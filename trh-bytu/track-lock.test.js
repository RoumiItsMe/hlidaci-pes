// node --test trh-bytu/track-lock.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireTrackLock, releaseTrackLock, readTrackLock, STALE_LOCK_MS } from "./track-lock.js";

function withDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "track-lock-"));
  try {
    fn(path.join(dir, "data", "track.lock"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("první běh zámek získá (i když složka ještě neexistuje), druhý souběžný ne", () => {
  withDir((lock) => {
    assert.equal(acquireTrackLock(lock, { pid: 1 }), true);
    assert.equal(acquireTrackLock(lock, { pid: 2 }), false);
    assert.equal(readTrackLock(lock).pid, 1);
  });
});

test("po uvolnění jde zámek získat znovu; cizí běh ho ale uvolnit nemůže", () => {
  withDir((lock) => {
    acquireTrackLock(lock, { pid: 1 });
    releaseTrackLock(lock, 2);
    assert.equal(existsSync(lock), true);
    releaseTrackLock(lock, 1);
    assert.equal(existsSync(lock), false);
    assert.equal(acquireTrackLock(lock, { pid: 3 }), true);
  });
});

test("zámek po spadlém běhu (starší než STALE_LOCK_MS) se převezme", () => {
  withDir((lock) => {
    const t0 = Date.parse("2026-10-16T08:00:00.000Z");
    acquireTrackLock(lock, { pid: 1, now: t0 });
    assert.equal(acquireTrackLock(lock, { pid: 2, now: t0 + STALE_LOCK_MS - 1000 }), false);
    assert.equal(readTrackLock(lock, t0 + STALE_LOCK_MS + 1000), null);
    assert.equal(acquireTrackLock(lock, { pid: 2, now: t0 + STALE_LOCK_MS + 1000 }), true);
    assert.equal(readTrackLock(lock, t0 + STALE_LOCK_MS + 2000).pid, 2);
  });
});

test("nečitelný zámek neblokuje", () => {
  withDir((lock) => {
    acquireTrackLock(lock, { pid: 1 });
    writeFileSync(lock, "ne-json");
    assert.equal(readTrackLock(lock), null);
    assert.equal(acquireTrackLock(lock, { pid: 2 }), true);
  });
});
