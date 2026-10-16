// node --test trh-bytu/new-build.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { isNewBuild, isNewBuildPending, ruianEntryForExactAddress } from "./new-build.js";
import { addressKey } from "./ruian.js";

const params = (p) => JSON.stringify(p);
const flat = (over = {}) => ({ id: "s:1", source: "sreality", address: "Česká Třebová", params_json: params({}), ...over });
const cache = (entries) => new Map(Object.entries(entries));
const KEY = addressKey("Lhotka", "51", "Česká Třebová");

test("novostavba: stav bytu z appky / uživatele, jinak portálový 'Novostavba' nebo 'Ve výstavbě'", () => {
  assert.equal(isNewBuild([flat({ own_condition: "novostavba" })]), true);
  assert.equal(isNewBuild([flat({ params_json: params({ condition: "Ve výstavbě" }) })]), true);
  assert.equal(isNewBuild([flat({ params_json: params({ condition: "Novostavba" }) })]), true);
  assert.equal(isNewBuild([flat({ params_json: params({ condition: "Velmi dobrý" }) })]), false);
  assert.equal(isNewBuild([flat()]), false);
});

test("ruční stav bytu přebíjí portál (uživatel řekl, že to novostavba není)", () => {
  assert.equal(isNewBuild([flat({ own_condition: "maintained", params_json: params({ condition: "Novostavba" }) })]), false);
  assert.equal(isNewBuild([flat({ own_condition: "novostavba", params_json: params({ condition: "Dobrý" }) })]), true);
});

test("výsledek RÚIAN pro zapsanou adresu: objekt / null (nezná) / undefined (bez adresy nebo nezjištěno)", () => {
  const withAddr = [flat({ exact_address: "Lhotka 51, Česká Třebová" })];
  assert.equal(ruianEntryForExactAddress(cache({ [KEY]: null }), withAddr), null);
  assert.deepEqual(ruianEntryForExactAddress(cache({ [KEY]: { building: { kod: 1 } } }), withAddr), { building: { kod: 1 } });
  assert.equal(ruianEntryForExactAddress(cache({}), withAddr), undefined);
  assert.equal(ruianEntryForExactAddress(cache({ [KEY]: null }), [flat()]), undefined);
});

test("novostavba před dokončením = novostavba se zapsanou adresou, kterou RÚIAN zná jako neznámou", () => {
  const nb = [flat({ own_condition: "novostavba", exact_address: "Lhotka 51, Česká Třebová" })];
  assert.equal(isNewBuildPending(nb, cache({ [KEY]: null })), true);
  assert.equal(isNewBuildPending(nb, cache({})), false); // ještě se nezjišťovalo — žádné předčasné označení
  assert.equal(isNewBuildPending(nb, cache({ [KEY]: { building: { kod: 1 } } })), false); // dům v registru je → ověřitelný
  assert.equal(isNewBuildPending([flat({ exact_address: "Lhotka 51, Česká Třebová" })], cache({ [KEY]: null })), false); // není novostavba
  assert.equal(isNewBuildPending([flat({ own_condition: "novostavba" })], cache({ [KEY]: null })), false); // bez adresy se nic neví
});
