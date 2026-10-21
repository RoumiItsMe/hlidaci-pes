// node --test trh-bytu/region-guard.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { isOutsideByAddress, isOutsideByPoint, nearestCenterKm, splitByAddress, OUTSIDE_MARGIN_KM } from "./region-guard.js";
import { watches } from "../config.js";

const WATCH = watches.find((w) => w.key === "byty");

test("adresa, která nejmenuje žádnou sledovanou lokalitu, je mimo (Pardubice)", () => {
  assert.equal(isOutsideByAddress("Gagarinova, Pardubice II, Pardubice", WATCH), true);
  assert.equal(isOutsideByAddress("Josefa Bublíka, Pardubice VII, Pardubice", WATCH), true);
  assert.equal(isOutsideByAddress("U Sportovní školy, Pardubice VII, Pardubice", WATCH), true);
});

test("adresa se sledovanou lokalitou zůstane — bez ohledu na diakritiku, velikost písmen i okres", () => {
  for (const a of ["Jilemnického, Ústí nad Orlicí", "U Dvora, Letohrad, okr. Ústí nad Orlicí", "SNP, Žamberk", "zamberk", "Truby, Česká Třebová", "Ústí nad Orlicí, ul. Lukesova", "Knapovec 6, Ústí  nad Orlicí"]) {
    assert.equal(isOutsideByAddress(a, WATCH), false, a);
  }
  // okres jmenuje Ústí nad Orlicí, takže o Králíkách rozhodne až bod z detailu
  assert.equal(isOutsideByAddress("Nádražní, Králíky, okr. Ústí nad Orlicí", WATCH), false);
});

test("bez adresy se nic nevylučuje (nejistota nesmí schovat skutečnou nabídku)", () => {
  for (const a of ["", "   ", null, undefined]) assert.equal(isOutsideByAddress(a, WATCH), false);
  assert.equal(isOutsideByAddress("Pardubice", { locations: [] }), false);
});

test("bod daleko od všech středů je mimo; bod v okruhu, na okraji i s rezervou zůstane", () => {
  // Pardubice, Králíky: mimo
  assert.equal(isOutsideByPoint(50.0343, 15.7812, WATCH), true);
  assert.equal(isOutsideByPoint(50.0844, 16.7655, WATCH), true);
  // střed Ústí, Letohrad, 5 km od středu Žamberka a 12 km (okraj okruhu + rezerva): uvnitř
  assert.equal(isOutsideByPoint(49.9739, 16.3957, WATCH), false);
  assert.equal(isOutsideByPoint(50.0352, 16.5036, WATCH), false);
  assert.equal(isOutsideByPoint(50.0735 + 12 / 111.32, 16.4664, WATCH), false);
  // těsně za okruhem + rezervou (5 + 8 km): mimo
  assert.equal(isOutsideByPoint(50.0735 + (5 + OUTSIDE_MARGIN_KM + 0.5) / 111.32, 16.4664, WATCH), true);
});

test("chybná nebo chybějící poloha nic nevylučuje (0,0, prohozené souřadnice, text, null)", () => {
  for (const [lat, lon] of [[0, 0], [16.39, 49.97], [null, null], [undefined, 16.4], ["50", "16"], [NaN, NaN]]) {
    assert.equal(isOutsideByPoint(lat, lon, WATCH), false, `${lat},${lon}`);
    assert.equal(nearestCenterKm(lat, lon, WATCH), null);
  }
  assert.equal(isOutsideByPoint(50.03, 15.78, { locations: [] }), false);
});

test("vzdálenost k nejbližšímu středu", () => {
  const km = nearestCenterKm(50.0343, 15.7812, WATCH); // Pardubice
  assert.ok(km > 40 && km < 55, String(km));
  assert.ok(nearestCenterKm(49.9739, 16.3957, WATCH) < 0.01);
});

test("výpis se rozdělí na zachované a vyřazené, pořadí se drží", () => {
  const items = [
    { id: "1", address: "Jilemnického, Ústí nad Orlicí" },
    { id: "2", address: "Gagarinova, Pardubice II, Pardubice" },
    { id: "3", address: "" },
    { id: "4", address: "Rokycanova, Pardubice V, Pardubice" },
    { id: "5", address: "Spořitelní, Letohrad" },
  ];
  const { kept, dropped } = splitByAddress(items, WATCH);
  assert.deepEqual(kept.map((i) => i.id), ["1", "3", "5"]);
  assert.deepEqual(dropped.map((i) => i.id), ["2", "4"]);
});

import { outsideReason } from "./region-guard.js";

test("uložená nabídka: mimo podle polohy (kterýkoli portál) nebo podle adresy (jen RealityMIX); jinak null", () => {
  const pardubice = { source: "realitymix", address: "Gagarinova, Pardubice II, Pardubice", lat: 50.0343, lon: 15.7812 };
  assert.equal(outsideReason(pardubice, WATCH), "point"); // poloha má přednost
  assert.equal(outsideReason({ ...pardubice, lat: null, lon: null }, WATCH), "address");
  assert.equal(outsideReason({ source: "bezrealitky", address: "Pardubice", lat: null, lon: null }, WATCH), null); // text jen u RealityMIX
  assert.equal(outsideReason({ source: "sreality", address: "Pardubice", lat: 50.0343, lon: 15.7812 }, WATCH), "point");
  assert.equal(outsideReason({ source: "realitymix", address: "Jilemnického, Ústí nad Orlicí", lat: 49.9739, lon: 16.3957 }, WATCH), null);
  assert.equal(outsideReason({ source: "realitymix", address: "", lat: null, lon: null }, WATCH), null);
});
