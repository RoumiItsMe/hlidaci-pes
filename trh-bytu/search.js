// Vyhledávání bytů na stránce Byty. Čisté funkce bez DB; byt = "entry" z computeEntries (entries.js).
//
// Hledá se bez ohledu na velikost písmen a diakritiku ("sporitelni" najde "Spořitelní") a každé zadané slovo
// musí být v bytu NĚKDE — v adrese, názvu, ID či odkazu inzerátu, poznámce, LV, parametrech nebo v popisu kterékoli
// nabídky téhož bytu (portály mají každý jiný text). Číslo zapsané s mezerami ("3 450 000") se bere jako jedno.
//
// Dvě úrovně shody: `core` = adresa, název, ID, odkaz, poznámka… (to uživatel typicky hledá), `text` = celý popis
// inzerátu. Byt, který odpovídá už podle `core`, je výš; shoda jen v popisu se doplní úryvkem, ať je vidět, proč
// byt vyšel.

import { descriptionForDetection } from "./listing-text.js";

// Foldování po JEDNOM znaku (diakritika pryč, malá písmena), ať se délka řetězce nemění a pozice shody v
// složeném textu sedí na původní text (úryvek se zvýrazněním).
export function fold(text) {
  return Array.from(String(text ?? ""), (ch) => {
    const f = ch.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    return f.length === 1 ? f : ch.toLowerCase().slice(0, 1) || " ";
  }).join("");
}

/** Dotaz → slova (složená, bez prázdných). Čísla s mezerami po tisících se slepí: "3 450 000" → "3450000". */
export function parseQuery(raw) {
  const text = fold(raw).replace(/(?<=\d)\s+(?=\d{3}(?!\d))/g, "");
  return text.split(/\s+/).filter(Boolean);
}

/** Texty bytu, které uživatel hledá jako první (adresa, název, ID, odkaz, poznámka, LV, parametry, cena). */
function coreFields(entry) {
  const members = entry.g.members;
  return [
    entry.address,
    entry.city,
    entry.addressInfo?.exact,
    entry.addressInfo?.unit,
    entry.notes,
    entry.sellerMotivation,
    entry.lvNumber,
    entry.priceLabel,
    entry.price != null ? String(entry.price) : null,
    entry.rep?.disposition,
    entry.rep?.area_m2 != null ? `${entry.rep.area_m2} m2` : null,
    entry.params?.ownership,
    ...members.flatMap((m) => [m.title, m.address, m.exact_address, m.id, m.source_id, m.url, m.disposition, m.price_czk != null ? String(m.price_czk) : null]),
  ].filter(Boolean);
}

/** Popisy všech nabídek bytu (u RealityMIX z geo_json, viz listing-text.js). */
function textFields(entry) {
  return entry.g.members.map((m) => descriptionForDetection(m)).filter(Boolean);
}

/**
 * Odpovídá byt dotazu? `null`, když ne; jinak `{ tier, context }`:
 *  - tier 0: všechna slova jsou v adrese/názvu/ID/…, tier 1: aspoň jedno slovo je jen v popisu;
 *  - context: úryvek z popisu kolem první shody (jen u tier 1), `{ before, match, after }` v původním textu.
 * Prázdný dotaz (`tokens` bez slov) odpovídá všemu s tier 0.
 */
export function searchEntry(entry, tokens) {
  if (!tokens.length) return { tier: 0, context: null };
  const core = fold(coreFields(entry).join(" | "));
  const rest = tokens.filter((t) => !core.includes(t));
  if (!rest.length) return { tier: 0, context: null };
  // Co v jádru chybí, musí být v popisu některé nabídky (každé slovo klidně v jiném).
  const descriptions = textFields(entry);
  const folded = descriptions.map(fold);
  if (!rest.every((t) => folded.some((d) => d.includes(t)))) return null;
  return { tier: 1, context: contextFor(descriptions, folded, rest[0]) };
}

const CONTEXT_RADIUS = 60;

function contextFor(descriptions, folded, token) {
  for (let i = 0; i < descriptions.length; i++) {
    const at = folded[i].indexOf(token);
    if (at < 0) continue;
    const text = descriptions[i].replace(/\s+/g, " ");
    // Zploštění mezer změní pozice; hledá se proto znovu v očištěném textu.
    const foldedText = fold(text);
    const pos = foldedText.indexOf(token);
    if (pos < 0 || foldedText.length !== text.length) return { before: "", match: "", after: text.slice(0, CONTEXT_RADIUS * 2) };
    const from = Math.max(0, pos - CONTEXT_RADIUS);
    const to = Math.min(text.length, pos + token.length + CONTEXT_RADIUS);
    return { before: (from > 0 ? "…" : "") + text.slice(from, pos), match: text.slice(pos, pos + token.length), after: text.slice(pos + token.length, to) + (to < text.length ? "…" : "") };
  }
  return null;
}
