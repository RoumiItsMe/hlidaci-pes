// node --test trh-bytu/address-suggest.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { regionWindows, regionWindow, buildEntries, parseQuery, matchEntries, parseRuianAddress, suggestAddresses, loadIndex, MAX_ITEMS } from "./address-suggest.js";

const WATCH = {
  locations: [
    { label: "Ústí nad Orlicí", centerLat: 49.9739, centerLng: 16.3957, radiusKm: 5 },
    { label: "Žamberk", centerLat: 50.0735, centerLng: 16.4664, radiusKm: 5 },
  ],
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "address-suggest-"));

// --- Falešná RÚIAN: vrstvy názvů + adresní místa (LIKE 'x%' a obec bez ulic) ---
const STREETS = [
  { nazev: "Truby", ulice: "Truby, Česká Třebová", obec: 1 },
  { nazev: "Truhlářská", ulice: "Truhlářská, Ústí nad Orlicí", obec: 2 },
  { nazev: "Nádražní", ulice: "Nádražní, Žamberk", obec: 3 },
  { nazev: "Nádražní", ulice: "Nádražní, Ústí nad Orlicí", obec: 2 },
  { nazev: "Šmilovského", ulice: "Šmilovského, Ústí nad Orlicí", obec: 2 },
  { nazev: "Stará", ulice: "Stará, Ústí nad Orlicí", obec: 2, nespravny: true }, // neplatná se vynechá
];
const PARTS = [
  { nazev: "Knapovec", obec: 2 },
  { nazev: "Ústí nad Orlicí", obec: 2 }, // část obce stejného jména jako obec = obec sama
];
const TOWNS = [
  { kod: 1, nazev: "Česká Třebová" },
  { kod: 2, nazev: "Ústí nad Orlicí" },
  { kod: 3, nazev: "Žamberk" },
  { kod: 4, nazev: "Dolní Dobrouč" },
];
const ADDRESSES = [
  ...[1737, 1734, 2201, 1735, 99].map((n) => `Truby ${n}, 56002 Česká Třebová`),
  "Nádražní 11, 56401 Žamberk",
  "Nádražní 114, 56401 Žamberk",
  "Nádražní 2, 56401 Žamberk",
  "Nádražní 12, 56201 Ústí nad Orlicí",
  "Nádražní 12, 50301 Cizí město", // mimo rejstřík obcí → nenabídne se
  "Šmilovského 5/7, 56201 Ústí nad Orlicí",
  "Knapovec 1, 56201 Ústí nad Orlicí",
  "Knapovec 10, 56201 Ústí nad Orlicí",
  "č.p. 181, 56102 Dolní Dobrouč",
  "č.p. 18, 56102 Dolní Dobrouč",
  "č.p. 181, 51721 Lípa nad Orlicí", // jiná obec téhož č.p.
  "Truby č.ev. 38, 56002 Česká Třebová", // evidenční číslo se nenabízí
  ...Array.from({ length: 40 }, (_, i) => `Dlouhá ${i + 1}, 56002 Česká Třebová`),
];
STREETS.push({ nazev: "Dlouhá", ulice: "Dlouhá, Česká Třebová", obec: 1 });

function fakeRuian() {
  const calls = [];
  const fn = async (layer, params) => {
    calls.push({ layer, where: params.where });
    if (layer === 4) return STREETS;
    if (layer === 11) return PARTS;
    if (layer === 12) return TOWNS;
    // adresní místa: `adresa LIKE 'X%'` (+ volitelně `AND adresa LIKE '%, _____ Obec'`)
    const m = params.where.match(/^adresa LIKE '(.*)%'(?: AND adresa LIKE '%, _____ (.*)')?$/);
    assert.ok(m, `neočekávaný dotaz: ${params.where}`);
    const prefix = m[1].replace(/''/g, "'");
    return ADDRESSES.filter((a) => a.startsWith(prefix) && (!m[2] || a.endsWith(` ${m[2]}`))).map((adresa) => ({ adresa }));
  };
  fn.calls = calls;
  return fn;
}
const run = (text, extra = {}) => {
  const queryFn = extra.queryFn ?? fakeRuian();
  return suggestAddresses(text, { watch: WATCH, file: extra.file ?? path.join(tmp(), "idx.json"), queryFn, now: extra.now ?? Date.now(), ...extra }).then((r) => ({ ...r, queryFn }));
};

test("okna: jedno na lokalitu (střed ± okruh + okraj), společné jen obalí všechna", () => {
  const w = regionWindows(WATCH);
  assert.equal(w.length, 2);
  const [minLon, minLat, maxLon, maxLat] = w[0].split(",").map(Number);
  assert.ok(minLon < 16.3957 && maxLon > 16.3957 && minLat < 49.9739 && maxLat > 49.9739);
  assert.ok(Math.abs((maxLat - minLat) * 111.2 - 14) < 0.1); // 2 × (5 + 2 km)
  const union = regionWindow(WATCH).split(",").map(Number);
  assert.equal(union[1], Math.min(...w.map((x) => Number(x.split(",")[1]))));
  assert.equal(union[3], Math.max(...w.map((x) => Number(x.split(",")[3]))));
  assert.deepEqual(regionWindows({ locations: [{ label: "x" }] }), []); // bez souřadnic nic
});

test("rejstřík: ulice (obec z pole ulice), části obce (ne se jménem obce), obce; neplatné se vynechají", () => {
  const entries = buildEntries({ streets: STREETS, parts: PARTS, towns: TOWNS });
  const has = (name, city, kind) => entries.some((e) => e.name === name && e.city === city && e.kind === kind);
  assert.ok(has("Truby", "Česká Třebová", "street"));
  assert.ok(has("Nádražní", "Žamberk", "street") && has("Nádražní", "Ústí nad Orlicí", "street"));
  assert.ok(has("Knapovec", "Ústí nad Orlicí", "part"));
  assert.ok(!has("Ústí nad Orlicí", "Ústí nad Orlicí", "part")); // jen jako obec
  assert.ok(has("Ústí nad Orlicí", "Ústí nad Orlicí", "town"));
  assert.ok(!entries.some((e) => e.name === "Stará"));
});

test("psaný text: číslo je jen poslední samostatné slovo, '17. listopadu' je název", () => {
  assert.deepEqual(parseQuery("Truby 17"), { name: "Truby", number: "17", city: null });
  assert.deepEqual(parseQuery("truby"), { name: "truby", number: null, city: null });
  assert.deepEqual(parseQuery("Truby 17/3a, Česká"), { name: "Truby", number: "17/3a", city: "Česká" });
  assert.deepEqual(parseQuery("17. listopadu 12"), { name: "17. listopadu", number: "12", city: null });
  assert.deepEqual(parseQuery("17"), { name: "17", number: null, city: null });
  assert.deepEqual(parseQuery("Na Pláni  5 "), { name: "Na Pláni", number: "5", city: null });
});

test("shoda názvu je bez diakritiky a velikosti písmen; přesná shoda před začátkem před začátkem slova", () => {
  const entries = buildEntries({ streets: STREETS, parts: PARTS, towns: TOWNS }).map((e) => ({ ...e, key: e.name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase() }));
  assert.deepEqual(matchEntries(entries, "smilov").map((e) => e.name), ["Šmilovského"]);
  assert.deepEqual(matchEntries(entries, "TRUHLARSKA").map((e) => [e.name, e.rank]), [["Truhlářská", 0]]);
  assert.equal(matchEntries(entries, "t").length, 0); // příliš krátké
  assert.deepEqual(matchEntries(entries, "nadrazni", "zamberk").map((e) => e.city), ["Žamberk"]); // město za čárkou
  assert.ok(matchEntries(entries, "orlici").some((e) => e.rank === 2)); // začátek slova uvnitř názvu
});

test("adresa z RÚIAN: ulice, část obce, č.p. bez ulice; evidenční čísla se zahodí", () => {
  assert.deepEqual(parseRuianAddress("Truby 1737, 56002 Česká Třebová"), { street: "Truby", number: "1737", part: null, city: "Česká Třebová" });
  assert.deepEqual(parseRuianAddress("Česká 318, Ostrovské Předměstí, 56301 Lanškroun"), { street: "Česká", number: "318", part: "Ostrovské Předměstí", city: "Lanškroun" });
  assert.deepEqual(parseRuianAddress("17. listopadu 5/7, 56201 Ústí nad Orlicí"), { street: "17. listopadu", number: "5/7", part: null, city: "Ústí nad Orlicí" });
  assert.deepEqual(parseRuianAddress("č.p. 181, 51721 Lípa nad Orlicí"), { street: "Lípa nad Orlicí", number: "181", part: null, city: "Lípa nad Orlicí" });
  assert.equal(parseRuianAddress("Českoskalická č.ev. 38, 54701 Náchod"), null);
  assert.equal(parseRuianAddress("č.ev. 38, 54701 Náchod"), null);
  assert.equal(parseRuianAddress("nesmysl"), null);
});

test("nejasný začátek: nabídne se výběr názvu (ulice, část obce, obec), ne čísla", async () => {
  const r = await run("tru");
  // Obec, kterou sekce sleduje jako první (Ústí), je v nabídce nahoře.
  assert.deepEqual(r.items.map((i) => [i.kind, i.value, i.detail]), [
    ["name", "Truhlářská ", "Ústí nad Orlicí"],
    ["name", "Truby ", "Česká Třebová"],
  ]);
  assert.equal(r.queryFn.calls.filter((c) => c.layer === 1).length, 0); // čísla se zatím nedotahují
});

test("jednoznačný název (přesná shoda): rovnou čísla popisná, řazená číselně, s obcí", async () => {
  const r = await run("truby");
  assert.deepEqual(r.items.map((i) => i.value), ["Truby 99, Česká Třebová", "Truby 1734, Česká Třebová", "Truby 1735, Česká Třebová", "Truby 1737, Česká Třebová", "Truby 2201, Česká Třebová"]);
  assert.ok(r.items.every((i) => i.kind === "address"));
  assert.equal(r.more, 0);
});

test("bez diakritiky najde ulici s diakritikou a vrátí ji správně napsanou, včetně čísla s lomítkem", async () => {
  const r = await run("smilovskeho");
  assert.deepEqual(r.items.map((i) => i.value), ["Šmilovského 5/7, Ústí nad Orlicí"]);
});

test("napsané číslo zúží dotaz na tu předponu", async () => {
  const r = await run("Truby 17");
  assert.deepEqual(r.items.map((i) => i.label), ["Truby 1734", "Truby 1735", "Truby 1737"]);
  const where = r.queryFn.calls.find((c) => c.layer === 1).where;
  assert.equal(where, "adresa LIKE 'Truby 17%'");
});

test("nejasný název, ale číslo už je napsané: čísla se nabídnou rovnou (z nejvýš tří kandidátů)", async () => {
  const r = await run("tru 17");
  assert.deepEqual(r.items.map((i) => i.value), ["Truby 1734, Česká Třebová", "Truby 1735, Česká Třebová", "Truby 1737, Česká Třebová"]);
  assert.ok(r.items.every((i) => i.kind === "address"));
});

test("stejná ulice ve dvou obcích: čísla z obou, nejdřív obec, kterou sekce sleduje první; cizí obec mimo rejstřík se nenabídne", async () => {
  const r = await run("nadrazni");
  assert.deepEqual(r.items.map((i) => i.value), ["Nádražní 12, Ústí nad Orlicí", "Nádražní 2, Žamberk", "Nádražní 11, Žamberk", "Nádražní 114, Žamberk"]);
});

test("město za čárkou zúží nabídku", async () => {
  const r = await run("nadrazni, zamb");
  assert.deepEqual(r.items.map((i) => i.detail), ["Žamberk", "Žamberk", "Žamberk"]);
});

test("část obce a obec bez ulic: Knapovec 1, č.p. v obci (jen jeho obec, ne jiná se stejným číslem)", async () => {
  assert.deepEqual((await run("knapovec")).items.map((i) => i.value), ["Knapovec 1, Ústí nad Orlicí", "Knapovec 10, Ústí nad Orlicí"]);
  const v = await run("dolni dobrouc 18");
  assert.deepEqual(v.items.map((i) => i.value), ["Dolní Dobrouč 18, Dolní Dobrouč", "Dolní Dobrouč 181, Dolní Dobrouč"]);
});

test("příliš mnoho čísel se ořízne na MAX_ITEMS a řekne se, kolik jich zbývá", async () => {
  const r = await run("dlouha");
  assert.equal(r.items.length, MAX_ITEMS);
  assert.equal(r.more, 30);
  assert.equal(r.items[0].label, "Dlouhá 1");
  assert.equal(r.items[9].label, "Dlouhá 10"); // číselně, ne po textu
});

test("sekce s vlastními obcemi nenabízí sousední města", async () => {
  const r = await run("nadrazni", { municipalities: ["Žamberk"] });
  assert.deepEqual(r.items.map((i) => i.detail), ["Žamberk", "Žamberk", "Žamberk"]);
  assert.deepEqual((await run("truby", { municipalities: ["Žamberk"] })).items, []);
});

test("apostrof v názvu se v dotazu zdvojí (žádné rozbité SQL)", async () => {
  const queryFn = async (layer) => (layer === 4 ? [{ nazev: "D'Orsay", ulice: "D'Orsay, Žamberk", obec: 3 }] : layer === 1 ? [] : []);
  const seen = [];
  await suggestAddresses("d'orsay", { watch: WATCH, file: path.join(tmp(), "i.json"), queryFn: async (l, p) => (seen.push(p.where), queryFn(l, p)), now: Date.now() });
  assert.ok(seen.includes("adresa LIKE 'D''Orsay %'"));
});

test("krátký nebo prázdný text nic nenabízí a RÚIAN se nevolá", async () => {
  for (const t of ["", " ", "a", "1"]) {
    const r = await run(t);
    assert.deepEqual(r.items, []);
    assert.equal(r.queryFn.calls.length, 0);
  }
});

test("rejstřík se stáhne jednou (dvě lokality × ulice, části, obce), uloží do souboru a další hledání ho znovu nestahuje", async () => {
  const file = path.join(tmp(), "idx.json");
  const queryFn = fakeRuian();
  const nameCalls = () => queryFn.calls.filter((c) => c.layer !== 1).length;
  await suggestAddresses("truby", { watch: WATCH, file, queryFn, now: Date.now() });
  assert.equal(nameCalls(), 2 * 3);
  assert.ok(JSON.parse(fs.readFileSync(file, "utf8")).entries.length > 0);
  await suggestAddresses("nadrazni", { watch: WATCH, file, queryFn, now: Date.now() });
  assert.equal(nameCalls(), 2 * 3);
});

test("starý rejstřík (po 30 dnech) nebo rejstřík pro jiné okolí se obnoví; poškozený soubor taky", async () => {
  const dir = tmp();
  const file = path.join(dir, "idx.json");
  const t0 = Date.parse("2026-10-01T10:00:00Z");
  await loadIndex({ file, watch: WATCH, queryFn: fakeRuian(), now: t0 });
  // čerstvý — soubor stačí (jiný soubor v paměti, aby se nepoužila paměť)
  const copy = path.join(dir, "copy.json");
  fs.copyFileSync(file, copy);
  const fresh = fakeRuian();
  await loadIndex({ file: copy, watch: WATCH, queryFn: fresh, now: t0 + 5 * 86400_000 });
  assert.equal(fresh.calls.length, 0);
  // stará kopie
  const old = path.join(dir, "old.json");
  fs.copyFileSync(file, old);
  const rebuilt = fakeRuian();
  await loadIndex({ file: old, watch: WATCH, queryFn: rebuilt, now: t0 + 31 * 86400_000 });
  assert.ok(rebuilt.calls.length > 0);
  // jiné okolí
  const other = path.join(dir, "other.json");
  fs.copyFileSync(file, other);
  const moved = fakeRuian();
  await loadIndex({ file: other, watch: { locations: [{ label: "X", centerLat: 50.4, centerLng: 16.1, radiusKm: 4 }] }, queryFn: moved, now: t0 + 86400_000 });
  assert.ok(moved.calls.length > 0);
  // poškozený soubor
  const broken = path.join(dir, "broken.json");
  fs.writeFileSync(broken, "{ rozbité");
  const again = fakeRuian();
  await loadIndex({ file: broken, watch: WATCH, queryFn: again, now: t0 });
  assert.ok(again.calls.length > 0);
});

test("selhání RÚIAN při stavbě rejstříku se předá a nezapamatuje — další pokus to zkusí znovu", async () => {
  const file = path.join(tmp(), "idx.json");
  await assert.rejects(loadIndex({ file, watch: WATCH, queryFn: async () => { throw new Error("RÚIAN HTTP 503"); } }), /503/);
  const ok = fakeRuian();
  const idx = await loadIndex({ file, watch: WATCH, queryFn: ok });
  assert.ok(idx.length > 0);
});
