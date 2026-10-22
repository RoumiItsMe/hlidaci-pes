// node --test trh-bytu/compare-filters.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { toNumber, applyCompareFilters, compareFilterOptions, sortDispositions, describeCompareFilters, NONE } from "./compare-filters.js";

let n = 0;
/** Zjednodušený "entry" z computeEntries — jen pole, která filtry čtou. */
function entry(over = {}) {
  n++;
  return {
    g: { members: [{ id: `sreality:${n}`, source: "sreality", title: "Prodej bytu", address: "Letohrad", description: "" }] },
    rep: { id: `sreality:${n}`, disposition: "2+1", area_m2: 55 },
    address: "Letohrad, ul. Ulice",
    city: "Letohrad",
    price: 3_000_000,
    priceLabel: "3 000 000 Kč",
    params: { ownership: "Osobní" },
    ownCondition: "renovated",
    daysOnMarket: 30,
    totalDiscountCzk: 0,
    ...over,
  };
}
const ids = (list) => list.map((e) => e.rep.id);

test("čísla: s mezerami, s čárkou, zkratky k a m; neplatné a záporné jsou null", () => {
  assert.equal(toNumber("3000000"), 3_000_000);
  assert.equal(toNumber("3 000 000"), 3_000_000);
  assert.equal(toNumber("3,5m"), 3_500_000);
  assert.equal(toNumber("2500k"), 2_500_000);
  assert.equal(toNumber("55.5"), 55.5);
  for (const bad of ["", "  ", null, undefined, "abc", "-5", "3 a 4"]) assert.equal(toNumber(bad), null, String(bad));
});

test("vlastnictví: jen osobní; 'bez údaje' najde byty, kterým vlastnictví chybí", () => {
  const personal = entry();
  const coop = entry({ params: { ownership: "Družstevní" } });
  const unknown = entry({ params: {} });
  const all = [personal, coop, unknown];
  assert.deepEqual(ids(applyCompareFilters(all, { vlastnictvi: "Osobní" })), [personal.rep.id]);
  assert.deepEqual(ids(applyCompareFilters(all, { vlastnictvi: NONE })), [unknown.rep.id]);
  assert.equal(applyCompareFilters(all, {}).length, 3); // bez filtru všechno
  assert.equal(applyCompareFilters(all, { vlastnictvi: "" }).length, 3);
});

test("dispozice a stav bytu (vč. 'bez hodnocení')", () => {
  const a = entry({ rep: { id: "a", disposition: "2+kk", area_m2: 50 }, ownCondition: "top" });
  const b = entry({ rep: { id: "b", disposition: "2+1", area_m2: 50 }, ownCondition: null });
  assert.deepEqual(ids(applyCompareFilters([a, b], { dispozice: "2+kk" })), ["a"]);
  assert.deepEqual(ids(applyCompareFilters([a, b], { stav_bytu: "top" })), ["a"]);
  assert.deepEqual(ids(applyCompareFilters([a, b], { stav_bytu: NONE })), ["b"]);
});

test("rozsah ceny a plochy: hranice jsou včetně, byt bez ceny/plochy rozsah nesplní", () => {
  const cheap = entry({ price: 2_000_000, rep: { id: "cheap", disposition: "1+1", area_m2: 30 } });
  const mid = entry({ price: 3_000_000, rep: { id: "mid", disposition: "2+1", area_m2: 55 } });
  const noPrice = entry({ price: null, rep: { id: "noprice", disposition: "2+1", area_m2: null } });
  const all = [cheap, mid, noPrice];
  assert.deepEqual(ids(applyCompareFilters(all, { cena_od: "2 000 000", cena_do: "3m" })), ["cheap", "mid"]);
  assert.deepEqual(ids(applyCompareFilters(all, { cena_od: "2500000" })), ["mid"]);
  assert.deepEqual(ids(applyCompareFilters(all, { cena_do: "2500000" })), ["cheap"]);
  assert.deepEqual(ids(applyCompareFilters(all, { plocha_od: "50" })), ["mid"]);
  assert.deepEqual(ids(applyCompareFilters(all, { plocha_do: "30" })), ["cheap"]);
  // nesmyslná hodnota filtr nezapne (nezúží na nic)
  assert.equal(applyCompareFilters(all, { cena_od: "abc" }).length, 3);
});

test("doba v nabídce aspoň N dní a jen zlevněné", () => {
  const fresh = entry({ daysOnMarket: 5 });
  const old = entry({ daysOnMarket: 90, totalDiscountCzk: 150_000 });
  const unknownDays = entry({ daysOnMarket: null });
  assert.deepEqual(ids(applyCompareFilters([fresh, old, unknownDays], { dnu_od: "60" })), [old.rep.id]);
  assert.deepEqual(ids(applyCompareFilters([fresh, old, unknownDays], { dnu_od: "5" })), [fresh.rep.id, old.rep.id]); // hranice včetně
  assert.deepEqual(ids(applyCompareFilters([fresh, old], { zlevneno: "1" })), [old.rep.id]);
});

test("hledání využívá stejnou logiku jako na stránce Byty (bez diakritiky, všechna slova)", () => {
  const a = entry({ address: "Spořitelní, Letohrad" });
  a.g.members[0].address = "Spořitelní, Letohrad";
  const b = entry();
  assert.deepEqual(ids(applyCompareFilters([a, b], { q: "sporitelni" })), [a.rep.id]);
  assert.equal(applyCompareFilters([a, b], { q: "sporitelni neexistuje" }).length, 0);
});

test("filtry se kombinují: osobní + nejdéle v nabídce + rozsah ceny", () => {
  const match = entry({ daysOnMarket: 120, price: 2_800_000 });
  const coop = entry({ daysOnMarket: 120, price: 2_800_000, params: { ownership: "Družstevní" } });
  const young = entry({ daysOnMarket: 10, price: 2_800_000 });
  const pricey = entry({ daysOnMarket: 120, price: 4_500_000 });
  const f = { vlastnictvi: "Osobní", dnu_od: "60", cena_do: "3m" };
  assert.deepEqual(ids(applyCompareFilters([match, coop, young, pricey], f)), [match.rep.id]);
});

test("možnosti výběrů: jen hodnoty z dat, dispozice od nejmenší", () => {
  const entries = [entry({ params: { ownership: "Osobní" }, rep: { id: "1", disposition: "3+1" } }), entry({ params: { ownership: "Družstevní" }, rep: { id: "2", disposition: "1+kk" } }), entry({ params: {}, rep: { id: "3", disposition: "2+kk" } }), entry({ rep: { id: "4", disposition: "2+1" } })];
  const o = compareFilterOptions(entries);
  assert.deepEqual(o.ownerships, ["Družstevní", "Osobní"]);
  assert.deepEqual(o.dispositions, ["1+kk", "2+kk", "2+1", "3+1"]);
  assert.deepEqual(sortDispositions(["atypický", "4+1", "1+1", "1+kk"]), ["1+kk", "1+1", "4+1", "atypický"]);
});

test("odznaky aktivních filtrů: co zrušit a slovně; bez filtrů žádné", () => {
  assert.deepEqual(describeCompareFilters({}), []);
  const chips = describeCompareFilters(
    { vlastnictvi: "Osobní", cena_od: "2m", cena_do: "3 500 000", dnu_od: "60", zlevneno: "1", stav_bytu: "top", plocha_od: "50", q: "dukelska" },
    { conditionLabel: (c) => ({ top: "V TOPu" })[c] }
  );
  const plain = (t) => t.replace(/\u00a0/g, " "); // toLocaleString dává do čísel nezlomitelné mezery
  assert.deepEqual(chips.map((c) => plain(c.label)), ["Vlastnictví: Osobní", "Stav: V TOPu", "Cena: 2 000 000 Kč–3 500 000 Kč", "Plocha: od 50 m²", "V nabídce aspoň 60 dní", "Jen zlevněné", "Hledání: „dukelska“"]);
  assert.deepEqual(chips.find((c) => c.label.startsWith("Cena")).clear, ["cena_od", "cena_do"]);
  assert.equal(describeCompareFilters({ vlastnictvi: NONE })[0].label, "Vlastnictví: bez údaje");
});
