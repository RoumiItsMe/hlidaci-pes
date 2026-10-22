// node --test scripts/run-and-commit.test.js
//
// Běh psa + commit stavu proti lokálnímu "origin", kde se během běhu objeví cizí commit (to, co
// 22. 10. 2026 způsobilo dvojí odeslání změn ceny): detekce smí proběhnout právě jednou a stav
// obou stran musí přežít. Potřebuje bash a git (na Windows Git Bash); jinak se přeskočí.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const posix = (p) => p.replace(/\\/g, "/");

function available(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
const SKIP = !(available("bash", ["-c", "true"]) && available("git", ["--version"])) && "bash nebo git není k dispozici";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf-8" });
const readState = (cwd) => JSON.parse(readFileSync(path.join(cwd, "data", "seen.json"), "utf-8"));

/**
 * Připraví bare origin + klon "runner" (checkout Actions) se skripty a stavem {"byty:idnes":[{id:1,price:100}]}.
 * `stub` je tělo shellu místo `node index.js`; má k dispozici $COUNTER a $OTHER (druhý klon, ze kterého jde
 * simulovat cizí push).
 */
function setup(stubBody) {
  const root = mkdtempSync(path.join(os.tmpdir(), "run-and-commit-"));
  const origin = path.join(root, "origin.git");
  const runner = path.join(root, "runner");
  const other = path.join(root, "other");
  git(root, "init", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, runner);
  for (const dir of [runner]) {
    git(dir, "config", "user.name", "test");
    git(dir, "config", "user.email", "test@example.com");
    git(dir, "config", "core.autocrlf", "false");
  }
  mkdirSync(path.join(runner, "scripts"));
  mkdirSync(path.join(runner, "lib"));
  mkdirSync(path.join(runner, "data"));
  for (const f of ["package.json", "config.js", "lib/state.js", "scripts/merge-seen.js", "scripts/run-and-commit.sh"]) {
    cpSync(path.join(REPO, f), path.join(runner, f));
  }
  // skript v kopii musí mít LF i když to autocrlf na Windows přepsal
  const sh = path.join(runner, "scripts", "run-and-commit.sh");
  writeFileSync(sh, readFileSync(sh, "utf-8").replace(/\r\n/g, "\n"));
  writeFileSync(path.join(runner, "data", "seen.json"), JSON.stringify({ "byty:idnes": [{ id: "1", price: 100 }] }, null, 2) + "\n");
  git(runner, "add", "-A");
  git(runner, "commit", "-q", "-m", "init");
  git(runner, "push", "-q", "origin", "main");
  git(root, "clone", "-q", origin, other);
  git(other, "config", "user.name", "someone");
  git(other, "config", "user.email", "someone@example.com");
  git(other, "config", "core.autocrlf", "false");

  const counter = path.join(root, "counter.txt");
  writeFileSync(path.join(root, "stub.sh"), `set -e\necho x >> "${posix(counter)}"\nOTHER="${posix(other)}"\n${stubBody}\n`);
  const run = spawnSync("bash", ["scripts/run-and-commit.sh"], {
    cwd: runner,
    encoding: "utf-8",
    env: { ...process.env, WATCH_CMD: `bash ${posix(path.join(root, "stub.sh"))}`, RUNNER_TEMP: posix(root) },
  });
  const runs = existsSync(counter) ? readFileSync(counter, "utf-8").trim().split("\n").length : 0;
  const verify = path.join(root, "verify");
  git(root, "clone", "-q", origin, verify);
  return { root, run, runs, originState: readState(verify), verify, output: `${run.stdout}\n${run.stderr}` };
}

// Co udělá "běh": zaznamená nový inzerát 2 a změní cenu inzerátu 1 (odešla by notifikace).
const WATCH_EDIT = String.raw`node -e '
const fs=require("fs");const f="data/seen.json";const s=JSON.parse(fs.readFileSync(f,"utf8"));
s["byty:idnes"]=[{id:"1",price:90},{id:"2",price:200}];
fs.writeFileSync(f,JSON.stringify(s,null,2)+"\n");'`;

const raceCommit = (body) => `
cd "$OTHER"
${body}
git push -q origin main
cd - >/dev/null
`;

test("bez souběhu: stav se pushne, detekce proběhne jednou", { skip: SKIP }, () => {
  const r = setup(WATCH_EDIT);
  try {
    assert.equal(r.run.status, 0, r.output);
    assert.equal(r.runs, 1);
    assert.deepEqual(r.originState["byty:idnes"], [{ id: "1", price: 90 }, { id: "2", price: 200 }]);
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test("cizí commit (jiný soubor) během běhu: push se zopakuje, detekce se NEpouští znovu", { skip: SKIP }, () => {
  const r = setup(`${WATCH_EDIT}\n${raceCommit(`echo cizi > cizi.txt; git add cizi.txt; git commit -q -m "cizi commit"`)}`);
  try {
    assert.equal(r.run.status, 0, r.output);
    assert.equal(r.runs, 1, "detekce (a tím odeslání notifikací) musí proběhnout právě jednou");
    assert.match(r.output, /Push selhal/);
    assert.deepEqual(r.originState["byty:idnes"], [{ id: "1", price: 90 }, { id: "2", price: 200 }]);
    assert.ok(existsSync(path.join(r.verify, "cizi.txt")), "cizí commit na origin zůstal");
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test("cizí commit mění i stav: změny obou stran se sloučí", { skip: SKIP }, () => {
  const theirsEdit = String.raw`node -e '
const fs=require("fs");const f="data/seen.json";const s=JSON.parse(fs.readFileSync(f,"utf8"));
s["byty:idnes"].push({id:"3",price:300});
fs.writeFileSync(f,JSON.stringify(s,null,2)+"\n");'`;
  const r = setup(`${WATCH_EDIT}\n${raceCommit(`${theirsEdit}; git add data/seen.json; git commit -q -m "stav z jineho zdroje"`)}`);
  try {
    assert.equal(r.run.status, 0, r.output);
    assert.equal(r.runs, 1);
    assert.deepEqual(r.originState["byty:idnes"], [{ id: "1", price: 90 }, { id: "3", price: 300 }, { id: "2", price: 200 }]);
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});

test("běh nic nezměnil: nic se necommituje a exit kód běhu se zachová", { skip: SKIP }, () => {
  const r = setup(`exit 3`);
  try {
    assert.equal(r.run.status, 3, r.output);
    assert.match(r.output, /Stav beze změny/);
    assert.deepEqual(r.originState["byty:idnes"], [{ id: "1", price: 100 }]);
  } finally {
    rmSync(r.root, { recursive: true, force: true });
  }
});
