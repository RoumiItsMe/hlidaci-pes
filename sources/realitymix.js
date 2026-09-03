// RealityMIX.cz — server-rendered HTML, parsuje se přes CSS selektory.
//
// Lokality (byty): URL má tvar /reality/byty/prodej/{kraj}/{okres}/{město}.
// Kraj (pardubicky) i okres (usti-nad-orlici) jsou pro všechny nakonfigurované
// lokality společné — všechny leží ve stejném okrese — mění se jen poslední
// segment (citySlug). Stejně jako u iDNES nejsou k dispozici GPS souřadnice
// jednotlivých inzerátů, takže se bere jen město (bez přesného 5km okruhu).
//
// Pozemky: RealityMIX má samostatné URL pro "pro bydlení" a "zahrady", ale
// (na rozdíl od iDNES) nemá žádnou "okolí"/radius úroveň — nejde tedy
// aproximovat okruh 20 km jinak než výčtem měst. Pro lokalitu, která má
// `extraCitySlugs` (viz config.js), se proto fetchuje samotné město PLUS
// každé z nich zvlášť — to pokryje hlavní obce v okolí, ne úplně každou
// vesnici v okruhu.
//
// Titulek/cena/adresa se parsují heuristicky z textu karty (přesné CSS
// třídy pro cenu/adresu portál nepojmenovává jednoznačně) — pokud se
// nepodaří vytáhnout, inzerát se přesto nahlásí (jen s obecnějším popiskem),
// protože ID + odkaz stačí k tomu, aby uživatel nabídku otevřel a posoudil sám.

import * as cheerio from "cheerio";
import { fetchText } from "../lib/http.js";
import { parsePriceCzkFromText, withinPriceCap } from "../lib/price.js";
import { mergeUniqueById } from "../lib/merge.js";

const KRAJ_SLUG = "pardubicky";
const OKRES_SLUG = "usti-nad-orlici";

function buildUrlsForCity(citySlug, watch) {
  if (watch.propertyType === "pozemek") {
    return [
      `https://realitymix.cz/reality/pozemky/pro-bydleni/prodej/${KRAJ_SLUG}/${OKRES_SLUG}/${citySlug}`,
      `https://realitymix.cz/reality/pozemky/zahrady/prodej/${KRAJ_SLUG}/${OKRES_SLUG}/${citySlug}`,
    ];
  }
  return [`https://realitymix.cz/reality/byty/prodej/${KRAJ_SLUG}/${OKRES_SLUG}/${citySlug}`];
}

async function fetchForUrl(url, watch) {
  const html = await fetchText(url);
  const $ = cheerio.load(html);

  const seenIds = new Set();
  const items = [];

  $("li.advert-item").each((_, el) => {
    const $el = $(el);
    const link = $el.find('a[href*="/detail/"]').first();
    const href = link.attr("href");
    if (!href) return;

    const idMatch = href.match(/-(\d+)\.html$/);
    if (!idMatch) return;
    const id = idMatch[1];
    if (seenIds.has(id)) return;
    seenIds.add(id);

    const title = $el.find("img[alt]").first().attr("alt")?.trim() || "Nabídka";
    const text = $el.text().replace(/\s+/g, " ").trim();

    let address = "";
    const titleIdx = text.indexOf(title);
    if (titleIdx !== -1) {
      const rest = text.slice(titleIdx + title.length);
      const stopMatch = rest.match(/\d[\d\s]{3,}\d\s?Kč|Rezervováno|Nabídněte cenu|Cena na vyžádání/);
      address = (stopMatch ? rest.slice(0, stopMatch.index) : rest.slice(0, 80)).trim();
    }

    const priceMatch = text.match(/(\d[\d\s]{3,}\d)\s?Kč/);
    const price = priceMatch ? `${priceMatch[1].replace(/\s+/g, " ").trim()} Kč` : "Cena na vyžádání";
    if (!withinPriceCap(parsePriceCzkFromText(price), watch.priceMaxCzk)) return;

    items.push({
      source: "realitymix",
      sourceLabel: "RealityMIX.cz",
      id,
      title,
      price,
      address,
      url: href,
    });
  });
  return items;
}

export async function fetchRealitymix(watch) {
  const perFetch = [];
  for (const loc of watch.locations) {
    const citySlugs = [loc.citySlug, ...(loc.extraCitySlugs || [])];
    for (const citySlug of citySlugs) {
      for (const url of buildUrlsForCity(citySlug, watch)) {
        perFetch.push(await fetchForUrl(url, watch));
      }
    }
  }
  return mergeUniqueById(perFetch);
}
