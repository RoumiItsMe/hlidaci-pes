// Přímý důkaz, že inzerát na portálu už neexistuje. Sběr inzerát, který se nenašel ve výpisu, nesmaže hned, ale čeká
// na potvrzení dalším během po odstupu (relist.js) — výpis může jednorázově vypadnout. Stránka samotného inzerátu ale
// u smazané nabídky říká jednoznačně, že zanikla, a přechodný výpadek výpisu to nezpůsobí. Signály, které jednotlivé
// portály u smazaného inzerátu vracejí (ověřeno 10/2026 na Dukelské 320; živý inzerát je vždy HTTP 200 bez nich):
//  - Sreality: HTTP 404;
//  - Bazoš: přesměrování na výpis kategorie (`/inzeraty/…`);
//  - iDNES: 200 s textem "Nabídka již není aktivní";
//  - RealityMIX: 200 s textem "Požadovaný inzerát již není v naší databázi";
//  - ostatní portály: HTTP 404 / 410.
// Cokoli jiného (chyba sítě, 403, 429, 5xx, běžná stránka) důkaz není → `false` a platí běžná pojistka z relist.js.

const GONE_TEXT = {
  idnes: /Nabídka již není aktivní/i,
  realitymix: /Požadovaný inzerát již není v naší databázi/i,
};
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Je odpověď portálu na stránku inzerátu důkazem, že inzerát zanikl? Čistá funkce (viz hlavička). */
export function classifyGonePage({ source, status, location = null, body = "" }) {
  if (status === 404 || status === 410) return true;
  if (source === "bazos") return status >= 300 && status < 400 && /\/inzeraty\//.test(location ?? "");
  if (status !== 200) return false;
  return GONE_TEXT[source]?.test(body ?? "") ?? false;
}

/** Zeptá se portálu na stránku inzerátu. Jakákoli chyba nebo nejasná odpověď = `false` (nic se nepotvrzuje). */
export async function probeGone(source, url, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  if (!url) return false;
  try {
    const res = await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": UA, "accept-language": "cs" } });
    const body = res.status === 200 && GONE_TEXT[source] ? await res.text() : "";
    return classifyGonePage({ source, status: res.status, location: res.headers.get("location"), body });
  } catch {
    return false;
  }
}
