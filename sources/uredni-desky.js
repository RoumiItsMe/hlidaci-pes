// Úřední desky obcí — stahování seznamu vyvěšených oznámení.
//
// Každá obec má desku jinde a v jiném redakčním systému, proto víc parserů
// (typ desky se volí v config.js → `noticeBoards[].type`):
//  - "vismo"  — CMS Vismo (Letohrad, Žamberk, Česká Třebová). Chronologický
//               výpis všech dokumentů je na /vismo/zobraz_dok.asp?ud=1 a jde
//               v něm nastavit počet na stránku (`pocet`). Na hlavní stránce
//               desky (/uredni-deska/N) je výpis jen po "složkách" a s pár
//               záznamy, takže se nehodí.
//  - "joomla" — Joomla tabulka kategorie (Ústí nad Orlicí): 10 záznamů na
//               stránku, jde zvednout přes `?limit=`.
//  - "ginis"  — GINIS Úřední deska (Lanškroun, ude.ginis.cloud): celý seznam
//               vyvěšených dokumentů na jediné stránce, bez stránkování.
//  - "ofn"    — otevřená data úřední desky (JSON-LD podle OFN MVČR), stejná u
//               každé obce, která je publikuje — zákonná povinnost mají obce s
//               rozšířenou působností (Králíky, Vysoké Mýto…); adresy feedů
//               jsou v Národním katalogu otevřených dat (data.gov.cz).
//  - "edesky-api" — oficiální API agregátoru edesky.cz (potřebuje osobní klíč
//               v env EDESKY_API_KEY): jedním dotazem dokumenty ze VŠECH desek
//               okresu (obce jsou jeho podřízené desky), s rozpoznaným textem
//               příloh. Slouží pro drobné obce, jejichž vlastní weby by bylo
//               nutné číst jeden po druhém. Webové stránky edesky.cz se z
//               GitHub Actions číst nedají (robot-check), API ano.
//
// Všechny parsery vrací totéž: `{ id, title, description, category, url,
// postedFrom, postedTo }` (+ volitelně `attachmentUrl`; u edesky-api navíc
// `viaEdesky`, `sourceLabel`, `sourceBoardId`, `attachmentText`). `id` je
// stabilní v rámci desky (slouží k dedup), data jsou ISO `YYYY-MM-DD` (nebo
// null). Parsery jsou čisté funkce nad textem odpovědi (bez sítě), ať jdou
// testovat nad uloženými daty.
//
// edesky.cz: datum u dokumentu je "načteno" (kdy ho agregátor stáhl), ne kdy
// ho obec vyvěsila — nový dokument tedy může být ve skutečnosti starý (hlavně
// když agregátor začne číst novou desku a načte celou historii, viz pojistka
// proti hromadnému načtení v lib/boards-runner.js). Datum vyvěšení "do" se
// nezjistí vůbec.
//
// Portály se občas předělají — když parser najde nula oznámení, `fetchBoardNotices`
// to hlásí jako chybu (viz níže) místo aby "žádné nové oznámení" tiše
// zamaskovalo rozbitý parser.

import * as cheerio from "cheerio";
import { fetchText } from "../lib/http.js";

// Kolik posledních oznámení se z desky bere. Hlídá se každých ~15 minut,
// takže i u velké desky stačí zlomek — ale s rezervou pro výpadek běhů
// (GitHub Actions občas cron přeskočí i na hodiny).
const NOTICES_PER_BOARD = 100;

function clean(text) {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/** "24.9.2026" / "24.09.2026" → "2026-09-24"; jinak null. */
function parseCzDate(text) {
  const m = clean(text).match(/(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/);
  if (!m) return null;
  const [, d, mo, y] = m;
  return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

function absoluteUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- Vismo ---

/**
 * Vismo: `<li class="urd-line">` = jedno oznámení. Odkaz vede buď na detail
 * (`…/d-29682`), nebo přímo na přiložený soubor (`File.ashx?…id_dokumenty=29678`).
 */
export function parseVismo(html, baseUrl) {
  const $ = cheerio.load(html);
  const notices = [];
  $("li.urd-line").each((_, li) => {
    const $li = $(li);
    const $a = $li.find(".urd-left strong a").first();
    const href = $a.attr("href");
    const title = clean($a.text());
    if (!href || !title) return;

    const detailId = href.match(/\/d-(\d+)(?:[/?#]|$)/)?.[1];
    const fileId = href.match(/id_dokumenty=(\d+)/i)?.[1];
    const id = detailId ? `d-${detailId}` : fileId ? `f-${fileId}` : href;

    // Popisek je holý <div> vedle <strong>; kategorie ("Složka dokumentů: …")
    // má třídu `ktg`.
    const description = clean(
      $li
        .find(".urd-left > div")
        .filter((__, d) => !$(d).hasClass("ktg"))
        .first()
        .text()
    );
    const category = clean($li.find(".urd-left .ktg a").first().text());

    notices.push({
      id,
      title,
      description,
      category,
      url: absoluteUrl(href, baseUrl),
      postedFrom: parseCzDate($li.find(".urd-from").text()),
      postedTo: parseCzDate($li.find(".urd-to").text()),
    });
  });
  return notices;
}

// --------------------------------------------------------------- Joomla ---

/**
 * Joomla (Ústí nad Orlicí): řádek tabulky `table.category`. ID je číslo
 * článku v URL (`…/12160-oznameni-o-…`). Sloupec "Od / do" nese dvě data
 * oddělená `<br>`.
 */
export function parseJoomla(html, baseUrl) {
  const $ = cheerio.load(html);
  const notices = [];
  $("table.category tbody tr").each((_, tr) => {
    const $tr = $(tr);
    const $a = $tr.find("td.list-title a").first();
    const href = $a.attr("href");
    const title = clean($a.text());
    if (!href || !title) return;

    const articleId = href.match(/\/(\d+)-[^/]*$/)?.[1];
    const dates = [...clean($tr.find("td").eq(3).html()?.replace(/<br\s*\/?>/gi, " ") ?? "").matchAll(/\d{1,2}\.\d{1,2}\.\d{4}/g)].map(
      (m) => parseCzDate(m[0])
    );

    notices.push({
      id: articleId ?? href,
      title,
      description: "",
      category: clean($tr.find("td.list-category").text()),
      url: absoluteUrl(href, baseUrl),
      // Sloupec "Dokument" ("zde") vede na PDF s vlastním textem oznámení.
      attachmentUrl: absoluteUrl($tr.find('td a[target="_blank"]').first().attr("href") ?? "", baseUrl) ?? undefined,
      postedFrom: dates[0] ?? null,
      postedTo: dates[1] ?? null,
    });
  });
  return notices;
}

// ---------------------------------------------------------------- GINIS ---

/**
 * GINIS Úřední deska: `#seznamDokumentu`. Název je odkaz s `?id=MULA…`
 * (stabilní identifikátor dokumentu); pod ním v `<small>` je "Kategorie: …".
 */
export function parseGinis(html, baseUrl) {
  const $ = cheerio.load(html);
  const notices = [];
  $("#seznamDokumentu tbody tr").each((_, tr) => {
    const $tr = $(tr);
    const $cell = $tr.find('td[data-title="Název dokumentu"]').first();
    const $a = $cell.find("a").first();
    const href = $a.attr("href");
    const title = clean($a.text());
    if (!href || !title) return;

    const id = href.match(/[?&]id=([^&]+)/)?.[1] ?? href;
    const category = clean($cell.find("small").first().text()).replace(/^Kategorie:\s*/i, "");
    const department = clean($tr.find("td.text-center small").first().text());

    notices.push({
      id,
      title,
      description: department, // odbor, který dokument vyvěsil — jen pro kontext
      category,
      url: absoluteUrl(href, baseUrl),
      postedFrom: parseCzDate($tr.find('td[data-title="Zobrazeno od"]').text()),
      postedTo: parseCzDate($tr.find('td[data-title="Zobrazeno do"]').text()),
    });
  });
  return notices;
}

// ------------------------------------------------------------------ OFN ---

/** OFN `{ datum: "2026-03-24" }` (nebo `datum_a_čas`) → "2026-03-24"; jinak null. */
function ofnDate(moment) {
  const raw = moment?.datum ?? moment?.["datum_a_čas"];
  return typeof raw === "string" && /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null;
}

/**
 * Otevřená data úřední desky (Otevřená formální norma MVČR, JSON-LD):
 * `{ typ: "Úřední deska", informace: [ { iri, url, název: { cs }, vyvěšení,
 * relevantní_do, dokument: [ { název, url } ] } ] }`. Obce s rozšířenou
 * působností ho mají od února 2022 ze zákona povinně (adresy feedů jsou v
 * Národním katalogu otevřených dat, data.gov.cz). Je to jediný typ desky,
 * který je stejný u všech obcí — jeden parser pro každou z nich.
 */
export function parseOfn(text) {
  const data = JSON.parse(text);
  const items = Array.isArray(data?.informace) ? data.informace : [];
  const notices = [];
  for (const item of items) {
    const name = item["název"];
    const title = clean(typeof name === "string" ? name : name?.cs);
    const id = item.iri ?? item.url;
    if (!id || !title) continue;

    const documents = Array.isArray(item.dokument) ? item.dokument : item.dokument ? [item.dokument] : [];
    const pdf = documents.find((d) => /\.pdf(?:$|\?)/i.test(`${d?.["název"]?.cs ?? ""} ${d?.url ?? ""}`)) ?? documents[0];

    notices.push({
      id,
      title,
      description: "",
      category: "",
      url: item.url ?? item.iri,
      attachmentUrl: pdf?.url ?? undefined,
      postedFrom: ofnDate(item["vyvěšení"]),
      postedTo: ofnDate(item["relevantní_do"]),
    });
  }
  return notices;
}

// ----------------------------------------------------------- edesky API ---

const EDESKY_API_URL = "https://edesky.cz/api/v1/documents";
const EDESKY_QUERY_DELAY_MS = 500;
// Nejstarší dokument, který se ještě bere (podle data NAČTENÍ na edesky.cz).
// První běh sahá hlouběji, ať se hned nahlásí i oznámení vyvěšená před
// zapnutím sledování; běžný běh má rezervu pro výpadek běhů.
const EDESKY_DEEP_DAYS = 30;
const EDESKY_REGULAR_DAYS = 7;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Text přílohy z API je URL-kódovaný ("%C4%8D…") s prokládanými mezerami;
 * dekóduje se, a když to nejde (není kódovaný, nebo je poškozený), vrátí se tak,
 * jak je.
 */
export function decodeAttachmentText(raw) {
  const compact = (raw ?? "").replace(/\s+/g, "");
  if (!compact) return "";
  try {
    return decodeURIComponent(compact);
  } catch {
    return (raw ?? "").trim();
  }
}

/**
 * Odpověď API edesky.cz (`/api/v1/documents`, XML) → oznámení. Jeden
 * `<document>` nese název (`name`), desku obce (`dashboard_id`, `dashboard_name`),
 * datum načtení (`created_at`) a přílohy s rozpoznaným textem (jen s
 * `show_texts=1`; pozor, dokumentovaný `include_texts` nic nedělá).
 *
 * `orig_url` bývá jen zástupný text ("#_pokud-potrebujete-…"), proto se za odkaz
 * bere jen když je to opravdová adresa, jinak stránka dokumentu na edesky.cz.
 */
export function parseEdeskyApi(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });
  if ($("edesky_search_api").length === 0) {
    throw new Error("API edesky.cz nevrátilo očekávanou odpověď (jiný formát, nebo vypršel klíč?)");
  }
  const notices = [];
  $("document").each((_, el) => {
    const $d = $(el);
    const edeskyUrl = $d.attr("edesky_url") ?? "";
    const docId = $d.attr("edesky_id") ?? edeskyUrl.match(/\/dokument\/(\d+)/)?.[1];
    const $attachments = $d.find("attachment");
    const title = clean($d.attr("name")) || clean($attachments.first().attr("name"));
    if (!docId || !title) return;

    // První příloha s rozpoznaným textem.
    let attachmentText = "";
    $attachments.each((__, a) => {
      if (attachmentText) return;
      attachmentText = decodeAttachmentText($(a).text());
    });

    const origUrl = $d.attr("orig_url") ?? "";
    notices.push({
      id: `e${docId}`,
      title,
      description: "",
      category: "",
      url: /^https?:\/\//i.test(origUrl) ? origUrl : edeskyUrl || `https://edesky.cz/dokument/${docId}`,
      postedFrom: ($d.attr("created_at") ?? "").slice(0, 10) || null, // "načteno", ne datum vyvěšení
      postedTo: null,
      viaEdesky: true,
      sourceLabel: clean($d.attr("dashboard_name") ?? "") || null,
      sourceBoardId: Number($d.attr("dashboard_id")) || null,
      attachmentText: attachmentText || undefined,
    });
  });
  return notices;
}

/**
 * Jeden dotaz na API. Chybové hlášky záměrně NEobsahují adresu — je v ní klíč
 * (`api_key`) a hlášky končí v logu i v Telegram alertu. 5xx a síťové chyby se
 * zkusí znovu (jako v lib/http.js), 4xx (špatný/vypršelý klíč) ne.
 */
async function edeskyApiQuery(params, apiKey) {
  const url = `${EDESKY_API_URL}?${new URLSearchParams({ ...params, api_key: apiKey })}`;
  let lastError;
  for (const backoff of [0, 1000, 2500]) {
    if (backoff) await sleep(backoff);
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; hlidaci-pes)", "Accept-Language": "cs-CZ,cs;q=0.9" },
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        const err = new Error(`API edesky.cz vrátilo HTTP ${res.status}${res.status === 401 || res.status === 403 ? " (zkontroluj klíč EDESKY_API_KEY)" : ""}`);
        err.status = res.status;
        throw err;
      }
      return await res.text();
    } catch (err) {
      lastError = err.status ? err : new Error(`API edesky.cz nedostupné (${err.cause?.code ?? err.name})`);
      if (lastError.status && lastError.status < 500) break;
    }
  }
  throw lastError;
}

/**
 * Oznámení z desky okresu na edesky.cz přes jeho oficiální API. Hledání je
 * podle přesných tvarů slov (bez skloňování), proto dotazy s hvězdičkou a
 * `OR` (viz `queries` v config.js). Klíč je v env `EDESKY_API_KEY`.
 */
async function fetchEdeskyApi(board, { deep }) {
  const apiKey = process.env.EDESKY_API_KEY;
  if (!apiKey) throw new Error("Chybí EDESKY_API_KEY (klíč k API edesky.cz, viz README)");

  const createdFrom = isoDaysAgo(deep ? EDESKY_DEEP_DAYS : EDESKY_REGULAR_DAYS);
  const byId = new Map();
  for (const [index, query] of board.queries.entries()) {
    if (index > 0) await sleep(EDESKY_QUERY_DELAY_MS);
    const xml = await edeskyApiQuery(
      {
        keywords: query.keywords,
        search_with: "es", // fulltext všeho vč. příloh
        dashboard_id: String(board.edeskyId),
        order: "date",
        created_from: createdFrom,
        ...(query.texts ? { show_texts: "1" } : {}),
      },
      apiKey
    );
    for (const notice of parseEdeskyApi(xml)) {
      const existing = byId.get(notice.id);
      // Stejný dokument z víc dotazů — zachovat variantu s textem přílohy.
      if (!existing || (!existing.attachmentText && notice.attachmentText)) byId.set(notice.id, notice);
    }
  }

  // Obce, které se čtou přímo z vlastní desky, tu nejsou podruhé.
  const skip = new Set(board.skipBoardIds ?? []);
  return [...byId.values()].filter((notice) => !skip.has(notice.sourceBoardId));
}

// ---------------------------------------------------------------- fetch ---

function listUrl(board) {
  switch (board.type) {
    case "vismo":
      return `${board.url}/vismo/zobraz_dok.asp?ud=1&tzv=1&pocet=${NOTICES_PER_BOARD}&stranka=1`;
    case "joomla":
      return `${board.url}?limit=${NOTICES_PER_BOARD}`;
    case "ginis":
    case "ofn":
      return board.url;
    default:
      throw new Error(`Neznámý typ úřední desky: ${board.type}`);
  }
}

const PARSERS = { vismo: parseVismo, joomla: parseJoomla, ginis: parseGinis, ofn: parseOfn };

/**
 * Stáhne poslední oznámení z desky obce. Nula oznámení = chyba (deska obce
 * není nikdy skutečně prázdná, takže je to skoro jistě změna struktury
 * stránky, ne "nic nového"). `deep` (první běh desky) čte hlouběji do
 * historie — týká se jen edesky-api, ostatní desky vrací vždy celé okno.
 */
export async function fetchBoardNotices(board, { deep = false } = {}) {
  if (board.type === "edesky-api") return fetchEdeskyApi(board, { deep });
  const url = listUrl(board);
  const html = await fetchText(url, { timeoutMs: 30_000 });
  const notices = PARSERS[board.type](html, url);
  if (notices.length === 0) {
    throw new Error(`Na úřední desce nebylo nalezeno žádné oznámení (změnila se struktura stránky?): ${url}`);
  }
  return notices;
}
