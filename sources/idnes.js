// Reality.iDNES.cz — klasicky server-rendered HTML (žádný embedded JSON),
// parsuje se přes CSS selektory (cheerio).
//
// Lokality (byty): pro každou nakonfigurovanou lokalitu je samostatná URL
// (jen na úrovni "město", bez GPS/radius — iDNES nenabízí radius filtr ani
// GPS souřadnice u jednotlivých inzerátů v seznamu, takže přesný 5km okruh
// tu nejde spočítat jako u Sreality/Bezrealitky).
//
// Pozemky: iDNES má samostatné URL pro "stavební pozemek" a "zahrady", a navíc
// (na rozdíl od byt-vyhledávání) diskrétní úrovně "okolí" přes `?s-rd=N`
// (1-5, čím víc, tím širší okruh — ale NENÍ to km, jen 5 pevných úrovní;
// nejblíž 20 km je úroveň 4, viz `idnesRadiusTier` v config.js). Použije se
// jen když je na lokalitě nastavená.

import * as cheerio from "cheerio";
import { fetchText } from "../lib/http.js";
import { parsePriceCzkFromText, withinPriceCap } from "../lib/price.js";
import { mergeUniqueById } from "../lib/merge.js";

function buildUrls(loc, watch) {
  const radiusParam = loc.idnesRadiusTier ? `?s-rd=${loc.idnesRadiusTier}` : "";
  if (watch.propertyType === "pozemek") {
    return [
      `https://reality.idnes.cz/s/prodej/pozemky/stavebni-pozemek/${loc.citySlug}/${radiusParam}`,
      `https://reality.idnes.cz/s/prodej/pozemky/zahrady/${loc.citySlug}/${radiusParam}`,
    ];
  }
  return [`https://reality.idnes.cz/s/prodej/byty/${loc.citySlug}/${radiusParam}`];
}

function parseListing(el, $) {
  const $el = $(el);
  const link = $el.find("a.c-products__link").first();
  const href = link.attr("href");
  if (!href) return null;

  const idMatch = href.match(/\/([0-9a-f]{24})\/?$/i);
  const id = idMatch ? idMatch[1] : href;

  const title = $el.find(".c-products__title").first().text().replace(/\s+/g, " ").trim();
  const address = $el.find(".c-products__info").first().text().replace(/\s+/g, " ").trim();
  const price = $el.find(".c-products__price").first().text().replace(/\s+/g, " ").trim();

  return { id, title, address, price: price || "Cena na vyžádání", url: href };
}

async function fetchOneUrl(url, watch) {
  const html = await fetchText(url);
  const $ = cheerio.load(html);

  const items = [];
  $(".c-products__inner").each((_, el) => {
    const parsed = parseListing(el, $);
    if (!parsed) return;
    const priceCzk = parsePriceCzkFromText(parsed.price);
    if (!withinPriceCap(priceCzk, watch.priceMaxCzk)) return;

    items.push({
      source: "idnes",
      sourceLabel: "Reality.iDNES.cz",
      id: parsed.id,
      title: parsed.title || "Nabídka",
      price: parsed.price,
      priceCzk,
      address: parsed.address,
      url: parsed.url,
    });
  });
  return items;
}

export async function fetchIdnes(watch) {
  const perLocation = [];
  for (const loc of watch.locations) {
    for (const url of buildUrls(loc, watch)) {
      perLocation.push(await fetchOneUrl(url, watch));
    }
  }
  return mergeUniqueById(perLocation);
}
