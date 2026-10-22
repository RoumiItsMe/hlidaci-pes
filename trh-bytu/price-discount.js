// Sleva z poslední inzerované ceny na kupní cenu — pro byty, jejichž skutečná cena prodeje není
// známá. Čisté funkce (bez DB), ať jdou otestovat.
//
// Kupní cena je typicky nižší než inzerovaná (po vyjednávání), jenže o kolik, appka nevěděla: počítala
// pevně s ASSUMED_PRICE_DISCOUNT (10 %). Ověřených prodejů je zatím pár, takže se místo jednoho čísla
// ukazuje rozpětí (sleva o DISCOUNT_SPREAD míň a víc) a až bude ověřených prodejů aspoň
// MIN_CALIBRATION_SAMPLES, odvodí se sleva z nich — medián skutečného rozdílu u ověřených bytů.

import { ASSUMED_PRICE_DISCOUNT } from "./sale-record.js";
import { bestPrice, pickOwnValue } from "./group.js";

/** Kolik ověřených prodejů je třeba, aby se sleva odvodila z dat místo pevných 10 %. */
export const MIN_CALIBRATION_SAMPLES = 10;
/** O kolik procentních bodů se sleva posouvá na obě strany při výpočtu rozpětí. */
export const DISCOUNT_SPREAD = 0.05;
// Odvozená sleva se drží v rozumných mezích (záporná by znamenala, že se byty prodávají nad inzerovanou
// cenou; nad 30 % už jde spíš o chybu v datech).
const MAX_CALIBRATED_DISCOUNT = 0.3;
// Vzorek mimo tenhle rozsah je téměř jistě překlep v ceně, ne reálný prodej.
const SAMPLE_MIN = -0.1;
const SAMPLE_MAX = 0.5;

/** Sleva v celých procentech pro text ("10"). */
export const percent = (discount) => Math.round(discount * 100);

/** Sleva, kterou má použít výpočet ceny u daného bytu (`e.discount` doplňuje computeEntries). */
export const entryDiscount = (e) => e?.discount?.discount ?? ASSUMED_PRICE_DISCOUNT;

function median(sorted) {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Sleva pro odhad kupní ceny: z ověřených prodejů (poměr kupní / poslední inzerované ceny), pokud jich je
 * aspoň MIN_CALIBRATION_SAMPLES, jinak výchozí. Vrací `{ discount, calibrated, samples }`.
 * `entries` = byty z computeEntries (`verifiedSalePrice`, `price`).
 */
export function estimateDiscount(entries) {
  const samples = [];
  for (const e of entries) {
    if (e.verifiedSalePrice == null || !(e.price > 0)) continue;
    const discount = 1 - e.verifiedSalePrice / e.price;
    if (discount >= SAMPLE_MIN && discount <= SAMPLE_MAX) samples.push(discount);
  }
  if (samples.length < MIN_CALIBRATION_SAMPLES) {
    return { discount: ASSUMED_PRICE_DISCOUNT, calibrated: false, samples: samples.length };
  }
  samples.sort((a, b) => a - b);
  // Na celá procenta: co appka ukazuje, to i počítá.
  const rounded = Math.round(Math.min(Math.max(median(samples), 0), MAX_CALIBRATED_DISCOUNT) * 100) / 100;
  return { discount: rounded, calibrated: true, samples: samples.length };
}

/**
 * Totéž ze skupin nabídek (group.js) — pro stránky, které nestaví celé `entries` (detail bytu).
 * Vrací stejné číslo jako estimateDiscount nad computeEntries.
 */
export function discountFromGroups(groups) {
  return estimateDiscount(
    groups.map((g) => ({ price: bestPrice(g.members), verifiedSalePrice: pickOwnValue(g.members, "verified_sale_price_czk") }))
  );
}

/** Rozpětí slev kolem základní: `{ base, min, max }` (min nejníž na 0). */
export function discountRange(base) {
  return { base, min: Math.max(0, Math.round((base - DISCOUNT_SPREAD) * 100) / 100), max: Math.round((base + DISCOUNT_SPREAD) * 100) / 100 };
}

/** Rozpětí slev slovy: "5–15 %". */
export function discountRangeLabel(base) {
  const { min, max } = discountRange(base);
  return `${percent(min)}–${percent(max)} %`;
}
