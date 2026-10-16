// node --test trh-bytu/geo-suggest.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { resolveAddress } from "./geo-suggest.js";

const member = (over = {}) => ({
  id: "bazos:1",
  source: "bazos",
  address: "Letohrad",
  title: "Prodej bytu 3+1",
  description: "Prodej bytu v ulici U Dvora 661, Letohrad. Byt je po rekonstrukci.",
  geo_json: null,
  lat: null,
  lon: null,
  ...over,
});
const verified = { addressPoint: "U Dvora 661, 56151 Letohrad" };
const ctx = (over = {}) => ({ city: "Letohrad", geocodes: () => undefined, pinSharedBy: () => 0, ...over });

test("číslo domu jen z textu je návrh (medium) — bez dalšího důkazu se adresa nedoplní sama", () => {
  const r = resolveAddress([member()], ctx());
  assert.equal(r.level, "medium");
  assert.equal(r.text, "U Dvora 661, Letohrad");
});

test("text potvrzený RÚIAN (adresní místo v téže obci existuje) je high a řekne proč", () => {
  const r = resolveAddress([member()], ctx({ ruianAddress: () => verified }));
  assert.equal(r.level, "high");
  assert.equal(r.text, "U Dvora 661, Letohrad");
  assert.ok(r.evidence.some((e) => e.type === "ruian" && /RÚIAN/.test(e.note)));
});

test("RÚIAN ještě nezjistil → zůstává návrh a důvod to říká", () => {
  const r = resolveAddress([member()], ctx({ ruianAddress: () => undefined }));
  assert.equal(r.level, "medium");
  assert.ok(r.reasons.some((x) => /čeká na ověření v RÚIAN/.test(x)));
});

test("RÚIAN adresu nezná → zůstává návrh (text nemusí být adresa bytu)", () => {
  const r = resolveAddress([member()], ctx({ ruianAddress: () => null }));
  assert.equal(r.level, "medium");
  assert.ok(r.reasons.some((x) => /nezná/.test(x)));
});

test("RÚIAN našel stejnou ulici v jiné obci → nepotvrzuje", () => {
  const r = resolveAddress([member()], ctx({ ruianAddress: () => ({ addressPoint: "U Dvora 661, 56301 Lanškroun" }) }));
  assert.equal(r.level, "medium");
});

test("bez známé obce se text nepotvrzuje (RÚIAN by mohl trefit tutéž ulici jinde)", () => {
  const r = resolveAddress([member({ address: null })], ctx({ city: null, ruianAddress: () => verified }));
  assert.equal(r.level, "medium");
});

test("dvě různé adresy v textu si odporují → nic se nepřiřadí, ani s potvrzením RÚIAN", () => {
  const two = member({ description: "Byt v ulici U Dvora 661, vedle ulice Husova 12." });
  const r = resolveAddress([two], ctx({ ruianAddress: () => verified }));
  assert.equal(r.level, "conflict");
});

test("text potvrzený stejnou ulicí od portálu je high i bez RÚIAN (původní pravidlo zůstává)", () => {
  const sreality = member({ id: "sreality:2", source: "sreality", geo_json: JSON.stringify({ street: "U Dvora", precision: "street" }), description: "" });
  const r = resolveAddress([member(), sreality], ctx());
  assert.equal(r.level, "high");
});

test("číslo s jednotkou (cena, plocha, minuty) se za číslo domu nepovažuje", () => {
  const noise = member({ description: "V ulici U Dvora 5 minut od centra, 70 m², cena 3 500 000 Kč." });
  const r = resolveAddress([noise], ctx({ ruianAddress: () => verified }));
  assert.equal(r.level, "none");
});

// --- Část obce bez ulic ("Knapovec 6") ---------------------------------------
const GEO_PART = JSON.stringify({ precision: "address", street: null, houseNumber: "6", streetNumber: null, city: "Ústí nad Orlicí", cityPart: "Knapovec" });
const knapovec = (over = {}) =>
  member({ id: "sreality:1", source: "sreality", address: "Knapovec, Ústí nad Orlicí", description: "Byt v bytovém domě č. p. 6.", geo_json: GEO_PART, ...over });
const knapovecCtx = (over = {}) => ctx({ city: "Ústí nad Orlicí", ...over });
const knapovecVerified = { addressPoint: "Knapovec 6, 56201 Ústí nad Orlicí" };

test("část obce + číslo popisné od portálu, potvrzené RÚIAN → high ('Knapovec 6')", () => {
  const r = resolveAddress([knapovec()], knapovecCtx({ ruianAddress: () => knapovecVerified }));
  assert.equal(r.level, "high");
  assert.equal(r.text, "Knapovec 6, Ústí nad Orlicí");
  assert.ok(r.evidence.some((e) => e.type === "ruian"));
  assert.ok(r.evidence.some((e) => /část obce Knapovec/.test(e.note)));
});

test("část obce od portálu bez potvrzení z RÚIAN je jen návrh (ve městě s ulicemi by chyběla ulice)", () => {
  assert.equal(resolveAddress([knapovec()], knapovecCtx()).level, "medium"); // bez ruianAddress
  assert.equal(resolveAddress([knapovec()], knapovecCtx({ ruianAddress: () => undefined })).level, "medium");
  assert.equal(resolveAddress([knapovec()], knapovecCtx({ ruianAddress: () => null })).level, "medium");
});

test("část obce: číslo, které neodpovídá budově v bodě z inzerátu, je spor — nepřiřadí se nic", () => {
  const withPin = knapovec({ lat: 49.9597, lon: 16.4467 });
  const r = resolveAddress([withPin], knapovecCtx({ ruianAddress: () => knapovecVerified, ruian: () => ({ exact: true, ambiguous: false, building: { cp: ["7"] } }) }));
  assert.equal(r.level, "conflict");
});

test("ulice od portálu se chová jako dřív (část obce se použije jen, když ulice chybí)", () => {
  const withStreet = knapovec({ geo_json: JSON.stringify({ precision: "address", street: "Lukesova", houseNumber: "1234", city: "Ústí nad Orlicí", cityPart: "Ústí nad Orlicí" }) });
  const r = resolveAddress([withStreet], knapovecCtx());
  assert.equal(r.level, "high");
  assert.equal(r.text, "Lukesova 1234, Ústí nad Orlicí");
});

test("bod na dům s číslem, u kterého mapa nezná ulici: důvod to říká (ne 'míří na ulici')", () => {
  const withPin = knapovec({ geo_json: null, lat: 49.9597, lon: 16.4467 });
  const osm = { address: { house_number: "6", village: "Knapovec" } };
  const r = resolveAddress([withPin], knapovecCtx({ geocodes: () => osm }));
  assert.ok(r.reasons.some((x) => /míří na dům č\. 6, ale mapa u něj nezná ulici/.test(x)), r.reasons.join(" | "));
  assert.ok(!r.reasons.some((x) => /míří na ulici/.test(x)));
});
