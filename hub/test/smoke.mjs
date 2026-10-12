// Smoke test: real hub + mock Betterbird extension + real MCP client. Run: node test/smoke.mjs
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const hubDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bbmcp-"));
const env = { ...process.env, BBMCP_CONFIG: path.join(tmp, "config.json"), BBMCP_LOG: path.join(tmp, "audit.log") };
const PORT = 18765;
const setup = (...a) => execFileSync("node", ["setup.mjs", ...a], { cwd: hubDir, env, encoding: "utf8" });
const tokenFrom = (out, re) => out.match(re)[0];

let passed = 0;
const ok = (name) => { passed++; console.log("  ok -", name); };

const initOut = setup("init", "127.0.0.1");
const extToken = tokenFrom(initOut, /bbext_[\w-]+/);
const cfg = JSON.parse(fs.readFileSync(env.BBMCP_CONFIG, "utf8")); cfg.port = PORT; fs.writeFileSync(env.BBMCP_CONFIG, JSON.stringify(cfg));
const readerTok = tokenFrom(setup("add-client", "reader", "read"), /bbmcp_[\w-]+/);
const drafterTok = tokenFrom(setup("add-client", "drafter", "read,draft"), /bbmcp_[\w-]+/);

const hub = spawn("node", ["server.mjs"], { cwd: hubDir, env, stdio: "pipe" });
await new Promise((r) => hub.stdout.on("data", (d) => String(d).includes("nasłuchuje") && r()));
const base = `http://127.0.0.1:${PORT}`;

try {
  // --- HTTP-level checks
  let r = await fetch(`${base}/health`); assert.equal(r.status, 200); assert.equal((await r.json()).extensionConnected, false); ok("health, extension not yet connected");
  r = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); assert.equal(r.status, 401); ok("no token -> 401");
  r = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: "Bearer nope", "Content-Type": "application/json" }, body: "{}" }); assert.equal(r.status, 401); ok("bad token -> 401");
  r = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${readerTok}`, Origin: "http://evil.example", "Content-Type": "application/json" }, body: "{}" }); assert.equal(r.status, 403); ok("browser Origin -> 403");
  r = await fetch(`${base}/mcp`, { headers: { Host: "evil.example", Authorization: `Bearer ${readerTok}` } }).catch(() => null);
  r = await fetch(`${base}/mcp`, { method: "GET", headers: { Authorization: `Bearer ${readerTok}` } }); assert.equal(r.status, 405); ok("GET /mcp -> 405 (stateless)");

  // --- WebSocket auth
  const badWs = new WebSocket(`ws://127.0.0.1:${PORT}/ext?token=wrong`);
  await new Promise((res) => { badWs.on("error", res); badWs.on("close", res); });
  assert.notEqual(badWs.readyState, WebSocket.OPEN); ok("extension WS with bad token rejected");

  // --- Mock extension
  const calls = [];
  const ext = new WebSocket(`ws://127.0.0.1:${PORT}/ext?token=${extToken}`);
  await new Promise((res, rej) => { ext.on("open", res); ext.on("error", rej); });
  ext.on("message", (raw) => {
    const { id, method, params } = JSON.parse(raw); calls.push({ method, params });
    const results = {
      list_accounts: [{ id: "account1", name: "Test", identities: [{ id: "id1", email: "me@example.com" }] }],
      search_messages: { count: 1, messages: [{ id: 42, subject: "Hello", author: "a@b.c" }] },
      get_message: { id: params.messageId, subject: "Hello", body: "Treść wiadomości" },
      create_draft: { saved: true, message: { id: 99, subject: params.subject } },
    };
    ext.send(JSON.stringify(method in results ? { id, result: results[method] } : { id, error: `unknown ${method}` }));
  });
  r = await fetch(`${base}/health`); assert.equal((await r.json()).extensionConnected, true); ok("extension connected");

  // a second (duplicate) extension instance must not kick the first one out
  const ext2 = new WebSocket(`ws://127.0.0.1:${PORT}/ext?token=${extToken}`);
  await new Promise((res, rej) => { ext2.on("open", res); ext2.on("error", rej); });
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(ext.readyState, WebSocket.OPEN); ok("second extension instance does not disconnect the first");
  ext2.close(); await new Promise((res) => setTimeout(res, 300));

  const connect = async (tok) => {
    const c = new Client({ name: "smoke", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tok}` } } }));
    return c;
  };
  const text = (res) => res.content[0].text;

  // --- reader: read tools only
  const reader = await connect(readerTok);
  const rTools = (await reader.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(rTools, ["bridge_status", "get_message", "list_accounts", "list_folders", "search_messages"]); ok("read client sees only read tools");
  assert.equal(JSON.parse(text(await reader.callTool({ name: "list_accounts", arguments: {} })))[0].id, "account1"); ok("round trip: list_accounts");
  const s = JSON.parse(text(await reader.callTool({ name: "search_messages", arguments: { query: "hello", limit: 5 } })));
  assert.equal(s.messages[0].id, 42); assert.equal(calls.at(-1).params.limit, 5); ok("round trip: search_messages with args");
  assert.equal(JSON.parse(text(await reader.callTool({ name: "get_message", arguments: { messageId: 42 } }))).body, "Treść wiadomości"); ok("round trip: get_message (UTF-8)");
  const denied = await reader.callTool({ name: "create_draft", arguments: { body: "x" } }).then((x) => x, (e) => ({ isError: true, e }));
  assert.ok(denied.isError); assert.ok(!calls.some((c) => c.method === "create_draft")); ok("read client cannot call create_draft");
  await reader.close();

  // --- drafter
  const drafter = await connect(drafterTok);
  const dTools = (await drafter.listTools()).tools.map((t) => t.name);
  assert.ok(dTools.includes("create_draft") && !dTools.some((n) => /send|delete|move/.test(n))); ok("draft client sees create_draft, no send/delete/move tools");
  const d = JSON.parse(text(await drafter.callTool({ name: "create_draft", arguments: { to: ["x@y.z"], subject: "Test", body: "Cześć" } })));
  assert.equal(d.message.id, 99); ok("round trip: create_draft");
  await drafter.close();

  // --- bridge down -> clear error
  ext.close(); await new Promise((res) => setTimeout(res, 300));
  const reader2 = await connect(readerTok);
  const down = await reader2.callTool({ name: "list_accounts", arguments: {} });
  assert.ok(down.isError && /nie jest połączone/.test(text(down))); ok("extension offline -> readable tool error");
  await reader2.close();

  // --- audit log
  const logTxt = fs.readFileSync(env.BBMCP_LOG, "utf8");
  assert.ok(logTxt.includes('"client":"drafter"') && logTxt.includes("auth_failed")); assert.ok(!logTxt.includes("Cześć")); ok("audit log written, draft body not logged");

  console.log(`\nAll ${passed} checks passed.`);
} catch (e) {
  console.error("\nFAILED:", e); process.exitCode = 1;
} finally {
  hub.kill(); await new Promise((res) => hub.on("exit", res)); // hub logs its exit; wait before deleting the temp dir
  fs.rmSync(tmp, { recursive: true, force: true });
}
