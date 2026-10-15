// node --test trh-bytu/dashboard.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { indexEntriesByListing, recentOffers, recentSales, saleMoment, recentPriceDrops, marketSnapshot, attention, relativeTime } from "./dashboard.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-15T10:00:00.000Z");
const ago = (days) => new Date(NOW - days * DAY).toISOString();

let seq = 0;
function entry(over = {}) {
  const id = `s:${++seq}`;
  return {
    g: { members: [{ id }] },
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
  assert.deepEqual(attention(entries), { enterPrice: 2, confirmFiling: 2, manualCheck: 2, noAddress: 2, total: 8 });
});

test("čas od posledního sběru česky", () => {
  assert.equal(relativeTime(null, NOW), null);
  assert.equal(relativeTime(new Date(NOW - 20 * 1000).toISOString(), NOW), "právě teď");
  assert.equal(relativeTime(new Date(NOW - 5 * 60 * 1000).toISOString(), NOW), "před 5 min");
  assert.equal(relativeTime(new Date(NOW - 3 * 60 * 60 * 1000).toISOString(), NOW), "před 3 h");
  assert.equal(relativeTime(ago(1), NOW), "před 1 dnem");
  assert.equal(relativeTime(ago(5), NOW), "před 5 dny");
});
