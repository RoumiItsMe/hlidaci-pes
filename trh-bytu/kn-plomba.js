// Co ze skenu domu (kn-api.js) platí pro konkrétní byt. Čistá logika bez
// DB/HTTP, aby šla otestovat.
//
// Dva režimy:
//  - jednotka bytu je známá (uživatel ji zapsal) → díváme se jen na ni a
//    plomba po rezervaci je silný důkaz o prodeji;
//  - jednotka neznámá → ukážeme všechny jednotky domu s plombou po rezervaci
//    jako NÁPOVĚDU. V domě se často prodává víc bytů najednou, takže plomba
//    sama o sobě neříká, že je to ten náš — rozhodne uživatel.
//
// Rozhodují jen řízení typu V (vklad vlastnického práva a dalších práv).
// Plomba z doby před rezervací (s rezervou) k prodeji tohoto bytu nepatří.

import { formatUnitNumber } from "./kn-api.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// Podaný vklad může předběhnout zápis rezervace (rezervace se v inzerátu často
// objeví se zpožděním), proto rezerva.
export const FILING_GRACE_DAYS = 14;

/** Řízení typu V přijatá po (rezervace − rezerva). */
export function qualifyingProceedings(proceedings, reservedAt) {
  const from = Date.parse(reservedAt) - FILING_GRACE_DAYS * DAY_MS;
  return proceedings.filter((r) => r.typ === "V" && r.datumPrijeti && Date.parse(r.datumPrijeti) >= from);
}

function earliestDay(proceedings) {
  const days = proceedings.map((r) => r.datumPrijeti.slice(0, 10)).sort();
  return days[0];
}

/**
 * @param scan        výsledek scanBuilding (z DB)
 * @param reservedAt  začátek rezervace (ISO)
 * @param unitNumber  číslo jednotky z API (parseUnitNumber), nebo null
 * @returns `{ scannedAt, unitCount, mode, unit, candidates, closed, incomplete }`
 *   candidates: `[{ number, label, lv, share, filedAt, proceedings }]` — jednotky s plombou po rezervaci
 *   closed:     `[{ number, label, lv, proceeding }]` — řízení, která po rezervaci začala a už skončila
 *   incomplete: sken neprošel všechny jednotky, v režimu bez čísla jednotky proto nic netvrdíme
 */
export function analyzePlombas(scan, { reservedAt, unitNumber = null }) {
  const mode = unitNumber != null ? "unit" : "building";
  const base = { scannedAt: scan.scannedAt, unitCount: scan.units.length, mode, unit: null, candidates: [], closed: [], incomplete: false };

  if (mode === "unit") {
    const exists = scan.units.find((u) => u.number === unitNumber);
    base.unit = { number: unitNumber, label: formatUnitNumber(unitNumber), lv: exists?.lv ?? null, missing: !exists };
  } else if (!scan.full) {
    return { ...base, incomplete: true };
  }

  const keep = (number) => mode === "building" || number === unitNumber;
  for (const p of scan.plomby) {
    if (!keep(p.unit)) continue;
    const proceedings = qualifyingProceedings(p.rizeni, reservedAt);
    if (!proceedings.length) continue;
    const u = scan.units.find((x) => x.number === p.unit);
    base.candidates.push({ number: p.unit, label: formatUnitNumber(p.unit), lv: p.lv ?? u?.lv ?? null, share: u?.share ?? null, filedAt: earliestDay(proceedings), proceedings });
  }
  base.candidates.sort((a, b) => a.filedAt.localeCompare(b.filedAt) || a.number - b.number);

  for (const c of scan.closed ?? []) {
    if (!keep(c.unit) || !qualifyingProceedings([c.proceeding], reservedAt).length) continue;
    base.closed.push({ number: c.unit, label: formatUnitNumber(c.unit), lv: c.lv ?? null, proceeding: c.proceeding });
  }
  return base;
}

const CS_DATE = new Intl.DateTimeFormat("cs-CZ", { day: "numeric", month: "numeric", year: "numeric", timeZone: "Europe/Prague" });
export function formatDay(iso) {
  return CS_DATE.format(new Date(iso.length === 10 ? `${iso}T12:00:00` : iso));
}

/** "č. 93/4 (LV 6319) — podáno 24. 9. 2026, 1. 10. 2026" */
export function describeCandidate(c) {
  const days = c.proceedings.map((r) => formatDay(r.datumPrijeti)).join(", ");
  return `č. ${c.label}${c.lv ? ` (LV ${c.lv})` : ""} — podáno ${days}${c.proceedings.length > 1 ? ` (${c.proceedings.length} řízení)` : ""}`;
}

/**
 * Jedna věta pro Telegram souhrn / kartu, nebo null, když není co říct.
 * Bez plomby se nepíše nic — souhrn je o tom, co se stalo.
 */
export function plombaHintLine(analysis) {
  if (!analysis) return null;
  if (analysis.mode === "unit") {
    if (analysis.unit.missing) return `⚠️ Jednotka ${analysis.unit.label} v domě neexistuje — zkontroluj číslo.`;
    const c = analysis.candidates[0];
    if (c) return `🔖 Jednotka ${analysis.unit.label}: vklad podán ${formatDay(c.filedAt)}`;
    return null;
  }
  if (!analysis.candidates.length) return null;
  const shown = analysis.candidates.slice(0, 3).map(describeCandidate).join("; ");
  const more = analysis.candidates.length > 3 ? ` (+${analysis.candidates.length - 3} dalších)` : "";
  return `🔎 V domě je podaný vklad: ${shown}${more} — jednotka bytu není zapsaná, tak to potvrď v appce.`;
}

// Sken starší než tohle už dům nehlídá (rozpočet volání nestačil, nebo API
// přestalo odpovídat) — ruční kontroly podle rozvrhu se vrátí. Víc než cyklus
// skenu (kn-scan.js, 5 dní), ať jeden zmeškaný den nevyvolá falešný poplach.
export const WATCH_MAX_AGE_DAYS = 8;

/**
 * Hlídá API plomby u tohoto bytu natolik, že ruční kontrola v katastru nic
 * nepřinese? Vrací:
 *  - `null`: nehlídá (dům nemá sken, sken je starý, je neúplný, nebo zapsaná
 *    jednotka v domě není) → platí ruční rozvrh kontrol;
 *  - `{ unverifiable: true }`: dům nemá v katastru vymezené jednotky (typicky
 *    družstevní byty) — vklad tu nevznikne a nic se nedá ověřit;
 *  - `{ needsConfirm, confirmAt }`: dům hlídáme; `needsConfirm`, když API našlo
 *    plombu po rezervaci, kterou appka sama k bytu nepřiřadila (kn-scan.js,
 *    matchFilings) — tu musí potvrdit uživatel. `confirmAt` = den podání (ms).
 */
export function apiWatch(scan, { reservedAt, unitNumber = null, now = Date.now() }) {
  if (!scan) return null;
  if (now - Date.parse(scan.scannedAt) > WATCH_MAX_AGE_DAYS * DAY_MS) return null;
  if (!scan.units.length) return { needsConfirm: false, confirmAt: null, unverifiable: true };
  const analysis = analyzePlombas(scan, { reservedAt, unitNumber });
  if (analysis.incomplete || analysis.unit?.missing) return null;
  const first = analysis.candidates[0];
  return { needsConfirm: Boolean(first), confirmAt: first ? Date.parse(first.filedAt) : null, unverifiable: false };
}
