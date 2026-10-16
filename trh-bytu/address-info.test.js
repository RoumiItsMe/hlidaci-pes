// node --test trh-bytu/address-info.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { addressInfo } from "./address-info.js";

const params = (p) => JSON.stringify(p);
const flat = (over = {}) => ({ id: "s:1", source: "sreality", address: "Popradská, Ústí nad Orlicí", params_json: params({}), ...over });
const coop = (over = {}) => flat({ params_json: params({ ownership: "Družstevní" }), ...over });

test("osobní byt bez zapsané adresy chybí (hlídá ho filtr Bez adresy a úkol)", () => {
  assert.equal(addressInfo([flat()]).state, "missing");
});

test("družstevní byt s lokalitou přesnou adresu nepotřebuje — v katastru se nedá ověřit", () => {
  assert.equal(addressInfo([coop()]).state, "notNeeded");
  assert.equal(addressInfo([coop({ address: "Česká Třebová (centrum)" })]).state, "notNeeded");
  assert.equal(addressInfo([coop({ address: "Česká Třebová" })]).state, "notNeeded");
});

test("družstevní byt úplně bez lokality se pořád připomíná", () => {
  assert.equal(addressInfo([coop({ address: null })]).state, "missing");
});

test("zapsaná adresa nebo jednotka vyhrává i u družstevního bytu", () => {
  assert.equal(addressInfo([coop({ exact_address: "Popradská 12, Ústí nad Orlicí" })]).state, "known");
  assert.equal(addressInfo([coop({ unit_number: "12/3" })]).state, "known");
});

test("družstevní byt, který uživatel označil jako 'neznámá', adresu nepotřebuje taky", () => {
  assert.equal(addressInfo([coop({ address_unknown: 1 })]).state, "notNeeded");
  assert.equal(addressInfo([flat({ address_unknown: 1 })]).state, "unknown");
});

test("vlastnictví z jiného portálu skupiny nebo ruční oprava rozhodují, ne jen první člen", () => {
  assert.equal(addressInfo([flat(), coop({ id: "b:2", source: "bazos", address: "Ústí nad Orlicí" })]).state, "notNeeded");
  // ruční oprava vlastnictví na Osobní přebíjí text/portál
  assert.equal(addressInfo([coop({ params_override_json: params({ ownership: "Osobní" }) })]).state, "missing");
});

test("příznak auto a autoOff se čtou jako dřív", () => {
  const ai = addressInfo([flat({ exact_address: "U Dvora 661, Letohrad", address_auto: 1 })]);
  assert.equal(ai.auto, true);
  assert.equal(addressInfo([flat({ address_auto: -1 })]).autoOff, true);
});
