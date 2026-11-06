// node --test trh-bytu/kn-plomba.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { qualifyingProceedings, analyzePlombas, plombaHintLine, describeCandidate, apiWatch, FILING_GRACE_DAYS, WATCH_MAX_AGE_DAYS } from "./kn-plomba.js";

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

// --- hlídání API (apiWatch) ---

const NOW = Date.parse("2026-10-14T06:00:00.000Z");

test("apiWatch: bez skenu, se starým skenem nebo s neúplným skenem se nehlídá (platí ruční rozvrh)", () => {
  assert.equal(apiWatch(null, { reservedAt: RESERVED, now: NOW }), null);
  const stale = scanOf({ scannedAt: new Date(NOW - (WATCH_MAX_AGE_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString() });
  assert.equal(apiWatch(stale, { reservedAt: RESERVED, now: NOW }), null);
  assert.equal(apiWatch(scanOf({ full: false }), { reservedAt: RESERVED, now: NOW }), null); // jednotka neznámá, sken jen část domu
  // Zapsaná jednotka, která v domě není: překlep, ruční kontrola zůstává.
  assert.equal(apiWatch(scanOf(), { reservedAt: RESERVED, unitNumber: 930099, now: NOW }), null);
});

test("apiWatch: čerstvý sken bez plomby po rezervaci = hlídá appka, nic k potvrzení", () => {
  const w = apiWatch(scanOf({ plomby: [] }), { reservedAt: RESERVED, now: NOW });
  assert.deepEqual(w, { needsConfirm: false, confirmAt: null, unverifiable: false, plombaActive: false, priceReadyAt: null, awaitingVklad: false, vkladEnded: false });
  // Plomba z doby před rezervací se nepočítá.
  const old = scanOf({ plomby: [{ unit: 930004, lv: 6319, rizeni: [proc(5000, "2026-06-01T10:00:00")] }] });
  assert.equal(apiWatch(old, { reservedAt: RESERVED, now: NOW }).needsConfirm, false);
  // Sken je dost čerstvý i po týdnu.
  const week = scanOf({ plomby: [], scannedAt: new Date(NOW - 7 * 24 * 60 * 60 * 1000).toISOString() });
  assert.equal(apiWatch(week, { reservedAt: RESERVED, now: NOW }).unverifiable, false);
});

test("apiWatch: plomba po rezervaci, kterou nikdo nepřiřadil, je k potvrzení ke dni podání", () => {
  const w = apiWatch(scanOf(), { reservedAt: RESERVED, now: NOW });
  assert.equal(w.needsConfirm, true);
  assert.equal(w.confirmAt, Date.parse("2026-09-24"));
});

test("apiWatch: dům bez jednotek (družstevní) nejde ověřit", () => {
  const w = apiWatch(scanOf({ units: [], plomby: [] }), { reservedAt: RESERVED, now: NOW });
  assert.equal(w.unverifiable, true);
  assert.equal(w.needsConfirm, false);
});

// --- fáze ceny: běží řízení, nebo už skončilo? ---

test("apiWatch se známou jednotkou: plomba na ní = řízení běží, cenu zatím nejde zjistit", () => {
  const w = apiWatch(scanOf(), { reservedAt: RESERVED, unitNumber: 930004, now: NOW });
  assert.equal(w.plombaActive, true);
  assert.equal(w.priceReadyAt, null);
  // Bez známé jednotky se o běhu řízení nic tvrdit nedá.
  assert.equal(apiWatch(scanOf(), { reservedAt: RESERVED, now: NOW }).plombaActive, false);
});

test("apiWatch se známou jednotkou: plomba zmizela a appka to zaznamenala = cenu už jde zjistit", () => {
  const seen = "2026-10-13T06:00:00.000Z";
  const scan = scanOf({
    plomby: [],
    closed: [{ unit: 930004, lv: 6319, proceeding: proc(7900, "2026-09-24T16:08:46", { stav: "Řízení ukončeno" }), closedSeenAt: seen }],
  });
  const w = apiWatch(scan, { reservedAt: RESERVED, unitNumber: 930004, now: NOW });
  assert.equal(w.plombaActive, false);
  assert.equal(w.priceReadyAt, Date.parse(seen));
  // Skončené řízení u jiné jednotky se nepočítá.
  assert.equal(apiWatch(scan, { reservedAt: RESERVED, unitNumber: 930001, now: NOW }).priceReadyAt, null);
  // A kdyby na jednotce byla ještě jiná plomba, cena čeká dál.
  const stillRunning = scanOf({ closed: scan.closed });
  assert.equal(apiWatch(stillRunning, { reservedAt: RESERVED, unitNumber: 930004, now: NOW }).plombaActive, true);
  assert.equal(apiWatch(stillRunning, { reservedAt: RESERVED, unitNumber: 930004, now: NOW }).priceReadyAt, null);
});

// --- potvrzení odložené "až po vkladu" (dvě plomby v domě, který byt je náš, pozná uživatel až z kupní ceny) ---

const WAIT = "2026-10-05T10:00:00.000Z";
const endedAt = (unit, id, filed, seen) => ({ unit, lv: null, proceeding: proc(id, filed, { stav: "Řízení ukončeno" }), closedSeenAt: seen });

test("apiWatch: odložené potvrzení se nepřipomíná, dokud v domě běží plomby — ani když přibude další", () => {
  const w = apiWatch(scanOf(), { reservedAt: RESERVED, waitSince: WAIT, now: NOW });
  assert.equal(w.needsConfirm, false);
  assert.equal(w.confirmAt, null);
  assert.equal(w.awaitingVklad, true);
  assert.equal(w.vkladEnded, false);
  const another = scanOf({ plomby: [...scanOf().plomby, { unit: 930001, lv: 6316, rizeni: [proc(8200, "2026-10-10T09:00:00")] }] });
  assert.equal(apiWatch(another, { reservedAt: RESERVED, waitSince: WAIT, now: NOW }).needsConfirm, false);
  // Bez odložení je táž plomba k potvrzení (kontrola, že test měří odložení).
  assert.equal(apiWatch(scanOf(), { reservedAt: RESERVED, now: NOW }).needsConfirm, true);
});

test("apiWatch: odložené potvrzení se vrátí, až sken uvidí skončené řízení v domě — k poslednímu takovému dni", () => {
  const first = "2026-10-12T06:00:00.000Z";
  const second = "2026-10-13T06:00:00.000Z";
  const oneEnded = scanOf({ closed: [endedAt(930001, 7950, "2026-09-25T10:00:00", first)] });
  const w = apiWatch(oneEnded, { reservedAt: RESERVED, waitSince: WAIT, now: NOW });
  assert.equal(w.needsConfirm, true);
  assert.equal(w.vkladEnded, true);
  assert.equal(w.awaitingVklad, false);
  assert.equal(w.confirmAt, Date.parse(first));
  // Druhé skončené řízení posune bod dál, ať "Zatím nic" u prvního nespolkne to druhé.
  const twoEnded = scanOf({ plomby: [], closed: [endedAt(930001, 7950, "2026-09-25T10:00:00", first), endedAt(930004, 7900, "2026-09-24T16:08:46", second)] });
  assert.equal(apiWatch(twoEnded, { reservedAt: RESERVED, waitSince: WAIT, now: NOW }).confirmAt, Date.parse(second));
});

test("apiWatch: řízení skončené už před odložením ho nevrací; a když už v domě nic neběží, nečeká se na nic", () => {
  const before = scanOf({ closed: [endedAt(930001, 7950, "2026-09-25T10:00:00", "2026-10-04T06:00:00.000Z")] });
  const w = apiWatch(before, { reservedAt: RESERVED, waitSince: WAIT, now: NOW });
  assert.equal(w.needsConfirm, false);
  assert.equal(w.awaitingVklad, true);
  const nothingRunning = scanOf({ plomby: [], closed: before.closed });
  assert.equal(apiWatch(nothingRunning, { reservedAt: RESERVED, waitSince: WAIT, now: NOW }).awaitingVklad, false);
});

test("apiWatch: se známou jednotkou se odložení neuplatní — plombu na ní appka sleduje sama", () => {
  const w = apiWatch(scanOf(), { reservedAt: RESERVED, unitNumber: 930004, waitSince: WAIT, now: NOW });
  assert.equal(w.plombaActive, true);
  assert.equal(w.awaitingVklad, false);
  assert.equal(w.needsConfirm, true);
});

// --- prodej na hypotéku: převod a zástava jsou dvě řízení V, API je neodliší ---

test("apiWatch: skončilo jen jedno ze dvou řízení na jednotce (třeba zástava) — cena ještě není k vyřízení; po skončení obou ano, k pozdějšímu", () => {
  const first = "2026-11-05T17:00:00.000Z";
  const second = "2026-11-10T17:00:00.000Z";
  const lien = proc(8473, "2026-10-14T15:40:10", { stav: "Odesláno vyrozumění o provedeném vkladu" });
  const transfer = proc(8641, "2026-10-21T08:13:27");
  const oneEnded = scanOf({
    plomby: [{ unit: 930004, lv: 6319, rizeni: [transfer] }],
    closed: [{ unit: 930004, lv: 6319, proceeding: lien, closedSeenAt: first }],
  });
  const w = apiWatch(oneEnded, { reservedAt: RESERVED, unitNumber: 930004, now: NOW });
  assert.equal(w.plombaActive, true);
  assert.equal(w.priceReadyAt, null);
  const bothEnded = scanOf({
    plomby: [],
    closed: [
      { unit: 930004, lv: 6319, proceeding: lien, closedSeenAt: first },
      { unit: 930004, lv: 6319, proceeding: { ...transfer, stav: "Vklad proveden" }, closedSeenAt: second },
    ],
  });
  assert.equal(apiWatch(bothEnded, { reservedAt: RESERVED, unitNumber: 930004, now: NOW }).priceReadyAt, Date.parse(second));
  // Plomba z doby před rezervací (cizí, dlouho běžící řízení) cenu neblokuje.
  const oldRunning = scanOf({ plomby: [{ unit: 930004, lv: 6319, rizeni: [proc(5000, "2026-06-01T10:00:00")] }], closed: [bothEnded.closed[0]] });
  assert.equal(apiWatch(oldRunning, { reservedAt: RESERVED, unitNumber: 930004, now: NOW }).priceReadyAt, Date.parse(first));
});
