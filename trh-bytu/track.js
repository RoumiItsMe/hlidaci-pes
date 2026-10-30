// Trh bytů — sběrný běh. Spouští se lokálně (naplánovanou úlohou ve
// Windows, viz README.md v této složce), NE přes GitHub Actions — na rozdíl
// od hlídacího psa (index.js) tahle appka potřebuje trvalé úložiště
// (SQLite + fotky), které na efemérním Actions runneru nejde bez
// commitování binárek do gitu. Databáze zůstává jen na PC; GitHub Actions pouští
// jen cloudového sběrače (scout.js), který ukládá snímky výpisů, a ty se tady na
// začátku běhu přehrají (snapshot-replay.js) — viz cloud/README.md.
//
// Znovupoužívá stávající sources/*.js (search-pass — "co je teď v
// nabídce") a config.js (watch "byty" — stejná lokalita jako hlídací pes).
// Žádný z těch souborů se needituje — nulové riziko pro živý hlídací pes.
//
// Pro každý nový inzerát navíc navštíví jeho DETAIL stránku (vlastní
// parsery v detail/*.js, nezávislé na sources/*.js) kvůli popisu a fotkám —
// to search-pass nemá. Dispozice a m² se berou z titulku (parse.js),
// funguje to univerzálně napříč všemi zdroji bez detail fetch.

import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { REGION, REGION_WATCH, KN_OPTIONS } from "./region.js";
import { runOtherRegions } from "./region-runner.js";
import { runBackup } from "./backup.js";
import { sendKnCheckDigest, processTelegramActions, notifyPossibleSales } from "./reservation-reminders.js";
import { refreshKnScans } from "./kn-scan.js";
import { openDb, nowIso, DATA_DIR } from "./db.js";
import { acquireTrackLock, releaseTrackLock } from "./track-lock.js";
import { geocodePending } from "./geo.js";
import { ruianPending } from "./ruian.js";
import { applyAutoAddresses, ruianPendingTextAddresses } from "./auto-address.js";
import { buildSources } from "./sources-config.js";
import { processSource } from "./process-source.js";
import { replaySnapshots, markLiveRun } from "./snapshot-replay.js";

const LOG_PATH = path.join(DATA_DIR, "track.log");
const LOCK_PATH = path.join(DATA_DIR, "track.lock");

// Telegram token/chat ID z `.env.local` v kořeni repa (git-ignored) —
// stejný mechanismus a stejné proměnné jako hlídací pes (viz
// scripts/watch-blocked-boards.js): TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID.
// Appka na ně normálně nesahá (sdílí env jen kvůli téhle jedné notifikaci),
// chybějící soubor proto fail-soft ignoruje — upozornění na rezervaci pak
// jen zaloguje chybu a běh pokračuje dál.
try {
  process.loadEnvFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env.local"));
} catch {
  // Viz komentář výš — appka běží bez dohledu, chybějící .env.local nesmí
  // shodit celý sběrný běh.
}

// Region bez Telegramu (např. Náchod) žádné zprávy neposílá — ani o rezervaci, ani
// o možném prodeji, podaném vkladu či souhrnu kontrol; zbytek (sběr, adresy,
// kontrola katastru) běží stejně. Denní strop volání API katastru je společný pro
// všechny regiony, proto má region vlastní limit (KN_OPTIONS v region.js).

function log(line) {
  const stamped = `[${nowIso()}] ${line}`;
  console.log(stamped);
  try {
    appendFileSync(LOG_PATH, stamped + "\n", "utf-8");
  } catch {
    // Appka běží bez dohledu — pád zápisu do logu nesmí shodit celý běh.
  }
}

const SOURCES = buildSources(log);

// Jen jeden sběr naráz (plánovaná úloha + tlačítko "Aktualizovat teď" na
// přehledu + dohánění po startu PC), viz track-lock.js. Běh, který zámek nezíská,
// se tiše přeskočí — ten druhý právě dělá totéž.
async function run() {
  if (!acquireTrackLock(LOCK_PATH)) {
    log("Jiný sběrný běh právě probíhá — tenhle se přeskakuje.");
    return;
  }
  process.on("exit", () => releaseTrackLock(LOCK_PATH));
  try {
    await runLocked();
  } finally {
    releaseTrackLock(LOCK_PATH);
  }
}

async function runLocked() {
  const db = openDb();
  const watch = REGION_WATCH;

  log("=== Start běhu ===");
  // Cloudový sběrač (scout.js): změny z doby, kdy PC nebylo zapnuté, se zapíšou se skutečným časem pozorování. Bez
  // TRH_SNAPSHOT_REPO se nedělá nic (viz snapshot-replay.js); selhání sběr neshodí.
  const runStartedAt = nowIso();
  try {
    await replaySnapshots({ db, sources: SOURCES, watch, regionKey: REGION.key, repoDir: process.env.TRH_SNAPSHOT_REPO, log });
  } catch (err) {
    log(`Přehrání snímků z cloudu selhalo: ${err.message}`);
  }
  let totalNew = 0;
  let totalPriceChanges = 0;
  let totalRemoved = 0;
  let totalRelisted = 0;
  let totalReservations = 0;
  let totalSold = 0;
  let hadError = false;

  for (const source of SOURCES) {
    const result = await processSource(db, source, watch, { log });
    totalNew += result.newCount;
    totalPriceChanges += result.priceChangeCount;
    totalRemoved += result.removedCount;
    totalRelisted += result.relistedCount;
    totalReservations += result.reservationCount;
    totalSold += result.soldCount ?? 0;
    if (result.error) hadError = true;
  }
  markLiveRun(db, runStartedAt); // snímky starší než tenhle sběr už nejsou potřeba

  log(
    `Hotovo. ${totalNew} nových bytů zaevidováno, ${totalPriceChanges} změn ceny, ${totalRemoved} zmizelo z nabídky, ${totalRelisted} znovu vloženo, ${totalReservations} změn rezervace, ${totalSold} prodáno.` +
      (hadError ? " (u některého zdroje selhalo stahování — zkontroluj log výše.)" : "")
  );

  // Kliknutí na tlačítka ze starších zpráv (viz reservation-reminders.js).
  // Nezávislé na výsledku sběru výš (fail-soft).
  if (REGION.telegram) await processTelegramActions(db, log);
  // Rezervované byty, které při tomhle běhu zmizely z nabídky — "možný
  // prodej", teď je nejlepší chvíle začít hledat v katastru.
  if (REGION.telegram) {
    try {
      await notifyPossibleSales(db, log);
    } catch (err) {
      log(`Upozornění na možný prodej selhalo: ${err.message}`);
    }
  }

  // Geokódování nových bodů a automatické doplnění adres (viz geo.js,
  // auto-address.js). Fail-soft — výpadek geokodéru sběr dat nesmí shodit.
  try {
    await geocodePending(db, log);
    await ruianPending(db, log); // oficiální ověření budovy + katastrální území, viz ruian.js
    await ruianPendingTextAddresses(db, log); // adresy z textu inzerátů v RÚIAN, viz auto-address.js
    const { assigned, revoked } = applyAutoAddresses(db, log);
    if (assigned || revoked) log(`[geo] adresy: ${assigned} doplněno automaticky, ${revoked} odvoláno.`);
  } catch (err) {
    log(`[geo] zpracování polohy selhalo: ${err.message}`);
  }

  // Plomby (podané vklady) v domech rezervovaných bytů přes bezplatné API
  // katastru (kn-scan.js) — před souhrnem, ať souhrn vidí čerstvá data a byt,
  // u kterého se vklad našel sám, už mezi "k vyřízení" nepatří. Bez KN_API_KEY
  // v .env.local se nedělá nic.
  try {
    const line = await refreshKnScans(db, log, KN_OPTIONS);
    if (line) log(line);
  } catch (err) {
    log(`Kontrola plomb v katastru selhala: ${err.message}`);
  }

  // Souhrn "tyhle byty je čas zkontrolovat v katastru" (rozvrh viz
  // kn-schedule.js). Až PO doplnění adres výš — bez přesné adresy se byt v
  // katastru dohledat nedá, takže čerstvě určená adresa musí být vidět.
  if (REGION.telegram) {
    try {
      await sendKnCheckDigest(db, log);
    } catch (err) {
      log(`Souhrn kontrol v katastru selhal: ${err.message}`);
    }
  }

  db.close();

  // Záloha dat do Dropboxu (viz backup.js) — až po zavření databáze, ať snímek obsahuje
  // všechno z tohoto běhu. Nikdy neshodí sběr (selhání jen zapíše do logu).
  log(runBackup({ dataDir: DATA_DIR, backupName: REGION.backupName }).line);
}

run()
  .catch((err) => {
    console.error("Neočekávaná chyba:", err);
    try {
      appendFileSync(LOG_PATH, `[${nowIso()}] NEOČEKÁVANÁ CHYBA: ${err.stack || err.message}\n`, "utf-8");
    } catch {
      // Nic víc se s tím nedá dělat — appka běží bez dohledu.
    }
    process.exitCode = 1;
  })
  // Plánovaná úloha pouští `node track.js` bez regionu: po výchozím regionu pustí
  // další regiony jako samostatné procesy (viz region-runner.js).
  .finally(() => runOtherRegions({ scriptPath: fileURLToPath(import.meta.url), log }));
