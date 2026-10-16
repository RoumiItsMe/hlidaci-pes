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
