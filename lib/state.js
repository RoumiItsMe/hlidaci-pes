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

/**
 * Pro dané sledování (klíč `<watch.key>:__fingerprints`) vrátí Mapu
 * `fingerprint -> zdroj, který ho nahlásil jako první`. Fingerprint (viz
 * `computeFingerprint` v index.js) identifikuje stejnou reálnou nemovitost
 * napříč RŮZNÝMI portály — na rozdíl od `getSourceItems` (dedup uvnitř
 * jednoho portálu podle ID) tohle dedupuje NAPŘÍČ portály v rámci jednoho
 * sledování, ať stejná nabídka na 3 portálech nedorazí jako 3 notifikace.
 */
export function getFingerprintMap(state, key) {
  const list = Array.isArray(state[key]) ? state[key] : [];
  const map = new Map();
  for (const entry of list) {
    if (entry && typeof entry === "object" && entry.fingerprint) {
      map.set(entry.fingerprint, entry.source ?? null);
    }
  }
  return map;
}

/** Uloží Mapu fingerprintů zpátky do stavu, ořezanou na `maxKeep` záznamů. */
export function setFingerprintMap(state, key, fpMap, maxKeep) {
  const entries = [...fpMap.entries()].map(([fingerprint, source]) => ({ fingerprint, source }));
  state[key] = entries.slice(-maxKeep);
}

/**
 * Nedávno ohlášené změny ceny (klíč `<watch.key>:__changes`): Mapa
 * `changeKey -> { source, sourceLabel, at }`, viz `priceChangeDuplicate` v lib/dedup.js.
 * Záznamy starší než `maxAgeMs` se zahodí hned při načtení, takže stav nenarůstá.
 */
export function getChangeMap(state, key, maxAgeMs, now = Date.now()) {
  const list = Array.isArray(state[key]) ? state[key] : [];
  const map = new Map();
  for (const entry of list) {
    if (!entry || typeof entry !== "object" || !entry.key || !entry.source) continue;
    if (!(now - Date.parse(entry.at) <= maxAgeMs)) continue;
    map.set(entry.key, { source: entry.source, sourceLabel: entry.sourceLabel ?? null, at: entry.at });
  }
  return map;
}

/** Uloží Mapu změn ceny zpátky do stavu, ořezanou na `maxKeep` nejnovějších. */
export function setChangeMap(state, key, changeMap, maxKeep) {
  const entries = [...changeMap.entries()].map(([k, v]) => ({ key: k, source: v.source, sourceLabel: v.sourceLabel ?? null, at: v.at }));
  state[key] = entries.slice(-maxKeep);
}

// --- Sloučení stavu po souběhu pushů (scripts/run-and-commit.sh) ---
//
// Když `git push` po běhu selže, protože na `main` mezitím přibyly jiné commity, nesmí se
// detekce pustit znovu: notifikace tohoto běhu už odešly a druhý průchod by je poslal podruhé
// (viděno naostro 22. 10. 2026 — dvě změny ceny dvakrát, 4 zprávy místo 2). Stav tohoto běhu
// se proto přenese přes nový stav z `main` — trojcestně: `base` je stav, ze kterého běh
// vyšel, `ours` jeho výsledek, `theirs` aktuální stav na `main`.

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Klíč položky seznamu: inzerát { id }, otisk { fingerprint }, změna ceny { key }, nebo samotný řetězec (ID desky).
function entryKey(entry) {
  if (typeof entry === "string") return entry;
  return entry?.id ?? entry?.fingerprint ?? entry?.key ?? null;
}

function mergeLists(ours, theirs, maxKeep) {
  const everyKeyed = [...ours, ...theirs].every((e) => entryKey(e) != null);
  if (!everyKeyed) return ours; // neznámý tvar — nepokoušíme se hádat
  // Pořadí: nejdřív to, co už je na main, nové z tohoto běhu za tím. Shoda → hodnota z tohoto
  // běhu (novější pozorování, např. změněná cena); Map.set na existující klíč drží původní pozici.
  const byKey = new Map(theirs.map((e) => [entryKey(e), e]));
  for (const e of ours) byKey.set(entryKey(e), e);
  return [...byKey.values()].slice(-maxKeep);
}

function mergeValue(base, ours, theirs, maxKeep) {
  if (sameValue(ours, base)) return theirs; // tenhle běh na hodnotě nic neměnil
  if (sameValue(theirs, base)) return ours; // main ji nezměnil
  if (ours === undefined) return theirs;
  if (theirs === undefined) return ours;
  if (isPlainObject(ours) && isPlainObject(theirs)) {
    const out = {};
    for (const k of new Set([...Object.keys(theirs), ...Object.keys(ours)])) {
      out[k] = mergeValue(isPlainObject(base) ? base[k] : undefined, ours[k], theirs[k], maxKeep);
    }
    return out;
  }
  if (Array.isArray(ours) && Array.isArray(theirs)) return mergeLists(ours, theirs, maxKeep);
  return ours;
}

/** Trojcestné sloučení stavu (viz výše); `maxKeep` ořezává seznamy jako setSourceItems. */
export function mergeStates(base, ours, theirs, maxKeep = 500) {
  return mergeValue(base ?? {}, ours, theirs, maxKeep);
}
