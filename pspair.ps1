$env:MUNIM_HOME = 'C:\Users\User\Desktop\munim\connector-ps\.testdata'
Remove-Item $env:MUNIM_HOME -Recurse -Force -EA SilentlyContinue
$S = 'C:\Users\User\Desktop\munim\connector-ps\Munim-Connector.ps1'
$job = Start-Job { param($s,$h)
  $env:MUNIM_HOME=$h
  & $s pair -Tally 'http://localhost:9000' -Cloud 'http://localhost:8080'
} -ArgumentList $S, $env:MUNIM_HOME
Start-Sleep 6
Receive-Job $job | Out-String
"---INTENT---"
