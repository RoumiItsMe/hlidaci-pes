// Sreality detail — vlastní, nezávislý na sources/sreality.js (ten se pro
// hlídacího psa nesmí měnit). Znovupoužívá jen fetchText.
//
// Zjištěno naostro (inspekce živého detailu): `estate` query v
// dehydratedState má top-level `description` (plný text), `images` (pole
// objektů s protokol-relativní `url`, "//..." → potřeba doplnit "https:"),
// `categorySubCb.name` (dispozice, např. "2+1") a `params.usableArea` (m²
// jako číslo) — obojí se ale u nás bere z titulku (viz parse.js), tohle
// slouží jen na description/fotky. Rezervace je v `params.stateCb` (viz
// isReserved níž) — dřív se hledala grepem "rezerv" na inzerátech, které
// rezervované nebyly, a tak se mylně došlo k závěru, že tenhle příznak
// neexistuje.
//
// Fotky z tohohle detailu appka VRÁTÍ (URL v `images`), ale STAŽENÍ vždy
// selže — Sreality CDN (d18-a.sdn.cz) vrací 401 na každý request bez
// ohledu na hlavičky, viz komentář v ../photos.js. Necháno tak (fail-soft,
// zdokumentováno v README) — přepis na headless prohlížeč by pro tenhle
// jeden zdroj byl nepřiměřeně velký zásah do "jednoduché appky".
//
// `params` (viz ../params.js pro seznam polí): Sreality má strukturovaná
// data — pole končící na "Cb" jsou objekty `{ name, value }` (interní
// "codebook", value=0 zpravidla znamená "- nezadáno" → bereme jako
// neznámé, nezobrazí se). `floorNumber` je 0-indexované (0 = přízemí, dál
// "1. patro" atd. — standardní česká konvence). Booleovská pole (balkón,
// sklep, terasa, lodžie, garáž) appka převádí na "Ano"/"Ne", s plochou v
// závorce, pokud je známá.

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

function cbName(cb) {
  if (!cb || typeof cb !== "object") return null;
  if (cb.value === 0 && /nezad[áa]no/i.test(cb.name || "")) return null;
  return cb.name || null;
}

function energyLetter(cb) {
  const name = cbName(cb);
  return name ? name.split(" - ")[0].trim() : null;
}

function yesNo(value, areaM2) {
  if (value == null) return null;
  const base = value ? "Ano" : "Ne";
  return value && areaM2 ? `${base} (${areaM2} m²)` : base;
}

function extractParams(est) {
  const p = est.params || {};
  return {
    ownership: cbName(p.ownership),
    condition: cbName(p.buildingCondition),
    buildingType: cbName(p.buildingType),
    floorInfo: p.floorNumber != null && p.floors != null ? `${p.floorNumber === 0 ? "Přízemí" : `${p.floorNumber}. patro`} z ${p.floors}` : null,
    energyRating: energyLetter(p.energyEfficiencyRating),
    elevator: cbName(p.elevator),
    balcony: yesNo(p.balcony, p.balconyArea),
    loggia: yesNo(p.loggia, p.loggiaArea),
    terrace: yesNo(p.terrace, p.terraceArea),
    cellar: yesNo(p.cellar, p.cellarArea),
    parking: typeof p.parking === "object" ? cbName(p.parking) : yesNo(p.parking),
    garage: yesNo(p.garage),
  };
}

// Stav inzerátu (`params.stateCb`): 0 = "- vyber stav" (výchozí, tedy běžná
// nabídka), 1 = "Rezervováno" — ověřeno naostro na 43 inzerátech (41× 0,
// 2× 1). Ve výpisu (search) tenhle příznak NENÍ (filtr "Bez rezervovaných
// nabídek" je u Sreality prémiový), takže jde zjistit jen z detailu.
function isReserved(est) {
  const state = est.params?.stateCb;
  return state?.value === 1 || /rezerv/i.test(state?.name || "");
}

export async function fetchSrealityDetail(url) {
  try {
    // skipAcceptHeader: Sreality detail stránky občas na "Accept"
    // s application/json odpovídají redirect smyčkou — stejný fix jako
    // u hlídacího psa (viz sources/sreality.js / lib/http.js).
    const html = await fetchText(url, { skipAcceptHeader: true });
    const data = extractNextData(html);
    const dh = data?.props?.pageProps?.dehydratedState;
    const q = dh?.queries?.find((q) => q.queryKey?.[0] === "estate");
    const est = q?.state?.data;
    if (!est) return { description: null, photoUrls: [], reserved: null, params: {} };

    const photoUrls = (est.images || [])
      .map((img) => (img.url?.startsWith("//") ? `https:${img.url}` : img.url))
      .filter(Boolean);

    return { description: est.description || null, photoUrls, reserved: isReserved(est), params: extractParams(est) };
  } catch (err) {
    console.warn(`[detail/sreality] ${url}: ${err.message}`);
    // `reserved: null` = "nevíme" (ne "není rezervováno") — chyba stažení
    // nesmí rezervaci u známého inzerátu zrušit, viz track.js.
    return { description: null, photoUrls: [], reserved: null, params: {} };
  }
}
