// node --test trh-bytu/region-sources.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { municipalityIn, bazosTitleInRegion, filterByMunicipality, parseSrealityPage, parseRealitymixCards, srealityDistrictFetcher } from "./region-sources.js";

const MUNI = ["Náchod", "Nové Město nad Metují"];

test("obec z adresy: i skloňovaná a s částí obce; Staré Město nad Metují je Náchod, ne Nové Město", () => {
  assert.equal(municipalityIn("Pražská, Náchod", MUNI), "Náchod");
  assert.equal(municipalityIn("Růžová, Náchod - Staré Město nad Metují", MUNI), "Náchod");
  assert.equal(municipalityIn("Byt v Náchodě", MUNI), "Náchod");
  assert.equal(municipalityIn("Malecí, Nové Město nad Metují", MUNI), "Nové Město nad Metují");
  assert.equal(municipalityIn("Byt v Novém Městě nad Metují", MUNI), "Nové Město nad Metují");
  assert.equal(municipalityIn("Staré Město nad Metují", MUNI), null);
  assert.equal(municipalityIn("Broumov", MUNI), null);
  assert.equal(municipalityIn("", MUNI), null);
});

test("filtr podle obce nechá jen nabídky z regionu (nabídky bez adresy ne)", () => {
  const items = [{ id: 1, address: "Husova, Náchod" }, { id: 2, address: "Hronov" }, { id: 3, address: "" }, { id: 4, address: "Sadová, Nové Město nad Metují" }];
  assert.deepEqual(filterByMunicipality(items, MUNI).map((i) => i.id), [1, 4]);
});

test("Bazoš: titulek jmenující jiné místo okresu se vyřadí, bez místa nebo se správnou obcí zůstane", () => {
  assert.equal(bazosTitleInRegion("Prodej bytu 4+1 66 m2 Pražská, Náchod", MUNI), true);
  assert.equal(bazosTitleInRegion("Prodej bytu 2+kk s balkonem, Nové Město nad Metují, Březinky", MUNI), true);
  assert.equal(bazosTitleInRegion("Prodám byt 2+1 na investici", MUNI), true);
  assert.equal(bazosTitleInRegion("Prodej bytu 2+1, 50 m² - Meziměstí", MUNI), false);
  assert.equal(bazosTitleInRegion("Byt Hronov u Náchoda", MUNI), true); // jmenuje obec regionu (rozhoduje portál)
  assert.equal(bazosTitleInRegion("Byt v Jaroměři", MUNI), false);
});

function srealityHtml(results, pagination = { total: results.length, limit: 22 }) {
  const data = { props: { pageProps: { dehydratedState: { queries: [{ queryKey: ["estatesSearch"], state: { data: { results, pagination } } }] } } } };
  return `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></html>`;
}
const flat = (id, city, over = {}) => ({ id, name: `Prodej bytu 2+1 ${id}`, priceCzk: 3_000_000 + id, categorySubCb: { name: "2+1" }, locality: { city, cityPart: city, citySeoName: "nachod" }, ...over });

test("Sreality: z výpisu celého okresu zůstanou jen byty z Náchoda a Nového Města (podle pole 'město')", () => {
  const html = srealityHtml([flat(1, "Náchod"), flat(2, "Hronov"), flat(3, "Nové Město nad Metují"), flat(4, "Broumov"), flat(5, "Náchod", { locality: { city: "Náchod", cityPart: "Běloves" } })]);
  const { items, resultCount, pagination } = parseSrealityPage(html, MUNI);
  assert.deepEqual(items.map((i) => i.id), ["1", "3", "5"]);
  assert.equal(resultCount, 5);
  assert.equal(pagination.total, 5);
  assert.equal(items[2].address, "Běloves, Náchod");
  assert.match(items[0].url, /^https:\/\/www\.sreality\.cz\/detail\/prodej\/byt\/2%2B1\/nachod\/1$/);
  assert.equal(items[0].source, "sreality");
});

test("Sreality: chybějící struktura stránky je chyba, ne prázdný výpis", () => {
  assert.throws(() => parseSrealityPage("<html></html>", MUNI), /__NEXT_DATA__/);
});

test("Sreality: výpis okresu se čte přes všechny stránky, ať zmizení nevznikne z neúplného seznamu", async () => {
  const pages = {
    "https://www.sreality.cz/hledani/prodej/byty/nachod": srealityHtml([flat(1, "Náchod"), flat(2, "Hronov")], { total: 3, limit: 2 }),
    "https://www.sreality.cz/hledani/prodej/byty/nachod?strana=2": srealityHtml([flat(3, "Nové Město nad Metují")], { total: 3, limit: 2 }),
  };
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return new Response(pages[String(url)] ?? "", { status: pages[String(url)] ? 200 : 404 });
  };
  try {
    const items = await srealityDistrictFetcher({ districtSlug: "nachod", municipalities: MUNI })({ priceMaxCzk: null });
    assert.deepEqual(items.map((i) => i.id).sort(), ["1", "3"]);
    assert.equal(seen.length, 2);
  } finally {
    globalThis.fetch = original;
  }
});

test("RealityMIX: karty výpisu se rozpoznají (id, cena, adresa, rezervace)", () => {
  const card = (id, title, text) => `<li class="advert-item"><a href="https://realitymix.cz/detail/x-${id}.html"><img alt="${title}"></a><span>${title} ${text}</span></li>`;
  const html = `<ul>${card(111, "Prodej bytu, 3+1, 68 m²", "Kostelecká, Náchod 3 750 000 Kč Nabídněte cenu")}${card(222, "Prodej bytu, 2+1, 40 m²", "Na Václaváku, Běloves, Náchod Cena na vyžádání Rezervováno")}</ul>`;
  const items = parseRealitymixCards(html);
  assert.deepEqual(items.map((i) => i.id), ["111", "222"]);
  assert.equal(items[0].priceCzk, 3_750_000);
  assert.match(items[0].address, /Kostelecká, Náchod/);
  assert.equal(items[1].reserved, true);
  assert.equal(items[1].priceCzk, null);
});
