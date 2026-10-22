// Přenese stav z právě doběhnutého běhu přes novější stav na `main` (viz mergeStates v lib/state.js):
//
//   node scripts/merge-seen.js <base.json> <ours.json>
//
// `data/seen.json` v checkoutu je přitom stav z `main` ("theirs"), `base` je stav, ze kterého běh
// vyšel, `ours` jeho výsledek. Výsledek se zapíše do `data/seen.json`. Volá ho
// scripts/run-and-commit.sh po odmítnutém `git push`.

import { readFile } from "node:fs/promises";
import { loadState, saveState, mergeStates } from "../lib/state.js";
import { maxSeenPerSource } from "../config.js";

const [basePath, oursPath] = process.argv.slice(2);
if (!basePath || !oursPath) {
  console.error("Použití: node scripts/merge-seen.js <base.json> <ours.json>");
  process.exit(2);
}

const readJson = async (file) => JSON.parse(await readFile(file, "utf-8"));
const [base, ours, theirs] = [await readJson(basePath), await readJson(oursPath), await loadState()];
await saveState(mergeStates(base, ours, theirs, maxSeenPerSource));
console.log("Stav z tohoto běhu přenesen přes novější stav na main.");
