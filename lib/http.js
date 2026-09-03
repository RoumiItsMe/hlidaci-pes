// Sdílený HTTP fetch wrapper — jednotná hlavička, timeout, chybové hlášky.

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const DEFAULT_TIMEOUT_MS = 20_000;

/** Stáhne text (HTML/XML/JSON) z dané URL s běžnou prohlížečovou hlavičkou. */
export async function fetchText(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "cs-CZ,cs;q=0.9,en;q=0.8",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText} pro ${url}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}
