#!/usr/bin/env node
'use strict';
/**
 * Answers one question: is Google sign-in actually working end to end?
 *
 * Each check names the exact fix, because "it doesn't work" is the least
 * useful thing a setup script can tell you.
 */
const API = process.env.MUNIM_API || 'http://localhost:8080';

const ok   = (m) => console.log(`  \x1b[32m[ OK ]\x1b[0m  ${m}`);
const bad  = (m, fix) => {
  console.log(`  \x1b[31m[FAIL]\x1b[0m  ${m}`);
  if (fix) console.log(`          \x1b[33m->\x1b[0m ${fix}`);
};

(async () => {
  console.log('');

  let cfg;
  try {
    const res = await fetch(`${API}/v1/auth/config`);
    cfg = await res.json();
    ok(`API is running at ${API}`);
  } catch {
    bad('API is not running', 'Open a terminal and run:  npm run api');
    process.exit(1);
  }

  if (!cfg.google) {
    bad('No Google client id configured',
      'Put GOOGLE_CLIENT_IDS=<your-client-id> in apps/api/.env, then restart the API');
    console.log('');
    process.exit(1);
  }
  ok(`Google client id is set (${cfg.google.clientId.slice(0, 24)}…)`);

  if (!/\.apps\.googleusercontent\.com$/.test(cfg.google.clientId)) {
    bad('That does not look like a Google client id',
      'It must end in .apps.googleusercontent.com - copy it again from the console');
    process.exit(1);
  }
  ok('Client id has the right shape');

  if (cfg.provider !== 'google') {
    bad(`Server is still offering "${cfg.provider}"`,
      'Restart the API so it re-reads .env:  npm run api:stop  then  npm run api');
    process.exit(1);
  }
  ok('Server is offering Google sign-in');

  // A forged token must be refused. If this passes, verification is live -
  // which is the part that actually protects the books.
  const res = await fetch(`${API}/v1/auth/google`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken: 'forged.token.here' }),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401 && body?.error?.code === 'INVALID_GOOGLE_TOKEN') {
    ok('Forged tokens are rejected - verification is live');
  } else {
    bad(`Expected 401 INVALID_GOOGLE_TOKEN, got ${res.status}`, 'Tell Claude what this said');
    process.exit(1);
  }

  console.log('\n  \x1b[32mReady.\x1b[0m  Run  npm run web  and open http://localhost:3000\n');
})();
