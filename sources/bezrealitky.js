// Bezrealitky.cz — data se čtou z embedded JSON (__NEXT_DATA__ → apolloCache),
// stejný princip jako Sreality. Portál ale (na rozdíl od Sreality) nemá
// "fetchni celý okres najednou" endpoint — lokalitu řeší přes "boundaryPoints"
// (obdélníkový výřez mapy), takže pro každou nakonfigurovanou lokalitu musíme
// poslat samostatný dotaz. Výsledky se pak sloučí a odduplikují (blízké
// lokality se v okruhu mohou překrývat).
//
// Pozemky: portál sice má pole `landType` (typ pozemku), ale u inzerátů
// v tomhle regionu je prakticky vždy "UNDEFINED" (prodejci ho nevyplňují) —
// nejde se tedy spolehlivě omezit jen na "bydlení/zahrady" jako u ostatních
// zdrojů. Bereme proto VŠECHNY pozemky v okruhu + do cenového stropu (je
// jich v tomhle regionu málo, takže i tak zůstává použitelné).

import { haversineKm, boundingBox } from "../lib/geo.js";
import { fetchText } from "../lib/http.js";
import { withinPriceCap } from "../lib/price.js";
import { mergeUniqueById } from "../lib/merge.js";

function buildUrl(boundaryPoints, estateType) {
  const params = new URLSearchParams({
    country: "ceska-republika",
    currency: "CZK",
    estateType,
    location: "fromMap",
    offerType: "PRODEJ",
  });
  return `https://www.bezrealitky.cz/vyhledat?boundaryPoints=${encodeURIComponent(
    JSON.stringify(boundaryPoints)
  )}&${params.toString()}`;
}

function extractNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) {
    throw new Error(
      "bezrealitky: __NEXT_DATA__ nenalezen — struktura stránky se pravděpodobně změnila."
    );
  }
  return JSON.parse(m[1]);
}

function formatDisposition(disp) {
  if (!disp) return "";
  const body = disp.replace(/^DISP_/, "");
  const parts = body.split("_");
  if (parts.length !== 2) return body;
  return `${parts[0]}+${parts[1].toLowerCase()}`;
}

function formatPrice(price) {
  if (!price) return "Cena na vyžádání";
  return `${price.toLocaleString("cs-CZ")} Kč`;
}

async function fetchForLocation(loc, watch) {
  const estateType = watch.propertyType === "pozemek" ? "POZEMEK" : "BYT";
  const box = boundingBox(loc.centerLat, loc.centerLng, loc.radiusKm);
  const boundaryPoints = [
    { lat: box.latMax, lng: box.lonMax },
    { lat: box.latMax, lng: box.lonMin },
    { lat: box.latMin, lng: box.lonMin },
    { lat: box.latMin, lng: box.lonMax },
    { lat: box.latMax, lng: box.lonMax },
  ];

  const html = await fetchText(buildUrl(boundaryPoints, estateType));
  const data = extractNextData(html);
  const cache = data?.props?.pageProps?.apolloCache;
  if (!cache?.ROOT_QUERY) {
    throw new Error("bezrealitky: apolloCache/ROOT_QUERY chybí — struktura stránky se změnila.");
  }

  const listKey = Object.keys(cache.ROOT_QUERY).find(
    (k) => k.startsWith("listAdverts(") && k.includes('"boundaryPoints"') && !k.includes("discountedOnly")
  );
  if (!listKey) {
    throw new Error("bezrealitky: listAdverts query nenalezen — struktura stránky se změnila.");
  }
  const refs = cache.ROOT_QUERY[listKey]?.list || [];

  const items = [];
  for (const { __ref } of refs) {
    const advert = cache[__ref];
    if (!advert?.gps) continue;
    if (haversineKm(loc.centerLat, loc.centerLng, advert.gps.lat, advert.gps.lng) > loc.radiusKm) continue;
    if (!withinPriceCap(advert.price, watch.priceMaxCzk)) continue;

    let title;
    if (watch.propertyType === "pozemek") {
      const surface = advert.surfaceLand ? `${advert.surfaceLand} m²` : "";
      title = ["Pozemek", surface].filter(Boolean).join(" • ");
    } else {
      const disp = formatDisposition(advert.disposition);
      const surface = advert.surface ? `${advert.surface} m²` : "";
      title = [disp, surface].filter(Boolean).join(" • ") || "Byt na prodej";
    }

    items.push({
      source: "bezrealitky",
      sourceLabel: "Bezrealitky.cz",
      id: String(advert.id),
      title,
      price: formatPrice(advert.price),
      priceCzk: advert.price || null,
      address: advert['address({"locale":"CS"})'] || "",
      url: `https://www.bezrealitky.cz/nemovitosti-byty-domy/${advert.uri}`,
    });
  }
  return items;
}

export async function fetchBezrealitky(watch) {
  const perLocation = [];
  for (const loc of watch.locations) {
    perLocation.push(await fetchForLocation(loc, watch));
  }
  return mergeUniqueById(perLocation);
}
