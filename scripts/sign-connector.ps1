<#
.SYNOPSIS
  Signs the connector script that customers download.

.DESCRIPTION
  Antivirus argues with unsigned files, and no amount of rewriting the file
  settles it: a downloaded script that starts PowerShell and installs a
  scheduled task looks the same to a scanner whoever wrote it. A signature is
  the only thing that answers the question it is actually asking - who wrote
  this, and can it be traced back to them.

  Run this on Windows, on the machine holding the certificate, after any change
  to connector-ps\Munim-Connector.ps1. It signs the copy in apps\api\assets,
  which is the one the server hands out.

  The signature covers the file's BYTES, which is why the download at
  ?format=ps1 is the same file for every customer. Personalising it per
  customer - what the .bat route does - would break the signature on the first
  byte.

.PARAMETER Thumbprint
  The signing certificate's thumbprint, from:
      Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert

.PARAMETER TimestampUrl
  A timestamp authority. Without one the signature dies with the certificate,
  usually a year later, and every customer who installs after that sees the
  warning again.

.EXAMPLE
  .\scripts\sign-connector.ps1 -Thumbprint A1B2C3...
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Thumbprint,
  [string]$TimestampUrl = 'http://timestamp.digicert.com'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'connector-ps\Munim-Connector.ps1'
$served = Join-Path $root 'apps\api\assets\Munim-Connector.ps1'

if (-not (Test-Path $source)) { throw "Cannot find $source" }

# The served copy is a copy, and a stale one signs the wrong code.
Copy-Item $source $served -Force
Write-Host "  copied  $source -> $served"

$cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
  Where-Object { $_.Thumbprint -eq $Thumbprint }
if (-not $cert) {
  throw "No code-signing certificate with thumbprint $Thumbprint. " +
        "List them with: Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert"
}

$result = Set-AuthenticodeSignature -FilePath $served -Certificate $cert `
  -TimestampServer $TimestampUrl -HashAlgorithm SHA256

if ($result.Status -ne 'Valid') {
  throw "Signing failed: $($result.Status) - $($result.StatusMessage)"
}

Write-Host "  signed   $served" -ForegroundColor Green
Write-Host "  by       $($cert.Subject)"
Write-Host "  until    $($cert.NotAfter)"
Write-Host ''
Write-Host '  Commit the signed file: it is what the server serves.' -ForegroundColor Cyan
