// node --test trh-bytu/auto-address.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initDb, insertListing, updateListingFields } from "./db.js";
import { addressKey, saveRuian } from "./ruian.js";
import { applyAutoAddresses } from "./auto-address.js";

function flat(db, id, over = {}) {
  insertListing(db, {
    id,
    source: "bazos",
    source_id: id.split(":")[1],
    url: "https://example.invalid/" + id,
    title: "Prodej bytu 3+1",
    disposition: "3+1",
    area_m2: 70,
    address: "Letohrad",
    description: "Prodej bytu v ulici U Dvora 661, Letohrad.",
    price_czk: 3_500_000,
    status: "removed",
    first_seen_at: "2026-09-24T06:00:00.000Z",
    last_seen_at: "2026-10-06T06:00:00.000Z",
    removed_at: "2026-10-07T06:00:00.000Z",
    ...over,
  });
}
const get = (db, id) => db.prepare("SELECT exact_address, address_auto FROM listings WHERE id = ?").get(id);
const logs = [];
const log = (l) => logs.push(l);

test("adresa z textu potvrzená v RÚIAN se doplní sama (označená jako automatická)", () => {
  const db = initDb(new DatabaseSync(":memory:"));
  flat(db, "bazos:1");
  saveRuian(db, addressKey("U Dvora", "661", "Letohrad"), { addressPoint: "U Dvora 661, 56151 Letohrad", ku: { kod: 1, nazev: "Letohrad" }, building: { cp: ["661"], isknId: 5 } });
  const { assigned } = applyAutoAddresses(db, log);
  assert.equal(assigned, 1);
  assert.deepEqual({ ...get(db, "bazos:1") }, { exact_address: "U Dvora 661, Letohrad", address_auto: 1 });
});

test("bez potvrzení z RÚIAN (nezjištěno / nezná) se nic nedoplní", () => {
  const db = initDb(new DatabaseSync(":memory:"));
  flat(db, "bazos:1");
  assert.equal(applyAutoAddresses(db, log).assigned, 0); // ještě nezjišťováno
  saveRuian(db, addressKey("U Dvora", "661", "Letohrad"), null); // dotaz proběhl, RÚIAN adresu nezná
  assert.equal(applyAutoAddresses(db, log).assigned, 0);
  assert.equal(get(db, "bazos:1").exact_address, null);
});

test("ruční adresa se potvrzením z textu nepřepíše", () => {
  const db = initDb(new DatabaseSync(":memory:"));
  flat(db, "bazos:1");
  updateListingFields(db, "bazos:1", { exact_address: "Husova 12, Letohrad" });
  saveRuian(db, addressKey("U Dvora", "661", "Letohrad"), { addressPoint: "U Dvora 661, 56151 Letohrad", ku: { kod: 1, nazev: "Letohrad" }, building: { cp: ["661"], isknId: 5 } });
  assert.equal(applyAutoAddresses(db, log).assigned, 0);
  assert.equal(get(db, "bazos:1").exact_address, "Husova 12, Letohrad");
});

import { addressNoticeLines } from "./auto-address.js";

test("upozornění na rezervaci: družstevní byt nevyzývá k doplnění adresy, osobní ano", () => {
  const db = initDb(new DatabaseSync(":memory:"));
  flat(db, "bazos:10", { status: "reserved", removed_at: null, description: "", address: "Ústí nad Orlicí, ul. Popradská" });
  updateListingFields(db, "bazos:10", { params_json: JSON.stringify({ ownership: "Družstevní" }) });
  flat(db, "bazos:11", { status: "reserved", removed_at: null, description: "", address: "Letohrad" });
  assert.deepEqual(addressNoticeLines(db, "bazos:10"), ["🏢 Družstevní byt — v katastru nejde ověřit, přesná adresa není potřeba."]);
  assert.match(addressNoticeLines(db, "bazos:11")[0], /Přesná adresa není zapsaná/);
});

test("část obce bez ulic: adresa od portálu potvrzená RÚIAN se doplní sama ('Knapovec 6')", () => {
  const db = initDb(new DatabaseSync(":memory:"));
  flat(db, "sreality:3967357004", {
    source: "sreality",
    source_id: "3967357004",
    address: "Knapovec, Ústí nad Orlicí",
    description: "Byt v menším zděném bytovém domě č. p. 6 s pouhými šesti bytovými jednotkami.",
    status: "active",
    removed_at: null,
  });
  updateListingFields(db, "sreality:3967357004", { geo_json: JSON.stringify({ precision: "address", street: null, houseNumber: "6", streetNumber: null, city: "Ústí nad Orlicí", cityPart: "Knapovec" }) });
  // dokud RÚIAN adresu nepotvrdí, zůstává jen návrh
  assert.equal(applyAutoAddresses(db, log).assigned, 0);
  saveRuian(db, addressKey("Knapovec", "6", "Ústí nad Orlicí"), { addressPoint: "Knapovec 6, 56201 Ústí nad Orlicí", ku: { kod: 666831, nazev: "Knapovec" }, building: { cp: ["6"], flats: 6, isknId: 400759611 } });
  assert.equal(applyAutoAddresses(db, log).assigned, 1);
  assert.deepEqual({ ...get(db, "sreality:3967357004") }, { exact_address: "Knapovec 6, Ústí nad Orlicí", address_auto: 1 });
});
