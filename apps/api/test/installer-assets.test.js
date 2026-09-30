const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

/**
 * The installer has to be inside the thing that serves it.
 *
 * apps/api is deployed on its own: the service builds from that directory and
 * nothing above it is in the container. A path that reaches up into the
 * repository resolves perfectly on a developer's machine and cannot resolve in
 * production, so the download failed with "the installer is not available on
 * this server" while every test on this machine passed.
 *
 * These tests fail on the machine where it can be fixed.
 */

const API = path.join(__dirname, '..');
const SHIPPED = path.join(API, 'assets', 'Munim-Connector.ps1');
const SOURCE = path.join(API, '..', '..', 'connector-ps', 'Munim-Connector.ps1');

test('the connector script ships inside apps/api', () => {
  assert.ok(fs.existsSync(SHIPPED),
    `${SHIPPED} is missing. It must live under apps/api or it is not deployed.`);
});

test('the shipped copy matches the one people edit', () => {
  // Two copies of a 90kB script is a drift problem waiting to happen. This is
  // what makes editing connector-ps/ and forgetting to copy it a failed test
  // rather than customers downloading a stale connector.
  if (!fs.existsSync(SOURCE)) return;   // published without the repo around it
  assert.equal(
    fs.readFileSync(SHIPPED, 'utf8'),
    fs.readFileSync(SOURCE, 'utf8'),
    'apps/api/assets/Munim-Connector.ps1 differs from connector-ps/Munim-Connector.ps1.\n'
    + 'Copy the edited one over: cp connector-ps/Munim-Connector.ps1 apps/api/assets/',
  );
});

test('the installer resolves a script that is actually there', () => {
  // Exercises the real resolution rather than repeating it: whatever the
  // module settled on has to exist, or every download 500s.
  const installer = require('../src/routes/installer');
  const script = installer.scriptPath();
  assert.ok(fs.existsSync(script), `installer resolved ${script}, which does not exist`);
});

test('the resolved script is the one that gets personalised', () => {
  const installer = require('../src/routes/installer');
  const raw = fs.readFileSync(installer.scriptPath(), 'utf8');
  const out = installer.personalise(raw, 'https://api.example.com', 'int_ABC123', 'A Shop');
  assert.ok(out.includes("$Cloud = 'https://api.example.com'"));
  assert.ok(out.includes("$Code = 'int_ABC123'"));
});

test('nothing above apps/api is required to serve the installer', () => {
  /*
   * The point of the whole exercise. Resolution must succeed with only the
   * contents of apps/api, because that is all production has.
   */
  const inside = path.join(API, 'assets', 'Munim-Connector.ps1');
  assert.ok(inside.startsWith(API + path.sep),
    'the shipped script must be under apps/api');
  assert.ok(fs.existsSync(inside));
});

test('the downloaded file does not pipe remote code into iex', () => {
  /*
   * `iwr | iex` runs code that never lands on disk. That is a download cradle,
   * the pattern antivirus is most confident about, and it blocked the install
   * on real customer machines. The script is fetched to a file, unblocked and
   * run from there, so it can be scanned - and read - like any other program.
   */
  const routeSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'installer.js'), 'utf8');
  const bat = routeSrc.slice(routeSrc.indexOf('function buildInstaller'),
                             routeSrc.indexOf('const filename ='));
  assert.ok(!/\|\s*iex/.test(bat), 'the .bat still pipes the script into iex');
  assert.match(bat, /-OutFile/);
  assert.match(bat, /Unblock-File/);
});

test('there is a download that no antivirus can mistake for a dropper', () => {
  /*
   * K7 quarantined the .bat on a customer's machine: a downloaded .bat that
   * starts PowerShell is the shape of a dropper, and no heuristic can tell
   * ours from a real one. The escape hatch is the script itself, which Windows
   * runs from its own "Run with PowerShell" menu item.
   */
  const routeSrc = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'installer.js'), 'utf8');
  const build = routeSrc.slice(routeSrc.indexOf('function buildInstaller'),
                              routeSrc.indexOf('const bat = ['));
  assert.match(build, /format.*ps1/, 'no plain-script download');
  assert.match(build, /Munim-Connector-\$\{safeName\}\.ps1/,
    'the plain script is not offered as a .ps1 file');
  // It must be the real script, not a second copy that can drift from it.
  assert.match(build, /personalise\(readTemplate\(\)/);
});
