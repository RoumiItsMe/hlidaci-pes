// Bezrealitky detail — vlastní, nezávislý na sources/bezrealitky.js.
//
// Zjištěno naostro: `__NEXT_DATA__.props.pageProps.origAdvert` obsahuje
// rovnou plně vytěžený inzerát — `description` (plný text), `publicImages`
// (pole objektů s `url`), a hlavně **`reserved` (boolean)** — jediný ze
// všech 5 portálů, kde je stav rezervace přímo a spolehlivě v datech
// (ověřeno na reálném rezervovaném inzerátu).

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

export async function fetchBezrealitkyDetail(url) {
  try {
    const html = await fetchText(url);
    const data = extractNextData(html);
    const adv = data?.props?.pageProps?.origAdvert;
    if (!adv) return { description: null, photoUrls: [], reserved: false };

    const photoUrls = (adv.publicImages || []).map((img) => img.url).filter(Boolean);
    return { description: adv.description || null, photoUrls, reserved: adv.reserved === true };
  } catch (err) {
    console.warn(`[detail/bezrealitky] ${url}: ${err.message}`);
    return { description: null, photoUrls: [], reserved: false };
  }
}
