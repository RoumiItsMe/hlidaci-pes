// RÚIAN (Registr územní identifikace, adres a nemovitostí) — oficiální
// zdroj ČÚZK, volně dostupná REST služba. Na rozdíl od OpenStreetMap
// (viz geo.js) dává:
//  - OBRYS BUDOVY (stavební objekt) v bodě — přesný test "bod leží v domě",
//    ne odhad podle obdélníku;
//  - VŠECHNA čísla popisná budovy (jeden dům má často víc vchodů s vlastním
//    číslem — z bodu se pak nepozná, který je ten správný) a její adresní
//    místa, počet bytů a podlaží;
//  - KATASTRÁLNÍ ÚZEMÍ (kód + název), které je při hledání v katastru
//    nemovitostí potřeba vedle čísla popisného.
//
// Dotazy se ukládají do `ruian_cache`. Služba je veřejná a bez klíče —
// dotazuje se zdvořile (pauza mezi dotazy) a jen pro body a adresy bytů.

import { nowIso } from "./db.js";
import { stripDiacritics } from "./geo-suggest.js";

const BASE = "https://ags.cuzk.cz/arcgis/rest/services/RUIAN/Prohlizeci_sluzba_nad_daty_RUIAN/MapServer";
const USER_AGENT = "hlidaci-pes-trh-bytu/1.0 (osobni nekomercni pouziti)";
const LAYER = { adresniMisto: 1, stavebniObjekt: 3, katastralniUzemi: 7 };
const BUILDING_FIELDS = "kod,cisladomovni,pocetbytu,pocetpodlazi,isknbudovaid,dokonceni,typstavebnihoobjektukod";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function pointKey(lat, lon) {
  return `pt:${lat.toFixed(6)},${lon.toFixed(6)}`;
}

export function addressKey(street, number, city) {
  return `adr:${stripDiacritics(street)}|${String(number).trim()}|${stripDiacritics(city || "")}`;
}

async function query(layer, params) {
  const url = `${BASE}/${layer}/query?` + new URLSearchParams({ f: "json", returnGeometry: "false", ...params });
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const json = await res.json();
  if (json.error) throw new Error(`RÚIAN: ${json.error.message || JSON.stringify(json.error)}`);
  return json.features || [];
}

function parseHouseNumbers(raw) {
  return String(raw ?? "")
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function pointGeometry(lat, lon) {
  return { geometry: `${lon},${lat}`, geometryType: "esriGeometryPoint", inSR: "4326", spatialRel: "esriSpatialRelIntersects" };
}

/**
 * Budova, katastrální území a adresní místa v bodě (WGS84). `building` je
 * `null`, když bod v žádné budově neleží (typicky střed ulice) nebo když
 * jich do 3 m leží víc (nejednoznačné); `exact` říká, že bod leží přímo v
 * obrysu, ne jen těsně vedle.
 *
 * `buildingKod` (jen při hledání podle adresy): adresní místo samo ví, do
 * kterého stavebního objektu patří, takže budovu bereme podle kódu a ne podle
 * polohy. Poloha adresního bodu často leží v obrysu víc objektů najednou
 * (sousední sekce, přístavba) a bod pak vyšel jako "nejednoznačný", ačkoli
 * adresa je v RÚIAN správně (reálně: J. Drobného 1620, Česká Třebová).
 */
export async function ruianLookupPoint(lat, lon, { buildingKod = null } = {}) {
  const pt = pointGeometry(lat, lon);
  let exact = true;
  let buildings = [];
  if (buildingKod != null && Number.isFinite(Number(buildingKod))) {
    buildings = await query(LAYER.stavebniObjekt, { where: `kod=${Number(buildingKod)}`, outFields: BUILDING_FIELDS });
  }
  if (buildings.length === 0) {
    buildings = await query(LAYER.stavebniObjekt, { ...pt, outFields: BUILDING_FIELDS });
  }
  if (buildings.length === 0) {
    exact = false;
    buildings = await query(LAYER.stavebniObjekt, { ...pt, distance: "3", units: "esriSRUnit_Meter", outFields: BUILDING_FIELDS });
  }
  const ku = (await query(LAYER.katastralniUzemi, { ...pt, outFields: "kod,nazev" }))[0]?.attributes ?? null;
  const ambiguous = buildings.length > 1;
  const b = buildings.length === 1 ? buildings[0].attributes : null;

  let addresses = [];
  if (b) {
    const rows = await query(LAYER.adresniMisto, {
      where: `stavebniobjekt=${Number(b.kod)}`,
      outFields: "adresa,cislodomovni,cisloorientacni,cisloorientacnipismeno",
    });
    addresses = rows.map((r) => ({
      text: r.attributes.adresa,
      cp: r.attributes.cislodomovni != null ? String(r.attributes.cislodomovni) : null,
      co: r.attributes.cisloorientacni != null ? `${r.attributes.cisloorientacni}${r.attributes.cisloorientacnipismeno || ""}` : null,
    }));
  }

  return {
    exact,
    ambiguous,
    ku: ku ? { kod: ku.kod, nazev: ku.nazev } : null,
    building: b
      ? {
          kod: b.kod,
          cp: parseHouseNumbers(b.cisladomovni),
          flats: b.pocetbytu ?? null,
          floors: b.pocetpodlazi ?? null,
          isknId: b.isknbudovaid ?? null,
          completed: typeof b.dokonceni === "number" ? new Date(b.dokonceni).getUTCFullYear() : null,
        }
      : null,
    addresses,
  };
}

/**
 * Adresní místo podle ulice + čísla popisného (+ obec) a k němu totéž co
 * `ruianLookupPoint`. Vrací `null`, když adresa v RÚIAN není (nebo je víc
 * různých obcí a žádná nesedí).
 */
export async function ruianLookupAddress(street, number, city) {
  const cp = String(number).split("/")[0].trim();
  const esc = (s) => String(s).replace(/'/g, "''");
  const addressFields = { outFields: "adresa,stavebniobjekt", returnGeometry: "true", outSR: "4326" };
  let rows = await query(LAYER.adresniMisto, {
    where: `adresa LIKE '${esc(street)} ${esc(cp)},%' OR adresa LIKE '${esc(street)} ${esc(cp)}/%'`,
    ...addressFields,
  });
  // Obec bez PSČ: ručně zapsaná adresa bývá "…, 560 02 Česká Třebová", v RÚIAN je "…, 56002 Česká Třebová".
  const cityText = String(city || "").replace(/\b\d{3}\s?\d{2}\b/g, "").replace(/\s+/g, " ").trim();
  const cityKey = stripDiacritics(cityText);
  // Obec bez ulic i částí obce ("Dolní Dobrouč 181" v obci Dolní Dobrouč): RÚIAN
  // takové adresy píše "č.p. 181, 56102 Dolní Dobrouč".
  if (rows.length === 0 && cityKey && stripDiacritics(street) === cityKey) {
    rows = await query(LAYER.adresniMisto, { where: `adresa LIKE 'č.p. ${esc(cp)}, % ${esc(cityText)}'`, ...addressFields });
  }
  const matching = rows.filter((r) => !cityKey || stripDiacritics(r.attributes.adresa).includes(cityKey));
  const pick = matching.length > 0 ? matching : rows.length === 1 ? rows : [];
  const geom = pick[0]?.geometry;
  if (!geom || typeof geom.x !== "number") return null;
  const result = await ruianLookupPoint(geom.y, geom.x, { buildingKod: pick[0].attributes.stavebniobjekt });
  return { ...result, addressPoint: pick[0].attributes.adresa, lookupVersion: ADDRESS_LOOKUP_VERSION };
}

// Verze hledání podle adresy: starší záznamy v mezipaměti, které budovu
// nenašly (bod ležel v obrysu víc objektů), se při příštím sběru zopakují —
// viz ruianPending.
export const ADDRESS_LOOKUP_VERSION = 2;

// Adresa, kterou RÚIAN neznal, se zkusí znovu po tolika dnech (čtvrtletí).
// Novostavba z webu developera ("Lhotka 51") má adresní místo a číslo popisné v
// registru až po dokončení domu; záporná odpověď proto nesmí platit navždy, ale
// ani se na ni nemá cenu ptát častěji — dům se nestaví po dnech.
export const RECHECK_UNKNOWN_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Kdy byl který klíč naposledy zjišťován: Map klíč → čas (ms). */
export function loadRuianFetchedAt(db) {
  const at = new Map();
  for (const r of db.prepare("SELECT key, fetched_at FROM ruian_cache").all()) at.set(r.key, Date.parse(r.fetched_at));
  return at;
}

/**
 * Má se záznam o adrese v mezipaměti zopakovat? Ano, když RÚIAN adresu
 * neznal a od té doby uplynulo RECHECK_UNKNOWN_DAYS, nebo když ji starší verze
 * hledání našla bez budovy (viz ADDRESS_LOOKUP_VERSION). Body (pt:) se
 * nemění, ty se neopakují.
 */
export function isRuianEntryStale(key, cached, fetchedAtMs, now = Date.now()) {
  if (!key.startsWith("adr:")) return false;
  if (cached === null) return now - (fetchedAtMs ?? 0) >= RECHECK_UNKNOWN_DAYS * DAY_MS;
  return Boolean(cached?.addressPoint) && !cached.building && cached.lookupVersion !== ADDRESS_LOOKUP_VERSION;
}

/** "Truby 1737, Česká Třebová" -> { street, number, city } (nebo null, když to nevypadá jako adresa s číslem). */
export function parseExactAddress(text) {
  const m = String(text ?? "")
    .trim()
    .match(/^(.+?)\s+(\d{1,5}(?:\s*\/\s*\d{1,3}[a-z]?)?)\s*(?:,\s*(.+))?$/i);
  if (!m) return null;
  return { street: m[1].trim(), number: m[2].replace(/\s+/g, ""), city: m[3] ? m[3].trim() : null };
}

export function loadRuianCache(db) {
  const cache = new Map();
  for (const r of db.prepare("SELECT key, result_json FROM ruian_cache").all()) {
    cache.set(r.key, r.result_json ? JSON.parse(r.result_json) : null);
  }
  return cache;
}

export function saveRuian(db, key, result) {
  db.prepare("INSERT OR REPLACE INTO ruian_cache (key, result_json, fetched_at) VALUES (?, ?, ?)").run(key, result ? JSON.stringify(result) : null, nowIso());
}

/**
 * Doplní do mezipaměti body a zapsané adresy, které tam ještě nejsou.
 * Fail-soft (výpadek služby sběr nezastaví, zkusí se příště).
 */
export async function ruianPending(db, log, { limit = 150, delayMs = 250 } = {}) {
  const cache = loadRuianCache(db);
  const fetchedAt = loadRuianFetchedAt(db);
  const todo = [];
  for (const p of db
    .prepare(
      `SELECT DISTINCT lat, lon FROM listings
       WHERE lat IS NOT NULL AND lon IS NOT NULL
         AND (source != 'sreality' OR json_extract(geo_json, '$.precision') = 'address')`
    )
    .all()) {
    const key = pointKey(p.lat, p.lon);
    if (!cache.has(key)) todo.push({ key, run: () => ruianLookupPoint(p.lat, p.lon) });
  }
  for (const r of db.prepare("SELECT DISTINCT exact_address FROM listings WHERE exact_address IS NOT NULL").all()) {
    const parsed = parseExactAddress(r.exact_address);
    if (!parsed) continue;
    const key = addressKey(parsed.street, parsed.number, parsed.city);
    if (!cache.has(key) || isRuianEntryStale(key, cache.get(key), fetchedAt.get(key))) {
      todo.push({ key, run: () => ruianLookupAddress(parsed.street, parsed.number, parsed.city) });
    }
  }

  let done = 0;
  let failures = 0;
  for (const job of todo.slice(0, limit)) {
    try {
      const result = await job.run();
      // Adresa, kterou RÚIAN dřív neznal, se objevila (novostavba po dokončení) —
      // jen do logu, byt se sám zařadí mezi ověřitelné (viz new-build.js).
      if (result && cache.get(job.key) === null) log(`[ruian] adresa se objevila v registru: ${job.key} — byt se zařadí mezi ověřitelné.`);
      saveRuian(db, job.key, result);
      done++;
      failures = 0;
    } catch (err) {
      failures++;
      log(`[ruian] dotaz selhal (${job.key}): ${err.message}`);
      if (failures >= 3) {
        log("[ruian] třikrát po sobě selhalo, zbytek se zkusí při příštím běhu.");
        break;
      }
    }
    await sleep(delayMs);
  }
  if (todo.length > 0) log(`[ruian] ověřeno ${done} z ${Math.min(todo.length, limit)} nových bodů/adres.`);
  return { done, pending: Math.max(0, todo.length - done) };
}
