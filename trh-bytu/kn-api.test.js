// node --test trh-bytu/kn-api.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { parseUnitNumber, formatUnitNumber, scanBuilding } from "./kn-api.js";

const NOW = Date.parse("2026-10-14T06:00:00.000Z");

test("číslo jednotky: '412/12' ↔ číslo z API", () => {
  assert.equal(parseUnitNumber("412/12"), 4120012);
  assert.equal(parseUnitNumber(" 93 / 4 "), 930004);
  assert.equal(parseUnitNumber("412/101"), 4120101);
  assert.equal(parseUnitNumber("4120001"), 4120001);
  assert.equal(parseUnitNumber("12"), null); // bez čísla popisného jednotku neurčíme
  assert.equal(parseUnitNumber(""), null);
  assert.equal(parseUnitNumber(null), null);
  assert.equal(parseUnitNumber("byt 3/12"), null);
  assert.equal(formatUnitNumber(4120012), "412/12");
  assert.equal(formatUnitNumber(930004), "93/4");
  assert.equal(formatUnitNumber(4120101), "412/101");
});

// Falešný klient: dům o dvou jednotkách, na druhé plomba řízením 100.
function fakeClient({ plombaOnSecond = true, proceedingStav = "Probíhá zpracování" } = {}) {
  let calls = 0;
  const log = [];
  const hit = (name) => {
    calls++;
    log.push(name);
  };
  return {
    hasKey: true,
    log,
    get calls() {
      return calls;
    },
    building: async () => {
      hit("building");
      return { id: 1, jednotky: [{ id: 11, cisloJednotky: 930001 }, { id: 12, cisloJednotky: 930004 }], rizeniPlomby: [] };
    },
    unit: async (id) => {
      hit(`unit:${id}`);
      return {
        id,
        lv: { cislo: id === 11 ? 6316 : 6319 },
        zpusobVyuziti: { nazev: "byt" },
        podilNaSpolecnychCastechDomu: { citatel: 37, jmenovatel: 625 },
        rizeniPlomby: id === 12 && plombaOnSecond ? [{ id: 100, typRizeni: "V", poradoveCislo: 7900, rok: 2026 }] : [],
      };
    },
    proceeding: async (id) => {
      hit(`proceeding:${id}`);
      return {
        id,
        typRizeni: "V",
        poradoveCislo: 7900,
        rok: 2026,
        datumPrijeti: "2026-09-24T16:08:46",
        stav: proceedingStav,
        provedeneOperace: [{ nazev: "Zaplombování", datumProvedeni: "2026-09-25T07:02:50" }],
      };
    },
  };
}

test("plný sken: jednotky, LV, podíl a detail řízení s datem podání", async () => {
  const client = fakeClient();
  const scan = await scanBuilding(client, 1, { now: NOW });
  assert.equal(scan.full, true);
  assert.equal(scan.calls, 4); // stavba + 2 jednotky + 1 řízení
  assert.deepEqual(scan.units.map((u) => [u.number, u.lv, u.use, u.share]), [
    [930001, 6316, "byt", "37/625"],
    [930004, 6319, "byt", "37/625"],
  ]);
  assert.equal(scan.plomby.length, 1);
  assert.equal(scan.plomby[0].unit, 930004);
  assert.equal(scan.plomby[0].lv, 6319);
  assert.equal(scan.plomby[0].rizeni[0].datumPrijeti, "2026-09-24T16:08:46");
  assert.equal(scan.plomby[0].rizeni[0].operace[0].nazev, "Zaplombování");
  assert.deepEqual(scan.closed, []);
});

test("nedostatek rozpočtu na celý dům: nic se neuloží, neúplný sken netvrdí, že je čisto", async () => {
  const client = fakeClient();
  const res = await scanBuilding(client, 1, { now: NOW, budget: 2 });
  assert.deepEqual(res, { skipped: "budget", needed: 2 });
});

test("částečný sken: jen zadané jednotky a bez dotazu na stavbu, známé řízení se nestahuje znovu", async () => {
  const first = await scanBuilding(fakeClient(), 1, { now: NOW });
  const client = fakeClient();
  const scan = await scanBuilding(client, 1, { now: NOW + 24 * 60 * 60 * 1000, prev: first, wantUnits: new Set([930004]) });
  assert.equal(scan.full, false);
  assert.deepEqual(client.log, ["unit:12"]); // žádná stavba, žádný detail řízení
  assert.equal(scan.plomby[0].rizeni[0].id, 100);
  assert.equal(scan.units.length, 2); // seznam jednotek zůstal
});

test("detail řízení se po pár dnech obnoví (stav se mění)", async () => {
  const first = await scanBuilding(fakeClient(), 1, { now: NOW });
  const client = fakeClient({ proceedingStav: "Odeslání informace o vyznačení plomby" });
  const scan = await scanBuilding(client, 1, { now: NOW + 5 * 24 * 60 * 60 * 1000, prev: first });
  assert.ok(client.log.includes("proceeding:100"));
  assert.equal(scan.plomby[0].rizeni[0].stav, "Odeslání informace o vyznačení plomby");
});

test("plomba, která zmizela: řízení skončilo, jeho konečný stav se zapamatuje", async () => {
  const first = await scanBuilding(fakeClient(), 1, { now: NOW });
  const client = fakeClient({ plombaOnSecond: false, proceedingStav: "Řízení ukončeno" });
  const scan = await scanBuilding(client, 1, { now: NOW + 20 * 24 * 60 * 60 * 1000, prev: first });
  assert.deepEqual(scan.plomby, []);
  assert.equal(scan.closed.length, 1);
  assert.equal(scan.closed[0].unit, 930004);
  assert.equal(scan.closed[0].proceeding.id, 100);
  assert.equal(scan.closed[0].proceeding.stav, "Řízení ukončeno");
  // Další sken už skončené řízení znovu nestahuje ani neduplikuje.
  const again = fakeClient({ plombaOnSecond: false });
  const third = await scanBuilding(again, 1, { now: NOW + 21 * 24 * 60 * 60 * 1000, prev: scan });
  assert.equal(third.closed.length, 1);
  assert.ok(!again.log.includes("proceeding:100"));
});
