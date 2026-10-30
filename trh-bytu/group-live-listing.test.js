// node --test trh-bytu/group-live-listing.test.js
// Odkaz "Inzerát" v přehledech nesmí vést na smazanou nabídku, když byt jinde běží (Dukelská, 10/2026: byt se po
// rezervaci vrátil, hlavní záznam podle zdroje a ID byla stará smazaná nabídka Sreality).
import test from "node:test";
import assert from "node:assert/strict";
import { liveListing, primaryListing, bestPrice, bestPriceListing } from "./group.js";

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

const p = (id, status, price, extra = {}) => ({ ...l(id, status), price_czk: price, ...extra });

test("cena: byt, který se vrátil s novou cenou, ukáže cenu aktuální nabídky, ne staré smazané (Dukelská: 3,29 M → 2,99 M)", () => {
  const members = [p("sreality:1615736908", "removed", 3_290_000), p("sreality:3583115340", "active", 2_990_000), p("idnes:6a9ad117", "removed", 3_290_000)];
  assert.equal(bestPrice(members), 2_990_000);
  assert.equal(bestPriceListing(members).id, "sreality:3583115340");
});

test("cena: běžící nabídky bez ceny (Dohodou) → platí poslední známá cena ze smazaných", () => {
  const members = [p("sreality:1", "removed", 3_290_000), p("sreality:2", "active", null)];
  assert.equal(bestPrice(members), 3_290_000);
});

test("cena: mezi běžícími nabídkami rozhoduje důvěryhodnost zdroje, mezi smazanými taky", () => {
  assert.equal(bestPrice([p("bazos:1", "active", 3_000_000), p("idnes:2", "active", 3_100_000)]), 3_100_000);
  assert.equal(bestPrice([p("idnes:2", "active", 3_100_000), p("bazos:1", "active", 3_000_000)]), 3_100_000); // na pořadí na vstupu nezáleží
  assert.equal(bestPrice([p("bazos:1", "removed", 3_000_000), p("idnes:2", "removed", 3_100_000)]), 3_100_000);
  assert.equal(bestPrice([p("bazos:1", "reserved", 3_000_000), p("sreality:2", "removed", 3_500_000)]), 3_000_000);
});

test("cena: nikdo cenu nemá → null; příznak ceny z textu patří nabídce, ze které se cena bere", () => {
  assert.equal(bestPrice([p("sreality:1", "active", null)]), null);
  assert.equal(bestPriceListing([p("sreality:1", "active", null)]), null);
  const members = [p("sreality:1", "removed", 3_290_000), p("bazos:2", "active", 2_990_000, { price_from_text: 1 })];
  assert.equal(bestPriceListing(members).price_from_text, 1);
});
