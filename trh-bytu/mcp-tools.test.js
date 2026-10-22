// node --test trh-bytu/mcp-tools.test.js
// Nástroje běží nad databází otevřenou JEN PRO ČTENÍ (jako v mcp-server.js) — kdyby některý
// zapisoval, test spadne.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initDb, insertListing, insertEvent, updateListingFields } from "./db.js";
import { createTools, ToolInputError, dayOf, bytu } from "./mcp-tools.js";

const NOW = Date.parse("2026-10-20T10:00:00Z");
const tools = Object.fromEntries(createTools({ baseUrl: "http://localhost:4321", now: () => NOW }).map((t) => [t.name, t]));

function listing(id, over) {
  return {
    source: id.split(":")[0],
    source_id: id.split(":")[1],
    url: `https://example.invalid/${id}`,
    title: "Prodej bytu",
    description: "",
    status: "active",
    first_seen_at: "2026-09-22T08:00:00Z",
    last_seen_at: "2026-10-20T06:00:00Z",
    removed_at: null,
    ...over,
    id,
  };
}

/** Testovací databáze v souboru, po naplnění znovu otevřená jen pro čtení. */
function makeDb(fill) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-tools-"));
  const file = path.join(dir, "t.sqlite");
  const rw = initDb(new DatabaseSync(file));
  fill(rw);
  rw.close();
  return { db: new DatabaseSync(file, { readOnly: true }), dir };
}

const fixtures = (db) => {
  // A: prodáno, cena potvrzená (katastr)
  insertListing(db, listing("idnes:a", { disposition: "3+1", area_m2: 74, address: "Spořitelní, Letohrad", price_czk: 2_850_000, status: "sold", removed_at: "2026-10-03T06:00:00Z" }));
  updateListingFields(db, "idnes:a", { own_condition: "renovated", verified_sale_price_czk: 2_850_000, verified_sale_date: "2026-10-10", kn_filed_at: "2026-10-10", sale_verdict: "sold", notes: "poznámka k bytu" });
  insertEvent(db, { listing_id: "idnes:a", event_type: "created", occurred_at: "2026-09-22T08:00:00Z" });
  insertEvent(db, { listing_id: "idnes:a", event_type: "price_change", old_price_czk: 3_100_000, new_price_czk: 2_850_000, occurred_at: "2026-09-30T06:00:00Z" });
  // B: po rezervaci zmizel (čeká na ověření)
  insertListing(db, listing("sreality:b", { disposition: "2+1", area_m2: 60, address: "Ústí nad Orlicí, ul. Jilemnického", price_czk: 3_000_000, status: "removed", removed_at: "2026-10-05T06:00:00Z" }));
  insertEvent(db, { listing_id: "sreality:b", event_type: "created", occurred_at: "2026-09-22T08:00:00Z" });
  insertEvent(db, { listing_id: "sreality:b", event_type: "reserved", occurred_at: "2026-09-25T06:00:00Z" });
  insertEvent(db, { listing_id: "sreality:b", event_type: "removed", occurred_at: "2026-10-05T06:00:00Z" });
  updateListingFields(db, "sreality:b", { own_condition: "top" });
  // C: portál označil prodáno, cena zatím neověřená
  insertListing(db, listing("bazos:c", { disposition: "2+kk", area_m2: 50, address: "Česká Třebová, ul. Trávník", price_czk: 2_500_000, status: "sold", removed_at: "2026-09-15T06:00:00Z" }));
  // F: prodáno dávno (mimo výchozí období)
  insertListing(db, listing("bazos:f", { disposition: "1+1", area_m2: 35, address: "Žamberk, ul. Nádražní", price_czk: 1_200_000, status: "sold", removed_at: "2026-06-01T06:00:00Z" }));
  // E: prodáno, ale skryté
  insertListing(db, listing("bazos:e", { disposition: "4+1", area_m2: 90, address: "Letohrad, ul. Hlavní", price_czk: 4_000_000, status: "sold", removed_at: "2026-10-01T06:00:00Z" }));
  updateListingFields(db, "bazos:e", { hidden: 1 });
  // G: zmizel bez rezervace (nepatří mezi prodané)
  insertListing(db, listing("sreality:g", { disposition: "3+kk", area_m2: 65, address: "Žamberk, ul. Tichá", price_czk: 3_300_000, status: "removed", removed_at: "2026-10-02T06:00:00Z" }));
  // nabídky: dvě v nabídce, jedna rezervovaná
  insertListing(db, listing("sreality:o1", { disposition: "2+1", area_m2: 55, address: "Ústí nad Orlicí, ul. Lukesova", price_czk: 3_500_000, first_seen_at: "2026-10-18T08:00:00Z" }));
  insertListing(db, listing("sreality:o2", { disposition: "3+kk", area_m2: 70, address: "Letohrad, ul. Nová", price_czk: 4_200_000, first_seen_at: "2026-10-01T08:00:00Z" }));
  insertEvent(db, { listing_id: "sreality:o2", event_type: "price_change", old_price_czk: 4_500_000, new_price_czk: 4_300_000, occurred_at: "2026-10-10T06:00:00Z" });
  insertEvent(db, { listing_id: "sreality:o2", event_type: "price_change", old_price_czk: 4_300_000, new_price_czk: 4_200_000, occurred_at: "2026-10-15T06:00:00Z" });
  insertListing(db, listing("sreality:o3", { disposition: "3+1", area_m2: 80, address: "Žamberk, ul. Dlouhá", price_czk: 3_000_000, status: "reserved", first_seen_at: "2026-09-25T08:00:00Z" }));
  updateListingFields(db, "sreality:o1", { own_condition: "top" });
  updateListingFields(db, "sreality:o3", { own_condition: "top" });
};

const { db } = makeDb(fixtures);
const run = (name, args = {}) => tools[name].handler(db, args);
const ids = (rows) => rows.map((r) => r.id).sort();

test("pomocníci: den z časového údaje (pražský čas), české množné číslo", () => {
  assert.equal(dayOf("2026-10-14"), "2026-10-14"); // datum bez času platí tak, jak je
  assert.equal(dayOf("2026-10-14T23:30:00Z"), "2026-10-15"); // po půlnoci v Praze už je další den
  assert.equal(dayOf(null), null);
  assert.equal(dayOf("nesmysl"), null);
  assert.deepEqual([1, 2, 4, 5, 0].map(bytu), ["1 byt", "2 byty", "4 byty", "5 bytů", "0 bytů"]);
});

test("prodane_byty: výchozí období 90 dní, bez skrytých, bez zmizelých bez rezervace; nejnovější prodej první", () => {
  const r = run("prodane_byty");
  assert.deepEqual(ids(r.byty), ["bazos:c", "idnes:a", "sreality:b"]); // ne F (červen), E (skrytý), G (bez rezervace)
  assert.deepEqual(r.byty.map((b) => b.id), ["idnes:a", "sreality:b", "bazos:c"]); // 10. 10., 5. 10., 15. 9.
  assert.equal(r.pocet, 3);
  assert.equal(r.pocetPotvrzenych, 1);
  assert.equal(r.pocetCekajicichNaOvereni, 2);
  assert.deepEqual(r.obdobi, { od: "2026-07-22", do: "2026-10-20" });
  assert.equal(r.byty[0].odkaz, "http://localhost:4321/byt/idnes%3Aa");
});

test("prodane_byty: cena prodeje je ověřená, nebo odhad −10 %, s uvedením základu a data", () => {
  const byId = Object.fromEntries(run("prodane_byty").byty.map((b) => [b.id, b]));
  assert.equal(byId["idnes:a"].cenaProdejeKc, 2_850_000);
  assert.match(byId["idnes:a"].cenaProdejeZaklad, /ověřená/);
  assert.equal(byId["idnes:a"].datumProdeje, "2026-10-10");
  assert.match(byId["idnes:a"].datumProdejeZdroj, /katastru/);
  assert.equal(byId["idnes:a"].cenaZaM2Kc, Math.round(2_850_000 / 74));
  assert.equal(byId["idnes:a"].stav, "prodáno (cena potvrzená)");
  assert.equal(byId["sreality:b"].cenaProdejeKc, 2_700_000); // 3 000 000 − 10 %
  assert.match(byId["sreality:b"].cenaProdejeZaklad, /odhad.*čeká na ověření/);
  assert.equal(byId["sreality:b"].datumProdeje, "2026-10-05");
  assert.match(byId["sreality:b"].datumProdejeZdroj, /zmizení inzerátu/);
  assert.equal(byId["sreality:b"].doklad, "po rezervaci zmizelo z portálů");
  assert.equal(byId["sreality:b"].stav, "čeká na ověření");
  assert.equal(byId["bazos:c"].doklad, "portál označil jako prodáno");
  assert.equal(byId["idnes:a"].pocetSnizeniCeny, 1);
});

test("prodane_byty: hranice období jsou včetně, pořadí od/do se hlídá", () => {
  assert.deepEqual(ids(run("prodane_byty", { od: "2026-10-10", do: "2026-10-10" }).byty), ["idnes:a"]);
  assert.deepEqual(ids(run("prodane_byty", { od: "2026-10-11" }).byty), []);
  assert.deepEqual(ids(run("prodane_byty", { do: "2026-10-09", od: "2026-10-05" }).byty), ["sreality:b"]);
  assert.deepEqual(ids(run("prodane_byty", { od: "2026-05-01", do: "2026-06-30" }).byty), ["bazos:f"]);
  assert.throws(() => run("prodane_byty", { od: "2026-10-11", do: "2026-10-01" }), ToolInputError);
});

test("prodane_byty: filtry stav, město (bez diakritiky), dispozice (bez mezer)", () => {
  assert.deepEqual(ids(run("prodane_byty", { stav: "potvrzene" }).byty), ["idnes:a"]);
  assert.deepEqual(ids(run("prodane_byty", { stav: "cekajici" }).byty), ["bazos:c", "sreality:b"]);
  assert.deepEqual(ids(run("prodane_byty", { mesto: "usti" }).byty), ["sreality:b"]);
  assert.deepEqual(ids(run("prodane_byty", { mesto: "ČESKÁ TŘEBOVÁ" }).byty), ["bazos:c"]);
  assert.deepEqual(ids(run("prodane_byty", { dispozice: "2 + kk" }).byty), ["bazos:c"]);
  assert.deepEqual(ids(run("prodane_byty", { limit: 1 }).byty), ["idnes:a"]);
  assert.match(run("prodane_byty", { limit: 1 }).upozorneni.join(" "), /prvních 1 z 3/);
});

test("prodane_byty: souhrn, upozornění na odhady a malý vzorek", () => {
  const r = run("prodane_byty");
  assert.equal(r.souhrnCenyProdeje.min, 2_250_000); // C: 2 500 000 −10 %
  assert.equal(r.souhrnCenyProdeje.max, 2_850_000);
  const notes = r.upozorneni.join(" ");
  assert.match(notes, /1 ověřenou kupní cenu/);
  assert.match(notes, /2 jen ODHAD/);
  assert.match(notes, /Malý vzorek \(3 byty\)/);
});

test("statistiky_cen (prodané): stejný vzorek jako Statistiky v appce vč. rezervovaných, členění podle města", () => {
  const r = run("statistiky_cen", { clenit_podle: "mesto" });
  // A, B, C + F (červen, bez filtru období) + rezervovaný o3; skrytý E a zmizelý bez rezervace G ne
  assert.equal(r.celkem.pocetBytu, 5);
  assert.deepEqual(r.celkem.zakladCeny, { overenych: 1, odhadNejdeOverit: 0, odhadCekaNaOvereni: 4 });
  assert.deepEqual(r.celkem.podleDokladu, { portalOznacilJakoProdano: 3, poRezervaciZmizeloZPortalu: 1, zatimRezervovano: 1 });
  const byCity = Object.fromEntries(r.skupiny.map((s) => [s.skupina, s]));
  assert.deepEqual(Object.keys(byCity).sort(), ["Letohrad", "Ústí nad Orlicí", "Česká Třebová", "Žamberk"].sort());
  assert.equal(byCity["Letohrad"].pocetBytu, 1);
  assert.equal(byCity["Letohrad"].cenaKc.prumer, 2_850_000);
  assert.equal(byCity["Letohrad"].poznamka, "malý vzorek");
  assert.equal(byCity["Žamberk"].pocetBytu, 2); // F (prodaný) + o3 (rezervovaný)
});

test("statistiky_cen (prodané): období podle data prodeje, jen potvrzené, medián je celé číslo", () => {
  const r = run("statistiky_cen", { od: "2026-10-01", do: "2026-10-31" });
  assert.equal(r.celkem.pocetBytu, 2); // A (10. 10.) a B (5. 10.); C je z 15. 9., o3 bez data prodeje
  assert.equal(r.celkem.cenaKc.min, 2_700_000);
  assert.equal(r.celkem.cenaKc.max, 2_850_000);
  assert.equal(r.celkem.cenaKc.median, 2_775_000);
  assert.ok(Number.isInteger(r.celkem.cenaZaM2Kc.median));
  assert.equal(r.skupiny, undefined);
  const confirmed = run("statistiky_cen", { vzorek: "potvrzene" });
  assert.equal(confirmed.celkem.pocetBytu, 1);
  assert.equal(confirmed.celkem.cenaKc.prumer, 2_850_000);
  assert.deepEqual(confirmed.celkem.zakladCeny, { overenych: 1, odhadNejdeOverit: 0, odhadCekaNaOvereni: 0 });
});

test("statistiky_cen (prodané): členění podle měsíce prodeje a dispozice", () => {
  const byMonth = run("statistiky_cen", { clenit_podle: "mesic", vzorek: "vse", od: "2026-09-01", do: "2026-10-31" });
  assert.deepEqual(byMonth.skupiny.map((s) => [s.skupina, s.pocetBytu]), [["2026-09", 1], ["2026-10", 2]]);
  const byDisp = run("statistiky_cen", { clenit_podle: "dispozice", od: "2026-09-01", do: "2026-10-31" });
  assert.deepEqual(byDisp.skupiny.map((s) => s.skupina).sort(), ["2+1", "2+kk", "3+1"]);
});

test("statistiky_cen (nabídky): inzerované ceny aktuálních nabídek a rezervovaných, bez rozpisu podle základu", () => {
  const r = run("statistiky_cen", { typ: "nabidky" });
  assert.equal(r.celkem.pocetBytu, 3);
  assert.equal(r.celkem.cenaKc.median, 3_500_000);
  assert.equal(r.celkem.cenaKc.min, 3_000_000);
  assert.equal(r.celkem.cenaKc.max, 4_200_000);
  assert.equal(r.celkem.zakladCeny, undefined);
  assert.match(r.upozorneni.join(" "), /INZEROVANÉ/);
  assert.equal(run("statistiky_cen", { typ: "nabidky", mesto: "Letohrad" }).celkem.pocetBytu, 1);
  assert.equal(run("statistiky_cen", { typ: "nabidky", od: "2026-10-15" }).celkem.pocetBytu, 1); // objeveno 18. 10.
});

test("statistiky_cen: žádná shoda dá prázdný souhrn s vysvětlením, ne chybu", () => {
  const r = run("statistiky_cen", { mesto: "Neexistující" });
  assert.equal(r.celkem.pocetBytu, 0);
  assert.equal(r.celkem.cenaKc, null);
  assert.match(r.upozorneni.join(" "), /není žádný byt s cenou/);
});

test("nabidky: filtry, řazení a limit", () => {
  assert.deepEqual(ids(run("nabidky").nabidky), ["sreality:o1", "sreality:o2", "sreality:o3"]);
  assert.equal(run("nabidky").nabidky[0].id, "sreality:o1"); // nejnovější objevená první
  assert.deepEqual(run("nabidky", { razeni: "cena_vzestupne" }).nabidky.map((n) => n.id), ["sreality:o3", "sreality:o1", "sreality:o2"]);
  assert.deepEqual(run("nabidky", { razeni: "cena_sestupne", limit: 1 }).nabidky.map((n) => n.id), ["sreality:o2"]);
  assert.deepEqual(ids(run("nabidky", { stav: "rezervovano" }).nabidky), ["sreality:o3"]);
  assert.deepEqual(ids(run("nabidky", { stav: "v_nabidce", cena_od: 3_400_000, cena_do: 3_600_000 }).nabidky), ["sreality:o1"]);
  assert.deepEqual(ids(run("nabidky", { plocha_od: 60 }).nabidky), ["sreality:o2", "sreality:o3"]);
  assert.deepEqual(ids(run("nabidky", { dispozice: "3+kk", mesto: "letohrad" }).nabidky), ["sreality:o2"]);
  const first = run("nabidky", { razeni: "cena_za_m2" }).nabidky[0];
  assert.equal(first.cenaZaM2Kc, Math.round(first.cenaKc / first.plochaM2));
  assert.equal(run("nabidky", { limit: 1 }).pocetNalezenych, 3);
});

test("zmeny_cen: řetěz změn jednoho bytu se spojí do jedné změny", () => {
  const r = run("zmeny_cen", { od: "2026-10-01" });
  assert.equal(r.pocetBytu, 1); // změna bytu A byla 30. 9. — před obdobím
  const o2 = r.byty[0];
  assert.equal(o2.id, "sreality:o2");
  assert.equal(o2.puvodniCenaKc, 4_500_000);
  assert.equal(o2.novaCenaKc, 4_200_000);
  assert.equal(o2.zmenaKc, -300_000);
  assert.equal(o2.zmenaProcent, -6.7);
  assert.equal(o2.pocetZmen, 2);
  assert.equal(o2.datumPosledniZmeny, "2026-10-15");
  assert.equal(o2.stav, "v nabídce");
  assert.equal(r.pocetZlevneni, 1);
  assert.equal(r.prumerneZlevneniProcent, -6.7);
});

test("zmeny_cen: výchozí období 30 dní, hranice včetně, směr zlevnění / zdražení", () => {
  const def = run("zmeny_cen");
  assert.deepEqual(def.obdobi, { od: "2026-09-20", do: "2026-10-20" });
  assert.deepEqual(ids(def.byty), ["idnes:a", "sreality:o2"]); // A zlevnil 30. 9. (je prodaný, ale změna ceny proběhla)
  assert.deepEqual(ids(run("zmeny_cen", { od: "2026-09-30", do: "2026-09-30" }).byty), ["idnes:a"]);
  assert.deepEqual(ids(run("zmeny_cen", { smer: "zdrazeni" }).byty), []);
  assert.deepEqual(ids(run("zmeny_cen", { smer: "zlevneni", limit: 1 }).byty), ["sreality:o2"]); // nejnovější změna první
});

test("detail_bytu: parametry, prodej, katastr, poznámka, časová osa, nabídky; funguje i pro skrytý byt", () => {
  const d = run("detail_bytu", { id: "idnes:a" });
  assert.equal(d.nazev, "Byt 3+1, 74 m²");
  assert.equal(d.stav, "prodáno (podle portálu)");
  assert.equal(d.prodej.cenaProdejeKc, 2_850_000);
  assert.match(d.prodej.cenaProdejeZaklad, /ověřená/);
  assert.equal(d.katastr.overenaKupniCenaKc, 2_850_000);
  assert.equal(d.katastr.vkladPodanDne, "2026-10-10");
  assert.equal(d.poznamka, "poznámka k bytu");
  assert.deepEqual(d.casovaOsa.map((e) => e.udalost), ["zaevidováno", "změna ceny"]);
  assert.deepEqual(d.casovaOsa[1], { datum: "2026-09-30", udalost: "změna ceny", portal: "Reality.iDNES.cz", puvodniCenaKc: 3_100_000, novaCenaKc: 2_850_000 });
  assert.equal(d.nabidky[0].url, "https://example.invalid/idnes:a");
  assert.equal(run("detail_bytu", { id: "bazos:e" }).skryty, true);
  assert.equal(run("detail_bytu", { id: "sreality:o1" }).prodej, null);
});

test("stav bytu: filtr stav_bytu (V TOPu, Po rekonstrukci, bez hodnocení) u prodaných bytů i nabídek; u řádků je stav slovy", () => {
  assert.deepEqual(ids(run("prodane_byty", { stav_bytu: "v_topu" }).byty), ["sreality:b"]);
  assert.deepEqual(ids(run("prodane_byty", { stav_bytu: "po_rekonstrukci" }).byty), ["idnes:a"]);
  assert.deepEqual(ids(run("prodane_byty", { stav_bytu: "bez_hodnoceni" }).byty), ["bazos:c"]);
  assert.deepEqual(ids(run("prodane_byty", { stav_bytu: "novostavba" }).byty), []);
  const byId = Object.fromEntries(run("prodane_byty").byty.map((b) => [b.id, b.stavBytu]));
  assert.deepEqual(byId, { "idnes:a": "Po rekonstrukci", "sreality:b": "V TOPu", "bazos:c": null });
  assert.deepEqual(ids(run("nabidky", { stav_bytu: "v_topu" }).nabidky), ["sreality:o1", "sreality:o3"]);
  assert.deepEqual(ids(run("nabidky", { stav_bytu: "v_topu", stav: "v_nabidce" }).nabidky), ["sreality:o1"]);
  assert.equal(run("nabidky", { stav_bytu: "v_topu" }).nabidky[0].stavBytu, "V TOPu");
});

test("stav bytu: statistiky cen prodaných bytů v TOPu (stejný vzorek jako Statistiky v appce) a členění podle stavu", () => {
  const top = run("statistiky_cen", { stav_bytu: "v_topu" });
  assert.equal(top.celkem.pocetBytu, 2); // B (po rezervaci zmizel) a rezervovaný o3
  assert.equal(top.celkem.cenaKc.min, 2_700_000); // obě ceny jsou odhad: 3 000 000 −10 %
  assert.equal(top.celkem.cenaKc.max, 2_700_000);
  assert.deepEqual(top.celkem.zakladCeny, { overenych: 0, odhadNejdeOverit: 0, odhadCekaNaOvereni: 2 });
  assert.equal(run("statistiky_cen", { stav_bytu: "v_topu", vzorek: "potvrzene" }).celkem.pocetBytu, 0); // v TOPu zatím žádný potvrzený prodej
  const groups = Object.fromEntries(run("statistiky_cen", { clenit_podle: "stav_bytu" }).skupiny.map((g) => [g.skupina, g.pocetBytu]));
  assert.deepEqual(groups, { "V TOPu": 2, "Po rekonstrukci": 1, "bez hodnocení": 2 });
  // nabídky v TOPu: inzerované ceny
  const offers = run("statistiky_cen", { typ: "nabidky", stav_bytu: "v_topu" });
  assert.equal(offers.celkem.pocetBytu, 2);
  assert.equal(offers.celkem.cenaKc.min, 3_000_000);
  assert.equal(offers.celkem.cenaKc.max, 3_500_000);
});

test("stav bytu: v detailu slovy, neplatná hodnota filtru se odmítne s výčtem možností", () => {
  assert.deepEqual(run("detail_bytu", { id: "sreality:b" }).vlastniHodnoceni, { Stav: "V TOPu" });
  assert.deepEqual(run("detail_bytu", { id: "idnes:a" }).vlastniHodnoceni, { Stav: "Po rekonstrukci" });
  assert.throws(() => run("prodane_byty", { stav_bytu: "top" }), (err) => err instanceof ToolInputError && /v_topu/.test(err.message) && /stav_bytu/.test(err.message));
  assert.throws(() => run("statistiky_cen", { clenit_podle: "stav" }), ToolInputError);
  for (const name of ["prodane_byty", "statistiky_cen", "nabidky"]) assert.ok(tools[name].inputSchema.properties.stav_bytu.enum.includes("v_topu"), name);
});

test("chybný vstup: srozumitelná česká hláška (ToolInputError), nikdy tichý výsledek", () => {
  const bad = [
    ["prodane_byty", { od: "2026/09/01" }, /RRRR-MM-DD/],
    ["prodane_byty", { od: "2026-13-45" }, /RRRR-MM-DD/],
    ["prodane_byty", { do: 20261001 }, /RRRR-MM-DD/],
    ["prodane_byty", { stav: "vsechno" }, /smí být jen: vse, potvrzene, cekajici/],
    ["prodane_byty", { limit: 0 }, /limit/],
    ["prodane_byty", { limit: 2.5 }, /limit/],
    ["statistiky_cen", { typ: "jine" }, /typ/],
    ["statistiky_cen", { clenit_podle: "rok" }, /clenit_podle/],
    ["nabidky", { cena_od: "levne" }, /cena_od.*číslo/],
    ["nabidky", { razeni: "nahodne" }, /razeni/],
    ["zmeny_cen", { smer: "nahoru" }, /smer/],
    ["detail_bytu", {}, /„id“/],
    ["detail_bytu", { id: "  " }, /„id“/],
    ["detail_bytu", { id: "sreality:neexistuje" }, /nenašel/],
  ];
  for (const [name, args, pattern] of bad) assert.throws(() => run(name, args), (err) => err instanceof ToolInputError && pattern.test(err.message), `${name} ${JSON.stringify(args)}`);
  assert.doesNotThrow(() => run("prodane_byty", { limit: 500 })); // limit nad maximum se ořízne, neodmítne
});

test("definice nástrojů: jedinečná jména, popis, schéma bez dalších vlastností, nic nezapisuje do databáze", () => {
  const all = createTools();
  assert.equal(new Set(all.map((t) => t.name)).size, all.length);
  for (const t of all) {
    assert.match(t.name, /^[a-z_]+$/);
    assert.ok(t.title && t.description.length > 40, t.name);
    assert.equal(t.inputSchema.type, "object");
    assert.equal(t.inputSchema.additionalProperties, false);
    assert.equal(typeof t.handler, "function");
  }
  // testovací databáze je otevřená jen pro čtení — zápis musí selhat, a nástroje přesto všechny proběhly
  assert.throws(() => db.exec("DELETE FROM listings"), /readonly/i);
  for (const t of all) {
    const args = t.name === "detail_bytu" ? { id: "idnes:a" } : {};
    assert.doesNotThrow(() => t.handler(db, args), t.name);
  }
});

test("trh_prehled: počty odpovídají appce (nabídky, rezervované, prodané, čekající) a stáří dat", () => {
  const r = run("trh_prehled");
  assert.equal(r.vNabidce, 2);
  assert.equal(r.rezervovano, 1);
  assert.equal(r.prodanoPotvrzeno, 1);
  assert.equal(r.cekaNaOvereni, 3); // B (po rezervaci zmizel), C a F (prodané bez ověřené ceny) — F je jen mimo výchozí období prodeje
  assert.equal(r.posledniAktualizaceDat, "2026-10-20");
  assert.equal(r.sekce, "http://localhost:4321");
  assert.ok(r.upozorneni.length >= 1);
});

test("dohledatelnost_zmizelych: zmizelé bez rezervace roztříděné; byt bez adresy jde zachránit, s odkazem a důvodem", () => {
  const r = run("dohledatelnost_zmizelych");
  // G je jediný zmizelý bez rezervace (B má rezervaci, F/A jsou prodané, E skrytý)
  assert.equal(r.zmizeloBezRezervace, 1);
  assert.equal(r.hlidaSe, 0);
  assert.equal(r.kZachraneDoplnenimAdresy, 1);
  assert.deepEqual(r.rozdeleni.find((d) => d.kategorie === "chybi_adresa").pocet, 1);
  assert.equal(r.rozdeleni.length, 7);
  assert.equal(r.byty.length, 1);
  assert.equal(r.byty[0].id, "sreality:g");
  assert.equal(r.byty[0].byt, "3+kk, 65 m²");
  assert.equal(r.byty[0].adresa, "Žamberk, ul. Tichá");
  assert.equal(r.byty[0].odkaz, "http://localhost:4321/byt/sreality%3Ag");
  assert.match(r.byty[0].proc, /chybí adresa/);
  assert.ok(r.upozorneni.some((u) => /nemusí být prodej/.test(u)));
});

test("statistiky_cen (prodané): u odhadů přibude rozpětí průměru za m² a informace o slevě; bez odhadů ne", () => {
  const r = run("statistiky_cen");
  const spread = r.celkem.rozpetiPrumeruZaM2Kc;
  assert.equal(spread.slevaProcent, "5–15 %");
  assert.equal(spread.zaklad, r.celkem.cenaZaM2Kc.prumer); // základ je stejný průměr jako ve výpisu
  assert.ok(spread.priVyssiSleve < spread.zaklad && spread.zaklad < spread.priNizsiSleve, JSON.stringify(spread));
  assert.deepEqual(
    { ...r.slevaOdhadu, poznamka: undefined },
    { slevaZPosledniCenyProcent: 10, rozpetiSlevyProcent: "5–15 %", odvozenaZOverenychProdeju: false, pocetOverenychProdeju: 1, poznamka: undefined }
  );
  assert.match(r.slevaOdhadu.poznamka, /pevných 10 %.*1 z 10/);
  assert.match(r.upozorneni.join(" "), /rozpětí 5–15 %/);
  // jen potvrzené (ověřená cena): žádný odhad, takže ani rozpětí
  assert.equal(run("statistiky_cen", { vzorek: "potvrzene" }).celkem.rozpetiPrumeruZaM2Kc, undefined);
});

test("prodane_byty: informace o slevě jde s výsledkem a popisek základu ceny nese rozpětí použité slevy", () => {
  const r = run("prodane_byty");
  assert.equal(r.slevaOdhadu.slevaZPosledniCenyProcent, 10);
  assert.match(r.byty.find((b) => b.id === "bazos:c").cenaProdejeZaklad, /−10 %/);
});

test("kalibrace: z 10 ověřených prodejů se sleva odvodí a použije v odhadech (statistiky i řádky)", () => {
  const { db: calibrated } = makeDb((d) => {
    for (let i = 1; i <= 10; i++) {
      const id = `bazos:v${i}`;
      insertListing(d, listing(id, { disposition: "2+1", area_m2: 50, address: "Letohrad, ul. Hlavní", price_czk: 3_000_000, status: "sold", removed_at: "2026-10-01T06:00:00Z" }));
      updateListingFields(d, id, { verified_sale_price_czk: 2_850_000, verified_sale_date: "2026-10-05", sale_verdict: "sold" }); // 5 % pod inzerovanou
    }
    insertListing(d, listing("sreality:odhad", { disposition: "3+1", area_m2: 60, address: "Žamberk, ul. Tichá", price_czk: 4_000_000, status: "sold", removed_at: "2026-10-02T06:00:00Z" }));
  });
  const stats = tools.statistiky_cen.handler(calibrated, { typ: "prodane" });
  assert.equal(stats.slevaOdhadu.odvozenaZOverenychProdeju, true);
  assert.equal(stats.slevaOdhadu.slevaZPosledniCenyProcent, 5);
  assert.equal(stats.slevaOdhadu.pocetOverenychProdeju, 10);
  assert.equal(stats.slevaOdhadu.rozpetiSlevyProcent, "0–10 %");
  const rows = tools.prodane_byty.handler(calibrated, { od: "2026-09-01" }).byty;
  const estimated = rows.find((b) => b.id === "sreality:odhad");
  assert.equal(estimated.cenaProdejeKc, 3_800_000); // 4 000 000 − 5 %, ne − 10 %
  assert.match(estimated.cenaProdejeZaklad, /−5 %/);
});
