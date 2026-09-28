// Dovyhodnocení zajímavého oznámení podle PŘÍLOHY (PDF): co se přesně dražší
// a jak velký je pozemek.
//
// Proč: z názvu ("Aukční vyhláška", "Záměr prodeje pozemku p.č. 1080/36 …")
// se často nepozná, jestli jde o byt, nebo o pár metrů čtverečních zahrady.
// Uživatel chce u dražeb pozemků slyšet jen o těch nad 100 m² — a výměra bývá
// jen v příloze ("o výměře 1 276 m2").
//
// Přílohu čteme JEN u oznámení, které už prošlo filtrem (typicky pár za den),
// ne u celé desky. Celé je to fail-open: když se soubor nepodaří najít,
// stáhnout nebo přečíst, oznámení se hlásí (radši zpráva navíc než promeškaná
// dražba) — jen bez údaje o výměře.
//
// Nečte se to u oznámení z agregátoru edesky.cz: jeho přílohy jsou pro roboty
// zakázané (robots.txt) a neregistrovaným uživatelům je ani nezobrazuje.

import * as cheerio from "cheerio";
import { extractText, getDocumentProxy } from "unpdf";
import { fetchBuffer, fetchText } from "./http.js";
import { extractAreaM2 } from "./notice-area.js";
import { fold } from "./notice-filter.js";

/** Pozemky do téhle výměry (včetně) se u dražeb nehlásí. */
export const MIN_LAND_AREA_M2 = 100;

// Odkaz na přílohu na stránce oznámení: Vismo (File.ashx), GINIS
// (souborL.php) nebo přímo .pdf.
const ATTACHMENT_HREF_RE = /File\.ashx|souborL\.php|\.pdf(?:$|[?#])/i;

// Delší text se nemá smysl parsovat — předmět dražby je na začátku vyhlášky.
const MAX_TEXT_CHARS = 60_000;

/** Adresa přílohy oznámení, nebo `null`. */
export async function resolveAttachmentUrl(notice, { getText = fetchText } = {}) {
  if (notice.viaEdesky) return null;
  if (notice.attachmentUrl) return notice.attachmentUrl;
  if (!notice.url) return null;
  if (ATTACHMENT_HREF_RE.test(notice.url)) return notice.url; // odkaz vede rovnou na soubor
  try {
    const $ = cheerio.load(await getText(notice.url, { timeoutMs: 20_000 }));
    const href = $("a[href]")
      .map((_, a) => $(a).attr("href"))
      .get()
      .find((h) => ATTACHMENT_HREF_RE.test(h));
    return href ? new URL(href, notice.url).toString() : null;
  } catch {
    return null;
  }
}

/** Text PDF přílohy, nebo `null` (není PDF, moc velké, nečitelné, chyba sítě). */
export async function readAttachmentText(url, { getBuffer = fetchBuffer } = {}) {
  try {
    const bytes = await getBuffer(url);
    if (!bytes || String.fromCharCode(...bytes.slice(0, 4)) !== "%PDF") return null;
    const pdf = await getDocumentProxy(bytes, { verbosity: 0 });
    const { text } = await extractText(pdf, { mergePages: true });
    return text.slice(0, MAX_TEXT_CHARS);
  } catch {
    return null;
  }
}

/**
 * Co se z textu vyhlášky pozná o předmětu: byt / dům / pozemek. Díváme se
 * jen na úsek za "Popis předmětu dražby" (nebo aspoň "Předmětem dražby") —
 * jinde v textu se běžně mluví o sousedních stavbách a v právní formulce
 * o "právech stavby, věcných břemenech…", takže by se dražený pozemek jevil
 * jako dům.
 */
export function describeSubject(text) {
  const f = fold(text);
  const described = f.search(/popis\s+predmetu/);
  const named = f.search(/predmet\w*\s+(?:verejne\s+)?(?:drazby|drazeb|aukce|prodeje)/);
  const at = described >= 0 ? described : named;
  const snippet = at >= 0 ? f.slice(at, at + 700) : f.slice(0, 2500);
  return {
    snippet,
    flat: /\bbytov\w+\s+jednotk|\bbyt\b|\bbytu\b|\bbyt\.?\s*c\./.test(snippet),
    house: /\b(?:rodinn\w+\s+dum|bytov\w+\s+dum|dum\s+c\.\s*p|budov\w+|stavba\s+c\.\s*p)\b/.test(snippet),
    land: /\bpozem\w*|\bparc\w*/.test(snippet),
    // "movitá věc" (díky \b nechytí "nemovitá"): dražba hrobu, auta, vybavení…
    movable: /\bmovit\w+\s+(?:vec|veci)\b/.test(snippet) && !/\bnemovit/.test(snippet),
  };
}

/**
 * Upřesní klasifikaci dražby podle přílohy a rozhodne, jestli se má vyřadit
 * (drobný pozemek). Vrací `{ skip, reason?, classification }` — `classification`
 * je původní doplněná o `areaM2` (výměra, když je známá), `mentionsFlat` a
 * `landOnly`. Jiné druhy oznámení než dražby se nemění.
 *
 * `deps` (`resolveUrl`, `readText`) jsou pro testy.
 */
export async function refineCandidate(notice, classification, deps = {}) {
  if (classification.kind !== "auction") return { skip: false, classification };

  const resolveUrl = deps.resolveUrl ?? resolveAttachmentUrl;
  const readText = deps.readText ?? readAttachmentText;

  const titleText = `${notice.title} ${notice.description ?? ""}`;
  let areaM2 = extractAreaM2(titleText);
  let mentionsFlat = classification.mentionsFlat === true;
  let landOnly = classification.landOnly === true;

  // Příloha se čte, jen když z názvu neplyne ani výměra, ani že jde o byt.
  if (areaM2 === null && !mentionsFlat) {
    const url = await resolveUrl(notice);
    const text = url ? await readText(url) : null;
    if (text) {
      const subject = describeSubject(text);
      if (subject.movable && !subject.flat && !subject.house && !subject.land) {
        return { skip: true, reason: "dražba movité věci", classification: { ...classification, areaM2 } };
      }
      mentionsFlat = subject.flat;
      landOnly = landOnly || (subject.land && !subject.flat && !subject.house);
      areaM2 = extractAreaM2(subject.snippet) ?? extractAreaM2(text);
    }
  }

  const refined = { ...classification, mentionsFlat, landOnly, areaM2 };
  if (landOnly && !mentionsFlat && areaM2 !== null && areaM2 <= MIN_LAND_AREA_M2) {
    return { skip: true, reason: `pozemek jen ${areaM2} m²`, classification: refined };
  }
  return { skip: false, classification: refined };
}
