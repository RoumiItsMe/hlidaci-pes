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
    if (layer === "1" && where.includes("LIKE")) features = addressRows;
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
