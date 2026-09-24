// Trh bytů — sběrný běh. Spouští se lokálně (naplánovanou úlohou ve
// Windows, viz README.md v této složce), NE přes GitHub Actions — na rozdíl
// od hlídacího psa (index.js) tahle appka potřebuje trvalé úložiště
// (SQLite + fotky), které na efemérním Actions runneru nejde bez
// commitování binárek do gitu.
//
// Znovupoužívá stávající sources/*.js (search-pass — "co je teď v
// nabídce") a config.js (watch "byty" — stejná lokalita jako hlídací pes).
// Žádný z těch souborů se needituje — nulové riziko pro živý hlídací pes.
//
// Pro každý nový inzerát navíc navštíví jeho DETAIL stránku (vlastní
// parsery v detail/*.js, nezávislé na sources/*.js) kvůli popisu a fotkám —
// to search-pass nemá. Dispozice a m² se berou z titulku (parse.js),
// funguje to univerzálně napříč všemi zdroji bez detail fetch.

import { appendFileSync } from "node:fs";
import path from "node:path";
import { watches } from "../config.js";
import { fetchSrealityAllPages } from "../sources/sreality.js";
import { fetchBezrealitky } from "../sources/bezrealitky.js";
import { fetchIdnes } from "../sources/idnes.js";
import { fetchRealitymix } from "../sources/realitymix.js";
import { fetchBazos } from "../sources/bazos.js";
import { openDb, nowIso, getListing, insertListing, updateListingFields, insertEvent, insertPhoto, DATA_DIR } from "./db.js";
import { handleDisappeared } from "./relist.js";
import { parseDisposition, parseAreaM2, parseAddressFromTitle, parsePriceFromDescription, findKnownPlace } from "./parse.js";
import { downloadPhotos } from "./photos.js";
import { fetchSrealityDetail } from "./detail/sreality.js";
import { fetchBezrealitkyDetail } from "./detail/bezrealitky.js";
import { fetchIdnesDetail } from "./detail/idnes.js";
import { fetchRealitymixDetail } from "./detail/realitymix.js";
import { fetchBazosDetail } from "./detail/bazos.js";

const LOG_PATH = path.join(DATA_DIR, "track.log");

const SOURCES = [
  // Sreality stahujeme přes VŠECHNY stránky výpisu — jen z 1. stránky by
  // starší inzeráty vytlačené novějšími vypadaly jako zmizelé.
  { name: "sreality", fetchList: fetchSrealityAllPages, fetchDetail: fetchSrealityDetail },
  { name: "bezrealitky", fetchList: fetchBezrealitky, fetchDetail: fetchBezrealitkyDetail },
  { name: "idnes", fetchList: fetchIdnes, fetchDetail: fetchIdnesDetail },
  { name: "realitymix", fetchList: fetchRealitymix, fetchDetail: fetchRealitymixDetail },
  { name: "bazos", fetchList: fetchBazos, fetchDetail: fetchBazosDetail },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(line) {
  const stamped = `[${nowIso()}] ${line}`;
  console.log(stamped);
  try {
    appendFileSync(LOG_PATH, stamped + "\n", "utf-8");
  } catch {
    // Appka běží bez dohledu — pád zápisu do logu nesmí shodit celý běh.
  }
}

async function processSource(db, source, watch) {
  let items;
  try {
    items = await source.fetchList(watch);
  } catch (err) {
    log(`[${source.name}] CHYBA při stahování seznamu: ${err.message}`);
    return { newCount: 0, priceChangeCount: 0, removedCount: 0, relistedCount: 0, error: true };
  }

  let newCount = 0;
  let priceChangeCount = 0;
  const currentIds = new Set();
  const createdThisRun = []; // kandidáti na "znovu vložený inzerát", viz relist.js

  for (const item of items) {
    const listingId = `${source.name}:${item.id}`;
    currentIds.add(listingId);
    const now = nowIso();

    const existing = getListing(db, listingId);
    if (!existing) {
      // Nový inzerát — dotáhnout detail (popis, fotky, případně reserved).
      const detail = await source.fetchDetail(item.url);
      const status = detail.reserved ? "reserved" : "active";

      // Titulek bývá stručný a někdy dispozici/plochu vůbec nemá (hlavně
      // Bazoš/RealityMIX) — v tom případě appka zkusí totéž vytáhnout z
      // popisu na detailu, ten je skoro vždy zmiňuje taky. Cena stejně:
      // "Cena na vyžádání"/"Dohodou" u samotné nabídky, ale popis přesto
      // často konkrétní číslo obsahuje. Adresa má tři úrovně: pole od
      // portálu → konec titulku (jen Bazoš) → aspoň název sledovaného
      // města zmíněný v popisu (viz parse.js).
      const disposition = parseDisposition(item.title) ?? parseDisposition(detail.description);
      const areaM2 = parseAreaM2(item.title) ?? parseAreaM2(detail.description);
      const priceCzk = item.priceCzk ?? parsePriceFromDescription(detail.description);
      const address = item.address || parseAddressFromTitle(item.title) || findKnownPlace(detail.description, watch) || null;

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
        params_json: JSON.stringify(detail.params || {}),
      });
      insertEvent(db, { listing_id: listingId, event_type: "created", new_price_czk: priceCzk, occurred_at: now });
      createdThisRun.push({ id: listingId, disposition, area_m2: areaM2, description: detail.description, price_czk: priceCzk });
      if (status === "reserved") {
        insertEvent(db, { listing_id: listingId, event_type: "reserved", occurred_at: now });
      }

      if (detail.photoUrls.length > 0) {
        const downloaded = await downloadPhotos(listingId, detail.photoUrls, log);
        for (const photo of downloaded) {
          insertPhoto(db, { listing_id: listingId, local_path: photo.localPath, source_url: photo.sourceUrl, downloaded_at: now });
        }
      }

      newCount++;
      log(`[${source.name}] nový inzerát ${item.id} (${status}) — ${item.title}`);
      await sleep(300); // zdvořilost vůči portálu — jeden detail fetch + fotky za sebou
      continue;
    }

    // Známý inzerát — update ceny + last_seen_at.
    const fields = { last_seen_at: now };
    if (existing.missed_since) fields.missed_since = null; // vrátil se, poslední výpadek byl jen přechodný
    if (item.priceCzk != null && existing.price_czk != null && item.priceCzk !== existing.price_czk) {
      insertEvent(db, {
        listing_id: listingId,
        event_type: "price_change",
        old_price_czk: existing.price_czk,
        new_price_czk: item.priceCzk,
        occurred_at: now,
      });
      fields.price_czk = item.priceCzk;
      priceChangeCount++;
      log(`[${source.name}] změna ceny ${item.id}: ${existing.price_czk} → ${item.priceCzk} Kč`);
    }
    if (existing.status === "removed") {
      // Znovu se objevil — vzácné, ale ať to appka umí (ne že by zůstal
      // navždy "removed", i když je zase v nabídce).
      fields.status = "active";
      fields.removed_at = null;
      insertEvent(db, { listing_id: listingId, event_type: "reactivated", occurred_at: now });
    }
    updateListingFields(db, listingId, fields);
  }

  // Cokoli, co bylo dřív active/reserved u TOHOTO zdroje, ale v aktuálním
  // běhu se nenašlo → buď znovu vložený inzerát, přechodný výpadek, nebo
  // zmizelo z nabídky (pravděpodobně prodáno/rezervováno jinde/staženo z
  // jiného důvodu — appka to netvrdí jistě, viz README). Rozlišení viz relist.js.
  const { removedCount, relistedCount } = handleDisappeared(db, source.name, currentIds, createdThisRun, log);

  return { newCount, priceChangeCount, removedCount, relistedCount, error: false };
}

async function run() {
  const db = openDb();
  const watch = watches.find((w) => w.key === "byty");
  if (!watch) throw new Error('watch "byty" nenalezen v config.js');

  log("=== Start běhu ===");
  let totalNew = 0;
  let totalPriceChanges = 0;
  let totalRemoved = 0;
  let totalRelisted = 0;
  let hadError = false;

  for (const source of SOURCES) {
    const result = await processSource(db, source, watch);
    totalNew += result.newCount;
    totalPriceChanges += result.priceChangeCount;
    totalRemoved += result.removedCount;
    totalRelisted += result.relistedCount;
    if (result.error) hadError = true;
  }

  log(
    `Hotovo. ${totalNew} nových bytů zaevidováno, ${totalPriceChanges} změn ceny, ${totalRemoved} zmizelo z nabídky, ${totalRelisted} znovu vloženo.` +
      (hadError ? " (u některého zdroje selhalo stahování — zkontroluj log výše.)" : "")
  );
  db.close();
}

run().catch((err) => {
  console.error("Neočekávaná chyba:", err);
  try {
    appendFileSync(LOG_PATH, `[${nowIso()}] NEOČEKÁVANÁ CHYBA: ${err.stack || err.message}\n`, "utf-8");
  } catch {
    // Nic víc se s tím nedá dělat — appka běží bez dohledu.
  }
  process.exitCode = 1;
});
