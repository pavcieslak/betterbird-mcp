# Run as Administrator (PowerShell), from the repository folder:
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
# Does: npm install, config + tokens, firewall rule (Tailscale only), hub autostart.
param(
  [string]$TailscaleIp = "",
  [int]$Port = 8765
)
$ErrorActionPreference = "Stop"
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw "Run PowerShell as Administrator (needed for the firewall rule and the autostart task)." }
$root = Split-Path -Parent $PSScriptRoot
$hub  = Join-Path $root "hub"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js (>=20) not found. Install it from https://nodejs.org and run again." }

if (-not $TailscaleIp) {
  $ts = Get-Command tailscale -ErrorAction SilentlyContinue
  if (-not $ts) { $p = "C:\Program Files\Tailscale\tailscale.exe"; if (Test-Path $p) { $ts = $p } }
  if ($ts) { $TailscaleIp = (& $ts ip -4 | Select-Object -First 1).Trim() }
}
if (-not $TailscaleIp) { throw "Could not detect the Tailscale IP. Pass it explicitly: -TailscaleIp 100.x.y.z" }
Write-Host "Tailscale IP: $TailscaleIp"

Push-Location $hub
npm install --omit=dev
if (-not (Test-Path "config.json")) {
  node setup.mjs init $TailscaleIp
  Write-Host "`n>>> Copy the EXTENSION TOKEN shown above now (it will not be shown again). <<<`n"
}
Pop-Location

# Firewall: the port is reachable only from the Tailscale range
$ruleName = "Betterbird MCP Hub (Tailscale)"
Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $Port `
  -RemoteAddress "100.64.0.0/10" -Action Allow -Profile Any | Out-Null
Write-Host "Firewall rule added (port $Port, only 100.64.0.0/10)."

# Autostart at logon. Logon type S4U = a process without a console window that cannot be closed by
# accident (a regular task opened a visible window, and closing it killed the hub).
$node = (Get-Command node).Source
$action    = New-ScheduledTaskAction -Execute $node -Argument "server.mjs" -WorkingDirectory $hub
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
$settings  = New-ScheduledTaskSettingsSet -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
Unregister-ScheduledTask -TaskName "BetterbirdMcpHub" -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName "BetterbirdMcpHub" -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
Start-ScheduledTask -TaskName "BetterbirdMcpHub"
Write-Host "Hub started and added to autostart (task: BetterbirdMcpHub)."
Write-Host "Next: node setup.mjs add-client rakazo read,draft   (in the hub folder)"
