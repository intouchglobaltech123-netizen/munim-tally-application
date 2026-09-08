$env:MUNIM_HOME = 'C:\Users\User\Desktop\munim\connector-ps\.testdata'
Remove-Item $env:MUNIM_HOME -Recurse -Force -EA SilentlyContinue
try {
  & 'C:\Users\User\Desktop\munim\connector-ps\Munim-Connector.ps1' check `
      -Tally 'http://localhost:9000' -Cloud 'http://localhost:8080' *>&1 |
    Out-File 'C:\Users\User\Desktop\munim\psout.txt' -Encoding utf8
} catch {
  $_.Exception.Message | Out-File 'C:\Users\User\Desktop\munim\psout.txt' -Encoding utf8
  $_.ScriptStackTrace  | Out-File 'C:\Users\User\Desktop\munim\psout.txt' -Append -Encoding utf8
}
