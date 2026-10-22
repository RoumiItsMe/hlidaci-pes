// Filtry tabulky Srovnání (/tabulka). Čisté funkce bez DB; byt = "entry" z computeEntries (entries.js).
//
// Hodnoty filtrů jsou přímo texty z URL (nebo null) — formulář je tak ukáže zpátky přesně, jak je uživatel napsal —
// a čísla se z nich čtou až tady (`toNumber`). Každý filtr zužuje výběr, všechny se kombinují (a ke stavu nabídky,
// městu a "Chybí údaje" ze server.js).

import { parseQuery, searchEntry } from "./search.js";

/** Hodnota výběru "bez údaje" — vlastnictví / stav, který u bytu není vyplněný. */
export const NONE = "__none";

/**
 * Číslo z textu: "3000000", "3 000 000", "3,5" i zkratky "3m" (miliony) a "2500k" (tisíce). Neplatné nebo záporné → null.
 */
export function toNumber(raw) {
  if (raw == null) return null;
  const text = String(raw).trim().toLowerCase().replace(/\s+/g, "").replace(",", ".");
  const m = text.match(/^(\d+(?:\.\d+)?)(k|m)?$/);
  if (!m) return null;
  const value = Number(m[1]) * (m[2] === "m" ? 1_000_000 : m[2] === "k" ? 1_000 : 1);
  return Number.isFinite(value) ? value : null;
}

const has = (v) => v != null && String(v).trim() !== "";

/** Klíče filtrů, tak jak se jmenují v URL (server.js je čte a posílá dál odkazům). */
export const COMPARE_FILTER_PARAMS = ["vlastnictvi", "dispozice", "stav_bytu", "cena_od", "cena_do", "plocha_od", "plocha_do", "dnu_od", "zlevneno", "q"];

/**
 * Použije filtry na byty.
 * @param f `{ vlastnictvi, dispozice, stav_bytu, cena_od, cena_do, plocha_od, plocha_do, dnu_od, zlevneno, q }` — texty z URL nebo null
 */
export function applyCompareFilters(entries, f) {
  const tokens = parseQuery(f.q);
  const priceMin = toNumber(f.cena_od);
  const priceMax = toNumber(f.cena_do);
  const areaMin = toNumber(f.plocha_od);
  const areaMax = toNumber(f.plocha_do);
  const daysMin = toNumber(f.dnu_od);
  return entries.filter((e) => {
    if (has(f.vlastnictvi)) {
      const own = e.params?.ownership || null;
      if (f.vlastnictvi === NONE ? own : own !== f.vlastnictvi) return false;
    }
    if (has(f.dispozice) && (e.rep?.disposition ?? null) !== f.dispozice) return false;
    if (has(f.stav_bytu)) {
      const cond = e.ownCondition || null;
      if (f.stav_bytu === NONE ? cond : cond !== f.stav_bytu) return false;
    }
    // Byt bez ceny / plochy ("cena na vyžádání") rozsah nesplní — nevíme, kam patří.
    if (priceMin != null && !(e.price != null && e.price >= priceMin)) return false;
    if (priceMax != null && !(e.price != null && e.price <= priceMax)) return false;
    if (areaMin != null && !(e.rep?.area_m2 != null && e.rep.area_m2 >= areaMin)) return false;
    if (areaMax != null && !(e.rep?.area_m2 != null && e.rep.area_m2 <= areaMax)) return false;
    if (daysMin != null && !(e.daysOnMarket != null && e.daysOnMarket >= daysMin)) return false;
    if (f.zlevneno === "1" && !((e.totalDiscountCzk ?? 0) > 0)) return false;
    if (tokens.length && !searchEntry(e, tokens)) return false;
    return true;
  });
}

/** Dispozice od nejmenší: 1+kk, 1+1, 2+kk, 2+1, … (ostatní podle abecedy na konec). */
export function sortDispositions(values) {
  const rank = (d) => {
    const m = String(d).replace(/\s+/g, "").match(/^(\d+)\+(kk|\d+)$/i);
    return m ? [Number(m[1]), m[2].toLowerCase() === "kk" ? 0 : 1] : null;
  };
  return [...values].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra && rb) return ra[0] - rb[0] || ra[1] - rb[1];
    if (ra) return -1;
    if (rb) return 1;
    return String(a).localeCompare(String(b), "cs");
  });
}

/** Hodnoty pro výběry: jen to, co se v datech opravdu vyskytuje (nenabízí se volba, po které nic nenajde). */
export function compareFilterOptions(entries) {
  const distinct = (values) => [...new Set(values.filter(Boolean))];
  return {
    ownerships: distinct(entries.map((e) => e.params?.ownership)).sort((a, b) => a.localeCompare(b, "cs")),
    dispositions: sortDispositions(distinct(entries.map((e) => e.rep?.disposition))),
  };
}

const kc = (n) => `${Math.round(n).toLocaleString("cs-CZ")} Kč`;

function rangeLabel(name, min, max, format) {
  if (min != null && max != null) return `${name}: ${format(min)}–${format(max)}`;
  if (min != null) return `${name}: od ${format(min)}`;
  return `${name}: do ${format(max)}`;
}

/**
 * Aktivní filtry slovy, pro odznaky s ✕: `[{ label, clear: [klíče v URL, které odznak zruší] }]`.
 * `conditionLabel(code)` dodává server (popisky stavu bytu žijí v params.js).
 */
export function describeCompareFilters(f, { conditionLabel = (c) => c } = {}) {
  const chips = [];
  if (has(f.vlastnictvi)) chips.push({ label: `Vlastnictví: ${f.vlastnictvi === NONE ? "bez údaje" : f.vlastnictvi}`, clear: ["vlastnictvi"] });
  if (has(f.dispozice)) chips.push({ label: `Dispozice: ${f.dispozice}`, clear: ["dispozice"] });
  if (has(f.stav_bytu)) chips.push({ label: `Stav: ${f.stav_bytu === NONE ? "bez hodnocení" : conditionLabel(f.stav_bytu)}`, clear: ["stav_bytu"] });
  const priceMin = toNumber(f.cena_od);
  const priceMax = toNumber(f.cena_do);
  if (priceMin != null || priceMax != null) chips.push({ label: rangeLabel("Cena", priceMin, priceMax, kc), clear: ["cena_od", "cena_do"] });
  const areaMin = toNumber(f.plocha_od);
  const areaMax = toNumber(f.plocha_do);
  if (areaMin != null || areaMax != null) chips.push({ label: rangeLabel("Plocha", areaMin, areaMax, (n) => `${n} m²`), clear: ["plocha_od", "plocha_do"] });
  const daysMin = toNumber(f.dnu_od);
  if (daysMin != null) chips.push({ label: `V nabídce aspoň ${daysMin} dní`, clear: ["dnu_od"] });
  if (f.zlevneno === "1") chips.push({ label: "Jen zlevněné", clear: ["zlevneno"] });
  if (has(f.q)) chips.push({ label: `Hledání: „${String(f.q).trim()}“`, clear: ["q"] });
  return chips;
}
