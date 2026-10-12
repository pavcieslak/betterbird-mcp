# Betterbird MCP Bridge

An MCP server (Streamable HTTP) plus a Betterbird extension. Any MCP client on the same Tailscale
network (Rakazo, Claude Code/Desktop, Gemini CLI, Antigravity) can read your mail and create drafts.

```
MCP clients ── HTTP + Bearer ──► Hub (machine running Betterbird, Tailscale IP, port 8765, /mcp)
                                   ▲ WebSocket, 127.0.0.1 only, its own token (bbext_...)
                             Betterbird extension
```

Two kinds of tokens, do not mix them up:
- `bbext_...`: the **extension** token, entered in the add-on options in Betterbird.
- `bbmcp_...`: a **client** token (Rakazo, Claude, ...), entered in that client.

## Security (built in)
- The hub listens only on the Tailscale IP and 127.0.0.1; the firewall allows the port only from `100.64.0.0/10`.
- Every client has its own token and permissions (`read`, `draft`, `modify`). Tools above a client's permission level are not even listed. The config stores only SHA-256 hashes; a token is shown once, when created.
- The extension has **no** `compose.send` permission: nothing can send mail. `create_draft` saves a draft, you send it manually.
- Requests carrying an `Origin` header (browsers) or an unknown `Host` are rejected.
- `hub/audit.log`: who called which tool and when (draft bodies are logged only as a character count), plus hub start/stop and rejected connections.
- Note: a client with `read` sees all mail in every account configured in Betterbird. Give the server only to the bots that need it.

## Installation (Windows)
Requirements: Node.js 20+, Betterbird/Thunderbird 128+, Tailscale.

1. PowerShell **as Administrator**:
   `powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1`
   The script runs `npm install`, creates `config.json`, adds a firewall rule and sets up hub autostart (task `BetterbirdMcpHub`, no console window). **Copy the extension token** (shown once).
2. Build and install the extension:
   `cd extension`, then `zip -r ../betterbird-mcp-bridge.xpi .` (or zip the folder contents and rename the file to `.xpi`), or download the `.xpi` from the Releases page.
   Betterbird → Add-ons → ⚙ → *Install Add-on From File*. The add-on is unsigned: set `xpinstall.signatures.required = false` in the Config Editor (or use *Debug Add-ons → Load Temporary Add-on* for testing).
3. Add-on options → paste the `bbext_...` token → *Save and connect* (status: `connected`).
4. Client tokens (in the `hub` folder):
   ```
   node setup.mjs add-client rakazo read,draft
   node setup.mjs add-client claude read,draft
   node setup.mjs add-client gemini read
   node setup.mjs list
   node setup.mjs revoke <name>
   ```
   A new client works without restarting the hub.
5. Lost the extension token: run `node setup.mjs rotate-ext` in the `hub` folder, paste the new token into the add-on options and click *Save and connect*.

## Tools (v1)
`bridge_status`, `list_accounts`, `list_folders`, `search_messages`, `get_message` (read) · `create_draft` (draft)

## Client configuration
URL: `http://<hub-tailscale-ip>:8765/mcp` (or a MagicDNS name; then add that name to `allowedHosts` in `hub/config.json`).
Header: `Authorization: Bearer <client token>`.

**Rakazo** (runs in Docker; containers reach the host's Tailscale addresses directly, no `iptables` changes needed): *Integrations → Add MCP server → Add remote MCP server*: name, URL as above, authentication *Bearer token*, *Verify and add*.

**Claude Code**
```
claude mcp add --transport http betterbird http://IP:8765/mcp --header "Authorization: Bearer TOKEN"
```
**Gemini CLI** (`~/.gemini/settings.json`)
```json
{ "mcpServers": { "betterbird": { "httpUrl": "http://IP:8765/mcp", "headers": { "Authorization": "Bearer TOKEN" } } } }
```
**Antigravity** (`mcp_config.json`; the format depends on the version, please check)
```json
{ "mcpServers": { "betterbird": { "serverUrl": "http://IP:8765/mcp", "headers": { "Authorization": "Bearer TOKEN" } } } }
```
**Claude Desktop** (stdio only): via the `mcp-remote` bridge
```json
{ "mcpServers": { "betterbird": { "command": "npx", "args": ["-y", "mcp-remote", "http://IP:8765/mcp", "--allow-http", "--header", "Authorization: Bearer TOKEN"] } } }
```

Test: `curl http://IP:8765/health` → `{"ok":true,"extensionConnected":true}`

## Troubleshooting
- **`extensionConnected: false`**: Betterbird is not running or the extension has a wrong token. Check `hub/audit.log`: `ws_rejected` means the hub rejects the token (the add-on needs `bbext_...`, not `bbmcp_...`); no entries at all means the extension never reaches the hub.
- **The hub disappeared** (`curl` to 127.0.0.1 gets no answer): `Get-ScheduledTaskInfo -TaskName BetterbirdMcpHub`. Result `3221225786` (0xC000013A) means it was closed via its console / Ctrl+C. `audit.log` records why the process ended (`signal`, `exit`, `uncaught_exception`). The task runs as S4U, without a window.
- **Timeout from another machine**: check the Tailscale ACL and the firewall rule (`Get-NetFirewallRule -DisplayName "Betterbird MCP*"`), and whether `curl` to the Tailscale address works from the host itself.
- **A `sudo` password prompt swallows pasted lines**: paste commands one at a time.
- Hub tests with a mock extension: `cd hub && npm test`.

## Roadmap
v2 (not done): moving messages, tagging, attachments (the `modify` permission).
