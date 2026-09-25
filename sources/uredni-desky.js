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
//
// Všechny parsery vrací totéž: `{ id, title, description, category, url,
// postedFrom, postedTo }`. `id` je stabilní v rámci desky (slouží k dedup),
// data jsou ISO `YYYY-MM-DD` (nebo null). Parsery jsou čisté funkce nad HTML
// (bez sítě), ať jdou testovat nad uloženými stránkami.
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
 * stránky, ne "nic nového").
 */
export async function fetchBoardNotices(board) {
  const url = listUrl(board);
  const html = await fetchText(url, { timeoutMs: 30_000 });
  const notices = PARSERS[board.type](html, url);
  if (notices.length === 0) {
    throw new Error(`Na úřední desce nebylo nalezeno žádné oznámení (změnila se struktura stránky?): ${url}`);
  }
  return notices;
}
