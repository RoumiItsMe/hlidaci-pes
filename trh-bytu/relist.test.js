// node --test trh-bytu/relist.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { isMissConfirmed, MIN_CONFIRM_GAP_MS } from "./relist.js";

const T0 = Date.parse("2026-10-16T06:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

test("zmizení potvrdí až další běh po odstupu, ne dva běhy hned po sobě", () => {
  assert.equal(isMissConfirmed(iso(T0), T0 + 5 * 60 * 1000), false); // ruční aktualizace pár minut po sběru
  assert.equal(isMissConfirmed(iso(T0), T0 + MIN_CONFIRM_GAP_MS - 1000), false);
  assert.equal(isMissConfirmed(iso(T0), T0 + MIN_CONFIRM_GAP_MS), true);
  assert.equal(isMissConfirmed(iso(T0), T0 + 24 * 60 * 60 * 1000), true); // běžný denní běh
});

test("bez prvního výpadku není co potvrzovat", () => {
  assert.equal(isMissConfirmed(null, T0), false);
  assert.equal(isMissConfirmed(undefined, T0), false);
});
