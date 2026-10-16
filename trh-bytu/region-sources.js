// Zdroje nabídek pro další regiony (viz region.js). Výchozí region čte portály
// přes ../sources/*.js, které jsou sdílené s hlídacím psem (GitHub Actions) a
// mají napevno okres Ústí nad Orlicí; ty se kvůli dalšímu regionu NEEDITUJÍ.
// Tady jsou jejich varianty, kterým se okres a obec předávají:
//
//  - Sreality a RealityMIX: vlastní čtení výpisu (okres je v URL napevno);
//  - iDNES, Bezrealitky, Bazoš: sdílené zdroje, které lokalitu berou z watch
//    (město / střed + poloměr / PSČ + poloměr), takže stačí obalit.
//
// Všude se výsledek na konec přefiltruje podle OBCE z adresy inzerátu: region
// chce "přímo tyto obce", ne okolí. Sreality vrací celý okres (stovky bytů z
// Broumova, Hronova…), poloměr u Bezrealitek / Bazoše je jen hrubý výřez.

import * as cheerio from "cheerio";
import { fetchText } from "../lib/http.js";
import { mergeUniqueById } from "../lib/merge.js";
import { parsePriceCzkFromText, withinPriceCap } from "../lib/price.js";
import { fetchBezrealitky } from "../sources/bezrealitky.js";
import { fetchIdnes } from "../sources/idnes.js";
import { fetchBazos } from "../sources/bazos.js";
import { fetchSrealityDetail } from "./detail/sreality.js";
import { fetchBezrealitkyDetail } from "./detail/bezrealitky.js";
import { fetchIdnesDetail } from "./detail/idnes.js";
import { fetchRealitymixDetail } from "./detail/realitymix.js";
import { fetchBazosDetail } from "./detail/bazos.js";
import { stripDiacritics } from "./geo-suggest.js";

// --- Obec z adresy ------------------------------------------------------

// Vzor obce nad textem bez diakritiky a malými písmeny — pokrývá i skloňování
// ("v Náchodě", "v Novém Městě nad Metují"). "Staré Město nad Metují" je část
// Náchoda a "Nové Město" nepotkává.
const MUNICIPALITY_PATTERNS = {
  "Náchod": /nachod/,
  "Nové Město nad Metují": /nov\w* mest\w* nad metuj/,
};

const norm = (text) => stripDiacritics(String(text ?? "")).replace(/\s+/g, " ");

/** Která z `municipalities` (názvy) se v textu vyskytuje, nebo null. */
export function municipalityIn(text, municipalities) {
  const t = norm(text);
  return municipalities.find((m) => (MUNICIPALITY_PATTERNS[m] ?? new RegExp(stripDiacritics(m).toLowerCase())).test(t)) ?? null;
}

// Další místa okresu a okolí. Bazoš nedává adresu, jen titulek — inzerát, co v
// titulku jmenuje JINÉ místo, do sekce nepatří (Bazoš ho do okruhu zařadil
// podle PSČ prodejce, které bývá hrubé).
const OTHER_PLACES = [
  "broumov", "hronov", "jaromer", "cerveny kostelec", "police nad metuji", "mezimesti", "teplice nad metuji",
  "ceska skalice", "velke porici", "slavonov", "machov", "studnice", "starkov", "dobrusk", "rychnov",
  "hradec kral", "trutnov", "upice", "vysokov", "adrspach", "rtyn", "zdar nad metuji", "bohuslavice",
  "nahorany", "jestrebi", "kramolna", "provodov", "hejtmankovice", "bezdekov", "nove mesto nad cerhou",
];

/** Titulek z Bazoše do regionu patří, když jmenuje jeho obec, nebo nejmenuje žádné jiné místo. */
export function bazosTitleInRegion(title, municipalities) {
  if (municipalityIn(title, municipalities)) return true;
  const t = norm(title);
  return !OTHER_PLACES.some((p) => t.includes(p));
}

// --- Sreality: celý okres, filtr podle obce --------------------------------

const PAGE_DELAY_MS = 400; // zdvořilost vůči portálu mezi stránkami
const MAX_PAGES = 20; // pojistka proti nekonečné smyčce

function extractNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) throw new Error("sreality: __NEXT_DATA__ nenalezen — struktura stránky se pravděpodobně změnila.");
  return JSON.parse(m[1]);
}

function buildSrealityDetailUrl(item) {
  const disposition = item.categorySubCb?.name || "";
  const loc = item.locality || {};
  const parts = [loc.citySeoName, loc.cityPartSeoName, loc.streetSeoName].filter(Boolean);
  const slug = parts.length ? parts.join("-") : "byt";
  return `https://www.sreality.cz/detail/prodej/byt/${encodeURIComponent(disposition)}/${slug}/${item.id}`;
}

function formatAddress(locality) {
  const cityPart = locality?.cityPart;
  const city = locality?.city;
  if (cityPart && cityPart !== city) return `${cityPart}, ${city}`;
  return city || "";
}

/** Jedna stránka výpisu Sreality → { items (jen z `municipalities`), pagination, resultCount }. */
export function parseSrealityPage(html, municipalities, priceMaxCzk = null) {
  const dehydrated = extractNextData(html)?.props?.pageProps?.dehydratedState;
  if (!dehydrated) throw new Error("sreality: dehydratedState chybí — struktura stránky se změnila.");
  const query = dehydrated.queries.find((q) => q.queryKey?.[0] === "estatesSearch");
  const results = query?.state?.data?.results || [];
  const pagination = query?.state?.data?.pagination || null;

  const items = [];
  for (const r of results) {
    // Obec přesně podle pole "město" (ne podle poloměru): "Náchod" včetně svých částí.
    const city = municipalities.find((m) => norm(m) === norm(r.locality?.city));
    if (!city) continue;
    if (!withinPriceCap(r.priceCzk, priceMaxCzk)) continue;
    items.push({
      source: "sreality",
      sourceLabel: "Sreality.cz",
      id: String(r.id),
      title: r.name || "Nabídka",
      price: r.priceCzk ? `${r.priceCzk.toLocaleString("cs-CZ")} Kč` : "Cena na vyžádání",
      priceCzk: r.priceCzk || null,
      address: formatAddress(r.locality),
      url: buildSrealityDetailUrl(r),
    });
  }
  return { items, pagination, resultCount: results.length };
}

/**
 * Výpis Sreality za celý okres přes všechny stránky (jako fetchSrealityAllPages
 * v ../sources/sreality.js — zmizení se odvozuje z výpisu, takže musí být
 * úplný). Cokoli podezřelého vyhodí chybu místo neúplného seznamu.
 */
export function srealityDistrictFetcher({ districtSlug, municipalities }) {
  return async (watch) => {
    const baseUrl = `https://www.sreality.cz/hledani/prodej/byty/${districtSlug}`;
    const perPage = [];
    let page = 1;
    let lastPage = 1;
    do {
      if (page > 1) await new Promise((resolve) => setTimeout(resolve, PAGE_DELAY_MS));
      const url = page === 1 ? baseUrl : `${baseUrl}?strana=${page}`;
      const { items, pagination, resultCount } = parseSrealityPage(await fetchText(url), municipalities, watch?.priceMaxCzk ?? null);
      if (resultCount === 0) throw new Error(`sreality: stránka ${page} výpisu je prázdná — výpis by byl neúplný.`);
      if (page === 1) {
        if (!pagination?.total || !pagination?.limit) throw new Error("sreality: ve výpisu chybí stránkování — struktura stránky se změnila.");
        lastPage = Math.min(Math.ceil(pagination.total / pagination.limit), MAX_PAGES);
      }
      perPage.push(items);
      page++;
    } while (page <= lastPage);
    return mergeUniqueById(perPage);
  };
}

// --- RealityMIX: kraj / okres / obec v URL --------------------------------

/** Karty výpisu RealityMIX → položky (stejné parsování jako ../sources/realitymix.js). */
export function parseRealitymixCards(html, priceMaxCzk = null) {
  const $ = cheerio.load(html);
  const seenIds = new Set();
  const items = [];
  $("li.advert-item").each((_, el) => {
    const $el = $(el);
    const href = $el.find('a[href*="/detail/"]').first().attr("href");
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
    const priceCzk = parsePriceCzkFromText(price);
    if (!withinPriceCap(priceCzk, priceMaxCzk)) return;

    items.push({ source: "realitymix", sourceLabel: "RealityMIX.cz", id, title, price, priceCzk, address, url: href, reserved: /Rezervováno/.test(text) });
  });
  return items;
}

export function realitymixFetcher({ krajSlug, okresSlug, citySlugs, municipalities }) {
  return async (watch) => {
    const perFetch = [];
    for (const citySlug of citySlugs) {
      const html = await fetchText(`https://realitymix.cz/reality/byty/prodej/${krajSlug}/${okresSlug}/${citySlug}`);
      perFetch.push(parseRealitymixCards(html, watch?.priceMaxCzk ?? null));
    }
    return filterByMunicipality(mergeUniqueById(perFetch), municipalities);
  };
}

// --- Sdílené zdroje s filtrem na obec ----------------------------------------

/** Nechá jen položky, jejichž adresa jmenuje jednu z obcí. */
export function filterByMunicipality(items, municipalities) {
  return items.filter((item) => municipalityIn(item.address, municipalities));
}

const withRadius = (watch, km) => ({ ...watch, locations: watch.locations.map((loc) => ({ ...loc, radiusKm: km })) });

/**
 * Zdroje nabídek regionu ve tvaru, který čeká track.js (`SOURCES`). Jen pro
 * regiony s vlastním watch (výchozí region si drží zdroje v track.js).
 */
export function regionSources(region) {
  const { municipalities } = region;
  return [
    {
      name: "sreality",
      fetchList: srealityDistrictFetcher({ districtSlug: "nachod", municipalities }),
      fetchDetail: fetchSrealityDetail,
      reservationFromDetail: true,
    },
    {
      name: "bezrealitky",
      fetchList: async (watch) => filterByMunicipality(await fetchBezrealitky(withRadius(watch, region.bezrealitkyRadiusKm)), municipalities),
      fetchDetail: fetchBezrealitkyDetail,
    },
    {
      name: "idnes",
      fetchList: async (watch) => filterByMunicipality(await fetchIdnes(watch), municipalities),
      fetchDetail: fetchIdnesDetail,
      soldFromDetail: true,
    },
    {
      name: "realitymix",
      fetchList: realitymixFetcher({ krajSlug: "kralovehradecky", okresSlug: "nachod", citySlugs: region.watch.locations.map((l) => l.citySlug), municipalities }),
      fetchDetail: fetchRealitymixDetail,
    },
    {
      name: "bazos",
      fetchList: async (watch) => (await fetchBazos(withRadius(watch, region.bazosRadiusKm))).filter((item) => bazosTitleInRegion(item.title, municipalities)),
      fetchDetail: fetchBazosDetail,
    },
  ];
}
