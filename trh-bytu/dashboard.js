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
 * Základní údaje o bytě, bez kterých se nedá porovnávat ani počítat statistika
 * ceny po rekonstrukci. Appka je zkouší vyčíst z inzerátu sama (extract-params.js,
 * detect-own-fields.js); co se nepodaří, zůstane k doplnění. `column` je sloupec
 * tabulky srovnání, kde se údaj doplňuje (viz renderComparisonTable).
 */
export const ESSENTIAL_FIELDS = [
  { key: "disposition", label: "dispozice", has: (e) => Boolean(e.rep?.disposition) },
  { key: "area", label: "plocha", has: (e) => Boolean(e.rep?.area_m2) },
  { key: "ownership", label: "vlastnictví", has: (e) => Boolean(e.params?.ownership) },
  { key: "condition", label: "stav (před/po rekonstrukci)", has: (e) => Boolean(e.ownCondition) },
];

/** Jestli se údaje o bytě vůbec vyžadují: živá nabídka, nebo prodaný / téměř jistě prodaný byt. */
export function needsEssentials(e) {
  return !e.hidden && (isLive(e) || isSoldOrAlmost(e));
}

/** Klíče chybějících základních údajů bytu (prázdné pole = vše vyplněno nebo se nevyžaduje). */
export function missingEssentials(e) {
  return needsEssentials(e) ? ESSENTIAL_FIELDS.filter((f) => !f.has(e)).map((f) => f.key) : [];
}

/**
 * Co čeká na uživatele — všechny úkoly na jednom místě, od nejdůležitějších.
 * Katastr (stejná pravidla jako fronta Katastr, jen spočítaná): zadat cenu
 * (vklad podán / řízení skončilo), potvrdit plombu, kterou appka k bytu
 * nepřiřadila, zkontrolovat ručně podle rozvrhu. Pak údaje, které appka
 * nevyčetla z inzerátu (viz ESSENTIAL_FIELDS), a přesná adresa — bez ní se byt
 * v katastru nedá hledat ani hlídat.
 *
 * Vrací `{ tasks: [{ key, count, href, label, why, entries }], total }`; úkoly s
 * nulou se vynechají. `entries` jsou byty, kterých se úkol týká.
 */
export function attention(entries) {
  const shown = entries.filter((e) => !e.hidden);
  const known = (e) => e.addressInfo?.state === "known";
  const due = shown.filter((e) => e.track && (e.track.stage === "filing" || e.track.stage === "price") && e.track.due && known(e));
  const enterPrice = due.filter((e) => e.track.kind === "price" || e.track.kind === "price-ready");
  const confirmTracked = due.filter((e) => e.track.kind === "confirm");
  // Zmizelý byt bez rezervace, u kterého se objevila plomba (viz renderKnQueue).
  const confirmUnreserved = shown.filter(
    (e) => !e.track && e.unreservedWatch?.needsConfirm && !(e.knCheckedAt && e.unreservedWatch.confirmAt <= Date.parse(e.knCheckedAt))
  );
  const confirmFiling = [...confirmTracked, ...confirmUnreserved];
  const manualCheck = due.filter((e) => !enterPrice.includes(e) && !confirmTracked.includes(e));
  const incomplete = shown.filter((e) => missingEssentials(e).length > 0);
  const noAddress = shown.filter((e) => e.addressInfo?.state === "missing" && isLive(e));

  // Co nejčastěji chybí: "stav (12×), vlastnictví (3×)".
  const missingCounts = ESSENTIAL_FIELDS.map((f) => ({ label: f.label, n: incomplete.filter((e) => missingEssentials(e).includes(f.key)).length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);

  const tasks = [
    { key: "enterPrice", entries: enterPrice, href: "/kontrola", label: "Zadat cenu prodeje", why: "vklad je podaný nebo řízení skončilo" },
    { key: "confirmFiling", entries: confirmFiling, href: "/kontrola", label: "Potvrdit plombu nalezenou v katastru", why: "appka ji nedokázala sama přiřadit k bytu" },
    { key: "manualCheck", entries: manualCheck, href: "/kontrola", label: "Zkontrolovat v katastru", why: "nastal termín kontroly" },
    {
      key: "missingData",
      entries: incomplete,
      href: "/tabulka?chybi=udaje",
      label: "Doplnit chybějící údaje",
      why: `appka je nevyčetla z inzerátu — ${missingCounts.map((x) => `${x.label} ${x.n}×`).join(", ")}`,
    },
    { key: "noAddress", entries: noAddress, href: "/byty?adresa=chybi", label: "Doplnit přesnou adresu", why: "bez ní se byt v katastru nedá hledat ani hlídat" },
  ]
    .filter((t) => t.entries.length > 0)
    .map(({ entries: list, ...task }) => ({ ...task, count: list.length, entries: list }));
  return { tasks, total: tasks.reduce((sum, t) => sum + t.count, 0) };
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

/**
 * Souhrn posledního dokončeného sběru z logu (track.log): řádek "Hotovo. …"
 * zapsaný po `sinceMs`. Vrací `{ kind: "done", text, warning }` (nulové počty se
 * vynechají), `{ kind: "skipped" }` (sběr se přeskočil, protože běžel jiný), nebo
 * null, když v logu po `sinceMs` nic takového není.
 */
export function parseRunSummary(logText, sinceMs = 0) {
  let result = null;
  for (const line of logText.split(/\r?\n/)) {
    const m = /^\[(\S+?)\] (.*)$/.exec(line);
    if (!m || !(Date.parse(m[1]) >= sinceMs - 2000)) continue;
    const body = m[2];
    if (body.startsWith("Jiný sběrný běh právě probíhá")) {
      result = { kind: "skipped" };
    } else if (body.startsWith("Hotovo. ")) {
      const rest = body.slice("Hotovo. ".length);
      const counts = rest.replace(/\s*\(.*\)\s*$/, "").replace(/\.$/, "");
      const parts = counts.split(", ").filter((p) => p && !/^0 /.test(p));
      result = { kind: "done", text: parts.length ? `Hotovo: ${parts.join(", ")}.` : "Hotovo: beze změn.", warning: /selhalo stahování/.test(rest) };
    }
  }
  return result;
}
