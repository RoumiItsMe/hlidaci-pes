// node --test trh-bytu/search.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { fold, parseQuery, searchEntry } from "./search.js";

/** Zjednodušený "entry" z computeEntries — jen to, co hledání čte. */
function entry(over = {}) {
  const members = over.members ?? [
    { id: "sreality:1211695180", source: "sreality", source_id: "1211695180", url: "https://www.sreality.cz/detail/prodej/byt/2+1/usti-nad-orlici-hylvaty-dukelska/1211695180", title: "Prodej bytu 2+1 52 m²", address: "Hylváty, Ústí nad Orlicí", description: "Krásný byt po rekonstrukci na sídlišti Dukla, ve 2. nadzemním podlaží.", price_czk: 3_450_000, disposition: "2+1" },
  ];
  return {
    g: { members },
    address: "Dukelská, Ústí nad Orlicí - Hylváty",
    city: "Ústí nad Orlicí",
    addressInfo: { exact: "Dukelská 323, Ústí nad Orlicí", unit: null },
    notes: null,
    sellerMotivation: null,
    lvNumber: null,
    priceLabel: "3 450 000 Kč",
    price: 3_450_000,
    rep: { disposition: "2+1", area_m2: 52 },
    params: { ownership: "Osobní" },
    ...over,
  };
}
const q = (text) => parseQuery(text);

test("foldování: bez diakritiky a velikosti písmen, délka textu se nemění", () => {
  assert.equal(fold("Spořitelní Žižkova ÚŘAD"), "sporitelni zizkova urad");
  assert.equal(fold("Příliš žluťoučký kůň").length, "Příliš žluťoučký kůň".length);
  assert.equal(fold(null), "");
});

test("dotaz: slova, čísla s mezerami se slepí, prázdný dotaz nemá slova", () => {
  assert.deepEqual(q("  Dukelská   323 "), ["dukelska", "323"]);
  assert.deepEqual(q("3 450 000"), ["3450000"]);
  assert.deepEqual(q("byt 3 450 000 Kč"), ["byt", "3450000", "kc"]);
  assert.deepEqual(q("2+1"), ["2+1"]);
  assert.deepEqual(q("   "), []);
  assert.deepEqual(q(null), []);
});

test("shoda podle ulice, bez diakritiky i podle části slova; vše v adrese/názvu je tier 0", () => {
  for (const text of ["dukelska", "Dukelská", "DUKELSKA 323", "hylvaty", "ústí orlicí", "dukel"]) {
    const r = searchEntry(entry(), q(text));
    assert.equal(r?.tier, 0, text);
  }
});

test("všechna slova musí být v bytu; jedno chybějící = žádná shoda", () => {
  assert.equal(searchEntry(entry(), q("dukelska lukesova")), null);
  assert.equal(searchEntry(entry(), q("neexistujici")), null);
});

test("shoda podle ID, odkazu, ceny (i s mezerami), dispozice a poznámky", () => {
  assert.equal(searchEntry(entry(), q("1211695180"))?.tier, 0); // ID
  assert.equal(searchEntry(entry(), q("sreality:1211695180"))?.tier, 0);
  assert.equal(searchEntry(entry(), q("3 450 000"))?.tier, 0);
  assert.equal(searchEntry(entry(), q("3450000"))?.tier, 0);
  assert.equal(searchEntry(entry(), q("2+1"))?.tier, 0);
  assert.equal(searchEntry(entry({ notes: "Volat majitele, vlastní parkování" }), q("parkování"))?.tier, 0);
  assert.equal(searchEntry(entry({ lvNumber: "6835" }), q("6835"))?.tier, 0);
});

test("text z kterékoli nabídky bytu: shoda jen v popisu je tier 1 s úryvkem kolem shody", () => {
  const e = entry({
    members: [
      { id: "sreality:a", source: "sreality", title: "Prodej bytu", address: "Hylváty", description: "Byt je po rekonstrukci.", price_czk: 3_450_000, disposition: "2+1" },
      { id: "realitymix:b", source: "realitymix", title: "Prodej bytu", address: "Hylváty", description: null, geo_json: JSON.stringify({ text: "Sklepní kóje a krásný výhled na Orlické hory, parkování před domem zdarma." }) },
    ],
  });
  const r = searchEntry(e, q("výhled"));
  assert.equal(r.tier, 1);
  assert.equal(r.context.match, "výhled"); // původní text se zachová, ne složený
  assert.match(r.context.before, /krásný $/);
  assert.match(r.context.after, /^ na Orlické hory/);
  // slova v různých nabídkách i v jádru zároveň: "rekonstrukci" (popis A) + "parkování" (popis B)
  assert.equal(searchEntry(e, q("rekonstrukci parkovani"))?.tier, 1);
  // diakritika v popisu se hledá bez diakritiky a úryvek nese původní podobu
  assert.equal(searchEntry(e, q("orlicke hory"))?.context.match, "Orlické");
});

test("prázdný dotaz odpovídá všemu; shoda v adrese má přednost před shodou jen v popisu", () => {
  assert.deepEqual(searchEntry(entry(), []), { tier: 0, context: null });
  const inAddress = searchEntry(entry(), q("dukelska"));
  const inText = searchEntry(entry({ address: "Jinde", addressInfo: {}, members: [{ id: "x:1", source: "x", title: "Byt", description: "Blízko ulice Dukelská a školy, v klidné části." }] }), q("dukelska"));
  assert.equal(inAddress.tier, 0);
  assert.equal(inText.tier, 1);
  assert.ok(inText.context.match.toLowerCase().startsWith("dukelsk"));
});

test("slova mimo jádro musí být v popisu všechna: jedno chybějící vyřadí byt", () => {
  const e = entry({ members: [{ id: "x:1", source: "x", title: "Byt", address: "Hylváty", description: "Byt po rekonstrukci, parkování před domem." }] });
  assert.equal(searchEntry(e, q("rekonstrukci parkovani"))?.tier, 1);
  assert.equal(searchEntry(e, q("rekonstrukci neexistuje")), null);
  assert.equal(searchEntry(e, q("hylvaty rekonstrukci neexistuje")), null); // slovo z jádra nic nezachrání
});
