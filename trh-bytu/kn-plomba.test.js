// node --test trh-bytu/kn-plomba.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { qualifyingProceedings, analyzePlombas, plombaHintLine, describeCandidate, FILING_GRACE_DAYS } from "./kn-plomba.js";

const RESERVED = "2026-09-10T08:00:00.000Z";
const proc = (id, datumPrijeti, extra = {}) => ({ id, typ: "V", cislo: id, rok: 2026, datumPrijeti, stav: "Probíhá zpracování", operace: [], fetchedAt: null, ...extra });

function scanOf(overrides = {}) {
  return {
    buildingId: 1,
    scannedAt: "2026-10-14T06:00:00.000Z",
    full: true,
    units: [
      { id: 11, number: 930001, lv: 6316, share: "37/625" },
      { id: 12, number: 930004, lv: 6319, share: "40/625" },
      { id: 13, number: 930005, lv: 6320, share: "41/625" },
    ],
    plomby: [
      { unit: 930004, lv: 6319, rizeni: [proc(7900, "2026-09-24T16:08:46"), proc(8070, "2026-10-01T14:01:38")] },
      { unit: 930005, lv: 6320, rizeni: [proc(5000, "2026-06-01T10:00:00")] }, // před rezervací
    ],
    closed: [],
    ...overrides,
  };
}

test("kvalifikuje jen vklady přijaté po rezervaci (s rezervou)", () => {
  const list = [
    proc(1, "2026-09-24T10:00:00"),
    proc(2, "2026-06-01T10:00:00"), // dávno před rezervací
    proc(3, "2026-09-01T10:00:00"), // v rezervě
    proc(4, "2026-09-24T10:00:00", { typ: "Z" }), // jiný typ řízení
    proc(5, null),
  ];
  assert.deepEqual(qualifyingProceedings(list, RESERVED).map((r) => r.id), [1, 3]);
  assert.equal(FILING_GRACE_DAYS, 14);
});

test("jednotka neznámá: nápověda ze všech jednotek domu, starý vklad se nezapočítá", () => {
  const a = analyzePlombas(scanOf(), { reservedAt: RESERVED });
  assert.equal(a.mode, "building");
  assert.equal(a.unitCount, 3);
  assert.equal(a.candidates.length, 1);
  assert.equal(a.candidates[0].label, "93/4");
  assert.equal(a.candidates[0].lv, 6319);
  assert.equal(a.candidates[0].filedAt, "2026-09-24"); // nejdřívější ze dvou řízení
  assert.equal(a.candidates[0].proceedings.length, 2);
});

test("jednotka známá: jen ona, jiné plomby v domě se ignorují", () => {
  const mine = analyzePlombas(scanOf(), { reservedAt: RESERVED, unitNumber: 930004 });
  assert.equal(mine.mode, "unit");
  assert.equal(mine.unit.label, "93/4");
  assert.equal(mine.candidates.length, 1);

  const other = analyzePlombas(scanOf(), { reservedAt: RESERVED, unitNumber: 930001 });
  assert.equal(other.candidates.length, 0);
  assert.equal(plombaHintLine(other), null); // bez plomby se nic netvrdí
});

test("jednotka, která v domě není, se nahlásí", () => {
  const a = analyzePlombas(scanOf(), { reservedAt: RESERVED, unitNumber: 930099 });
  assert.equal(a.unit.missing, true);
  assert.match(plombaHintLine(a), /93\/99 v domě neexistuje/);
});

test("částečný sken v režimu bez jednotky je neúplný a nic netvrdí", () => {
  const a = analyzePlombas(scanOf({ full: false }), { reservedAt: RESERVED });
  assert.equal(a.incomplete, true);
  assert.deepEqual(a.candidates, []);
  assert.equal(plombaHintLine(a), null);
  // Se známou jednotkou částečný sken stačí.
  assert.equal(analyzePlombas(scanOf({ full: false }), { reservedAt: RESERVED, unitNumber: 930004 }).candidates.length, 1);
});

test("skončená řízení po rezervaci: jen u té jednotky a jen novější než rezervace", () => {
  const scan = scanOf({
    plomby: [],
    closed: [
      { unit: 930004, lv: 6319, proceeding: proc(7900, "2026-09-24T16:08:46", { stav: "Řízení ukončeno" }) },
      { unit: 930005, lv: 6320, proceeding: proc(5000, "2026-06-01T10:00:00", { stav: "Řízení ukončeno" }) },
    ],
  });
  const all = analyzePlombas(scan, { reservedAt: RESERVED });
  assert.deepEqual(all.closed.map((c) => c.label), ["93/4"]);
  assert.equal(analyzePlombas(scan, { reservedAt: RESERVED, unitNumber: 930001 }).closed.length, 0);
});

test("věta pro souhrn: nápověda u neznámé jednotky vyzývá k potvrzení, u známé tvrdí jen fakt", () => {
  const building = plombaHintLine(analyzePlombas(scanOf(), { reservedAt: RESERVED }));
  assert.match(building, /^🔎 V domě je podaný vklad: č\. 93\/4 \(LV 6319\) — podáno 24\. 9\. 2026, 1\. 10\. 2026 \(2 řízení\)/);
  assert.match(building, /potvrď v appce/);
  const unit = plombaHintLine(analyzePlombas(scanOf(), { reservedAt: RESERVED, unitNumber: 930004 }));
  assert.equal(unit, "🔖 Jednotka 93/4: vklad podán 24. 9. 2026");
  assert.equal(describeCandidate(analyzePlombas(scanOf(), { reservedAt: RESERVED }).candidates[0]).startsWith("č. 93/4"), true);
});
