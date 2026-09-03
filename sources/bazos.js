// Bazoš.cz (reality.bazos.cz) — má nativní RSS feed přesně pro tenhle účel,
// včetně parametrů pro adresu + okruh v km i cenu. Nejjednodušší a
// nejstabilnější ze všech pěti zdrojů.
//
// Byty: cat=65 = kategorie "Byty" v rubrice "Prodej" (Reality), typ=1 = Prodej,
// hlokalita = PSČ bez mezery, humkreis = okruh v km. `hlokalita` MUSÍ být
// platné PSČ (ne text) — Bazoš bez rozpoznaného PSČ tiše ignoruje lokalitní
// filtr a vrátí nabídku z celé ČR (ověřeno).
//
// Pozemky: cat=71 ("Pozemky") je široký koš — mísí stavební parcely se
// zemědělskou půdou, lesy i loukami — Bazoš nemá jemnější rozdělení jako
// ostatní portály. Proto se navíc filtruje podle klíčových slov v titulku
// ("bydlení"/"stavební"). cat=72 ("Zahrady") je už čistě zahrady, ty se
// berou beze změny. Cenový strop (`cenado`) podporuje přímo v URL, takže
// ho posíláme rovnou (méně dat k přenosu) — ale filtrujeme i klientsky
// (`withinPriceCap`) jako pojistku, kdyby se to na straně portálu chovalo
// jinak, než čekáme.
//
// Lokality: pro každou nakonfigurovanou lokalitu samostatný RSS dotaz
// (Bazoš neumí víc středů/okruhů v jednom požadavku), výsledky se sloučí
// a odduplikují.

import * as cheerio from "cheerio";
import { fetchText } from "../lib/http.js";
import { parsePriceCzkFromText, withinPriceCap } from "../lib/price.js";
import { mergeUniqueById } from "../lib/merge.js";

// U pozemků (cat=71) musí titulek obsahovat aspoň jedno z těchto slov, ať
// nevypadnou stavební/rezidenční parcely z hromady polí, lesů a luk.
const LAND_KEYWORD_RE = /bydlen|stavebn/i;

// Podílové spoluvlastnictví (např. "Podíl 50 % o výměře ...") se u obou
// pozemkových kategorií (71 i 72) vyřazuje vždy — na cizím pozemku glamping
// nepostavíš, potřeba je celý pozemek ve výhradním vlastnictví.
const CO_OWNERSHIP_RE = /pod[íi]l/i;

function buildRssUrl(loc, watch, category) {
  const params = new URLSearchParams({
    rub: "re",
    cat: String(category.cat),
    typ: "1",
    hlokalita: loc.zip,
    humkreis: String(loc.radiusKm),
  });
  if (watch.priceMaxCzk != null) params.set("cenado", String(watch.priceMaxCzk));
  return `https://www.bazos.cz/rss.php?${params.toString()}`;
}

function categoriesFor(watch) {
  if (watch.propertyType === "pozemek") {
    return [
      { cat: 71, requireKeyword: true }, // Pozemky (obecné) — jen bydlení/stavební
      { cat: 72, requireKeyword: false }, // Zahrady
    ];
  }
  return [{ cat: 65, requireKeyword: false }]; // Byty
}

async function fetchForLocationAndCategory(loc, watch, category) {
  const xml = await fetchText(buildRssUrl(loc, watch, category));
  const $ = cheerio.load(xml, { xmlMode: true });

  const items = [];
  $("item").each((_, el) => {
    const $el = $(el);
    const link = $el.find("link").first().text().trim();
    const rawTitle = $el.find("title").first().text().trim();

    const idMatch = link.match(/\/inzerat\/(\d+)\//);
    if (!idMatch) return;
    const id = idMatch[1];

    // Titulek bývá ve tvaru "Název inzerátu: 4 160 000" (cena bez "Kč" na konci).
    const splitMatch = rawTitle.match(/^(.*):\s*([\d\s]+)$/);
    const title = splitMatch ? splitMatch[1].trim() : rawTitle;
    const price = splitMatch ? `${splitMatch[2].replace(/\s+/g, " ").trim()} Kč` : "Cena na vyžádání";

    if (category.requireKeyword && !LAND_KEYWORD_RE.test(title)) return;
    if (watch.propertyType === "pozemek" && CO_OWNERSHIP_RE.test(title)) return;
    if (!withinPriceCap(parsePriceCzkFromText(price), watch.priceMaxCzk)) return;

    items.push({
      source: "bazos",
      sourceLabel: "Bazoš.cz",
      id,
      title: title || "Nabídka",
      price,
      address: "",
      url: link,
    });
  });
  return items;
}

export async function fetchBazos(watch) {
  const categories = categoriesFor(watch);
  const perFetch = [];
  for (const loc of watch.locations) {
    for (const category of categories) {
      perFetch.push(await fetchForLocationAndCategory(loc, watch, category));
    }
  }
  return mergeUniqueById(perFetch);
}
