// node --test trh-bytu/group-review.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { groupListings } from "./group.js";
import { reviewGroup, compatible } from "./group-review.js";

const TEXT =
  "Krásný byt 2+1 po velmi povedené rekonstrukci! Vítejte v Ústí nad Orlicí! Nachází se na oblíbeném sídlišti Dukla ve 2. nadzemním podlaží zděného domu. " +
  "Plocha bytu je 52 m² včetně sklepa a lodžie. Byt je ihned k nastěhování, v okolí škola, školka i obchody.";

function listing(overrides) {
  return { id: "x:1", source: "x", disposition: "2+1", area_m2: 52, price_czk: 3_450_000, address: "Dukelská, Ústí nad Orlicí - Hylváty", description: TEXT, geo_json: null, replaced_by: null, manual_group: null, ...overrides };
}
const A = (o) => listing({ id: "sreality:a", source: "sreality", ...o });
const B = (o) => listing({ id: "idnes:b", source: "idnes", ...o });
const C = (o) => listing({ id: "bazos:c", source: "bazos", ...o });
const review = (rows) => reviewGroup(groupListings(rows)[0]);

test("neprotiřečí si: výměra v toleranci a cena shodná; chybějící údaj rozpor není", () => {
  assert.equal(compatible(A(), B()), true);
  assert.equal(compatible(A({ area_m2: 52.8 }), B()), true); // v toleranci 1 m²
  assert.equal(compatible(A({ price_czk: null }), B()), true); // RK cenu nezveřejnila
  assert.equal(compatible(A({ area_m2: null }), B()), true); // portál plochu neuvádí
  assert.equal(compatible(A({ price_czk: null }), B({ price_czk: null })), true);
  // rozpor: jiná výměra, jiná známá cena, jiná dispozice
  assert.equal(compatible(A({ area_m2: 58 }), B()), false);
  assert.equal(compatible(A({ price_czk: 3_300_000 }), B()), false);
  assert.equal(compatible(A({ disposition: "3+1" }), B()), false);
});

test("byt bez rozporu je v pořádku — i když ho spojil jen text a žádná nabídka nemá cenu", () => {
  assert.deepEqual(review([A(), B()]), { level: "ok", weak: [] });
  assert.deepEqual(review([A()]), { level: "ok", weak: [] });
  // RealityMIX bez ceny, výměra shodná: skoro jistě tentýž byt, nic ke kontrole
  assert.equal(review([A(), B(), C({ price_czk: null })]).level, "ok");
  assert.equal(review([A({ price_czk: null }), B({ price_czk: null })]).level, "ok");
});

test("ruční byt se nekontroluje (rozhodl uživatel)", () => {
  assert.equal(review([A({ manual_group: "m1" }), B({ manual_group: "m1", area_m2: 58 })]).level, "ok");
});

test("rozpor ve výměře (RealityMIX se sklepem) jde ke kontrole a řekne se v čem", () => {
  const rows = [A(), B(), C({ area_m2: 58 })];
  assert.equal(groupListings(rows).length, 1); // automatika je spojila podle textu
  const r = review(rows);
  assert.equal(r.level, "check");
  assert.deepEqual(r.weak, [{ id: "bazos:c", source: "bazos", notes: ["výměra 58 m² místo 52 m²"] }]);
});

test("rozpor v ceně jde ke kontrole; nabídka bez ceny a s jinou výměrou ukáže jen výměru", () => {
  // jedna nabídka s jinou cenou: spojená přes nabídku bez ceny (text)
  const rows = [A({ price_czk: null }), B({ price_czk: 3_450_000 }), C({ price_czk: 3_300_000 })];
  const r = review(rows);
  assert.equal(r.level, "check");
  assert.equal(r.weak.length, 1);
  assert.match(r.weak[0].notes.join(" "), /cena/);
  const withArea = review([A(), B(), C({ price_czk: null, area_m2: 56 })]);
  assert.deepEqual(withArea.weak[0].notes, ["výměra 56 m² místo 52 m²"]);
});

test("jádro je největší skupina nabídek, které si neprotiřečí; ostatní jsou 'slabé'", () => {
  const r = review([A(), B(), C({ area_m2: 57 })]);
  assert.deepEqual(r.weak.map((w) => w.id), ["bazos:c"]);
});
