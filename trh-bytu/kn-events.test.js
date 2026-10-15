// node --test trh-bytu/kn-events.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { diffKnScan, saveKnEvents, loadKnEvents, KN_EVENTS_DDL } from "./kn-events.js";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-10-10T06:00:00.000Z"); // předchozí sken
const T1 = T0 + 5 * DAY; // nový sken
const iso = (ms) => new Date(ms).toISOString();
const UNIT = 4120012; // 412/12
const OTHER_UNIT = 4120007; // 412/7

const proc = (id, datumPrijeti, typ = "V") => ({ id, typ, cislo: id, rok: 2026, datumPrijeti, stav: "probíhá", operace: [] });
const scan = ({ at, plomby = [], closed = [] }) => ({ buildingId: 77, scannedAt: iso(at), full: true, units: [], plomby, closed });
const plomba = (unit, ...rizeni) => ({ unit, lv: 6319, rizeni });
const entry = { listingId: "sreality:1", unit: UNIT, address: "Lukesova 412" };

test("první sken domu nevyrobí žádné události plomba ani ended — nemáme s čím porovnat", () => {
  const next = scan({ at: T1, plomby: [plomba(UNIT, proc(1, "2026-10-08"))], closed: [{ unit: OTHER_UNIT, lv: 1, proceeding: proc(2, "2026-09-01") }] });
  assert.deepEqual(diffKnScan(null, next, { entries: [entry] }), []);
});

test("vklad přiřazený k bytu je událost filing s jednotkou, LV a adresou", () => {
  const next = scan({ at: T1, plomby: [plomba(UNIT, proc(1, "2026-10-08"))] });
  const events = diffKnScan(null, next, {
    entries: [entry],
    matches: [{ listingId: "sreality:1", filedAt: "2026-10-08", unit: UNIT, lv: 6319, via: "building", proceedingIds: [1] }],
  });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    ref: "filing:sreality:1:2026-10-08",
    kind: "filing",
    occurredAt: iso(T1),
    buildingId: 77,
    listingId: "sreality:1",
    detail: { unit: "412/12", lv: 6319, filedAt: "2026-10-08", via: "building", address: "Lukesova 412" },
  });
});

test("nová plomba na cizí jednotce je událost domu (bez bytu) s adresou domu", () => {
  const prev = scan({ at: T0 });
  const next = scan({ at: T1, plomby: [plomba(OTHER_UNIT, proc(5, "2026-10-12"))] });
  const events = diffKnScan(prev, next, { entries: [entry] });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "plomba");
  assert.equal(events[0].listingId, null);
  assert.equal(events[0].detail.unit, "412/7");
  assert.equal(events[0].detail.address, "Lukesova 412");
  assert.equal(events[0].ref, "plomba:5");
});

test("nová plomba na jednotce sledovaného bytu se k bytu váže", () => {
  const prev = scan({ at: T0 });
  const next = scan({ at: T1, plomby: [plomba(UNIT, proc(6, "2026-10-12"))] });
  const [event] = diffKnScan(prev, next, { entries: [entry] });
  assert.equal(event.kind, "plomba");
  assert.equal(event.listingId, "sreality:1");
});

test("plomba, kterou už minulý sken znal (i uzavřenou), není novinka", () => {
  const known = proc(7, "2026-10-09");
  const prev = scan({ at: T0, plomby: [plomba(UNIT, known)], closed: [{ unit: OTHER_UNIT, lv: 1, proceeding: proc(8, "2026-10-01") }] });
  const next = scan({ at: T1, plomby: [plomba(UNIT, known), plomba(OTHER_UNIT, proc(8, "2026-10-01"))] });
  assert.deepEqual(diffKnScan(prev, next, { entries: [entry] }), []);
});

test("plomba podaná dávno před minulým skenem není novinka (částečný sken ji jen neviděl)", () => {
  const prev = scan({ at: T0 });
  const next = scan({ at: T1, plomby: [plomba(OTHER_UNIT, proc(9, "2026-09-01"))] });
  assert.deepEqual(diffKnScan(prev, next, { entries: [entry] }), []);
});

test("plomba podaná den před minulým skenem se ještě bere jako nová (den bez hodiny, katastr se zpožďuje)", () => {
  const prev = scan({ at: T0 });
  const next = scan({ at: T1, plomby: [plomba(OTHER_UNIT, proc(10, "2026-10-09"))] });
  assert.equal(diffKnScan(prev, next, { entries: [entry] }).length, 1);
});

test("plomba, kterou skenem přiřadil match, nevyrobí ještě druhou událost plomba", () => {
  const prev = scan({ at: T0 });
  const next = scan({ at: T1, plomby: [plomba(UNIT, proc(11, "2026-10-12"))] });
  const events = diffKnScan(prev, next, {
    entries: [entry],
    matches: [{ listingId: "sreality:1", filedAt: "2026-10-12", unit: UNIT, lv: 6319, via: "unit", proceedingIds: [11] }],
  });
  assert.deepEqual(events.map((e) => e.kind), ["filing"]);
});

test("jiné než vkladové řízení (typ ≠ V) se nehlásí", () => {
  const prev = scan({ at: T0 });
  const next = scan({ at: T1, plomby: [plomba(OTHER_UNIT, proc(12, "2026-10-12", "Z"))], closed: [{ unit: OTHER_UNIT, lv: 1, proceeding: proc(13, "2026-10-01", "Z") }] });
  assert.deepEqual(diffKnScan(prev, next, { entries: [entry] }), []);
});

test("konec řízení: nově uzavřené řízení je událost ended; už dřív uzavřené ne", () => {
  const prev = scan({ at: T0, plomby: [plomba(UNIT, proc(14, "2026-09-20"))], closed: [{ unit: OTHER_UNIT, lv: 1, proceeding: proc(15, "2026-08-01") }] });
  const ended = { ...proc(14, "2026-09-20"), stav: "Vyřízeno" };
  const next = scan({
    at: T1,
    closed: [
      { unit: OTHER_UNIT, lv: 1, proceeding: proc(15, "2026-08-01") },
      { unit: UNIT, lv: 6319, proceeding: ended },
    ],
  });
  const events = diffKnScan(prev, next, { entries: [entry] });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "ended");
  assert.equal(events[0].listingId, "sreality:1");
  assert.deepEqual(events[0].detail, { unit: "412/12", lv: 6319, filedAt: "2026-09-20", state: "Vyřízeno", address: "Lukesova 412" });
});

test("ukládání: stejná událost se nezapíše dvakrát a načte se zpět s detailem", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(KN_EVENTS_DDL);
  const events = diffKnScan(null, scan({ at: T1 }), {
    entries: [entry],
    matches: [{ listingId: "sreality:1", filedAt: "2026-10-08", unit: UNIT, lv: 6319, via: "unit", proceedingIds: [1] }],
  });
  assert.equal(saveKnEvents(db, events), 1);
  assert.equal(saveKnEvents(db, events), 0);
  const [row] = loadKnEvents(db);
  assert.equal(row.kind, "filing");
  assert.equal(row.listing_id, "sreality:1");
  assert.equal(row.detail.unit, "412/12");
});
