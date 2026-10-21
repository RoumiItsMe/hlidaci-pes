// Dohledatelnost zmizelých bytů BEZ rezervace: u kterých se dá v katastru zjistit, co se
// s nimi stalo, a u kterých ne — a proč.
//
// Zmizelý byt bez rezervace nic neříká o prodeji (portály po zmizení inzerátu nesdělují důvod;
// iDNES napíše jen datum, ostatní nic) a katastr jde hledat jen podle domu. Číslo "27 zmizelých,
// hlídá se 10" ale dobře nevypovídá — část z nich dohledávat nejde z principu, část nikdy
// prodej nebyla. Tenhle modul je roztřídí, ať je vidět, kolik je skutečně neodhalených a které
// z nich se dají zachránit doplněním adresy (čisté funkce nad "entry" z computeEntries).

import { pragueDay } from "./kn-priority.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Kolik bytů z jednoho portálu a města musí zmizet týž den, aby šlo o stažený balík. */
export const BULK_MIN_FLATS = 3;
/** Zmizelý byt bez rezervace hlídá API katastru tolik dní po zmizení (kn-scan.js UNRESERVED_HORIZON_DAYS). */
export const WATCH_HORIZON_DAYS = 120;

export const CATEGORY_LABELS = {
  watched: "hlídá API katastru",
  closed: "hlídání skončilo (uplynulo okno po zmizení)",
  unverifiable: "nejde ověřit v katastru (družstevní byt, novostavba, dům bez jednotek)",
  bulk: "stažený balík (víc stejných bytů zmizelo týž den) — nejspíš ne prodej",
  unknown: "adresa označena jako nedohledatelná",
  noWatch: "adresa je, ale dům v katastru appka nenašla",
  missing: "chybí adresa — dá se zachránit doplněním",
};

/** Zmizelé byty bez rezervace a bez rozhodnutí z katastru (stejný výběr jako sekce na stránce Kontrola v katastru). */
export function vanishedUnreserved(entries) {
  return entries.filter((e) => !e.hidden && e.status === "removed" && !e.saleVerdict && !e.track);
}

const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
const sameType = (a, b) => a.rep.disposition && a.rep.disposition === b.rep.disposition && a.rep.area_m2 != null && b.rep.area_m2 != null && Math.abs(a.rep.area_m2 - b.rep.area_m2) <= 0.5;

/**
 * Stažený balík: ≥ minFlats bytů ze STEJNÉHO portálu a města zmizelo týž den a aspoň dva z nich jsou
 * stejného typu (dispozice + plocha) — typicky developerský projekt nebo makléř, který stáhl nabídku.
 * Byt, který zmizel z víc portálů najednou, mezi ně nepatří (to je skutečné zmizení z trhu).
 * @returns Set bytů (entry), které k nějakému balíku patří
 */
export function findBulkDelistings(entries, { minFlats = BULK_MIN_FLATS } = {}) {
  const groups = new Map();
  for (const e of entries) {
    const sources = new Set(e.g.members.map((m) => m.source));
    if (sources.size !== 1 || !e.removedAt || !e.city) continue;
    const key = `${[...sources][0]}|${norm(e.city)}|${pragueDay(Date.parse(e.removedAt))}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const bulk = new Set();
  for (const list of groups.values()) {
    if (list.length < minFlats) continue;
    const hasTwin = list.some((a, i) => list.some((b, j) => i !== j && sameType(a, b)));
    if (hasTwin) for (const e of list) bulk.add(e);
  }
  return bulk;
}

/** Do které skupiny zmizelý byt patří (první shoda platí) a co s tím. */
export function categorize(e, { bulk = new Set(), now = Date.now() } = {}) {
  const info = e.addressInfo ?? {};
  const daysGone = e.removedAt ? Math.floor((now - Date.parse(e.removedAt)) / DAY_MS) : null;
  if (info.state === "known") {
    if (e.unreservedWatch?.unverifiable || e.newBuildPending) return "unverifiable";
    if (!e.unreservedWatch) return "noWatch";
    return daysGone != null && daysGone > WATCH_HORIZON_DAYS ? "closed" : "watched";
  }
  if (info.state === "notNeeded" || e.unverifiable || e.newBuildPending) return "unverifiable";
  if (bulk.has(e)) return "bulk";
  if (info.state === "unknown") return "unknown";
  return "missing";
}

/**
 * Roztřídění zmizelých bytů bez rezervace.
 * @returns { total, counts: {kategorie: počet}, traceable (hlídá se), untraceable (nejde z principu nebo není prodej),
 *            actionable: [{ id, label, address, daysGone, category, why }] — ty, co se dají zachránit adresou (nejnovější první) }
 */
export function traceVanished(entries, { now = Date.now() } = {}) {
  const flats = vanishedUnreserved(entries);
  const bulk = findBulkDelistings(flats);
  const counts = Object.fromEntries(Object.keys(CATEGORY_LABELS).map((k) => [k, 0]));
  const rows = flats.map((e) => {
    const category = categorize(e, { bulk, now });
    counts[category]++;
    return { entry: e, category };
  });
  const actionable = rows
    .filter((r) => r.category === "missing" || r.category === "noWatch")
    .map(({ entry: e, category }) => ({
      id: e.rep.id,
      label: [e.rep.disposition, e.rep.area_m2 ? `${e.rep.area_m2} m²` : null].filter(Boolean).join(", ") || "byt",
      address: e.address || null,
      daysGone: e.removedAt ? Math.floor((now - Date.parse(e.removedAt)) / DAY_MS) : null,
      category,
      why: CATEGORY_LABELS[category],
    }))
    .sort((a, b) => (a.daysGone ?? Infinity) - (b.daysGone ?? Infinity));
  return {
    total: flats.length,
    counts,
    traceable: counts.watched,
    untraceable: counts.unverifiable + counts.bulk + counts.unknown + counts.closed,
    actionable,
  };
}
