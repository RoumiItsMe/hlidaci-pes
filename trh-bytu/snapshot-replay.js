// Přehrání snímků z cloudového sběrače (scout.js, snapshot.js) při startu sběru na PC. Sběrač denně uloží do soukromého
// repozitáře, co bylo na portálech; appka si je stáhne (`git pull`) a zapíše stejnými pravidly jako běžný sběr
// (process-source.js), jen s časem pozorování. Po týdnu bez PC tak zná změny po dnech místo "všechno dnes".
//
// Zapnuté jen s `TRH_SNAPSHOT_REPO` (cesta k lokálnímu klonu repozitáře se snímky, nastavuje se v `.env.local`);
// bez něj se nedělá nic a sběr běží jako dřív. Snímky leží v `<repo>/snapshots/<region>/<čas>.json`.
//
// Co se přehrává: snímky NOVĚJŠÍ než `snapshots_applied_until` (app_state) — čas posledního přehraného snímku nebo
// posledního běžného sběru na PC, podle toho, co je později (viz markLiveRun). Snímek starší než poslední sběr na PC
// by jen opakoval, co appka už ví. Přehrává se od nejstaršího, takže zmizení se potvrdí druhým snímkem po odstupu a
// datuje se prvním nenalezením.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { collectedAtFromFile, isValidSnapshot } from "./snapshot.js";
import { processSource } from "./process-source.js";

export const APPLIED_KEY = "snapshots_applied_until";
// Zdroj, který byl v databázi aktivní aspoň u tolika nabídek a ve snímku má NULA nabídek, je podezřelý (výpadek portálu,
// změna stránky) — takový výpis se nepřehrává, ať nevzniknou falešná zmizení. Malý zdroj (Bezrealitky) smí být prázdný.
export const EMPTY_LIST_GUARD_MIN_ACTIVE = 10;
const PULL_TIMEOUT_MS = 60_000;

export function getAppliedUntil(db) {
  return db.prepare("SELECT value FROM app_state WHERE key = ?").get(APPLIED_KEY)?.value ?? null;
}

export function setAppliedUntil(db, iso) {
  db.prepare("INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(APPLIED_KEY, iso);
}

/** Běžný sběr na PC pozoroval všechno do tohoto okamžiku — starší snímky už nejsou potřeba. Nikdy nevrací čas zpět. */
export function markLiveRun(db, iso) {
  const current = getAppliedUntil(db);
  if (!current || current < iso) setAppliedUntil(db, iso);
}

/** Odkud přehrávat, když ještě nic nepřehrávalo: poslední pozorování, které appka zná (nová databáze = vše). */
function baseline(db) {
  return getAppliedUntil(db) ?? db.prepare("SELECT MAX(last_seen_at) AS t FROM listings").get()?.t ?? "";
}

/** Aktualizuje lokální klon se snímky. Selhání (offline, přihlášení) nic nerozbije — použijí se snímky na disku. */
export function pullSnapshotRepo(repoDir, log, exec = execFileSync) {
  try {
    exec("git", ["-C", repoDir, "pull", "--ff-only", "--quiet"], { timeout: PULL_TIMEOUT_MS, stdio: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    return true;
  } catch (err) {
    log(`Stažení snímků z cloudu (git pull) selhalo: ${String(err.message).split("\n")[0]} — použijí se snímky, které už jsou na disku.`);
    return false;
  }
}

/** Soubory snímků regionu novější než `after`, od nejstaršího. */
export function pendingSnapshots(repoDir, regionKey, after) {
  const dir = path.join(repoDir, "snapshots", regionKey);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((file) => ({ file: path.join(dir, file), collectedAt: collectedAtFromFile(file) }))
    .filter((s) => s.collectedAt && s.collectedAt > after)
    .sort((a, b) => a.collectedAt.localeCompare(b.collectedAt));
}

const activeCount = (db, source) => db.prepare("SELECT COUNT(*) AS c FROM listings WHERE source = ? AND status IN ('active','reserved')").get(source).c;

/**
 * Přehraje nepřehrané snímky regionu. Vrací `{ enabled, applied, skipped }` (počet snímků).
 *
 * @param sources `[{ name, fetchDetail, … }]` — zdroje regionu (sources-config.js)
 * @param pull    stažení klonu (v testech náhrada)
 * @param deps    náhrady pro processSource (testy)
 */
export async function replaySnapshots({ db, sources, watch, regionKey, repoDir, log, pull = pullSnapshotRepo, deps }) {
  if (!repoDir || !existsSync(repoDir)) {
    if (repoDir) log(`Složka se snímky z cloudu neexistuje (${repoDir}) — přehrávání se přeskakuje.`);
    return { enabled: false, applied: 0, skipped: 0 };
  }
  pull(repoDir, log);
  const pending = pendingSnapshots(repoDir, regionKey, baseline(db));
  let applied = 0;
  let skipped = 0;
  for (const { file, collectedAt } of pending) {
    let snapshot;
    try {
      snapshot = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      log(`Snímek ${path.basename(file)} nejde přečíst (${err.message}) — přeskočen.`);
      skipped++;
      continue;
    }
    if (!isValidSnapshot(snapshot) || snapshot.region !== regionKey || snapshot.collectedAt !== collectedAt) {
      log(`Snímek ${path.basename(file)} není platný snímek regionu ${regionKey} — přeskočen.`);
      skipped++;
      continue;
    }
    log(`=== Přehrávám snímek z cloudu: ${collectedAt} ===`);
    for (const source of sources) {
      const entry = snapshot.sources[source.name];
      if (!entry?.ok) {
        log(`[${source.name}] ve snímku chybí výpis (${entry?.error ?? "zdroj tam není"}) — přeskočeno.`);
        continue;
      }
      if (entry.items.length === 0 && activeCount(db, source.name) >= EMPTY_LIST_GUARD_MIN_ACTIVE) {
        log(`[${source.name}] ve snímku je prázdný výpis, ale v databázi je ${activeCount(db, source.name)} aktivních nabídek — podezřelé, přeskočeno.`);
        continue;
      }
      await processSource(db, source, watch, { log, items: entry.items, observedAt: snapshot.collectedAt, deps });
    }
    setAppliedUntil(db, collectedAt);
    applied++;
  }
  if (pending.length) log(`Snímky z cloudu: přehráno ${applied}, přeskočeno ${skipped}.`);
  return { enabled: true, applied, skipped };
}
