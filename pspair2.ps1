$env:MUNIM_HOME = 'C:\Users\User\Desktop\munim\connector-ps\.testdata'
Remove-Item $env:MUNIM_HOME -Recurse -Force -EA SilentlyContinue
& 'C:\Users\User\Desktop\munim\connector-ps\Munim-Connector.ps1' pair `
   -Tally 'http://localhost:9000' -Cloud 'http://localhost:8080' *>&1 |
  Out-File 'C:\Users\User\Desktop\munim\pairlog.txt' -Encoding utf8
