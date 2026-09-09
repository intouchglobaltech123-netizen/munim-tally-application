const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/**
 * The connector script, checked without running Windows.
 *
 * PowerShell has no compile step, so a call to a function that does not exist
 * is a runtime error on a shop computer at 9am - discovered by the customer,
 * not by us. That is not hypothetical: the voucher outbox shipped calling
 * `Invoke-Api`, which was never a function in this file, and every write would
 * have failed with "term is not recognized".
 *
 * These are cheap structural checks. They cannot prove the script works, but
 * they catch the mistakes that are invisible until it runs.
 */

const SCRIPT = path.join(__dirname, '..', '..', '..', 'connector-ps', 'Munim-Connector.ps1');
const src = fs.readFileSync(SCRIPT, 'utf8');

/** Every function this script defines. */
function defined() {
  const out = new Set();
  const re = /^\s*function\s+([A-Za-z][\w-]*)/gm;
  let m;
  while ((m = re.exec(src))) out.add(m[1].toLowerCase());
  return out;
}

/*
 * Code with the string literals taken out.
 *
 * Without this, an HTTP header called "Idempotency-Key" and any XML inside a
 * here-string read as commands. Blanking them - rather than deleting them -
 * keeps every line number intact, so a failure still points at the right line.
 */
const codeOnly = (() => {
  let out = src;
  const blank = (text) => text.replace(/[^\n]/g, ' ');
  // Here-strings first: they contain the Tally XML, and their contents are
  // never code.
  out = out.replace(/@"[\s\S]*?"@/g, blank);
  out = out.replace(/@'[\s\S]*?'@/g, blank);
  out = out.replace(/"(?:[^"`\n]|`.)*"/g, blank);
  out = out.replace(/'(?:[^'\n]|'')*'/g, blank);
  /*
   * Comments too - a sentence like "the Get-Foo helper" is prose, not a call.
   *
   * Block comments BEFORE line comments: the line-comment pattern would
   * otherwise consume the `#` of an opening `<#`, leaving the block unmatched
   * and its prose read as code.
   */
  out = out.replace(/<#[\s\S]*?#>/g, blank);
  out = out.replace(/#[^\n]*/g, blank);
  return out;
})();

/**
 * Every Verb-Noun call in the script.
 *
 * Matched on PowerShell's own naming convention, which is what makes this
 * tractable: a token like `Invoke-Outbox` at the head of a statement or inside
 * a subexpression is a command, and anything hyphenated that is not a cmdlet
 * we know about must be ours.
 */
function called() {
  const out = new Map();
  const re = /(^|[\s(|{=&$])([A-Z][a-z]+)-([A-Z][\w]*)/g;
  let m;
  while ((m = re.exec(codeOnly))) {
    const name = `${m[2]}-${m[3]}`;
    const line = codeOnly.slice(0, m.index).split('\n').length;
    if (!out.has(name)) out.set(name, line);
  }
  return out;
}

/*
 * Built-in cmdlets this script legitimately uses. Anything hyphenated that is
 * neither here nor defined in the file is a typo or a function that was
 * renamed and left behind.
 */
const BUILTIN = new Set([
  'write-host', 'write-log', 'write-error', 'write-warning', 'write-output',
  'invoke-webrequest', 'invoke-restmethod', 'invoke-expression', 'invoke-command',
  'start-sleep', 'start-process', 'get-date', 'get-content', 'set-content',
  'add-content', 'out-file', 'out-null', 'out-string', 'test-path', 'new-item',
  'remove-item', 'copy-item', 'move-item', 'join-path', 'split-path',
  'new-object', 'select-object', 'where-object', 'foreach-object', 'sort-object',
  'measure-object', 'group-object', 'compare-object',
  'convertto-json', 'convertfrom-json', 'convertto-securestring',
  'new-timespan', 'get-random', 'get-process', 'stop-process', 'start-service',
  'get-service', 'set-service', 'new-service',
  'register-scheduledtask', 'unregister-scheduledtask', 'get-scheduledtask',
  'new-scheduledtaskaction', 'new-scheduledtasktrigger', 'new-scheduledtasksettingsset',
  'set-scheduledtask', 'start-scheduledtask',
  'get-wmiobject', 'get-ciminstance', 'get-itemproperty', 'set-itemproperty',
  'new-itemproperty', 'remove-itemproperty', 'get-childitem',
  'add-type', 'set-executionpolicy', 'get-credential', 'read-host',
  'export-clixml', 'import-clixml', 'get-command', 'get-module', 'import-module',
  'set-location', 'get-location', 'resolve-path', 'test-connection',
  'get-netadapter', 'get-eventlog', 'get-winevent', 'clear-host',
  'set-strictmode', 'new-guid', 'get-host', 'start-job', 'receive-job',
  'wait-job', 'remove-job', 'get-job', 'set-alias', 'get-variable',
  'set-variable', 'remove-variable', 'get-member', 'select-string',
  'format-list', 'format-table', 'tee-object', 'write-verbose', 'write-debug',
  'write-progress', 'get-filehash', 'unblock-file', 'expand-archive',
  'compress-archive', 'get-acl', 'set-acl', 'enable-scheduledtask',
  'get-item', 'add-member', 'new-alias', 'get-help', 'set-psdebug',
  'get-cimclass', 'new-ciminstance', 'set-ciminstance', 'invoke-cimmethod',
]);

test('every function the script calls is one it defines', () => {
  /*
   * The check that would have caught `Invoke-Api` before it shipped.
   */
  const have = defined();
  const missing = [];

  for (const [name, line] of called()) {
    const lower = name.toLowerCase();
    if (have.has(lower) || BUILTIN.has(lower)) continue;
    missing.push(`${name} (line ${line})`);
  }

  assert.deepEqual(missing, [],
    'these look like calls to functions that do not exist:\n  ' + missing.join('\n  '));
});

/**
 * The real parser, when there is one.
 *
 * Everything else in this file is a structural approximation. PowerShell's own
 * parser is the only thing that actually decides whether this script runs, and
 * on a machine that can reach powershell.exe there is no reason to guess.
 *
 * Skipped rather than failed where PowerShell is absent - a Linux CI box should
 * not fail a build over a Windows binary it was never going to have.
 */
test('the script parses under PowerShell itself', (t) => {
  const { execFileSync } = require('child_process');
  const ps = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  if (!fs.existsSync(ps)) return t.skip('PowerShell is not reachable from here');

  // The script lives on the Windows filesystem; hand the parser a Windows path.
  const winPath = SCRIPT.replace(/^\/mnt\/([a-z])\//, (_, d) => `${d.toUpperCase()}:\\`)
    .replace(/\//g, '\\');

  const out = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', `
    $tokens = $null; $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile(
      '${winPath}', [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors -and $errors.Count -gt 0) {
      $errors | Select-Object -First 5 | ForEach-Object {
        Write-Output ("line {0}: {1}" -f $_.Extent.StartLineNumber, $_.Message)
      }
    } else { Write-Output 'OK' }
  `], { encoding: 'utf8', timeout: 120000 }).trim();

  assert.equal(out, 'OK', `PowerShell could not parse the connector:\n${out}`);
});

/**
 * The file the customer actually runs, parsed the way it is actually run.
 *
 * Two differences from the test above, and both of them shipped a broken
 * installer once.
 *
 * It parses the PERSONALISED script, not the template. The customer never
 * sees the template.
 *
 * And it parses it as a STRING, not as a file. The .bat does
 * `iwr -useb <url> | iex`, so PowerShell is handed text, not a path. That
 * matters because a UTF-8 byte order mark is an encoding marker in a file and
 * PowerShell skips it - but in a string it is just U+FEFF sitting in front of
 * [CmdletBinding()], and the parser rejects everything after it. Writing the
 * script to a file and parsing the file reports PARSE OK for content that
 * cannot run. Which is what happened.
 */
test('the personalised script parses the way iex will run it', (t) => {
  const { execFileSync } = require('child_process');
  const ps = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  if (!fs.existsSync(ps)) return t.skip('PowerShell is not reachable from here');

  const installer = require('../src/routes/installer');
  const personalised = installer.personalise(
    src, 'https://api.example.com', 'int_TESTCODE1234', 'Verma Traders');

  // A byte order mark anywhere is the failure this test exists for: iex is
  // given a string, and there is no such thing as a marker in a string.
  assert.ok(!personalised.includes('\uFEFF'),
    'the served script must carry no byte order mark - iex cannot skip one');

  assert.ok(personalised.includes("$Cloud = 'https://api.example.com'"));
  assert.ok(personalised.includes("$Code = 'int_TESTCODE1234'"));
  assert.ok(personalised.includes("$Command = 'setup'"),
    'running the file with no arguments has to install, not just report');

  /*
   * Handed over as base64 in a file, then decoded back to a string.
   *
   * Not passed on the command line - 90kB does not fit, spawn fails with
   * E2BIG. Not read with Get-Content either, because that reads a FILE and
   * would skip a byte order mark, which is the very thing being tested. Base64
   * round-trips the exact characters iex would receive.
   */
  const tmp = path.join(path.dirname(SCRIPT), '.iex-parse-test.b64');
  fs.writeFileSync(tmp, Buffer.from(personalised, 'utf8').toString('base64'), 'ascii');
  let out;
  try {
    const winTmp = tmp.replace(/^\/mnt\/([a-z])\//, (_, d) => `${d.toUpperCase()}:\\`)
      .replace(/\//g, '\\');
    out = execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', `
      $b64 = [System.IO.File]::ReadAllText('${winTmp}')
      $text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($b64))
      $tokens = $null; $errors = $null
      [System.Management.Automation.Language.Parser]::ParseInput(
        $text, [ref]$tokens, [ref]$errors) | Out-Null
      if ($errors -and $errors.Count -gt 0) {
        $errors | Select-Object -First 5 | ForEach-Object {
          Write-Output ("line {0}: {1}" -f $_.Extent.StartLineNumber, $_.Message)
        }
      } else { Write-Output 'OK' }
    `], { encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024 }).trim();
  } finally {
    fs.rmSync(tmp, { force: true });
  }

  assert.equal(out, 'OK',
    `PowerShell could not parse what iex is handed:\n${out}`);
});

test('the script is brace-balanced', () => {
  // A stray brace turns the rest of the file into part of the previous
  // function, and PowerShell reports it from somewhere unrelated.
  const opens = (src.match(/\{/g) || []).length;
  const closes = (src.match(/\}/g) || []).length;
  assert.equal(opens, closes, `${opens} open braces against ${closes} closing`);
});

test('every function the script defines is reachable', () => {
  /*
   * Dead code in a script nobody can step through is where stale assumptions
   * live. A function defined and never called is usually one that was replaced
   * and forgotten.
   */
  const calls = new Set([...called().keys()].map((n) => n.toLowerCase()));
  const orphans = [];
  for (const fn of defined()) {
    // Count a definition as reachable if the name appears anywhere other than
    // its own definition line.
    const uses = (src.match(new RegExp(`\\b${fn}\\b`, 'gi')) || []).length;
    if (uses <= 1 && !calls.has(fn)) orphans.push(fn);
  }
  assert.deepEqual(orphans, [], `defined but never called: ${orphans.join(', ')}`);
});

test('the write path posts through the same helper as everything else', () => {
  /*
   * The outbox must use Invoke-Cloud with the device token, like every other
   * call. A bespoke Invoke-RestMethod there would miss the timeout, the error
   * unwrapping and the auth header.
   */
  const outbox = src.slice(src.indexOf('function Invoke-Outbox'));
  assert.match(outbox, /Invoke-Cloud \$cfg '\/v1\/connector\/outbox' 'GET' \$null \$cfg\.deviceToken/);
});

test('a voucher is only ever created in Tally, never altered', () => {
  /*
   * Munim does not own anything already in the customer's books. An import
   * with ACTION="Alter" would silently rewrite a voucher somebody else entered.
   */
  const xml = src.slice(src.indexOf('function New-VoucherImportXml'),
                        src.indexOf('function Send-VoucherResult'));
  assert.match(xml, /ACTION="Create"/);
  assert.ok(!/ACTION="Alter"/i.test(xml), 'the importer can alter existing vouchers');
  assert.ok(!/ACTION="Delete"/i.test(xml), 'the importer can delete vouchers');
});

test('the import carries the id that makes a retry safe', () => {
  const xml = src.slice(src.indexOf('function New-VoucherImportXml'),
                        src.indexOf('function Send-VoucherResult'));
  assert.match(xml, /<REMOTEID>/,
    'without a REMOTEID a dropped connection means a duplicate invoice');
});

test('the outbox checks Tally before posting', () => {
  // The other half of idempotency: ask whether it is already there.
  const outbox = src.slice(src.indexOf('function Invoke-Outbox'),
                           src.indexOf('function Invoke-Commands'));
  const check = outbox.indexOf('Get-VoucherByRemoteId');
  const post = outbox.indexOf('New-VoucherImportXml');
  assert.ok(check >= 0 && post >= 0, 'both steps are present');
  assert.ok(check < post, 'the duplicate check must come before the import');
});

// --- surviving a laptop being shut and reopened -----------------------------

test('the scheduled task covers all four ways a shop PC comes back', () => {
  /*
   * Each of these catches a case the others miss:
   *   AtLogOn    - somebody signs in each morning
   *   AtStartup  - the machine rebooted after a power cut and sits at the
   *                login screen until somebody arrives
   *   resume     - a laptop lid opened, which is neither a boot nor a logon
   *   repeating  - the safety net if the watcher died for any other reason
   */
  const install = src.slice(src.indexOf('$triggers = @('));
  assert.match(install, /New-ScheduledTaskTrigger -AtLogOn/);
  assert.match(install, /New-ScheduledTaskTrigger -AtStartup/);
  assert.match(install, /Power-Troubleshooter/,
    'nothing fires when a laptop wakes from sleep');
  assert.match(install, /-RepetitionInterval/);
});

test('the task survives a laptop on battery', () => {
  // Task Scheduler refuses to start tasks on battery by default, which is
  // every laptop in every shop.
  assert.match(src, /-AllowStartIfOnBatteries/);
  assert.match(src, /-DontStopIfGoingOnBatteries/);
  // And a missed run while asleep must be made up, not skipped.
  assert.match(src, /-StartWhenAvailable/);
});

test('the loop notices it was suspended and throws away its connections', () => {
  /*
   * Start-Sleep is suspended along with the process, so a five-second wait can
   * return eight hours later. The sockets in the pool are dead by then, and the
   * first requests hang instead of failing fast - which is the "it only worked
   * after I restarted it" report.
   */
  const watch = src.slice(src.indexOf('function Invoke-Watch'));
  assert.match(watch, /resumed after/i);
  assert.match(watch, /MaxServicePointIdleTime/,
    'pooled connections are not reset after a resume');
  assert.match(watch, /\$script:TallyEdition = ''/,
    'Tally is not re-checked after a resume');
});

test('a wedged watcher can be replaced, not just detected', () => {
  /*
   * The mutex alone had a hole: a process can hold it and be stuck on a socket
   * that never returns. It is alive, so MultipleInstances=IgnoreNew turns every
   * retry away and the shop silently stops syncing while looking healthy.
   */
  const watch = src.slice(src.indexOf('function Invoke-Watch'));
  assert.match(watch, /watch\.alive/, 'no proof-of-life file');
  assert.match(watch, /Stop-Process/, 'a stuck holder is never displaced');
  assert.match(watch, /Munim-Connector/,
    'the takeover must only ever kill this script, never any PowerShell');
});

test('the takeover never kills the process doing the killing', () => {
  // Without the $PID guard the new copy stops itself and the shop is left with
  // nothing running at all - strictly worse than the stuck process.
  const watch = src.slice(src.indexOf('function Invoke-Watch'));
  const takeover = watch.slice(watch.indexOf('taking over from a stuck watcher'));
  assert.match(takeover, /\$me = \$PID/);
  assert.match(takeover, /ProcessId -ne \$me/);
});

test('proof of life is written by work, not by existing', () => {
  // Touched inside the loop body, so it only stays fresh while passes complete.
  const watch = src.slice(src.indexOf('function Invoke-Watch'));
  const loop = watch.slice(watch.indexOf('while ($true)'));
  assert.match(loop, /Set-Content -Path \$aliveFile/);
});
