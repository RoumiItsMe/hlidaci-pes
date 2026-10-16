// node --test trh-bytu/parse.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { findKnownPlace, extractCity, zipToKnownPlace } from "./parse.js";
import { REGIONS } from "./region.js";

const NACHOD = REGIONS.nachod.watch;

test("Náchod: město se pozná z textu i ve skloňovaných tvarech", () => {
  assert.equal(findKnownPlace("Prodám byt v Náchodě na sídlišti.", NACHOD), "Náchod");
  assert.equal(findKnownPlace("Byt v Novém Městě nad Metují, klidná ulice", NACHOD), "Nové Město nad Metují");
  assert.equal(findKnownPlace("Byt v Hronově", NACHOD), null);
});

test("Náchod: město z adresy pro filtr — část obce patří k Náchodu, okres se ignoruje", () => {
  assert.equal(extractCity("Růžová, Náchod - Staré Město nad Metují", NACHOD), "Náchod");
  assert.equal(extractCity("Rašínova, Nové Město nad Metují, okr. Náchod", NACHOD), "Nové Město nad Metují");
  assert.equal(extractCity("Husova, Náchod", NACHOD), "Náchod");
});

test("PSČ z Bazoše se přiřadí k městu regionu", () => {
  assert.equal(zipToKnownPlace("547 01", NACHOD), "Náchod");
  assert.equal(zipToKnownPlace("54901", NACHOD), "Nové Město nad Metují");
  assert.equal(zipToKnownPlace("56401", NACHOD), null); // Žamberk je jiný region
});
