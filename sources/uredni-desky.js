// Úřední desky obcí — stahování seznamu vyvěšených oznámení.
//
// Každá obec má desku jinde a v jiném redakčním systému, proto tři parsery
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
//  - "edesky" — agregátor edesky.cz: jedním dotazem dokumenty ze VŠECH desek
//               okresu (obce jsou jeho podřízené desky). Slouží pro drobné
//               obce, jejichž vlastní weby by bylo nutné číst jeden po druhém.
//
// Všechny parsery vrací totéž: `{ id, title, description, category, url,
// postedFrom, postedTo }` (+ volitelně `attachmentUrl`; u edesky navíc
// `viaEdesky`, `sourceLabel`, `sourceBoardId`, `tags`). `id` je stabilní v
// rámci desky (slouží k dedup), data jsou ISO `YYYY-MM-DD` (nebo null).
// Parsery jsou čisté funkce nad HTML (bez sítě), ať jdou testovat nad
// uloženými stránkami.
//
// edesky.cz: datum u dokumentu je "Načteno" (kdy ho agregátor stáhl), ne kdy
// ho obec vyvěsila — nový dokument tedy může být ve skutečnosti starý (hlavně
// když agregátor začne číst novou desku a načte celou historii, viz pojistka
// proti hromadnému načtení v lib/boards-runner.js). Datum vyvěšení "do" se
// nezjistí vůbec a přílohy jsou pro roboty zakázané (robots.txt).
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

// --------------------------------------------------------------- edesky ---

/**
 * edesky.cz: řádek výpisu `/dokumenty` = jeden dokument. Odkaz na zdroj
 * (`itemprop=affiliation`) nese název a ID desky obce, odkaz na dokument
 * (`itemprop=url`) jeho číselné ID.
 */
export function parseEdesky(html) {
  const $ = cheerio.load(html);
  const notices = [];
  $("tr").each((_, tr) => {
    const $tr = $(tr);
    const $doc = $tr.find("a[itemprop=url]").first();
    const $source = $tr.find("a[itemprop=affiliation]").first();
    const docId = $doc.attr("href")?.match(/\/dokument\/(\d+)/)?.[1];
    const title = clean($doc.text());
    if (!docId || !title) return;
    notices.push({
      id: `e${docId}`,
      title,
      description: "",
      category: "",
      url: `https://edesky.cz/d/${docId}`,
      postedFrom: $tr.find("time").attr("datetime") ?? null, // "Načteno", ne datum vyvěšení
      postedTo: null,
      viaEdesky: true,
      sourceLabel: clean($source.text()) || null,
      sourceBoardId: Number($source.attr("href")?.match(/\/desky\/(\d+)-/)?.[1]) || null,
    });
  });
  return notices;
}

const EDESKY_PAGE_DELAY_MS = 300;
// První běh čte hlouběji (cca 2–3 týdny dokumentů ~ 30 denně), ať se hned
// nahlásí i oznámení vyvěšená před zapnutím sledování. Běžný běh stačí jedna
// stránka (25 dokumentů ≈ den provozu okresu).
const EDESKY_DEEP_PAGES = 16;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchEdesky(board, { deep }) {
  const base = `https://edesky.cz/dokumenty?zdroj=${board.edeskyId}`;
  const byId = new Map();

  const pages = deep ? EDESKY_DEEP_PAGES : 1;
  for (let page = 1; page <= pages; page++) {
    const rows = parseEdesky(await fetchText(`${base}&page=${page}`, { timeoutMs: 30_000 }));
    if (rows.length === 0) {
      if (page === 1) throw new Error(`Na edesky.cz nebyl nalezen žádný dokument (změnila se struktura stránky?): ${base}`);
      break; // hlubší stránky došly
    }
    for (const notice of rows) byId.set(notice.id, notice);
    if (page < pages) await sleep(EDESKY_PAGE_DELAY_MS);
  }

  // Agregátor dokumenty třídí podle obsahu příloh — tag "Dražby" zachytí i
  // dražbu s nic neříkajícím názvem, kterou by filtr z názvu minul.
  await sleep(EDESKY_PAGE_DELAY_MS);
  const drazby = parseEdesky(await fetchText(`${base}&tag=${encodeURIComponent("Dražby")}&page=1`, { timeoutMs: 30_000 }));
  for (const notice of drazby) {
    const existing = byId.get(notice.id) ?? notice;
    existing.tags = [...new Set([...(existing.tags ?? []), "Dražby"])];
    byId.set(existing.id, existing);
  }

  // Města, která se čtou přímo z jejich vlastní desky, tu nejsou podruhé.
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
      return board.url;
    default:
      throw new Error(`Neznámý typ úřední desky: ${board.type}`);
  }
}

const PARSERS = { vismo: parseVismo, joomla: parseJoomla, ginis: parseGinis };

/**
 * Stáhne poslední oznámení z desky obce. Nula oznámení = chyba (deska obce
 * není nikdy skutečně prázdná, takže je to skoro jistě změna struktury
 * stránky, ne "nic nového"). `deep` (první běh desky) čte hlouběji do
 * historie — týká se jen edesky, ostatní desky vrací vždy celé okno.
 */
export async function fetchBoardNotices(board, { deep = false } = {}) {
  if (board.type === "edesky") return fetchEdesky(board, { deep });
  const url = listUrl(board);
  const html = await fetchText(url, { timeoutMs: 30_000 });
  const notices = PARSERS[board.type](html, url);
  if (notices.length === 0) {
    throw new Error(`Na úřední desce nebylo nalezeno žádné oznámení (změnila se struktura stránky?): ${url}`);
  }
  return notices;
}
