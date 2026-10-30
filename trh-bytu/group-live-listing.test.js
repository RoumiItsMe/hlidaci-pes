// node --test trh-bytu/group-live-listing.test.js
// Odkaz "Inzerát" v přehledech nesmí vést na smazanou nabídku, když byt jinde běží (Dukelská, 10/2026: byt se po
// rezervaci vrátil, hlavní záznam podle zdroje a ID byla stará smazaná nabídka Sreality).
import test from "node:test";
import assert from "node:assert/strict";
import { liveListing, primaryListing } from "./group.js";

const l = (id, status) => ({ id, source: id.split(":")[0], status, url: `https://example.test/${id}` });

test("byt, který se po rezervaci vrátil: odkaz vede na aktuální nabídku, ne na starou smazanou", () => {
  const members = [l("sreality:1615736908", "removed"), l("sreality:3583115340", "active"), l("idnes:6a9ad117", "removed"), l("idnes:6ae49dad", "active")];
  assert.equal(primaryListing(members).id, "sreality:1615736908"); // to je ten problém: hlavní záznam je stará smazaná nabídka
  assert.equal(liveListing(members).id, "sreality:3583115340"); // nejdůvěryhodnější z těch, co jsou teď v nabídce
});

test("rezervovaná nabídka je taky živá; z živých rozhoduje důvěryhodnost zdroje", () => {
  assert.equal(liveListing([l("sreality:1", "removed"), l("idnes:2", "reserved")]).id, "idnes:2");
  assert.equal(liveListing([l("bazos:1", "active"), l("idnes:2", "active"), l("sreality:3", "active")]).id, "sreality:3");
});

test("žádná nabídka není živá: platí hlavní záznam", () => {
  const members = [l("idnes:2", "removed"), l("sreality:9", "removed"), l("sreality:1", "sold")];
  assert.equal(liveListing(members).id, primaryListing(members).id);
  assert.equal(liveListing([l("sreality:1", "removed")]).id, "sreality:1");
});

test("byt s jedinou živou nabídkou na méně důvěryhodném portálu vede právě na ni", () => {
  assert.equal(liveListing([l("sreality:1", "removed"), l("bazos:7", "active")]).id, "bazos:7");
});
