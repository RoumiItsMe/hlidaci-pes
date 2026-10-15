// node --test trh-bytu/kn-scan.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { selectBuildingsToScan, matchFilings, unreservedTrack, isCooperativeOwnership, worthScanning, SCAN_HORIZON_DAYS, CYCLE_DAYS, UNRESERVED_HORIZON_DAYS, NO_UNITS_RECHECK_DAYS } from "./kn-scan.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-14T06:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const scansAgo = (ages) => new Map(Object.entries(ages).map(([id, days]) => [Number(id), { scannedAt: iso(NOW - days * DAY) }]));
const bld = (id) => ({ id });

test("nový dům (bez skenu) se projde hned, i když je jinak všechno čerstvé", () => {
  const picked = selectBuildingsToScan([bld(1), bld(2), bld(3)], scansAgo({ 2: 1 }), NOW);
  assert.deepEqual(picked.map((b) => b.id), [1, 3]);
});

test("dům zkontrolovaný před méně než 5 dny se bez důvodu nebere", () => {
  const picked = selectBuildingsToScan([bld(1), bld(2)], scansAgo({ 1: 1, 2: 4 }), NOW);
  assert.deepEqual(picked, []);
});

test("plánovaná dávka: denně nejvýš pětina domů, nejstarší první", () => {
  const buildings = Array.from({ length: 10 }, (_, i) => bld(i + 1));
  const scans = scansAgo(Object.fromEntries(buildings.map((b, i) => [b.id, 5 + i * 0.1]))); // všechny po cyklu, 10 je nejstarší
  const picked = selectBuildingsToScan(buildings, scans, NOW);
  assert.equal(picked.length, Math.ceil(10 / CYCLE_DAYS));
  assert.deepEqual(picked.map((b) => b.id), [10, 9]);
});

test("dlouhodobě: 10 domů naskenovaných naráz se rozloží a žádný dům se neprochází častěji než po 5 dnech", () => {
  const buildings = Array.from({ length: 10 }, (_, i) => bld(i + 1));
  const scans = new Map(buildings.map((b) => [b.id, { scannedAt: iso(NOW) }]));
  const lastScan = new Map(buildings.map((b) => [b.id, 0]));
  const perDay = [];
  for (let day = 1; day <= 30; day++) {
    const now = NOW + day * DAY;
    const picked = selectBuildingsToScan(buildings, scans, now);
    perDay.push(picked.length);
    for (const b of picked) {
      assert.ok(day - lastScan.get(b.id) >= CYCLE_DAYS, `dům ${b.id} dvakrát během ${day - lastScan.get(b.id)} dní`);
      scans.set(b.id, { scannedAt: iso(now) });
      lastScan.set(b.id, day);
    }
  }
  assert.ok(Math.max(...perDay) <= 2, `v jeden den ${Math.max(...perDay)} domů`);
  assert.ok(perDay.reduce((a, b) => a + b, 0) >= 10, "každý dům se za měsíc prošel aspoň jednou znovu");
});

// --- shoda plomby s bytem ---

const RESERVED = "2026-09-10T08:00:00.000Z";
const proc = (id, day) => ({ id, typ: "V", cislo: id, rok: 2026, datumPrijeti: `${day}T10:00:00`, stav: "Probíhá zpracování", operace: [], fetchedAt: null });
function scanOf({ plomby = [[930004, "2026-09-24"]], full = true } = {}) {
  return {
    buildingId: 1,
    scannedAt: iso(NOW),
    full,
    units: [930001, 930004, 930005].map((n, i) => ({ id: 10 + i, number: n, lv: 6300 + i, share: "1/10" })),
    plomby: plomby.map(([unit, day], i) => ({ unit, lv: 6300, rizeni: [proc(7000 + i, day)] })),
    closed: [],
  };
}
const flat = (extra = {}) => ({ unitNumber: null, autoUnitNumber: null, autoOff: false, filedAt: null, track: { reservedAt: RESERVED }, ...extra });

test("jednotka známá: plomba na ní se spojí s bytem", () => {
  const e = flat({ unitNumber: 930004 });
  const m = matchFilings([e], scanOf());
  assert.equal(m.length, 1);
  assert.equal(m[0].via, "unit");
  assert.equal(m[0].candidate.filedAt, "2026-09-24");
  assert.equal(matchFilings([flat({ unitNumber: 930001 })], scanOf()).length, 0); // plomba je jinde
  assert.equal(matchFilings([flat({ unitNumber: 930004, filedAt: "2026-09-24" })], scanOf()).length, 0); // už zapsáno
});

test("jednotka neznámá, jediný byt v domě a jediná plomba: spojí se jako odhad", () => {
  const e = flat();
  const m = matchFilings([e], scanOf());
  assert.equal(m.length, 1);
  assert.equal(m[0].via, "building");
  assert.equal(m[0].candidate.label, "93/4");
});

test("nejasno se nespojí: dvě plomby, dva byty bez jednotky, zrušený odhad, neúplný sken, plomba před rezervací", () => {
  assert.equal(matchFilings([flat()], scanOf({ plomby: [[930004, "2026-09-24"], [930005, "2026-10-01"]] })).length, 0);
  assert.equal(matchFilings([flat(), flat()], scanOf()).length, 0);
  assert.equal(matchFilings([flat({ autoOff: true })], scanOf()).length, 0);
  assert.equal(matchFilings([flat()], scanOf({ full: false })).length, 0);
  assert.equal(matchFilings([flat()], scanOf({ plomby: [[930004, "2026-06-01"]] })).length, 0);
});

test("jednotka, kterou už má jiný byt (zapsaná i odhadnutá), se nepřidělí znovu", () => {
  const other = flat({ unitNumber: 930004, filedAt: "2026-09-24" });
  const mine = flat();
  const both = scanOf({ plomby: [[930004, "2026-09-24"], [930005, "2026-10-01"]] });
  const m = matchFilings([other, mine], both);
  assert.equal(m.length, 1);
  assert.equal(m[0].entry, mine);
  assert.equal(m[0].candidate.label, "93/5");
  // Totéž s odhadnutou jednotkou jiného bytu.
  const guessedOther = flat({ autoUnitNumber: 930004, filedAt: "2026-09-24" });
  assert.equal(matchFilings([guessedOther, mine], both)[0].candidate.label, "93/5");
  // Jen jedna plomba a už patří jinému bytu → pro tenhle nic nezbývá.
  assert.equal(matchFilings([other, mine], scanOf()).length, 0);
});

test("vklad zapsaný u jiného bytu bez jednotky: nevíme, kterou plombu už má, takže se nehádá", () => {
  const filedUnknown = flat({ filedAt: "2026-09-24" });
  assert.equal(matchFilings([filedUnknown, flat()], scanOf({ plomby: [[930004, "2026-09-24"], [930005, "2026-10-01"]] })).length, 0);
});

test("velký dům: odhad podle jediné plomby se nedělá, zapsaná jednotka funguje dál", () => {
  const manyUnits = (n) => Array.from({ length: n }, (_, i) => ({ id: 100 + i, number: 930000 + i + 1, lv: 6000 + i, use: "byt", share: "1/10" }));
  const big = { ...scanOf(), units: [...manyUnits(30), { id: 1, number: 930004, lv: 6319, use: "byt", share: "1/10" }] }; // 31 bytů
  const edge = { ...scanOf(), units: [...manyUnits(29), { id: 1, number: 930004, lv: 6319, use: "byt", share: "1/10" }] }; // 30 bytů
  assert.equal(matchFilings([flat()], big).length, 0);
  assert.equal(matchFilings([flat()], edge).length, 1);
  assert.equal(matchFilings([flat({ unitNumber: 930004 })], big).length, 1); // jednotku zná uživatel → bez omezení
  // Garáže se do velikosti domu nepočítají.
  const withGarages = { ...scanOf(), units: [...manyUnits(10), ...Array.from({ length: 40 }, (_, i) => ({ id: 500 + i, number: 939000 + i, lv: 7000 + i, use: "garáž" })), { id: 1, number: 930004, lv: 6319, use: "byt", share: "1/10" }] };
  assert.equal(matchFilings([flat()], withGarages).length, 1);
});

// --- zmizelé byty bez rezervace ---

const gone = (extra = {}) => ({ id: "a", source: "sreality", status: "removed", removed_at: iso(NOW - 10 * DAY), first_seen_at: iso(NOW - 60 * DAY), ...extra });

test("zmizelý byt bez rezervace se hlídá od zmizení, jen UNRESERVED_HORIZON_DAYS", () => {
  const t = unreservedTrack([gone()], NOW);
  assert.equal(t.stage, "filing");
  assert.equal(t.unreserved, true);
  assert.equal(t.reservedAt, iso(NOW - 10 * DAY)); // místo rezervace datum zmizení
  assert.equal(unreservedTrack([gone({ removed_at: iso(NOW - (UNRESERVED_HORIZON_DAYS + 1) * DAY) })], NOW), null);
  assert.ok(unreservedTrack([gone({ removed_at: iso(NOW - (UNRESERVED_HORIZON_DAYS - 1) * DAY) })], NOW));
});

test("nehlídá se byt, který je v nabídce, má verdikt, nebo se už prodal", () => {
  assert.equal(unreservedTrack([gone({ status: "active", removed_at: null })], NOW), null);
  assert.equal(unreservedTrack([gone({ sale_verdict: "withdrawn", kn_checked_at: iso(NOW - 5 * DAY) })], NOW), null);
  assert.equal(unreservedTrack([gone({ sale_verdict: "sold" })], NOW), null);
});

test("plomba po zmizení bytu bez rezervace se páruje stejně jako po rezervaci (rezerva 14 dní před zmizením)", () => {
  const e = flat({ track: { reservedAt: iso(NOW - 10 * DAY), unreserved: true } });
  const early = scanOf({ plomby: [[930004, iso(NOW - 20 * DAY).slice(0, 10)]] }); // 10 dní před zmizením — v rezervě
  const tooEarly = scanOf({ plomby: [[930004, iso(NOW - 40 * DAY).slice(0, 10)]] }); // 30 dní před zmizením
  assert.equal(matchFilings([e], early).length, 1);
  assert.equal(matchFilings([e], tooEarly).length, 0);
});

// --- družstevní byty ---

test("družstevní vlastnictví se pozná z inzerátu i z ruční opravy, ruční oprava má přednost", () => {
  const params = (o) => JSON.stringify(o);
  assert.equal(isCooperativeOwnership([{ source: "sreality", params_json: params({ ownership: "Družstevní" }) }]), true);
  assert.equal(isCooperativeOwnership([{ source: "sreality", params_json: params({ ownership: "družstevní vlastnictví" }) }]), true);
  assert.equal(isCooperativeOwnership([{ source: "sreality", params_json: params({ ownership: "Osobní" }) }]), false);
  assert.equal(isCooperativeOwnership([{ source: "sreality", params_json: params({}) }]), false);
  assert.equal(isCooperativeOwnership([{ source: "sreality" }]), false);
  // Ruční oprava ("Doplnit parametry") přebíjí portál — v obou směrech.
  assert.equal(isCooperativeOwnership([{ source: "sreality", params_json: params({ ownership: "Družstevní" }), params_override_json: params({ ownership: "Osobní" }) }]), false);
  assert.equal(isCooperativeOwnership([{ source: "sreality", params_json: params({ ownership: "Osobní" }), params_override_json: params({ ownership: "Družstevní" }) }]), true);
  // Stačí, že to říká kterákoli nabídka bytu.
  assert.equal(isCooperativeOwnership([{ source: "sreality", params_json: params({}) }, { source: "bazos", params_json: params({ ownership: "Družstevní" }) }]), true);
});

test("dům, kde od posledního skenu zmizel inzerát bytu, se projde hned, i když je sken čerstvý", () => {
  const scans = scansAgo({ 1: 1, 2: 1, 3: 1 });
  const buildings = [
    { id: 1, changedAt: NOW - 0.5 * DAY }, // zmizel po skenu (před 12 hodinami, sken je starý den)
    { id: 2, changedAt: NOW - 2 * DAY }, // zmizel před skenem — už ho sken viděl
    { id: 3, changedAt: null }, // nic nezmizelo
  ];
  assert.deepEqual(selectBuildingsToScan(buildings, scans, NOW).map((b) => b.id), [1]);
  // Po novém skenu už se nezopakuje.
  const rescanned = scansAgo({ 1: 0.1, 2: 1, 3: 1 });
  assert.deepEqual(selectBuildingsToScan(buildings, rescanned, NOW), []);
});

test("dům bez jednotek se nepřeskenovává každých 5 dní, jen výjimečně, a zmizení bytu ho nevyvolá", () => {
  const scanOf = (days, units) => new Map([[1, { scannedAt: iso(NOW - days * DAY), units }]]);
  const pick = (scans, building = { id: 1 }) => selectBuildingsToScan([building], scans, NOW).map((b) => b.id);
  const someUnit = [{ id: 1, number: 930001 }];
  assert.deepEqual(pick(scanOf(10, [])), []); // 10 dní bez jednotek je málo
  assert.deepEqual(pick(scanOf(10, someUnit)), [1]); // běžný dům po cyklu ano
  assert.deepEqual(pick(scanOf(NO_UNITS_RECHECK_DAYS + 1, [])), [1]); // po NO_UNITS_RECHECK_DAYS se zkusí znovu
  assert.deepEqual(pick(scanOf(3, []), { id: 1, changedAt: NOW - 1 * DAY }), []); // zmizení bytu v domě bez jednotek sken nevyvolá
  assert.deepEqual(pick(scanOf(3, someUnit), { id: 1, changedAt: NOW - 1 * DAY }), [1]); // v běžném domě ano
});

test("skenování pokračuje i po konci rozvrhu kontrol (nezjištěno), dokud nepřejde SCAN_HORIZON_DAYS", () => {
  assert.equal(worthScanning({ stage: "filing", expired: false, ageDays: 50 }), true);
  assert.equal(worthScanning({ stage: "price", expired: false, ageDays: 500 }), true); // fáze ceny nikdy neexpiruje
  assert.equal(worthScanning({ stage: "filing", expired: true, ageDays: 200 }), true); // rozvrh skončil, ale plomba se ještě může objevit
  assert.equal(worthScanning({ stage: "filing", expired: true, ageDays: SCAN_HORIZON_DAYS + 1 }), false);
  assert.equal(worthScanning({ stage: "done", expired: false, ageDays: 10 }), false);
  assert.equal(worthScanning({ stage: "withdrawn" }), false);
  assert.equal(worthScanning(null), false);
});
