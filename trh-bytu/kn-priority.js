// Přednost sekcí při čerpání společného limitu API katastru.
//
// Limit volání je jeden na klíč (500 za den), ale appka má víc sekcí (region.js):
// Ústí nad Orlicí a okolí je HLAVNÍ ("primary"), Náchod až druhý ("secondary").
// TVRDÉ PRAVIDLO: když by limit nestačil, data z katastru dostane vždy Ústí.
//
// Jak se to zajišťuje (sekce spolu jinak nesdílí nic, proto malý společný soubor):
//  - Ústí si bere svůj obvyklý denní strop a po dokončení dnešní kontroly to
//    zapíše do společného souboru (`markPrimaryDone`);
//  - sekce druhá v pořadí si NEMŮŽE vzít nic z toho, co by mohlo Ústí ještě
//    potřebovat. Dokud Ústí dnes nedoběhlo, nechává mu celý jeho denní strop;
//    po doběhnutí jen malou zálohu (STANDBY_CALLS) pro pozdější ruční
//    obnovení. Neví-li se (soubor chybí, nejde přečíst, jiný den), bere se
//    to jako "Ústí ještě nedoběhlo" — chyba vždy na straně Ústí.

import fs from "node:fs";
import path from "node:path";

export const SHARED_STATE_FILE = path.join(import.meta.dirname, "kn-shared-state.json");

// Kolik volání zůstane Ústí po jeho dnešní kontrole (ruční "Aktualizovat teď",
// nový byt s rezervací během dne), než si zbytek smí vzít druhá sekce.
export const STANDBY_CALLS = 100;

/** Dnešní den v Praze ("2026-10-19"). Limit API se počítá po dnech, tak i záznam. */
export function pragueDay(now = Date.now()) {
  return new Date(now).toLocaleDateString("sv-SE", { timeZone: "Europe/Prague" });
}

/** Společný soubor se stavem (JSON). Čtení i zápis nikdy nevyhazují. */
export function fileLedger(file = SHARED_STATE_FILE) {
  return {
    read() {
      try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        return null;
      }
    },
    write(state) {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
      fs.renameSync(tmp, file);
    },
  };
}

/** Ústí zapíše, že dnešní kontrola katastru doběhla. */
export function markPrimaryDone(ledger, now = Date.now()) {
  ledger.write({ day: pragueDay(now), primaryDoneAt: new Date(now).toISOString() });
}

/** Doběhlo Ústí dnes? Cokoli nejasného znamená "ne". */
export function primaryDoneToday(ledger, now = Date.now()) {
  const state = ledger.read();
  return Boolean(state?.primaryDoneAt) && state.day === pragueDay(now);
}

/**
 * Kolik volání si smí dnes vzít sekce druhá v pořadí.
 * @param ownCap        vlastní denní strop sekce
 * @param limit,used    limit klíče a dnešní čerpání (obojí společné)
 * @param reserve       rezerva, která zůstává vždy
 * @param primaryBudget denní strop Ústí
 * @param primaryDone   Ústí dnes s kontrolou doběhlo
 * @returns nezáporné číslo
 */
export function secondaryBudget({ ownCap, limit, used, reserve, primaryBudget, primaryDone, standby = STANDBY_CALLS }) {
  const claimedByPrimary = primaryDone ? standby : primaryBudget;
  return Math.max(0, Math.min(ownCap, limit - used - reserve - claimedByPrimary));
}
