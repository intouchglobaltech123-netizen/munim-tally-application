<#
  Starts the Munim backend and web app against YOUR REAL TALLY.

      powershell -ExecutionPolicy Bypass -File .\scripts\dev-windows.ps1

    dev API   :8080   auth, ingest, reports, admin
    web app   :3000   customer dashboard + /admin

  Tally must be open on this machine with its gateway on, or the connector has
  nothing to read:
      Tally  ->  F1  ->  Settings  ->  Connectivity
                 "Act as" = Server,  Port = 9000

  There is no demo data. Sign in with your mobile number, name your business,
  then run the connector and scan its QR code.

  -FakeTally starts the test fixture on :9000 instead. That is for automated
  tests and for working on a machine with no Tally - not for evaluating the
  product.

  Ctrl+C stops everything.
#>
param(
  [switch]$FakeTally,     # use the test fixture instead of real Tally
  [switch]$NoWeb          # backend only
)

$ErrorActionPreference = 'Stop'
$root  = Split-Path -Parent $PSScriptRoot
$procs = @()

function Start-Bg($name, $file, $argList, $port) {
  if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
    Write-Host "  $name already running on :$port" -ForegroundColor DarkGray
    return $null
  }
  $p = Start-Process -FilePath $file -ArgumentList $argList -WindowStyle Hidden -PassThru
  Write-Host "  $name -> :$port  (pid $($p.Id))" -ForegroundColor DarkGray
  return $p
}

function Wait-Port($port, $seconds = 20) {
  for ($i = 0; $i -lt $seconds * 2; $i++) {
    if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

try {
  Write-Host "`n  Starting Munim..." -ForegroundColor Cyan
  $procs += Start-Bg 'API' 'node' "$root\apps\api\src\index.js" 8080

  if ($FakeTally) {
    $procs += Start-Bg 'TEST Tally fixture' 'node' "$root\mock-tally\src\index.js" 9000
  }
  $procs = $procs | Where-Object { $_ }
  if (-not (Wait-Port 8080)) { throw 'dev API did not start - is node installed?' }

  # Tell the truth about Tally rather than letting it fail later inside the
  # connector, where the cause is much harder to see.
  if (Get-NetTCPConnection -LocalPort 9000 -State Listen -ErrorAction SilentlyContinue) {
    Write-Host '  Tally is listening on :9000' -ForegroundColor DarkGray
  } else {
    Write-Host "`n  Tally is NOT sharing on port 9000." -ForegroundColor Yellow
    Write-Host '  Open Tally, then: F1 -> Settings -> Connectivity' -ForegroundColor Yellow
    Write-Host '                    "Act as" = Server, Port = 9000' -ForegroundColor Yellow
    Write-Host '  Keep Tally open. (Or re-run this with -FakeTally.)' -ForegroundColor Yellow
  }

  if (-not $NoWeb) {
    Write-Host "`n  Starting the web app..." -ForegroundColor Cyan
    $next = "$root\apps\web\node_modules\next\dist\bin\next"
    if (-not (Test-Path $next)) {
      Write-Host '  Dependencies missing. Run this first:' -ForegroundColor Yellow
      Write-Host '    corepack pnpm install' -ForegroundColor Yellow
    } else {
      $env:NEXT_PUBLIC_API_URL = 'http://localhost:8080'
      $procs += Start-Bg 'web app' 'node' @($next, 'dev', '-p', '3000') 3000
      $procs = $procs | Where-Object { $_ }
      Wait-Port 3000 45 | Out-Null
      Start-Process 'http://localhost:3000'
    }
  }

  Write-Host "`n  ---------------------------------------------------------" -ForegroundColor Green
  Write-Host '   1. Open  http://localhost:3000' -ForegroundColor Green
  Write-Host '   2. Sign in with your mobile number (OTP is printed by the API)' -ForegroundColor Green
  Write-Host '   3. Name your business' -ForegroundColor Green
  Write-Host '   4. In another window, link this computer:' -ForegroundColor Green
  Write-Host '        .\connector\dist\Munim.exe setup' -ForegroundColor Green
  Write-Host '   5. Scan the QR it shows, in the Munim app' -ForegroundColor Green
  Write-Host "  ---------------------------------------------------------`n" -ForegroundColor Green
  Write-Host '  Press Ctrl+C to stop.'

  while ($true) { Start-Sleep -Seconds 3600 }
}
finally {
  foreach ($p in $procs) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  Write-Host "`n  Stopped." -ForegroundColor Cyan
}
