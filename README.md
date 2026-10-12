# Betterbird MCP Bridge

Serwer MCP (Streamable HTTP) + rozszerzenie Betterbirda. Dowolny klient MCP w jednej sieci Tailscale
(Rakazo, Claude Code/Desktop, Gemini CLI, Antigravity) może czytać pocztę i tworzyć szkice.

```
Klienci MCP ── HTTP + Bearer ──► Hub (komputer z Betterbirdem, IP Tailscale, port 8765, /mcp)
                                   ▲ WebSocket, tylko 127.0.0.1, własny token (bbext_...)
                             Rozszerzenie w Betterbirdzie
```

Dwa rodzaje tokenów, nie mylić:
- `bbext_...`: token **rozszerzenia**, wpisujesz go w opcjach dodatku w Betterbirdzie.
- `bbmcp_...`: token **klienta** (Rakazo, Claude itd.), wpisujesz go w tym kliencie.

## Bezpieczeństwo (wbudowane)
- Hub nasłuchuje tylko na IP Tailscale i 127.0.0.1; zapora wpuszcza port wyłącznie z `100.64.0.0/10`.
- Każdy klient ma własny token i uprawnienia (`read`, `draft`, `modify`). Narzędzia powyżej uprawnień w ogóle nie są listowane. W configu trzymany jest tylko hash SHA-256; token widać raz, przy tworzeniu.
- Rozszerzenie **nie ma** `compose.send`: nic nie wyśle maila. `create_draft` zapisuje szkic, wysyłasz ręcznie.
- Odrzucane są żądania z nagłówkiem `Origin` (przeglądarki) i z nieznanym `Host`.
- `hub/audit.log`: kto, które narzędzie, kiedy (treść szkiców tylko jako liczba znaków), plus start/zamknięcie huba i odrzucone połączenia.
- Uwaga: klient z `read` widzi całą pocztę ze wszystkich kont w Betterbirdzie. Przypisuj serwer tylko tym botom, które go potrzebują.

## Instalacja (Windows)
Wymagania: Node.js 20+, Betterbird/Thunderbird 128+, Tailscale.

1. PowerShell **jako Administrator**:
   `powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1`
   Skrypt zrobi `npm install`, `config.json`, regułę zapory i autostart huba (zadanie `BetterbirdMcpHub`, bez okna konsoli). **Skopiuj token rozszerzenia** (pokazany raz).
2. Zbuduj i zainstaluj rozszerzenie:
   `cd extension` → `zip -r ../betterbird-mcp-bridge.xpi .` (albo spakuj zawartość folderu do ZIP i zmień rozszerzenie na `.xpi`).
   Betterbird → Dodatki → ⚙ → *Zainstaluj dodatek z pliku*. Niepodpisany dodatek wymaga `xpinstall.signatures.required = false` w Edytorze konfiguracji (albo *Debug Add-ons → Load Temporary Add-on* do testów).
3. Opcje dodatku → wklej token `bbext_...` → *Zapisz i połącz* (status: `connected`).
4. Tokeny klientów (w folderze `hub`):
   ```
   node setup.mjs add-client rakazo read,draft
   node setup.mjs add-client claude read,draft
   node setup.mjs add-client gemini read
   node setup.mjs list
   node setup.mjs revoke <nazwa>
   ```
   Nowy klient działa bez restartu huba.
5. Zgubiony token rozszerzenia: w folderze `hub` uruchom `node setup.mjs rotate-ext`, wklej nowy token w opcjach dodatku i kliknij *Zapisz i połącz*.

## Narzędzia (v1)
`bridge_status`, `list_accounts`, `list_folders`, `search_messages`, `get_message` (read) · `create_draft` (draft)

## Konfiguracja klientów
URL: `http://<IP-Tailscale-huba>:8765/mcp` (lub nazwa MagicDNS; dopisz ją wtedy do `allowedHosts` w `hub/config.json`).
Nagłówek: `Authorization: Bearer <token klienta>`.

**Rakazo** (działa w Dockerze, kontenery same docierają do adresów Tailscale hosta, nic nie trzeba w `iptables`): *Integrations → Add MCP server → Add remote MCP server*: nazwa, URL jak wyżej, autoryzacja *Bearer token*, *Verify and add*.

**Claude Code**
```
claude mcp add --transport http betterbird http://IP:8765/mcp --header "Authorization: Bearer TOKEN"
```
**Gemini CLI** (`~/.gemini/settings.json`)
```json
{ "mcpServers": { "betterbird": { "httpUrl": "http://IP:8765/mcp", "headers": { "Authorization": "Bearer TOKEN" } } } }
```
**Antigravity** (`mcp_config.json`, format zależy od wersji, sprawdź)
```json
{ "mcpServers": { "betterbird": { "serverUrl": "http://IP:8765/mcp", "headers": { "Authorization": "Bearer TOKEN" } } } }
```
**Claude Desktop** (tylko stdio): przez most `mcp-remote`
```json
{ "mcpServers": { "betterbird": { "command": "npx", "args": ["-y", "mcp-remote", "http://IP:8765/mcp", "--allow-http", "--header", "Authorization: Bearer TOKEN"] } } }
```

Test: `curl http://IP:8765/health` → `{"ok":true,"extensionConnected":true}`

## Rozwiązywanie problemów
- **`extensionConnected: false`**: Betterbird nie jest uruchomiony albo rozszerzenie ma zły token. Zajrzyj do `hub/audit.log`: `ws_rejected` = hub odrzuca token (w opcjach dodatku musi być `bbext_...`, nie `bbmcp_...`); brak wpisów = rozszerzenie w ogóle nie dochodzi do huba.
- **Hub zniknął** (`curl` na 127.0.0.1 nie odpowiada): `Get-ScheduledTaskInfo -TaskName BetterbirdMcpHub`. Kod `3221225786` (0xC000013A) oznacza zamknięcie przez konsolę/Ctrl+C. Przyczynę zakończenia zapisuje `audit.log` (`signal`, `exit`, `uncaught_exception`). Zadanie działa jako S4U, bez okna.
- **Timeout z innej maszyny**: sprawdź ACL Tailscale i regułę zapory (`Get-NetFirewallRule -DisplayName "Betterbird MCP*"`), oraz czy `curl` na adres Tailscale działa z hosta.
- **Pytanie o hasło `sudo` połyka wklejone linie**: wklejaj komendy po jednej.
- Testy huba z atrapą rozszerzenia: `cd hub && npm test`.

## Plan
v2 (nie zrobione): przenoszenie, tagowanie, załączniki (uprawnienie `modify`).
