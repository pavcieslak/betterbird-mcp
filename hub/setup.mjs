// Token management. Tokens are shown ONCE; only their SHA-256 is stored in config.json.
//   node setup.mjs init [tailscale-ip] [allowed-host ...]
//   node setup.mjs add-client <name> <read,draft,modify>
//   node setup.mjs rotate-ext
//   node setup.mjs list
//   node setup.mjs revoke <name>
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.BBMCP_CONFIG || path.join(dir, "config.json");
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const newToken = (prefix) => `${prefix}_${crypto.randomBytes(32).toString("base64url")}`;
const ALLOWED = new Set(["read", "draft", "modify"]);

const load = () => JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const save = (c) => { fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2), { mode: 0o600 }); };

const [cmd, ...args] = process.argv.slice(2);

if (cmd === "init") {
  if (fs.existsSync(CONFIG_PATH)) { console.error("config.json already exists. Delete it if you want to start over."); process.exit(1); }
  const [tsIp, ...hosts] = args;
  const ext = newToken("bbext");
  const config = {
    port: 8765,
    bind: tsIp ? [tsIp, "127.0.0.1"] : ["127.0.0.1"],
    allowedHosts: hosts,
    extTokenHash: sha(ext),
    clients: [],
  };
  save(config);
  console.log("Created config.json\n");
  console.log("EXTENSION TOKEN (paste it into the extension options in Betterbird; shown only once):");
  console.log(ext, "\n");
  console.log("Add clients: node setup.mjs add-client <name> read,draft");
} else if (cmd === "add-client") {
  const [name, permsArg = "read"] = args;
  if (!name) { console.error("Give a client name"); process.exit(1); }
  const permissions = permsArg.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = permissions.filter((p) => !ALLOWED.has(p));
  if (bad.length) { console.error(`Unknown permissions: ${bad.join(", ")} (allowed: read, draft, modify)`); process.exit(1); }
  const config = load();
  if (config.clients.some((c) => c.name === name)) { console.error("A client with this name already exists (revoke it first)."); process.exit(1); }
  const token = newToken("bbmcp");
  config.clients.push({ name, permissions, tokenHash: sha(token), created: new Date().toISOString() });
  save(config);
  console.log(`Client: ${name}  permissions: ${permissions.join(",")}`);
  console.log("TOKEN (shown only once):");
  console.log(token);
} else if (cmd === "rotate-ext") {
  const config = load();
  const ext = newToken("bbext");
  config.extTokenHash = sha(ext);
  save(config);
  console.log("New EXTENSION TOKEN (shown only once, starts with bbext_):");
  console.log(ext);
  console.log("Paste it into the extension options in Betterbird and click 'Save and connect'. Client tokens (Rakazo etc.) are unchanged.");
} else if (cmd === "list") {
  const c = load();
  console.log(`bind: ${c.bind.join(", ")}  port: ${c.port}`);
  for (const cl of c.clients) console.log(`- ${cl.name}  [${cl.permissions.join(",")}]  ${cl.created}`);
} else if (cmd === "revoke") {
  const c = load();
  const before = c.clients.length;
  c.clients = c.clients.filter((x) => x.name !== args[0]);
  save(c);
  console.log(before === c.clients.length ? "Client not found." : `Revoked: ${args[0]}`);
} else {
  console.log("Usage: node setup.mjs init [tailscale-ip] [host...] | add-client <name> <permissions> | rotate-ext | list | revoke <name>");
}
