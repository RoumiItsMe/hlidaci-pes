// Perzistence "už viděných" inzerátů — data/seen.json, commitované do repa
// (GitHub Actions ho po každém běhu commitne zpátky).
//
// Pro každou dvojici (sledování, zdroj) se pamatuje pole položek
// `{ id, price }` — `price` je poslední známá cena v Kč (nebo null, když
// nešla zjistit), potřebná pro detekci změny ceny. Pořadí pole = pořadí,
// v jakém byly ID poprvé zaznamenány — na tom stojí ořezávání na
// `maxKeep` nejnovějších (viz `setSourceItems`).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(__dirname, "..", "data", "seen.json");

/** Načte stav. Pokud soubor neexistuje (první běh), vrátí prázdný objekt. */
export async function loadState() {
  try {
    const raw = await readFile(STATE_PATH, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
}

/** Uloží stav zpátky na disk (formátovaně, ať je diff v gitu čitelný). */
export async function saveState(state) {
  await mkdir(path.dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

/**
 * Pro daný klíč (`<watch.key>:<source.name>`) vrátí Mapu známých položek
 * `id -> { price }`. Zpětně kompatibilní se starším formátem (prosté pole
 * ID bez ceny) — takové ID se načtou s `price: null`, takže se na nich
 * první běh po upgradu nespustí falešná notifikace o "změně" ceny (viz
 * guard v `index.js` — porovnává se jen známá cena proti známé ceně).
 */
export function getSourceItems(state, key) {
  const list = Array.isArray(state[key]) ? state[key] : [];
  const map = new Map();
  for (const entry of list) {
    if (typeof entry === "string") {
      map.set(entry, { price: null });
    } else if (entry && typeof entry === "object" && entry.id) {
      map.set(entry.id, { price: entry.price ?? null });
    }
  }
  return map;
}

/** Uloží Mapu zpátky do stavu, ořezanou na `maxKeep` nejnovějších záznamů. */
export function setSourceItems(state, key, itemsMap, maxKeep) {
  const entries = [...itemsMap.entries()].map(([id, data]) => ({ id, price: data.price ?? null }));
  state[key] = entries.slice(-maxKeep);
}
