// Betterbird MCP Bridge - connects to the local hub over WebSocket (127.0.0.1) and
// executes a small, fixed set of read / draft operations. It can NOT send mail.

const DEFAULTS = { hubUrl: "ws://127.0.0.1:8765/ext", token: "" };
let ws = null;
let retryMs = 1000;
let state = "disconnected";
let timer = null;
// exactly one pending reconnect at any time, otherwise two sockets replace each other in a loop
function schedule(ms) { clearTimeout(timer); timer = setTimeout(connect, ms); }

async function getSettings() {
  const s = await messenger.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...s };
}

async function connect() {
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return; // already connecting/connected
  const { hubUrl, token } = await getSettings();
  if (!token) { state = "no token"; return schedule(5000); }
  try {
    const u = new URL(hubUrl);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) {
      state = "refused: hub URL must be loopback";
      return schedule(10000);
    }
    u.searchParams.set("token", token);
    ws = new WebSocket(u.toString());
  } catch (e) { state = "bad url"; return schedule(10000); }

  ws.onopen = () => { state = "connected"; retryMs = 1000; };
  ws.onmessage = async (ev) => {
    let req;
    try { req = JSON.parse(ev.data); } catch { return; }
    try {
      const fn = handlers[req.method];
      if (!fn) throw new Error(`unknown method ${req.method}`);
      const result = await fn(req.params || {});
      ws.send(JSON.stringify({ id: req.id, result }));
    } catch (e) {
      ws.send(JSON.stringify({ id: req.id, error: String(e && e.message || e) }));
    }
  };
  ws.onclose = () => { state = "disconnected"; ws = null; retryMs = Math.min(retryMs * 2, 30000); schedule(retryMs); };
  ws.onerror = () => {};
}

// ------------------------------------------------------------------ helpers
const brief = (m) => ({
  id: m.id,
  date: m.date,
  author: m.author,
  recipients: m.recipients,
  ccList: m.ccList,
  subject: m.subject,
  read: m.read,
  flagged: m.flagged,
  folder: m.folder ? { id: m.folder.id, name: m.folder.name, path: m.folder.path, accountId: m.folder.accountId } : undefined,
  headerMessageId: m.headerMessageId,
  size: m.size,
});

function flattenFolders(folders, out = []) {
  for (const f of folders || []) {
    out.push({ id: f.id, accountId: f.accountId, name: f.name, path: f.path, type: f.type });
    if (f.subFolders) flattenFolders(f.subFolders, out);
  }
  return out;
}

function htmlToText(html) {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n").trim();
}

function collectParts(part, acc = { text: [], html: [], attachments: [] }) {
  const ct = (part.contentType || "").toLowerCase();
  if (part.name || part.fileName) {
    if (part.name) acc.attachments.push({ name: part.name, contentType: part.contentType, size: part.size });
  } else if (ct.startsWith("text/plain") && part.body) acc.text.push(part.body);
  else if (ct.startsWith("text/html") && part.body) acc.html.push(part.body);
  for (const p of part.parts || []) collectParts(p, acc);
  return acc;
}

async function listAll(list) {
  const out = [...list.messages];
  while (list.id) { list = await messenger.messages.continueList(list.id); out.push(...list.messages); }
  return out;
}

// ------------------------------------------------------------------ handlers
const handlers = {
  async list_accounts() {
    const accounts = await messenger.accounts.list(false);
    return accounts.map((a) => ({
      id: a.id, name: a.name, type: a.type,
      identities: (a.identities || []).map((i) => ({ id: i.id, email: i.email, name: i.name, label: i.label })),
    }));
  },

  async list_folders({ accountId }) {
    const accounts = await messenger.accounts.list(true);
    const out = [];
    for (const a of accounts) {
      if (accountId && a.id !== accountId) continue;
      for (const f of flattenFolders(a.folders)) {
        let unread = null;
        try { unread = (await messenger.folders.getFolderInfo(f.id)).unreadMessageCount; } catch { /* needs no extra permission in 128, ignore otherwise */ }
        out.push({ ...f, unread });
      }
    }
    return out;
  },

  async search_messages(a) {
    const q = {};
    if (a.query) q.fullText = a.query;
    if (a.from) q.author = a.from;
    if (a.to) q.recipients = a.to;
    if (a.subject) q.subject = a.subject;
    if (a.folderId) q.folderId = a.folderId;
    if (typeof a.unread === "boolean") q.unread = a.unread;
    if (typeof a.flagged === "boolean") q.flagged = a.flagged;
    if (a.fromDate) q.fromDate = new Date(a.fromDate);
    if (a.toDate) q.toDate = new Date(a.toDate);
    const limit = Math.min(a.limit || 25, 100);
    let list = await messenger.messages.query(q);
    const collected = [];
    for (;;) {
      collected.push(...list.messages);
      if (collected.length >= limit || !list.id) break;
      list = await messenger.messages.continueList(list.id);
    }
    return { count: Math.min(collected.length, limit), messages: collected.slice(0, limit).map(brief) };
  },

  async get_message({ messageId, maxBodyChars = 20000 }) {
    const header = await messenger.messages.get(messageId);
    const full = await messenger.messages.getFull(messageId);
    const parts = collectParts(full);
    let body = parts.text.join("\n").trim();
    let source = "text/plain";
    if (!body && parts.html.length) { body = htmlToText(parts.html.join("\n")); source = "text/html (converted)"; }
    const truncated = body.length > maxBodyChars;
    return {
      ...brief(header),
      headers: { "message-id": full.headers?.["message-id"], references: full.headers?.references, "reply-to": full.headers?.["reply-to"] },
      bodySource: source,
      body: truncated ? body.slice(0, maxBodyChars) : body,
      truncated,
      attachments: parts.attachments,
    };
  },

  async create_draft(a) {
    const details = {
      to: a.to || [], cc: a.cc || [], bcc: a.bcc || [],
      subject: a.subject || "",
    };
    if (a.isHtml) details.body = a.body; else details.plainTextBody = a.body;
    if (a.identityId) details.identityId = a.identityId;

    let tab;
    if (a.replyToMessageId) {
      tab = await messenger.compose.beginReply(a.replyToMessageId, "replyToSender", details);
    } else {
      tab = await messenger.compose.beginNew(details);
    }
    const res = await messenger.compose.saveMessage(tab.id, { mode: "draft" });
    // the compose window was only needed to save; close it so nothing is left half-open
    try { const t = await messenger.tabs.get(tab.id); await messenger.windows.remove(t.windowId); } catch { /* may already be closed */ }
    const saved = (res.messages || [])[0];
    return { saved: true, note: "Szkic zapisany w Szkicach. Wysyłanie tylko ręcznie w Betterbirdzie.", message: saved ? brief(saved) : undefined };
  },
};

messenger.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "status") return Promise.resolve({ state });
  if (msg && msg.type === "reconnect") { reconnectNow(); return Promise.resolve({ ok: true }); }
});

function reconnectNow() { retryMs = 500; if (ws) ws.close(); else schedule(0); }
messenger.storage.onChanged.addListener((changes) => { if (changes.token || changes.hubUrl) reconnectNow(); });

connect();
