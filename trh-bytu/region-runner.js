// Rozběh dalších regionů po sběru výchozího (viz region.js, track.js). Plánovaná
// úloha pouští `node track.js` bez regionu: nejdřív proběhne výchozí region
// (beze změny), potom každý další region jako SAMOSTATNÝ proces s vlastní
// databází a časovým limitem — chyba nebo zaseknutí dalšího regionu výchozí data
// nijak neovlivní. Jen jeden region pustí `TRH_REGION=…` (ruční spuštění,
// tlačítko "Aktualizovat teď"), ten žádný další nespouští.

import { spawnSync } from "node:child_process";
import { OTHER_REGIONS } from "./region.js";

export const REGION_RUN_TIMEOUT_MS = 25 * 60 * 1000;

/**
 * @returns `[{ key, ok }]` pro každý spuštěný region (prázdné, když je region zadaný výslovně)
 */
export function runOtherRegions({ scriptPath, log, regions = OTHER_REGIONS, env = process.env, spawn = spawnSync }) {
  if (env.TRH_REGION) return [];
  const results = [];
  for (const other of regions) {
    try {
      log(`=== Další region: ${other.key} ===`);
      const result = spawn(process.execPath, [scriptPath], {
        env: { ...env, TRH_REGION: other.key },
        stdio: "inherit",
        timeout: REGION_RUN_TIMEOUT_MS,
      });
      const failed = Boolean(result.error) || result.status !== 0;
      if (failed) log(`Region ${other.key} skončil s chybou (${result.error?.message ?? `kód ${result.status}`}) — jeho log je v jeho složce dat.`);
      results.push({ key: other.key, ok: !failed });
    } catch (err) {
      log(`Region ${other.key} se nepodařilo spustit: ${err.message}`);
      results.push({ key: other.key, ok: false });
    }
  }
  return results;
}
