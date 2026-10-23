// Doplnění strukturovaných parametrů (vlastnictví, druh objektu, stav, balkon, sklep…) u UŽ uložených RealityMIX
// inzerátů. Sběr je čte od chvíle, kdy se detail/realitymix.js naučil blok "Podrobné informace"; starší inzeráty
// mají `params_json` prázdný, takže se např. o družstevním bytě nevědělo (a po rezervaci se k němu připomínala
// kontrola v katastru, kde se družstevní byt ověřit nedá).
//
//   node trh-bytu/backfill-realitymix-params.js            # jen vypíše, co by změnil
//   node trh-bytu/backfill-realitymix-params.js --apply    # záloha databáze, pak zapíše
//
// Region podle TRH_REGION jako všude. Prochází jen RealityMIX inzeráty, které jsou ještě v nabídce nebo
// rezervované (stránka zmizelých už neexistuje); každý stáhne jednou (jako sběr, s pauzou). Sloučení je totéž
// pravidlo jako při sběru (mergeExtractedParams: údaj z portálu má přednost před textem). RUČNÍ přepsání
// (`params_override_json`) se NIKDY nemění — když se ale liší od toho, co říká portál, vypíše se, ať o tom víš.
// Před zápisem se databáze zkopíruje do `<složka dat>/backup-rmxparams-<čas>.sqlite`; běží jen když neprobíhá sběr.

import { copyFileSync } from "node:fs";
import path from "node:path";
import { openDb, DATA_DIR } from "./db.js";
import { REGION } from "./region.js";
import { fetchRealitymixDetail } from "./detail/realitymix.js";
import { mergeExtractedParams } from "./extract-params.js";
import { acquireTrackLock, releaseTrackLock } from "./track-lock.js";

const apply = process.argv.includes("--apply");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const parse = (json) => {
  try {
    return json ? JSON.parse(json) : {};
  } catch {
    return {};
  }
};

const db = openDb();
const rows = db
  .prepare("SELECT id, url, status, address, params_json, params_override_json FROM listings WHERE source = 'realitymix' AND status IN ('active','reserved') ORDER BY first_seen_at")
  .all();
console.log(`Sekce „${REGION.label}“: ${rows.length} RealityMIX inzerátů v nabídce nebo rezervovaných.`);

const changes = [];
const conflicts = [];
let withoutBlock = 0;
for (const row of rows) {
  const portal = (await fetchRealitymixDetail(row.url)).params ?? {};
  await sleep(400);
  if (!Object.keys(portal).length) {
    withoutBlock++;
    continue;
  }
  const stored = parse(row.params_json);
  const merged = mergeExtractedParams(stored, portal);
  const diff = Object.keys(merged).filter((key) => JSON.stringify(merged[key]) !== JSON.stringify(stored[key]));
  if (diff.length) changes.push({ row, merged, diff, stored });
  const override = parse(row.params_override_json);
  for (const [field, manual] of Object.entries(override)) {
    if (merged[field] != null && String(merged[field]).toLowerCase() !== String(manual).toLowerCase()) conflicts.push({ row, field, manual, portal: merged[field] });
  }
}

console.log(`\nStránka bez bloku parametrů: ${withoutBlock}. K doplnění nebo změně: ${changes.length}.`);
for (const { row, diff, stored, merged } of changes) {
  const parts = diff.map((key) => (stored[key] != null ? `${key}: ${stored[key]} → ${merged[key]}` : `${key}: ${merged[key]}`));
  console.log(`  ${row.id} | ${row.address || "(bez adresy)"} | ${parts.join(", ")}`);
}
if (conflicts.length) {
  console.log(`\nRuční přepsání, které se liší od portálu (nemění se, jen ať o tom víš): ${conflicts.length}`);
  for (const c of conflicts) console.log(`  ⚠ ${c.row.id} | ${c.row.address || "(bez adresy)"} | ${c.field}: ručně „${c.manual}“, portál „${c.portal}“`);
}
if (!changes.length) process.exit(0);
if (!apply) {
  console.log("\nNic se nezměnilo. Zápis: node trh-bytu/backfill-realitymix-params.js --apply");
  process.exit(0);
}

const lockPath = path.join(DATA_DIR, "track.lock");
if (!acquireTrackLock(lockPath)) {
  console.error("Právě běží sběr dat — doplnění se nespustilo, zkus to za chvíli.");
  process.exit(1);
}
try {
  db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = path.join(DATA_DIR, `backup-rmxparams-${stamp}.sqlite`);
  copyFileSync(path.join(DATA_DIR, "trh-bytu.sqlite"), backup);
  console.log(`\nZáloha databáze: ${backup}`);
  db.exec("BEGIN");
  try {
    for (const { row, merged } of changes) db.prepare("UPDATE listings SET params_json = ? WHERE id = ?").run(JSON.stringify(merged), row.id);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  console.log(`Doplněno ${changes.length} inzerátů.`);
} finally {
  releaseTrackLock(lockPath);
}
