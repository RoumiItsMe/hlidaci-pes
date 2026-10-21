// node --test trh-bytu/backup.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initDb, insertListing } from "./db.js";
import { findBackupRoot, backupDay, backupDatabase, backupPhotos, runBackup, KEEP_SNAPSHOTS, BACKUP_FOLDER_NAME } from "./backup.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "backup-test-"));
const NOW = Date.parse("2026-10-21T10:00:00Z");

/** Živá databáze v režimu WAL (jako v appce) s n inzeráty; spojení zůstává otevřené. */
function liveDb(dir, n = 3) {
  const file = path.join(dir, "trh-bytu.sqlite");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  initDb(db);
  for (let i = 1; i <= n; i++) {
    insertListing(db, { id: `sreality:${i}`, source: "sreality", source_id: String(i), url: `https://example.invalid/${i}`, title: "Prodej bytu", description: "", price_czk: 3_000_000 + i, status: "active", first_seen_at: "2026-10-01T08:00:00Z", last_seen_at: "2026-10-21T06:00:00Z" });
  }
  return { db, file };
}

test("cíl zálohy: TRH_BACKUP_DIR má přednost, jinak Dropbox podle jeho info.json, jinak nic", () => {
  const dir = tmp();
  const dropbox = path.join(dir, "Dropbox");
  fs.mkdirSync(dropbox);
  const info = path.join(dir, "info.json");
  fs.writeFileSync(info, JSON.stringify({ personal: { path: dropbox, host: 1 } }));
  assert.equal(findBackupRoot({ TRH_BACKUP_DIR: path.join(dir, "jina") }, info), path.join(dir, "jina"));
  assert.equal(findBackupRoot({}, info), path.join(dropbox, BACKUP_FOLDER_NAME));
  // firemní účet bez "personal"
  fs.writeFileSync(info, JSON.stringify({ business: { path: dropbox } }));
  assert.equal(findBackupRoot({}, info), path.join(dropbox, BACKUP_FOLDER_NAME));
  // složka Dropboxu už neexistuje / soubor nejde přečíst / není JSON / neexistuje
  fs.writeFileSync(info, JSON.stringify({ personal: { path: path.join(dir, "smazano") } }));
  assert.equal(findBackupRoot({}, info), null);
  fs.writeFileSync(info, "{ rozbité");
  assert.equal(findBackupRoot({}, info), null);
  assert.equal(findBackupRoot({}, path.join(dir, "neni.json")), null);
});

test("den snímku je pražský (po půlnoci v Praze už další den)", () => {
  assert.equal(backupDay(Date.parse("2026-10-21T10:00:00Z")), "2026-10-21");
  assert.equal(backupDay(Date.parse("2026-10-21T22:30:00Z")), "2026-10-22");
});

test("snímek živé databáze (WAL, otevřené spojení) je úplný, ověřený a bez zbylých dočasných souborů", () => {
  const dir = tmp();
  const { db, file } = liveDb(dir, 3);
  try {
    const dest = path.join(dir, "zaloha");
    const r = backupDatabase({ dbFile: file, destDir: dest, now: NOW });
    assert.equal(path.basename(r.file), "trh-bytu-2026-10-21.sqlite");
    assert.equal(r.listings, 3);
    assert.deepEqual(fs.readdirSync(dest), ["trh-bytu-2026-10-21.sqlite"]); // žádný .tmp, žádný -wal/-shm
    // obsah snímku = obsah databáze, a dá se použít jako databáze appky
    const snap = new DatabaseSync(r.file, { readOnly: true });
    assert.equal(snap.prepare("SELECT COUNT(*) c FROM listings").get().c, 3);
    assert.equal(snap.prepare("SELECT price_czk p FROM listings WHERE id = 'sreality:2'").get().p, 3_000_002);
    snap.close();
    // zápis do živé databáze po záloze se do hotového snímku nedostane
    insertListing(db, { id: "sreality:99", source: "sreality", source_id: "99", url: "https://example.invalid/99", title: "x", description: "", price_czk: 1, status: "active", first_seen_at: "2026-10-21T08:00:00Z", last_seen_at: "2026-10-21T08:00:00Z" });
    const after = new DatabaseSync(r.file, { readOnly: true });
    assert.equal(after.prepare("SELECT COUNT(*) c FROM listings").get().c, 3);
    after.close();
  } finally {
    db.close();
  }
});

test("snímek zachytí i data, která jsou zatím jen ve WAL (ještě nejsou v hlavním souboru)", () => {
  const dir = tmp();
  const { db, file } = liveDb(dir, 1);
  try {
    db.exec("PRAGMA wal_autocheckpoint = 0;"); // nic se do hlavního souboru nepřepíše samo
    for (let i = 10; i < 20; i++) {
      insertListing(db, { id: `sreality:${i}`, source: "sreality", source_id: String(i), url: `https://example.invalid/${i}`, title: "x", description: "", price_czk: 1, status: "active", first_seen_at: "2026-10-21T08:00:00Z", last_seen_at: "2026-10-21T08:00:00Z" });
    }
    assert.equal(backupDatabase({ dbFile: file, destDir: path.join(dir, "z"), now: NOW }).listings, 11);
  } finally {
    db.close();
  }
});

test("druhý běh téhož dne snímek nahradí (jeden na den), jiný den přidá další", () => {
  const dir = tmp();
  const { db, file } = liveDb(dir, 1);
  const dest = path.join(dir, "z");
  try {
    assert.equal(backupDatabase({ dbFile: file, destDir: dest, now: NOW }).listings, 1);
    insertListing(db, { id: "sreality:2", source: "sreality", source_id: "2", url: "https://example.invalid/2", title: "x", description: "", price_czk: 1, status: "active", first_seen_at: "2026-10-21T08:00:00Z", last_seen_at: "2026-10-21T08:00:00Z" });
    assert.equal(backupDatabase({ dbFile: file, destDir: dest, now: NOW + 3600_000 }).listings, 2);
    assert.deepEqual(fs.readdirSync(dest), ["trh-bytu-2026-10-21.sqlite"]);
    backupDatabase({ dbFile: file, destDir: dest, now: NOW + 24 * 3600_000 });
    assert.deepEqual(fs.readdirSync(dest).sort(), ["trh-bytu-2026-10-21.sqlite", "trh-bytu-2026-10-22.sqlite"]);
  } finally {
    db.close();
  }
});

test("retence: drží se posledních N snímků, nejstarší se mažou, cizí soubory ve složce zůstanou", () => {
  const dir = tmp();
  const { db, file } = liveDb(dir, 1);
  const dest = path.join(dir, "z");
  fs.mkdirSync(dest);
  try {
    for (let d = 1; d <= 6; d++) fs.writeFileSync(path.join(dest, `trh-bytu-2026-09-0${d}.sqlite`), "stary");
    fs.writeFileSync(path.join(dest, "moje-poznamky.txt"), "nesahat");
    fs.writeFileSync(path.join(dest, "trh-bytu-2026-09-01.sqlite.bak"), "nesahat");
    const r = backupDatabase({ dbFile: file, destDir: dest, now: NOW, keep: 3 });
    assert.deepEqual(r.removed, ["trh-bytu-2026-09-01.sqlite", "trh-bytu-2026-09-02.sqlite", "trh-bytu-2026-09-03.sqlite", "trh-bytu-2026-09-04.sqlite"]);
    assert.deepEqual(fs.readdirSync(dest).sort(), ["moje-poznamky.txt", "trh-bytu-2026-09-01.sqlite.bak", "trh-bytu-2026-09-05.sqlite", "trh-bytu-2026-09-06.sqlite", "trh-bytu-2026-10-21.sqlite"]);
    assert.equal(KEEP_SNAPSHOTS, 30);
  } finally {
    db.close();
  }
});

test("nejde-li databáze zazálohovat (není to SQLite / neexistuje), vznikne chyba a ve složce nic nezůstane", () => {
  const dir = tmp();
  const dest = path.join(dir, "z");
  const notDb = path.join(dir, "trh-bytu.sqlite");
  fs.writeFileSync(notDb, "tohle není databáze, jen text".repeat(50));
  assert.throws(() => backupDatabase({ dbFile: notDb, destDir: dest, now: NOW }));
  assert.deepEqual(fs.existsSync(dest) ? fs.readdirSync(dest) : [], []);
  assert.throws(() => backupDatabase({ dbFile: path.join(dir, "neexistuje.sqlite"), destDir: dest, now: NOW }), /neexistuje/);
});

test("fotky: kopírují se jen nové (nebo změněné) soubory a ze zálohy se nikdy nemaže", () => {
  const dir = tmp();
  const photos = path.join(dir, "photos");
  const dest = path.join(dir, "z", "photos");
  fs.mkdirSync(path.join(photos, "sreality_1"), { recursive: true });
  fs.mkdirSync(path.join(photos, "bazos_2"), { recursive: true });
  fs.writeFileSync(path.join(photos, "sreality_1", "1.jpg"), "aaaa");
  fs.writeFileSync(path.join(photos, "bazos_2", "1.jpg"), "bb");
  let r = backupPhotos({ photosDir: photos, destDir: dest });
  assert.deepEqual([r.copied, r.skipped, r.bytes], [2, 0, 6]);
  assert.equal(fs.readFileSync(path.join(dest, "sreality_1", "1.jpg"), "utf8"), "aaaa");
  // nic nového → nic se nekopíruje
  r = backupPhotos({ photosDir: photos, destDir: dest });
  assert.deepEqual([r.copied, r.skipped], [0, 2]);
  // nový soubor a změněná velikost se zkopírují; smazaná fotka ve zdroji ze zálohy NEzmizí
  fs.writeFileSync(path.join(photos, "sreality_1", "2.jpg"), "cc");
  fs.writeFileSync(path.join(photos, "bazos_2", "1.jpg"), "bbbbbb");
  fs.rmSync(path.join(photos, "sreality_1", "1.jpg"));
  r = backupPhotos({ photosDir: photos, destDir: dest });
  assert.deepEqual([r.copied, r.skipped], [2, 0]);
  assert.ok(fs.existsSync(path.join(dest, "sreality_1", "1.jpg")));
  assert.equal(fs.readFileSync(path.join(dest, "bazos_2", "1.jpg"), "utf8"), "bbbbbb");
  // zdrojová složka chybí → nic, bez chyby
  assert.deepEqual(backupPhotos({ photosDir: path.join(dir, "neni"), destDir: dest }), { copied: 0, skipped: 0, bytes: 0 });
});

test("runBackup: záloha sekce do podsložky, fotky jen na požádání, řádek pro log", () => {
  const dir = tmp();
  const dataDir = path.join(dir, "data");
  fs.mkdirSync(path.join(dataDir, "photos", "sreality_1"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "photos", "sreality_1", "1.jpg"), "foto");
  const { db } = liveDb(dataDir, 2);
  try {
    const root = path.join(dir, "Dropbox", BACKUP_FOLDER_NAME);
    const plain = runBackup({ dataDir, backupName: "usti-nad-orlici", env: {}, now: NOW, root });
    assert.equal(plain.ok, true);
    assert.match(plain.line, /trh-bytu-2026-10-21\.sqlite/);
    assert.match(plain.line, /2 inzerátů/);
    assert.ok(!/fotky/.test(plain.line));
    assert.ok(fs.existsSync(path.join(root, "usti-nad-orlici", "trh-bytu-2026-10-21.sqlite")));
    assert.ok(!fs.existsSync(path.join(root, "usti-nad-orlici", "photos")));
    // s fotkami (přepínač v prostředí)
    const withPhotos = runBackup({ dataDir, backupName: "usti-nad-orlici", env: { TRH_BACKUP_PHOTOS: "1" }, now: NOW, root });
    assert.match(withPhotos.line, /fotky: 1 nových/);
    assert.ok(fs.existsSync(path.join(root, "usti-nad-orlici", "photos", "sreality_1", "1.jpg")));
  } finally {
    db.close();
  }
});

test("runBackup nikdy nevyhazuje: bez cíle se přeskočí, při chybě vrátí ok:false s důvodem", () => {
  const dir = tmp();
  const none = runBackup({ dataDir: dir, backupName: "x", env: {}, now: NOW, root: null });
  assert.deepEqual([none.ok, none.skipped], [false, true]);
  assert.match(none.line, /Dropbox ani nastavenou složku/);
  const broken = runBackup({ dataDir: path.join(dir, "neni"), backupName: "x", env: {}, now: NOW, root: path.join(dir, "cil") });
  assert.deepEqual([broken.ok, broken.skipped], [false, false]);
  assert.match(broken.line, /Záloha dat selhala: databáze neexistuje/);
});
