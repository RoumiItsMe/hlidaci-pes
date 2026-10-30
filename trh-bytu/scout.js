// Cloudový sběrač: stáhne výpisy portálů jedné sekce a uloží je jako snímek (snapshot.js). Pouští ho GitHub Actions
// jednou denně (viz cloud/README.md), takže mezera v datech po dovolené bez PC je den, ne týden. Do databáze ani na
// disk mimo `--out` nesahá, nestahuje fotky ani nevolá Telegram a katastr.
//
//   TRH_REGION=default node trh-bytu/scout.js --out <složka>      (bez TRH_REGION výchozí sekce)
//
// Snímek skončí v `<složka>/<region>/<čas>.json`. Když se nepodaří stáhnout ani jeden portál, nezapíše se nic a skript
// skončí chybou (ať workflow nezaznamená prázdný běh jako úspěch).

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { REGION, REGION_WATCH } from "./region.js";
import { buildSources } from "./sources-config.js";
import { collectSnapshot, hasAnyData, snapshotRelPath } from "./snapshot.js";

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

const outDir = argValue("--out");
if (!outDir) {
  console.error("Použití: node trh-bytu/scout.js --out <složka>");
  process.exit(2);
}

const log = (line) => console.log(`[${new Date().toISOString()}] ${line}`);
log(`=== Sběrač: ${REGION.label} ===`);
const snapshot = await collectSnapshot({ sources: buildSources(log), watch: REGION_WATCH, regionKey: REGION.key, log });
if (!hasAnyData(snapshot)) {
  console.error("Nepodařilo se stáhnout žádný portál — snímek se neukládá.");
  process.exit(1);
}
const file = path.join(outDir, snapshotRelPath(snapshot));
mkdirSync(path.dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(snapshot) + "\n", "utf8");
const failed = Object.entries(snapshot.sources).filter(([, s]) => !s.ok).map(([name]) => name);
log(`Uloženo: ${file}${failed.length ? ` (bez portálů: ${failed.join(", ")})` : ""}`);
