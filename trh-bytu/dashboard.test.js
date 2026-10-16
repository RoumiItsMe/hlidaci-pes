// node --test trh-bytu/dashboard.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { indexEntriesByListing, recentOffers, recentSales, saleMoment, recentPriceDrops, marketSnapshot, attention, missingEssentials, relativeTime, parseRunSummary } from "./dashboard.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-15T10:00:00.000Z");
const ago = (days) => new Date(NOW - days * DAY).toISOString();

let seq = 0;
function entry(over = {}) {
  const id = `s:${++seq}`;
  return {
    g: { members: [{ id }] },
    // Základní údaje vyplněné (viz ESSENTIAL_FIELDS), ať testy nevyrábí úkol "doplnit údaje".
    rep: { id, disposition: "2+1", area_m2: 50 },
    params: { ownership: "Osobní" },
    ownCondition: "maintained",
    hidden: false,
    status: "active",
    discoveredAt: ago(1),
    pricePerM2: null,
    verifiedSalePrice: null,
    verifiedSaleDate: null,
    knFiledAt: null,
    removedAt: null,
    saleVerdict: null,
    triage: null,
    track: null,
    unreservedWatch: null,
    knCheckedAt: null,
    addressInfo: { state: "known" },
    ...over,
  };
}
const ids = (entries) => entries.map((e) => e.g.members[0].id);

test("nejnovější nabídky: jen živé a neskryté, nejnověji objevené první, s limitem", () => {
  const a = entry({ discoveredAt: ago(5) });
  const b = entry({ discoveredAt: ago(1), status: "reserved" });
  const c = entry({ discoveredAt: ago(0.1), hidden: true });
  const d = entry({ discoveredAt: ago(0.2), status: "removed" });
  const e = entry({ discoveredAt: ago(3) });
  assert.deepEqual(ids(recentOffers([a, b, c, d, e], { limit: 2 })), ids([b, e]));
  assert.deepEqual(ids(recentOffers([a, b, c, d, e])), ids([b, e, a]));
});

test("datum prodeje: z katastru, jinak den podání vkladu, jinak zmizení; bez dat null", () => {
  assert.equal(saleMoment(entry({ verifiedSaleDate: "2026-10-01", knFiledAt: "2026-09-20", removedAt: ago(9) })), "2026-10-01");
  assert.equal(saleMoment(entry({ knFiledAt: "2026-09-20", removedAt: ago(9) })), "2026-09-20");
  assert.equal(saleMoment(entry({ removedAt: ago(9) })), ago(9));
  assert.equal(saleMoment(entry()), null);
});

test("nejnovější prodeje: potvrzené i čekající na ověření, bez skrytých a bez obyčejně zmizelých", () => {
  const confirmed = entry({ status: "sold", verifiedSalePrice: 2850000, knFiledAt: ago(5).slice(0, 10) });
  const pending = entry({ status: "sold", removedAt: ago(2) });
  const goneAfterReservation = entry({ status: "removed", triage: { wasReserved: true }, removedAt: ago(9) });
  const plainRemoved = entry({ status: "removed", triage: { wasReserved: false }, removedAt: ago(1) });
  const hiddenSale = entry({ status: "sold", verifiedSalePrice: 1, hidden: true, removedAt: ago(0.5) });
  const noDate = entry({ status: "sold" });
  const out = recentSales([confirmed, pending, goneAfterReservation, plainRemoved, hiddenSale, noDate]);
  assert.deepEqual(ids(out), ids([pending, confirmed, goneAfterReservation, noDate]));
});

function priceNotification(e, oldPrice, newPrice, daysAgo) {
  return { type: "price", group: e.g, occurredAt: ago(daysAgo), detail: { oldPrice, newPrice } };
}

test("největší slevy: řetěz změn jednoho bytu se spojí do jedné slevy, největší procento první", () => {
  const a = entry();
  const b = entry();
  const index = indexEntriesByListing([a, b]);
  const notifications = [
    priceNotification(a, 3300000, 3200000, 2), // a: 3,5 M → 3,2 M po dvou krocích
    priceNotification(a, 3500000, 3300000, 6),
    priceNotification(b, 4000000, 3800000, 1), // b: −5 %
  ];
  const out = recentPriceDrops(notifications, index, { now: NOW });
  assert.deepEqual(out.map((d) => [d.entry === a, d.oldPrice, d.newPrice]), [
    [true, 3500000, 3200000],
    [false, 4000000, 3800000],
  ]);
  assert.ok(out[0].pct > out[1].pct);
});

test("největší slevy: zdražení, staré změny, zmizelé a skryté byty se nepočítají", () => {
  const up = entry();
  const old = entry();
  const gone = entry({ status: "removed" });
  const hid = entry({ hidden: true });
  const net = entry(); // zlevnil a zase zdražil na původní
  const index = indexEntriesByListing([up, old, gone, hid, net]);
  const notifications = [
    priceNotification(up, 3000000, 3200000, 1),
    priceNotification(old, 3000000, 2500000, 40),
    priceNotification(gone, 3000000, 2500000, 1),
    priceNotification(hid, 3000000, 2500000, 1),
    priceNotification(net, 3000000, 2800000, 4),
    priceNotification(net, 2800000, 3000000, 2),
  ];
  assert.deepEqual(recentPriceDrops(notifications, index, { now: NOW }), []);
  // V delším okně přibude jen "old"; "net" skončil na původní ceně, takže slevou není.
  assert.deepEqual(recentPriceDrops(notifications, index, { now: NOW, days: 60 }).map((d) => d.entry), [old]);
});

test("pás čísel: počty podle stavu, nové za týden, medián Kč/m² jen z bytů v nabídce", () => {
  const entries = [
    entry({ pricePerM2: 50000, discoveredAt: ago(2) }),
    entry({ pricePerM2: 60000, discoveredAt: ago(30) }),
    entry({ pricePerM2: 70000, discoveredAt: ago(30) }),
    entry({ status: "reserved", pricePerM2: 999999, discoveredAt: ago(1) }),
    entry({ status: "sold", verifiedSalePrice: 1000000 }),
    entry({ status: "sold" }),
    entry({ status: "removed", triage: { wasReserved: true } }),
    entry({ hidden: true, pricePerM2: 1 }),
  ];
  const snap = marketSnapshot(entries, { now: NOW, weekDrops: 4 });
  assert.deepEqual(snap, { active: 3, reserved: 1, newThisWeek: 2, dropsThisWeek: 4, pending: 2, confirmed: 1, medianPricePerM2: 60000 });
});

const taskCounts = (entries) => Object.fromEntries(attention(entries).tasks.map((t) => [t.key, t.count]));

test("čeká na tebe: cena, plomba k potvrzení, ruční kontrola, chybějící adresa — a nic ze skrytých", () => {
  const due = (kind, over = {}) => entry({ status: "reserved", track: { stage: "filing", due: true, kind }, ...over });
  const entries = [
    due("price-ready"),
    due("price"),
    due("confirm"),
    due("cash"),
    due("vanish"),
    due("mortgage", { hidden: true }),
    due("cash", { addressInfo: { state: "missing" } }), // bez adresy: řeší se doplněním adresy, ne kontrolou
    entry({ status: "removed", unreservedWatch: { needsConfirm: true, confirmAt: Date.parse(ago(3)) } }),
    entry({ status: "removed", unreservedWatch: { needsConfirm: true, confirmAt: Date.parse(ago(9)) }, knCheckedAt: ago(2) }), // odloženo "zatím nic"
    entry({ addressInfo: { state: "missing" } }),
    entry({ status: "removed", addressInfo: { state: "missing" } }), // zmizelý bez adresy se nepřipomíná
  ];
  const { tasks } = attention(entries);
  assert.deepEqual(taskCounts(entries), { enterPrice: 2, confirmFiling: 2, manualCheck: 2, noAddress: 2 });
  // Pořadí úkolů: nejdřív katastr, nakonec adresa.
  assert.deepEqual(tasks.map((t) => t.key), ["enterPrice", "confirmFiling", "manualCheck", "noAddress"]);
  assert.equal(tasks[0].entries.length, 2);
});

test("bez úkolů je seznam prázdný", () => {
  assert.deepEqual(attention([entry(), entry({ status: "removed" })]), { tasks: [], total: 0 });
});

test("chybějící základní údaje: dispozice, plocha, vlastnictví, stav — jen u bytů, kde se vyžadují", () => {
  const bare = { rep: { disposition: null, area_m2: null }, params: {}, ownCondition: null };
  assert.deepEqual(missingEssentials(entry(bare)), ["disposition", "area", "ownership", "condition"]);
  assert.deepEqual(missingEssentials(entry({ ownCondition: null })), ["condition"]);
  assert.deepEqual(missingEssentials(entry({ params: {} })), ["ownership"]);
  assert.deepEqual(missingEssentials(entry()), []);
  // nevyžaduje se u skrytého, u obyčejně zmizelého ani u rezervace zrušené / staženého bytu
  assert.deepEqual(missingEssentials(entry({ ...bare, hidden: true })), []);
  assert.deepEqual(missingEssentials(entry({ ...bare, status: "removed", triage: { wasReserved: false } })), []);
  // vyžaduje se u živé nabídky i rezervace a u prodaného / téměř jistě prodaného bytu (kvůli statistice po rekonstrukci)
  assert.equal(missingEssentials(entry({ ...bare, status: "reserved" })).length, 4);
  assert.equal(missingEssentials(entry({ ...bare, status: "sold" })).length, 4);
  assert.equal(missingEssentials(entry({ ...bare, status: "removed", triage: { wasReserved: true } })).length, 4);
});

test("úkol 'doplnit údaje': počet bytů, co nejčastěji chybí, odkaz na filtr v tabulce srovnání", () => {
  const entries = [
    entry({ ownCondition: null }),
    entry({ ownCondition: null }),
    entry({ ownCondition: null, params: {} }),
    entry({ hidden: true, ownCondition: null }),
    entry(),
  ];
  const task = attention(entries).tasks.find((t) => t.key === "missingData");
  assert.equal(task.count, 3);
  assert.equal(task.href, "/tabulka?chybi=udaje");
  assert.ok(task.why.includes("stav (před/po rekonstrukci) 3×, vlastnictví 1×"), task.why);
});

test("čas od posledního sběru česky", () => {
  assert.equal(relativeTime(null, NOW), null);
  assert.equal(relativeTime(new Date(NOW - 20 * 1000).toISOString(), NOW), "právě teď");
  assert.equal(relativeTime(new Date(NOW - 5 * 60 * 1000).toISOString(), NOW), "před 5 min");
  assert.equal(relativeTime(new Date(NOW - 3 * 60 * 60 * 1000).toISOString(), NOW), "před 3 h");
  assert.equal(relativeTime(ago(1), NOW), "před 1 dnem");
  assert.equal(relativeTime(ago(5), NOW), "před 5 dny");
});

const LOG = [
  "[2026-10-16T06:00:00.000Z] === Start běhu ===",
  "[2026-10-16T06:01:36.853Z] Hotovo. 3 nových bytů zaevidováno, 1 změn ceny, 0 zmizelo z nabídky, 0 znovu vloženo, 0 změn rezervace, 0 prodáno.",
  "[2026-10-16T12:00:00.000Z] === Start běhu ===",
  "[2026-10-16T12:01:10.000Z] Hotovo. 0 nových bytů zaevidováno, 0 změn ceny, 0 zmizelo z nabídky, 0 znovu vloženo, 0 změn rezervace, 0 prodáno.",
].join("\n");

test("souhrn sběru z logu: jen nenulové počty a jen běh po zadaném čase", () => {
  assert.deepEqual(parseRunSummary(LOG, Date.parse("2026-10-16T05:59:00.000Z")), { kind: "done", text: "Hotovo: beze změn.", warning: false }); // poslední řádek vyhrává
  const first = LOG.split("\n").slice(0, 2).join("\n");
  assert.deepEqual(parseRunSummary(first, Date.parse("2026-10-16T05:59:00.000Z")), { kind: "done", text: "Hotovo: 3 nových bytů zaevidováno, 1 změn ceny.", warning: false });
  assert.equal(parseRunSummary(first, Date.parse("2026-10-16T07:00:00.000Z")), null);
});

test("souhrn sběru: varování při selhání zdroje a přeskočený běh", () => {
  const warn = "[2026-10-16T06:01:36.853Z] Hotovo. 1 nových bytů zaevidováno, 0 změn ceny, 0 zmizelo z nabídky, 0 znovu vloženo, 0 změn rezervace, 0 prodáno. (u některého zdroje selhalo stahování — zkontroluj log výše.)";
  assert.deepEqual(parseRunSummary(warn, 0), { kind: "done", text: "Hotovo: 1 nových bytů zaevidováno.", warning: true });
  assert.deepEqual(parseRunSummary("[2026-10-16T06:00:00.000Z] Jiný sběrný běh právě probíhá — tenhle se přeskakuje.", 0), { kind: "skipped" });
  assert.equal(parseRunSummary("", 0), null);
});
