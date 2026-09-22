// Sreality detail — vlastní, nezávislý na sources/sreality.js (ten se pro
// hlídacího psa nesmí měnit). Znovupoužívá jen fetchText.
//
// Zjištěno naostro (inspekce živého detailu): `estate` query v
// dehydratedState má top-level `description` (plný text), `images` (pole
// objektů s protokol-relativní `url`, "//..." → potřeba doplnit "https:"),
// `categorySubCb.name` (dispozice, např. "2+1") a `params.usableArea` (m²
// jako číslo) — obojí se ale u nás bere z titulku (viz parse.js), tohle
// slouží jen na description/fotky. Žádný "rezervováno" příznak se v datech
// nenašel (grep na "rezerv" nic nenašel) — reserved-detekce pro Sreality
// tedy není k dispozici, spoléhá se jen na zmizení z výpisu (removed).
//
// Fotky z tohohle detailu appka VRÁTÍ (URL v `images`), ale STAŽENÍ vždy
// selže — Sreality CDN (d18-a.sdn.cz) vrací 401 na každý request bez
// ohledu na hlavičky, viz komentář v ../photos.js. Necháno tak (fail-soft,
// zdokumentováno v README) — přepis na headless prohlížeč by pro tenhle
// jeden zdroj byl nepřiměřeně velký zásah do "jednoduché appky".

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
    if (!est) return { description: null, photoUrls: [], reserved: false };

    const photoUrls = (est.images || [])
      .map((img) => (img.url?.startsWith("//") ? `https:${img.url}` : img.url))
      .filter(Boolean);

    return { description: est.description || null, photoUrls, reserved: false };
  } catch (err) {
    console.warn(`[detail/sreality] ${url}: ${err.message}`);
    return { description: null, photoUrls: [], reserved: false };
  }
}
