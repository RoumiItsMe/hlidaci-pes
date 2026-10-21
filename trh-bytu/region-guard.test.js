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

import { isDemandAd, notAnOfferReason } from "./region-guard.js";

test("poptávka (někdo byt shání) se pozná podle začátku titulku; běžné nabídky ne", () => {
  for (const title of ["Poptávka bytu v Novém Městě nad Metují: Dohodou", "poptávám byt 2+1 v Náchodě", "Koupím byt v Letohradě", "KOUPÍME byt", "Sháním byt 3+1 v Žamberku", "Hledám ke koupi byt", "Odkoupím byt, rychlé jednání", "  Poptávka: byt 2+kk"]) {
    assert.equal(isDemandAd(title), true, title);
  }
  for (const title of ["Prodej bytu 2+1, 54 m²", "Prodám byt 3+1", "Byt 2+1 v Náchodě, vhodný pro investory", "Poptávkový byt", "Koupímeto"]) {
    assert.equal(isDemandAd(title), false, title);
  }
  for (const empty of [null, undefined, ""]) assert.equal(isDemandAd(empty), false);
  assert.equal(notAnOfferReason({ title: "Poptávka bytu v Náchodě" }), "demand");
  assert.equal(notAnOfferReason({ title: "Prodej bytu 2+1" }), null);
});

import { isRentalAd, MIN_SALE_PRICE_CZK } from "./region-guard.js";

test("pronájem mezi nabídkami: pozná se podle URL, titulku nebo ceny v řádu nájmu; prodej (i 'vhodný k pronájmu') ne", () => {
  // reálný případ: jeden pronájem 3+kk v Letohradě na třech portálech
  assert.equal(isRentalAd({ title: "Prodej bytu, 3+kk, 62 m²", url: "https://realitymix.cz/detail/letohrad/pronajem-bytu-3-kk-62-m-8721671.html", price_czk: 19200 }), true);
  assert.equal(isRentalAd({ title: "Pronájem bytu 3+kk, 62 m2", url: "https://reality.idnes.cz/detail/prodej/byt/x/abc/", price_czk: null }), true);
  assert.equal(isRentalAd({ title: "Prodej bytu 3+kk 62 m²", url: "https://www.sreality.cz/detail/prodej/byt/3+kk/letohrad/2683506764", price_czk: 19200 }), true);
  assert.equal(isRentalAd({ title: "Prodej bytu 2+1", url: "https://www.sreality.cz/detail/pronajem/byt/2+1/x/1", price_czk: 3_500_000 }), true);
  assert.equal(isRentalAd({ title: "K pronájmu byt 1+1", url: "https://x/1", priceCzk: 8000 }), true); // priceCzk jako u položky z výpisu
  // běžné prodeje
  assert.equal(isRentalAd({ title: "Prodej bytu 2+1 54 m²", url: "https://www.sreality.cz/detail/prodej/byt/2+1/x/1", price_czk: 3_500_000 }), false);
  assert.equal(isRentalAd({ title: "Prodej bytu k investici, vhodný k pronájmu", url: "https://x/detail/prodej/byt/1", price_czk: 2_500_000 }), false);
  assert.equal(isRentalAd({ title: "Nájemní dům a byt na prodej", url: "https://x/2", price_czk: 5_000_000 }), false);
  // cena neznámá nebo nulová není důkaz pronájmu
  for (const price of [null, undefined, 0]) assert.equal(isRentalAd({ title: "Prodej bytu", url: "https://x/3", price_czk: price }), false);
  // hranice ceny
  assert.equal(isRentalAd({ title: "Prodej bytu", url: "https://x/4", price_czk: MIN_SALE_PRICE_CZK - 1 }), true);
  assert.equal(isRentalAd({ title: "Prodej bytu", url: "https://x/4", price_czk: MIN_SALE_PRICE_CZK }), false);
  // společný důvod: poptávka má přednost, pronájem se pozná, jinak nic
  assert.equal(notAnOfferReason({ title: "Poptávka bytu", url: "https://x/5", price_czk: 5000 }), "demand");
  assert.equal(notAnOfferReason({ title: "Pronájem bytu", url: "https://x/6" }), "rental");
  assert.equal(notAnOfferReason({ title: "Prodej bytu", url: "https://x/7", price_czk: 2_000_000 }), null);
});
