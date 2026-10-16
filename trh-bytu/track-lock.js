// Zámek sběrného běhu (track.js): v jednu chvíli smí běžet jen jeden. Souběh
// hrozí, jakmile se sběr dá spustit i ručně (tlačítko "Aktualizovat teď" na
// přehledu) vedle plánované úlohy (denně v 8:00 + dohánění po startu / probuzení
// PC) — dva běhy najednou by si šlapaly po stejných řádcích (dvojí založení
// nového inzerátu, dvojí upozornění).
//
// Zámek je soubor s PID a časem startu. Starší než STALE_LOCK_MS se ignoruje
// (běh spadl, nebo ho někdo zabil, a soubor po něm zůstal) — celý sběr trvá
// minuty, ne půl hodiny.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const STALE_LOCK_MS = 30 * 60 * 1000;

/** Platný (nezastaralý) zámek `{ pid, startedAt }`, jinak null. */
export function readTrackLock(lockPath, now = Date.now()) {
  try {
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    if (now - Date.parse(lock.startedAt) < STALE_LOCK_MS) return lock;
  } catch {
    // Žádný zámek, nebo nečitelný — bereme jako volno.
  }
  return null;
}

/** Zkusí zámek převzít. false = jiný běh právě probíhá. */
export function acquireTrackLock(lockPath, { now = Date.now(), pid = process.pid } = {}) {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const data = JSON.stringify({ pid, startedAt: new Date(now).toISOString() });
  try {
    writeFileSync(lockPath, data, { flag: "wx" }); // atomicky: soubor buď vznikne, nebo už existuje
    return true;
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
  if (readTrackLock(lockPath, now)) return false;
  // Zastaralý zámek po spadlém běhu: převezmeme ho.
  rmSync(lockPath, { force: true });
  try {
    writeFileSync(lockPath, data, { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}

/** Uvolní zámek, jen když je pořád náš (po převzetí zastaralého ho nesmí smazat cizí běh). */
export function releaseTrackLock(lockPath, pid = process.pid) {
  try {
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    if (lock.pid === pid) rmSync(lockPath, { force: true });
  } catch {
    // Už není.
  }
}
