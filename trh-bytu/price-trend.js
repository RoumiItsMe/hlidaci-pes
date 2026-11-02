// Vývoj cen v čase (stránka /vyvoj a její CSV): ceny a počty bytů po týdnech, měsících nebo čtvrtletích.
// Čisté funkce nad "entry" z computeEntries (entries.js) — nic nečtou z DB ani nezapisují.
//
// Nabídka v minulosti se dá zrekonstruovat, protože appka u každého bytu ví, kdy ho poprvé viděla, kdy zmizel
// a každou změnu ceny (události v DB). Proto je u každého období "stav ke konci období": které byty tehdy byly
// v nabídce a za kolik. Dřív než appka začala sledovat se nedá říct nic — o bytech prodaných před tím nic neví,
// takže by průměr byl zkreslený; období začínají dnem prvního sběru.

import { byPriority } from "./group.js";
import { saleMoment } from "./dashboard.js";
import { effectivePriceForStats } from "./sale-stats.js";
import { OWN_FIELDS } from "./params.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// Co appka najde při úplně prvním sběru, je nabídka, která už na trhu byla — ne "přibylé" byty. První sběr
// sekce trvá i několik běhů (víc portálů, detaily), proto celý první den.
export const INITIAL_SCAN_MS = DAY_MS;

export const PERIODS = { week: "Týdny", month: "Měsíce", quarter: "Čtvrtletí" };

const MONTHS = ["leden", "únor", "březen", "duben", "květen", "červen", "červenec", "srpen", "září", "říjen", "listopad", "prosinec"];
const MONTHS_SHORT = ["led", "úno", "bře", "dub", "kvě", "čvn", "čvc", "srp", "zář", "říj", "lis", "pro"];

/** Čas v ms; datum bez času ("2026-10-10", zadané z katastru) jako místní půlnoc, ne UTC. */
export function toMs(value) {
  if (value == null || value === "") return null;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (day) return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])).getTime();
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Začátek období, do kterého `ms` patří (místní čas): pondělí, 1. den měsíce, 1. den čtvrtletí. */
export function periodStart(ms, period) {
  const d = new Date(ms);
  if (period === "week") return new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime();
  if (period === "month") return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  return new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1).getTime();
}

function nextPeriodStart(start, period) {
  const d = new Date(start);
  if (period === "week") return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7).getTime();
  return new Date(d.getFullYear(), d.getMonth() + (period === "month" ? 1 : 3), 1).getTime();
}

const dayMonth = (ms) => {
  const d = new Date(ms);
  return `${d.getDate()}. ${d.getMonth() + 1}.`;
};

/** Popisek období do tabulky (`label`) a krátký pod osu grafu (`short`). `end` je začátek dalšího období. */
export function periodLabels(start, end, period) {
  const d = new Date(start);
  if (period === "week") return { label: `${dayMonth(start)}–${dayMonth(end - 1)} ${new Date(end - 1).getFullYear()}`, short: dayMonth(start) };
  if (period === "month") return { label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`, short: `${MONTHS_SHORT[d.getMonth()]} ${String(d.getFullYear()).slice(2)}` };
  const q = Math.floor(d.getMonth() / 3) + 1;
  return { label: `${q}. čtvrtletí ${d.getFullYear()}`, short: `Q${q} ${d.getFullYear()}` };
}

/** Výchozí délka období podle toho, jak dlouho appka sleduje: krátká historie po týdnech, dlouhá po měsících. */
export function autoPeriod(trackingStart, now = Date.now()) {
  const days = (now - trackingStart) / DAY_MS;
  return days < 120 ? "week" : days < 730 ? "month" : "quarter";
}

/** Inzerovaná cena jednoho inzerátu v okamžiku `t`: poslední cena z jeho událostí do `t` (null = tehdy bez ceny). */
function listingPriceAt(listing, events, t) {
  let price = null;
  let priceAt = -Infinity;
  let hasPriceEvents = false;
  for (const ev of events) {
    if (ev.new_price_czk == null) continue;
    hasPriceEvents = true;
    const at = toMs(ev.occurred_at);
    if (at <= t && at >= priceAt) {
      price = ev.new_price_czk;
      priceAt = at;
    }
  }
  if (price != null) return price;
  // Inzerát bez jediné události s cenou (cenu doplnil až detail nabídky): jediná známá cena je ta současná.
  return !hasPriceEvents && listing.price_czk != null && toMs(listing.first_seen_at) <= t ? listing.price_czk : null;
}

/**
 * Inzerovaná cena bytu v okamžiku `t` — stejné pořadí jako dnešní cena (bestPriceListing, group.js): napřed
 * inzeráty, které tehdy byly v nabídce, podle důvěryhodnosti portálu.
 */
export function entryPriceAt(entry, t, eventsByListing = groupEventsByListing(entry)) {
  const alive = (m) => toMs(m.first_seen_at) <= t && (!m.removed_at || toMs(m.removed_at) > t);
  const ordered = byPriority(entry.g.members);
  for (const m of [...ordered.filter(alive), ...ordered.filter((m) => !alive(m))]) {
    const price = listingPriceAt(m, eventsByListing.get(m.id) ?? [], t);
    if (price != null) return price;
  }
  return null;
}

function groupEventsByListing(entry) {
  const map = new Map();
  for (const ev of entry.events ?? []) {
    if (!map.has(ev.listing_id)) map.set(ev.listing_id, []);
    map.get(ev.listing_id).push(ev);
  }
  return map;
}

/** Byl byt v okamžiku `t` na trhu (i rezervovaný)? Od chvíle, kdy ho appka poprvé viděla, do zmizení. */
export function onMarketAt(entry, t) {
  const from = toMs(entry.discoveredAt);
  const to = toMs(entry.removedAt);
  return from != null && from <= t && (to == null || to > t);
}

// Co rezervaci inzerátu ukončí (stejně jako ve zvonečku, notifications.js).
const RESERVATION_END = new Set(["unreserved", "removed", "relisted", "reactivated"]);

/** Byl byt v okamžiku `t` rezervovaný? Stačí jeden inzerát (stejně jako dnešní stav, mergedStatus v group.js). */
export function reservedAt(entry, t, eventsByListing = groupEventsByListing(entry)) {
  for (const events of eventsByListing.values()) {
    let reserved = false;
    let lastAt = -Infinity;
    for (const ev of events) {
      if (ev.event_type !== "reserved" && !RESERVATION_END.has(ev.event_type)) continue;
      const at = toMs(ev.occurred_at);
      if (at <= t && at >= lastAt) {
        reserved = ev.event_type === "reserved";
        lastAt = at;
      }
    }
    if (reserved) return true;
  }
  return false;
}

/**
 * Kdy se byt prodal (nebo téměř jistě prodal): datum prodeje z katastru, den podání vkladu, zmizení inzerátu
 * (saleMoment, dashboard.js) — a u bytu, který je zatím jen rezervovaný, začátek rezervace.
 */
export function saleAt(entry) {
  const known = toMs(saleMoment(entry));
  if (known != null) return known;
  const reserved = (entry.events ?? []).filter((ev) => ev.event_type === "reserved").map((ev) => toMs(ev.occurred_at));
  return reserved.length ? Math.max(...reserved) : null;
}

/** Prodej se počítá stejně jako ve Statistikách ("Prodané a téměř jistě prodané", sale-stats.js). */
const countsAsSale = (e) => e.almostSold && e.statsInclude !== "exclude";

const mean = (values) => (values.length ? Math.round(values.reduce((s, v) => s + v, 0) / values.length) : null);
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Řádky vývoje cen, od nejstaršího období. Každé období nese:
 *  - `stock`: nabídka ke konci období (u probíhajícího k `now`) — počet volných bytů (bez rezervovaných),
 *    kolik z nich má cenu i plochu,
 *    průměr a medián inzerované ceny za m² a medián celkové ceny;
 *  - `added` / `removed`: kolik bytů v období přibylo a zmizelo (`initial` = nalezené prvním sběrem, nepočítají
 *    se do přibylých — na trhu už byly);
 *  - `sales`: prodané a téměř jistě prodané podle data prodeje — průměr ceny za m² (ověřená cena, jinak odhad
 *    jako ve Statistikách), kolik je ověřených a kolik odhadů, a seznam bytů za průměrem.
 * `trackingStart` = první sběr sekce (z NEfiltrovaných bytů, jinak by filtr posunul začátek sledování).
 */
export function priceTrend(entries, { period = "week", now = Date.now(), trackingStart = null } = {}) {
  const start = trackingStart ?? Math.min(...entries.map((e) => toMs(e.discoveredAt)).filter((v) => v != null));
  if (!Number.isFinite(start) || start > now) return { period, trackingStart: null, rows: [] };
  const prepared = entries.map((e) => ({ e, events: groupEventsByListing(e), discovered: toMs(e.discoveredAt), removed: toMs(e.removedAt), sale: countsAsSale(e) ? saleAt(e) : null }));

  const rows = [];
  for (let from = periodStart(start, period); from <= now; from = nextPeriodStart(from, period)) {
    const to = nextPeriodStart(from, period);
    const at = Math.min(to - 1, now);
    const inPeriod = (ms) => ms != null && ms >= from && ms < to && ms <= now;

    // Nabídka = volné byty: rezervovaný už má kupce (a dnešní nabídka na Přehledu je taky bez rezervovaných).
    const onMarket = prepared.filter((p) => onMarketAt(p.e, at) && !reservedAt(p.e, at, p.events));
    const perM2 = [];
    const prices = [];
    for (const p of onMarket) {
      const price = entryPriceAt(p.e, at, p.events);
      if (price == null) continue;
      prices.push(price);
      // Zaokrouhleno po bytech stejně jako dnešní cena za m² (entries.js), ať medián sedí s Přehledem na korunu.
      if (p.e.rep.area_m2) perM2.push(Math.round(price / p.e.rep.area_m2));
    }

    const sold = prepared.filter((p) => inPeriod(p.sale)).map(({ e }) => {
      const { price, basis } = effectivePriceForStats(e);
      return { id: e.rep.id, address: e.address || e.city || "—", areaM2: e.rep.area_m2 ?? null, basis, pricePerM2: price != null && e.rep.area_m2 ? Math.round(price / e.rep.area_m2) : null };
    });
    const soldPriced = sold.filter((s) => s.pricePerM2 != null);

    const added = prepared.filter((p) => inPeriod(p.discovered));
    const initial = added.filter((p) => p.discovered < start + INITIAL_SCAN_MS).length;
    rows.push({
      start: from,
      end: to,
      ...periodLabels(from, to, period),
      partial: to > now,
      at,
      stock: { count: onMarket.length, priced: perM2.length, avgPerM2: mean(perM2), medianPerM2: median(perM2), medianPrice: median(prices) },
      added: added.length - initial,
      initial,
      removed: prepared.filter((p) => inPeriod(p.removed)).length,
      sales: {
        count: sold.length,
        priced: soldPriced.length,
        avgPerM2: mean(soldPriced.map((s) => s.pricePerM2)),
        verified: soldPriced.filter((s) => s.basis === "verified").length,
        estimated: soldPriced.filter((s) => s.basis !== "verified").length,
        items: soldPriced.sort((a, b) => a.pricePerM2 - b.pricePerM2),
      },
    });
  }
  return { period, trackingStart: start, rows };
}

/** Volby stavu bytu ve filtru: vše, bez novostaveb, jednotlivé stavy z hodnocení (params.js) a "nezadáno". */
export const CONDITION_FILTERS = [
  ["bez-novostaveb", "Bez novostaveb"],
  ...OWN_FIELDS.find((f) => f.column === "own_condition").options,
  ["nezadano", "Stav nezadaný"],
];

/** Byty podle filtru stránky (`city`, `disposition`, `condition` — null = bez omezení). */
export function filterTrendEntries(entries, { city = null, disposition = null, condition = null } = {}) {
  return entries.filter(
    (e) =>
      (!city || e.city === city) &&
      (!disposition || (e.rep.disposition || "—") === disposition) &&
      (!condition ||
        (condition === "bez-novostaveb" ? e.ownCondition !== "novostavba" : condition === "nezadano" ? !e.ownCondition : e.ownCondition === condition))
  );
}

/** Města a dispozice, které v datech jsou, od nejčastějších — pro výběry ve filtru. */
export function trendFilterOptions(entries) {
  const counted = (key) => {
    const counts = new Map();
    for (const e of entries) {
      const v = key(e);
      if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "cs")).map(([value, count]) => ({ value, count }));
  };
  return { cities: counted((e) => e.city), dispositions: counted((e) => e.rep.disposition || "—") };
}

/** Změna v procentech mezi dvěma hodnotami (null, když jedna chybí). */
export function percentChange(from, to) {
  return from && to != null ? ((to - from) / from) * 100 : null;
}

const csvCell = (v) => {
  if (v == null) return "";
  const s = String(v);
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const isoDay = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * Tabulka vývoje jako CSV pro Excel: středník (česká verze Excelu jím dělí sloupce), BOM (jinak Excel rozbije
 * diakritiku), čísla bez oddělovačů tisíců, data ISO. Jeden řádek = jedno období, od nejstaršího.
 */
export function trendCsv(trend) {
  const header = [
    "Od",
    "Do",
    "Období",
    "Probíhá",
    "V nabídce",
    "S cenou a plochou",
    "Průměr nabídka Kč/m²",
    "Medián nabídka Kč/m²",
    "Medián nabídka Kč",
    "Přibylo",
    "Z prvního sběru",
    "Zmizelo",
    "Prodáno",
    "Průměr prodej Kč/m²",
    "Prodej ověřená cena",
    "Prodej odhad",
  ];
  const lines = trend.rows.map((r) =>
    [
      isoDay(r.start),
      isoDay(r.end - 1),
      r.label,
      r.partial ? "ano" : "",
      r.stock.count,
      r.stock.priced,
      r.stock.avgPerM2,
      r.stock.medianPerM2,
      r.stock.medianPrice,
      r.added,
      r.initial || "",
      r.removed,
      r.sales.count,
      r.sales.avgPerM2,
      r.sales.verified,
      r.sales.estimated,
    ]
      .map(csvCell)
      .join(";")
  );
  return `\uFEFF${[header.join(";"), ...lines].join("\r\n")}\r\n`;
}
