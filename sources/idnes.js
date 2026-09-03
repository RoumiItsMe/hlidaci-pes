// Reality.iDNES.cz — klasicky server-rendered HTML (žádný embedded JSON),
// parsuje se přes CSS selektory (cheerio).
//
// Lokality: pro každou nakonfigurovanou lokalitu je samostatná URL (jen na
// úrovni "město", bez GPS/radius — iDNES nenabízí radius filtr ani GPS
// souřadnice u jednotlivých inzerátů v seznamu, takže přesný 5km okruh tu
// nejde spočítat jako u Sreality/Bezrealitky). Výsledky se sloučí a
// odduplikují.

import * as cheerio from "cheerio";
import { fetchText } from "../lib/http.js";
import { mergeUniqueById } from "../lib/merge.js";

async function fetchForLocation(loc) {
  const url = `https://reality.idnes.cz/s/prodej/byty/${loc.citySlug}/`;
  const html = await fetchText(url);
  const $ = cheerio.load(html);

  const items = [];
  $(".c-products__inner").each((_, el) => {
    const $el = $(el);
    const link = $el.find("a.c-products__link").first();
    const href = link.attr("href");
    if (!href) return;

    const idMatch = href.match(/\/([0-9a-f]{24})\/?$/i);
    const id = idMatch ? idMatch[1] : href;

    const title = $el.find(".c-products__title").first().text().replace(/\s+/g, " ").trim();
    const address = $el.find(".c-products__info").first().text().replace(/\s+/g, " ").trim();
    const price = $el.find(".c-products__price").first().text().replace(/\s+/g, " ").trim();

    items.push({
      source: "idnes",
      sourceLabel: "Reality.iDNES.cz",
      id,
      title: title || "Byt na prodej",
      price: price || "Cena na vyžádání",
      address,
      url: href,
    });
  });
  return items;
}

export async function fetchIdnes(config) {
  const perLocation = [];
  for (const loc of config.locations) {
    perLocation.push(await fetchForLocation(loc));
  }
  return mergeUniqueById(perLocation);
}
