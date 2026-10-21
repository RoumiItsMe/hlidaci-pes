// Záloha dat Trh bytů (databáze, volitelně fotky) do složky, kterou synchronizuje
// Dropbox (nebo jakákoli jiná). Historie nabídek se nedá zpětně dohledat — portály ji
// nedrží — takže databáze na jednom počítači je jediná kopie.
//
//  - ŽIVÁ databáze se do Dropboxu NIKDY nedává (SQLite + synchronizace souborů za
//    běhu databázi poškodí). Zálohuje se konzistentní SNÍMEK (`VACUUM INTO`), který se
//    nejdřív ověří (integrity_check) a teprve pak atomicky přejmenuje na výsledný název.
//  - Jeden snímek na den (`trh-bytu-RRRR-MM-DD.sqlite`, další běh téhož dne ho nahradí),
//    drží se posledních KEEP_SNAPSHOTS.
//  - Fotky (stovky MB) jen na požádání (TRH_BACKUP_PHOTOS=1 / --photos): kopírují se jen nové
//    soubory a ze zálohy se nikdy nemaže — záloha není zrcadlo.
//  - Cíl: TRH_BACKUP_DIR (`.env.local` nebo prostředí), jinak složka "Trh bytu - zaloha"
//    v Dropboxu podle jeho vlastního info.json. Bez cíle se záloha přeskočí.
//  - Nevyhazuje: sběr (track.js) běží bez dohledu a záloha ho nesmí shodit.
//
// Obnovení: zavři appku, zkopíruj snímek jako `data/trh-bytu.sqlite` (smaž vedle něj
// `-wal` a `-shm`), spusť appku.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

export const KEEP_SNAPSHOTS = 30;
export const BACKUP_FOLDER_NAME = "Trh bytu - zaloha";
const SNAPSHOT_RE = /^trh-bytu-\d{4}-\d{2}-\d{2}\.sqlite$/;

/** Kam zálohovat: TRH_BACKUP_DIR, jinak Dropbox (podle jeho info.json), jinak null. */
export function findBackupRoot(env = process.env, infoPath = path.join(env.LOCALAPPDATA ?? "", "Dropbox", "info.json")) {
  if (env.TRH_BACKUP_DIR) return path.resolve(env.TRH_BACKUP_DIR);
  try {
    const info = JSON.parse(readFileSync(infoPath, "utf8"));
    const folder = info.personal?.path ?? Object.values(info).find((v) => v?.path)?.path;
    if (folder && existsSync(folder)) return path.join(folder, BACKUP_FOLDER_NAME);
  } catch {
    // Dropbox není nainstalovaný nebo info.json nejde přečíst
  }
  return null;
}

/** Pražský den ("2026-10-21") — den ve jménu snímku. */
export function backupDay(now = Date.now()) {
  return new Date(now).toLocaleDateString("sv-SE", { timeZone: "Europe/Prague" });
}

/**
 * Konzistentní snímek databáze do `destDir/trh-bytu-RRRR-MM-DD.sqlite`.
 * @returns { file, bytes, listings, removed: [staré snímky, které se smazaly] }
 */
export function backupDatabase({ dbFile, destDir, now = Date.now(), keep = KEEP_SNAPSHOTS }) {
  if (!existsSync(dbFile)) throw new Error(`databáze neexistuje: ${dbFile}`);
  mkdirSync(destDir, { recursive: true });
  const final = path.join(destDir, `trh-bytu-${backupDay(now)}.sqlite`);
  const tmp = `${final}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  const source = new DatabaseSync(dbFile, { readOnly: true });
  try {
    source.prepare("VACUUM INTO ?").run(tmp);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  } finally {
    source.close();
  }
  let listings;
  try {
    const snapshot = new DatabaseSync(tmp, { readOnly: true });
    try {
      const check = snapshot.prepare("PRAGMA integrity_check").all();
      if (check.length !== 1 || check[0].integrity_check !== "ok") throw new Error(`snímek je poškozený: ${JSON.stringify(check).slice(0, 200)}`);
      listings = snapshot.prepare("SELECT COUNT(*) AS c FROM listings").get().c;
    } finally {
      snapshot.close();
    }
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  renameSync(tmp, final); // nahradí případný dřívější snímek téhož dne (atomicky, i na Windows)

  // Retence: jen soubory se jménem snímku (cizí soubory ve složce se nikdy nemažou).
  const snapshots = readdirSync(destDir).filter((f) => SNAPSHOT_RE.test(f)).sort();
  const removed = snapshots.slice(0, Math.max(0, snapshots.length - keep));
  for (const f of removed) rmSync(path.join(destDir, f), { force: true });
  return { file: final, bytes: statSync(final).size, listings, removed };
}

/** Zkopíruje do zálohy fotky, které tam ještě nejsou (nebo mají jinou velikost). Nikdy nemaže. */
export function backupPhotos({ photosDir, destDir }) {
  let copied = 0;
  let skipped = 0;
  let bytes = 0;
  if (!existsSync(photosDir)) return { copied, skipped, bytes };
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const from = path.join(dir, entry.name);
      const relPath = path.join(rel, entry.name);
      if (entry.isDirectory()) {
        walk(from, relPath);
        continue;
      }
      const to = path.join(destDir, relPath);
      const size = statSync(from).size;
      if (existsSync(to) && statSync(to).size === size) {
        skipped++;
        continue;
      }
      mkdirSync(path.dirname(to), { recursive: true });
      copyFileSync(from, to);
      copied++;
      bytes += size;
    }
  };
  walk(photosDir, "");
  return { copied, skipped, bytes };
}

/**
 * Záloha jedné sekce (databáze + volitelně fotky). Nikdy nevyhazuje.
 * @returns { ok: true, line } nebo { ok: false, skipped: true, line }
 */
export function runBackup({ dataDir, backupName, env = process.env, now = Date.now(), withPhotos = env.TRH_BACKUP_PHOTOS === "1", root = findBackupRoot(env) }) {
  if (!root) return { ok: false, skipped: true, line: "Záloha přeskočena: nenašel jsem Dropbox ani nastavenou složku (TRH_BACKUP_DIR)." };
  try {
    const dest = path.join(root, backupName);
    const db = backupDatabase({ dbFile: path.join(dataDir, "trh-bytu.sqlite"), destDir: dest, now });
    const parts = [`databáze ${path.basename(db.file)} (${(db.bytes / 1024 / 1024).toFixed(1)} MB, ${db.listings} inzerátů)`];
    if (db.removed.length) parts.push(`smazáno starých snímků: ${db.removed.length}`);
    if (withPhotos) {
      const photos = backupPhotos({ photosDir: path.join(dataDir, "photos"), destDir: path.join(dest, "photos") });
      parts.push(`fotky: ${photos.copied} nových (${(photos.bytes / 1024 / 1024).toFixed(0)} MB), ${photos.skipped} už v záloze`);
    }
    return { ok: true, line: `Záloha dat → ${dest}: ${parts.join("; ")}` };
  } catch (err) {
    return { ok: false, skipped: false, line: `Záloha dat selhala: ${err.message}` };
  }
}

// Ruční spuštění: node trh-bytu/backup.js [--photos]   (sekce podle TRH_REGION)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { DATA_DIR } = await import("./db.js");
  const { REGION } = await import("./region.js");
  try {
    process.loadEnvFile(path.join(import.meta.dirname, "..", ".env.local"));
  } catch {
    // bez .env.local jede automatické hledání Dropboxu
  }
  const result = runBackup({ dataDir: DATA_DIR, backupName: REGION.backupName, withPhotos: process.argv.includes("--photos") || process.env.TRH_BACKUP_PHOTOS === "1" });
  console.log(result.line);
  process.exitCode = result.ok ? 0 : 1;
}
