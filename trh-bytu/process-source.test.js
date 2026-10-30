// node --test trh-bytu/process-source.test.js
// Zápis zdroje do databáze (process-source.js): běžný sběr (hlídá, že přesun z track.js nic nezměnil) a PŘEHRÁVÁNÍ
// uloženého snímku z cloudového sběrače — všechno se zapíše k času pozorování, ne k "teď", a nic se nestahuje navíc.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initDb, getListing } from "./db.js";
import { REGION_WATCH } from "./region.js";
import { processSource } from "./process-source.js";

const T1 = "2026-10-28T04:10:00.000Z";
const T2 = "2026-10-29T04:10:00.000Z";
const T3 = "2026-10-30T04:10:00.000Z";

const logs = [];
const log = (line) => logs.push(line);
const detailOf = (extra = {}) => ({ description: "Krásný byt po rekonstrukci v klidné části Ústí nad Orlicí.", photoUrls: [], params: {}, geo: null, reserved: false, sold: false, ...extra });
const itemOf = (id, extra = {}) => ({ id, title: "Prodej bytu 2+1 52 m²", url: `https://example.test/${id}`, priceCzk: 3_000_000, address: "Ústí nad Orlicí", ...extra });

function setup({ details = {}, flags = {}, detailError = null } = {}) {
  const db = initDb(new DatabaseSync(":memory:"));
  const calls = { detail: [], notified: [], probes: [] };
  const source = {
    name: "sreality",
    fetchList: async () => [],
    fetchDetail: async (url) => {
      calls.detail.push(url);
      if (detailError) throw new Error(detailError);
      return details[url] ?? detailOf();
    },
    ...flags,
  };
  const deps = {
    notifyReservation: async (listing) => calls.notified.push(listing),
    downloadPhotos: async () => [],
    sleep: async () => {},
    probe: async (...args) => (calls.probes.push(args), false),
  };
  const run = (items, options = {}) => processSource(db, source, REGION_WATCH, { log, items, deps, ...options });
  return { db, source, calls, run };
}
const eventsOf = (db, id) => db.prepare("SELECT event_type, occurred_at, old_price_czk, new_price_czk FROM events WHERE listing_id = ? ORDER BY id").all(id).map((e) => ({ ...e }));
const kinds = (db, id) => eventsOf(db, id).map((e) => e.event_type);

// --- běžný sběr -------------------------------------------------------------------------------------------------

test("sběr: nový inzerát se založí s detailem (popis, dispozice, plocha) a událostí 'created' s cenou", async () => {
  const { db, run, calls } = setup();
  const result = await run([itemOf("1")]);
  const row = getListing(db, "sreality:1");
  assert.equal(result.newCount, 1);
  assert.equal(row.status, "active");
  assert.equal(row.disposition, "2+1");
  assert.equal(row.area_m2, 52);
  assert.equal(row.price_czk, 3_000_000);
  assert.match(row.description, /Krásný byt/);
  assert.deepEqual(kinds(db, "sreality:1"), ["created"]);
  assert.deepEqual(calls.detail, ["https://example.test/1"]);
});

test("sběr: změna ceny, 'Dohodou' → cena i cena → 'Dohodou' (poslední známá cena zůstává)", async () => {
  const { db, run } = setup();
  await run([itemOf("1", { priceCzk: null }), itemOf("2")]);
  const result = await run([itemOf("1", { priceCzk: 2_990_000 }), itemOf("2", { priceCzk: null })]);
  assert.equal(result.priceChangeCount, 1);
  assert.equal(getListing(db, "sreality:1").price_czk, 2_990_000);
  assert.deepEqual(eventsOf(db, "sreality:1").pop(), { event_type: "price_change", occurred_at: eventsOf(db, "sreality:1").pop().occurred_at, old_price_czk: null, new_price_czk: 2_990_000 });
  assert.equal(getListing(db, "sreality:2").price_czk, 3_000_000); // cena → Dohodou se nezapisuje
  assert.deepEqual(kinds(db, "sreality:2"), ["created"]);
});

test("sběr: rezervace z výpisu zapíše stav a událost a pošle upozornění", async () => {
  const { db, run, calls } = setup();
  await run([itemOf("1")]);
  const result = await run([itemOf("1", { reserved: true })]);
  assert.equal(result.reservationCount, 1);
  assert.equal(getListing(db, "sreality:1").status, "reserved");
  assert.deepEqual(kinds(db, "sreality:1"), ["created", "reserved"]);
  assert.equal(calls.notified.length, 1);
});

test("sběr: Sreality čte rezervaci známého inzerátu z detailu (reservationFromDetail), iDNES prodej z detailu", async () => {
  const sreality = setup({ flags: { reservationFromDetail: true } });
  await sreality.run([itemOf("1")]);
  sreality.calls.detail.length = 0;
  sreality.source.fetchDetail = async (url) => (sreality.calls.detail.push(url), detailOf({ reserved: true }));
  await sreality.run([itemOf("1")]);
  assert.equal(getListing(sreality.db, "sreality:1").status, "reserved");
  assert.equal(sreality.calls.detail.length, 1);

  const idnes = setup({ flags: { soldFromDetail: true } });
  await idnes.run([itemOf("1")]);
  idnes.source.fetchDetail = async () => detailOf({ sold: true });
  const result = await idnes.run([itemOf("1")]);
  assert.equal(result.soldCount, 1);
  assert.equal(getListing(idnes.db, "sreality:1").status, "sold");
});

test("sběr: nenalezený inzerát se nesmaže hned, jen se poznamená první výpadek (stránka nic neprokázala)", async () => {
  const { db, run, calls } = setup();
  await run([itemOf("1")]);
  const result = await run([]);
  const row = getListing(db, "sreality:1");
  assert.equal(result.removedCount, 0);
  assert.equal(row.status, "active");
  assert.ok(row.missed_since);
  assert.equal(calls.probes.length, 1);
});

test("sběr: zmizelý inzerát, který se vrátil, je znovu v nabídce s událostí 'reactivated'", async () => {
  const { db, run } = setup();
  await run([itemOf("1")]);
  db.prepare("UPDATE listings SET status = 'removed', removed_at = ? WHERE id = ?").run(T1, "sreality:1");
  await run([itemOf("1")]);
  const row = getListing(db, "sreality:1");
  assert.equal(row.status, "active");
  assert.equal(row.removed_at, null);
  assert.deepEqual(kinds(db, "sreality:1"), ["created", "reactivated"]);
});

test("sběr: selhání výpisu se nahlásí chybou a nic se nezmění", async () => {
  const { db, source, run } = setup();
  await run([itemOf("1")]);
  source.fetchList = async () => {
    throw new Error("portál nejede");
  };
  const result = await processSource(db, source, REGION_WATCH, { log, deps: { sleep: async () => {} } });
  assert.equal(result.error, true);
  assert.equal(getListing(db, "sreality:1").status, "active");
  assert.equal(getListing(db, "sreality:1").missed_since, null);
});

// --- přehrávání snímku ------------------------------------------------------------------------------------------

test("přehrání: nový inzerát i jeho událost mají čas pozorování, ne 'teď'", async () => {
  const { db, run } = setup();
  await run([itemOf("1")], { observedAt: T1 });
  const row = getListing(db, "sreality:1");
  assert.equal(row.first_seen_at, T1);
  assert.equal(row.last_seen_at, T1);
  assert.equal(eventsOf(db, "sreality:1")[0].occurred_at, T1);
});

test("přehrání: změna ceny a návrat do nabídky se zapíšou k času pozorování", async () => {
  const { db, run } = setup();
  await run([itemOf("1")], { observedAt: T1 });
  await run([itemOf("1", { priceCzk: 2_800_000 })], { observedAt: T2 });
  db.prepare("UPDATE listings SET status = 'removed', removed_at = ? WHERE id = ?").run(T2, "sreality:1");
  await run([itemOf("1", { priceCzk: 2_800_000 })], { observedAt: T3 });
  const events = eventsOf(db, "sreality:1");
  assert.deepEqual(events.map((e) => [e.event_type, e.occurred_at]), [["created", T1], ["price_change", T2], ["reactivated", T3]]);
  assert.equal(getListing(db, "sreality:1").last_seen_at, T3);
});

test("přehrání: rezervaci a prodej určil sběrač ve snímku (item.reserved / item.sold) — známé inzeráty se nestahují", async () => {
  const sreality = setup({ flags: { reservationFromDetail: true } });
  await sreality.run([itemOf("1", { reserved: false })], { observedAt: T1 });
  sreality.calls.detail.length = 0;
  await sreality.run([itemOf("1", { reserved: true })], { observedAt: T2 });
  assert.equal(getListing(sreality.db, "sreality:1").status, "reserved");
  assert.deepEqual(eventsOf(sreality.db, "sreality:1").pop().occurred_at, T2);
  assert.equal(sreality.calls.detail.length, 0, "detail známého inzerátu se při přehrání nestahuje");

  const idnes = setup({ flags: { soldFromDetail: true } });
  await idnes.run([itemOf("1")], { observedAt: T1 });
  idnes.calls.detail.length = 0;
  const result = await idnes.run([itemOf("1", { sold: true })], { observedAt: T2 });
  assert.equal(result.soldCount, 1);
  assert.equal(getListing(idnes.db, "sreality:1").removed_at, T2);
  assert.equal(idnes.calls.detail.length, 0);
});

test("přehrání: nový inzerát, jehož detail už nejde stáhnout, se založí jen z údajů výpisu", async () => {
  const { db, run } = setup({ detailError: "HTTP 404" });
  const result = await run([itemOf("1")], { observedAt: T1 });
  const row = getListing(db, "sreality:1");
  assert.equal(result.newCount, 1);
  assert.equal(row.title, "Prodej bytu 2+1 52 m²");
  assert.equal(row.price_czk, 3_000_000);
  assert.equal(row.description, null);
  assert.equal(row.first_seen_at, T1);
});

test("sběr: chyba stažení detailu nového inzerátu letí dál jako dřív (jen přehrání ji toleruje)", async () => {
  const { run } = setup({ detailError: "HTTP 500" });
  await assert.rejects(() => run([itemOf("1")]), /HTTP 500/);
});

test("přehrání: zmizení se potvrdí druhým snímkem po odstupu, datum je první nenalezení, na portál se nikdo neptá", async () => {
  // Síť, která o každé stránce tvrdí "404 = smazáno": kdyby přehrání ověřovalo zmizení na stránce inzerátu (ta ukazuje
  // dnešek, ne okamžik pozorování), potvrdilo by se zmizení už prvním snímkem.
  const realFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => (networkCalls++, { status: 404, headers: { get: () => null }, text: async () => "" });
  try {
    const { db, run } = setup();
    await run([itemOf("1")], { observedAt: T1 });
    await run([], { observedAt: T2 });
    assert.equal(getListing(db, "sreality:1").missed_since, T2);
    assert.equal(getListing(db, "sreality:1").status, "active");
    const result = await run([], { observedAt: T3 });
    const row = getListing(db, "sreality:1");
    assert.equal(result.removedCount, 1);
    assert.equal(row.status, "removed");
    assert.equal(row.removed_at, T2);
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});
