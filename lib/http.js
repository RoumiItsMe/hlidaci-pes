// Sdílený HTTP fetch wrapper — jednotná hlavička, timeout, retry, chybové hlášky.

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const DEFAULT_TIMEOUT_MS = 20_000;
const RETRY_BACKOFF_MS = [1000, 2500]; // délka pauzy před 2. a 3. pokusem

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchOnce(url, { timeoutMs, skipAcceptHeader }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {
      "User-Agent": USER_AGENT,
      "Accept-Language": "cs-CZ,cs;q=0.9,en;q=0.8",
    };
    if (!skipAcceptHeader) {
      headers.Accept = "text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8";
    }
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} ${res.statusText} pro ${url}`);
      err.status = res.status;
      throw err;
    }
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Stáhne text (HTML/XML/JSON) z dané URL s běžnou prohlížečovou hlavičkou.
 *
 * Portály občas vrátí krátkodobou 5xx chybu (viděno naostro: Bazoš 502,
 * Sreality 503) nebo síťovou chybu, co se sama spraví během pár vteřin —
 * bez retry by to hned skončilo jako "zdroj přestal fungovat" alert, i
 * když jde jen o jednorázový zádrhel na straně portálu. Zkusí se tedy
 * znovu (max 2×, s krátkou pauzou), a jen když selžou i tyhle pokusy, jde
 * chyba dál (a teprve to je hodné Telegram alertu — viz index.js).
 * 4xx chyby (typicky 404 — trvalá, ne přechodná) se NEzkouší znovu.
 *
 * `skipAcceptHeader` — Sreality detail stránky (ne search) na hlavičku
 * `Accept: ...,application/json;q=0.9,...` odpovídají přerušovaně redirect
 * smyčkou ("redirect count exceeded") — ověřeno naostro, izolováno na tenhle
 * konkrétní header (bez něj/jen s Accept-Language stránka projde normálně).
 * Search stránky (a všechny ostatní zdroje) tenhle problém nemají, takže se
 * default nemění globálně — jen volající, co na něj narazí, si ho vypne.
 */
export async function fetchText(url, { timeoutMs = DEFAULT_TIMEOUT_MS, skipAcceptHeader = false } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt++) {
    try {
      return await fetchOnce(url, { timeoutMs, skipAcceptHeader });
    } catch (err) {
      lastErr = err;
      // 4xx (klientská/trvalá chyba, např. 404) nemá smysl opakovat —
      // retry má smysl jen u 5xx (server dočasně nedostupný) a u síťových
      // chyb bez status kódu (timeout, DNS, redirect smyčka apod.).
      const isRetriable = err.status == null || err.status >= 500;
      if (!isRetriable || attempt === RETRY_BACKOFF_MS.length) break;
      await sleep(RETRY_BACKOFF_MS[attempt]);
    }
  }
  throw lastErr;
}
