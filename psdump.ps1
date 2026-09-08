$env:MUNIM_HOME = 'C:\Users\User\Desktop\munim\connector-ps\.testdata'
# Load the connector's functions without running a command
$src = Get-Content 'C:\Users\User\Desktop\munim\connector-ps\Munim-Connector.ps1' -Raw
$body = $src -replace '(?s)^.*?# -+ tally -+', ''
$body = $body -replace '(?s)# -+ main -+.*$', ''
Invoke-Expression $body
$cfg = [ordered]@{ tallyUrl='http://localhost:9000'; cloudUrl='http://localhost:8080' }
$doc = Invoke-Tally $cfg (New-CollectionRequest 'Voucher' 'Arul G' 0)
foreach ($n in $doc.SelectNodes('//VOUCHER')) {
  $rec = ConvertTo-VoucherRecord $n 'x'
  if (-not $rec.guid) { continue }
  $rec.data | Select-Object vchNo, vchType, date, amountPaise, isCancelled, isOptional | ConvertTo-Json
  break
}
