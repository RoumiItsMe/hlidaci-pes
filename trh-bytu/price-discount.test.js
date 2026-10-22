// node --test trh-bytu/price-discount.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { estimateDiscount, discountRange, discountRangeLabel, entryDiscount, percent, MIN_CALIBRATION_SAMPLES, DISCOUNT_SPREAD } from "./price-discount.js";

/** Byt s ověřenou prodejní cenou: poslední inzerovaná 3 000 000, prodáno se slevou `discount`. */
const sold = (discount, price = 3_000_000) => ({ price, verifiedSalePrice: Math.round(price * (1 - discount)) });
const many = (discount, count) => Array.from({ length: count }, () => sold(discount));

test("málo ověřených prodejů: zůstává pevných 10 % a appka říká, kolik vzorků má", () => {
  assert.deepEqual(estimateDiscount([]), { discount: 0.1, calibrated: false, samples: 0 });
  assert.deepEqual(estimateDiscount(many(0.04, MIN_CALIBRATION_SAMPLES - 1)), { discount: 0.1, calibrated: false, samples: MIN_CALIBRATION_SAMPLES - 1 });
});

test("od 10 ověřených prodejů se sleva odvodí z dat (medián), na celá procenta", () => {
  assert.deepEqual(estimateDiscount(many(0.06, 10)), { discount: 0.06, calibrated: true, samples: 10 });
  // medián, ne průměr: jeden extrémní prodej (−40 %) hodnotu neodvede
  const withOutlier = [...many(0.05, 9), sold(0.4)];
  assert.equal(estimateDiscount(withOutlier).discount, 0.05);
  // sudý počet: průměr dvou prostředních (4 % a 8 % → 6 %)
  assert.equal(estimateDiscount([...many(0.04, 5), ...many(0.08, 5)]).discount, 0.06);
  // zaokrouhleno na celá procenta, ať co appka ukazuje, to i počítá
  assert.equal(estimateDiscount(many(0.0734, 10)).discount, 0.07);
});

test("byty bez ověřené ceny nebo bez inzerované ceny a zjevné překlepy se do vzorku nepočítají", () => {
  const valid = many(0.06, 10);
  const noise = [
    { price: 3_000_000, verifiedSalePrice: null }, // cena neověřená
    { price: null, verifiedSalePrice: 2_800_000 }, // není s čím porovnat
    { price: 3_000_000, verifiedSalePrice: 300_000 }, // překlep o řád (sleva 90 %)
    { price: 3_000_000, verifiedSalePrice: 30_000_000 }, // překlep opačně
  ];
  assert.deepEqual(estimateDiscount([...valid, ...noise]), { discount: 0.06, calibrated: true, samples: 10 });
});

test("sleva se drží v mezích 0–30 %: prodej nad inzerovanou cenou nevyrobí zápornou slevu", () => {
  assert.equal(estimateDiscount(many(-0.02, 10)).discount, 0);
  assert.equal(estimateDiscount(many(0.45, 10)).discount, 0.3);
});

test("rozpětí kolem základní slevy: ±5 p. b., dolů nejvýš na 0", () => {
  assert.equal(DISCOUNT_SPREAD, 0.05);
  assert.deepEqual(discountRange(0.1), { base: 0.1, min: 0.05, max: 0.15 });
  assert.equal(discountRangeLabel(0.1), "5–15 %");
  assert.deepEqual(discountRange(0.03), { base: 0.03, min: 0, max: 0.08 });
  assert.equal(discountRangeLabel(0.03), "0–8 %");
});

test("sleva pro byt: kalibrovaná z computeEntries, jinak výchozí; procenta pro text", () => {
  assert.equal(entryDiscount({ discount: { discount: 0.07, calibrated: true, samples: 11 } }), 0.07);
  assert.equal(entryDiscount({}), 0.1);
  assert.equal(entryDiscount(undefined), 0.1);
  assert.equal(percent(0.07), 7);
  assert.equal(percent(0.1), 10);
});
