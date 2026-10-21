// node --test trh-bytu/mcp-protocol.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { createMcpServer, PROTOCOL_VERSIONS } from "./mcp-protocol.js";
import { ToolInputError } from "./mcp-tools.js";
import { initDb, insertListing } from "./db.js";

function makeServer(overrides = {}) {
  const logs = [];
  const closed = [];
  const tools = [
    { name: "ok", title: "OK", description: "Vrátí objekt.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, handler: (db, args) => ({ hotovo: true, args, db: db.id }) },
    {
      name: "spatny_vstup",
      title: "Špatný vstup",
      description: "Vždy odmítne vstup.",
      inputSchema: { type: "object", properties: {} },
      handler: () => {
        throw new ToolInputError("Parametr „x“ je špatně.");
      },
    },
    {
      name: "spadne",
      title: "Spadne",
      description: "Vždy selže.",
      inputSchema: { type: "object", properties: {} },
      handler: () => {
        throw new Error("rozbité");
      },
    },
  ];
  const server = createMcpServer({
    tools,
    openDb: overrides.openDb ?? (() => ({ id: "db1", close: () => closed.push("zavřeno") })),
    serverInfo: { name: "test", version: "1.0.0" },
    instructions: "Pokyny pro model.",
    log: (l) => logs.push(l),
  });
  return { server, logs, closed };
}
const call = (server, method, params, id = 1) => server.handle({ jsonrpc: "2.0", id, method, params });

test("initialize: vrátí zvolenou verzi protokolu, schopnost tools, serverInfo a pokyny", () => {
  const { server } = makeServer();
  const r = call(server, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "1" } });
  assert.equal(r.id, 1);
  assert.equal(r.result.protocolVersion, "2025-06-18");
  assert.ok(r.result.capabilities.tools);
  assert.equal(r.result.capabilities.resources, undefined); // jen to, co umíme
  assert.deepEqual(r.result.serverInfo, { name: "test", version: "1.0.0" });
  assert.equal(r.result.instructions, "Pokyny pro model.");
});

test("initialize: verze, kterou klient chce a my umíme, se zopakuje; neznámá nebo chybějící dostane naši nejnovější", () => {
  const { server } = makeServer();
  for (const v of PROTOCOL_VERSIONS) assert.equal(call(server, "initialize", { protocolVersion: v }).result.protocolVersion, v);
  assert.equal(call(server, "initialize", { protocolVersion: "2099-01-01" }).result.protocolVersion, PROTOCOL_VERSIONS[0]);
  assert.equal(call(server, "initialize", {}).result.protocolVersion, PROTOCOL_VERSIONS[0]);
  assert.equal(call(server, "initialize").result.protocolVersion, PROTOCOL_VERSIONS[0]);
});

test("notifikace a odpovědi klienta se nezodpovídají; ping vrátí prázdný objekt", () => {
  const { server } = makeServer();
  assert.equal(server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.equal(server.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 5 } }), null);
  assert.equal(server.handle({ jsonrpc: "2.0", id: 7, result: {} }), null); // odpověď klienta na náš požadavek
  assert.deepEqual(call(server, "ping").result, {});
});

test("tools/list: jméno, název, popis, schéma a příznaky jen pro čtení", () => {
  const { server } = makeServer();
  const { tools } = call(server, "tools/list", {}).result;
  assert.deepEqual(tools.map((t) => t.name), ["ok", "spatny_vstup", "spadne"]);
  assert.equal(tools[0].title, "OK");
  assert.equal(tools[0].inputSchema.type, "object");
  assert.deepEqual(tools[0].annotations, { title: "OK", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  assert.equal(tools[0].handler, undefined); // funkce se ven nedostane
});

test("tools/call: výsledek jako textový JSON, databáze se po volání zavře", () => {
  const { server, closed } = makeServer();
  const r = call(server, "tools/call", { name: "ok", arguments: { a: 1 } });
  assert.equal(r.result.isError, undefined);
  assert.equal(r.result.content[0].type, "text");
  assert.deepEqual(JSON.parse(r.result.content[0].text), { hotovo: true, args: { a: 1 }, db: "db1" });
  assert.deepEqual(closed, ["zavřeno"]);
  // bez arguments se bere prázdný objekt
  assert.deepEqual(JSON.parse(call(server, "tools/call", { name: "ok" }).result.content[0].text).args, {});
});

test("tools/call: špatný vstup nástroje je výsledek s isError (model ho vidí), ne chyba protokolu; databáze se zavře i tak", () => {
  const { server, closed, logs } = makeServer();
  const r = call(server, "tools/call", { name: "spatny_vstup", arguments: {} });
  assert.equal(r.error, undefined);
  assert.equal(r.result.isError, true);
  assert.equal(r.result.content[0].text, "Parametr „x“ je špatně.");
  assert.deepEqual(closed, ["zavřeno"]);
  assert.deepEqual(logs, []); // chyba uživatele se do logu nezapisuje
});

test("tools/call: neočekávané selhání nástroje je isError s obecnou hláškou a zápisem do logu", () => {
  const { server, logs, closed } = makeServer();
  const r = call(server, "tools/call", { name: "spadne", arguments: {} });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /Dotaz se nepodařil: rozbité/);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /spadne/);
  assert.deepEqual(closed, ["zavřeno"]);
});

test("tools/call: databáze, která nejde otevřít, je isError s důvodem (a nic se nezavírá)", () => {
  const { server, closed } = makeServer({
    openDb: () => {
      throw new Error("databáze nebyla nalezena");
    },
  });
  const r = call(server, "tools/call", { name: "ok", arguments: {} });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /databáze nebyla nalezena/);
  assert.deepEqual(closed, []);
});

test("tools/call: neznámý nástroj, chybějící jméno a argumenty, které nejsou objekt, jsou chyba protokolu -32602", () => {
  const { server } = makeServer();
  for (const params of [{ name: "nic" }, {}, null, { name: 5 }, { name: "ok", arguments: [1] }, { name: "ok", arguments: "x" }]) {
    const r = call(server, "tools/call", params);
    assert.equal(r.error?.code, -32602, JSON.stringify(params));
    assert.equal(r.result, undefined);
  }
});

test("neznámá metoda je -32601; zpráva bez jsonrpc 2.0 nebo s chybnou metodou je -32600; id se vrací", () => {
  const { server } = makeServer();
  assert.equal(call(server, "resources/list", {}, 9).error.code, -32601);
  assert.equal(call(server, "resources/list", {}, 9).id, 9);
  assert.equal(server.handle({ id: 3, method: "ping" }).error.code, -32600);
  assert.equal(server.handle({ jsonrpc: "2.0", id: 4, method: 5 }).error.code, -32600);
  assert.equal(server.handle("text").error.code, -32600);
  assert.equal(server.handle(null).error.code, -32600);
});

test("řádky: prázdný se přeskočí, nevalidní JSON je -32700 s id null, dávka je -32600, jinak jeden řádek JSON", () => {
  const { server } = makeServer();
  assert.equal(server.handleLine("   "), null);
  assert.equal(server.handleLine(""), null);
  assert.deepEqual(JSON.parse(server.handleLine("{nejde")), { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Neplatný JSON." } });
  assert.equal(JSON.parse(server.handleLine("[]")).error.code, -32600);
  assert.equal(server.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })), null);
  const out = server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
  assert.ok(!out.includes("\n")); // protokol po řádcích — odpověď nesmí obsahovat zalomení
  assert.equal(JSON.parse(out).result.tools.length, 3);
  // česká diakritika projde beze změny
  assert.match(server.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "spatny_vstup" } })), /Parametr „x“ je špatně/);
});

// --- skutečný server přes stdio (podproces) nad zkušební databází ---

function startServer(env) {
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "mcp-server.js")], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  const lines = [];
  const waiters = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    lines.push(line);
    waiters.shift()?.();
  });
  const nextLine = async () => {
    if (!lines.length) await new Promise((resolve) => waiters.push(resolve));
    return lines.shift();
  };
  const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, send, nextLine, exited, stderr: () => stderr };
}

test("stdio server: handshake, seznam nástrojů, volání nad zkušební databází, čistý stdout, konec po zavření vstupu", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-stdio-"));
  const file = path.join(dir, "t.sqlite");
  const rw = initDb(new DatabaseSync(file));
  insertListing(rw, { id: "sreality:1", source: "sreality", source_id: "1", url: "https://example.invalid/1", title: "Prodej bytu", disposition: "2+1", area_m2: 55, address: "Letohrad, ul. Nová", description: "", price_czk: 3_500_000, status: "active", first_seen_at: "2026-10-18T08:00:00Z", last_seen_at: "2026-10-20T06:00:00Z" });
  rw.close();
  const s = startServer({ TRH_DB_PATH: file });
  try {
    s.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } });
    const init = JSON.parse(await s.nextLine());
    assert.equal(init.result.serverInfo.name, "trh-bytu-default");
    s.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    s.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const list = JSON.parse(await s.nextLine()); // jediná odpověď po notifikaci je ta na tools/list
    assert.equal(list.id, 2);
    assert.deepEqual(list.result.tools.map((t) => t.name), ["trh_prehled", "prodane_byty", "statistiky_cen", "nabidky", "zmeny_cen", "detail_bytu"]);
    s.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "trh_prehled", arguments: {} } });
    const overview = JSON.parse(await s.nextLine());
    assert.equal(overview.id, 3);
    const data = JSON.parse(overview.result.content[0].text);
    assert.equal(data.vNabidce, 1);
    assert.equal(data.sekce, "http://localhost:4321");
    s.send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "prodane_byty", arguments: { od: "špatně" } } });
    const bad = JSON.parse(await s.nextLine());
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /RRRR-MM-DD/);
    s.child.stdin.end();
    assert.equal(await s.exited, 0);
    assert.match(s.stderr(), /připraven/);
  } finally {
    s.child.kill();
  }
});

test("stdio server: chybějící databáze nespadne — nástroj vrátí isError s vysvětlením; sekce se volí TRH_REGION", async () => {
  const s = startServer({ TRH_DB_PATH: path.join(os.tmpdir(), "neexistuje-db.sqlite"), TRH_REGION: "nachod" });
  try {
    s.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    assert.equal(JSON.parse(await s.nextLine()).result.serverInfo.name, "trh-bytu-nachod");
    s.send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "trh_prehled", arguments: {} } });
    const r = JSON.parse(await s.nextLine());
    assert.equal(r.result.isError, true);
    assert.match(r.result.content[0].text, /nebyla nalezena/);
    s.send({ jsonrpc: "2.0", id: 3, method: "ping" });
    assert.deepEqual(JSON.parse(await s.nextLine()).result, {}); // server dál žije
    s.child.stdin.end();
    assert.equal(await s.exited, 0);
  } finally {
    s.child.kill();
  }
});
