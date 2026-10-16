// Údaje o bytě, které se nedají zjistit ("Nezjistitelné"). Úkol "Doplnit chybějící
// údaje" (dashboard.js) jinak visí, dokud údaj nikdo nevyplní — a některý se
// vyplnit prostě nedá (inzerát o stavu mlčí a nikdo neví). Označený údaj se u
// bytu z úkolu vyřadí; nic se nemaže a jde to vrátit.
//
// Ukládá se na byt jako celek (všechny nabídky skupiny) jako JSON pole klíčů
// (ESSENTIAL_FIELDS) ve sloupci listings.unknown_fields. Čistá logika bez DB.

import { ESSENTIAL_FIELDS } from "./dashboard.js";

export const ESSENTIAL_KEYS = ESSENTIAL_FIELDS.map((f) => f.key);

function parseOne(raw) {
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((k) => ESSENTIAL_KEYS.includes(k)) : [];
  } catch {
    return [];
  }
}

/** Klíče údajů označených jako nezjistitelné — sjednocení přes všechny nabídky bytu. */
export function parseUnknownFields(members) {
  return ESSENTIAL_KEYS.filter((key) => members.some((m) => parseOne(m.unknown_fields).includes(key)));
}

/** Seznam po přidání klíčů (neplatné klíče se zahodí, pořadí je stálé). */
export function addUnknownFields(current, keys) {
  return ESSENTIAL_KEYS.filter((k) => current.includes(k) || keys.includes(k));
}

/** Seznam po odebrání klíčů; bez `keys` se odebere všechno. */
export function removeUnknownFields(current, keys = null) {
  return keys ? current.filter((k) => !keys.includes(k)) : [];
}

/** Hodnota do sloupce: JSON pole, nebo null, když nic není. */
export function serializeUnknownFields(list) {
  return list.length ? JSON.stringify(list) : null;
}

/** "dispozice,plocha" (z formuláře) → platné klíče. */
export function parseFieldList(text) {
  return String(text ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((k) => ESSENTIAL_KEYS.includes(k));
}

/** Popisky klíčů pro uživatele: ["stav (před/po rekonstrukci)", "vlastnictví"]. */
export function labelsOf(keys) {
  return ESSENTIAL_FIELDS.filter((f) => keys.includes(f.key)).map((f) => f.label);
}
