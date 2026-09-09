'use strict';
const fs = require('fs');
const path = require('path');
const { query } = require('../db');
const auth = require('../lib/auth');
const features = require('../lib/features');
const quotas = require('../lib/quotas');
const { bad } = require('../lib/http');

/**
 * Getting the connector onto a customer's Tally computer.
 *
 * The problem this solves: a shop owner is not going to download a file, open
 * PowerShell, work out a path, and type a pairing code correctly. Every one of
 * those steps loses people, and the pairing code is the worst - it is read off
 * one screen and typed into another, and getting it wrong looks identical to
 * the product being broken.
 *
 * So the installer they download already knows who they are. The server takes
 * the connector script, pins the cloud URL and a fresh pairing code into it,
 * and hands it back. Running it is the whole install.
 *
 * The code inside is short-lived and single-use, which is what makes it safe to
 * put in a file somebody might email to themselves.
 */

const SCRIPT = path.join(__dirname, '..', '..', '..', '..', 'connector-ps', 'Munim-Connector.ps1');


/** The connector script as shipped, before it is personalised. */
function readTemplate() {
  try {
    return fs.readFileSync(SCRIPT, 'utf8');
  } catch {
    throw bad('INSTALLER_UNAVAILABLE', 'The installer is not available on this server.');
  }
}

/**
 * Pins one customer's server and pairing code into the script.
 *
 * By rewriting the parameter defaults, never by prepending lines: PowerShell
 * requires param() to be the first statement in a file, so anything written
 * above it stops the whole script parsing and the customer sees a wall of red
 * before anything runs.
 */
function personalise(script, cloud, code, orgName) {
  const q = (v) => `'${String(v).replace(/'/g, "''")}'`;   // PowerShell escaping

  /*
   * Strip the byte order mark before anything is put in front of it.
   *
   * The template is saved UTF-8 with a BOM, which is correct and which
   * PowerShell wants at the very start of a file. Prepending the header pushed
   * it into the middle, where it is no longer a BOM but a stray zero-width
   * character sitting between a comment and <#. PowerShell then refuses the
   * whole file - "Unexpected token 'param'" - and since this script is piped
   * straight into iex by the customer's .bat, the failure lands on their
   * screen during setup rather than anywhere we would see it.
   */
  const body = script.replace(/^\uFEFF/, '');

  const out = body
    .replace('[string]$Cloud,', `[string]$Cloud = ${q(cloud)},`)
    .replace('[string]$Code,', `[string]$Code = ${q(code)},`)
    // Run with no arguments and the customer wants the whole install, not a
    // status check.
    .replace("[string]$Command = 'check',", "[string]$Command = 'setup',");

  const header = [
    '# ---------------------------------------------------------------',
    `#  Munim connector - prepared for ${String(orgName).replace(/[\r\n]/g, ' ')}`,
    `#  Generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    '#',
    '#  This file is personal to your account. Do not share it.',
    '# ---------------------------------------------------------------',
    '',
  ].join('\n');

  if (out === body) {
    throw bad('INSTALLER_UNAVAILABLE',
      'The installer template has changed and could not be personalised.');
  }

  // Comments above param() are fine; only statements are not. The BOM goes
  // back at the very front, where PowerShell expects it.
  return '\uFEFF' + header + out;
}

/** Where the connector should send data - what the customer's browser reached. */
function cloudUrlFor(ctx) {
  if (process.env.PUBLIC_API_URL) return process.env.PUBLIC_API_URL.replace(/\/$/, '');
  const host = ctx.headers?.host;
  if (!host) return 'http://localhost:8080';
  // Behind a proxy the original scheme is only in the header.
  const proto = ctx.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${host}`;
}

/**
 * Builds a one-off installer for the signed-in customer.
 *
 * Returns the script as a download. Every copy is different: it carries its own
 * pairing code, so two customers can never end up sharing a connector, and a
 * file that leaks is worthless within minutes.
 */
async function download(ctx) {
  const s = auth.requireUser(ctx);
  if (!s.org.name || !s.org.name.trim()) {
    throw bad('NOT_ONBOARDED', 'Name your business before connecting Tally.');
  }

  /*
   * The plan limits how many computers actually sync - not how many times the
   * setup file was downloaded.
   *
   * Counting pending rows locked customers out of their own plan: download the
   * file twice and the second attempt was refused with "your plan allows 1
   * computers", while nothing was connected at all. A connector only occupies a
   * slot once it has paired.
   */
  const { rows: live } = await query(
    `SELECT count(*)::int AS n FROM connectors
      WHERE org_id = $1 AND revoked_at IS NULL AND status <> 'pending'`,
    [s.org.id]);
  // Through quotas rather than features, so the plan table is the single place
  // a ceiling is decided. limitFor still honours the older max_connectors
  // column, so customers whose limit was raised by hand keep it.
  const { rows: orgRow } = await query('SELECT * FROM orgs WHERE id = $1', [s.org.id]);
  quotas.assertWithin(orgRow[0], 'connectors', live[0].n);

  /*
   * Reuse the customer's own unfinished setup rather than minting a new one.
   *
   * People download the file more than once - they lose it, they email it to
   * themselves, they click twice. Every download used to create a fresh pairing
   * code AND a fresh connector row, so a customer who downloaded three times
   * had three half-built connectors, and only one file that still worked.
   *
   * One live setup per customer at a time: download as often as you like, and
   * every copy is the same valid one until it is used.
   */
  const { rows: existing } = await query(
    `SELECT i.code
       FROM pair_intents i
       JOIN connectors c ON c.id = i.connector_id
      WHERE i.org_id = $1
        AND i.expires_at > now() + interval '5 minutes'
        AND c.status = 'pending'
        AND c.revoked_at IS NULL
      ORDER BY i.created_at DESC LIMIT 1`,
    [s.org.id],
  );

  if (existing.length) {
    return buildInstaller(ctx, s, existing[0].code);
  }

  const crypto = require('crypto');
  const code = 'int_' + crypto.randomBytes(9).toString('base64url');

  // Pre-approved: the person downloading is already signed in, so asking them
  // to approve their own download on their own phone is ceremony, not security.
  const deviceToken = auth.newToken('dev');
  const { rows: conn } = await query(
    `INSERT INTO connectors (org_id, machine_name, status, token_hash)
     VALUES ($1, 'Tally computer', 'pending', $2) RETURNING id`,
    [s.org.id, auth.hash(deviceToken)],
  );
  await query(
    `INSERT INTO pair_intents
       (code, org_id, approved_by, connector_id, device_token_once, approved_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, now(), now() + interval '60 minutes')`,
    [code, s.org.id, s.user.id, conn[0].id, deviceToken],
  );

  let script;
  try {
    script = fs.readFileSync(SCRIPT, 'utf8');
  } catch {
    throw bad('INSTALLER_UNAVAILABLE', 'The installer is not available on this server.');
  }

  return buildInstaller(ctx, s, code);
}

/** The .bat itself, shared by a fresh setup and a repeat download. */
function buildInstaller(ctx, s, code) {
  const cloud = cloudUrlFor(ctx);

  /*
   * What the customer downloads is a .bat, not the PowerShell script.
   *
   * A shop owner double-clicks files. They do not right-click and choose "Run
   * with PowerShell" - and on many machines .ps1 is not even associated with
   * anything, so a double-click opens Notepad and the install is over before it
   * started. Windows runs .bat on a double-click, always, with no association
   * and no execution-policy prompt.
   *
   * The .bat does one thing: fetch this customer's personalised script and run
   * it. That keeps the file tiny, and means a fix to the connector reaches
   * customers without them downloading anything again.
   */
  const url = `${cloud}/install/${code}`;
  const safeOrg = s.org.name.replace(/[\r\n"%<>|&^]/g, ' ').slice(0, 40);

  const bat = [
    '@echo off',
    'setlocal',
    'title Munim - connect this computer to your account',
    'color 0A',
    'echo.',
    'echo   ============================================',
    `echo    Munim setup for ${safeOrg}`,
    'echo   ============================================',
    'echo.',
    'echo   This connects Tally on this computer to your',
    'echo   Munim account. It only reads your data.',
    'echo.',
    'echo   Keep Tally open while this runs.',
    'echo.',
    'pause',
    '',
    ':: Bypass applies to this one process only - nothing on the machine is',
    ':: changed, and Windows never prompts.',
    ':: The catch shows the REAL error. An earlier version blamed the internet',
    ':: for everything, which sent people to fix the wrong thing.',
    'powershell -NoProfile -ExecutionPolicy Bypass -Command ' +
      `"try { iwr -useb '${url}' | iex } catch { ` +
      'Write-Host \'\'; ' +
      'Write-Host \'  Setup could not finish.\' -ForegroundColor Red; ' +
      'Write-Host \'\'; ' +
      'Write-Host (\'  \' + $_.Exception.Message) -ForegroundColor Yellow; ' +
      'Write-Host \'\'; ' +
      'Write-Host \'  If this mentions the network, check this computer is online.\' -ForegroundColor DarkGray; ' +
      'Write-Host \'  If it mentions permission, right-click this file and\' -ForegroundColor DarkGray; ' +
      'Write-Host \'  choose Run as administrator.\' -ForegroundColor DarkGray; ' +
      'Write-Host \'\'; ' +
      'Read-Host \'  Press Enter to close\' }"',
    '',
    'endlocal',
    '',
  ].join('\r\n');   // CRLF: a .bat with Unix line endings misbehaves on Windows

  const filename = `Munim-Setup-${s.org.name.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 24)}.bat`;

  return {
    _raw: {
      body: bat,
      contentType: 'application/octet-stream',
      headers: { 'Content-Disposition': `attachment; filename="${filename}"` },
    },
  };
}

/**
 * The one-line install, for customers who can paste a command.
 *
 *   iwr -useb <url> | iex
 *
 * Unauthenticated on purpose: the code in the URL is the credential, it is
 * short-lived, and it is worthless once used.
 */
async function oneLiner(ctx) {
  const s = auth.requireUser(ctx);
  const cloud = cloudUrlFor(ctx);
  const { rows } = await query(
    `SELECT code FROM pair_intents
      WHERE org_id = $1 AND approved_at IS NOT NULL AND expires_at > now()
      ORDER BY created_at DESC LIMIT 1`,
    [s.org.id],
  );
  return {
    cloud,
    command: rows.length
      ? `iwr -useb ${cloud}/install/${rows[0].code} | iex`
      : null,
  };
}

/**
 * Serves the personalised script to the .bat the customer double-clicked.
 *
 * Unauthenticated on purpose: the code in the URL *is* the credential. It is
 * single-use, expires within the hour, and is worthless afterwards - which is
 * exactly what lets a shop owner run one file with no sign-in on that machine.
 */
async function publicScript(ctx, code) {
  const { rows } = await query(
    `SELECT i.code, o.name AS org_name
       FROM pair_intents i JOIN orgs o ON o.id = i.org_id
      WHERE i.code = $1 AND i.expires_at > now()`,
    [code],
  );
  if (!rows.length) {
    // Plain text, not JSON: this response is piped straight into PowerShell,
    // so an error has to be something a person can read in the console.
    return {
      _raw: {
        body: 'Write-Host "\n  This setup link has expired.\n  '
          + 'Open Munim on your phone or computer and download it again.\n" '
          + '-ForegroundColor Yellow\nRead-Host "Press Enter to close"\n',
        contentType: 'text/plain; charset=utf-8',
      },
    };
  }

  return {
    _raw: {
      body: personalise(readTemplate(), cloudUrlFor(ctx), code, rows[0].org_name),
      contentType: 'text/plain; charset=utf-8',
    },
  };
}

module.exports = { download, oneLiner, publicScript, cloudUrlFor, personalise };
