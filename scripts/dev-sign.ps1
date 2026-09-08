<#
  Signs the connector with a self-signed certificate so it runs on YOUR machine.

      powershell -ExecutionPolicy Bypass -File .\scripts\dev-sign.ps1

  Why this is needed
  ------------------
  Windows Smart App Control refuses to run unsigned binaries. On a machine with
  it enabled that includes the connector, the Inno installer, and even Go's own
  compiler tools - so you cannot build or run anything locally.

  A self-signed certificate, trusted for your user only, satisfies it. No admin
  rights, no money, and it is reversible (see -Remove below).

  What this is NOT
  ----------------
  This does NOT help your customers. The certificate is trusted only on this
  machine. Shipping to real customers still needs a certificate from a real CA
  (see docs/15-installer.md). This exists purely so you can develop.
#>
param(
  [string]$Exe = "$(Split-Path -Parent $PSScriptRoot)\connector\dist\Munim.exe",
  [switch]$Remove          # delete the certificate and stop trusting it
)

$ErrorActionPreference = 'Stop'
$SUBJECT = 'CN=Munim Technologies (dev)'

function Get-DevCert {
  Get-ChildItem Cert:\CurrentUser\My |
    Where-Object { $_.Subject -eq $SUBJECT -and $_.NotAfter -gt (Get-Date) } |
    Select-Object -First 1
}

function Remove-FromStore($storeName, $cert) {
  $s = New-Object System.Security.Cryptography.X509Certificates.X509Store $storeName, 'CurrentUser'
  $s.Open('ReadWrite')
  $s.Certificates | Where-Object { $_.Thumbprint -eq $cert.Thumbprint } | ForEach-Object { $s.Remove($_) }
  $s.Close()
}

if ($Remove) {
  $cert = Get-DevCert
  if (-not $cert) { Write-Host '  No dev certificate found.'; return }
  Remove-FromStore 'Root' $cert
  Remove-FromStore 'TrustedPublisher' $cert
  Remove-Item "Cert:\CurrentUser\My\$($cert.Thumbprint)" -Force
  Write-Host "  Removed $($cert.Thumbprint)" -ForegroundColor Cyan
  return
}

if (-not (Test-Path $Exe)) {
  Write-Host "  Not found: $Exe" -ForegroundColor Red
  Write-Host '  Build it first (from WSL, because Go is blocked on Windows):' -ForegroundColor Yellow
  Write-Host '    cd connector' -ForegroundColor Yellow
  Write-Host '    GOOS=windows GOARCH=amd64 go build -o dist/Munim.exe ./cmd/lkp-agent' -ForegroundColor Yellow
  exit 1
}

$cert = Get-DevCert
if (-not $cert) {
  Write-Host '  Creating a development certificate...' -ForegroundColor Cyan
  $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $SUBJECT `
          -CertStoreLocation Cert:\CurrentUser\My `
          -KeyUsage DigitalSignature -KeyLength 2048 `
          -NotAfter (Get-Date).AddYears(3)

  # Trust it for this user only. Machine-wide trust would need admin and is a
  # bigger change than developing on your own machine warrants.
  foreach ($name in 'Root', 'TrustedPublisher') {
    $s = New-Object System.Security.Cryptography.X509Certificates.X509Store $name, 'CurrentUser'
    $s.Open('ReadWrite'); $s.Add($cert); $s.Close()
  }
  Write-Host "  Created and trusted: $($cert.Thumbprint)" -ForegroundColor DarkGray
} else {
  Write-Host "  Using existing certificate $($cert.Thumbprint)" -ForegroundColor DarkGray
}

$r = Set-AuthenticodeSignature -FilePath $Exe -Certificate $cert
if ($r.Status -ne 'Valid') {
  Write-Host "  Signing failed: $($r.Status) - $($r.StatusMessage)" -ForegroundColor Red
  exit 1
}

Write-Host "`n  Signed: $Exe" -ForegroundColor Green
Write-Host '  It will now run on this machine. Try:' -ForegroundColor Green
Write-Host "    $Exe check`n" -ForegroundColor Green
