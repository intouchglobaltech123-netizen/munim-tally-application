<#
  Makes the API reachable from your phone.

      Right-click PowerShell -> Run as Administrator, then:
      powershell -ExecutionPolicy Bypass -File .\scripts\expose-api.ps1

  Why this is needed
  ------------------
  The API runs inside WSL. Windows can reach it on localhost because WSL2
  forwards loopback - but that forwarding is loopback ONLY. A phone on your
  Wi-Fi hits your Windows LAN address, and nothing is listening there.

  This adds a port proxy so:

      phone  ->  192.168.x.x:8080  (Windows)  ->  172.x.x.x:8080  (WSL)

  Needs administrator once. Re-run it after a reboot: WSL gets a new IP each
  time it starts, and the proxy would otherwise point at the old one.

      -Remove   tear the forwarding and firewall rule back down
#>
param(
  [int]$Port = 8080,
  [int]$MetroPort = 8081,   # Expo's bundler, so the phone can load the app at all
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$ruleName = "Munim API $Port"
$metroRule = "Munim Expo $MetroPort"

$admin = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if (-not $admin) {
  Write-Host "`n  This needs administrator." -ForegroundColor Yellow
  Write-Host '  Right-click PowerShell -> Run as Administrator, then run it again.' -ForegroundColor Yellow
  Write-Host '  (It changes Windows port forwarding and the firewall.)' -ForegroundColor DarkGray
  exit 1
}

if ($Remove) {
  netsh interface portproxy delete v4tov4 listenport=$Port listenaddress=0.0.0.0 | Out-Null
  Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
  Remove-NetFirewallRule -DisplayName $metroRule -ErrorAction SilentlyContinue
  Write-Host "`n  Removed the forwarding and firewall rules for ports $Port and $MetroPort.`n" -ForegroundColor Cyan
  exit 0
}

# WSL's address changes on every restart, so read it now rather than trusting
# anything written down earlier.
$wslIp = (wsl hostname -I).Trim().Split(' ')[0]
if (-not $wslIp) { Write-Host '  Could not read the WSL IP. Is WSL running?' -ForegroundColor Red; exit 1 }

# Pick the adapter that is actually on the network. Disconnected adapters keep
# a 169.254.x.x link-local address, and grabbing one of those writes a dead
# address into .env that fails with the same opaque "network request failed".
$lan = (Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.PrefixOrigin -eq 'Dhcp' -and
                 $_.IPAddress -notlike '127.*' -and
                 $_.IPAddress -notlike '169.254.*' -and
                 $_.InterfaceAlias -notlike '*WSL*' } |
  Sort-Object { (Get-NetAdapter -Name $_.InterfaceAlias -ErrorAction SilentlyContinue).Status -ne 'Up' } |
  Select-Object -First 1)
$lanAlias = $lan.InterfaceAlias
$lanIp = $lan.IPAddress

if (-not $lanIp) {
  Write-Host '  No connected network adapter found. Is Wi-Fi on?' -ForegroundColor Red
  exit 1
}

Write-Host "`n  WSL (API)     : $wslIp"
Write-Host "  Windows (LAN) : $lanIp"

# Replace any stale mapping from a previous boot.
netsh interface portproxy delete v4tov4 listenport=$Port listenaddress=0.0.0.0 2>$null | Out-Null
netsh interface portproxy add v4tov4 `
  listenport=$Port listenaddress=0.0.0.0 `
  connectport=$Port connectaddress=$wslIp | Out-Null

# The rule is Private-only on purpose: reachable on your own Wi-Fi, not on a
# cafe network. But a rule scoped to Private does nothing while Windows has the
# network classified Public - the rule exists, looks fine, and never applies.
$netProfile = Get-NetConnectionProfile -InterfaceAlias $lanAlias -ErrorAction SilentlyContinue
if ($netProfile -and $netProfile.NetworkCategory -eq 'Public') {
  Write-Host "  network       : '$($netProfile.Name)' is classified Public" -ForegroundColor Yellow
  Write-Host '                  A Private-only firewall rule cannot apply to it.' -ForegroundColor Yellow
  Set-NetConnectionProfile -InterfaceAlias $lanAlias -NetworkCategory Private
  Write-Host '                  -> set to Private (correct for your own Wi-Fi)' -ForegroundColor Green
  Write-Host '                  Undo: Set-NetConnectionProfile -InterfaceAlias ' `
             "$lanAlias -NetworkCategory Public" -ForegroundColor DarkGray
} elseif ($netProfile) {
  Write-Host "  network       : '$($netProfile.Name)' is $($netProfile.NetworkCategory)"
}

# Two ports, two different jobs. Opening only the API is not enough: without
# Metro the phone cannot download the app bundle at all, and Expo Go just sits
# on "connecting" - which looks nothing like a firewall problem.
#   $Port      the API, forwarded into WSL
#   $MetroPort Expo's bundler, running on Windows itself (no proxy needed)
foreach ($r in @(@{ Name = $ruleName; P = $Port }, @{ Name = $metroRule; P = $MetroPort })) {
  if (-not (Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $r.Name -Direction Inbound -Action Allow `
      -Protocol TCP -LocalPort $r.P -Profile Private | Out-Null
    Write-Host "  firewall      : '$($r.Name)' added (private networks)"
  } else {
    Write-Host "  firewall      : '$($r.Name)' already present"
  }
}

# Testing from this machine proves nothing: traffic to our own LAN address never
# crosses the firewall, so a blocked port still answers. Ask WSL instead - it is
# a separate host on the far side of the firewall, same as the phone.
Write-Host "`n  Checking from outside the firewall..." -ForegroundColor DarkGray
$probe = (wsl -e bash -lc "curl -s -m 8 http://${lanIp}:$Port/v1/health 2>/dev/null").Trim()

# Metro only answers once "npx expo start" is running, so a miss here is a
# reminder rather than a failure.
$metro = (wsl -e bash -lc "curl -s -m 6 http://${lanIp}:$MetroPort/status 2>/dev/null").Trim()
if ($metro -match 'packager-status:running') {
  Write-Host "  Expo bundler  : reachable on $MetroPort" -ForegroundColor Green
} else {
  Write-Host "  Expo bundler  : not answering on $MetroPort (start it with 'npx expo start')" -ForegroundColor DarkGray
}

if ($probe -match '"ok"\s*:\s*true') {
  Write-Host "  reachable at http://${lanIp}:$Port  ->  $probe" -ForegroundColor Green
  Write-Host '  Your phone can now reach the API on this Wi-Fi.' -ForegroundColor Green
} else {
  Write-Host "  NOT reachable from another host on http://${lanIp}:$Port" -ForegroundColor Red
  Write-Host '  Checks: is the API running in WSL (corepack pnpm api)?' -ForegroundColor Yellow
  Write-Host '          is this Wi-Fi set to Private? (shown above)' -ForegroundColor Yellow
  Write-Host '          does your router block client-to-client traffic (AP isolation)?' -ForegroundColor Yellow
}

Write-Host "`n  Put this in apps\mobile\.env :" -ForegroundColor Cyan
Write-Host "      EXPO_PUBLIC_API_URL=http://${lanIp}:$Port" -ForegroundColor Green
Write-Host "`n  Then restart Expo with a cleared cache:  npx expo start --clear`n"
