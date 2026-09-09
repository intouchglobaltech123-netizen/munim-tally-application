<#
.SYNOPSIS
  Munim connector - reads Tally and syncs it to the Munim cloud.

.DESCRIPTION
  A PowerShell version of the connector, for machines where an unsigned .exe
  cannot run.

  Windows Smart App Control blocks unsigned executables outright, and a code
  signing certificate costs real money. It does NOT block PowerShell scripts,
  because powershell.exe is itself signed by Microsoft. So this ships as a
  script: nothing to install, nothing to sign, works on every Windows.

  It is read-only into Tally. There is deliberately no code path that writes.

.EXAMPLE
  .\Munim-Connector.ps1 check
  .\Munim-Connector.ps1 pair
  .\Munim-Connector.ps1 sync
  .\Munim-Connector.ps1 install     # run every 5 minutes in the background
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [ValidateSet('setup', 'check', 'pair', 'sync', 'watch', 'companies',
               'install', 'uninstall', 'status', 'reset', 'reconcile', 'logs',
               'history')]
  [string]$Command = 'check',

  [string]$Tally,           # e.g. http://localhost:9000
  [string]$Cloud,           # e.g. https://munim-tally-application-production.up.railway.app
  # Baked into the installer the customer downloads, so pairing needs no typing
  # and cannot be mistyped. Short-lived, and useless once used.
  [string]$Code,
  # The licence the customer bought. Asked for interactively when not supplied,
  # so a support engineer can pass one in and a shop owner can type one.
  [string]$LicenceKey,
  # Every AlterID poll is one small request that returns nothing when nothing
  # changed, so a short interval is cheap. 3s means a voucher saved in Tally is
  # on the owner's phone about as fast as they can look at it.
  [int]$IntervalSeconds = 3
)

$ErrorActionPreference = 'Stop'
$script:AppVersion = '0.1.0'

<#
  TLS 1.2, explicitly.

  Windows PowerShell 5.1 - which is what ships on the machines this runs on -
  negotiates whatever SecurityProtocol is set, and on older Windows that is
  still TLS 1.0. Every modern HTTPS endpoint refuses it, and the failure comes
  back as "The underlying connection was closed", which names nothing and sends
  a support call in entirely the wrong direction.

  Set before any request is made, and additively, so a machine that already
  prefers 1.3 keeps it.
#>
try {
  [Net.ServicePointManager]::SecurityProtocol =
    [Net.ServicePointManager]::SecurityProtocol -bor
    [Net.SecurityProtocolType]::Tls12
  # 1.3 where the framework knows about it; ignored quietly where it does not.
  try {
    [Net.ServicePointManager]::SecurityProtocol =
      [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls13
  } catch { }
} catch { }

<#
  Shops sit behind proxies more often than you would think - a school, a mall
  unit, a shared office. Using the system proxy with the logged-in user's
  credentials is what a browser on the same machine already does, so if the web
  works, this works.
#>
try {
  [Net.WebRequest]::DefaultWebProxy = [Net.WebRequest]::GetSystemWebProxy()
  [Net.WebRequest]::DefaultWebProxy.Credentials = [Net.CredentialCache]::DefaultNetworkCredentials
} catch { }

# Long-running connections go stale behind some routers; this keeps them honest.
try { [Net.ServicePointManager]::DnsRefreshTimeout = 60000 } catch { }
$script:TaskName = 'MunimConnector'

# State lives in ProgramData, not beside the script, so replacing the script
# never loses the pairing.
<#
  Where settings live.

  ProgramData is the right home for something machine-wide, and it is tried
  first. But it is not always writable by the person running setup: a file left
  by an earlier run under a different account, or one restored from a backup,
  carries an ACL that denies them - and the failure surfaces halfway through
  setup as something unrelated.

  A shop owner should not have to know what "run as administrator" means to
  install this, so fall back to their own AppData, which is always writable.
#>
function Resolve-DataDir {
  if ($env:MUNIM_HOME) { return $env:MUNIM_HOME }

  $shared = Join-Path $env:ProgramData 'Munim'
  try {
    New-Item -ItemType Directory -Force -Path $shared -ErrorAction Stop | Out-Null
    # Prove it is writable, rather than assuming the directory implies it.
    $probe = Join-Path $shared '.write-test'
    [System.IO.File]::WriteAllText($probe, 'x')
    Remove-Item $probe -Force -ErrorAction SilentlyContinue

    # An unwritable config left by an earlier run would still break saving.
    $cfg = Join-Path $shared 'config.json'
    if (Test-Path $cfg) {
      try {
        Set-ItemProperty -Path $cfg -Name IsReadOnly -Value $false -ErrorAction Stop
        $fs = [System.IO.File]::Open($cfg, 'Open', 'ReadWrite')
        $fs.Close()
      } catch {
        return Join-Path $env:LOCALAPPDATA 'Munim'
      }
    }
    return $shared
  } catch {
    return Join-Path $env:LOCALAPPDATA 'Munim'
  }
}

$script:DataDir = Resolve-DataDir
$script:ConfigPath = Join-Path $script:DataDir 'config.json'
$script:CursorPath = Join-Path $script:DataDir 'cursors.json'
$script:LogPath = Join-Path $script:DataDir 'connector.log'

# ---------------------------------------------------------------- config ----

function Get-Config {
  $cfg = [ordered]@{
    cloudUrl     = 'https://munim-tally-application-production.up.railway.app'
    tallyUrl     = 'http://localhost:9000'
    tallyVersion = 'prime'
    deviceToken  = ''
    connectorId  = ''
    orgName      = ''
    # Set once, when the licence is redeemed. Its presence is what stops the
    # key being asked for again on this machine.
    licenceId    = ''
    intervalSecs = 30
  }
  if (Test-Path $script:ConfigPath) {
    try {
      $onDisk = Get-Content $script:ConfigPath -Raw | ConvertFrom-Json
      foreach ($p in $onDisk.PSObject.Properties) { $cfg[$p.Name] = $p.Value }
    } catch {
      # A corrupt config must not brick the connector on every run.
      Write-Log "config unreadable, using defaults: $($_.Exception.Message)"
    }
  }
  if ($Tally) { $cfg.tallyUrl = $Tally.TrimEnd('/') }
  if ($Cloud) { $cfg.cloudUrl = $Cloud.TrimEnd('/') }
  return $cfg
}

function Save-Config($cfg) {
  New-Item -ItemType Directory -Force -Path $script:DataDir | Out-Null

  <#
    Clear read-only before writing.

    Files under ProgramData pick up the read-only attribute in several ordinary
    ways - copied from a network share, restored from a backup, written by a
    different account. Set-Content then throws, and because the whole setup runs
    inside one try/catch the customer is told the internet is down, which sends
    them to fix the wrong thing entirely.
  #>
  if (Test-Path $script:ConfigPath) {
    try { Set-ItemProperty -Path $script:ConfigPath -Name IsReadOnly -Value $false } catch { }
  }

  try {
    ($cfg | ConvertTo-Json -Depth 6) | Set-Content $script:ConfigPath -Encoding UTF8
  } catch {
    throw "Could not save settings to $($script:ConfigPath). " +
          "Right-click this file and choose 'Run as administrator', then try again. " +
          "($($_.Exception.Message))"
  }
}

function Get-Cursors {
  if (Test-Path $script:CursorPath) {
    try { return Get-Content $script:CursorPath -Raw | ConvertFrom-Json } catch { }
  }
  return [pscustomobject]@{}
}

function Save-Cursors($cursors) {
  New-Item -ItemType Directory -Force -Path $script:DataDir | Out-Null
  ($cursors | ConvertTo-Json -Depth 6) | Set-Content $script:CursorPath -Encoding UTF8
}

<#
  The log, kept small.

  This runs unattended for months. A line per failed poll on a shop that closes
  every night is tens of thousands of lines a year, and an unbounded log file on
  a customer's machine is our problem, not theirs.

  One rollover, no compression: the last two files are enough to answer "what
  happened last night", which is the only question this log ever gets asked.
#>
$script:MaxLogBytes = 512KB

function Write-Log($msg) {
  $line = "{0}  {1}" -f (Get-Date -Format 's'), $msg
  try {
    New-Item -ItemType Directory -Force -Path $script:DataDir | Out-Null

    if (Test-Path $script:LogPath) {
      $size = (Get-Item $script:LogPath).Length
      if ($size -gt $script:MaxLogBytes) {
        $old = "$($script:LogPath).1"
        Remove-Item $old -Force -ErrorAction SilentlyContinue
        Move-Item $script:LogPath $old -Force -ErrorAction SilentlyContinue
      }
    }

    Add-Content -Path $script:LogPath -Value $line
  } catch { }
}

# ----------------------------------------------------------------- tally ----

<#
  Tally's XML is not valid XML. Repair it before parsing, or the first customer
  with "R & K Traders" in their books breaks the sync:
    - control bytes anywhere in the stream
    - numeric refs for those same control chars (&#4;)
    - bare, unescaped & in names
  Do NOT unescape everything and re-escape: that turns &lt; into &amp;lt; and
  silently mangles every name containing an escaped character.
#>
function Repair-TallyXml([string]$xml) {
  if (-not $xml) { return '' }
  # forbidden control characters (tab/LF/CR are legal and must survive)
  $xml = $xml -replace '[\x00-\x08\x0B\x0C\x0E-\x1F]', ''
  # numeric references to those same characters
  $xml = $xml -replace '&#(?:0?[0-8]|1[1-9]|2[0-9]|3[01]);', ''
  # escape only ampersands that do not already begin a valid entity
  $xml = $xml -replace '&(?!(?:[a-zA-Z][a-zA-Z0-9]{0,8}|#[0-9]{1,7}|#x[0-9a-fA-F]{1,6});)', '&amp;'
  # anything before the first tag (Tally sometimes prefixes junk)
  $i = $xml.IndexOf('<')
  if ($i -gt 0) { $xml = $xml.Substring($i) }
  return $xml
}

function Invoke-Tally($cfg, [string]$body, [int]$TimeoutSec = 300) {
  $res = Invoke-WebRequest -Uri $cfg.tallyUrl -Method Post -Body $body `
           -ContentType 'text/xml;charset=utf-8' -TimeoutSec $TimeoutSec -UseBasicParsing
  $clean = Repair-TallyXml $res.Content
  try {
    return [xml]$clean
  } catch {
    throw "Tally sent a response this connector could not read: $($_.Exception.Message)"
  }
}

# Native methods per collection. Keep them explicit: asking for a field a Tally
# version does not have makes it return an empty collection with no error,
# which looks exactly like "no new data".
# Detected once per process, then reused: Tally's edition cannot change while
# it is running, and the server interval arrives on each heartbeat.
$script:TallyEdition = ''
$script:TallyRelease = ''
$script:ServerInterval = 0

$script:NativeMethods = @{
  Company   = 'Name,StartingFrom,EndingAt,GUID,AlterID'
  Group     = 'Name,Parent,PrimaryGroup,GUID,AlterID'
  Ledger    = 'Name,Parent,OpeningBalance,ClosingBalance,LedgerPhone,LedgerMobile,Email,BillCreditPeriod,GUID,AlterID'
  StockItem = 'Name,BaseUnits,ClosingBalance,ClosingValue,GUID,AlterID'
  Voucher   = 'Date,VoucherTypeName,VoucherNumber,PartyLedgerName,Narration,Amount,IsCancelled,IsOptional,GUID,AlterID'
}

function New-CompaniesRequest {
  @"
<ENVELOPE>
  <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST>
  <TYPE>Collection</TYPE><ID>ListOfCompanies</ID></HEADER>
  <BODY><DESC>
    <STATICVARIABLES>
      <SVEXPORTFORMAT>`$`$SysName:XML</SVEXPORTFORMAT>
      <SVIsSimpleCompany>No</SVIsSimpleCompany>
    </STATICVARIABLES>
    <TDL><TDLMESSAGE>
      <COLLECTION NAME="ListOfCompanies" ISINITIALIZE="Yes">
        <TYPE>Company</TYPE>
        <NATIVEMETHOD>$($script:NativeMethods.Company)</NATIVEMETHOD>
      </COLLECTION>
    </TDLMESSAGE></TDL>
  </DESC></BODY>
</ENVELOPE>
"@
}

<#
  The AlterID filter is what makes this incremental. Every master and voucher
  carries a monotonically increasing AlterID; asking only for records above the
  last one we stored turns a full re-download into a few rows. Without it this
  would re-read the entire book every cycle.
#>
<#
  The company's own details: address, GSTIN, PAN, the lot.

  Deliberately a SECOND request rather than more fields on the company list.
  Tally answers a collection asking for a field it does not have with an EMPTY
  collection and no error - indistinguishable from "no companies open". Putting
  these fields on the list request would mean a single unsupported field on one
  Tally version silently breaks company discovery, and with it pairing.

  Kept separate, the worst case is that this one request comes back empty and
  the profile stays blank. Everything else keeps working.
#>
function New-CompanyProfileRequest([string]$company) {
  $esc = [System.Security.SecurityElement]::Escape($company)
  @"
<ENVELOPE>
  <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST>
  <TYPE>Collection</TYPE><ID>MunimCompanyProfile</ID></HEADER>
  <BODY><DESC>
    <STATICVARIABLES>
      <SVEXPORTFORMAT>`$`$SysName:XML</SVEXPORTFORMAT>
      <SVCURRENTCOMPANY>$esc</SVCURRENTCOMPANY>
      <SVIsSimpleCompany>No</SVIsSimpleCompany>
    </STATICVARIABLES>
    <TDL><TDLMESSAGE>
      <COLLECTION NAME="MunimCompanyProfile" ISINITIALIZE="Yes">
        <TYPE>Company</TYPE>
        <NATIVEMETHOD>Name,BasicCompanyFormalName,Address,StateName,CountryName,PinCode,PhoneNumber,Email,IncomeTaxNumber,GSTRegistrationNumber,CompanyRegistrationNumber,BooksFrom,StartingFrom,EndingAt,BaseCurrencySymbol,GUID</NATIVEMETHOD>
      </COLLECTION>
    </TDLMESSAGE></TDL>
  </DESC></BODY>
</ENVELOPE>
"@
}

<#
  Turns that into the record the API stores.

  ADDRESS is a LIST in Tally - a company address is several lines - so the
  lines are joined rather than only the first being taken, which would drop
  everything after the street.
#>
function ConvertTo-CompanyProfileRecord($node, [string]$companyGuid) {
  $lines = @()
  foreach ($a in $node.SelectNodes('ADDRESS.LIST/ADDRESS')) {
    if ($a.InnerText.Trim()) { $lines += $a.InnerText.Trim() }
  }
  # Some builds return a bare ADDRESS with no LIST wrapper.
  if ($lines.Count -eq 0) {
    $bare = Get-Child $node 'ADDRESS'
    if ($bare) { $lines += $bare }
  }

  [pscustomobject]@{
    kind        = 'companyProfile'
    companyGuid = $companyGuid
    guid        = $companyGuid
    alterId     = 0
    data        = [pscustomobject]@{
      name       = (Get-Child $node 'NAME')
      formalName = (Get-Child $node 'BASICCOMPANYFORMALNAME')
      address    = ($lines -join ', ')
      state      = (Get-Child $node 'STATENAME')
      country    = (Get-Child $node 'COUNTRYNAME')
      pincode    = (Get-Child $node 'PINCODE')
      phone      = (Get-Child $node 'PHONENUMBER')
      email      = (Get-Child $node 'EMAIL')
      pan        = (Get-Child $node 'INCOMETAXNUMBER')
      gstin      = (Get-Child $node 'GSTREGISTRATIONNUMBER')
      cin        = (Get-Child $node 'COMPANYREGISTRATIONNUMBER')
      booksFrom  = (ConvertTo-IsoDate (Get-Child $node 'BOOKSFROM'))
      fyStart    = (ConvertTo-IsoDate (Get-Child $node 'STARTINGFROM'))
      fyEnd      = (ConvertTo-IsoDate (Get-Child $node 'ENDINGAT'))
      currency   = (Get-Child $node 'BASECURRENCYSYMBOL')
    }
  }
}

function New-CollectionRequest([string]$type, [string]$company, [long]$sinceAlterId) {
  $filter = ''
  $system = ''
  if ($sinceAlterId -ge 0) {
    $filter = "`n        <FILTER>MunimAlterFilter</FILTER>"
    $system = "`n      <SYSTEM TYPE=`"Formulae`" NAME=`"MunimAlterFilter`">`$AlterID &gt; $sinceAlterId</SYSTEM>"
  }
  # Without FETCH a voucher arrives as a header with no line items - no ledger
  # entries, no bills, so no outstanding and no reminders.
  $fetch = ''
  if ($type -eq 'Voucher') {
    $fetch = "`n        <FETCH>AllLedgerEntries,LedgerEntries,AllInventoryEntries,BillAllocations</FETCH>"
  }
  $esc = [System.Security.SecurityElement]::Escape($company)

  @"
<ENVELOPE>
  <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST>
  <TYPE>Collection</TYPE><ID>Munim$type</ID></HEADER>
  <BODY><DESC>
    <STATICVARIABLES>
      <SVEXPORTFORMAT>`$`$SysName:XML</SVEXPORTFORMAT>
      <SVCURRENTCOMPANY>$esc</SVCURRENTCOMPANY>
    </STATICVARIABLES>
    <TDL><TDLMESSAGE>
      <COLLECTION NAME="Munim$type" ISMODIFY="No">
        <TYPE>$type</TYPE>
        <NATIVEMETHOD>$($script:NativeMethods[$type])</NATIVEMETHOD>$fetch$filter
      </COLLECTION>$system
    </TDLMESSAGE></TDL>
  </DESC></BODY>
</ENVELOPE>
"@
}

function Get-TallyCompanies($cfg) {
  $doc = Invoke-Tally $cfg (New-CompaniesRequest)
  $out = @()
  foreach ($n in $doc.SelectNodes('//COMPANY')) {
    $name = Get-NodeName $n
    if ($name) {
      $out += [pscustomobject]@{
        Name    = $name
        Guid    = (Get-Child $n 'GUID')
        FyStart = (Get-Child $n 'STARTINGFROM')
      }
    }
  }
  return $out
}

# --------------------------------------------------------------- parsing ----

function Get-Child($node, [string]$tag) {
  $c = $node.SelectSingleNode($tag)
  if ($c) { return $c.InnerText.Trim() }
  return ''
}

<#
  Real Tally puts a master's name in the element ATTRIBUTE and leaves the <NAME>
  child empty (it holds a language list). Reading only the child yields blank
  names against real Tally; reading only the attribute yields blanks against
  some exports. Read both.
#>
function Get-NodeName($node) {
  $a = $node.GetAttribute('NAME')
  if ($a -and $a.Trim()) { return $a.Trim() }
  return (Get-Child $node 'NAME')
}

<#
  Amounts arrive Indian-formatted with a sign and sometimes a unit suffix:
  "-1,25,000.00". Returns integer paise - never a float. A float rupee value
  accumulates error across a large aggregation, and an accounting product that
  is off by a paisa is one nobody trusts.
#>
function ConvertTo-Paise([string]$s) {
  if (-not $s) { return [long]0 }
  $s = $s.Trim()
  $neg = $false
  if ($s.StartsWith('(') -and $s.EndsWith(')')) { $neg = $true; $s = $s.Trim('(', ')') }
  $digits = ($s -replace '[^0-9.\-]', '')
  if ($digits -match '^-') { $neg = -not $neg }
  $digits = $digits -replace '-', ''
  if (-not $digits -or $digits -eq '.') { return [long]0 }

  $parts = $digits.Split('.')
  $whole = if ($parts[0]) { $parts[0] } else { '0' }
  $frac = if ($parts.Length -gt 1) { ($parts[1] + '00').Substring(0, 2) } else { '00' }
  $total = [long]$whole * 100 + [long]$frac
  if ($neg) { return -$total }
  return $total
}

function ConvertTo-IsoDate([string]$s) {
  if ($s -and $s.Length -eq 8) {
    try { return ([datetime]::ParseExact($s, 'yyyyMMdd', $null)).ToString('yyyy-MM-dd') } catch { }
  }
  return ''
}

function ConvertTo-Bool([string]$s) { return ($s -and $s.Trim().ToLower() -eq 'yes') }

function Get-CreditDays([string]$s) {
  if ($s -match '(\d+)') { return [int]$Matches[1] }
  return 0
}

# ------------------------------------------------------------ normalizing ---

<#
  Tally signs Debit negative and Credit positive. We store the opposite -
  Debit positive - because that is what every screen wants: a customer who owes
  you money should read as a positive receivable, and cash in hand is not a
  negative number.
#>
<#
  The account tree.

  Ledgers carry only their immediate parent's NAME, which is enough to classify
  the standard Tally groups by name alone but not a group the shop invented.
  A customer who files buyers under "Local Customers" inside Sundry Debtors has
  a ledger whose parent means nothing to a name-based rule, and it silently
  falls out of the Balance Sheet. The tree is what lets that be resolved to the
  primary group it actually hangs from.
#>
<#
  The master detail requests.

  A SECOND request per master type, exactly as with the company profile, and
  for the same reason: Tally answers a collection asking for a field it does
  not have with an EMPTY collection and no error. Putting these fields on the
  main Ledger or StockItem request would mean one unsupported field on one
  Tally version silently emptying the sync that everything else depends on.

  Kept apart, the worst case is that a party has no GSTIN on screen.
#>
function New-DetailRequest([string]$type, [string]$company, [string]$methods) {
  $esc = [System.Security.SecurityElement]::Escape($company)
  @"
<ENVELOPE>
  <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST>
  <TYPE>Collection</TYPE><ID>MunimDetail$type</ID></HEADER>
  <BODY><DESC>
    <STATICVARIABLES>
      <SVEXPORTFORMAT>`$`$SysName:XML</SVEXPORTFORMAT>
      <SVCURRENTCOMPANY>$esc</SVCURRENTCOMPANY>
    </STATICVARIABLES>
    <TDL><TDLMESSAGE>
      <COLLECTION NAME="MunimDetail$type" ISINITIALIZE="Yes">
        <TYPE>$type</TYPE>
        <NATIVEMETHOD>$methods</NATIVEMETHOD>
      </COLLECTION>
    </TDLMESSAGE></TDL>
  </DESC></BODY>
</ENVELOPE>
"@
}

# Everything beyond the core fields, asked for separately.
$script:DetailMethods = @{
  Ledger = 'Name,GUID,PartyGSTIN,GSTRegistrationType,IncomeTaxNumber,LedgerContact,' +
           'Address,LedStateName,CountryName,PinCode,CreditLimit,' +
           'BankDetails,BankName,BankAccountNo,IFSCode,BankAccHolderName'
  StockItem = 'Name,GUID,Parent,Category,BaseUnits,AdditionalUnits,HSNCode,GSTApplicable,' +
              'OpeningBalance,OpeningValue,MinimumLevel,MaximumLevel,ReorderLevel,' +
              'StandardCostList,StandardPriceList'
}

<#
  Joins Tally's ADDRESS.LIST into one string.

  An address in Tally is a list of free-text lines with no structure, so the
  lines ARE the address - taking only the first would drop everything after
  the street.
#>
function Get-AddressLines($node, [string]$tag = 'ADDRESS') {
  $lines = @()
  foreach ($a in $node.SelectNodes("$tag.LIST/$tag")) {
    if ($a.InnerText.Trim()) { $lines += $a.InnerText.Trim() }
  }
  if ($lines.Count -eq 0) {
    $bare = Get-Child $node $tag
    if ($bare) { $lines += $bare }
  }
  return ($lines -join ', ')
}

<# A GST rate as basis points: 18% -> 1800. Never a float. #>
function ConvertTo-BasisPoints([string]$raw) {
  if ($raw -match '(-?[\d.]+)') { return [int][Math]::Round([double]$Matches[1] * 100) }
  return 0
}

function ConvertTo-LedgerDetailRecord($node, [string]$companyGuid) {
  [pscustomobject]@{
    kind        = 'ledgerDetail'
    companyGuid = $companyGuid
    guid        = (Get-Child $node 'GUID')
    alterId     = 0
    data        = [pscustomobject]@{
      name          = (Get-NodeName $node)
      gstin         = (Get-Child $node 'PARTYGSTIN')
      gstRegType    = (Get-Child $node 'GSTREGISTRATIONTYPE')
      pan           = (Get-Child $node 'INCOMETAXNUMBER')
      contactPerson = (Get-Child $node 'LEDGERCONTACT')
      address       = (Get-AddressLines $node 'ADDRESS')
      state         = (Get-Child $node 'LEDSTATENAME')
      country       = (Get-Child $node 'COUNTRYNAME')
      pincode       = (Get-Child $node 'PINCODE')
      creditLimitPaise = (ConvertTo-Paise (Get-Child $node 'CREDITLIMIT'))
      bankName      = (Get-Child $node 'BANKNAME')
      bankAccount   = (Get-Child $node 'BANKACCOUNTNO')
      bankIfsc      = (Get-Child $node 'IFSCODE')
      bankHolder    = (Get-Child $node 'BANKACCHOLDERNAME')
    }
  }
}

function ConvertTo-StockDetailRecord($node, [string]$companyGuid) {
  $openQty = 0.0
  $raw = Get-Child $node 'OPENINGBALANCE'
  if ($raw -match '(-?[\d,]+(?:\.\d+)?)') { $openQty = [double]($Matches[1] -replace ',', '') }

  $level = {
    param($tag)
    $v = Get-Child $node $tag
    if ($v -match '(-?[\d,]+(?:\.\d+)?)') { return [double]($Matches[1] -replace ',', '') }
    return 0.0
  }

  [pscustomobject]@{
    kind        = 'stockDetail'
    companyGuid = $companyGuid
    guid        = (Get-Child $node 'GUID')
    alterId     = 0
    data        = [pscustomobject]@{
      name         = (Get-NodeName $node)
      parentGroup  = (Get-Child $node 'PARENT')
      category     = (Get-Child $node 'CATEGORY')
      altUnit      = (Get-Child $node 'ADDITIONALUNITS')
      hsn          = (Get-Child $node 'HSNCODE')
      gstRateBp    = (ConvertTo-BasisPoints (Get-Child $node 'GSTAPPLICABLE'))
      openingQty   = $openQty
      openingValuePaise = (ConvertTo-Paise (Get-Child $node 'OPENINGVALUE'))
      minLevel     = (& $level 'MINIMUMLEVEL')
      maxLevel     = (& $level 'MAXIMUMLEVEL')
      reorderLevel = (& $level 'REORDERLEVEL')
    }
  }
}

function ConvertTo-GroupRecord($node, [string]$companyGuid) {
  [pscustomobject]@{
    kind        = 'group'
    companyGuid = $companyGuid
    guid        = (Get-Child $node 'GUID')
    alterId     = [long](Get-Child $node 'ALTERID')
    data        = [pscustomobject]@{
      name         = (Get-NodeName $node)
      parent       = (Get-Child $node 'PARENT')
      primaryGroup = (Get-Child $node 'PRIMARYGROUP')
    }
  }
}

function ConvertTo-LedgerRecord($node, [string]$companyGuid) {
  $phone = Get-Child $node 'LEDGERMOBILE'
  if (-not $phone) { $phone = Get-Child $node 'LEDGERPHONE' }
  [pscustomobject]@{
    kind        = 'ledger'
    companyGuid = $companyGuid
    guid        = (Get-Child $node 'GUID')
    alterId     = [long](Get-Child $node 'ALTERID')
    data        = [pscustomobject]@{
      name         = (Get-NodeName $node)
      parentGroup  = (Get-Child $node 'PARENT')
      openingPaise = -(ConvertTo-Paise (Get-Child $node 'OPENINGBALANCE'))
      closingPaise = -(ConvertTo-Paise (Get-Child $node 'CLOSINGBALANCE'))
      phone        = $phone
      email        = (Get-Child $node 'EMAIL')
      creditDays   = (Get-CreditDays (Get-Child $node 'BILLCREDITPERIOD'))
    }
  }
}

function ConvertTo-VoucherRecord($node, [string]$companyGuid) {
  $entries = @()
  $bills = @()
  foreach ($e in $node.SelectNodes('ALLLEDGERENTRIES.LIST')) {
    $entries += [pscustomobject]@{
      ledger      = (Get-Child $e 'LEDGERNAME')
      amountPaise = -(ConvertTo-Paise (Get-Child $e 'AMOUNT'))
    }
    foreach ($b in $e.SelectNodes('BILLALLOCATIONS.LIST')) {
      $bills += [pscustomobject]@{
        ref         = (Get-Child $b 'NAME')
        billType    = (Get-Child $b 'BILLTYPE')
        dueDate     = (ConvertTo-IsoDate (Get-Child $b 'BILLCREDITPERIOD'))
        amountPaise = -(ConvertTo-Paise (Get-Child $b 'AMOUNT'))
      }
    }
  }

  $items = @()
  foreach ($i in $node.SelectNodes('ALLINVENTORYENTRIES.LIST')) {
    $qtyRaw = Get-Child $i 'ACTUALQTY'
    $qty = 0.0
    if ($qtyRaw -match '(-?[\d,]+(?:\.\d+)?)') { $qty = [double]($Matches[1] -replace ',', '') }
    $items += [pscustomobject]@{
      item        = (Get-Child $i 'STOCKITEMNAME')
      qty         = $qty
      ratePaise   = (ConvertTo-Paise (Get-Child $i 'RATE'))
      amountPaise = -(ConvertTo-Paise (Get-Child $i 'AMOUNT'))
    }
  }

  [pscustomobject]@{
    kind        = 'voucher'
    companyGuid = $companyGuid
    guid        = (Get-Child $node 'GUID')
    alterId     = [long](Get-Child $node 'ALTERID')
    data        = [pscustomobject]@{
      vchNo       = (Get-Child $node 'VOUCHERNUMBER')
      vchType     = (Get-Child $node 'VOUCHERTYPENAME')
      date        = (ConvertTo-IsoDate (Get-Child $node 'DATE'))
      party       = (Get-Child $node 'PARTYLEDGERNAME')
      amountPaise = -(ConvertTo-Paise (Get-Child $node 'AMOUNT'))
      narration   = (Get-Child $node 'NARRATION')
      isCancelled = (ConvertTo-Bool (Get-Child $node 'ISCANCELLED'))
      isOptional  = (ConvertTo-Bool (Get-Child $node 'ISOPTIONAL'))
      entries     = $entries
      items       = $items
      bills       = $bills
    }
  }
}

function ConvertTo-StockRecord($node, [string]$companyGuid) {
  $qtyRaw = Get-Child $node 'CLOSINGBALANCE'
  $qty = 0.0
  if ($qtyRaw -match '(-?[\d,]+(?:\.\d+)?)') { $qty = [double]($Matches[1] -replace ',', '') }
  [pscustomobject]@{
    kind        = 'stockItem'
    companyGuid = $companyGuid
    guid        = (Get-Child $node 'GUID')
    alterId     = [long](Get-Child $node 'ALTERID')
    data        = [pscustomobject]@{
      name              = (Get-NodeName $node)
      unit              = (Get-Child $node 'BASEUNITS')
      closingQty        = $qty
      closingValuePaise = -(ConvertTo-Paise (Get-Child $node 'CLOSINGVALUE'))
    }
  }
}

# ----------------------------------------------------------------- cloud ----

function Invoke-Cloud($cfg, [string]$path, [string]$method = 'GET', $body = $null, [string]$token = $null) {
  $headers = @{}
  if ($token) { $headers['Authorization'] = "Bearer $token" }
  $args = @{
    Uri         = "$($cfg.cloudUrl)$path"
    Method      = $method
    Headers     = $headers
    ContentType = 'application/json'
    TimeoutSec  = 60
    UseBasicParsing = $true
  }
  if ($null -ne $body) { $args['Body'] = ($body | ConvertTo-Json -Depth 8 -Compress) }
  try {
    return Invoke-RestMethod @args
  } catch {
    $msg = $_.Exception.Message
    $resp = $_.Exception.Response
    if ($resp) {
      try {
        $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $raw = $reader.ReadToEnd()
        $parsed = $raw | ConvertFrom-Json
        if ($parsed.error.message) { $msg = $parsed.error.message }
      } catch { }
    }
    throw $msg
  }
}

<#
  One batch of records as NDJSON. The Idempotency-Key is derived from the batch
  contents so a retry after a timeout carries the same key the first attempt
  did; the server scopes it per tenant before use.
#>
<#
  The outbox.

  A shop's internet goes down. Without somewhere to put them, the connector has
  two bad options: advance its cursor and lose the records, or hold the cursor
  and re-read the same rows out of Tally every three seconds until the line
  comes back - which on a slow shop PC is a real load for hours.

  So a batch that cannot be sent is written to disk instead, and the cursor is
  allowed to move on. The queue drains, oldest first, as soon as the server
  answers again. Each file carries the idempotency key it was built with, so a
  batch that was actually received before the connection dropped is recognised
  and discarded rather than double-counted.

  Capped, because a disk that fills is a worse failure than a sync that stalls.
  At the cap the connector stops queueing and holds its cursor instead - back to
  the safe, slow behaviour.
#>
$script:OutboxDir = $null
$script:LastOutboxError = ''
$script:MaxOutboxFiles = 500

function Get-OutboxDir {
  if (-not $script:OutboxDir) {
    $script:OutboxDir = Join-Path $script:DataDir 'outbox'
    New-Item -ItemType Directory -Force -Path $script:OutboxDir | Out-Null
  }
  return $script:OutboxDir
}

function Add-ToOutbox([string]$key, [string]$lines) {
  $dir = Get-OutboxDir
  $count = @(Get-ChildItem $dir -Filter '*.ndjson' -ErrorAction SilentlyContinue).Count
  if ($count -ge $script:MaxOutboxFiles) {
    throw "Munim is offline and the queue is full ($count batches waiting). " +
          'Nothing has been lost - it will catch up once the connection returns.'
  }

  # Sortable name: the queue drains in the order it was filled, so the books
  # arrive in the order they were written.
  $name = '{0}-{1}.ndjson' -f (Get-Date -Format 'yyyyMMddHHmmssfff'), [guid]::NewGuid().ToString('N').Substring(0, 6)
  $path = Join-Path $dir $name
  # The key travels with the payload; without it a resend looks like new data.
  Set-Content -Path $path -Value ($key + "`n" + $lines) -Encoding UTF8
  Write-Log "queued batch offline ($($count + 1) waiting)"
}

function Get-OutboxCount {
  try { return @(Get-ChildItem (Get-OutboxDir) -Filter '*.ndjson' -EA SilentlyContinue).Count }
  catch { return 0 }
}

<#
  Drains the queue, oldest first.

  Stops at the first failure rather than working through the rest: if one send
  failed the line is still down, and hammering it wastes the customer's
  bandwidth on requests that cannot succeed.
#>
function Send-Outbox($cfg) {
  $dir = Get-OutboxDir
  $files = @(Get-ChildItem $dir -Filter '*.ndjson' -EA SilentlyContinue | Sort-Object Name)
  if ($files.Count -eq 0) { return $true }
  $script:LastOutboxError = ''

  Write-Host "  Catching up: $($files.Count) batch(es) waiting." -ForegroundColor Cyan
  $sent = 0
  foreach ($f in $files) {
    try {
      $body = Get-Content $f.FullName -Raw
      $nl = $body.IndexOf("`n")
      if ($nl -lt 1) { Remove-Item $f.FullName -Force -EA SilentlyContinue; continue }
      $key = $body.Substring(0, $nl).Trim()
      $lines = $body.Substring($nl + 1)

      Send-Raw $cfg $key $lines
      Remove-Item $f.FullName -Force -EA SilentlyContinue
      $sent++
    } catch {
      # Kept so the caller can say what actually went wrong. "Offline" and
      # "the server refused us" need different words and different actions,
      # and telling somebody to check their internet when the real problem is
      # a revoked connector wastes everybody's afternoon.
      $script:LastOutboxError = $_.Exception.Message
      Write-Log "outbox stalled after $sent of $($files.Count): $($_.Exception.Message)"
      return $false
    }
  }
  Write-Host "  Caught up: $sent batch(es) sent." -ForegroundColor Green
  Write-Log "outbox drained ($sent batches)"
  return $true
}

<# The actual POST, shared by a live send and an outbox replay. #>
function Send-Raw($cfg, [string]$key, [string]$lines) {
  Invoke-RestMethod -Uri "$($cfg.cloudUrl)/v1/ingest" -Method Post `
    -Body ([System.Text.Encoding]::UTF8.GetBytes($lines)) `
    -ContentType 'application/x-ndjson' `
    -Headers @{ Authorization = "Bearer $($cfg.deviceToken)"; 'Idempotency-Key' = $key } `
    -TimeoutSec 120 | Out-Null
}

<# True when a failure is the network rather than the server refusing us. #>
function Test-OfflineError($err) {
  return ($err -match 'unable to connect|actively refused|timed out|timeout|' +
          'no such host|name or service|network is unreachable|remote name could not be resolved|' +
          'connection was closed|underlying connection')
}

function Send-Batch($cfg, $records) {
  if (-not $records -or $records.Count -eq 0) { return }
  $lines = ($records | ForEach-Object { $_ | ConvertTo-Json -Depth 10 -Compress }) -join "`n"
  $first = $records[0]; $last = $records[$records.Count - 1]
  $key = "$($first.companyGuid)-$($first.kind)-$($first.alterId)-$($last.alterId)-$($records.Count)"

  <#
    Two attempts before giving up on the line.

    Most failures on a shop connection are a single dropped packet, and a second
    try a moment later succeeds. Retrying more than once just delays the point
    at which the batch belongs in the outbox.
  #>
  for ($attempt = 1; $attempt -le 2; $attempt++) {
    try {
      Send-Raw $cfg $key $lines
      return
    } catch {
      $msg = $_.Exception.Message
      if (-not (Test-OfflineError $msg)) { throw }   # a real refusal: surface it
      if ($attempt -eq 1) { Start-Sleep -Seconds 2; continue }

      # Still no line. Keep the batch and let the cursor move on; it goes out
      # when the connection returns.
      Add-ToOutbox $key $lines
      return
    }
  }
}

# -------------------------------------------------------------- commands ----

function New-Check([string]$label, [bool]$ok, [string]$detail, [string]$fix = '') {
  [pscustomobject]@{ Label = $label; Ok = $ok; Detail = $detail; Fix = $fix }
}

function Test-Prerequisites($cfg) {
  # Built as a plain list. A script block cannot append to the caller's array -
  # "+=" inside one silently writes to a local copy and every check vanishes.
  $results = New-Object System.Collections.ArrayList

  [void]$results.Add((New-Check 'Windows' $true ([Environment]::OSVersion.VersionString)))

  $net = $false
  try {
    $net = (Invoke-WebRequest 'http://www.msftconnecttest.com/connecttest.txt' `
            -TimeoutSec 8 -UseBasicParsing).StatusCode -eq 200
  } catch { }
  [void]$results.Add((New-Check 'Internet connection' $net `
    $(if ($net) { 'Connected' } else { 'No internet' }) `
    'Connect this computer to the internet, then try again.'))

  $cloudOk = $false
  try { Invoke-Cloud $cfg '/v1/health' | Out-Null; $cloudOk = $true } catch { }
  [void]$results.Add((New-Check 'Munim server' $cloudOk `
    $(if ($cloudOk) { 'Reachable' } else { "Cannot reach $($cfg.cloudUrl)" }) `
    'Allow PowerShell through your firewall or antivirus.'))

  $companies = @()
  $tallyOk = $false
  try { $companies = @(Get-TallyCompanies $cfg); $tallyOk = $true } catch { }
  [void]$results.Add((New-Check 'Tally connection' $tallyOk `
    $(if ($tallyOk) { "Connected at $($cfg.tallyUrl)" } else { 'Tally is not answering' }) `
    'Open Tally, press F1 > Settings > Connectivity > Client/Server configuration. Set "Enable ODBC" to Yes and Port to 9000, then accept. Keep Tally open.'))

  if ($tallyOk) {
    $has = $companies.Count -gt 0
    [void]$results.Add((New-Check 'Company open in Tally' $has `
      $(if ($has) { "$($companies.Count) open: $(($companies | ForEach-Object { $_.Name }) -join ', ')" }
        else { 'No company is open' }) `
      'In Tally, open the company you want to sync, then try again.'))
  }

  return $results.ToArray()
}

function Show-Checks($results) {
  foreach ($r in $results) {
    $mark = if ($r.Ok) { '  OK  ' } else { ' FAIL ' }
    Write-Host ("[{0}] {1,-24} {2}" -f $mark, $r.Label, $r.Detail)
    if (-not $r.Ok -and $r.Fix) { Write-Host "         -> $($r.Fix)" -ForegroundColor Yellow }
  }
}

function Invoke-Check($cfg) {
  $results = Test-Prerequisites $cfg
  Show-Checks $results
  if ($results | Where-Object { -not $_.Ok }) { exit 1 }
}

<#
  Pairing never asks for a phone number on this computer. The cloud issues a
  short-lived code; the owner approves it in the Munim app, already signed in;
  the device token comes back here. This machine never handles a credential of
  theirs.
#>
<#
  The licence check.

  One key connects one computer, for good. The check has to happen on the server
  - a script on the customer's machine can be edited, and a licence that is only
  enforced locally is not a licence at all.

  It runs before pairing, so a wrong key costs nothing and a right one is spent
  only when the machine is actually going to be set up.
#>
function Invoke-Licence($cfg) {
  if ($cfg.licenceId) { return $true }   # already licensed on this machine

  $key = $LicenceKey
  if (-not $key) {
    Write-Host ''
    Write-Host '  Enter your Munim licence key.' -ForegroundColor Cyan
    Write-Host '  It is on your invoice and looks like MUNM-XXXX-XXXX-XXXX' -ForegroundColor DarkGray
    Write-Host ''
    $key = Read-Host '  Licence key'
  }

  if (-not $key) {
    Write-Host '  No licence key entered.' -ForegroundColor Yellow
    return $false
  }

  try {
    $body = @{ key = $key; machine = $env:COMPUTERNAME }
    $res = Invoke-Cloud $cfg '/v1/licence/redeem' 'POST' $body
  } catch {
    # The server's message is written for the shop owner, so show it as-is
    # rather than replacing it with something vaguer.
    $msg = $_.ErrorDetails.Message
    if ($msg) {
      try { $msg = ($msg | ConvertFrom-Json).error.message } catch { }
    }
    if (-not $msg) { $msg = $_.Exception.Message }
    Write-Host ''
    Write-Host "  $msg" -ForegroundColor Red
    return $false
  }

  $cfg.licenceId = $res.licenceId
  Save-Config $cfg
  Write-Host "  Licence accepted." -ForegroundColor Green
  return $true
}

function Invoke-Pair($cfg) {
  <#
    Two ways in.

    The installer the customer downloads already carries a code, so pairing is
    silent: nothing to read off one screen and type into another, and nothing to
    mistype. -Code is that path.

    Without one we ask the cloud for a fresh code and show it, which is what
    support does over the phone when an install needs re-pairing.
  #>
  if ($Code) {
    Write-Host ''
    Write-Host '  Connecting this computer to your Munim account...' -ForegroundColor Cyan
    $poll = Invoke-Cloud $cfg "/v1/auth/intent?id=$Code"
    if ($poll.expired) {
      Write-Host '  That link has expired. Download the installer again from Munim.' -ForegroundColor Yellow
      return $false
    }
    if ($poll.approved) {
      $cfg.deviceToken = $poll.deviceToken
      $cfg.connectorId = $poll.connectorId
      $cfg.orgName     = $poll.orgName
      Save-Config $cfg
      Write-Host "  Connected to $($poll.orgName)." -ForegroundColor Green
      return $true
    }
    # Not approved yet: fall through and wait on the same code rather than
    # minting a second one the customer never saw.
    Write-Host '  Waiting for approval in the Munim app...' -NoNewline
    $deadline = (Get-Date).AddMinutes(15)
    while ((Get-Date) -lt $deadline) {
      Start-Sleep -Seconds 3
      Write-Host '.' -NoNewline
      $poll = Invoke-Cloud $cfg "/v1/auth/intent?id=$Code"
      if ($poll.expired) { Write-Host "`n  That link expired." -ForegroundColor Yellow; return $false }
      if ($poll.approved) {
        $cfg.deviceToken = $poll.deviceToken
        $cfg.connectorId = $poll.connectorId
        $cfg.orgName     = $poll.orgName
        Save-Config $cfg
        Write-Host "`n  Connected to $($poll.orgName)." -ForegroundColor Green
        return $true
      }
    }
    Write-Host "`n  Timed out." -ForegroundColor Yellow
    return $false
  }

  $intent = Invoke-Cloud $cfg '/v1/auth/intent' 'POST'
  Write-Host ''
  Write-Host '  Open the Munim app on your phone and tap "Link Tally".' -ForegroundColor Cyan
  Write-Host ''
  Write-Host '  Type this code into the app:' -ForegroundColor Cyan
  Write-Host ''
  Write-Host "      $($intent.intentId)" -ForegroundColor Green
  Write-Host ''
  # Only shown when the server is configured with a real link base. Printing a
  # URL that does not resolve is worse than printing none.
  if ($intent.pairUrl) {
    Write-Host "  Or scan:  $($intent.pairUrl)" -ForegroundColor DarkGray
    Write-Host ''
  }
  Write-Host "  The code is good for 15 minutes." -ForegroundColor DarkGray
  Write-Host '  Waiting...' -NoNewline

  $deadline = (Get-Date).AddMinutes(15)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 3
    Write-Host '.' -NoNewline
    $poll = Invoke-Cloud $cfg "/v1/auth/intent?id=$($intent.intentId)"
    if ($poll.expired) { Write-Host "`n  That code expired. Run pair again." -ForegroundColor Yellow; return $false }
    if ($poll.approved) {
      $cfg.deviceToken = $poll.deviceToken
      $cfg.connectorId = $poll.connectorId
      $cfg.orgName = $poll.orgName
      Save-Config $cfg
      Write-Host "`n  Connected to $($poll.orgName)." -ForegroundColor Green
      return $true
    }
  }
  Write-Host "`n  Timed out." -ForegroundColor Yellow
  return $false
}

<#
  Tells the server which books this machine can see.

  Deliberately survives being offline. Registration is bookkeeping - the server
  already knows these companies from every previous sync - so a dropped line
  here must not stop the records themselves being read and queued. Blocking on
  it meant a shop with no internet did nothing at all, and the outbox that
  exists precisely for that case never saw a single batch.
#>
function Register-Companies($cfg) {
  $companies = @(Get-TallyCompanies $cfg)
  if ($companies.Count -eq 0) { throw 'No company is open in Tally.' }

  $payload = @{ companies = @($companies | ForEach-Object {
      @{ tallyGuid = $_.Guid; name = $_.Name; fyStart = $_.FyStart; enabled = $true } }) }
  try {
    Invoke-Cloud $cfg '/v1/connectors/companies/discover' 'POST' $payload $cfg.deviceToken | Out-Null
  } catch {
    $msg = $_.Exception.Message
    # A refusal is real and must surface; a dead line is not this function's
    # problem to solve.
    if (-not (Test-OfflineError $msg)) { throw }
    Write-Log "company registration skipped while offline: $msg"
  }

  return $companies
}

function Invoke-Sync($cfg, [string]$trigger = 'auto') {
  if (-not $cfg.deviceToken) { throw 'Not paired yet. Run:  .\Munim-Connector.ps1 pair' }

  <#
    Anything queued while offline goes first.

    Order matters: sending yesterday's records after today's would leave the
    books briefly wrong, and a customer looking at that moment sees figures that
    do not add up. If the queue will not drain the line is still down, so there
    is no point reading Tally at all this pass.
  #>
  if ((Get-OutboxCount) -gt 0) {
    if (-not (Send-Outbox $cfg)) {
      $why = $script:LastOutboxError
      if (Test-OfflineError $why) {
        throw "Munim is offline - $(Get-OutboxCount) batch(es) waiting. " +
              'Nothing is lost; they go as soon as the connection returns.'
      }
      # Not the network. Pass the real reason up, so the watcher can recognise
      # a revoked connector and stop instead of retrying for ever.
      throw "Could not send queued data: $why"
    }
  }

  $companies = Register-Companies $cfg
  $cursors = Get-Cursors

  foreach ($co in $companies) {
    $state = $cursors.$($co.Guid)
    if (-not $state) { $state = [pscustomobject]@{ master = 0; voucher = 0 } }

    # Timed per company, so the history can show which book is slow rather
    # than only that "the sync" took a while.
    $runStart = Get-Date

    $masterHigh = [long]$state.master
    $records = New-Object System.Collections.ArrayList

    <#
      Master detail, best effort.

      Wrapped for the same reason the company profile is: these ask Tally for
      fields whose availability varies by version, and a party without a GSTIN
      on screen is a cosmetic problem. The ledgers and vouchers below must sync
      regardless.
    #>
    foreach ($dt in @('Ledger', 'StockItem')) {
      try {
        $ddoc = Invoke-Tally $cfg (New-DetailRequest $dt $co.Name $script:DetailMethods[$dt])
        foreach ($n in $ddoc.SelectNodes("//$($dt.ToUpper())")) {
          $drec = if ($dt -eq 'Ledger') {
            ConvertTo-LedgerDetailRecord $n $co.Guid
          } else {
            ConvertTo-StockDetailRecord $n $co.Guid
          }
          if ($drec.guid) { [void]$records.Add($drec) }
        }
      } catch {
        Write-Log ("{0} detail skipped for {1}: {2}" -f $dt, $co.Name, $_.Exception.Message)
      }
    }

    <#
      The profile, best effort.

      Wrapped because it is the only request asking Tally for fields whose
      availability varies by version. A company that will not describe itself
      is a cosmetic problem - a blank letterhead - and must never stop the
      ledgers and vouchers below from syncing.
    #>
    try {
      $pdoc = Invoke-Tally $cfg (New-CompanyProfileRequest $co.Name)
      foreach ($n in $pdoc.SelectNodes('//COMPANY')) {
        $prec = ConvertTo-CompanyProfileRecord $n $co.Guid
        if ($prec.data.name) { [void]$records.Add($prec); break }
      }
    } catch {
      Write-Log ("company profile skipped for {0}: {1}" -f $co.Name, $_.Exception.Message)
    }

    # Group first: it is the tree the other two hang from, and sending it in
    # the same batch means a ledger never lands referring to a group the server
    # has not seen.
    foreach ($type in @('Group', 'Ledger', 'StockItem')) {
      $doc = Invoke-Tally $cfg (New-CollectionRequest $type $co.Name ([long]$state.master))
      foreach ($n in $doc.SelectNodes("//$($type.ToUpper())")) {
        $rec = switch ($type) {
          'Group'  { ConvertTo-GroupRecord  $n $co.Guid }
          'Ledger' { ConvertTo-LedgerRecord $n $co.Guid }
          default  { ConvertTo-StockRecord  $n $co.Guid }
        }
        if (-not $rec.guid) { continue }
        [void]$records.Add($rec)
        if ($rec.alterId -gt $masterHigh) { $masterHigh = $rec.alterId }
      }
    }

    $voucherHigh = [long]$state.voucher
    $doc = Invoke-Tally $cfg (New-CollectionRequest 'Voucher' $co.Name ([long]$state.voucher))
    foreach ($n in $doc.SelectNodes('//VOUCHER')) {
      $rec = ConvertTo-VoucherRecord $n $co.Guid
      if (-not $rec.guid) { continue }
      [void]$records.Add($rec)
      if ($rec.alterId -gt $voucherHigh) { $voucherHigh = $rec.alterId }
    }

    if ($records.Count -eq 0) {
      Write-Host ("  {0,-28} no changes" -f $co.Name)
      # Still a successful pass. Without this a quiet shop and a broken one
      # look identical in the history.
      Send-RunReport $cfg $co $runStart $trigger $true 0 0 ''
      continue
    }

    # 500 per batch keeps each request small enough for a shop's slow line.
    $sent = 0
    for ($i = 0; $i -lt $records.Count; $i += 500) {
      $end = [Math]::Min($i + 499, $records.Count - 1)
      Send-Batch $cfg $records[$i..$end]
      $sent += ($end - $i + 1)
    }

    # Advance the cursor only after the server accepted every batch. Advancing
    # first and then failing loses records silently, and the customer only
    # notices at month end.
    $cursors | Add-Member -NotePropertyName $co.Guid `
      -NotePropertyValue ([pscustomobject]@{ master = $masterHigh; voucher = $voucherHigh; name = $co.Name }) -Force
    Save-Cursors $cursors

    Write-Host ("  {0,-28} {1} records  alterId {2} -> {3}" -f $co.Name, $sent, $state.voucher, $voucherHigh)
    Write-Log "$($co.Name): sent $sent records, voucher cursor -> $voucherHigh"
    Send-RunReport $cfg $co $runStart $trigger $true $sent $records.Count ''
  }
}

<#
  Tell the cloud what this pass did.

  Wrapped and swallowed on purpose: failing to REPORT a sync must never fail
  the sync. This is diagnostics, and diagnostics that can break the thing they
  observe are worse than none.
#>
function Send-RunReport($cfg, $company, $startedAt, [string]$trigger,
                        [bool]$ok, [int]$records, [int]$total, [string]$err) {
  try {
    Invoke-Cloud $cfg '/v1/sync/run' 'POST' @{
      tallyGuid  = $company.Guid
      startedAt  = $startedAt.ToUniversalTime().ToString('o')
      durationMs = [int]((Get-Date) - $startedAt).TotalMilliseconds
      trigger    = $trigger
      ok         = $ok
      records    = $records
      batches    = [Math]::Ceiling($records / 500.0)
      error      = $err
    } $cfg.deviceToken | Out-Null
  } catch {
    Write-Log "run report failed: $($_.Exception.Message)"
  }
}

function Invoke-Heartbeat($cfg, [string]$status, [bool]$tallyUp, [string]$lastError) {
  if (-not $cfg.deviceToken) { return }
  try {
    $reply = Invoke-Cloud $cfg '/v1/connectors/heartbeat' 'POST' `
      @{
        status = $status; tallyUp = $tallyUp
        appVersion = $script:AppVersion; lastError = $lastError
        # So the operator console can tell a brief blip from a shop that has
        # been queueing for days.
        queuedBatches = (Get-OutboxCount)
        # Detected once and cached: it cannot change while Tally is running,
        # and asking on every beat would be a request every three seconds to
        # learn something we already know.
        tallyEdition = $script:TallyEdition
        tallyRelease = $script:TallyRelease
      } `
      $cfg.deviceToken

    # The heartbeat is the only way in: a shop PC has no port anyone can reach,
    # so everything the app asked for arrives in this reply.
    if ($reply) {
      if ($reply.settings -and $reply.settings.intervalSeconds) {
        $script:ServerInterval = [int]$reply.settings.intervalSeconds
      }
      if ($reply.commands -and $reply.commands.Count -gt 0) {
        Invoke-Commands $cfg $reply.commands
      }

      <#
        Vouchers waiting to be written, checked on every heartbeat.

        Not left to a command from the server: somebody who has just pressed
        Send is standing there watching, and waiting for the next command round
        trip would make a five-second job feel like a minute. The heartbeat is
        already happening, and the outbox call costs nothing when it is empty.

        The flag is only a hint - the server enforces what may be written, and
        an outbox call on a business that has writing switched off comes back
        with nothing.
      #>
      if ($reply.hasOutbox) {
        $out = Invoke-Outbox $cfg
        if ($out) { Write-Log "outbox: $out" }
      }
    }
  } catch { Write-Log "heartbeat failed: $($_.Exception.Message)" }
}

<#
  The watcher. This runs for months without anybody looking at it.

  Everything here exists to answer one question: after a power cut, a Tally
  that was closed for the weekend, a router reboot or a laptop lid closing for
  three days - does data still reach Munim without the owner doing anything?

  So the loop is written to be impossible to kill from the inside:

   - every iteration is wrapped; a throw can never end it
   - the heartbeat is wrapped separately, because a failure while REPORTING a
     failure used to take the loop down with it
   - backoff is capped low. Half an hour of silence after Tally reopens is a
     customer saying "it stopped working"; 60 seconds is not
   - Tally being closed is not an error - it is a shop that shut for the night,
     and it is the normal state for half of every day
   - the config is re-read as it goes, so re-pairing on the web takes effect
     without anybody restarting anything
   - a revoked connector stops rather than retrying for ever
#>
function Invoke-Watch($cfg) {
  Write-Host "  Watching Tally every $IntervalSeconds seconds. Ctrl+C to stop." -ForegroundColor Cyan
  Write-Log "watch started (interval ${IntervalSeconds}s)"

  <#
    One watcher per machine - but only while that watcher is actually working.

    The mutex alone had a hole. A process can hold it and be wedged: a socket
    that never returns after a resume, a Tally call blocked on a modal dialog
    somebody left open. It is alive, so the mutex is held and the scheduled
    task's MultipleInstances=IgnoreNew turns every retry away - and the shop
    silently stops syncing while everything looks fine from the outside.

    So aliveness is proved by work, not by existing. The loop touches a
    heartbeat file every pass; a second copy that finds the file stale concludes
    the holder is stuck, kills it, and takes over. A healthy watcher is never
    displaced, because a healthy watcher writes that file every few seconds.
  #>
  $aliveFile = Join-Path $script:DataDir 'watch.alive'
  $mutex = New-Object System.Threading.Mutex($false, 'Global\MunimConnectorWatch')
  if (-not $mutex.WaitOne(0)) {
    $stuck = $false
    try {
      if (Test-Path $aliveFile) {
        $age = ((Get-Date) - (Get-Item $aliveFile).LastWriteTime).TotalSeconds
        # Generous: a slow sync of a large company legitimately takes minutes,
        # and killing a working watcher is far worse than waiting for a stuck
        # one. Ten minutes of no progress at all is not slowness.
        if ($age -gt 600) { $stuck = $true; Write-Log ("holder stale by {0:N0}s" -f $age) }
      } else {
        # No file at all from a holder that should be writing one: either it
        # predates this version or it never got started properly.
        $stuck = $true
        Write-Log 'holder wrote no heartbeat file'
      }
    } catch { }

    if (-not $stuck) {
      Write-Host '  Munim is already running on this computer.' -ForegroundColor Yellow
      Write-Log 'another watcher holds the lock and is healthy; exiting'
      return
    }

    Write-Host '  The running copy has stopped responding. Replacing it.' -ForegroundColor Yellow
    Write-Log 'taking over from a stuck watcher'
    try {
      # Only PowerShell processes running THIS script, and never this one.
      $me = $PID
      Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" |
        Where-Object { $_.ProcessId -ne $me -and $_.CommandLine -like '*Munim-Connector*' } |
        ForEach-Object {
          Write-Log "stopping stuck watcher pid $($_.ProcessId)"
          Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
    } catch { Write-Log "could not stop the stuck watcher: $($_.Exception.Message)" }

    Start-Sleep -Seconds 2
    if (-not $mutex.WaitOne(0)) {
      Write-Log 'could not take the lock even after stopping the holder; exiting'
      return
    }
  }

  # Once per process, before the first beat, so the very first heartbeat
  # already carries it.
  if (-not $script:TallyEdition) {
    $v = Get-TallyEdition $cfg
    $script:TallyEdition = $v.edition
    $script:TallyRelease = $v.release
    if ($v.release) { Write-Log "tally $($v.edition) release $($v.release)" }
  }

  $backoff = $IntervalSeconds
  $sinceReload = 0
  $quiet = 0            # consecutive failures
  $started = Get-Date
  $lastPass = Get-Date

  <#
    Start again from scratch after a long run of failures.

    Some failures are not in the data or the network but in this process: a
    handle the framework will not release, a socket pool that has gone bad, a
    DNS answer cached from before the router rebooted. Nothing in the loop can
    fix those, and the process has usually been up for weeks by the time they
    happen.

    A fresh process costs a second and clears all of it. The scheduled task and
    the .cmd watchdog both restart us, so exiting is safe - and after roughly
    thirty minutes of solid failure, exiting is the better move.
  #>
  $restartAfterFailures = 60

  try {
    while ($true) {
      try {
        <#
          Did this machine just wake up?

          When Windows suspends the process, Start-Sleep is suspended with it,
          so a five-second wait can return eight hours later and the loop
          carries on as though nothing happened. It has not: the TCP
          connections in the pool are dead, any DNS answer was cached on a
          different network, and the first few requests will hang until they
          time out rather than failing fast.

          That is the "it only started working after I restarted it" report.
          A wall-clock jump far larger than the wait we asked for is the signal,
          and the fix is to throw the connection pool away and re-check Tally
          rather than to trust anything cached from before.
        #>
        $slept = ((Get-Date) - $lastPass).TotalSeconds
        if ($slept -gt ([Math]::Max($backoff * 4, 120))) {
          Write-Log ("resumed after {0:N0}s asleep; resetting connections" -f $slept)

          try {
            # Close pooled sockets so the next request opens a fresh one
            # instead of writing into a connection the other end forgot.
            [System.Net.ServicePointManager]::MaxServicePointIdleTime = 1
            Start-Sleep -Milliseconds 100
            [System.Net.ServicePointManager]::MaxServicePointIdleTime = 100000
          } catch { }

          # Tally may have been closed and reopened, or the company changed,
          # while the lid was shut.
          $script:TallyEdition = ''
          $script:TallyRelease = ''

          # Re-read config now rather than waiting out the usual minute: a
          # laptop that was re-paired while asleep should not sync as the old
          # device even once.
          $sinceReload = 60
          # And do not sit on a long backoff inherited from before the sleep.
          $backoff = $IntervalSeconds
          $quiet = 0
        }
        $lastPass = Get-Date

        # Proof of life, written every pass. A stuck watcher stops updating
        # this and another copy takes over; see the top of this function.
        try { Set-Content -Path $aliveFile -Value (Get-Date -Format 'o') -ErrorAction Stop }
        catch { }

        # Pick up a re-pair, or a licence revoked from the web, about once a
        # minute without re-reading the file on every single pass.
        $sinceReload += $backoff
        if ($sinceReload -ge 60) {
          $sinceReload = 0
          $fresh = Get-Config
          if ($fresh.deviceToken) { $cfg = $fresh }
        }

        if (-not $cfg.deviceToken) {
          Write-Log 'not paired; waiting'
          Start-Sleep -Seconds 30
          continue
        }

        $passStart = Get-Date
        try {
          Invoke-Sync $cfg
        } catch {
          # Recorded before rethrowing: a history showing only the passes that
          # worked is exactly the history that hides a broken shop.
          Safe-RunReport $cfg $passStart $_.Exception.Message
          throw
        }
        Safe-Heartbeat $cfg 'ok' $true ''

        if ($quiet -gt 0) {
          Write-Host '  Syncing again.' -ForegroundColor Green
          Write-Log "recovered after $quiet failure(s)"
          $quiet = 0
        }
        # The app can change how often this runs without a reinstall. The
        # local flag stays the floor, so support can still force a fast loop
        # on a machine they are watching.
        $backoff = if ($script:ServerInterval -gt 0) {
          [Math]::Max($IntervalSeconds, $script:ServerInterval)
        } else { $IntervalSeconds }
      } catch {
        $msg = $_.Exception.Message
        $quiet++

        # A connector that has been unlinked or whose licence was cancelled
        # should stop, not retry for ever against a server that keeps saying no.
        if ($msg -match '401|403|revoked|not authorised|unauthorized') {
          Write-Host '  This computer is no longer linked to Munim.' -ForegroundColor Yellow
          Write-Host '  Run the setup file again to reconnect.' -ForegroundColor Yellow
          Write-Log "stopping: $msg"
          Safe-Heartbeat $cfg 'revoked' $false $msg
          return
        }

        # Tally closed is the normal overnight state, not a fault. Retry soon,
        # and do not shout about it.
        $tallyDown = $msg -match 'refused|not answering|actively refused|unable to connect|timed out'

        if ($quiet -eq 1 -or $quiet % 20 -eq 0) {
          Write-Host "  Waiting: $msg" -ForegroundColor DarkGray
          Write-Log "sync failed ($quiet): $msg"
        }
        # if/else, not a ternary: Windows PowerShell 5.1 is what ships on the
        # machines this runs on, and it has no ternary operator.
        $state = 'error'
        if ($tallyDown) { $state = 'tally-down' }
        Safe-Heartbeat $cfg $state $false $msg

        # Capped low on purpose: the point is to be syncing again within a
        # minute of the problem going away, not to be economical about polling.
        $backoff = if ($tallyDown) { [Math]::Min($backoff * 2, 30) }
                   else { [Math]::Min($backoff * 2, 60) }

        # Tally being shut overnight is not a stuck process, so it never counts
        # towards a restart - only failures we cannot explain do.
        if (-not $tallyDown -and $quiet -ge $restartAfterFailures) {
          Write-Host '  Restarting Munim to clear the problem.' -ForegroundColor Yellow
          Write-Log "restarting after $quiet consecutive failures (up since $started)"
          return
        }
      }

      Start-Sleep -Seconds $backoff
    }
  } finally {
    $mutex.ReleaseMutex()
    $mutex.Dispose()
  }
}

<#
  Reporting a failure must never cause one.

  The heartbeat is how the operator console knows a customer has stopped
  syncing, so it is worth attempting - but the network being down is exactly
  when it will throw, and that used to end the loop that was trying to survive.
#>
<#
  What Tally actually is over there.

  "Not supported" is a completely different support call from "not running",
  and only this machine can tell them apart. Best effort - a Tally that will
  not name itself still syncs perfectly well, so a failure here is silent.
#>
function Get-TallyEdition($cfg) {
  try {
    $xml = @"
<ENVELOPE>
  <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST>
  <TYPE>Function</TYPE><ID>`$`$LicenseInfo</ID></HEADER>
  <BODY><DESC><FUNCPARAMLIST>
    <PARAM>VersionNumber</PARAM>
  </FUNCPARAMLIST></DESC></BODY>
</ENVELOPE>
"@
    $doc = Invoke-Tally $cfg $xml
    $release = ''
    $node = $doc.SelectSingleNode('//RESULT')
    if ($node) { $release = $node.InnerText.Trim() }

    # Tally Prime reports a 3-part release (3.0.1); ERP 9 reports 9.x. Reading
    # the edition off the release rather than asking separately keeps this to
    # one request.
    $edition = if ($release -match '^9\.') { 'erp9' }
               elseif ($release) { 'prime' }
               else { '' }
    return @{ edition = $edition; release = $release }
  } catch {
    return @{ edition = ''; release = '' }
  }
}

<#
  Reconciliation: prove what Tally holds matches what Munim holds.

  The incremental sync rides on ALTERID, which counts upward as records change.
  Tally does NOT raise an ALTERID when a voucher is DELETED - so a deleted
  voucher stays in Munim for ever and every total including it is quietly
  wrong. Nothing else in the pipeline can notice.

  This reads every GUID Tally can see and sends the whole set. `complete` is
  the safety catch: if the read threw halfway, the list is a lie, and acting on
  it would delete real records. In that case we send what we have with
  complete=$false, and the server counts without deleting.
#>
function Invoke-Reconcile($cfg, $company) {
  $kinds = @(
    @{ kind = 'voucher';   type = 'Voucher';   node = 'VOUCHER' },
    @{ kind = 'ledger';    type = 'Ledger';    node = 'LEDGER' },
    @{ kind = 'stockItem'; type = 'StockItem'; node = 'STOCKITEM' }
  )
  $summary = @()

  foreach ($k in $kinds) {
    $guids = New-Object System.Collections.ArrayList
    $complete = $true
    try {
      # -1 asks for everything, not just what changed since the cursor.
      $doc = Invoke-Tally $cfg (New-CollectionRequest $k.type $company.Name -1)
      foreach ($n in $doc.SelectNodes("//$($k.node)")) {
        $g = Get-Child $n 'GUID'
        if ($g) { [void]$guids.Add($g) }
      }
    } catch {
      $complete = $false
      Write-Log "reconcile read failed for $($k.kind): $($_.Exception.Message)"
    }

    try {
      $res = Invoke-Cloud $cfg '/v1/sync/reconcile' 'POST' @{
        tallyGuid = $company.Guid
        kind      = $k.kind
        guids     = @($guids)
        complete  = $complete
      } $cfg.deviceToken

      $summary += "$($k.kind): Tally $($res.inTally), Munim $($res.inMunim), removed $($res.deleted)"
      Write-Log "reconcile $($k.kind): tally=$($res.inTally) munim=$($res.inMunim) stale=$($res.stale) deleted=$($res.deleted)"
    } catch {
      Write-Log "reconcile upload failed for $($k.kind): $($_.Exception.Message)"
      $summary += "$($k.kind): failed"
    }
  }
  return ($summary -join '; ')
}

<#
  Ship the tail of the log up, when somebody has actually asked for it.

  Pulled rather than streamed: sending every line continuously would be
  constant traffic on a slow shop connection to report that nothing is wrong.
#>
function Send-Logs($cfg, [int]$count = 300) {
  if (-not (Test-Path $script:LogFile)) { return 'no log file yet' }

  $lines = Get-Content $script:LogFile -Tail $count -ErrorAction SilentlyContinue
  $payload = New-Object System.Collections.ArrayList

  foreach ($l in $lines) {
    if (-not $l) { continue }
    # Classified here because this is the only place that knows what the line
    # meant; the server just stores what it is told.
    $level = if ($l -match 'fail|error|could not|refused|denied') { 'error' }
             elseif ($l -match 'retry|waiting|offline|skipped|paused') { 'warn' }
             else { 'info' }
    $at = ''
    if ($l -match '^\[?(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})') { $at = $Matches[1] }
    [void]$payload.Add(@{ at = $at; level = $level; line = $l })
  }

  if ($payload.Count -eq 0) { return 'log is empty' }

  Invoke-Cloud $cfg '/v1/sync/logs' 'POST' @{ lines = @($payload) } $cfg.deviceToken | Out-Null
  return "sent $($payload.Count) line(s)"
}

<#
  Do whatever the app asked for.

  Each command is wrapped on its own: one that fails must not stop the next,
  and must not take the watch loop down with it.
#>

# ---------------------------------------------------------------- writing ----
#
# Everything above this line reads. This is the only part that writes, and it is
# written defensively enough to be boring:
#
#   * It asks Tally whether the voucher is already there BEFORE posting. Every
#     voucher Munim sends carries a REMOTEID - a GUID the server minted - so
#     "did this already go in?" is a question Tally can answer. Without that, a
#     connection dropped between Tally accepting a voucher and the server
#     hearing about it means a duplicate invoice, and duplicate invoices are
#     found weeks later by an accountant.
#
#   * It never alters an existing voucher. Every import is a create. Munim does
#     not own anything already in the customer's books.
#
#   * A rejection is reported verbatim. Tally's own words are more useful to
#     whoever has to fix it than any summary this script could write.

function Get-VoucherByRemoteId($cfg, [string]$company, [string]$remoteId) {
  $esc = [System.Security.SecurityElement]::Escape($company)
  $rid = [System.Security.SecurityElement]::Escape($remoteId)
  $body = @"
<ENVELOPE>
  <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST>
  <TYPE>Collection</TYPE><ID>MunimByRemote</ID></HEADER>
  <BODY><DESC>
    <STATICVARIABLES>
      <SVEXPORTFORMAT>`$`$SysName:XML</SVEXPORTFORMAT>
      <SVCURRENTCOMPANY>$esc</SVCURRENTCOMPANY>
    </STATICVARIABLES>
    <TDL><TDLMESSAGE>
      <COLLECTION NAME="MunimByRemote" ISINITIALIZE="Yes">
        <TYPE>Voucher</TYPE>
        <NATIVEMETHOD>GUID,VoucherNumber,RemoteID</NATIVEMETHOD>
        <FILTER>MunimRemote</FILTER>
      </COLLECTION>
      <SYSTEM TYPE="Formulae" NAME="MunimRemote">`$RemoteID = "$rid"</SYSTEM>
    </TDLMESSAGE></TDL>
  </DESC></BODY>
</ENVELOPE>
"@
  try {
    $xml = Invoke-Tally $cfg $body 60
    $v = $xml.ENVELOPE.BODY.DATA.COLLECTION.VOUCHER
    if ($v) {
      $first = if ($v -is [array]) { $v[0] } else { $v }
      return [pscustomobject]@{
        Found  = $true
        Guid   = [string]$first.GUID
        Number = [string]$first.VOUCHERNUMBER
      }
    }
  } catch {
    # A version that cannot answer this is not a reason to refuse to post; it
    # only means the duplicate check is unavailable, which the caller decides
    # what to do about.
    Write-Log "remote-id lookup unavailable: $($_.Exception.Message)"
    return [pscustomobject]@{ Found = $false; Unavailable = $true }
  }
  return [pscustomobject]@{ Found = $false }
}

function New-VoucherImportXml($v) {
  $esc = { param($t) [System.Security.SecurityElement]::Escape([string]$t) }

  # Tally wants yyyyMMdd, not an ISO date.
  $date = ([datetime]$v.date).ToString('yyyyMMdd')

  $lines = ''
  foreach ($e in $v.entries) {
    # Munim stores debit positive. Tally is the other way round, so the sign is
    # flipped here - the same negation the ingest path applies on the way in,
    # in reverse. Getting this backwards produces books that balance and are
    # completely wrong.
    $amt = [decimal]$e.amountPaise / 100
    $tallyAmount = (-$amt).ToString('0.00', [System.Globalization.CultureInfo]::InvariantCulture)
    $isDeemed = if ($e.amountPaise -gt 0) { 'Yes' } else { 'No' }

    $billXml = ''
    foreach ($b in $v.bills) {
      if ([string]$b.ledger -ne [string]$e.ledger) { continue }
      $bAmt = [decimal]$b.amountPaise / 100
      $billXml += @"

        <BILLALLOCATIONS.LIST>
          <NAME>$(& $esc $b.ref)</NAME>
          <BILLTYPE>$(& $esc $b.type)</BILLTYPE>
          <AMOUNT>$((-$bAmt).ToString('0.00', [System.Globalization.CultureInfo]::InvariantCulture))</AMOUNT>
        </BILLALLOCATIONS.LIST>
"@
    }

    $lines += @"

      <ALLLEDGERENTRIES.LIST>
        <LEDGERNAME>$(& $esc $e.ledger)</LEDGERNAME>
        <ISDEEMEDPOSITIVE>$isDeemed</ISDEEMEDPOSITIVE>
        <AMOUNT>$tallyAmount</AMOUNT>$billXml
      </ALLLEDGERENTRIES.LIST>
"@
  }

  $itemXml = ''
  foreach ($i in $v.items) {
    $rate = [decimal]$i.ratePaise / 100
    $amt  = [decimal]$i.amountPaise / 100
    $itemXml += @"

      <ALLINVENTORYENTRIES.LIST>
        <STOCKITEMNAME>$(& $esc $i.item)</STOCKITEMNAME>
        <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
        <ACTUALQTY>$($i.qty)</ACTUALQTY>
        <BILLEDQTY>$($i.qty)</BILLEDQTY>
        <RATE>$($rate.ToString('0.00', [System.Globalization.CultureInfo]::InvariantCulture))</RATE>
        <AMOUNT>$((-$amt).ToString('0.00', [System.Globalization.CultureInfo]::InvariantCulture))</AMOUNT>
      </ALLINVENTORYENTRIES.LIST>
"@
  }

  $numberXml = ''
  if ([string]$v.number -ne '') {
    $numberXml = "<VOUCHERNUMBER>$(& $esc $v.number)</VOUCHERNUMBER>"
  }

  @"
<ENVELOPE>
  <HEADER><VERSION>1</VERSION><TALLYREQUEST>Import</TALLYREQUEST><TYPE>Data</TYPE>
  <ID>Vouchers</ID></HEADER>
  <BODY><DESC>
    <STATICVARIABLES>
      <SVCURRENTCOMPANY>$(& $esc $v.companyName)</SVCURRENTCOMPANY>
    </STATICVARIABLES>
  </DESC>
  <DATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
    <VOUCHER VCHTYPE="$(& $esc $v.vchType)" ACTION="Create" OBJVIEW="Accounting Voucher View">
      <!-- The identity that makes this safe to retry. -->
      <REMOTEID>$(& $esc $v.remoteId)</REMOTEID>
      <DATE>$date</DATE>
      <EFFECTIVEDATE>$date</EFFECTIVEDATE>
      <VOUCHERTYPENAME>$(& $esc $v.vchType)</VOUCHERTYPENAME>
      $numberXml
      <PARTYLEDGERNAME>$(& $esc $v.party)</PARTYLEDGERNAME>
      <NARRATION>$(& $esc $v.narration)</NARRATION>
      <PERSISTEDVIEW>Accounting Voucher View</PERSISTEDVIEW>$lines$itemXml
    </VOUCHER>
  </TALLYMESSAGE></DATA>
  </BODY>
</ENVELOPE>
"@
}

function Send-VoucherResult($cfg, [string]$id, [bool]$ok, $fields) {
  $payload = @{ ok = $ok }
  foreach ($k in $fields.Keys) { $payload[$k] = $fields[$k] }
  try {
    Invoke-Cloud $cfg "/v1/connector/outbox/$id" 'POST' $payload $cfg.deviceToken | Out-Null
  } catch {
    Write-Log "could not report voucher result: $($_.Exception.Message)"
  }
}

function Invoke-Outbox($cfg) {
  $box = $null
  try {
    $box = Invoke-Cloud $cfg '/v1/connector/outbox' 'GET' $null $cfg.deviceToken
  } catch {
    Write-Log "outbox unavailable: $($_.Exception.Message)"
    return 'outbox unavailable'
  }
  if (-not $box -or -not $box.vouchers -or $box.vouchers.Count -eq 0) { return '' }

  $posted = 0; $failed = 0; $skipped = 0
  foreach ($v in $box.vouchers) {
    try {
      # Already there? Then a previous attempt reached Tally and we lost the
      # answer, not the voucher.
      $existing = Get-VoucherByRemoteId $cfg $v.companyName $v.remoteId
      if ($existing.Found) {
        Write-Log "voucher $($v.id) was already in Tally ($($existing.Number))"
        Send-VoucherResult $cfg $v.id $true @{
          tallyGuid     = $existing.Guid
          voucherNumber = $existing.Number
          response      = 'Already present in Tally; not posted again.'
        }
        $skipped++
        continue
      }

      $xml = New-VoucherImportXml $v
      $res = Invoke-Tally $cfg $xml 120
      $imp = $res.ENVELOPE.BODY.DATA.IMPORTRESULT

      $created = 0; $errors = 0
      if ($imp) {
        $created = [int]('0' + [string]$imp.CREATED)
        $errors  = [int]('0' + [string]$imp.ERRORS)
      }
      $raw = $res.OuterXml
      if ($raw.Length -gt 3500) { $raw = $raw.Substring(0, 3500) }

      if ($created -ge 1 -and $errors -eq 0) {
        # Read the GUID back rather than assuming: Tally allocates the number
        # from its own series, and that number is what the customer will quote.
        $made = Get-VoucherByRemoteId $cfg $v.companyName $v.remoteId
        Send-VoucherResult $cfg $v.id $true @{
          tallyGuid     = $made.Guid
          voucherNumber = $made.Number
          response      = $raw
        }
        Write-Log "posted voucher $($v.id) as $($made.Number)"
        $posted++
      } else {
        $why = [string]$imp.LINEERROR
        if (-not $why) { $why = "Tally reported $errors error(s) and created $created." }
        Send-VoucherResult $cfg $v.id $false @{ error = $why; response = $raw }
        Write-Log "Tally refused voucher $($v.id): $why"
        $failed++
      }
    } catch {
      Send-VoucherResult $cfg $v.id $false @{ error = $_.Exception.Message }
      Write-Log "voucher $($v.id) failed: $($_.Exception.Message)"
      $failed++
    }
  }

  $parts = @()
  if ($posted)  { $parts += "$posted posted" }
  if ($skipped) { $parts += "$skipped already there" }
  if ($failed)  { $parts += "$failed refused" }
  return ($parts -join ', ')
}

function Invoke-Commands($cfg, $commands) {
  if (-not $commands) { return }

  foreach ($c in $commands) {
    $ok = $true
    $result = ''
    try {
      Write-Log "command $($c.kind) ($($c.id))"
      switch ($c.kind) {
        'sync' {
          Invoke-Sync $cfg 'command'
          $result = 'synced'
        }
        'logs' {
          $result = Send-Logs $cfg
        }
        'outbox' {
          $r = Invoke-Outbox $cfg
          $result = if ($r) { $r } else { 'nothing waiting' }
        }
        'reconcile' {
          $parts = @()
          foreach ($co in (Register-Companies $cfg)) {
            $parts += "$($co.Name) -> " + (Invoke-Reconcile $cfg $co)
          }
          $result = ($parts -join ' | ')
        }
        default { $ok = $false; $result = "unknown command $($c.kind)" }
      }
    } catch {
      $ok = $false
      $result = $_.Exception.Message
      Write-Log "command $($c.kind) failed: $result"
    }

    try {
      Invoke-Cloud $cfg '/v1/sync/command' 'POST' `
        @{ id = $c.id; ok = $ok; result = $result } $cfg.deviceToken | Out-Null
    } catch {
      Write-Log "could not report command result: $($_.Exception.Message)"
    }
  }
}

function Safe-Heartbeat($cfg, [string]$status, [bool]$tallyUp, [string]$err) {
  try { Invoke-Heartbeat $cfg $status $tallyUp $err } catch { }
}

<#
  Record a failed pass without a company to attribute it to.

  A failure often happens before we know which book we were on - the network
  was down, or Tally would not answer at all - so this reports the run against
  the account rather than a company.
#>
function Safe-RunReport($cfg, $startedAt, [string]$err) {
  try {
    Invoke-Cloud $cfg '/v1/sync/run' 'POST' @{
      startedAt  = $startedAt.ToUniversalTime().ToString('o')
      durationMs = [int]((Get-Date) - $startedAt).TotalMilliseconds
      trigger    = 'auto'
      ok         = $false
      error      = $err
    } $cfg.deviceToken | Out-Null
  } catch { }
}

<#
  A scheduled task, not a Windows service: a per-user task needs no admin rights
  and therefore no UAC prompt, which is one less thing for a shop owner to get
  wrong.
#>
<#
  Keep Munim running, and start it again after a restart.

  Two ways, tried in order:

   1. A scheduled task. The right tool - it restarts the watcher if it dies and
      survives the user logging out. It needs administrator rights, which a shop
      owner double-clicking a file will not have.

   2. A shortcut in the Startup folder. Needs no rights at all, and starts at
      every login.

  The fallback matters more than it looks: without it, setup succeeded, synced,
  and then failed on its very last step with "Access is denied" - leaving a
  customer paired but not syncing, which is the worst of both.
#>
function Install-Task {
  $script = $PSCommandPath
  if (-not $script) { $script = $MyInvocation.MyCommand.Path }

  <#
    The script has to survive the file the customer downloaded.

    They ran a .bat from Downloads, and Downloads gets tidied. Worse, the script
    is fetched fresh over the network each run, so there may be no local file at
    all to point a startup entry at. Copy it somewhere permanent first, and
    schedule THAT.
  #>
  $installed = Join-Path $script:DataDir 'Munim-Connector.ps1'
  try {
    if ($script -and (Test-Path $script) -and $script -ne $installed) {
      Copy-Item $script $installed -Force
    } elseif (-not (Test-Path $installed)) {
      # Fetched over the network with no file on disk: write out what is running.
      $body = $MyInvocation.MyCommand.ScriptBlock.Ast.Extent.Text
      if ($body) { Set-Content -Path $installed -Value $body -Encoding UTF8 }
    }
    if (Test-Path $installed) { $script = $installed }
  } catch {
    Write-Log "could not copy the script into place: $($_.Exception.Message)"
  }

  # `watch`, not `sync`. A five-minute schedule is not "live": the owner adds an
  # invoice, looks at their phone, and sees nothing. This runs one long-lived
  # watcher instead, polling AlterID every few seconds - cheap, because a poll
  # with no changes returns nothing.
  $psArgs = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`" watch"

  try {
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $psArgs

    <#
      Three triggers, because a shop computer fails in three different ways.

        at log on      - the ordinary case, every morning
        at startup     - covers a machine that reboots after a power cut and
                         sits at the login screen until someone arrives
        every 5 min    - the safety net. If the watcher was killed by anything
                         at all, this starts it again; the mutex inside makes a
                         second copy harmless.

      StartWhenAvailable matters for a laptop that was asleep at the scheduled
      time: without it, a missed run is simply skipped.
    #>
    $triggers = @(New-ScheduledTaskTrigger -AtLogOn)
    try { $triggers += New-ScheduledTaskTrigger -AtStartup } catch { }

    <#
      Waking from sleep, which is the case the other triggers all miss.

      Closing a laptop lid is not a shutdown and opening it is not a logon, so
      neither AtStartup nor AtLogOn ever fires - the machine simply resumes.
      Until this trigger existed, a laptop opened at 9am waited up to five
      minutes for the repeating trigger before anything synced, and if the old
      process had survived the sleep holding dead sockets, it waited for the
      staleness check instead.

      Windows writes Event 1 to the Power-Troubleshooter log on every resume,
      including from hibernate. Built as CIM rather than with a cmdlet because
      Windows PowerShell 5.1 has no New-ScheduledTaskTrigger switch for an
      event subscription.
    #>
    try {
      $resumeXml = @'
<QueryList><Query Id="0" Path="System"><Select Path="System">
*[System[Provider[@Name='Microsoft-Windows-Power-Troubleshooter']
and EventID=1]]
</Select></Query></QueryList>
'@
      $resume = Get-CimClass -ClassName MSFT_TaskEventTrigger `
        -Namespace Root/Microsoft/Windows/TaskScheduler -ErrorAction Stop
      $t = New-CimInstance -CimClass $resume -ClientOnly
      $t.Subscription = $resumeXml
      $t.Enabled = $true
      $triggers += $t
    } catch {
      # Not fatal. The repeating trigger still covers a resume, just later.
      Write-Log "resume trigger unavailable: $($_.Exception.Message)"
    }
    # No RepetitionDuration: omitted, it repeats indefinitely, which is what we
    # want. [TimeSpan]::MaxValue looks like the way to say that but serialises
    # to P99999999DT23H59M59S, which Task Scheduler rejects outright - and the
    # whole registration fails with "value out of range".
    $repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
      -RepetitionInterval (New-TimeSpan -Minutes 5)
    $triggers += $repeat

    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable `
      -DontStopOnIdleEnd -ExecutionTimeLimit ([TimeSpan]::Zero) `
      -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
      -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

    Register-ScheduledTask -TaskName $script:TaskName -Action $action `
      -Trigger $triggers -Settings $settings -Force -ErrorAction Stop | Out-Null

    Write-Host '  Installed. Munim syncs continuously and starts itself at login.' -ForegroundColor Green
    return
  } catch {
    Write-Log "scheduled task refused ($($_.Exception.Message)); using Startup folder"
  }

  <#
    No admin, so no scheduled task. Two things instead, because a Startup
    shortcut alone only fires at login - it does nothing if the watcher dies at
    eleven in the morning.

      Startup folder  - starts it at every login, including after a reboot
      Run registry    - the same, and survives the Startup folder being tidied

    Plus a watchdog inside the .cmd: if the watcher ever exits, it waits a
    minute and starts it again, for as long as the machine is on. The mutex in
    the watcher makes a duplicate harmless.
  #>
  try {
    $startup = [Environment]::GetFolderPath('Startup')
    $cmdPath = Join-Path $startup 'Munim.cmd'
    @(
      '@echo off',
      'rem Keeps Munim syncing. Delete this file to stop it.',
      'title Munim',
      ':loop',
      ('powershell.exe ' + $psArgs),
      'timeout /t 60 /nobreak >nul',
      'goto loop'
    ) -join "`r`n" | Set-Content $cmdPath -Encoding ASCII

    # A second way in, in case the Startup folder is cleaned out.
    try {
      $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
      Set-ItemProperty -Path $runKey -Name 'Munim' `
        -Value ('cmd.exe /c start "" /min "' + $cmdPath + '"') -ErrorAction Stop
    } catch {
      Write-Log "could not add the Run entry: $($_.Exception.Message)"
    }

    Write-Host '  Installed. Munim syncs continuously and starts itself at login.' -ForegroundColor Green
    Write-Host '  (Started from your Startup folder - no administrator needed.)' -ForegroundColor DarkGray
  } catch {
    # Setup has already paired and synced, so this is a warning, not a failure.
    Write-Host '  Could not set Munim to start automatically.' -ForegroundColor Yellow
    Write-Host '  Your data is synced. To keep it live, run this file again' -ForegroundColor Yellow
    Write-Host '  as administrator, or leave a window open with:' -ForegroundColor Yellow
    Write-Host "      powershell -ExecutionPolicy Bypass -File `"$script`" watch" -ForegroundColor DarkGray
    return
  }

  # Start it now, so the customer does not have to log out and back in.
  try {
    Start-Process powershell.exe -ArgumentList $psArgs -WindowStyle Hidden | Out-Null
  } catch { }
}

function Uninstall-Task {
  # Remove every way it starts, since any of them could have been used.
  Unregister-ScheduledTask -TaskName $script:TaskName -Confirm:$false -ErrorAction SilentlyContinue
  $cmdPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'Munim.cmd'
  Remove-Item $cmdPath -Force -ErrorAction SilentlyContinue
  Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' `
    -Name 'Munim' -ErrorAction SilentlyContinue
  Get-Process powershell -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*Munim-Connector*watch*' } |
    Stop-Process -Force -ErrorAction SilentlyContinue

  Write-Host '  Munim will no longer start automatically. Your data is untouched.' -ForegroundColor Cyan
}

function Show-Status($cfg) {
  Write-Host ''
  if ($cfg.deviceToken) {
    Write-Host "  Connected to : $($cfg.orgName)" -ForegroundColor Green
  } else {
    Write-Host '  Not paired yet. Run:  .\Munim-Connector.ps1 pair' -ForegroundColor Yellow
  }
  # The question a customer actually asks is "is my data getting through?"
  $waiting = Get-OutboxCount
  if ($waiting -gt 0) {
    Write-Host "  Status       : OFFLINE - $waiting batch(es) waiting to send" -ForegroundColor Yellow
    Write-Host '                 Nothing is lost. They go as soon as the connection returns.' -ForegroundColor DarkGray
  } else {
    Write-Host '  Status       : up to date' -ForegroundColor Green
  }
  Write-Host "  Tally        : $($cfg.tallyUrl)"
  Write-Host "  Cloud        : $($cfg.cloudUrl)"
  Write-Host "  Data folder  : $($script:DataDir)"
  $task = Get-ScheduledTask -TaskName $script:TaskName -ErrorAction SilentlyContinue
  Write-Host "  Background   : $(if ($task) { 'installed (every 5 min)' } else { 'not installed' })"
  Write-Host ''
  Show-Checks (Test-Prerequisites $cfg)
}

# ------------------------------------------------------------------ main ----

$cfg = Get-Config

switch ($Command) {
  'check' { Invoke-Check $cfg }
  'status' { Show-Status $cfg }
  'companies' {
    $list = @(Get-TallyCompanies $cfg)
    if ($list.Count -eq 0) { Write-Host '  No company is open in Tally.'; break }
    $list | Format-Table Name, Guid, FyStart -AutoSize
  }
  'pair' {
    Show-Checks (Test-Prerequisites $cfg)
    if (Invoke-Pair $cfg) {
      $cfg = Get-Config
      $named = Register-Companies $cfg
      Write-Host "  Syncing $($named.Count) book(s): $(($named | ForEach-Object { $_.Name }) -join ', ')"
      Invoke-Sync $cfg
    }
  }
  <#
    The whole install, in one command.

    This is what the downloaded installer runs, and what a shop owner gets from
    double-clicking a file: check the machine, connect to their account, find
    their books, pull them once so the app is not empty, then keep it running
    after every restart. Anything that needs a second step here is a step that
    loses people.
  #>
  'setup' {
    $results = Test-Prerequisites $cfg
    Show-Checks $results
    if ($results | Where-Object { -not $_.Ok }) {
      Write-Host ''
      Write-Host '  Fix the item(s) marked FAIL above, then run this file again.' -ForegroundColor Yellow
      Write-Host '  Press Enter to close.' -ForegroundColor DarkGray
      if ($Host.UI.RawUI) { [void](Read-Host) }
      break
    }

    <#
      A device token from a previous account is worse than none.

      The machine may have been set up for a business that has since been
      deleted, or moved to a different Munim account. The stored token then
      looks valid to this script and is rejected by the server on every sync,
      which reads as "syncing is broken" rather than "this needs pairing again".

      One cheap check settles it, and re-pairing is the fix.
    #>
    if ($cfg.deviceToken) {
      try {
        Invoke-Cloud $cfg '/v1/connectors' 'GET' $null $cfg.deviceToken | Out-Null
      } catch {
        Write-Host '  This computer was linked to an account that no longer exists.' -ForegroundColor Yellow
        Write-Host '  Setting it up again.' -ForegroundColor Yellow
        $cfg.deviceToken = ''
        $cfg.connectorId = ''
        $cfg.orgName     = ''
        $cfg.licenceId   = ''
        Save-Config $cfg
      }
    }

    if (-not (Invoke-Licence $cfg)) {
      Write-Host ''
      Write-Host '  Setup stopped. Press Enter to close.' -ForegroundColor DarkGray
      if ($Host.UI.RawUI) { [void](Read-Host) }
      break
    }
    $cfg = Get-Config

    if (-not $cfg.deviceToken) {
      if (-not (Invoke-Pair $cfg)) {
        Write-Host '  Press Enter to close.' -ForegroundColor DarkGray
        if ($Host.UI.RawUI) { [void](Read-Host) }
        break
      }
      $cfg = Get-Config
    } else {
      Write-Host "  Already connected to $($cfg.orgName)." -ForegroundColor Green
    }

    $named = @(Register-Companies $cfg)
    Write-Host "  Syncing $($named.Count) book(s): $(($named | ForEach-Object { $_.Name }) -join ', ')"
    Invoke-Sync $cfg
    Install-Task

    Write-Host ''
    Write-Host '  Done. Your Tally data is now in Munim, and stays up to date.' -ForegroundColor Green
    Write-Host '  You can close this window - Munim keeps running in the background.' -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '  Press Enter to close.' -ForegroundColor DarkGray
    if ($Host.UI.RawUI) { [void](Read-Host) }
  }
  'sync' { Invoke-Sync $cfg 'manual' }

  <#
    Prove Tally and Munim hold the same records, and remove any that Tally no
    longer has. Safe to run at any time: it deletes only what Tally itself has
    dropped, and only when the whole book was read successfully.
  #>
  'reconcile' {
    foreach ($co in (Register-Companies $cfg)) {
      Write-Host "  $($co.Name)" -ForegroundColor Cyan
      Write-Host "    $(Invoke-Reconcile $cfg $co)"
    }
  }

  # Send the log up so support can read it without asking for a file.
  'logs' {
    Write-Host "  $(Send-Logs $cfg)" -ForegroundColor Cyan
  }

  # The tail of the local log, for someone standing at the shop's PC.
  'history' {
    if (Test-Path $script:LogFile) {
      Get-Content $script:LogFile -Tail 40
    } else {
      Write-Host '  Nothing logged yet.' -ForegroundColor Yellow
    }
  }
  'watch' {
    <#
      Nothing gets out of here.

      `watch` is started by a scheduled task with no window and nobody watching
      it. An exception that escapes ends the process silently, and the customer
      finds out weeks later that their figures stopped moving. Whatever happens,
      it is written down - and then we exit so the task or the watchdog starts a
      clean one.
    #>
    try {
      Invoke-Watch $cfg
    } catch {
      Write-Log "watch ended unexpectedly: $($_.Exception.Message)"
      Write-Log $_.ScriptStackTrace
      # Non-zero, so the scheduled task's restart rule treats it as a failure
      # rather than a job that finished its work.
      exit 1
    }
  }
  'install' { Install-Task }
  'uninstall' { Uninstall-Task }
  'reset' {
    Remove-Item $script:CursorPath -ErrorAction SilentlyContinue
    Write-Host '  Cursors cleared. The next sync will read everything again.'
  }
}
