// node --test trh-bytu/snapshot.test.js
// Snímek výpisů z cloudového sběrače (snapshot.js): co se do něj zapíše a jak se pozná platný.
import test from "node:test";
import assert from "node:assert/strict";
import { SNAPSHOT_VERSION, collectSnapshot, collectedAtFromFile, hasAnyData, isValidSnapshot, snapshotRelPath } from "./snapshot.js";

const NOW = new Date("2026-10-31T04:10:03.123Z");
const noPause = async () => {};
const item = (id, extra = {}) => ({ id, title: `Prodej bytu ${id}`, url: `https://example.test/${id}`, priceCzk: 3_000_000, ...extra });
const source = (name, items, extra = {}) => ({ name, fetchList: async () => items, fetchDetail: async () => ({}), ...extra });
const collect = (sources) => collectSnapshot({ sources, watch: {}, regionKey: "default", now: NOW, pause: noPause });

test("snímek nese verzi, region, čas pozorování a výpis každého zdroje", async () => {
  const snapshot = await collect([source("bazos", [item("1"), item("2")]), source("idnes", [])]);
  assert.equal(snapshot.version, SNAPSHOT_VERSION);
  assert.equal(snapshot.region, "default");
  assert.equal(snapshot.collectedAt, "2026-10-31T04:10:03.123Z");
  assert.deepEqual(snapshot.sources.bazos, { ok: true, items: [item("1"), item("2")] });
  assert.deepEqual(snapshot.sources.idnes, { ok: true, items: [] });
  assert.equal(isValidSnapshot(snapshot), true);
});

test("zdroj, jehož výpis se nepodařilo stáhnout, je zapsaný jako ok:false (ne jako prázdný výpis) a ostatní zůstanou", async () => {
  const broken = { ...source("sreality", []), fetchList: async () => { throw new Error("HTTP 503"); } };
  const snapshot = await collect([broken, source("bazos", [item("1")])]);
  assert.deepEqual(snapshot.sources.sreality, { ok: false, error: "HTTP 503" });
  assert.equal(snapshot.sources.bazos.ok, true);
  assert.equal(hasAnyData(snapshot), true);
  assert.equal(isValidSnapshot(snapshot), true);
});

test("když se nepodaří žádný portál, snímek nemá data", async () => {
  const broken = (name) => ({ ...source(name, []), fetchList: async () => { throw new Error("síť"); } });
  assert.equal(hasAnyData(await collect([broken("sreality"), broken("bazos")])), false);
});

test("Sreality: rezervace se doplní z detailu každé nabídky; iDNES: prodej z detailu; ostatní portály detail nestahují", async () => {
  const fetched = [];
  const detail = (flags) => async (url) => (fetched.push(url), flags[url] ?? {});
  const sreality = source("sreality", [item("1"), item("2")], { reservationFromDetail: true, fetchDetail: detail({ "https://example.test/1": { reserved: true }, "https://example.test/2": { reserved: false } }) });
  const idnes = source("idnes", [item("3"), item("4")], { soldFromDetail: true, fetchDetail: detail({ "https://example.test/3": { sold: true } }) });
  const bazos = source("bazos", [item("5")], { fetchDetail: detail({}) });
  const snapshot = await collect([sreality, idnes, bazos]);
  assert.deepEqual(snapshot.sources.sreality.items.map((i) => i.reserved), [true, false]);
  assert.deepEqual(snapshot.sources.idnes.items.map((i) => i.sold), [true, false]);
  assert.equal("reserved" in snapshot.sources.bazos.items[0], false);
  assert.equal(fetched.includes("https://example.test/5"), false);
});

test("detail, který se nepodařilo stáhnout, nechá příznak nezadaný ('nevíme'), ne false — a ostatní nabídky doběhnou", async () => {
  const flaky = source("sreality", [item("1"), item("2")], {
    reservationFromDetail: true,
    fetchDetail: async (url) => {
      if (url.endsWith("/1")) throw new Error("HTTP 429");
      return { reserved: true };
    },
  });
  const snapshot = await collect([flaky]);
  const [first, second] = snapshot.sources.sreality.items;
  assert.equal("reserved" in first, false);
  assert.equal(second.reserved, true);
});

test("cesta souboru se řadí podle času a jde z ní zpět přečíst čas pozorování", async () => {
  const snapshot = await collect([source("bazos", [])]);
  const rel = snapshotRelPath(snapshot);
  assert.equal(rel, "default/2026-10-31T04-10-03-123Z.json");
  assert.equal(collectedAtFromFile("2026-10-31T04-10-03-123Z.json"), "2026-10-31T04:10:03.123Z");
  assert.equal(collectedAtFromFile("poznamky.txt"), null);
  const later = snapshotRelPath({ ...snapshot, collectedAt: "2026-11-01T04:10:00.000Z" });
  assert.ok(later > rel);
});

test("neplatný snímek se pozná (cizí verze, chybějící čas, rozbité zdroje)", () => {
  const ok = { version: SNAPSHOT_VERSION, region: "default", collectedAt: "2026-10-31T04:10:00.000Z", sources: { bazos: { ok: true, items: [] } } };
  assert.equal(isValidSnapshot(ok), true);
  assert.equal(isValidSnapshot({ ...ok, version: 99 }), false);
  assert.equal(isValidSnapshot({ ...ok, collectedAt: "včera" }), false);
  assert.equal(isValidSnapshot({ ...ok, region: undefined }), false);
  assert.equal(isValidSnapshot({ ...ok, sources: { bazos: { ok: true } } }), false);
  assert.equal(isValidSnapshot({ ...ok, sources: { bazos: { ok: "ano" } } }), false);
  assert.equal(isValidSnapshot(null), false);
});
