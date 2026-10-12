// Betterbird MCP Hub
// - /mcp  : Streamable HTTP (stateless), Bearer token per client, per-client permissions
// - /ext  : WebSocket for the Betterbird extension (loopback only, own token)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.BBMCP_CONFIG || path.join(__dirname, "config.json");
const LOG_PATH = process.env.BBMCP_LOG || path.join(__dirname, "audit.log");

const sha256 = (s) => crypto.createHash("sha256").update(s).digest();
function tokenMatches(plain, hashHex) {
  if (!plain || !hashHex) return false;
  const a = sha256(plain);
  const b = Buffer.from(hashHex, "hex");
  return b.length === a.length && crypto.timingSafeEqual(a, b);
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.error(`Brak ${CONFIG_PATH}. Uruchom najpierw: node setup.mjs init`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}
let config = loadConfig();
// config is re-read on SIGHUP / when the file changes, so new clients need no restart
fs.watchFile(CONFIG_PATH, { interval: 2000 }, () => {
  try { config = loadConfig(); log("hub", "config_reloaded", {}); } catch (e) { console.error("config reload failed", e.message); }
});

function log(client, event, detail) {
  const line = JSON.stringify({ t: new Date().toISOString(), client, event, ...detail });
  try { fs.appendFileSync(LOG_PATH, line + "\n"); } catch { /* ignore */ }
  if (process.env.BBMCP_VERBOSE) console.log(line);
}

// ---------------------------------------------------------------- bridge
let extSocket = null;
let nextId = 1;
const pending = new Map();

function callExtension(method, params = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!extSocket || extSocket.readyState !== 1) {
      return reject(new Error("Rozszerzenie Betterbirda nie jest połączone z hubem (uruchom Betterbird i sprawdź token w opcjach rozszerzenia)."));
    }
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: rozszerzenie nie odpowiedziało na ${method}`)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    extSocket.send(JSON.stringify({ id, method, params }));
  });
}

function handleExtMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  const p = pending.get(msg.id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(msg.id);
  if (msg.error) p.reject(new Error(msg.error)); else p.resolve(msg.result);
}

// ---------------------------------------------------------------- MCP tools
const asText = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });

function buildServer(client) {
  const server = new McpServer({ name: "betterbird-mcp", version: "0.1.0" });
  const perms = new Set(client.permissions);

  const tool = (name, perm, def, handler) => {
    if (!perms.has(perm)) return; // tools above the client's permission level are not even listed
    server.registerTool(name, def, async (args) => {
      log(client.name, "tool_call", { tool: name, args: redact(args) });
      try { return asText(await handler(args)); }
      catch (e) { log(client.name, "tool_error", { tool: name, error: e.message }); return { isError: true, ...asText(`Błąd: ${e.message}`) }; }
    });
  };

  tool("bridge_status", "read", {
    title: "Bridge status",
    description: "Check whether the Betterbird extension is connected to the hub.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => ({ extensionConnected: !!extSocket && extSocket.readyState === 1 }));

  tool("list_accounts", "read", {
    title: "List accounts",
    description: "List mail accounts and their identities (ids needed for other tools).",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, () => callExtension("list_accounts"));

  tool("list_folders", "read", {
    title: "List folders",
    description: "List folders (id, name, path, type, unread count). Optionally for one account.",
    inputSchema: { accountId: z.string().optional() },
    annotations: { readOnlyHint: true },
  }, (a) => callExtension("list_folders", a));

  tool("search_messages", "read", {
    title: "Search messages",
    description: "Search messages across folders. Returns headers only (no body); use get_message for the content.",
    inputSchema: {
      query: z.string().optional().describe("Full-text query"),
      from: z.string().optional().describe("Author contains"),
      to: z.string().optional().describe("Recipient contains"),
      subject: z.string().optional().describe("Subject contains"),
      folderId: z.string().optional().describe("Limit to one folder (id from list_folders)"),
      unread: z.boolean().optional(),
      flagged: z.boolean().optional(),
      fromDate: z.string().optional().describe("ISO date, messages on/after"),
      toDate: z.string().optional().describe("ISO date, messages on/before"),
      limit: z.number().int().min(1).max(100).default(25),
    },
    annotations: { readOnlyHint: true },
  }, (a) => callExtension("search_messages", a, 60000));

  tool("get_message", "read", {
    title: "Get message",
    description: "Get one message: headers, body text and attachment list (names/sizes only).",
    inputSchema: {
      messageId: z.number().int(),
      maxBodyChars: z.number().int().min(100).max(200000).default(20000),
    },
    annotations: { readOnlyHint: true },
  }, (a) => callExtension("get_message", a, 60000));

  tool("create_draft", "draft", {
    title: "Create draft",
    description: "Create a draft in the Drafts folder of the account. It NEVER sends mail; the user reviews and sends it manually in Betterbird.",
    inputSchema: {
      to: z.array(z.string()).default([]),
      cc: z.array(z.string()).optional(),
      bcc: z.array(z.string()).optional(),
      subject: z.string().default(""),
      body: z.string().describe("Message body"),
      isHtml: z.boolean().default(false),
      identityId: z.string().optional().describe("Sender identity id from list_accounts"),
      replyToMessageId: z.number().int().optional().describe("Create the draft as a reply to this message"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  }, (a) => callExtension("create_draft", a, 60000));

  return server;
}

function redact(args) {
  const o = { ...args };
  if (typeof o.body === "string") o.body = `[${o.body.length} chars]`;
  return o;
}

// ---------------------------------------------------------------- HTTP
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function hostAllowed(hostHeader) {
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  const allowed = new Set(["localhost", "127.0.0.1", "::1", ...(config.bind || []), ...(config.allowedHosts || [])].map((s) => s.toLowerCase()));
  return allowed.has(host);
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const json = (res, code, obj, headers = {}) => { res.writeHead(code, { "Content-Type": "application/json", ...headers }); res.end(JSON.stringify(obj)); };

async function handleHttp(req, res) {
  const url = new URL(req.url, "http://x");
  if (!hostAllowed(req.headers.host)) return json(res, 403, { error: "host not allowed" });
  if (req.headers.origin) return json(res, 403, { error: "browser origins are not allowed" });

  if (url.pathname === "/health") return json(res, 200, { ok: true, extensionConnected: !!extSocket && extSocket.readyState === 1 });
  if (url.pathname !== "/mcp") return json(res, 404, { error: "not found" });

  const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const client = (config.clients || []).find((c) => tokenMatches(bearer, c.tokenHash));
  if (!client) {
    log("?", "auth_failed", { ip: req.socket.remoteAddress });
    return json(res, 401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
  }
  if (req.method !== "POST") return json(res, 405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server: use POST)" }, id: null }, { Allow: "POST" });

  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }); }

  const server = buildServer(client);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
const extSockets = new Set();
wss.on("connection", (ws) => {
  // Several extension instances may connect (e.g. a stale add-on page). Never kick the others out
  // (that makes them reconnect in a loop); route requests to the newest live one.
  extSockets.add(ws);
  extSocket = ws;
  log("ext", "connected", { instances: extSockets.size });
  ws.on("message", handleExtMessage);
  ws.on("close", () => {
    extSockets.delete(ws);
    if (extSocket === ws) extSocket = [...extSockets].filter((s) => s.readyState === 1).pop() || null;
    log("ext", "disconnected", { instances: extSockets.size });
  });
  ws.on("error", () => {});
});

function onUpgrade(req, socket, head) {
  const url = new URL(req.url, "http://x");
  const ok = url.pathname === "/ext"
    && LOOPBACK.has(req.socket.remoteAddress)
    && !req.headers.origin?.startsWith("http") // browsers pages are refused; moz-extension:// is fine
    && tokenMatches(url.searchParams.get("token"), config.extTokenHash);
  if (!ok) { log("ext", "ws_rejected", { ip: req.socket.remoteAddress }); socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
}

const PORT = config.port || 8765;
const binds = [...new Set(config.bind && config.bind.length ? config.bind : ["127.0.0.1"])];
if (!binds.includes("127.0.0.1")) binds.push("127.0.0.1"); // the extension always connects over loopback

let listening = 0;
for (const host of binds) {
  const srv = http.createServer((req, res) => handleHttp(req, res).catch((e) => { log("hub", "http_error", { error: e.message }); if (!res.headersSent) json(res, 500, { error: "internal error" }); }));
  srv.on("upgrade", onUpgrade);
  srv.on("error", (e) => console.error(`Nie można nasłuchiwać na ${host}:${PORT} - ${e.code || e.message}`));
  srv.listen(PORT, host, () => { listening++; console.log(`Hub nasłuchuje na http://${host}:${PORT}/mcp`); });
}
// Diagnostics: record why the process ended, and survive a stray error from a single request.
process.on("uncaughtException", (e) => { log("hub", "uncaught_exception", { error: String((e && e.stack) || e) }); });
process.on("unhandledRejection", (e) => { log("hub", "unhandled_rejection", { error: String((e && e.stack) || e) }); });
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
  try { process.on(sig, () => { log("hub", "signal", { signal: sig }); process.exit(0); }); } catch { /* signal not supported on this platform */ }
}
process.on("exit", (code) => { log("hub", "exit", { code }); });
log("hub", "started", { pid: process.pid, node: process.version, binds });
