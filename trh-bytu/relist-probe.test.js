// node --test trh-bytu/relist-probe.test.js
// Nenalezený inzerát se potvrdí jako zmizelý hned, když to říká jeho vlastní stránka (gone-probe.js); jinak platí
// dosavadní pojistka (potvrzení dalším během po odstupu, relist.js).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initDb, insertListing, getListing } from "./db.js";
import { handleDisappeared, MAX_GONE_PROBES_PER_RUN, MIN_CONFIRM_GAP_MS } from "./relist.js";

const noPause = async () => {};
const logs = [];
const log = (line) => logs.push(line);

function freshDb(ids, { missed_since = null } = {}) {
  const db = initDb(new DatabaseSync(":memory:"));
  for (const id of ids) {
    insertListing(db, { id, source: "sreality", source_id: id.split(":")[1], url: `https://example.test/${id}`, title: "Prodej bytu", disposition: "2+1", area_m2: 51, price_czk: 2_895_000, status: "active", first_seen_at: "2026-09-22T09:31:00.000Z", last_seen_at: "2026-10-27T09:55:00.000Z" });
    if (missed_since) db.prepare("UPDATE listings SET missed_since = ? WHERE id = ?").run(missed_since, id); // insertListing tenhle sloupec nezná
  }
  return db;
}
const eventsOf = (db, id) => db.prepare("SELECT event_type, occurred_at FROM events WHERE listing_id = ?").all(id).map((e) => e.event_type);

test("stránka inzerátu říká 'smazáno' → zmizení se potvrdí hned při prvním výpadku, datum je okamžik zjištění", async () => {
  const db = freshDb(["sreality:1"]);
  const calls = [];
  const probe = async (source, url) => (calls.push([source, url]), true);
  const result = await handleDisappeared(db, "sreality", new Set(), [], log, { probe, pause: noPause });
  const row = getListing(db, "sreality:1");
  assert.equal(result.removedCount, 1);
  assert.equal(row.status, "removed");
  assert.ok(row.removed_at);
  assert.equal(row.missed_since, null);
  assert.deepEqual(eventsOf(db, "sreality:1"), ["removed"]);
  assert.deepEqual(calls, [["sreality", "https://example.test/sreality:1"]]);
});

test("stránka nic nedokazuje (chyba, běžná odpověď) → platí dosavadní pojistka: jen se poznamená první výpadek", async () => {
  const db = freshDb(["sreality:1"]);
  const result = await handleDisappeared(db, "sreality", new Set(), [], log, { probe: async () => false, pause: noPause });
  const row = getListing(db, "sreality:1");
  assert.equal(result.removedCount, 0);
  assert.equal(row.status, "active");
  assert.ok(row.missed_since);
  assert.deepEqual(eventsOf(db, "sreality:1"), []);
});

test("důkaz po dřívějším prvním výpadku: datum zmizení zůstává okamžik, kdy ho appka poprvé nenašla", async () => {
  const missedSince = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // před hodinou, odstup ještě neuplynul
  const db = freshDb(["sreality:1"], { missed_since: missedSince });
  const result = await handleDisappeared(db, "sreality", new Set(), [], log, { probe: async () => true, pause: noPause });
  const row = getListing(db, "sreality:1");
  assert.equal(result.removedCount, 1);
  assert.equal(row.removed_at, missedSince);
  assert.equal(row.missed_since, null);
});

test("výpadek už starší než odstup se potvrdí bez dotazu na portál", async () => {
  const db = freshDb(["sreality:1"], { missed_since: new Date(Date.now() - MIN_CONFIRM_GAP_MS - 1000).toISOString() });
  let called = 0;
  const result = await handleDisappeared(db, "sreality", new Set(), [], log, { probe: async () => (called++, false), pause: noPause });
  assert.equal(result.removedCount, 1);
  assert.equal(called, 0);
  assert.equal(getListing(db, "sreality:1").status, "removed");
});

test("strop dotazů na portál: nad ním se další inzeráty potvrzují jen pojistkou (výpadek výpisu není úklid portálu)", async () => {
  const ids = Array.from({ length: MAX_GONE_PROBES_PER_RUN + 3 }, (_, i) => `sreality:${i + 1}`);
  const db = freshDb(ids);
  let called = 0;
  const result = await handleDisappeared(db, "sreality", new Set(), [], log, { probe: async () => (called++, true), pause: noPause });
  assert.equal(called, MAX_GONE_PROBES_PER_RUN);
  assert.equal(result.removedCount, MAX_GONE_PROBES_PER_RUN);
  const stillActive = ids.filter((id) => getListing(db, id).status === "active");
  assert.equal(stillActive.length, 3);
  assert.ok(stillActive.every((id) => getListing(db, id).missed_since));
});

test("nalezené inzeráty se neověřují; znovu vložený inzerát je relist a na portál se kvůli němu nikdo neptá", async () => {
  const db = freshDb(["sreality:1", "sreality:2"]);
  let called = 0;
  const probe = async () => (called++, true);
  const result = await handleDisappeared(db, "sreality", new Set(["sreality:1"]), [], log, { probe, pause: noPause });
  assert.equal(getListing(db, "sreality:1").status, "active"); // je ve výpisu, nic se s ním neděje
  assert.equal(getListing(db, "sreality:2").status, "removed");
  assert.equal(result.removedCount, 1);
  assert.equal(called, 1);
});

test("inzeráty jiného zdroje se nesahá", async () => {
  const db = freshDb(["sreality:1"]);
  const result = await handleDisappeared(db, "idnes", new Set(), [], log, { probe: async () => true, pause: noPause });
  assert.equal(result.removedCount, 0);
  assert.equal(getListing(db, "sreality:1").status, "active");
});
