$env:MUNIM_HOME='C:\Users\User\Desktop\munim\connector-ps\.live'
Remove-Item $env:MUNIM_HOME -Recurse -Force -EA SilentlyContinue
New-Item -ItemType Directory -Force -Path $env:MUNIM_HOME | Out-Null
'{"cloudUrl":"http://localhost:8080","tallyUrl":"http://localhost:9000","deviceToken":"dev_wmnuesrfxy"}' | Set-Content "$env:MUNIM_HOME\config.json"
& 'C:\Users\User\Desktop\munim\connector-ps\Munim-Connector.ps1' sync *>&1 | Out-String
