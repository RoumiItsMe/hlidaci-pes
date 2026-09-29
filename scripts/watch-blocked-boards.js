// Doháňí úřední desky, na které GitHub Actions momentálně nedosáhne (viz
// README — "Domácí záloha pro blokované desky"). Spouští se z domácího PC
// přes Windows Task Scheduler, typicky jednou denně.
//
// Není to samostatný mechanismus — použije PŘESNĚ stejnou detekci jako
// GitHub Actions (`lib/boards-runner.js`), jen ji spustí navíc pro desky,
// které mají v POSLEDNÍM committnutém stavu `health.failing === true` —
// tedy ty, kde poslední pokus z GitHubu selhal. Když momentálně nic
// neselhává, skript nic nedělá, nic nezapisuje a tiše skončí — nezajímá ho,
// KTERÉ desky byly problematické včera, jen to, co je rozbité TEĎ.
//
// Dedup je sdílený s GitHub Actions přes stejný `board:<key>` klíč v
// data/seen.json — obě strany commitují do TÉHOŽ souboru (stejný retry-on-
// -push-conflict vzorec jako ve `watch.yml`), takže se nic nenahlásí
// dvakrát jen proto, že to jednou zkontroloval GitHub a jednou domácí PC.
//
// Vědomý kompromis: pokud i domácí IP jednou přestane na danou desku
// stačit, skript to jen zaloguje jako běžné selhání (`health.js` alert
// debounce platí stejně) — nejde o zázračné řešení, jen o druhou šanci.
//
// Telegram token/chat ID: `.env.local` v kořeni repa (git-ignored):
//   TELEGRAM_BOT_TOKEN=...
//   TELEGRAM_CHAT_ID=...
// Spuštění: `node scripts/watch-blocked-boards.js` (env se načte sám).

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, mkdirSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const LOG_PATH = path.join(REPO_ROOT, "data", "watch-blocked-boards.log");

try {
  process.loadEnvFile(path.join(REPO_ROOT, ".env.local"));
} catch {
  // .env.local nemusí existovat (např. při prvním spuštění) — proměnné
  // mohou být nastavené i jinak (systémové env). Chybí-li i tak, ohlásí
  // se to srozumitelně níž při prvním pokusu o odeslání Telegram zprávy.
}

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  try {
    mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    appendFileSync(LOG_PATH, stamped + "\n", "utf-8");
  } catch {
    // Log je jen pro pohodlí — když se nepovede zapsat, běh kvůli tomu nepadá.
  }
}

function git(args) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

function hasLocalStateChanges() {
  try {
    git(["diff", "--quiet", "--", "data/seen.json"]);
    return false;
  } catch {
    return true;
  }
}

async function main() {
  const { noticeBoards } = await import(path.join(REPO_ROOT, "config.js"));
  const { loadState, saveState } = await import(path.join(REPO_ROOT, "lib", "state.js"));
  const { runNoticeBoards } = await import(path.join(REPO_ROOT, "lib", "boards-runner.js"));

  log("=== Start běhu (domácí záloha blokovaných desek) ===");

  try {
    git(["pull", "--rebase", "origin", "main"]);
  } catch (err) {
    log(`git pull selhal — zkontroluj připojení k internetu: ${err.message.split("\n")[0]}`);
    process.exitCode = 1;
    return;
  }

  for (let attempt = 1; attempt <= 3; attempt++) {
    const state = await loadState();
    const stuck = noticeBoards.filter((b) => state.__health?.[`board:${b.key}`]?.failing);

    if (stuck.length === 0) {
      log("Žádná deska momentálně neselhává — z domova není co doháňět.");
      return;
    }

    log(`Zkouším domácí připojení pro: ${stuck.map((b) => b.label).join(", ")}`);
    const { sent, hadError, hadSeriousError } = await runNoticeBoards(state, { boards: stuck });
    await saveState(state);
    log(
      `Hotovo. Odesláno ${sent} upozornění.` +
        (hadSeriousError ? " Aspoň jedna deska selhává i z domova." : hadError ? " Ojedinělá chyba, viz log výše." : "")
    );

    if (!hasLocalStateChanges()) {
      log("Stav beze změny, není co commitovat.");
      return;
    }

    git(["add", "data/seen.json"]);
    git(["commit", "-m", "chore: aktualizace stavu hlídacího psa (domácí záloha) [skip ci]"]);
    try {
      git(["push", "origin", "main"]);
      log(`Push OK (pokus ${attempt}).`);
      return;
    } catch {
      log(`Push selhal (pokus ${attempt}/3) — GitHub Actions mezitím pushnul. Stahuju nejnovější stav a zkouším znovu.`);
      git(["fetch", "origin", "main"]);
      git(["reset", "--hard", "origin/main"]);
    }
  }
  log("::error:: Nepodařilo se commitnout stav ani po 3 pokusech.");
  process.exitCode = 1;
}

main().catch((err) => {
  log(`Neočekávaná chyba: ${err.stack ?? err.message}`);
  process.exitCode = 1;
});
