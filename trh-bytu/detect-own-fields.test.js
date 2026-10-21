// node --test trh-bytu/detect-own-fields.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { detectOwnCondition, conditionFromPortal, resolveOwnCondition, proposeOwnFields } from "./detect-own-fields.js";
import { geoTextOf, descriptionForDetection, listingText } from "./listing-text.js";

test("stav z textu: dosavadní pravidla se nezměnila (po rekonstrukci / k rekonstrukci / udržovaný / novostavba)", () => {
  assert.equal(detectOwnCondition("Byt je po kompletní rekonstrukci."), "renovated");
  assert.equal(detectOwnCondition("Byt prošel celkovou rekonstrukcí."), "renovated");
  assert.equal(detectOwnCondition("Byt je k rekonstrukci."), "needs_reno");
  assert.equal(detectOwnCondition("Velmi dobře udržovaný byt 3+1."), "maintained");
  assert.equal(detectOwnCondition("Cihlová novostavba z roku 2020."), "novostavba");
  assert.equal(detectOwnCondition("Částečná rekonstrukce bytu."), null);
  assert.equal(detectOwnCondition("Do budoucna je naplánována kompletní rekonstrukce, byt po rekonstrukci domu."), null); // plánovaná práce není hotová
  assert.equal(detectOwnCondition("Byt je po rekonstrukci a zároveň k rekonstrukci."), null); // protichůdné
  assert.equal(detectOwnCondition(""), null);
  assert.equal(detectOwnCondition(null), null);
});

test("'zrekonstruovaná koupelna' je jedna součást, ne byt po rekonstrukci; zrekonstruovaný byt ano", () => {
  assert.equal(detectOwnCondition("Byt prošel postupnou modernizací, zrekonstruovaná koupelna, nová okna."), null);
  assert.equal(detectOwnCondition("Zrekonstruovaná kuchyň a koupelna, plastová okna."), null);
  assert.equal(detectOwnCondition("Zrekonstruovaný byt v klidné lokalitě."), "renovated");
  assert.equal(detectOwnCondition("Byt je zrekonstruovaný, připravený k nastěhování."), "renovated");
  assert.equal(detectOwnCondition("Kompletně zrekonstruovaný byt včetně koupelny."), "renovated");
  assert.equal(detectOwnCondition("V bytě je zrekonstruované jádro, podlahy a rozvody."), null); // jen části
});

test("portálový Stav: mapují se jen jednoznačné hodnoty (novostavba, po / před rekonstrukcí)", () => {
  assert.equal(conditionFromPortal("Novostavba"), "novostavba");
  assert.equal(conditionFromPortal("Ve výstavbě"), "novostavba");
  assert.equal(conditionFromPortal("Po rekonstrukci"), "renovated");
  assert.equal(conditionFromPortal("Před rekonstrukcí"), "needs_reno");
  assert.equal(conditionFromPortal("  po REKONSTRUKCI "), "renovated"); // velikost písmen a okraje nevadí
  // dvojznačné se nemapují — u uživatele se dělí všemi směry
  for (const v of ["Velmi dobrý", "Dobrý", "V rekonstrukci", "Špatný", "", null, undefined, 5]) assert.equal(conditionFromPortal(v), null, String(v));
});

test("stav z textu a portálu dohromady: shoda a jediný signál platí, protichůdné = nic", () => {
  assert.equal(resolveOwnCondition({ text: "byt po rekonstrukci", portalCondition: "Po rekonstrukci" }), "renovated");
  assert.equal(resolveOwnCondition({ text: "bez zmínky", portalCondition: "Po rekonstrukci" }), "renovated"); // jen portál
  assert.equal(resolveOwnCondition({ text: "byt po rekonstrukci", portalCondition: "Dobrý" }), "renovated"); // jen text (portál dvojznačný)
  assert.equal(resolveOwnCondition({ text: "byt k rekonstrukci", portalCondition: "Po rekonstrukci" }), null); // spor
  assert.equal(resolveOwnCondition({ text: "bez zmínky", portalCondition: "Velmi dobrý" }), null);
  assert.equal(resolveOwnCondition({ text: "", portalCondition: null }), null);
});

test("návrh vlastního hodnocení: jen to, co chybí; uložené (i ruční) hodnoty se nikdy nepřepíšou", () => {
  const input = { text: "Cihlový dům po revitalizaci. Byt po rekonstrukci.", portalCondition: "Po rekonstrukci" };
  assert.deepEqual(proposeOwnFields(input), { own_condition: "renovated", own_construction: "brick", own_revitalized: "yes" });
  assert.deepEqual(proposeOwnFields(input, {}), proposeOwnFields(input));
  // uživatel už stav nastavil jinak → nic z toho se nenavrhne
  assert.deepEqual(proposeOwnFields(input, { own_condition: "needs_reno" }), { own_construction: "brick", own_revitalized: "yes" });
  assert.deepEqual(proposeOwnFields(input, { own_condition: "top", own_construction: "panel", own_revitalized: "no" }), {});
  assert.deepEqual(proposeOwnFields({ text: "nic", portalCondition: null }), {});
});

test("text inzerátu: popis, jinak text z geo_json (RealityMIX); nečitelný JSON nevadí", () => {
  const geo = JSON.stringify({ lat: 50.4, lon: 16.1, text: "Byt po celkové rekonstrukci." });
  assert.equal(geoTextOf(geo), "Byt po celkové rekonstrukci.");
  assert.equal(geoTextOf({ text: "objekt" }), "objekt");
  for (const bad of [null, undefined, "", "{ rozbité", JSON.stringify({ lat: 1 }), JSON.stringify({ text: 5 })]) assert.equal(geoTextOf(bad), "");
  assert.equal(descriptionForDetection({ description: "Popis z portálu", geo_json: geo }), "Popis z portálu"); // popis má přednost
  assert.equal(descriptionForDetection({ description: null, geo_json: geo }), "Byt po celkové rekonstrukci.");
  assert.equal(descriptionForDetection({ description: "", geo_json: null }), "");
  assert.equal(listingText({ title: "Prodej bytu 2+1", description: null, geo_json: geo }), "Prodej bytu 2+1 Byt po celkové rekonstrukci.");
  assert.equal(listingText({ title: null, description: null, geo_json: null }), "");
  // RealityMIX bez popisu: stav se z textu v geo_json opravdu pozná
  assert.equal(resolveOwnCondition({ text: listingText({ title: "Prodej bytu, 2+1, 54 m²", description: null, geo_json: geo }), portalCondition: null }), "renovated");
});
