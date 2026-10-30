// Zápis jednoho zdroje do databáze: porovná nabídky z výpisu s uloženým stavem a zapíše rozdíl (nový inzerát, změna
// ceny, rezervace, prodej, zmizení, návrat do nabídky). Vyčleněno z track.js, aby šlo (a) testovat bez spuštění sběru a
// (b) pustit nad uloženým snímkem výpisu z cloudového sběrače (snapshot-replay.js) se skutečným časem pozorování.

import { REGION } from "./region.js";
import { sendTelegramMessage } from "../lib/telegram.js";
import { isOutsideByPoint, nearestCenterKm, notAnOfferReason } from "./region-guard.js";
import { nowIso, getListing, insertListing, updateListingFields, insertEvent, insertPhoto } from "./db.js";
import { handleDisappeared } from "./relist.js";
import { reservationChange } from "./reservation.js";
import { planPriceUpdate } from "./price-update.js";
import { parseDisposition, parseAreaM2, parseAddressFromTitle, parsePriceFromDescription, findKnownPlace, zipToKnownPlace, parseStreetFromText } from "./parse.js";
import { proposeOwnFields } from "./detect-own-fields.js";
import { extractParamsFromText, mergeExtractedParams } from "./extract-params.js";
import { downloadPhotos } from "./photos.js";
import { geoFields } from "./geo.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Telegram upozornění na rezervaci — uživatel chce vědět HNED, že nabídka
// přešla do rezervace, aby stihl zkontrolovat převod v katastru nemovitostí.
// Posílá se jak u nabídky, která se rovnou zaeviduje jako rezervovaná
// (appka ji vidí poprvé), tak u známé nabídky, co se rezervovala mezi dvěma
// běhy — v obou případech je to STEJNÁ informace ("tenhle byt je pravděpodobně
// prodáno/rezervováno"), jen jinou cestou appka k ní došla. Fail-soft: appka
// běží bez dohledu (naplánovaná úloha), chybějící token nebo výpadek
// Telegramu nesmí shodit celý sběrný běh, jen se zaloguje.
async function notifyReservation(listing, log) {
  if (!REGION.telegram) return;
  const specs = [listing.disposition, listing.area_m2 ? `${listing.area_m2} m²` : null].filter(Boolean).join(", ");
  const price = listing.price_czk != null ? `${listing.price_czk.toLocaleString("cs-CZ")} Kč` : "cena na vyžádání";
  const text = `🔒 Rezervováno: ${specs || "byt"}${listing.address ? `, ${listing.address}` : ""}\n${price}\n${listing.url}`;
  try {
    await sendTelegramMessage(text);
  } catch (err) {
    log(`Telegram upozornění na rezervaci selhalo: ${err.message}`);
  }
}

// Zapíše do `fields` polohu z právě staženého detailu, pokud ji známý
// inzerát ještě nemá (starší záznamy vznikly před sběrem polohy).
function captureGeoIfMissing(existing, fields, detail) {
  if (existing.lat != null || existing.geo_json != null) return;
  Object.assign(fields, geoFields(detail.geo));
}

const NOT_AN_OFFER_LABELS = { demand: "poptávka", rental: "pronájem", share: "jen podíl na bytě" };

// Detail nového inzerátu. U přehrávaného snímku může být inzerát mezitím pryč — pak se založí jen z údajů výpisu, ať o
// něm historie ví (popis, fotky a poloha chybí). Při běžném sběru chyba stahování letí dál jako dřív.
async function fetchNewDetail(source, item, replay, log) {
  if (!replay) return source.fetchDetail(item.url);
  try {
    return await source.fetchDetail(item.url);
  } catch (err) {
    log(`[${source.name}] detail ${item.id} už nejde stáhnout (${err.message}) — založeno jen z údajů výpisu`);
    return { description: null, photoUrls: [], params: {}, geo: null };
  }
}

/**
 * Zapíše zdroj do databáze.
 *
 * @param opts.log         funkce pro log (povinná)
 * @param opts.items       nabídky z výpisu; bez nich se výpis stáhne (`source.fetchList`)
 * @param opts.observedAt  ISO čas pozorování: zapíná PŘEHRÁVÁNÍ uloženého snímku z cloudového sběrače. Všechny
 *                         události a časy se zapisují k tomuto okamžiku (ne "teď"), příznaky rezervace a prodeje
 *                         (`item.reserved`, `item.sold`) určil sběrač v době pozorování, takže se nestahují detaily
 *                         známých inzerátů a zmizení se neověřuje na stránce inzerátu (ta ukazuje dnešek, ne tehdy).
 * @param opts.deps        náhrady pro testy: `notifyReservation`, `downloadPhotos`, `sleep`, `probe` (ověření zmizení)
 */
export async function processSource(db, source, watch, { log, items: providedItems = null, observedAt = null, deps = {} } = {}) {
  const replay = observedAt != null;
  const stamp = () => observedAt ?? nowIso();
  const notify = deps.notifyReservation ?? ((listing) => notifyReservation(listing, log));
  const savePhotos = deps.downloadPhotos ?? downloadPhotos;
  const pause = deps.sleep ?? sleep;

  let items = providedItems;
  if (!items) {
    try {
      items = await source.fetchList(watch);
    } catch (err) {
      log(`[${source.name}] CHYBA při stahování seznamu: ${err.message}`);
      return { newCount: 0, priceChangeCount: 0, removedCount: 0, relistedCount: 0, reservationCount: 0, error: true };
    }
  }

  let newCount = 0;
  let priceChangeCount = 0;
  let reservationCount = 0;
  let soldCount = 0;
  const currentIds = new Set();
  const createdThisRun = []; // kandidáti na "znovu vložený inzerát", viz relist.js

  for (const item of items) {
    const listingId = `${source.name}:${item.id}`;
    currentIds.add(listingId);
    const now = stamp();

    const existing = getListing(db, listingId);
    if (!existing) {
      // Poptávka ("Poptávka bytu v …") ani pronájem není nabídka bytu k prodeji — nezaeviduje se (viz region-guard.js).
      const notAnOffer = notAnOfferReason({ title: item.title, url: item.url, priceCzk: item.priceCzk });
      if (notAnOffer) {
        log(`[${source.name}] není nabídka k prodeji (${NOT_AN_OFFER_LABELS[notAnOffer]}), přeskočeno: ${item.id} — ${item.title}`);
        continue;
      }
      // Nový inzerát — dotáhnout detail (popis, fotky, případně reserved).
      const detail = await fetchNewDetail(source, item, replay, log);
      // Prodej jen podílu na bytě (id. 1/2) se pozná až z textu, který výpis nemá — RealityMIX ho
      // nese v geo.text, ostatní v description (viz region-guard.js, listing-text.js).
      const notAnOfferByText = notAnOfferReason({ title: item.title, description: detail.description, geo_json: detail.geo });
      if (notAnOfferByText) {
        log(`[${source.name}] není nabídka k prodeji (${NOT_AN_OFFER_LABELS[notAnOfferByText]}), přeskočeno: ${item.id} — ${item.title}`);
        await pause(250);
        continue;
      }
      // Poloha z detailu leží daleko od všech sledovaných lokalit (portál doplnil
      // výpis nabídkou odjinud) — nezaeviduje se (viz region-guard.js). Neznámá
      // poloha se nevylučuje.
      if (isOutsideByPoint(detail.geo?.lat, detail.geo?.lon, watch)) {
        log(`[${source.name}] mimo sledovanou oblast (${Math.round(nearestCenterKm(detail.geo.lat, detail.geo.lon, watch))} km od nejbližší lokality), přeskočeno: ${item.id}${item.address ? ` — ${item.address}` : ""}`);
        await pause(250);
        continue;
      }
      // Rezervace z výpisu (iDNES, RealityMIX, Bezrealitky) nebo z detailu
      // (Sreality, Bezrealitky).
      const status = item.reserved === true || detail.reserved === true ? "reserved" : "active";

      // Titulek bývá stručný a někdy dispozici/plochu vůbec nemá (hlavně
      // Bazoš/RealityMIX) — v tom případě appka zkusí totéž vytáhnout z
      // popisu na detailu, ten je skoro vždy zmiňuje taky. Cena stejně:
      // "Cena na vyžádání"/"Dohodou" u samotné nabídky, ale popis přesto
      // často konkrétní číslo obsahuje. Adresa má PĚT úrovní: pole od
      // portálu → konec titulku (jen Bazoš, formát "... m², Město, ulice")
      // → PSČ z Bazošova vlastního detailu (viz zipToKnownPlace — jde o
      // jeho geokódování, přesnější než hádání ze slov, ale on sám u
      // "Lokalita:" ukazuje jen nejbližší okresní město, takže se řadí až
      // za titulek) → název sledovaného města zmíněný přímo v titulku
      // (např. "Moderní bydlení - Česká Třebová, byt 32m2" — město je v
      // titulku, ale ne v pozici za plochou, na kterou cílí druhý krok) →
      // totéž v popisu na detailu, vč. skloňovaných tvarů (findKnownPlace
      // v parse.js).
      const disposition = parseDisposition(item.title) ?? parseDisposition(detail.description);
      const areaM2 = parseAreaM2(item.title) ?? parseAreaM2(detail.description);
      // Cena z popisu jen tam, kde ji portál vůbec neuvedl — a značí se
      // (price_from_text), protože text bývá zastaralý (RK sníží cenu u
      // inzerátu a v textu nechá původní; viz README).
      const textPrice = item.priceCzk == null ? parsePriceFromDescription(detail.description) : null;
      const priceCzk = item.priceCzk ?? textPrice;
      let address =
        item.address ||
        parseAddressFromTitle(item.title) ||
        zipToKnownPlace(detail.zip, watch) ||
        findKnownPlace(item.title, watch) ||
        findKnownPlace(detail.description, watch) ||
        null;
      // Když všech pět úrovní skončilo jen na holém názvu sledovaného
      // města, zkusí appka ještě najít ulici zmíněnou v textu ("… v ulici
      // Velký Hájek.") a připojit ji — víc než jen město, i když to pořád
      // není oficiální adresa. Fires jen na HOLÉ město (žádná jiná úroveň
      // adresu už nezpřesnila), ať appka nepřepisuje konkrétnější adresu.
      if (address && watch.locations.some((loc) => loc.label === address)) {
        const street = parseStreetFromText(item.title) ?? parseStreetFromText(detail.description);
        if (street) address = `${address}, ul. ${street}`;
      }

      // Text popisu jako záchranná síť pro patro/sklep/vlastnictví, když je
      // portál buď vůbec nedává strukturovaně (Bazoš/iDNES/RealityMIX), nebo
      // je má ve svém JSON prázdné (reálný případ: sreality:479404108má
      // nativně `floorInfo: null`, popis přitom patro říká) — nativní
      // hodnota od portálu má vždy přednost, viz mergeExtractedParams.
      // RealityMIX má popis v `geo.text`, ne v `description` (viz listing-text.js) — text se čte z obou.
      const params = mergeExtractedParams(extractParamsFromText(item.title, detail.description || detail.geo?.text), detail.params || {});

      insertListing(db, {
        id: listingId,
        source: source.name,
        source_id: item.id,
        url: item.url,
        title: item.title,
        disposition,
        area_m2: areaM2,
        address,
        description: detail.description,
        price_czk: priceCzk,
        status,
        first_seen_at: now,
        last_seen_at: now,
        params_json: JSON.stringify(params),
        price_from_text: textPrice != null,
      });

      // Odhad vlastního hodnocení (viz detect-own-fields.js) — VŽDY jen jako
      // výchozí návrh pro čerstvě zaevidovaný inzerát (pole je teď jistě
      // NULL, insertListing na ně vůbec nesahá). Appka je pak sama od sebe
      // už nikdy nepřepíše, jedině uživatel ručně přes <select> — proto
      // stačí zapsat jednou tady, žádná ochrana proti přepsání navíc není
      // potřeba.
      // Stav bere i z portálového "Stav" (jen jednoznačné hodnoty, viz detect-own-fields.js)
      // a u RealityMIX z textu v `geo.text`.
      const ownFields = proposeOwnFields({ text: `${item.title} ${detail.description || detail.geo?.text || ""}`, portalCondition: detail.params?.condition });
      // Skutečné datum zveřejnění od portálu (jen Sreality/Bazoš to umí,
      // viz db.js) — appka mu nevěří naslepo, jen když je v minulosti (ne v
      // budoucnu, což by značilo špatně rozparsované datum) a ne řádově
      // vzdálenější než pár let (fail-soft proti pádnému parsovacímu omylu).
      if (detail.listedAt) {
        const listedTime = new Date(detail.listedAt).getTime();
        if (Number.isFinite(listedTime) && listedTime <= Date.now() && listedTime > Date.now() - 5 * 365 * 24 * 60 * 60 * 1000) {
          ownFields.listed_at = detail.listedAt;
        }
      }
      // Poloha od portálu (souřadnice, strukturovaná adresa) — musí se zachytit
      // hned, ze stránky zmizelého inzerátu odejde, viz geo.js.
      Object.assign(ownFields, geoFields(detail.geo));
      if (Object.keys(ownFields).length > 0) updateListingFields(db, listingId, ownFields);
      insertEvent(db, { listing_id: listingId, event_type: "created", new_price_czk: priceCzk, occurred_at: now });
      createdThisRun.push({ id: listingId, disposition, area_m2: areaM2, description: detail.description, price_czk: priceCzk });
      if (status === "reserved") {
        insertEvent(db, { listing_id: listingId, event_type: "reserved", occurred_at: now });
        await notify({ disposition, area_m2: areaM2, address, price_czk: priceCzk, url: item.url });
      }

      if (detail.photoUrls.length > 0) {
        const downloaded = await savePhotos(listingId, detail.photoUrls, log);
        for (const photo of downloaded) {
          insertPhoto(db, { listing_id: listingId, local_path: photo.localPath, source_url: photo.sourceUrl, downloaded_at: now });
        }
      }

      newCount++;
      log(`[${source.name}] nový inzerát ${item.id} (${status}) — ${item.title}`);
      await pause(300); // zdvořilost vůči portálu — jeden detail fetch + fotky za sebou
      continue;
    }

    // Známý inzerát — update ceny + last_seen_at.
    const fields = { last_seen_at: now };
    if (existing.missed_since) fields.missed_since = null; // vrátil se, poslední výpadek byl jen přechodný
    // Cena: změna, nebo z "Dohodou" na konkrétní cenu (viz price-update.js); cena → "Dohodou" se nezapisuje.
    const priceUpdate = planPriceUpdate(existing, item.priceCzk);
    if (priceUpdate) {
      Object.assign(fields, priceUpdate.fields);
      if (priceUpdate.event) {
        insertEvent(db, { listing_id: listingId, event_type: "price_change", ...priceUpdate.event, occurred_at: now });
        priceChangeCount++;
        log(`[${source.name}] změna ceny ${item.id}: ${existing.price_czk ?? "bez ceny"} → ${item.priceCzk} Kč`);
      }
    }
    if (existing.status === "removed") {
      // Znovu se objevil — vzácné, ale ať to appka umí (ne že by zůstal
      // navždy "removed", i když je zase v nabídce).
      fields.status = "active";
      fields.removed_at = null;
      insertEvent(db, { listing_id: listingId, event_type: "reactivated", occurred_at: now });
    }

    // Prodáno (iDNES, jen z detailu). Prodaný byt je KONEČNÝ stav — kontroluje
    // se dřív než rezervace, protože štítek "Rezervováno" z karty při
    // prodeji zmizí a appka by to jinak zapsala jako zrušenou rezervaci.
    // Poslední cena inzerátu je prodejní cena (viz detail/idnes.js).
    // Detail se u známých inzerátů čte (iDNES kvůli "prodáno", Sreality kvůli
    // rezervaci) tak jako tak — když u nich ještě chybí poloha, doplní se z
    // téhož stažení (viz captureGeoIfMissing).
    let soldNow = false;
    if (source.soldFromDetail && existing.status !== "sold") {
      if (replay) {
        soldNow = item.sold === true; // příznak určil sběrač při pozorování (snapshot.js)
      } else {
        const detail = await source.fetchDetail(item.url);
        soldNow = detail.sold === true;
        captureGeoIfMissing(existing, fields, detail);
        await pause(250); // zdvořilost vůči portálu
      }
    }
    if (soldNow) {
      const salePrice = fields.price_czk ?? existing.price_czk;
      fields.status = "sold";
      fields.removed_at = now; // okamžik, kdy appka zjistila prodej (konec doby v nabídce)
      insertEvent(db, { listing_id: listingId, event_type: "sold", new_price_czk: salePrice, occurred_at: now });
      soldCount++;
      log(`[${source.name}] prodáno: ${listingId} (cena ${salePrice ?? "neuvedena"} Kč)`);
      updateListingFields(db, listingId, fields);
      continue;
    }

    // Rezervace: z výpisu, nebo (Sreality) z detailu. `null`/`undefined` =
    // portál to v tomhle běhu nesdělil → stav se nemění (viz reservation.js).
    let observedReserved = item.reserved; // u přehrávaného snímku ho z detailu určil sběrač (snapshot.js)
    if (source.reservationFromDetail && !replay) {
      const detail = await source.fetchDetail(item.url);
      observedReserved = detail.reserved;
      captureGeoIfMissing(existing, fields, detail);
      await pause(250); // zdvořilost vůči portálu
    }
    const reservation = reservationChange(fields.status ?? existing.status, observedReserved);
    if (reservation) {
      fields.status = reservation.status;
      insertEvent(db, { listing_id: listingId, event_type: reservation.eventType, occurred_at: now });
      reservationCount++;
      log(`[${source.name}] ${reservation.eventType === "reserved" ? "rezervováno" : "rezervace zrušena"}: ${listingId}`);
      if (reservation.eventType === "reserved") {
        await notify({
          disposition: existing.disposition,
          area_m2: existing.area_m2,
          address: existing.address,
          price_czk: fields.price_czk ?? existing.price_czk,
          url: item.url,
        });
      }
    }
    updateListingFields(db, listingId, fields);
  }

  // Cokoli, co bylo dřív active/reserved u TOHOTO zdroje, ale v aktuálním
  // běhu se nenašlo → buď znovu vložený inzerát, přechodný výpadek, nebo
  // zmizelo z nabídky (pravděpodobně prodáno/rezervováno jinde/staženo z
  // jiného důvodu — appka to netvrdí jistě, viz README). Rozlišení viz relist.js.
  // U přehrávaného snímku se zmizení neověřuje na stránce inzerátu (ukazuje dnešek, ne tehdy) a časy jsou z pozorování.
  const disappearedOptions = replay ? { probe: async () => false, at: observedAt, pause: async () => {} } : { pause, probe: deps.probe };
  const { removedCount, relistedCount } = await handleDisappeared(db, source.name, currentIds, createdThisRun, log, disappearedOptions);

  return { newCount, priceChangeCount, removedCount, relistedCount, reservationCount, soldCount, error: false };
}

