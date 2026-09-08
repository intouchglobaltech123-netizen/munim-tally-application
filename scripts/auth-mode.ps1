<#
  Switches the API between Firebase phone sign-in and the development OTP,
  by commenting the ALLOW_DEV_OTP lines in apps/api/.env.

      .\scripts\auth-mode.ps1 firebase   # real SMS
      .\scripts\auth-mode.ps1 dev        # console OTP
      .\scripts\auth-mode.ps1            # show current mode

  Restart the API afterwards for it to take effect.
#>
param([ValidateSet('firebase','dev','')] [string]$Mode = '')

$envFile = Join-Path (Split-Path -Parent $PSScriptRoot) 'apps\api\.env'
if (-not (Test-Path $envFile)) { Write-Host "  Not found: $envFile" -ForegroundColor Red; exit 1 }
$lines = Get-Content $envFile

if (-not $Mode) {
  $on = $lines | Where-Object { $_ -match '^\s*ALLOW_DEV_OTP\s*=\s*1' }
  Write-Host ("`n  Current mode: {0}" -f $(if ($on) { 'dev OTP (console code)' } else { 'Firebase (real SMS)' })) -ForegroundColor Cyan
  Write-Host "  Change it:  .\scripts\auth-mode.ps1 firebase   |   .\scripts\auth-mode.ps1 dev`n"
  exit 0
}

$out = foreach ($l in $lines) {
  if ($l -match '^\s*#?\s*(ALLOW_DEV_OTP|OTP_FIXED_CODE)\s*=') {
    $bare = $l -replace '^\s*#\s*', ''
    if ($Mode -eq 'firebase') { "# $bare" } else { $bare }
  } else { $l }
}
Set-Content $envFile $out

if ($Mode -eq 'firebase') {
  Write-Host "`n  Switched to Firebase. Restart the API, then sign in on the web app." -ForegroundColor Green
  Write-Host "  If Firebase refuses, run:  .\scripts\auth-mode.ps1 dev`n" -ForegroundColor DarkGray
} else {
  Write-Host "`n  Switched to development OTP. The code prints in the API console." -ForegroundColor Yellow
  Write-Host "  NEVER ship this mode.`n" -ForegroundColor Yellow
}
