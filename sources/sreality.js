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

function buildDetailUrl(item) {
  const disposition = item.categorySubCb?.name || "";
  const loc = item.locality || {};
  const parts = [loc.citySeoName, loc.cityPartSeoName, loc.streetSeoName].filter(Boolean);
  const slug = parts.length ? parts.join("-") : "byt";
  const kind = item.categoryMainCb?.value === 3 ? "pozemky" : "byt";
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
