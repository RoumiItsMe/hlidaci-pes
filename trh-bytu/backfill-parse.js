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
//           node trh-bytu/backfill-parse.js --offline   (bez fází 2 a 6, žádné síťové dotazy)
//           node trh-bytu/backfill-parse.js --params-only   (jen fáze 4 a 5)

import { openDb } from "./db.js";
import { groupListings, mergePortalParams } from "./group.js";
import { parseDisposition, parseAddressFromTitle, findKnownPlace, zipToKnownPlace, parseStreetFromText } from "./parse.js";
import { proposeOwnFields } from "./detect-own-fields.js";
import { listingText, descriptionForDetection } from "./listing-text.js";
import { extractParamsFromText, mergeExtractedParams, normalizeOwnership, upgradeLegacyFloor } from "./extract-params.js";
import { fetchBazosDetail } from "./detail/bazos.js";
import { fetchSrealityDetail } from "./detail/sreality.js";
import { REGION_WATCH } from "./region.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// `--params-only`: jen fáze 4 a 5 (parametry z textu + ulice), bez doplňování
// dispozice/adresy/vlastního hodnocení a bez sítě — bezpečné po vylepšení
// extract-params.js, nesahá na vlastní hodnocení, které uživatel mohl vymazat.
const PARAMS_ONLY = process.argv.includes("--params-only");
const OFFLINE = PARAMS_ONLY || process.argv.includes("--offline");
const watch = REGION_WATCH;

const db = openDb();

// --- Fáze 1: offline, dispozice/adresa ze SVÝCH VLASTNÍCH title/description ---
const rows = PARAMS_ONLY ? [] : db.prepare("SELECT id, source, url, title, description, address, disposition FROM listings WHERE disposition IS NULL OR address IS NULL").all();

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
for (const row of OFFLINE ? [] : stillMissingAddress) {
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
const ownRows = PARAMS_ONLY
  ? []
  : db
      .prepare(
        "SELECT id, title, description, geo_json, params_json, own_condition, own_construction, own_revitalized FROM listings WHERE own_condition IS NULL OR own_construction IS NULL OR own_revitalized IS NULL"
      )
      .all();

let fixedCondition = 0;
let fixedConstruction = 0;
let fixedRevitalized = 0;

for (const row of ownRows) {
  // Navrhuje se jen to, co chybí (NULL) — ostatní pole může mít uživatel nastavené ručně a ta se
  // nesmí přepsat, i kdyby detekce vyšla jinak (proposeOwnFields). Text je titulek + popis (u
  // RealityMIX z geo_json, viz listing-text.js); stav navíc z portálového "Stav" (jen
  // jednoznačné hodnoty, viz detect-own-fields.js).
  let portalCondition = null;
  try {
    portalCondition = row.params_json ? JSON.parse(row.params_json).condition ?? null : null;
  } catch {
    portalCondition = null;
  }
  const updates = proposeOwnFields({ text: listingText(row), portalCondition }, row);
  if (updates.own_condition != null) fixedCondition++;
  if (updates.own_construction != null) fixedConstruction++;
  if (updates.own_revitalized != null) fixedRevitalized++;

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

// --- Fáze 4: offline, PARAM_FIELDS (patro/výtah/sklep/balkon/vlastnictví…) z textu ---
// Všechny záznamy, ne jen ty s NULL params_json — extrakce doplňuje
// JEDNOTLIVÉ klíče uvnitř JSON blobu, takže i řádek s vyplněnými jinými poli
// (typicky Sreality condition/buildingType) může některé z nich pořád
// postrádat, viz mergeExtractedParams. Mění se jen to, co chybí, a "Ne" u
// vybavení, které text výslovně vyvrací (viz mergeExtractedParams) — jiná
// hodnota se nepřepisuje. Navíc se sjednotí velikost písmen u vlastnictví
// (dřív se ukládalo "družstevní" malými písmeny, což výběr v tabulce
// nepoznal).
const paramRows = db.prepare("SELECT id, title, description, geo_json, params_json FROM listings").all();

const filled = {};
let upgradedNo = 0;
let normalizedOwnership = 0;

let upgradedFloors = 0;

for (const row of paramRows) {
  let original = {};
  try {
    original = row.params_json ? JSON.parse(row.params_json) : {};
  } catch {
    original = {};
  }
  const extracted = extractParamsFromText(row.title, descriptionForDetection(row));

  // Podlaží se dřív ukládalo ve dvou různých číslováních podle zdroje (viz
  // formatFloor): "2. patro z 4" z portálu je ve skutečnosti 2. NP, "2. patro"
  // z textu skutečně patro. Starý tvar se převede na jednoznačný
  // "1. patro (2. NP)"; hodnotu z textu (bez "z N") appka radši dopočítá znovu
  // novými pravidly, než aby převáděla výsledek starých.
  const existing = { ...original };
  if (typeof existing.floorInfo === "string" && !/\(\d+\. NP\)|^Podzemní/.test(existing.floorInfo)) {
    const fromPortal = /\sz\s\d+$/.test(existing.floorInfo);
    const upgraded = fromPortal ? upgradeLegacyFloor(existing.floorInfo) : extracted.floorInfo ?? upgradeLegacyFloor(existing.floorInfo);
    if (upgraded !== existing.floorInfo) {
      existing.floorInfo = upgraded;
      upgradedFloors++;
    }
  }
  const merged = mergeExtractedParams(extracted, existing);
  const ownership = normalizeOwnership(merged.ownership);
  if (merged.ownership != null && ownership !== merged.ownership) {
    merged.ownership = ownership;
    normalizedOwnership++;
  }

  const changes = {};
  for (const [key, value] of Object.entries(merged)) {
    if (JSON.stringify(value) === JSON.stringify(original[key])) continue;
    changes[key] = original[key] == null ? value : `${original[key]} → ${value}`;
    if (original[key] == null) filled[key] = (filled[key] || 0) + 1;
    else if (key !== "ownership" && key !== "floorInfo") upgradedNo++;
  }
  if (Object.keys(changes).length === 0) continue;

  db.prepare("UPDATE listings SET params_json = ? WHERE id = ?").run(JSON.stringify(merged), row.id);
  console.log(`${row.id}: ${JSON.stringify(changes)}`);
}

console.log(
  `Fáze 4 hotovo. Zkoumáno ${paramRows.length} záznamů — doplněno: ${JSON.stringify(filled)}, "Ne" opraveno podle textu u ${upgradedNo}, podlaží převedeno na tvar "patro (NP)" u ${upgradedFloors}, velikost písmen u vlastnictví sjednocena u ${normalizedOwnership}.`
);

// --- Fáze 4b: ruční přepsání parametrů (params_override_json) ---
// Uložení formuláře v detailu dřív zapsalo jako "ruční přepsání" i hodnoty,
// které uživatel nezměnil (formulář je posílá předvyplněné) — takové zmrazené
// kopie pak blokují každou opravu čtení inzerátu. Tady se (1) podlaží ve
// starém tvaru převede stejně jako ve fázi 4 a (2) přepsání, které se shoduje
// s hodnotou z portálu/textu, zahodí. Skutečně odlišná ruční hodnota zůstane.
const overrideRows = db.prepare("SELECT * FROM listings").all();
let droppedOverrides = 0;
let keptOverrides = 0;
for (const group of groupListings(overrideRows)) {
  const holder = group.members.find((m) => m.params_override_json);
  if (!holder) continue;
  let override;
  try {
    override = JSON.parse(holder.params_override_json);
  } catch {
    continue;
  }
  const portal = mergePortalParams(group.members);
  const kept = {};
  for (const [key, raw] of Object.entries(override)) {
    const value = key === "floorInfo" ? upgradeLegacyFloor(raw) : raw;
    if (value === portal[key]) droppedOverrides++;
    else {
      kept[key] = value;
      keptOverrides++;
    }
  }
  const json = Object.keys(kept).length ? JSON.stringify(kept) : null;
  if (json === holder.params_override_json) continue;
  for (const m of group.members) db.prepare("UPDATE listings SET params_override_json = ? WHERE id = ?").run(json, m.id);
  console.log(`${holder.id}: přepsání ${holder.params_override_json} → ${json ?? "žádné"}`);
}
console.log(`Fáze 4b hotovo. Zahozeno ${droppedOverrides} přepsání shodných s portálem/textem, ponecháno ${keptOverrides} skutečně ručních.`);

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
const listedAtRows = OFFLINE ? [] : db.prepare("SELECT id, source, url FROM listings WHERE source IN ('sreality','bazos') AND listed_at IS NULL").all();

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
