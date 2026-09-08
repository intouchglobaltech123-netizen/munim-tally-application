$ErrorActionPreference = 'Stop'
$sdk = 'D:\Android\Sdk'
$zip = 'D:\Android\cmdline-tools.zip'

New-Item -ItemType Directory -Force -Path $sdk | Out-Null
Write-Output "downloading command-line tools to D: ..."
Invoke-WebRequest -Uri 'https://dl.google.com/android/repository/commandlinetools-win-13114758_latest.zip' -OutFile $zip -UseBasicParsing
Write-Output ("downloaded: " + [math]::Round((Get-Item $zip).Length/1MB,1) + " MB")

# sdkmanager expects to live at <sdk>/cmdline-tools/latest/bin
Expand-Archive -Path $zip -DestinationPath "$sdk\tmp" -Force
New-Item -ItemType Directory -Force -Path "$sdk\cmdline-tools" | Out-Null
if (Test-Path "$sdk\cmdline-tools\latest") { Remove-Item "$sdk\cmdline-tools\latest" -Recurse -Force }
Move-Item "$sdk\tmp\cmdline-tools" "$sdk\cmdline-tools\latest"
Remove-Item "$sdk\tmp" -Recurse -Force
Remove-Item $zip -Force

Write-Output ("sdkmanager present: " + (Test-Path "$sdk\cmdline-tools\latest\bin\sdkmanager.bat"))
