// node --test trh-bytu/parse-area.test.js
// Výměra z textu inzerátu. Bazoš si znak "²" v textu rozbije na "m and sup2;" (tak ho posílá přímo v HTML) — bez
// téhle varianty u jeho inzerátů výměra chyběla a nešly spojit s inzeráty z jiných portálů (Dukelská, 10/2026).
import test from "node:test";
import assert from "node:assert/strict";
import { parseAreaM2, parseAddressFromTitle } from "./parse.js";
import { groupListings } from "./group.js";

test("výměra: m², m2 i rozbitý zápis z Bazoše (m and sup2;, m&sup2;)", () => {
  assert.equal(parseAreaM2("Prodej bytu 3+1, 67 m², Ústí nad Orlicí"), 67);
  assert.equal(parseAreaM2("Byt 1kk 28m2"), 28);
  assert.equal(parseAreaM2("byt o dispozici 3+1 a celkové výměře 67 m and sup2;, situovaný ve zvýšeném přízemí"), 67);
  assert.equal(parseAreaM2("výměra 52,5 m and sup2; včetně sklepa"), 52.5);
  assert.equal(parseAreaM2("celková výměra 67 m&sup2;"), 67);
  assert.equal(parseAreaM2("celková výměra 67 m&amp;sup2;"), 67);
  assert.equal(parseAreaM2("67 M AND SUP2;"), 67);
});

test("výměra: pozemek a jiné míry bez čtverečního znaku se nebere", () => {
  assert.equal(parseAreaM2("pozemek o rozloze 3 451 m v obci Záchlumí"), null);
  assert.equal(parseAreaM2("vzdálenost 120 m and park poblíž"), null);
  assert.equal(parseAreaM2("v domě je 2 m and sup"), null);
  assert.equal(parseAreaM2(""), null);
  assert.equal(parseAreaM2(null), null);
});

test("adresa za výměrou v titulku funguje i s rozbitým zápisem z Bazoše", () => {
  const fixed = parseAddressFromTitle("Prodej bytu 1+1, 44 m², Ústí nad Orlicí, ulice Wolkerova");
  assert.equal(fixed, "Ústí nad Orlicí, ulice Wolkerova");
  assert.equal(parseAddressFromTitle("Prodej bytu 1+1, 44 m and sup2;, Ústí nad Orlicí, ulice Wolkerova"), fixed);
});

test("shoda napříč portály: výměru uvedenou v popisu Bazoše jako 'm and sup2;' párování uznává", () => {
  const description = "Krásný byt po povedené rekonstrukci v klidné části Ústí nad Orlicí, ve zvýšeném přízemí zděného domu. Byt je ihned k nastěhování, v okolí škola, školka i obchody a park.";
  const sreality = { id: "sreality:1", source: "sreality", disposition: "3+1", area_m2: 75, price_czk: null, address: "Dukelská, Ústí nad Orlicí", description, replaced_by: null, manual_group: null };
  // jiná výměra v poli inzerátu (68), ale popis uvádí 75 m² — jen v rozbitém zápisu z Bazoše
  const bazos = { id: "bazos:1", source: "bazos", disposition: "3+1", area_m2: 68, price_czk: null, address: "Ústí nad Orlicí", description: `${description} Celková výměra 75 m and sup2;.`, replaced_by: null, manual_group: null };
  assert.equal(groupListings([sreality, bazos]).length, 1);
  const withoutMention = { ...bazos, description };
  assert.equal(groupListings([sreality, withoutMention]).length, 2); // kontrola: bez zmínky o výměře se nespojí
});
