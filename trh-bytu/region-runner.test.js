// node --test trh-bytu/region-runner.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { runOtherRegions, REGION_RUN_TIMEOUT_MS } from "./region-runner.js";

const regions = [{ key: "nachod" }, { key: "jiny" }];
const quiet = () => {};

test("plánované spuštění (bez regionu): každý další region se pustí jako vlastní proces s TRH_REGION a limitem", () => {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ args, region: opts.env.TRH_REGION, timeout: opts.timeout });
    return { status: 0 };
  };
  const results = runOtherRegions({ scriptPath: "track.js", log: quiet, regions, env: { PATH: "x" }, spawn });
  assert.deepEqual(calls.map((c) => c.region), ["nachod", "jiny"]);
  assert.deepEqual(calls[0].args, ["track.js"]);
  assert.equal(calls[0].timeout, REGION_RUN_TIMEOUT_MS);
  assert.deepEqual(results, [{ key: "nachod", ok: true }, { key: "jiny", ok: true }]);
});

test("region zadaný výslovně (ruční spuštění, tlačítko) žádný další nespouští — jinak by se rozběh zacyklil", () => {
  const spawn = () => assert.fail("nemělo se nic spouštět");
  assert.deepEqual(runOtherRegions({ scriptPath: "track.js", log: quiet, regions, env: { TRH_REGION: "nachod" }, spawn }), []);
  assert.deepEqual(runOtherRegions({ scriptPath: "track.js", log: quiet, regions, env: { TRH_REGION: "default" }, spawn }), []);
});

test("chyba nebo výjimka jednoho regionu nic neshodí a neodnese další; hlásí se do logu", () => {
  const logs = [];
  const spawn = (cmd, args, opts) => {
    if (opts.env.TRH_REGION === "nachod") throw new Error("nejde spustit");
    return { status: 3 };
  };
  const results = runOtherRegions({ scriptPath: "track.js", log: (l) => logs.push(l), regions, env: {}, spawn });
  assert.deepEqual(results, [{ key: "nachod", ok: false }, { key: "jiny", ok: false }]);
  assert.ok(logs.some((l) => /nachod se nepodařilo spustit: nejde spustit/.test(l)));
  assert.ok(logs.some((l) => /jiny skončil s chybou \(kód 3\)/.test(l)));
});

test("časový limit (spawnSync vrátí error) se hlásí jako chyba regionu", () => {
  const logs = [];
  const spawn = () => ({ status: null, error: new Error("ETIMEDOUT") });
  const [r] = runOtherRegions({ scriptPath: "track.js", log: (l) => logs.push(l), regions: [regions[0]], env: {}, spawn });
  assert.equal(r.ok, false);
  assert.ok(logs.some((l) => /ETIMEDOUT/.test(l)));
});
