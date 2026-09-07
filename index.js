// Hlídací pes — hlavní orchestrátor.
//
// Projde všechna sledování (watches, viz config.js) × všechny zdroje
// (portály), porovná nalezené inzeráty s tím, co už bylo dřív viděno
// (data/seen.json), a pošle notifikaci na Telegram o:
//  (a) nových inzerátech,
//  (b) změně ceny u inzerátů, které už dřív sledoval.
//
// Při úplně prvním běhu pro danou dvojici (sledování, zdroj) — žádný
// předchozí stav — se aktuální nabídka jen "zabaseline" jako už viděná —
// bez notifikací — ať uživatele nezaplaví desítkami zpráv o inzerátech,
// které tam visí už dlouho. Stejný princip platí i při přidání nového
// sledování/lokality: state klíč je nový → první běh je tichý baseline.
// Změna ceny se navíc přirozeně neohlásí, pokud předchozí cena nebyla
// známá (typicky migrace ze staršího formátu stavu, nebo inzerát dřív měl
// "Cena na vyžádání") — hlásí se jen známá cena → jiná známá cena.
//
// Zdravotní stav (state.__health) sleduje, jestli daná dvojice (sledování,
// zdroj) právě selhává — když ano, pošle se Telegram alert (a znovu až po
// 12 hodinách, ať to při dlouhodobém výpadku nespamuje každých 15 minut).
// Jakmile se zdroj zase rozchodí, pošle se zpráva o zotavení.
//
// Stejná nemovitost se často inzeruje na víc portálech najednou (realitka
// nahodí tu samou nabídku na Sreality i Bezrealitky i jinam) — bez zásahu
// by to znamenalo až 5 notifikací o "nové nabídce" pro jednu reálnou věc.
// `computeFingerprint` z toho udělá otisk (cena + plocha v m² z titulku) a
// sdílí se napříč VŠEMI zdroji v rámci jednoho sledování (state klíč
// `<watch.key>:__fingerprints`) — druhý a další portál se stejným otiskem
// se potichu přeskočí, bez ohledu na to, kdy a odkud přišel první.

import { watches, maxSeenPerSource } from "./config.js";
import {
  loadState,
  saveState,
  getSourceItems,
  setSourceItems,
  getFingerprintMap,
  setFingerprintMap,
} from "./lib/state.js";
import { sendTelegramMessage, sleep } from "./lib/telegram.js";
import { fetchSreality, fetchListingDates } from "./sources/sreality.js";
import { fetchBezrealitky } from "./sources/bezrealitky.js";
import { fetchIdnes } from "./sources/idnes.js";
import { fetchRealitymix } from "./sources/realitymix.js";
import { fetchBazos } from "./sources/bazos.js";

const ACTIONS_LOG_URL = "https://github.com/RoumiItsMe/hlidaci-pes/actions";
const REALERT_COOLDOWN_MS = 12 * 60 * 60 * 1000; // 12 hodin

const SOURCES = [
  { name: "sreality", label: "Sreality.cz", fetch: fetchSreality },
  { name: "bezrealitky", label: "Bezrealitky.cz", fetch: fetchBezrealitky },
  { name: "idnes", label: "Reality.iDNES.cz", fetch: fetchIdnes },
  { name: "realitymix", label: "RealityMIX.cz", fetch: fetchRealitymix },
  { name: "bazos", label: "Bazoš.cz", fetch: fetchBazos },
];

function formatCzk(n) {
  return `${n.toLocaleString("cs-CZ")} Kč`;
}

// Sreality řadí "nejnovější" podle data poslední ÚPRAVY inzerátu, ne podle
// prvního zveřejnění — inzerát starý roky tak umí vyskočit jako "nový", jen
// když ho prodejce/RK upraví (viz komentář u fetchListingDates). Nad tímhle
// prahem (dní od `since`) se taková "nová" nabídka rovnou přeskočí a
// notifikace se vůbec nepošle (dřív se posílala s vysvětlující poznámkou,
// ale uživatel je nechce vidět vůbec — jen to zaneřádí Telegram).
const STALE_LISTING_THRESHOLD_DAYS = 30;

function formatDateCzk(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("cs-CZ", { timeZone: "UTC" });
}

/** Vrátí počet dní od `since`, nebo null (neznámé/neparsovatelné datum). */
function daysSince(sinceDateStr) {
  if (!sinceDateStr) return null;
  const since = new Date(`${sinceDateStr}T00:00:00Z`);
  if (Number.isNaN(since.getTime())) return null;
  return Math.floor((Date.now() - since.getTime()) / (24 * 60 * 60 * 1000));
}

// U ZMĚNY CENY je zajímavý opačný údaj než u nových nabídek — ne "since"
// (na trhu od), ale "edited" (naposledy upraveno), protože změna ceny JE
// ta úprava, co inzerát vytáhla nahoru. Na rozdíl od formatSinceNote se
// ukazuje vždycky (když je k dispozici), ne jen nad nějakým prahem — tady
// jde jen o potvrzující kontext, ne o filtr "je to relevantní".
function formatEditedNote(editedDateStr) {
  if (!editedDateStr) return null;
  const dateLabel = formatDateCzk(editedDateStr);
  if (!dateLabel) return null;
  return `📝 Upraveno na Sreality: ${dateLabel}`;
}

// Otisk stejné reálné nemovitosti napříč portály: cena (přesná, agenti ji
// typicky kopírují beze změny na všechny portály) + plocha v m² vytažená
// z titulku (formát "X m²"/"X m2" je napříč všemi zdroji konzistentní).
// Bez adresy/lokality — ty se mezi portály liší formátem příliš na to, aby
// šly spolehlivě porovnat, a v našem malém geografickém okruhu je shoda
// ceny + plochy sama o sobě už dost silný signál, že jde o tu samou věc.
// Když cenu nebo plochu nejde zjistit, radši nededuplikovat vůbec (vrátí
// null → nikdy se nepřiřadí k jiné položce) než riskovat, že se dvě různé
// nemovitosti mylně sloučí a jedna z nich zmizí.
const AREA_M2_RE = /(\d+(?:[.,]\d+)?)\s*m[²2]/i;

function computeFingerprint(item) {
  if (item.priceCzk == null) return null;
  const m = item.title?.match(AREA_M2_RE);
  if (!m) return null;
  const areaM2 = Math.round(parseFloat(m[1].replace(",", ".")));
  if (!Number.isFinite(areaM2)) return null;
  return `${item.priceCzk}_${areaM2}`;
}

function formatNewItemMessage(watch, item) {
  const lines = [`${watch.emoji} Nová nabídka — ${watch.label} • ${item.sourceLabel}`, item.title];
  if (item.address) lines.push(`📍 ${item.address}`);
  lines.push(`💰 ${item.price}`);
  lines.push(item.url);
  return lines.join("\n");
}

function formatPriceChangeMessage(watch, item, oldPriceCzk, newPriceCzk, extraNote) {
  const arrow = newPriceCzk < oldPriceCzk ? "🔻" : "🔺";
  const diff = newPriceCzk - oldPriceCzk;
  const diffText = `${diff > 0 ? "+" : ""}${formatCzk(diff)}`;
  const lines = [
    `${arrow} Změna ceny — ${watch.label} • ${item.sourceLabel}`,
    item.title,
  ];
  if (item.address) lines.push(`📍 ${item.address}`);
  lines.push(`💰 ${formatCzk(oldPriceCzk)} → ${formatCzk(newPriceCzk)} (${diffText})`);
  if (extraNote) lines.push(extraNote);
  lines.push(item.url);
  return lines.join("\n");
}

function getHealth(state, key) {
  if (!state.__health) state.__health = {};
  if (!state.__health[key]) state.__health[key] = { failing: false, lastAlertAt: null };
  return state.__health[key];
}

/** Pošle Telegram alert o selhání — hned při první chybě, pak nejvýš 1x za 12 h. */
async function alertFailure(health, label, err) {
  const now = Date.now();
  const alreadyAlertedRecently =
    health.failing && health.lastAlertAt && now - Date.parse(health.lastAlertAt) < REALERT_COOLDOWN_MS;
  health.failing = true;
  if (alreadyAlertedRecently) return;

  health.lastAlertAt = new Date(now).toISOString();
  try {
    await sendTelegramMessage(
      `⚠️ Hlídací pes: ${label} přestal fungovat.\nChyba: ${err.message}\n\nLog: ${ACTIONS_LOG_URL}`
    );
  } catch (alertErr) {
    console.error(`Nepodařilo se odeslat alert o selhání (${label}): ${alertErr.message}`);
  }
}

/** Pošle Telegram zprávu o zotavení, pokud předtím selhávalo. */
async function alertRecoveryIfNeeded(health, label) {
  if (!health.failing) return;
  health.failing = false;
  health.lastAlertAt = null;
  try {
    await sendTelegramMessage(`✅ Hlídací pes: ${label} zase funguje.`);
  } catch (err) {
    console.error(`Nepodařilo se odeslat zprávu o zotavení (${label}): ${err.message}`);
  }
}

async function run() {
  const state = await loadState();
  let totalNew = 0;
  let totalPriceChanges = 0;
  let totalStaleSkipped = 0;
  let totalCrossPortalSkipped = 0;
  let hadError = false;

  for (const watch of watches) {
    const fpKey = `${watch.key}:__fingerprints`;
    const seenFingerprints = getFingerprintMap(state, fpKey);

    for (const src of SOURCES) {
      const stateKey = `${watch.key}:${src.name}`;
      const label = `${watch.label} • ${src.label}`;
      const health = getHealth(state, stateKey);
      const known = getSourceItems(state, stateKey);
      const isFirstRun = known.size === 0;

      let items;
      try {
        items = await src.fetch(watch);
      } catch (err) {
        hadError = true;
        console.error(`[${stateKey}] CHYBA při stahování: ${err.message}`);
        await alertFailure(health, label, err);
        continue;
      }

      await alertRecoveryIfNeeded(health, label);

      const newItems = [];
      const priceChanges = [];
      for (const item of items) {
        const prev = known.get(item.id);
        if (!prev) {
          newItems.push(item);
        } else if (prev.price != null && item.priceCzk != null && prev.price !== item.priceCzk) {
          priceChanges.push({ item, oldPriceCzk: prev.price, newPriceCzk: item.priceCzk });
        }
        known.set(item.id, { price: item.priceCzk ?? null });
      }

      console.log(
        `[${stateKey}] nalezeno ${items.length} inzerátů, z toho ${newItems.length} nových, ${priceChanges.length} se změnou ceny${
          isFirstRun ? " (první běh — jen baseline, bez notifikací)" : ""
        }`
      );

      setSourceItems(state, stateKey, known, maxSeenPerSource);

      if (isFirstRun) continue;

      for (const item of newItems) {
        try {
          const fingerprint = computeFingerprint(item);

          // Napříč portály nejlevnější kontrola první (žádný HTTP request)
          // — když už tuhle nemovitost nahlásil jiný zdroj, není důvod
          // utrácet extra request na Sreality since-check níže.
          if (fingerprint && seenFingerprints.has(fingerprint)) {
            totalCrossPortalSkipped += 1;
            console.log(
              `[${stateKey}] přeskakuji nabídku ${item.id} — stejná nemovitost (${item.priceCzk} Kč, otisk ${fingerprint}) už nahlášena přes ${seenFingerprints.get(fingerprint)}.`
            );
            continue;
          }

          // Jen pro Sreality — jediný zdroj, kde víme, že "nejnovější" může
          // znamenat "jen upraveno", ne "nově zveřejněno" (viz komentáře
          // výše a v sources/sreality.js). Fail-soft: když se since nepodaří
          // zjistit, bereme to jako "neznámé stáří" a notifikace jde ven
          // (radši ukázat i nejistou nabídku, než aby unikla ta jedna nová).
          if (item.source === "sreality") {
            const { since } = await fetchListingDates(item.url);
            const days = daysSince(since);
            if (days != null && days >= STALE_LISTING_THRESHOLD_DAYS) {
              totalStaleSkipped += 1;
              console.log(
                `[${stateKey}] přeskakuji "novou" nabídku ${item.id} — na trhu už ${days} dní (since=${since}), Sreality ji jen upravila.`
              );
              // I stálou nabídku počítáme jako "vyřešenou" pro tenhle otisk,
              // ať ji jiný portál (bez since/edited údajů) nenahlásí znovu.
              if (fingerprint) seenFingerprints.set(fingerprint, src.label);
              continue;
            }
          }

          await sendTelegramMessage(formatNewItemMessage(watch, item));
          if (fingerprint) seenFingerprints.set(fingerprint, src.label);
          totalNew += 1;
          await sleep(400);
        } catch (err) {
          hadError = true;
          console.error(`[${stateKey}] CHYBA při odesílání Telegram zprávy (nová nabídka): ${err.message}`);
        }
      }

      for (const { item, oldPriceCzk, newPriceCzk } of priceChanges) {
        try {
          // Tady naopak zajímá "edited" (kdy se cena reálně změnila), ne
          // "since" — viz formatEditedNote výše.
          const editedNote =
            item.source === "sreality" ? formatEditedNote((await fetchListingDates(item.url)).edited) : null;
          await sendTelegramMessage(formatPriceChangeMessage(watch, item, oldPriceCzk, newPriceCzk, editedNote));
          totalPriceChanges += 1;
          await sleep(400);
        } catch (err) {
          hadError = true;
          console.error(`[${stateKey}] CHYBA při odesílání Telegram zprávy (změna ceny): ${err.message}`);
        }
      }
    }

    setFingerprintMap(state, fpKey, seenFingerprints, maxSeenPerSource);
  }

  await saveState(state);
  console.log(
    `Hotovo. Odesláno ${totalNew} notifikací o nových nabídkách, ${totalPriceChanges} o změně ceny ` +
      `(${totalStaleSkipped} "nových" přeskočeno jako neaktuální, ${totalCrossPortalSkipped} přeskočeno jako duplicita z jiného portálu).`
  );

  if (hadError) {
    console.warn("Během běhu došlo k dílčím chybám — zkontroluj log výše.");
    // Nenulový exit kód → GitHub Actions označí běh jako neúspěšný (červený),
    // což (mimo Telegram alert výše) spustí i výchozí e-mailové upozornění
    // GitHubu vlastníkovi repa. Krok, co commituje stav, běží i tak (viz
    // `if: always()` ve workflow.yml) — stav a health-tracking se uloží vždy.
    process.exitCode = 1;
  }
}

run().catch(async (err) => {
  console.error("Neočekávaná chyba:", err);
  process.exitCode = 1;
  try {
    await sendTelegramMessage(
      `🔴 Hlídací pes: neočekávaná chyba celého běhu.\n${err.message}\n\nLog: ${ACTIONS_LOG_URL}`
    );
  } catch {
    // Telegram taky nemusí být dostupný (např. celkový výpadek sítě) — chyba
    // je aspoň v GitHub Actions logu a běh skončí červeně.
  }
});
