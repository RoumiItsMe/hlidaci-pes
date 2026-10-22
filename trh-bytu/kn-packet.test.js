// node --test trh-bytu/kn-packet.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { knObjectUrl, knLinks, priceStake, priceReadiness, verificationProgress } from "./kn-packet.js";

// Skutečný tvar skenu domu (kn-scan.js): id budovy a jednotky vrací API katastru.
const SCAN = {
  buildingId: 379759611,
  units: [
    { id: 108592611, number: 18020001, lv: 6835, use: "byt", share: "255/10000" },
    { id: 108593611, number: 18020002, lv: 6836, use: "byt", share: "258/10000" },
  ],
};

test("adresa objektu v katastru: jen budova a jednotka a jen s platným id", () => {
  assert.equal(knObjectUrl("Budova", 379759611), "https://nahlizenidokn.cuzk.cz/ZobrazObjekt.aspx?typ=Budova&id=379759611");
  assert.equal(knObjectUrl("Jednotka", 108592611), "https://nahlizenidokn.cuzk.cz/ZobrazObjekt.aspx?typ=Jednotka&id=108592611");
  for (const id of [null, undefined, 0, -5, 1.5, "12", NaN]) assert.equal(knObjectUrl("Budova", id), null, String(id));
  assert.equal(knObjectUrl("List", 1), null); // jiný typ appka nezná, ať neodkazuje naslepo
});

test("odkazy: na jednotku, když je známá a existuje; jinak na dům; bez skenu žádné", () => {
  assert.deepEqual(knLinks({ scan: SCAN, unitNumber: 18020002 }), {
    building: "https://nahlizenidokn.cuzk.cz/ZobrazObjekt.aspx?typ=Budova&id=379759611",
    unit: "https://nahlizenidokn.cuzk.cz/ZobrazObjekt.aspx?typ=Jednotka&id=108593611",
    unitMissing: false,
  });
  const noUnit = knLinks({ scan: SCAN });
  assert.equal(noUnit.unit, null);
  assert.ok(noUnit.building);
  // zapsané číslo jednotky v domě není → dům + příznak, ať to jde ukázat jako chyba v čísle
  const missing = knLinks({ scan: SCAN, unitNumber: 18020099 });
  assert.equal(missing.unit, null);
  assert.equal(missing.unitMissing, true);
  assert.deepEqual(knLinks({ scan: null, unitNumber: 18020001 }), { building: null, unit: null, unitMissing: false });
});

test("co je ve hře: odhad ceny a jeho rozpětí; nic, když je cena ověřená nebo není z čeho počítat", () => {
  assert.deepEqual(priceStake({ lastPrice: 3_000_000, verifiedPrice: null, discount: 0.1 }), {
    lastPrice: 3_000_000,
    discount: 0.1,
    estimate: 2_700_000,
    low: 2_550_000, // sleva 15 %
    high: 2_850_000, // sleva 5 %
  });
  assert.equal(priceStake({ lastPrice: 3_000_000, verifiedPrice: 2_800_000, discount: 0.1 }), null);
  assert.equal(priceStake({ lastPrice: null, verifiedPrice: null, discount: 0.1 }), null);
  assert.equal(priceStake({ lastPrice: 0, verifiedPrice: null, discount: 0.1 }), null);
  // kalibrovaná sleva se promítne
  assert.equal(priceStake({ lastPrice: 3_000_000, verifiedPrice: null, discount: 0.06 }).estimate, 2_820_000);
});

test("cena je dohledatelná: po konci plomby, nebo když od podání vkladu uplynulo dost dní", () => {
  const now = Date.parse("2026-10-22T10:00:00Z");
  assert.deepEqual(priceReadiness({ plombaEnd: "2026-10-10", now }), { state: "ready", day: "2026-10-10" });
  assert.deepEqual(priceReadiness({ plombaEnd: "2026-11-05", now }), { state: "waiting", day: "2026-11-05" });
  // konec plomby má přednost před výpočtem z podání
  assert.equal(priceReadiness({ plombaEnd: "2026-11-05", knFiledAt: "2026-08-01", now }).state, "waiting");
  // jen podání vkladu: rozhodnutí do ~30 dní
  assert.deepEqual(priceReadiness({ knFiledAt: "2026-10-12", now }), { state: "waiting", day: "2026-11-11" });
  assert.deepEqual(priceReadiness({ knFiledAt: "2026-09-12", now }), { state: "ready", day: "2026-10-12" });
  assert.equal(priceReadiness({ now }), null); // o vkladu nic nevíme → nic netvrdíme
});

test("postup ověřování: kolik cen appka má a kolik jich potřebuje; bez údajů výchozí", () => {
  assert.deepEqual(verificationProgress({ discount: 0.1, calibrated: false, samples: 3 }, 10), { verified: 3, needed: 10, calibrated: false, discount: 0.1 });
  assert.deepEqual(verificationProgress({ discount: 0.06, calibrated: true, samples: 12 }, 10), { verified: 12, needed: 10, calibrated: true, discount: 0.06 });
  assert.deepEqual(verificationProgress(undefined, 10), { verified: 0, needed: 10, calibrated: false, discount: 0.1 });
});
