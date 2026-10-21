// Minimální MCP server (Model Context Protocol, JSON-RPC 2.0 po řádcích přes stdio) bez
// závislostí — umí jen to, co appka potřebuje: initialize, ping, tools/list, tools/call.
// Záměrně bez oficiální SDK: ta by do package.json (sdíleného s hlídacím psem, který ho
// instaluje na GitHub Actions) přitáhla desítky balíčků kvůli jednomu lokálnímu serveru.
//
// Tento modul je čistá logika (zpráva dovnitř → odpověď ven), stdio obstarává
// mcp-server.js. Chyby protokolu (neznámá metoda, špatné parametry) jdou jako JSON-RPC
// error; chyby nástroje (špatný vstup, selhání dotazu) jako výsledek s `isError`, aby je
// model viděl a mohl se opravit.

import { ToolInputError } from "./mcp-tools.js";

// Verze protokolu, které umíme (funkce, které používáme, se mezi nimi neliší).
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const E = { PARSE: -32700, INVALID_REQUEST: -32600, METHOD_NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603 };

const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * @param tools     pole nástrojů z mcp-tools.js (name, title, description, inputSchema, handler(db, args))
 * @param openDb    () => databáze otevřená jen pro čtení (otevírá se při každém volání, ať server přežije
 *                  restart appky i obnovu databáze ze zálohy)
 * @param serverInfo { name, version }
 * @param instructions text pro model (jak nástroje používat)
 * @param log       (řádek) => void — jen do stderr, stdout patří protokolu
 */
export function createMcpServer({ tools, openDb, serverInfo, instructions, log = () => {} }) {
  const byName = new Map(tools.map((t) => [t.name, t]));

  function listTools() {
    return tools.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: { title: t.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }));
  }

  function callTool(params) {
    if (!isObject(params) || typeof params.name !== "string") return { error: [E.INVALID_PARAMS, "Chybí název nástroje (name)."] };
    const tool = byName.get(params.name);
    if (!tool) return { error: [E.INVALID_PARAMS, `Neznámý nástroj: ${params.name}`] };
    const args = params.arguments ?? {};
    if (!isObject(args)) return { error: [E.INVALID_PARAMS, "Argumenty nástroje (arguments) musí být objekt."] };
    let db = null;
    try {
      db = openDb();
      const result = tool.handler(db, args);
      return { result: { content: [{ type: "text", text: JSON.stringify(result) }] } };
    } catch (err) {
      if (!(err instanceof ToolInputError)) log(`nástroj ${tool.name} selhal: ${err.stack || err.message}`);
      const text = err instanceof ToolInputError ? err.message : `Dotaz se nepodařil: ${err.message}`;
      return { result: { content: [{ type: "text", text }], isError: true } };
    } finally {
      try {
        db?.close();
      } catch {
        // už zavřená
      }
    }
  }

  /** Jedna zpráva dovnitř → odpověď (objekt) nebo null (notifikace nebo odpověď klienta, na které se neodpovídá). */
  function handle(message) {
    if (!isObject(message) || message.jsonrpc !== "2.0") return rpcError(isObject(message) ? message.id : null, E.INVALID_REQUEST, "Neplatná JSON-RPC zpráva.");
    const { id, method, params } = message;
    const isRequest = id !== undefined && id !== null;
    // Odpověď klienta na náš požadavek (žádný jsme neposlali) — ignorovat.
    if (method === undefined) return null;
    if (typeof method !== "string") return rpcError(id, E.INVALID_REQUEST, "Chybí metoda.");
    if (!isRequest) return null; // notifikace (např. notifications/initialized, notifications/cancelled)

    switch (method) {
      case "initialize": {
        const requested = isObject(params) ? params.protocolVersion : undefined;
        return rpcResult(id, {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo,
          instructions,
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: listTools() });
      case "tools/call": {
        const out = callTool(params);
        return out.error ? rpcError(id, ...out.error) : rpcResult(id, out.result);
      }
      default:
        return rpcError(id, E.METHOD_NOT_FOUND, `Metoda není podporovaná: ${method}`);
    }
  }

  /** Jeden řádek ze stdin (text) → řádek odpovědi (text) nebo null. */
  function handleLine(line) {
    const text = line.trim();
    if (!text) return null;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return JSON.stringify(rpcError(null, E.PARSE, "Neplatný JSON."));
    }
    // Dávky (pole) protokol od verze 2025-06-18 nepoužívá.
    if (Array.isArray(message)) return JSON.stringify(rpcError(null, E.INVALID_REQUEST, "Dávkové zprávy nejsou podporované."));
    let response;
    try {
      response = handle(message);
    } catch (err) {
      log(`vnitřní chyba: ${err.stack || err.message}`);
      response = rpcError(isObject(message) ? message.id : null, E.INTERNAL, "Vnitřní chyba serveru.");
    }
    return response ? JSON.stringify(response) : null;
  }

  return { handle, handleLine };
}
