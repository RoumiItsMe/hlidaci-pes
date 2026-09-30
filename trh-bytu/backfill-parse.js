// Jednorázový (ale bezpečně opakovatelný) přepočet dispozice/adresy/
// vlastního hodnocení pro existující záznamy v DB.
//
// track.js dopočítává disposition/address/own_* z title/description jen při
// PRVNÍM zaevidování inzerátu (viz "Nový inzerát" větev v processSource) —
// když se pak parse.js/detect-own-fields.js vylepší (nová heuristika, další
// skloňovaný tvar, nové klíčové slovo), staré řádky v DB zůstávají
// nedotčené navždy, dokud je někdo ručně nepřepočítá. Tenhle skript to
// udělá ve TŘECH fázích:
//
//   1. Offline — dispozice/adresa z title/description, které appka už má
//      uložené. Žádný network fetch, běží na všech zdrojích.
//   2. Bazoš-only síťová fáze — PSČ (viz zipToKnownPlace) appka historicky
//      neukládala, DB ho tedy nemá k dispozici offline. Pro záznamy, co po
//      fázi 1 pořád nemají adresu, znovu navštíví jejich Bazoš detail (jen
//      Bazoš — jediný zdroj s touhle úrovní, viz track.js) a zkusí PSČ
//      odsud. Zdvořilostní pauza mezi requesty jako v track.js.
//   3. Offline — vlastní hodnocení (own_condition/own_construction/
//      own_revitalized, viz detect-own-fields.js), taky z title/
//      description. Nezávislé na fázích 1-2.
//   4. Offline — PARAM_FIELDS z textu (patro/sklep/vlastnictví, viz
//      extract-params.js). Doplňuje jen chybějící KLÍČE uvnitř params_json,
//      nikdy nepřepíše, co tam portál nebo dřívější běh appky už dal.
//   5. Offline — ulice u adresy, co skončila jen na holém městě.
//   6. Sreality+Bazoš síťová fáze — skutečné datum zveřejnění (`listed_at`,
//      viz db.js) appka historicky neukládala, i tady musí znovu navštívit
//      živý detail. Nejpomalejší fáze (desítky requestů, zdvořilostní
//      pauza u každého) — běží jako poslední a jen pro řádky bez
//      `listed_at`.
//
// Idempotentní: nikdy nepřepíše hodnotu, která už je vyplněná (jen NULL →
// něco) — ani hodnotu, kterou mezitím ručně upravil uživatel přes <select> v
// appce — takže jde spustit opakovaně po každé úpravě parse.js/
// detect-own-fields.js bez rizika.
//
// Spuštění: node trh-bytu/backfill-parse.js

import { openDb } from "./db.js";
import { parseDisposition, parseAddressFromTitle, findKnownPlace, zipToKnownPlace, parseStreetFromText } from "./parse.js";
import { detectOwnCondition, detectOwnConstruction, detectOwnRevitalized } from "./detect-own-fields.js";
import { extractParamsFromText, mergeExtractedParams } from "./extract-params.js";
import { fetchBazosDetail } from "./detail/bazos.js";
import { fetchSrealityDetail } from "./detail/sreality.js";
import { watches } from "../config.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const watch = watches.find((w) => w.key === "byty");
if (!watch) throw new Error('watch "byty" nenalezen v config.js');

const db = openDb();

// --- Fáze 1: offline, dispozice/adresa ze SVÝCH VLASTNÍCH title/description ---
const rows = db.prepare("SELECT id, source, url, title, description, address, disposition FROM listings WHERE disposition IS NULL OR address IS NULL").all();

let fixedDisposition = 0;
let fixedAddress = 0;
const stillMissingAddress = [];

for (const row of rows) {
  const updates = {};

  if (row.disposition == null) {
    const disposition = parseDisposition(row.title) ?? parseDisposition(row.description);
    if (disposition != null) {
      updates.disposition = disposition;
      fixedDisposition++;
    }
  }

  if (row.address == null) {
    // Stejné úrovně jako v track.js kromě PSČ (to offline nemáme, viz fáze 2)
    // — konec titulku → město přímo v titulku → město v popisu.
    const address = parseAddressFromTitle(row.title) ?? findKnownPlace(row.title, watch) ?? findKnownPlace(row.description, watch);
    if (address != null) {
      updates.address = address;
      fixedAddress++;
    } else if (row.source === "bazos") {
      stillMissingAddress.push(row);
    }
  }

  if (Object.keys(updates).length > 0) {
    const setClause = Object.keys(updates)
      .map((k) => `${k} = ?`)
      .join(", ");
    db.prepare(`UPDATE listings SET ${setClause} WHERE id = ?`).run(...Object.values(updates), row.id);
    console.log(`${row.id}: ${JSON.stringify(updates)}`);
  }
}

// --- Fáze 2: Bazoš PSČ, vyžaduje znovu navštívit detail ---
for (const row of stillMissingAddress) {
  const detail = await fetchBazosDetail(row.url);
  const address = zipToKnownPlace(detail.zip, watch);
  if (address != null) {
    db.prepare("UPDATE listings SET address = ? WHERE id = ?").run(address, row.id);
    fixedAddress++;
    console.log(`${row.id}: {"address":"${address}"} (PSČ ${detail.zip})`);
  }
  await sleep(300); // zdvořilost vůči portálu, stejná pauza jako track.js
}

console.log(
  `Fáze 1-2 hotovo. Zkoumáno ${rows.length} záznamů s chybějící dispozicí/adresou (z toho ${stillMissingAddress.length} dotázáno na Bazoš PSČ) — dispozice doplněna u ${fixedDisposition}, adresa u ${fixedAddress}.`
);

// --- Fáze 3: offline, vlastní hodnocení (own_condition/own_construction/own_revitalized) ---
const ownRows = db
  .prepare(
    "SELECT id, title, description, own_condition, own_construction, own_revitalized FROM listings WHERE own_condition IS NULL OR own_construction IS NULL OR own_revitalized IS NULL"
  )
  .all();

let fixedCondition = 0;
let fixedConstruction = 0;
let fixedRevitalized = 0;

for (const row of ownRows) {
  const updates = {};
  const text = `${row.title || ""} ${row.description || ""}`;

  // Kontrola `row.own_* == null` je tu záměrně, ne jen "detekce něco
  // našla" — řádek se do `ownRows` dostal, i když třeba jen JEDNO ze tří
  // polí je NULL; ostatní dvě může mít nastavené UŽIVATEL ručně a ty se
  // nesmí přepsat, i kdyby detekce z textu vyšla na jinou hodnotu.
  if (row.own_condition == null) {
    const condition = detectOwnCondition(text);
    if (condition != null) {
      updates.own_condition = condition;
      fixedCondition++;
    }
  }
  if (row.own_construction == null) {
    const construction = detectOwnConstruction(text);
    if (construction != null) {
      updates.own_construction = construction;
      fixedConstruction++;
    }
  }
  if (row.own_revitalized == null) {
    const revitalized = detectOwnRevitalized(text);
    if (revitalized != null) {
      updates.own_revitalized = revitalized;
      fixedRevitalized++;
    }
  }

  if (Object.keys(updates).length > 0) {
    const setClause = Object.keys(updates)
      .map((k) => `${k} = ?`)
      .join(", ");
    db.prepare(`UPDATE listings SET ${setClause} WHERE id = ?`).run(...Object.values(updates), row.id);
    console.log(`${row.id}: ${JSON.stringify(updates)}`);
  }
}

console.log(
  `Fáze 3 hotovo. Zkoumáno ${ownRows.length} záznamů s chybějícím vlastním hodnocením — stav doplněn u ${fixedCondition}, konstrukce u ${fixedConstruction}, revitalizace u ${fixedRevitalized}.`
);

// --- Fáze 4: offline, PARAM_FIELDS (patro/sklep/vlastnictví) z textu ---
// Všechny záznamy, ne jen ty s NULL params_json — extrakce doplňuje
// JEDNOTLIVÉ klíče uvnitř JSON blobu (floorInfo/cellar/ownership), takže i
// řádek s vyplněnými jinými poli (typicky Sreality condition/buildingType)
// může tyhle tři pořád postrádat, viz mergeExtractedParams.
const paramRows = db.prepare("SELECT id, title, description, params_json FROM listings").all();

let fixedFloor = 0;
let fixedCellar = 0;
let fixedOwnership = 0;

for (const row of paramRows) {
  let existing = {};
  try {
    existing = row.params_json ? JSON.parse(row.params_json) : {};
  } catch {
    existing = {};
  }
  const extracted = extractParamsFromText(row.title, row.description);
  const additions = Object.keys(extracted).filter((k) => extracted[k] != null && existing[k] == null);
  if (additions.length === 0) continue;

  const merged = mergeExtractedParams(extracted, existing);
  if (additions.includes("floorInfo")) fixedFloor++;
  if (additions.includes("cellar")) fixedCellar++;
  if (additions.includes("ownership")) fixedOwnership++;
  db.prepare("UPDATE listings SET params_json = ? WHERE id = ?").run(JSON.stringify(merged), row.id);
  console.log(`${row.id}: ${JSON.stringify(Object.fromEntries(additions.map((k) => [k, extracted[k]])))}`);
}

console.log(
  `Fáze 4 hotovo. Zkoumáno ${paramRows.length} záznamů — patro doplněno u ${fixedFloor}, sklep u ${fixedCellar}, vlastnictví u ${fixedOwnership}.`
);

// --- Fáze 5: offline, ulice u adresy, co skončila jen na holém městě ---
// Na rozdíl od fáze 1 tahle neběží nad `address IS NULL` (ta u těchhle
// řádků NENÍ NULL, jen holé "Žamberk"/"Česká Třebová" apod.) — vlastní
// dotaz na přesnou shodu s watch.locations.
const cityLabels = watch.locations.map((l) => l.label);
const bareCityRows = db
  .prepare(`SELECT id, title, description, address FROM listings WHERE address IN (${cityLabels.map(() => "?").join(",")})`)
  .all(...cityLabels);

let fixedStreet = 0;
for (const row of bareCityRows) {
  const street = parseStreetFromText(row.title) ?? parseStreetFromText(row.description);
  if (!street) continue;
  const address = `${row.address}, ul. ${street}`;
  db.prepare("UPDATE listings SET address = ? WHERE id = ?").run(address, row.id);
  fixedStreet++;
  console.log(`${row.id}: {"address":"${address}"}`);
}

console.log(`Fáze 5 hotovo. Zkoumáno ${bareCityRows.length} záznamů s holou městskou adresou — ulice doplněna u ${fixedStreet}.`);

// --- Fáze 6: Sreality + Bazoš síťová fáze, skutečné datum zveřejnění ---
const listedAtRows = db.prepare("SELECT id, source, url FROM listings WHERE source IN ('sreality','bazos') AND listed_at IS NULL").all();

let fixedListedAt = 0;
for (const row of listedAtRows) {
  const fetchDetail = row.source === "sreality" ? fetchSrealityDetail : fetchBazosDetail;
  const detail = await fetchDetail(row.url);
  if (detail.listedAt) {
    const listedTime = new Date(detail.listedAt).getTime();
    // Stejná pojistka jako v track.js — nikdy datum v budoucnu ani
    // nesmyslně staré (chybný parsing by appku jinak tiše zmátl).
    if (Number.isFinite(listedTime) && listedTime <= Date.now() && listedTime > Date.now() - 5 * 365 * 24 * 60 * 60 * 1000) {
      db.prepare("UPDATE listings SET listed_at = ? WHERE id = ?").run(detail.listedAt, row.id);
      fixedListedAt++;
      console.log(`${row.id}: {"listed_at":"${detail.listedAt}"}`);
    }
  }
  await sleep(300); // zdvořilost vůči portálu, stejná pauza jako track.js
}

console.log(`Fáze 6 hotovo. Zkoumáno ${listedAtRows.length} Sreality/Bazoš záznamů bez data zveřejnění — doplněno u ${fixedListedAt}.`);

db.close();
