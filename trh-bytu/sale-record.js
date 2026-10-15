// Jediné místo, které z údajů o prodeji bytu — z KTERÉHOKOLI formuláře (fronta
// Katastr, detail bytu, tabulka srovnání) — skládá zápis do databáze. Dřív si
// každý formulář řešil zápis po svém, takže cena zadaná v detailu nenastavila
// "prodáno" (byt pak zůstal ve frontě Katastr a mimo "Prodáno" ve statistikách)
// a naopak.
//
// Údaje o prodeji jsou tyhle sloupce, vždy zapsané na VŠECHNY nabídky jednoho
// bytu (group.js): `sale_verdict`, `kn_filed_at`, `lv_number`, `unit_number`,
// `verified_sale_price_czk`, `verified_sale_date`, `kn_checked_at`.
//
// Pravidlo, které drží pohromadě: cena, datum prodeje nebo podaný vklad
// znamenají, že je byt PRODANÝ — zapíšou i verdikt, pokud ho byt ještě nemá.
// Čistá logika bez DB, ať jde otestovat.

import { parseUnitNumber, formatUnitNumber } from "./kn-api.js";
import { saleVerdict, pickOwnValue } from "./group.js";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const LV_RE = /^[0-9A-Za-z/ -]{1,20}$/;

function isDay(value) {
  return typeof value === "string" && DAY_RE.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * Hodnota z formuláře → "beze změny" (`undefined`), "vymazat" (`null`), nebo
 * hodnota. Neplatná hodnota (ručně upravené URL, překlep) je "beze změny":
 * appka si žádnou hodnotu nevymýšlí ani kvůli ní nemaže správnou.
 */
function field(value, normalize) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = String(value).trim();
  if (text === "") return null;
  const normalized = normalize(text);
  return normalized == null ? undefined : normalized;
}

/**
 * @param input    každé pole: `undefined` = beze změny, `null` nebo prázdný text =
 *                 vymazat, jinak hodnota
 *   - `verdict`   'sold' | 'withdrawn' — výslovný verdikt
 *   - `filedAt`   den podání vkladu (YYYY-MM-DD, budoucnost se ořízne na dnešek)
 *   - `lv`        číslo LV
 *   - `unit`      číslo jednotky ("412/12" se sjednotí s číslem z API)
 *   - `price`     kupní cena v Kč (kladná)
 *   - `saleDate`  datum prodeje (YYYY-MM-DD)
 *   - `checked`   jen zapsat, že se kontrolovalo ("Zatím nic")
 *   - `reset`     vrátit byt mezi nerozhodnuté (smaže verdikt, vklad, kontrolu, cenu a datum prodeje)
 * @param current  stav bytu před zápisem: `{ verdict, filedAt, autoUnit }`
 * @param now      ISO čas zápisu
 * @returns objekt sloupců ke zápisu (prázdný, když není co měnit)
 */
export function buildSaleRecordUpdates({ input, current, now }) {
  const today = now.slice(0, 10);

  if (input.reset) {
    // Smaže i cenu a datum prodeje: cena znamená prodáno, takže byt, který se
    // vrací mezi nerozhodnuté, ji mít nesmí (jinak by ho příští start appky
    // zase označil jako prodaný). LV a jednotka zůstávají — patří bytu.
    const updates = { sale_verdict: null, kn_checked_at: null, kn_filed_at: null, kn_digest_cp: null, verified_sale_price_czk: null, verified_sale_date: null };
    // Vrací-li uživatel odhad appky ("není to ten byt"), appka mu už automaticky
    // nic nepřiřadí (kn-scan.js, matchFilings).
    if (current.autoUnit) Object.assign(updates, { kn_auto_unit: null, kn_auto_off: 1 });
    return updates;
  }

  const updates = {};
  const price = field(input.price, (t) => {
    const n = Number(t);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  });
  const saleDate = field(input.saleDate, (t) => (isDay(t) ? t : null));
  const filedAt = field(input.filedAt, (t) => (isDay(t) ? (t <= today ? t : today) : null));
  const lv = field(input.lv, (t) => (LV_RE.test(t) ? t : null));
  const unit = field(input.unit, (t) => {
    const clipped = t.slice(0, 60);
    const parsed = parseUnitNumber(clipped);
    return parsed != null ? formatUnitNumber(parsed) : clipped;
  });

  if (price !== undefined) updates.verified_sale_price_czk = price;
  if (saleDate !== undefined) updates.verified_sale_date = saleDate;
  if (filedAt !== undefined) updates.kn_filed_at = filedAt;
  if (lv !== undefined) updates.lv_number = lv;
  if (unit !== undefined) {
    updates.unit_number = unit;
    // Ručně zapsaná jednotka nahrazuje odhad appky.
    if (current.autoUnit) updates.kn_auto_unit = null;
  }

  const impliesSale = price != null || saleDate != null || filedAt != null;
  if (input.verdict) updates.sale_verdict = input.verdict;
  else if (impliesSale && current.verdict !== "sold") updates.sale_verdict = "sold";

  if (updates.sale_verdict || input.checked) updates.kn_checked_at = now;
  return updates;
}

/** Stav bytu před zápisem — z nabídek skupiny (viz group.js). */
export function currentSaleState(members) {
  return {
    verdict: saleVerdict(members),
    filedAt: pickOwnValue(members, "kn_filed_at"),
    autoUnit: pickOwnValue(members, "kn_auto_unit"),
  };
}

// Družstevní byt prodaný podle portálu se v katastru ověřit nedá, takže se
// bere poslední INZEROVANÁ cena. Ta ale bývá o pár procent vyšší než kupní (po
// vyjednávání se byt prodá níž), proto se do statistik počítá snížená o tohle.
// Cena se nikam neukládá, počítá se při čtení: jakmile uživatel zadá skutečnou
// cenu, platí ta.
export const ASSUMED_PRICE_DISCOUNT = 0.1;

export function assumedSalePrice(lastPrice) {
  return lastPrice == null ? null : Math.round(lastPrice * (1 - ASSUMED_PRICE_DISCOUNT));
}

/**
 * Cena bytu pro statistiky a její původ:
 *  - `verified`: kupní cena zadaná z katastru;
 *  - `assumed`: družstevní byt, poslední inzerovaná cena snížená o ASSUMED_PRICE_DISCOUNT;
 *  - `asking`: poslední inzerovaná cena beze změny (zatím neověřená).
 */
export function statsSalePrice({ verified, price, assumed }) {
  if (verified != null) return { price: verified, basis: "verified" };
  if (assumed && price != null) return { price: assumedSalePrice(price), basis: "assumed" };
  return { price: price ?? null, basis: "asking" };
}

/**
 * "Aspoň částečně prodaný" byt — to, o co v appce hlavně jde: je prodaný
 * (verdikt z katastru, nebo to říká portál), po rezervaci zmizel ze všech
 * portálů (inzerát se po rezervaci stahuje), nebo je zatím rezervovaný.
 * Zmizelý byt BEZ rezervace sem nepatří, je to jen "možný prodej".
 * "Neprodáno" z katastru tohle vylučuje. Rezervace, která padne, byt vrátí do
 * nabídky, takže z přehledu sama zmizí.
 */
export function isAlmostSold({ status, verdict, wasReserved }) {
  if (verdict === "withdrawn") return false;
  return status === "sold" || status === "reserved" || (status === "removed" && Boolean(wasReserved));
}

/** Na čem prodej bytu stojí: "sold" (prodáno) | "gone" (po rezervaci zmizelo) | "reserved" (rezervováno). */
export function saleEvidence(status) {
  return status === "sold" ? "sold" : status === "reserved" ? "reserved" : "gone";
}
