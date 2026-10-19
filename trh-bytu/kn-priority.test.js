// node --test trh-bytu/kn-priority.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { secondaryBudget, pragueDay, fileLedger, markPrimaryDone, primaryDoneToday, STANDBY_CALLS } from "./kn-priority.js";

const base = { ownCap: 150, limit: 500, reserve: 100, primaryBudget: 350 };

test("druhá sekce, dokud Ústí nedoběhlo: bere jen to, co přesahuje celý strop Ústí", () => {
  assert.equal(secondaryBudget({ ...base, used: 0, primaryDone: false }), 50);
  assert.equal(secondaryBudget({ ...base, used: 40, primaryDone: false }), 10);
  assert.equal(secondaryBudget({ ...base, used: 50, primaryDone: false }), 0);
  assert.equal(secondaryBudget({ ...base, used: 200, primaryDone: false }), 0); // nikdy záporné
});

test("druhá sekce po doběhnutí Ústí: vlastní strop, ale nad zálohou pro Ústí", () => {
  assert.equal(secondaryBudget({ ...base, used: 90, primaryDone: true }), 150);
  assert.equal(secondaryBudget({ ...base, used: 200, primaryDone: true }), 100);
  assert.equal(secondaryBudget({ ...base, used: 350, primaryDone: true }), 0);
  assert.equal(STANDBY_CALLS, 100);
});

test("pravidlo drží pro každé čerpání: Ústí vždy zůstane celý jeho strop, nebo záloha", () => {
  for (let used = 0; used <= 500; used++) {
    for (const primaryDone of [false, true]) {
      const b = secondaryBudget({ ...base, used, primaryDone });
      assert.ok(b >= 0 && b <= base.ownCap);
      const leftForPrimary = base.limit - base.reserve - (used + b);
      // Co po čerpání druhé sekce zbývá Ústí, nikdy neklesne pod to, co mu patří (a co by zbylo bez druhé sekce).
      const needed = primaryDone ? STANDBY_CALLS : base.primaryBudget;
      assert.ok(leftForPrimary >= Math.min(needed, base.limit - base.reserve - used), `used=${used} done=${primaryDone}`);
    }
  }
});

test("den se počítá v pražském čase", () => {
  assert.equal(pragueDay(Date.parse("2026-10-19T10:00:00Z")), "2026-10-19");
  assert.equal(pragueDay(Date.parse("2026-10-19T22:30:00Z")), "2026-10-20"); // už po půlnoci v Praze
});

test("společný soubor: zápis, čtení, přechod na další den; poškozený nebo chybějící soubor = 'nedoběhlo'", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kn-priority-"));
  try {
    const file = path.join(dir, "state.json");
    const ledger = fileLedger(file);
    const noon = Date.parse("2026-10-19T10:00:00Z");
    assert.equal(primaryDoneToday(ledger, noon), false); // soubor neexistuje
    markPrimaryDone(ledger, noon);
    assert.equal(primaryDoneToday(ledger, noon + 3600_000), true);
    assert.equal(primaryDoneToday(ledger, noon + 24 * 3600_000), false); // další den
    fs.writeFileSync(file, "{ rozbité");
    assert.equal(primaryDoneToday(ledger, noon), false);
    assert.deepEqual(fs.readdirSync(dir), ["state.json"]); // žádné zbylé dočasné soubory
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
