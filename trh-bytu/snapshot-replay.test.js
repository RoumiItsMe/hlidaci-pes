// node --test trh-bytu/snapshot-replay.test.js
// Přehrání denních snímků z cloudového sběrače po době, kdy PC nebylo zapnuté (snapshot-replay.js).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initDb, getListing } from "./db.js";
import { REGION_WATCH } from "./region.js";
import { snapshotRelPath, SNAPSHOT_VERSION } from "./snapshot.js";
import { EMPTY_LIST_GUARD_MIN_ACTIVE, getAppliedUntil, markLiveRun, pendingSnapshots, pullSnapshotRepo, replaySnapshots, setAppliedUntil } from "./snapshot-replay.js";

const D1 = "2026-10-28T04:10:00.000Z";
const D2 = "2026-10-29T04:10:00.000Z";
const D3 = "2026-10-30T04:10:00.000Z";
const logs = [];
const log = (line) => logs.push(line);
const itemOf = (id, extra = {}) => ({ id, title: "Prodej bytu 2+1 52 m²", url: `https://example.test/${id}`, priceCzk: 3_000_000, address: "Ústí nad Orlicí", ...extra });

function makeSource(name = "sreality", flags = {}) {
  return { name, fetchList: async () => [], fetchDetail: async () => ({ description: "Krásný byt po rekonstrukci v klidné části Ústí nad Orlicí.", photoUrls: [], params: {}, geo: null }), ...flags };
}
const deps = { notifyReservation: async () => {}, downloadPhotos: async () => [], sleep: async () => {} };

function setup() {
  const repo = mkdtempSync(path.join(tmpdir(), "trh-snapshots-"));
  const db = initDb(new DatabaseSync(":memory:"));
  const writeSnapshot = (collectedAt, sources, extra = {}) => {
    const snapshot = { version: SNAPSHOT_VERSION, region: "default", collectedAt, sources, ...extra };
    const file = path.join(repo, "snapshots", snapshotRelPath(snapshot));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(snapshot));
    return file;
  };
  const replay = (options = {}) => replaySnapshots({ db, sources: [makeSource()], watch: REGION_WATCH, regionKey: "default", repoDir: repo, log, pull: () => {}, deps, ...options });
  return { repo, db, writeSnapshot, replay, cleanup: () => rmSync(repo, { recursive: true, force: true }) };
}
const ok = (...items) => ({ sreality: { ok: true, items } });
const eventsOf = (db, id) => db.prepare("SELECT event_type, occurred_at FROM events WHERE listing_id = ? ORDER BY id").all(id).map((e) => [e.event_type, e.occurred_at]);

test("příběh: PC 3 dny vypnuté — změny se zapíšou po dnech, ne všechny 'dnes'", async () => {
  const t = setup();
  try {
    t.writeSnapshot(D1, ok(itemOf("1"), itemOf("2")));
    t.writeSnapshot(D2, ok(itemOf("1", { priceCzk: 2_900_000 }))); // byt 2 zmizel, byt 1 zlevnil
    t.writeSnapshot(D3, ok(itemOf("1", { priceCzk: 2_900_000 }), itemOf("3"))); // byt 2 stále pryč, nový byt 3
    const result = await t.replay();
    assert.deepEqual(result, { enabled: true, applied: 3, skipped: 0 });
    assert.deepEqual(eventsOf(t.db, "sreality:1"), [["created", D1], ["price_change", D2]]);
    assert.deepEqual(eventsOf(t.db, "sreality:3"), [["created", D3]]);
    const gone = getListing(t.db, "sreality:2");
    assert.equal(gone.status, "removed");
    assert.equal(gone.removed_at, D2); // první den, kdy tam nebyl
    assert.deepEqual(eventsOf(t.db, "sreality:2"), [["created", D1], ["removed", D2]]);
    assert.equal(getAppliedUntil(t.db), D3);
  } finally {
    t.cleanup();
  }
});

test("přehrání je idempotentní: už přehrané snímky se podruhé nepoužijí", async () => {
  const t = setup();
  try {
    t.writeSnapshot(D1, ok(itemOf("1")));
    await t.replay();
    const eventsBefore = t.db.prepare("SELECT COUNT(*) AS c FROM events").get().c;
    const again = await t.replay();
    assert.equal(again.applied, 0);
    assert.equal(t.db.prepare("SELECT COUNT(*) AS c FROM events").get().c, eventsBefore);
  } finally {
    t.cleanup();
  }
});

test("snímek starší než poslední běžný sběr na PC se nepřehrává; novější ano", async () => {
  const t = setup();
  try {
    t.writeSnapshot(D1, ok(itemOf("1")));
    t.writeSnapshot(D3, ok(itemOf("2")));
    markLiveRun(t.db, D2); // PC sbíralo mezi snímky
    const result = await t.replay();
    assert.equal(result.applied, 1);
    assert.ok(getListing(t.db, "sreality:2"));
    assert.equal(getListing(t.db, "sreality:1"), undefined); // snímek D1 byl starší než sběr na PC, jeho nabídky se z něj nezakládají
  } finally {
    t.cleanup();
  }
});

test("bez dosavadního přehrávání se začíná od posledního pozorování v databázi", async () => {
  const t = setup();
  try {
    await t.replay(); // nic
    t.db.prepare("INSERT INTO listings (id, source, source_id, url, status, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, 'active', ?, ?)").run("sreality:9", "sreality", "9", "https://x/9", D1, D2);
    t.writeSnapshot(D1, ok(itemOf("9")));
    t.writeSnapshot(D3, ok(itemOf("9")));
    const result = await t.replay();
    assert.equal(result.applied, 1); // D1 je starší než poslední pozorování (D2)
  } finally {
    t.cleanup();
  }
});

test("zdroj, který se ve snímku nepodařilo stáhnout (ok:false), se přeskočí — jeho nabídky nezačnou 'mizet'", async () => {
  const t = setup();
  try {
    t.writeSnapshot(D1, ok(itemOf("1")));
    t.writeSnapshot(D2, { sreality: { ok: false, error: "HTTP 503" } });
    await t.replay();
    const row = getListing(t.db, "sreality:1");
    assert.equal(row.status, "active");
    assert.equal(row.missed_since, null);
    assert.equal(row.last_seen_at, D1);
  } finally {
    t.cleanup();
  }
});

test("podezřele prázdný výpis (zdroj s mnoha aktivními nabídkami) se nepřehrává; malý zdroj smí být prázdný", async () => {
  const t = setup();
  try {
    const many = Array.from({ length: EMPTY_LIST_GUARD_MIN_ACTIVE }, (_, i) => itemOf(String(i + 1)));
    t.writeSnapshot(D1, ok(...many));
    t.writeSnapshot(D2, ok()); // celý výpis najednou prázdný = výpadek portálu, ne úklid
    await t.replay();
    assert.equal(t.db.prepare("SELECT COUNT(*) AS c FROM listings WHERE missed_since IS NOT NULL").get().c, 0);
    assert.ok(logs.some((l) => /prázdný výpis/.test(l)));

    const small = setup();
    try {
      small.writeSnapshot(D1, ok(itemOf("1")));
      small.writeSnapshot(D2, ok());
      await small.replay();
      assert.equal(getListing(small.db, "sreality:1").missed_since, D2);
    } finally {
      small.cleanup();
    }
  } finally {
    t.cleanup();
  }
});

test("cizí region, nečitelný soubor a snímek s rozbitým obsahem se přeskočí, ostatní doběhnou", async () => {
  const t = setup();
  try {
    // soubor leží ve složce default, ale uvnitř je snímek jiného regionu
    mkdirSync(path.join(t.repo, "snapshots", "default"), { recursive: true });
    writeFileSync(path.join(t.repo, "snapshots", "default", "2026-10-28T04-10-00-000Z.json"), JSON.stringify({ version: SNAPSHOT_VERSION, region: "nachod", collectedAt: D1, sources: ok(itemOf("1")) }));
    const broken = path.join(t.repo, "snapshots", "default", "2026-10-28T05-00-00-000Z.json");
    writeFileSync(broken, "{ tohle není json");
    t.writeSnapshot("2026-10-28T06:00:00.000Z", ok(itemOf("2")));
    const result = await t.replay();
    assert.deepEqual(result, { enabled: true, applied: 1, skipped: 2 });
    assert.ok(getListing(t.db, "sreality:2"));
    assert.equal(getListing(t.db, "sreality:1"), undefined);
  } finally {
    t.cleanup();
  }
});

test("bez složky se snímky (TRH_SNAPSHOT_REPO nenastaveno / neexistuje) se nic neděje", async () => {
  const t = setup();
  try {
    assert.deepEqual(await t.replay({ repoDir: null }), { enabled: false, applied: 0, skipped: 0 });
    assert.deepEqual(await t.replay({ repoDir: path.join(t.repo, "neexistuje") }), { enabled: false, applied: 0, skipped: 0 });
  } finally {
    t.cleanup();
  }
});

test("git pull se zavolá nad složkou se snímky; jeho selhání přehrávání nezastaví", async () => {
  const t = setup();
  try {
    t.writeSnapshot(D1, ok(itemOf("1")));
    const pulled = [];
    const result = await t.replay({ pull: (dir) => pulled.push(dir) });
    assert.deepEqual(pulled, [t.repo]);
    assert.equal(result.applied, 1);

    const calls = [];
    const failing = () => { throw new Error("fatal: Authentication failed\nnápověda"); };
    assert.equal(pullSnapshotRepo(t.repo, log, failing), false);
    assert.ok(logs.some((l) => /git pull\) selhalo: fatal: Authentication failed/.test(l)));
    assert.equal(pullSnapshotRepo(t.repo, log, (cmd, args, options) => (calls.push([cmd, args, options]), "")), true);
    assert.deepEqual(calls[0][1], ["-C", t.repo, "pull", "--ff-only", "--quiet"]);
    assert.equal(calls[0][2].env.GIT_TERMINAL_PROMPT, "0"); // nikdy nečeká na zadání hesla
  } finally {
    t.cleanup();
  }
});

test("pendingSnapshots řadí od nejstaršího a bere jen novější než zadaný čas; markLiveRun nikdy nevrací čas zpět", () => {
  const t = setup();
  try {
    t.writeSnapshot(D3, ok());
    t.writeSnapshot(D1, ok());
    t.writeSnapshot(D2, ok());
    assert.deepEqual(pendingSnapshots(t.repo, "default", "").map((s) => s.collectedAt), [D1, D2, D3]);
    assert.deepEqual(pendingSnapshots(t.repo, "default", D2).map((s) => s.collectedAt), [D3]);
    assert.deepEqual(pendingSnapshots(t.repo, "nachod", ""), []);
    markLiveRun(t.db, D2);
    markLiveRun(t.db, D1);
    assert.equal(getAppliedUntil(t.db), D2);
    setAppliedUntil(t.db, D3);
    assert.equal(getAppliedUntil(t.db), D3);
  } finally {
    t.cleanup();
  }
});
