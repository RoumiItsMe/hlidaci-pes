// Sreality.cz — data se čtou přímo z embedded JSON (__NEXT_DATA__), který
// stránka posílá server-side rendered. Žádné volání API navíc není potřeba.
//
// Lokality: fetchujeme jedním (nebo pro pozemky dvěma — viz níže) dotazem
// za celý okres Ústí nad Orlicí (ten pokrývá VŠECHNY nakonfigurované
// lokality napříč všemi sledováními, protože všechny leží ve stejném
// okrese), a pak každý inzerát otestujeme, jestli spadá do okruhu ALESPOŇ
// JEDNÉ z nakonfigurovaných lokalit (přes GPS souřadnice). Sreality neumí
// "adresa + poloměr" hledání přes URL/parametry, ale ke každému inzerátu
// vrací lat/lng, takže si radius dopočítáme sami — a díky jednomu
// společnému fetchi za celý okres nepotřebujeme samostatný dotaz na
// lokalitu (na rozdíl od Bezrealitky/iDNES/RealityMIX/Bazoše).
//
// Pozemky: Sreality nemá kategorii "rekreační pozemek", ale má vlastní URL
// pro "Bydlení" (stavební parcely, slug "stavebni-parcely") a "Zahrady"
// (slug "zahrady") — přesně to, co chceme. Fetchují se zvlášť a slučují.

import { haversineKm } from "../lib/geo.js";
import { fetchText } from "../lib/http.js";
import { withinPriceCap } from "../lib/price.js";
import { mergeUniqueById } from "../lib/merge.js";

const DISTRICT_SLUG = "usti-nad-orlici";

function buildSearchUrls(watch) {
  if (watch.propertyType === "pozemek") {
    return [
      `https://www.sreality.cz/hledani/prodej/pozemky/stavebni-parcely/${DISTRICT_SLUG}`,
      `https://www.sreality.cz/hledani/prodej/pozemky/zahrady/${DISTRICT_SLUG}`,
    ];
  }
  return [`https://www.sreality.cz/hledani/prodej/byty/${DISTRICT_SLUG}`];
}

function extractNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) {
    throw new Error(
      "sreality: __NEXT_DATA__ nenalezen — struktura stránky se pravděpodobně změnila."
    );
  }
  return JSON.parse(m[1]);
}

// Detail URL u pozemků NENÍ jen kosmetický — Sreality vrací 404, pokud
// "kind" segment (pozemek/byt) nebo dispozice v URL neodpovídá přesně
// (ověřeno naostro: /pozemky/ místo /pozemek/ i /Bydlení/ místo /bydleni/
// obojí samostatně 404ovalo). `categorySubCb.name` (např. "Bydlení",
// "Zahrady") se pro pozemky v URL nepoužívá stejně jako pro byty — web má
// vlastní (nepravidelné, "Zahrady" → "zahrada" je navíc jednotné číslo)
// slugy, které nejdou odvodit obecným pravidlem, proto explicitní mapa.
// Fetchujeme jen tyhle dvě kategorie (viz buildSearchUrls), takže mapa
// nikdy neminí — kdyby přesto ano, fallback aspoň neshodí celý běh.
const LAND_DETAIL_SLUGS = {
  19: "bydleni", // Bydlení (stavební parcela)
  23: "zahrada", // Zahrady
};

function buildDetailUrl(item) {
  const isLand = item.categoryMainCb?.value === 3;
  const kind = isLand ? "pozemek" : "byt";
  const disposition = isLand
    ? LAND_DETAIL_SLUGS[item.categorySubCb?.value] || "ostatni"
    : item.categorySubCb?.name || "";
  const loc = item.locality || {};
  const parts = [loc.citySeoName, loc.cityPartSeoName, loc.streetSeoName].filter(Boolean);
  const slug = parts.length ? parts.join("-") : "byt";
  return `https://www.sreality.cz/detail/prodej/${kind}/${encodeURIComponent(
    disposition
  )}/${slug}/${item.id}`;
}

function formatPrice(priceCzk) {
  if (!priceCzk) return "Cena na vyžádání";
  return `${priceCzk.toLocaleString("cs-CZ")} Kč`;
}

// U míst bez konkrétní čtvrti vrací Sreality cityPart === city (např. obojí
// "Ústí nad Orlicí") — bez téhle deduplikace by adresa vyšla "Ústí nad
// Orlicí, Ústí nad Orlicí".
function formatAddress(locality) {
  const cityPart = locality?.cityPart;
  const city = locality?.city;
  if (cityPart && cityPart !== city) return `${cityPart}, ${city}`;
  return city || "";
}

async function fetchOneUrl(url, watch) {
  const html = await fetchText(url);
  const data = extractNextData(html);
  const dehydrated = data?.props?.pageProps?.dehydratedState;
  if (!dehydrated) {
    throw new Error("sreality: dehydratedState chybí — struktura stránky se změnila.");
  }
  const query = dehydrated.queries.find((q) => q.queryKey?.[0] === "estatesSearch");
  const results = query?.state?.data?.results || [];

  const items = [];
  for (const r of results) {
    const lat = r.locality?.latitude;
    const lng = r.locality?.longitude;
    if (lat == null || lng == null) continue;

    const withinAnyLocation = watch.locations.some(
      (loc) => haversineKm(loc.centerLat, loc.centerLng, lat, lng) <= loc.radiusKm
    );
    if (!withinAnyLocation) continue;

    if (!withinPriceCap(r.priceCzk, watch.priceMaxCzk)) continue;

    items.push({
      source: "sreality",
      sourceLabel: "Sreality.cz",
      id: String(r.id),
      title: r.name || "Nabídka",
      price: formatPrice(r.priceCzk),
      priceCzk: r.priceCzk || null,
      address: formatAddress(r.locality),
      url: buildDetailUrl(r),
    });
  }
  return items;
}

export async function fetchSreality(watch) {
  const urls = buildSearchUrls(watch);
  const perUrl = [];
  for (const url of urls) {
    perUrl.push(await fetchOneUrl(url, watch));
  }
  return mergeUniqueById(perUrl);
}

// Sreality řadí "nejnovější" podle data POSLEDNÍ ÚPRAVY inzerátu, ne podle
// data prvního zveřejnění — když prodejce/RK inzerát jen upraví (třeba
// jen opraví popisek, nebo právě SNÍŽÍ CENU), vyskočí nahoru jako "nové",
// i když je na trhu roky (ověřeno naostro: inzerát s `since: 2021-02-27`,
// `edited: 2026-08-19`, zachycený naším pollingem jako "nová nabídka"
// v okamžiku, kdy ho Sreality "upravila" — reálně žádná nová nabídka).
// Detail stránka má pole `params.since` (na trhu od) a `params.edited`
// (naposledy upraveno) — search-výpis ani jedno z nich nemá, proto extra
// fetch. Oba se hodí, ale pro jiný účel: `since` u NOVÝCH inzerátů (odliší
// "opravdu nové" od "jen vytažené nahoru", viz index.js), `edited` u ZMĚNY
// CENY (potvrdí, kdy se cena reálně změnila — to je totiž přesně ta stejná
// "úprava", co inzerát vytáhne nahoru). Volá se jen pro položky, co jsme
// právě vyhodnotili jako nové/změněné, ne pro každý inzerát v každém běhu.
export async function fetchListingDates(url) {
  // fetchText už sama zkouší 5xx/síťové chyby znovu (viz lib/http.js) —
  // tady stačí zachytit, kdyby selhala i po těch pokusech.
  try {
    const html = await fetchText(url, { skipAcceptHeader: true });
    const data = extractNextData(html);
    const dh = data?.props?.pageProps?.dehydratedState;
    const q = dh?.queries?.find((q) => q.queryKey?.[0] === "estate");
    const params = q?.state?.data?.params;
    return { since: params?.since || null, edited: params?.edited || null };
  } catch {
    return { since: null, edited: null }; // best-effort — ať kvůli tomuhle neselže celá notifikace
  }
}
