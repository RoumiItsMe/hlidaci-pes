// node --test trh-bytu/sale-stats.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { topSaleStats, almostSoldSaleStats, renovatedSaleStats, effectivePriceForStats } from "./sale-stats.js";
import { OWN_FIELDS } from "./params.js";

let n = 0;
/** Zjednodušený "entry" z computeEntries — jen pole, která statistiky čtou. */
function entry(over = {}) {
  n++;
  return {
    rep: { id: `sreality:${n}`, disposition: "2+1", area_m2: 50 },
    city: "Letohrad",
    address: `Letohrad, ul. Ulice ${n}`,
    status: "sold",
    price: 3_000_000,
    verifiedSalePrice: null,
    unverifiable: false,
    track: null,
    almostSold: true,
    statsInclude: null,
    ownCondition: "top",
    saleVerdict: null,
    ...over,
  };
}

test("stav 'V TOPu' je volba v hodnocení Stav (mezi Po rekonstrukci a Novostavbou), kódy se neopakují", () => {
  const condition = OWN_FIELDS.find((f) => f.column === "own_condition");
  assert.deepEqual(condition.options.map(([code]) => code), ["needs_reno", "maintained", "renovated", "top", "novostavba"]);
  assert.equal(condition.options.find(([code]) => code === "top")[1], "V TOPu");
  assert.equal(new Set(condition.options.map(([code]) => code)).size, condition.options.length);
});

test("TOP statistika: jen byty se stavem V TOPu, které jsou prodané, po rezervaci zmizelé nebo rezervované", () => {
  const sold = entry();
  const gone = entry({ status: "removed" }); // po rezervaci zmizel (almostSold)
  const reserved = entry({ status: "reserved" });
  const notAlmostSold = entry({ status: "removed", almostSold: false }); // zmizel bez rezervace = jen možný prodej
  const otherCondition = entry({ ownCondition: "renovated" });
  const noCondition = entry({ ownCondition: null });
  const stats = topSaleStats([sold, gone, reserved, notAlmostSold, otherCondition, noCondition]);
  assert.equal(stats.totalEligible, 3);
  assert.deepEqual(stats.cities[0].dispositions[0].items.map((i) => i.id).sort(), [sold, gone, reserved].map((e) => e.rep.id).sort());
});

test("TOP statistika: ruční 'Ve statistice: vyřadit' platí, byt v TOPu se nepočítá do 'Po rekonstrukci' (samostatný koš)", () => {
  const kept = entry();
  const excluded = entry({ statsInclude: "exclude" });
  assert.equal(topSaleStats([kept, excluded]).totalEligible, 1);
  assert.equal(renovatedSaleStats([kept]).totalEligible, 0); // TOP není "renovated"
  assert.equal(renovatedSaleStats([entry({ ownCondition: "renovated" })]).totalEligible, 1);
  // a obecná statistika prodaných bytů bere TOP byt jako každý jiný
  assert.equal(almostSoldSaleStats([kept]).totalEligible, 1);
});

test("TOP statistika: cena je ověřená, jinak odhad −10 %; souhrn přes všechna města a dispozice", () => {
  const verified = entry({ verifiedSalePrice: 3_500_000, rep: { id: "sreality:v", disposition: "3+1", area_m2: 70 } }); // 50 000 Kč/m²
  const estimated = entry({ price: 3_000_000, rep: { id: "sreality:e", disposition: "2+1", area_m2: 50 }, city: "Žamberk" }); // 2 700 000 / 50 = 54 000 Kč/m²
  assert.deepEqual(effectivePriceForStats(verified), { price: 3_500_000, basis: "verified" });
  assert.deepEqual(effectivePriceForStats(estimated), { price: 2_700_000, basis: "pending" });
  const stats = topSaleStats([verified, estimated]);
  assert.equal(stats.cities.length, 2);
  assert.deepEqual(stats.overall, { count: 2, verifiedCount: 1, assumedCount: 0, pendingCount: 1, avg: 52_000, min: 50_000, max: 54_000 });
  assert.equal(stats.overall.items, undefined); // souhrn nenese seznam bytů
});

test("TOP statistika bez bytů v TOPu: prázdná, souhrn null (žádné vymyšlené číslo)", () => {
  const stats = topSaleStats([entry({ ownCondition: null }), entry({ ownCondition: "maintained" })]);
  assert.deepEqual(stats, { cities: [], totalEligible: 0, overall: null });
  assert.equal(topSaleStats([]).overall, null);
});

test("souhrn 'overall' je i u ostatních statistik a odpovídá součtu po městech", () => {
  const entries = [entry({ ownCondition: null }), entry({ ownCondition: null, city: "Žamberk", price: 2_000_000 }), entry({ ownCondition: null, city: "Ústí nad Orlicí", price: 4_000_000 })];
  const stats = almostSoldSaleStats(entries);
  assert.equal(stats.overall.count, stats.cities.reduce((sum, c) => sum + c.totalCount, 0));
  assert.equal(stats.overall.count, 3);
});
