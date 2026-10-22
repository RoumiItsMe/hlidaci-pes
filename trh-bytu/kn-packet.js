// Podklady k ověření prodejní ceny v katastru — co appka o bytě ví a může připravit, aby ti zbylo jen
// dohledat a dopsat cenu. Čisté funkce (bez DB/HTTP), ať jdou otestovat; vykresluje je server.js
// (fronta Katastr).
//
// Katastr cenu neposkytuje přes API (kn-api.js), takže ji zadáváš ručně. Veřejné nahlížení do katastru ale
// má stálé adresy konkrétní budovy a jednotky (ZobrazObjekt.aspx?typ=Budova|Jednotka&id=…, id vrací
// API), a tak se dá odkázat přímo na ni. Vlastníka a další údaje katastr zobrazí až po vyřešení CAPTCHA —
// to appka nedělá a dělat nebude.

import { assumedSalePrice } from "./sale-record.js";
import { discountRange } from "./price-discount.js";

const KN_OBJECT_URL = "https://nahlizenidokn.cuzk.cz/ZobrazObjekt.aspx";
const DAY_MS = 24 * 60 * 60 * 1000;
// Rozhodnutí o vkladu bývá do ~měsíce od podání (viz kn-schedule.js, cena se hledá od 25. dne po podání).
const DECISION_DAYS = 30;

const isId = (id) => Number.isInteger(id) && id > 0;

/** Adresa stránky budovy / jednotky ve veřejném nahlížení do katastru, nebo null bez platného id. */
export function knObjectUrl(type, id) {
  if (!["Budova", "Jednotka"].includes(type) || !isId(id)) return null;
  return `${KN_OBJECT_URL}?typ=${type}&id=${id}`;
}

/**
 * Odkazy do katastru pro byt ze skenu domu (kn-scan.js): na jednotku, když je její číslo známé a v domě
 * existuje, jinak na dům. `unitNumber` je číslo z parseUnitNumber (kn-api.js) nebo null.
 */
export function knLinks({ scan, unitNumber = null }) {
  if (!scan) return { building: null, unit: null, unitMissing: false };
  const building = knObjectUrl("Budova", scan.buildingId);
  if (unitNumber == null) return { building, unit: null, unitMissing: false };
  const unit = (scan.units ?? []).find((u) => u.number === unitNumber);
  return { building, unit: unit ? knObjectUrl("Jednotka", unit.id) : null, unitMissing: !unit };
}

/**
 * Co je ve hře: kolik se bytu teď počítá do statistik, než se cena ověří, a v jakém rozpětí.
 * `null`, když ověřená cena už je, nebo když není z čeho odhad spočítat.
 */
export function priceStake({ lastPrice, verifiedPrice, discount }) {
  if (verifiedPrice != null || !(lastPrice > 0)) return null;
  const range = discountRange(discount);
  return {
    lastPrice,
    discount,
    estimate: assumedSalePrice(lastPrice, discount),
    low: assumedSalePrice(lastPrice, range.max),
    high: assumedSalePrice(lastPrice, range.min),
  };
}

/**
 * Dá se kupní cena už dohledat? Podle vkladu a konce plomby (kn-schedule.js):
 * `{ state: "ready" | "waiting", day }` nebo `null`, když o vkladu nic nevíme.
 *  - ready:   plomba skončila, nebo od podání vkladu uplynulo dost dní, aby rozhodnutí o vkladu přišlo;
 *  - waiting: plomba ještě trvá / rozhodnutí o vkladu ještě nepřišlo (`day` = od kdy se vyplatí hledat).
 */
export function priceReadiness({ knFiledAt = null, plombaEnd = null, now = Date.now() }) {
  if (plombaEnd) {
    const end = Date.parse(plombaEnd);
    return end <= now ? { state: "ready", day: plombaEnd.slice(0, 10) } : { state: "waiting", day: plombaEnd.slice(0, 10) };
  }
  if (knFiledAt) {
    const expected = Date.parse(knFiledAt) + DECISION_DAYS * DAY_MS;
    return { state: expected <= now ? "ready" : "waiting", day: new Date(expected).toISOString().slice(0, 10) };
  }
  return null;
}

/**
 * Postup ověřování ceny: `{ verified, needed, calibrated, discount }` — kolik ověřených cen appka má a kolik
 * jich potřebuje, aby si slevu u odhadů odvodila sama (price-discount.js).
 */
export function verificationProgress(discountInfo, needed) {
  const info = discountInfo ?? { discount: 0.1, calibrated: false, samples: 0 };
  return { verified: info.samples, needed, calibrated: info.calibrated, discount: info.discount };
}
