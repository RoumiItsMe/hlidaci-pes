// node --test trh-bytu/ruian.test.js
// RÚIAN se tu nevolá: global fetch je nahrazený falešnými odpověďmi podle vrstvy.
import test from "node:test";
import assert from "node:assert/strict";
import { ruianLookupAddress, ADDRESS_LOOKUP_VERSION } from "./ruian.js";

const ROW = { attributes: { adresa: "J. Drobného 1620, 56002 Česká Třebová", stavebniobjekt: 777 }, geometry: { x: 16.44, y: 49.9 } };
const BUILDING = (kod, cp) => ({ attributes: { kod, cisladomovni: cp, pocetbytu: 14, pocetpodlazi: 4, isknbudovaid: 5 } });

/**
 * @param addressRows   řádky vrstvy adresní místo pro hledání podle ulice a čísla
 * @param pointBuildings budovy, které se vrátí při hledání podle polohy (víc než jedna = nejednoznačné)
 */
function stubRuian({ addressRows = [ROW], pointBuildings = [BUILDING(777, "1620"), BUILDING(778, "1621")] } = {}) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    const layer = u.pathname.match(/\/(\d+)\/query$/)[1];
    const where = u.searchParams.get("where") || "";
    seen.push({ layer, where });
    let features = [];
    if (layer === "1" && where.includes("LIKE")) features = typeof addressRows === "function" ? addressRows(where) : addressRows;
    else if (layer === "1") features = [{ attributes: { adresa: ROW.attributes.adresa, cislodomovni: 1620, cisloorientacni: null } }];
    else if (layer === "3" && where.startsWith("kod=")) features = [BUILDING(Number(where.slice(4)), "1620")];
    else if (layer === "3") features = pointBuildings;
    else if (layer === "7") features = [{ attributes: { kod: 621757, nazev: "Česká Třebová" } }];
    return { ok: true, json: async () => ({ features }) };
  };
  return { seen, restore: () => (globalThis.fetch = original) };
}

test("budova se bere podle kódu z adresního místa, i když bod leží v obrysu víc objektů", async () => {
  const stub = stubRuian();
  try {
    const r = await ruianLookupAddress("J. Drobného", "1620", "Česká Třebová");
    assert.equal(r.ambiguous, false);
    assert.equal(r.building.kod, 777);
    assert.deepEqual(r.building.cp, ["1620"]);
    assert.equal(r.building.isknId, 5);
    assert.equal(r.ku.nazev, "Česká Třebová");
    assert.equal(r.lookupVersion, ADDRESS_LOOKUP_VERSION);
    assert.ok(stub.seen.some((q) => q.layer === "3" && q.where === "kod=777"));
  } finally {
    stub.restore();
  }
});

test("adresní místo bez kódu budovy: zpět na hledání podle polohy (dvě budovy v bodě = nejednoznačné)", async () => {
  const stub = stubRuian({ addressRows: [{ ...ROW, attributes: { adresa: ROW.attributes.adresa } }] });
  try {
    const r = await ruianLookupAddress("J. Drobného", "1620", "Česká Třebová");
    assert.equal(r.ambiguous, true);
    assert.equal(r.building, null);
    assert.equal(r.ku.kod, 621757);
  } finally {
    stub.restore();
  }
});

test("obec s PSČ ('560 02 Česká Třebová') se přiřadí ke správné obci, ne k téže ulici jinde", async () => {
  const other = { attributes: { adresa: "J. Drobného 1620, 56301 Lanškroun", stavebniobjekt: 999 }, geometry: { x: 16.6, y: 49.9 } };
  const stub = stubRuian({ addressRows: [other, ROW] });
  try {
    const r = await ruianLookupAddress("J. Drobného", "1620", "560 02 Česká Třebová");
    assert.equal(r.addressPoint, ROW.attributes.adresa);
    assert.equal(r.building.kod, 777);
  } finally {
    stub.restore();
  }
});

test("adresa, kterou RÚIAN nezná, vrací null", async () => {
  const stub = stubRuian({ addressRows: [] });
  try {
    assert.equal(await ruianLookupAddress("Neexistující", "1", "Česká Třebová"), null);
  } finally {
    stub.restore();
  }
});

import { DatabaseSync } from "node:sqlite";
import { initDb, insertListing, updateListingFields } from "./db.js";
import { addressKey, saveRuian, loadRuianCache, ruianPending, isRuianEntryStale, RECHECK_UNKNOWN_DAYS } from "./ruian.js";

const DAYS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-16T12:00:00.000Z");

test("co se v mezipaměti opakuje: adresa neznámá po RECHECK_UNKNOWN_DAYS, starší nález bez budovy; ostatní ne", () => {
  const key = "adr:lhotka|51|ceska trebova";
  const old = NOW - (RECHECK_UNKNOWN_DAYS + 1) * DAYS;
  const recent = NOW - 2 * DAYS;
  assert.equal(isRuianEntryStale(key, null, recent, NOW), false); // adresu RÚIAN neznal teprve nedávno
  assert.equal(isRuianEntryStale(key, null, old, NOW), true); // novostavba mezitím mohla dostat číslo popisné
  assert.equal(isRuianEntryStale(key, null, undefined, NOW), true); // bez údaje o stáří radši zopakovat
  assert.equal(isRuianEntryStale("pt:49.9,16.4", null, old, NOW), false); // body se neopakují
  assert.equal(isRuianEntryStale(key, { addressPoint: "x" }, recent, NOW), true); // starší verze hledání, budova nenalezena
  assert.equal(isRuianEntryStale(key, { addressPoint: "x", lookupVersion: ADDRESS_LOOKUP_VERSION }, recent, NOW), false);
  assert.equal(isRuianEntryStale(key, { addressPoint: "x", building: { kod: 1 } }, old, NOW), false);
});

test("ruianPending: adresa, kterou RÚIAN dřív neznal, se po čase zjistí znovu — novostavba se objeví v registru", async () => {
  const db = initDb(new DatabaseSync(":memory:"));
  insertListing(db, { id: "sreality:1", source: "sreality", source_id: "1", url: "https://example.invalid/1", title: "Prodej bytu 2+1", address: "Česká Třebová", status: "active", first_seen_at: "2026-09-24T06:00:00.000Z", last_seen_at: "2026-10-16T06:00:00.000Z" });
  updateListingFields(db, "sreality:1", { exact_address: "J. Drobného 1620, Česká Třebová" });
  const key = addressKey("J. Drobného", "1620", "Česká Třebová");
  saveRuian(db, key, null); // dřív neznámá

  const stub = stubRuian();
  try {
    // čerstvé "neznámá" se nezjišťuje znovu
    await ruianPending(db, () => {}, { delayMs: 0 });
    assert.equal(loadRuianCache(db).get(key), null);
    assert.equal(stub.seen.length, 0);

    // po RECHECK_UNKNOWN_DAYS ano, a RÚIAN už adresu i budovu zná
    db.prepare("UPDATE ruian_cache SET fetched_at = ? WHERE key = ?").run(new Date(Date.now() - (RECHECK_UNKNOWN_DAYS + 1) * DAYS).toISOString(), key);
    await ruianPending(db, () => {}, { delayMs: 0 });
    const refreshed = loadRuianCache(db).get(key);
    assert.equal(refreshed.building.kod, 777);
    assert.equal(refreshed.lookupVersion, ADDRESS_LOOKUP_VERSION);
  } finally {
    stub.restore();
  }
});

test("záporná odpověď RÚIAN se opakuje po čtvrtletí, ne dřív", () => {
  const key = "adr:lhotka|51|ceska trebova";
  assert.equal(RECHECK_UNKNOWN_DAYS, 90);
  assert.equal(isRuianEntryStale(key, null, NOW - 30 * DAYS, NOW), false);
  assert.equal(isRuianEntryStale(key, null, NOW - 89 * DAYS, NOW), false);
  assert.equal(isRuianEntryStale(key, null, NOW - 91 * DAYS, NOW), true);
});

test("obec bez ulic: RÚIAN píše 'č.p. 181, 56102 Dolní Dobrouč', ne 'Dolní Dobrouč 181' — najde se druhým dotazem", async () => {
  const cpRow = { attributes: { adresa: "č.p. 181, 56102 Dolní Dobrouč", stavebniobjekt: 777 }, geometry: { x: 16.5, y: 49.9 } };
  const stub = stubRuian({ addressRows: (where) => (where.includes("č.p.") ? [cpRow] : []) });
  try {
    const r = await ruianLookupAddress("Dolní Dobrouč", "181", "Dolní Dobrouč");
    assert.equal(r.addressPoint, "č.p. 181, 56102 Dolní Dobrouč");
    assert.equal(r.building.kod, 777);
    assert.ok(stub.seen.some((q) => q.layer === "1" && q.where.includes("'č.p. 181, % Dolní Dobrouč'")));
  } finally {
    stub.restore();
  }
});

test("zápis 'č.p.' se zkouší jen tam, kde se název 'ulice' rovná obci — jinak by se trefilo cizí č.p. ve městě", async () => {
  const stub = stubRuian({ addressRows: (where) => (where.includes("č.p.") ? [{ attributes: { adresa: "č.p. 6, 56201 Ústí nad Orlicí", stavebniobjekt: 5 }, geometry: { x: 16.4, y: 49.9 } }] : []) });
  try {
    assert.equal(await ruianLookupAddress("Knapovec", "6", "Ústí nad Orlicí"), null);
    assert.ok(!stub.seen.some((q) => q.where.includes("č.p.")));
  } finally {
    stub.restore();
  }
});
