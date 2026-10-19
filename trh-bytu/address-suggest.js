// Napovídání přesné adresy v detailu bytu (jako v e-shopu): po napsání začátku
// ulice appka nabídne konkrétní čísla popisná, po výběru se adresa vyplní celá.
//
// Zdroj je RÚIAN (ČÚZK), stejný registr, přes který se adresa při uložení ověřuje
// (ruian.js) — nabízí se tedy jen adresy, které opravdu existují.
//  1. Rejstřík názvů (ulice, části obce, obce v okolí sledovaných lokalit) se
//     stáhne jednou (3 dotazy, ~1 s) a uloží do souboru ve složce dat sekce;
//     obnovuje se po 30 dnech. Hledání v něm je místní, takže je okamžité a
//     nezávisí na diakritice ("smilovskeho" najde "Šmilovského").
//  2. Čísla popisná k vybranému názvu se dotáhnou živě z RÚIAN (~0,3 s) a
//     krátce se pamatují.
//
// Dotazy jsou omezené na okolí sledovaných lokalit (obdélník kolem středů a
// okruhů z watch), takže nabídka nezahlcuje celou republikou.

import fs from "node:fs";
import { stripDiacritics } from "./geo-suggest.js";
import { RUIAN_ENDPOINT } from "./ruian.js";

export const INDEX_VERSION = 1;
const INDEX_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_ITEMS = 10;
const NUMBER_FETCH_LIMIT = 200;
const NUMBER_CACHE_MS = 10 * 60 * 1000;
const KM_PER_DEG = 111.2;
const LAYER = { ulice: 4, castObce: 11, obec: 12, adresniMisto: 1 };

const fmtWindow = (minLon, minLat, maxLon, maxLat) => [minLon, minLat, maxLon, maxLat].map((v) => v.toFixed(4)).join(",");

/**
 * Obdélníky "minLon,minLat,maxLon,maxLat" — jeden na každou lokalitu watch (střed ± okruh + okraj v km).
 * Zvlášť, ne jeden společný: společný obdélník kolem vzdálených lokalit by sebral i města mezi nimi.
 */
export function regionWindows(watch, marginKm = 2) {
  const out = [];
  for (const l of watch?.locations ?? []) {
    if (typeof l.centerLat !== "number" || typeof l.centerLng !== "number") continue;
    const r = (l.radiusKm ?? 5) + marginKm;
    const dLat = r / KM_PER_DEG;
    const dLon = r / (KM_PER_DEG * Math.cos((l.centerLat * Math.PI) / 180));
    out.push(fmtWindow(l.centerLng - dLon, l.centerLat - dLat, l.centerLng + dLon, l.centerLat + dLat));
  }
  return out;
}

/** Společný obdélník kolem všech oken — jen zúžení dotazu na čísla (města se pak dofiltrují podle rejstříku). */
export function regionWindow(watch, marginKm = 2) {
  const boxes = regionWindows(watch, marginKm).map((w) => w.split(",").map(Number));
  if (!boxes.length) return null;
  return fmtWindow(Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3])));
}

const envelopeParams = (windowStr) => ({ geometry: windowStr, geometryType: "esriGeometryEnvelope", inSR: "4326", spatialRel: "esriSpatialRelIntersects" });

/** Dotaz na vrstvu RÚIAN, vrací atributy řádků. */
export async function ruianQueryFeatures(layer, params, { fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
  const url = `${RUIAN_ENDPOINT.BASE}/${layer}/query?` + new URLSearchParams({ f: "json", returnGeometry: "false", ...params });
  const res = await fetchImpl(url, { headers: { "User-Agent": RUIAN_ENDPOINT.USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`RÚIAN HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`RÚIAN: ${json.error.message || JSON.stringify(json.error)}`);
  return (json.features ?? []).map((f) => f.attributes);
}

const validRow = (a) => a && a.nespravny !== true && a.platido == null;

/**
 * Rejstřík názvů z řádků vrstev Ulice, Část obce a Obec.
 * Položka: { name, city, kind: "street" | "part" | "town" }.
 */
export function buildEntries({ streets = [], parts = [], towns = [] }) {
  const townByKod = new Map(towns.filter(validRow).map((t) => [t.kod, t.nazev]));
  const seen = new Set();
  const entries = [];
  const add = (name, city, kind) => {
    if (!name || !city) return;
    const k = `${kind}|${stripDiacritics(name)}|${stripDiacritics(city)}`;
    if (seen.has(k)) return;
    seen.add(k);
    entries.push({ name, city, kind });
  };
  for (const s of streets.filter(validRow)) {
    // Pole `ulice` je "Truby, Česká Třebová" — název i obec v jednom.
    const fromField = typeof s.ulice === "string" && s.ulice.includes(", ") ? s.ulice.slice(s.ulice.lastIndexOf(", ") + 2) : null;
    add(s.nazev, fromField ?? townByKod.get(s.obec), "street");
  }
  for (const p of parts.filter(validRow)) {
    const city = townByKod.get(p.obec);
    // Část obce se stejným názvem jako obec je jen obec samotná.
    if (city && stripDiacritics(city) !== stripDiacritics(p.nazev)) add(p.nazev, city, "part");
  }
  for (const t of towns.filter(validRow)) add(t.nazev, t.nazev, "town");
  return entries;
}

async function buildIndex(queryFn, windows) {
  const streets = [];
  const parts = [];
  const towns = [];
  for (const w of windows) {
    const env = envelopeParams(w);
    streets.push(...(await queryFn(LAYER.ulice, { where: "1=1", outFields: "nazev,ulice,obec,nespravny,platido", ...env })));
    parts.push(...(await queryFn(LAYER.castObce, { where: "1=1", outFields: "nazev,obec,nespravny,platido", ...env })));
    towns.push(...(await queryFn(LAYER.obec, { where: "1=1", outFields: "kod,nazev,nespravny,platido", ...env })));
  }
  return buildEntries({ streets, parts, towns });
}

const prepare = (entries) => entries.map((e) => ({ ...e, key: stripDiacritics(e.name) }));

async function readOrBuild({ file, windows, queryFn, now }) {
  const signature = windows.join(";");
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    if (saved.version === INDEX_VERSION && saved.window === signature && now - Date.parse(saved.builtAt) < INDEX_TTL_MS) return prepare(saved.entries);
  } catch {
    // žádný nebo poškozený soubor — postaví se znovu
  }
  const entries = await buildIndex(queryFn, windows);
  try {
    fs.writeFileSync(file, JSON.stringify({ version: INDEX_VERSION, window: signature, builtAt: new Date(now).toISOString(), entries }));
  } catch {
    // rejstřík se jen nezapamatuje; příště se stáhne znovu
  }
  return prepare(entries);
}

const indexMemo = new Map();
/** Rejstřík názvů pro sekci (z paměti, ze souboru, nebo nově z RÚIAN). Nevyhazuje při prázdném okně; selhání sítě se předá. */
export function loadIndex({ file, watch, queryFn = ruianQueryFeatures, now = Date.now() }) {
  const windows = regionWindows(watch);
  if (!windows.length) return Promise.resolve([]);
  const memoKey = `${file}|${windows.join(";")}`;
  const memo = indexMemo.get(memoKey);
  if (memo && now - memo.at < INDEX_TTL_MS) return memo.promise;
  const promise = readOrBuild({ file, windows, queryFn, now });
  indexMemo.set(memoKey, { at: now, promise });
  promise.catch(() => indexMemo.delete(memoKey)); // neúspěch se nepamatuje
  return promise;
}

/**
 * Rozdělí napsaný text: "Truby 17, Česká" -> { name: "Truby", number: "17", city: "Česká" }.
 * Číslo je jen poslední samostatné slovo tvaru 17 / 17/3 / 17a — "17. listopadu" je název.
 */
export function parseQuery(text) {
  const [left, ...rest] = String(text ?? "").slice(0, 120).split(",");
  const m = left.replace(/\s+/g, " ").trimStart().match(/^(.*?)(?:\s+(\d+(?:\/\d*)?[A-Za-z]?))?\s*$/);
  return { name: (m?.[1] ?? "").trim(), number: m?.[2] ?? null, city: rest.join(",").trim() || null };
}

/** Položky rejstříku, jejichž název začíná napsaným textem (nebo má takové slovo). rank: 0 přesná shoda, 1 začátek, 2 začátek slova. */
export function matchEntries(entries, name, city = null) {
  const nk = stripDiacritics(name).replace(/\s+/g, " ").trim();
  if (nk.length < 2) return [];
  const ck = city ? stripDiacritics(city) : null;
  const out = [];
  for (const e of entries) {
    if (ck && !stripDiacritics(e.city).includes(ck)) continue;
    let rank = null;
    if (e.key === nk) rank = 0;
    else if (e.key.startsWith(nk)) rank = 1;
    else if ((" " + e.key).includes(" " + nk)) rank = 2;
    if (rank !== null) out.push({ ...e, rank });
  }
  return out;
}

/**
 * "Truby 1737, 56002 Česká Třebová" / "Česká 318, Ostrovské Předměstí, 56301 Lanškroun"
 * / "č.p. 181, 51721 Lípa nad Orlicí" -> { street, number, part, city }. Jiné tvary (č.ev.) null.
 * Obec bez ulic má v appce ulici = obec ("Dolní Dobrouč 181").
 */
export function parseRuianAddress(adresa) {
  const text = String(adresa ?? "");
  const cp = text.match(/^č\.p\. (\d+(?:\/\d+[A-Za-z]?)?)(?:, (.+?))?, \d{3} ?\d{2} (.+)$/);
  if (cp) return { street: cp[3], number: cp[1], part: cp[2] ?? null, city: cp[3] };
  const m = text.match(/^(.+?) (\d+(?:\/\d+[A-Za-z]?)?)(?:, (.+?))?, \d{3} ?\d{2} (.+)$/);
  // "Českoskalická č.ev. 38" je evidenční číslo (rekreační objekt), ne číslo popisné.
  if (m && !/(^|\s)č\.ev\.$/.test(m[1])) return { street: m[1], number: m[2], part: m[3] ?? null, city: m[4] };
  return null;
}

const numberOrder = (n) => {
  const [cp, co] = String(n).split("/");
  return [parseInt(cp, 10) || 0, parseInt(co ?? "0", 10) || 0];
};

const literal = (s) => String(s).replace(/'/g, "''");

function numberWhere(target, numberPrefix) {
  const num = numberPrefix ? literal(numberPrefix.replace(/\s+/g, "")) : "";
  if (target.kind === "town") return `adresa LIKE 'č.p. ${num}%' AND adresa LIKE '%, _____ ${literal(target.name)}'`;
  return `adresa LIKE '${literal(target.name)} ${num}%'`;
}

const numberCache = new Map();

async function fetchNumbers(target, numberPrefix, { windowStr, queryFn, now }) {
  const key = `${windowStr}|${target.kind}|${target.name}|${numberPrefix ?? ""}`;
  const hit = numberCache.get(key);
  if (hit && now - hit.at < NUMBER_CACHE_MS) return hit.rows;
  const rows = await queryFn(LAYER.adresniMisto, {
    where: numberWhere(target, numberPrefix),
    outFields: "adresa",
    orderByFields: "adresa",
    resultRecordCount: String(NUMBER_FETCH_LIMIT),
    ...envelopeParams(windowStr),
  });
  const parsed = rows.map((r) => parseRuianAddress(r.adresa)).filter(Boolean);
  numberCache.set(key, { at: now, rows: parsed });
  return parsed;
}

const cityRank = (city, watch) => {
  const ck = stripDiacritics(city);
  const i = (watch?.locations ?? []).findIndex((l) => stripDiacritics(l.label) === ck);
  return i < 0 ? 99 : i;
};

const KIND_LABEL = { street: "ulice", part: "část obce", town: "obec" };
const KIND_ORDER = { street: 0, part: 1, town: 2 };

/**
 * Nabídka pro napsaný text. Vrací { items, more }:
 *  - položka `kind: "name"` — jen název (ulice / část obce / obec); po výběru se
 *    dopíše do pole a nabídnou se jeho čísla;
 *  - položka `kind: "address"` — celá adresa ("Truby 1737, Česká Třebová") v `value`.
 * Čísla se nabídnou hned, jakmile je název jednoznačný (přesná shoda, jediný
 * kandidát, nebo už je napsané číslo); jinak se nejdřív vybírá název.
 * `municipalities` (volitelně) zúží nabídku jen na tyto obce.
 */
export async function suggestAddresses(text, { watch, file, municipalities = null, queryFn = ruianQueryFeatures, now = Date.now() }) {
  const q = parseQuery(text);
  if (stripDiacritics(q.name).trim().length < 2) return { items: [], more: 0 };
  let entries = await loadIndex({ file, watch, queryFn, now });
  // Sekce, která sleduje jen vybrané obce ("přímo tyto obce"), nenabízí sousední města.
  if (municipalities?.length) {
    const only = new Set(municipalities.map(stripDiacritics));
    entries = entries.filter((e) => only.has(stripDiacritics(e.city)));
  }
  const matches = matchEntries(entries, q.name, q.city);
  if (!matches.length) return { items: [], more: 0 };

  const byName = (list) => [...new Map(list.map((m) => [`${m.kind}|${m.key}`, m])).values()];
  const exact = byName(matches.filter((m) => m.rank === 0));
  const distinct = byName(matches);
  let targets = [];
  if (exact.length) targets = exact;
  else if (distinct.length === 1) targets = distinct;
  else if (q.number !== null && distinct.length <= 3) targets = distinct;

  if (!targets.length) {
    matches.sort((a, b) => a.rank - b.rank || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || cityRank(a.city, watch) - cityRank(b.city, watch) || a.name.localeCompare(b.name, "cs") || a.city.localeCompare(b.city, "cs"));
    const items = matches.slice(0, MAX_ITEMS).map((m) => ({ kind: "name", value: `${m.name} `, label: m.name, detail: m.kind === "street" ? m.city : `${KIND_LABEL[m.kind]} · ${m.city}` }));
    return { items, more: Math.max(0, matches.length - items.length) };
  }

  const windowStr = regionWindow(watch);
  const lists = await Promise.all(
    targets.slice(0, 3).map(async (t) => {
      // Společný obdélník zasáhne i města mezi lokalitami; nabídnou se jen obce, kde rejstřík název zná.
      const cities = new Set(matches.filter((m) => m.kind === t.kind && m.key === t.key).map((m) => stripDiacritics(m.city)));
      return (await fetchNumbers(t, q.number, { windowStr, queryFn, now })).filter((a) => cities.has(stripDiacritics(a.city)));
    })
  );
  const ck = q.city ? stripDiacritics(q.city) : null;
  const seen = new Set();
  const rows = [];
  for (const a of lists.flat()) {
    if (ck && !stripDiacritics(`${a.city} ${a.part ?? ""}`).includes(ck)) continue;
    const value = `${a.street} ${a.number}, ${a.city}`;
    const k = `${value}|${a.part ?? ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    rows.push({ ...a, value });
  }
  rows.sort((a, b) => cityRank(a.city, watch) - cityRank(b.city, watch) || a.city.localeCompare(b.city, "cs") || numberOrder(a.number)[0] - numberOrder(b.number)[0] || numberOrder(a.number)[1] - numberOrder(b.number)[1]);
  const items = rows.slice(0, MAX_ITEMS).map((a) => ({ kind: "address", value: a.value, label: `${a.street} ${a.number}`, detail: a.part ? `${a.part} · ${a.city}` : a.city }));
  return { items, more: Math.max(0, rows.length - items.length) };
}
