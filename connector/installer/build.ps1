#requires -version 5
<#
  Builds the Munim connector and packages the Windows installer.

    .\installer\build.ps1                 # build exe + installer
    .\installer\build.ps1 -Sign           # also sign both binaries
    .\installer\build.ps1 -SkipInstaller  # exe only

  An UNSIGNED installer triggers Windows SmartScreen ("Windows protected your
  PC"), and most shop owners stop there. Sign before you ship to customers.
#>
param(
  [switch]$Sign,
  [switch]$SkipInstaller,
  [string]$Version = "0.1.0",
  [string]$CertThumbprint = $env:MUNIM_CERT_THUMBPRINT,
  [string]$TimestampUrl = "http://timestamp.digicert.com"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "    $m" -ForegroundColor Green }

try {
  Step "Running tests"
  go test ./...
  if ($LASTEXITCODE -ne 0) { throw "tests failed" }
  Ok "tests passed"

  Step "Building munim-connector.exe (windows/amd64)"
  New-Item -ItemType Directory -Force -Path .\dist | Out-Null
  $env:GOOS = "windows"; $env:GOARCH = "amd64"; $env:CGO_ENABLED = "0"
  # -s -w strips the symbol table: a smaller download on a shop's slow line.
  go build -trimpath -ldflags "-s -w -X main.version=$Version" -o .\dist\munim-connector.exe .\cmd\lkp-agent
  if ($LASTEXITCODE -ne 0) { throw "go build failed" }
  Ok ("{0:N1} MB" -f ((Get-Item .\dist\munim-connector.exe).Length / 1MB))

  if ($Sign) {
    Step "Signing the connector"
    if (-not $CertThumbprint) { throw "Set MUNIM_CERT_THUMBPRINT or pass -CertThumbprint" }
    & signtool sign /sha1 $CertThumbprint /fd SHA256 /tr $TimestampUrl /td SHA256 `
        .\dist\munim-connector.exe
    if ($LASTEXITCODE -ne 0) { throw "signing failed" }
    Ok "signed"
  }

  # --- free distribution path -------------------------------------------
  # Ship this single file. Windows Smart App Control blocks unsigned Inno
  # Setup stubs (installer patterns have poor reputation because malware
  # abuses them) but allows a plain binary through - verified with Mark of
  # the Web attached on an SAC-enforced Windows 11 Pro machine.
  # Double-clicking it runs the same check -> install service -> pair flow.
  Step "Packaging the no-installer download"
  Copy-Item .\dist\munim-connector.exe .\dist\Munim.exe -Force
  $h = (Get-FileHash .\dist\Munim.exe -Algorithm SHA256).Hash
  Set-Content .\dist\Munim.exe.sha256 "$h  Munim.exe"
  Ok "dist\Munim.exe  (publish this + the .sha256 on your download page)"

  if ($SkipInstaller) { Ok "skipping installer"; return }

  Step "Compiling the installer"
  $iscc = @(
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $iscc) { throw "Inno Setup 6 not found. Install it from https://jrsoftware.org/isdl.php" }

  & $iscc "/DAppVersion=$Version" .\installer\munim.iss
  if ($LASTEXITCODE -ne 0) { throw "iscc failed" }

  $setup = ".\dist\MunimSetup-$Version.exe"
  Ok ("{0} ({1:N1} MB)" -f $setup, ((Get-Item $setup).Length / 1MB))

  if ($Sign) {
    Step "Signing the installer"
    & signtool sign /sha1 $CertThumbprint /fd SHA256 /tr $TimestampUrl /td SHA256 $setup
    if ($LASTEXITCODE -ne 0) { throw "signing failed" }
    Ok "signed"
  }

  Write-Host "`nDone. Ship: $setup`n" -ForegroundColor Green
}
finally {
  Pop-Location
}
