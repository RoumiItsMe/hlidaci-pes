// Přehled (úvodní dashboard, /prehled): co je nového a co čeká na rozhodnutí.
// Čisté funkce nad "entry" z computeEntries (server.js) a nad upozorněními ze
// zvonečku (notifications.js) — HTML skládá server.js. Skryté byty se tu
// nikdy nezobrazují (uživatel je vyřadil), výjimkou není ani prodej.

import { isConfirmedSale, isPendingSale, isSoldOrAlmost } from "./sale-status.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

const isLive = (e) => e.status === "active" || e.status === "reserved";
const timeOf = (iso) => Date.parse(iso) || 0;

/** Inzerát → byt (skupina), ať jde z upozornění najít entry bez ohledu na portál. */
export function indexEntriesByListing(entries) {
  const index = new Map();
  for (const e of entries) for (const m of e.g.members) index.set(m.id, e);
  return index;
}

/** Nejnověji objevené nabídky, které ještě něco znamenají (v nabídce / rezervované). */
export function recentOffers(entries, { limit = 6 } = {}) {
  return entries
    .filter((e) => !e.hidden && isLive(e))
    .sort((a, b) => timeOf(b.discoveredAt) - timeOf(a.discoveredAt))
    .slice(0, limit);
}

/**
 * Kdy se byt nejspíš prodal — nejpřesnější ze známých dat: datum prodeje z
 * katastru (zadané ručně), den podání vkladu, nakonec den zmizení inzerátu.
 */
export function saleMoment(e) {
  return e.verifiedSaleDate || e.knFiledAt || e.removedAt || null;
}

/** Prodané i téměř jistě prodané byty, nejnovější prodej první (bez data nakonec). */
export function recentSales(entries, { limit = 6 } = {}) {
  return entries
    .filter((e) => !e.hidden && isSoldOrAlmost(e))
    .sort((a, b) => timeOf(saleMoment(b)) - timeOf(saleMoment(a)))
    .slice(0, limit);
}

/**
 * Největší slevy za posledních `days` dní u bytů, které ještě jsou na trhu.
 * Řetěz změn ceny jednoho bytu se spojí do jedné slevy (nejstarší původní →
 * nejnovější nová cena), takže byt, který zlevnil třikrát, není ve výpisu třikrát
 * a zlevnění následované zdražením se nepočítá. `notifications` = ze zvonečku.
 */
export function recentPriceDrops(notifications, entryOfListing, { now = Date.now(), days = 30, limit = 5 } = {}) {
  const from = now - days * DAY_MS;
  const byEntry = new Map();
  for (const n of notifications) {
    if (n.type !== "price" || timeOf(n.occurredAt) < from) continue;
    const entry = entryOfListing.get(n.group.members[0].id);
    if (!entry || entry.hidden || !isLive(entry)) continue;
    if (!byEntry.has(entry)) byEntry.set(entry, []);
    byEntry.get(entry).push(n);
  }
  const drops = [];
  for (const [entry, chain] of byEntry) {
    chain.sort((a, b) => timeOf(a.occurredAt) - timeOf(b.occurredAt));
    const oldPrice = chain[0].detail.oldPrice;
    const last = chain[chain.length - 1];
    const newPrice = last.detail.newPrice;
    if (oldPrice == null || newPrice == null || newPrice >= oldPrice) continue;
    drops.push({ entry, oldPrice, newPrice, pct: (oldPrice - newPrice) / oldPrice, at: last.occurredAt });
  }
  return drops.sort((a, b) => b.pct - a.pct || timeOf(b.at) - timeOf(a.at)).slice(0, limit);
}

function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** Čísla do pásu nahoře: kolik čeho je a co se za týden pohnulo. */
export function marketSnapshot(entries, { now = Date.now(), weekDrops = 0 } = {}) {
  const shown = entries.filter((e) => !e.hidden);
  const active = shown.filter((e) => e.status === "active");
  return {
    active: active.length,
    reserved: shown.filter((e) => e.status === "reserved").length,
    newThisWeek: shown.filter((e) => isLive(e) && now - timeOf(e.discoveredAt) < 7 * DAY_MS).length,
    dropsThisWeek: weekDrops,
    pending: shown.filter(isPendingSale).length,
    confirmed: shown.filter(isConfirmedSale).length,
    medianPricePerM2: median(active.map((e) => e.pricePerM2)),
  };
}

/**
 * Co čeká na uživatele (stejná pravidla jako fronta Katastr, jen spočítaná):
 * zadat cenu (vklad podán / řízení skončilo), potvrdit plombu, kterou appka
 * k bytu nepřiřadila, zkontrolovat ručně podle rozvrhu a doplnit adresu — bez ní
 * se byt v katastru nedá hledat ani hlídat.
 */
export function attention(entries) {
  const shown = entries.filter((e) => !e.hidden);
  const known = (e) => e.addressInfo?.state === "known";
  const due = shown.filter((e) => e.track && (e.track.stage === "filing" || e.track.stage === "price") && e.track.due && known(e));
  const enterPrice = due.filter((e) => e.track.kind === "price" || e.track.kind === "price-ready").length;
  const confirmTracked = due.filter((e) => e.track.kind === "confirm").length;
  // Zmizelý byt bez rezervace, u kterého se objevila plomba (viz renderKnQueue).
  const confirmUnreserved = shown.filter(
    (e) => !e.track && e.unreservedWatch?.needsConfirm && !(e.knCheckedAt && e.unreservedWatch.confirmAt <= Date.parse(e.knCheckedAt))
  ).length;
  const confirmFiling = confirmTracked + confirmUnreserved;
  const manualCheck = due.length - enterPrice - confirmTracked;
  const noAddress = shown.filter((e) => e.addressInfo?.state === "missing" && isLive(e)).length;
  return { enterPrice, confirmFiling, manualCheck, noAddress, total: enterPrice + confirmFiling + manualCheck + noAddress };
}

/** "před 5 min", "před 3 h", "před 2 dny" — pro údaj o posledním sběru. */
export function relativeTime(iso, now = Date.now()) {
  if (!iso) return null;
  const diff = Math.max(0, now - Date.parse(iso));
  if (diff < MINUTE_MS) return "právě teď";
  if (diff < HOUR_MS) return `před ${Math.floor(diff / MINUTE_MS)} min`;
  if (diff < DAY_MS) return `před ${Math.floor(diff / HOUR_MS)} h`;
  const days = Math.floor(diff / DAY_MS);
  return days === 1 ? "před 1 dnem" : `před ${days} dny`;
}
