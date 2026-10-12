# Uruchom jako Administrator (PowerShell), z folderu betterbird-mcp:
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
# Robi: npm install, config + tokeny, reguła zapory (tylko Tailscale), autostart huba.
param(
  [string]$TailscaleIp = "",
  [int]$Port = 8765
)
$ErrorActionPreference = "Stop"
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw "Uruchom PowerShell jako Administrator (potrzebne do reguły zapory i zadania autostartu)." }
$root = Split-Path -Parent $PSScriptRoot
$hub  = Join-Path $root "hub"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Brak Node.js (>=20). Zainstaluj z https://nodejs.org i uruchom ponownie." }

if (-not $TailscaleIp) {
  $ts = Get-Command tailscale -ErrorAction SilentlyContinue
  if (-not $ts) { $p = "C:\Program Files\Tailscale\tailscale.exe"; if (Test-Path $p) { $ts = $p } }
  if ($ts) { $TailscaleIp = (& $ts ip -4 | Select-Object -First 1).Trim() }
}
if (-not $TailscaleIp) { throw "Nie wykryto IP Tailscale. Podaj: -TailscaleIp 100.x.y.z" }
Write-Host "IP Tailscale: $TailscaleIp"

Push-Location $hub
npm install --omit=dev
if (-not (Test-Path "config.json")) {
  node setup.mjs init $TailscaleIp
  Write-Host "`n>>> Skopiuj TOKEN ROZSZERZENIA powyżej (nie zostanie pokazany ponownie). <<<`n"
}
Pop-Location

# Zapora: port tylko z podsieci Tailscale
$ruleName = "Betterbird MCP Hub (Tailscale)"
Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $Port `
  -RemoteAddress "100.64.0.0/10" -Action Allow -Profile Any | Out-Null
Write-Host "Reguła zapory dodana (port $Port, tylko 100.64.0.0/10)."

# Autostart po zalogowaniu. Logon S4U = proces bez okna konsoli, którego nie da się przypadkiem
# zamknąć (zwykłe zadanie otwierało widoczne okno, a jego zamknięcie zabijało hub).
$node = (Get-Command node).Source
$action    = New-ScheduledTaskAction -Execute $node -Argument "server.mjs" -WorkingDirectory $hub
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
$settings  = New-ScheduledTaskSettingsSet -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Unregister-ScheduledTask -TaskName "BetterbirdMcpHub" -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName "BetterbirdMcpHub" -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
Start-ScheduledTask -TaskName "BetterbirdMcpHub"
Write-Host "Hub uruchomiony i dodany do autostartu (zadanie: BetterbirdMcpHub)."
Write-Host "Dalej: node setup.mjs add-client rakazo read,draft   (w folderze hub)"
