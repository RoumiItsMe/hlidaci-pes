// Bezrealitky detail — vlastní, nezávislý na sources/bezrealitky.js.
//
// Zjištěno naostro: `__NEXT_DATA__.props.pageProps.origAdvert` obsahuje
// rovnou plně vytěžený inzerát — `description` (plný text), `publicImages`
// (pole objektů s `url`), a hlavně **`reserved` (boolean)** — jediný ze
// všech 5 portálů, kde je stav rezervace přímo a spolehlivě v datech
// (ověřeno na reálném rezervovaném inzerátu).
//
// `params` (viz ../params.js): `ownership`/`condition`/`construction` jsou
// enum stringy (např. "DRUZSTEVNI", "BEFORE_RECONSTRUCTION", "PANEL") —
// překládají se přes mapy níž. Mapy NEJSOU zaručeně vyčerpávající (Bezreal-
// itky nepublikuje seznam všech hodnot) — neznámý kód appka nezahodí, jen
// ho zobrazí "humanizovaný" (podtržítka na mezery, malá písmena) místo
// syrového ENUM_KODU. `floor`/`etage` bývá jedno z nich vyplněné (různé
// inzeráty používají různé pole pro totéž), proto se bere `floor ?? etage`.

import { fetchText } from "../../lib/http.js";

function extractNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

const OWNERSHIP_LABELS = {
  OSOBNI: "Osobní",
  DRUZSTEVNI: "Družstevní",
  STATNI_OBECNI: "Státní/obecní",
  STATNI: "Státní",
  OBECNI: "Obecní",
};

const CONDITION_LABELS = {
  NEW_BUILDING: "Novostavba",
  VERY_GOOD: "Velmi dobrý",
  GOOD: "Dobrý",
  BEFORE_RECONSTRUCTION: "Před rekonstrukcí",
  AFTER_RECONSTRUCTION: "Po rekonstrukci",
  UNDER_CONSTRUCTION: "Ve výstavbě",
  PROJECT: "Projekt",
  BAD: "Špatný",
  DEVASTATED: "Zchátralý",
};

const CONSTRUCTION_LABELS = {
  BRICK: "Cihlová",
  PANEL: "Panelová",
  SKELETAL: "Skeletová",
  MIXED: "Smíšená",
  WOOD: "Dřevěná",
  STONE: "Kamenná",
};

function humanize(code) {
  if (!code) return null;
  const known = OWNERSHIP_LABELS[code] || CONDITION_LABELS[code] || CONSTRUCTION_LABELS[code];
  if (known) return known;
  const words = code.toLowerCase().replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function yesNo(value, areaM2) {
  if (value == null) return null;
  const base = value ? "Ano" : "Ne";
  return value && areaM2 ? `${base} (${areaM2} m²)` : base;
}

function extractParams(adv) {
  const floor = adv.floor ?? adv.etage;
  return {
    ownership: humanize(adv.ownership),
    condition: humanize(adv.condition),
    buildingType: humanize(adv.construction),
    floorInfo: floor != null && adv.totalFloors != null ? `${floor}. patro z ${adv.totalFloors}` : null,
    energyRating: adv.penb || null,
    elevator: adv.lift == null ? null : adv.lift ? "Ano" : "Ne",
    balcony: yesNo(adv.balcony, adv.balconySurface),
    loggia: yesNo(adv.loggia, adv.loggiaSurface),
    terrace: yesNo(adv.terrace, adv.terraceSurface),
    cellar: yesNo(adv.cellar, adv.cellarSurface),
    parking: yesNo(adv.parking),
    garage: yesNo(adv.garage),
  };
}

export async function fetchBezrealitkyDetail(url) {
  try {
    const html = await fetchText(url);
    const data = extractNextData(html);
    const adv = data?.props?.pageProps?.origAdvert;
    if (!adv) return { description: null, photoUrls: [], reserved: false, params: {} };

    const photoUrls = (adv.publicImages || []).map((img) => img.url).filter(Boolean);
    return { description: adv.description || null, photoUrls, reserved: adv.reserved === true, params: extractParams(adv) };
  } catch (err) {
    console.warn(`[detail/bezrealitky] ${url}: ${err.message}`);
    return { description: null, photoUrls: [], reserved: false, params: {} };
  }
}
