// Perzistence "už viděných" inzerátů — data/seen.json, commitované do repa
// (GitHub Actions ho po každém běhu commitne zpátky).

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
 * Pro daný zdroj vrátí Set známých ID a helper na jejich doplnění.
 * `maxKeep` omezuje, kolik posledních ID si pro zdroj pamatujeme.
 */
export function getSourceSeen(state, source) {
  const list = Array.isArray(state[source]) ? state[source] : [];
  return new Set(list);
}

export function setSourceSeen(state, source, idsSet, maxKeep) {
  const ids = [...idsSet];
  state[source] = ids.slice(-maxKeep);
}
