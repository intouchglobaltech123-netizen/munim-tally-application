'use strict';
const crypto = require('crypto');
const { query, tx } = require('../db');
const google = require('../lib/google');
const { HttpError, bad, normalizePhone } = require('../lib/http');
const auth = require('../lib/auth');
const features = require('../lib/features');
const plans = require('../lib/plans');
const security = require('./security');
const perms = require('../lib/permissions');
const audit = require('../lib/audit');

/**
 * A short, human name for the phone that is signing in, so the owner can later
 * recognise it in "Linked devices" and cut off one they no longer hold.
 *
 * Client-supplied and therefore untrusted: it is only ever displayed, never
 * used for a decision, and is trimmed to something a row can hold.
 */
/**
 * Which kind of device this is - "mobile" or "web".
 *
 * Drives the one-session-per-kind rule below. Derived from the label the client
 * sends, so it is a hint rather than a fact; being wrong costs somebody an
 * extra sign-in, never access to anything.
 */
function deviceKind(ctx) {
  const label = String(ctx.headers?.['x-munim-device'] ?? '');
  return /android|iphone|ipad|ios/i.test(label) ? 'mobile' : 'web';
}

function deviceLabel(ctx) {
  const raw = ctx.headers?.['x-munim-device'] || ctx.body?.device;
  if (typeof raw !== 'string') return null;
  const clean = raw.replace(/[^\x20-\x7E]/g, '').trim();
  return clean ? clean.slice(0, 60) : null;
}

/**
 * Turns a proven identity into a Munim session.
 *
 * Both providers land here, deliberately. The account-matching and linking
 * rules are where a mistake hands one person another person's books, so there
 * is exactly one copy of them - a second provider cannot quietly drift.
 *
 * @param {object} id  { uid, phone, email, via } - email must already be
 *                     verified by the provider; the caller drops it otherwise.
 */
async function issueSession(ctx, { uid, phone, email, via }) {

  if (!phone && !email) {
    throw bad('NO_IDENTITY',
      'That sign-in carries no mobile number or verified email address.');
  }

  const kind = deviceKind(ctx);

  const out = await tx(async (c) => {
    const SELECT = `SELECT u.*, o.name AS org_name, o.plan, o.trial_ends_at,
                           o.message_credits
                      FROM users u JOIN orgs o ON o.id = u.org_id`;

    /*
     * Find the account, most trustworthy identifier first.
     *
     * 1. firebase_uid  - the same provider account as last time. Exact.
     *                    (Holds a Firebase uid or a Google sub; they are
     *                    different namespaces, so a person who uses Firebase on
     *                    the web and Google on the phone simply matches on
     *                    email instead, which is the correct outcome.)
     * 2. phone         - proven by SMS.
     * 3. email         - proven by the provider, and only when verified.
     *
     * Order matters: someone who signed up by phone and later uses Google with
     * the same address must land in the account they already have, rather than
     * quietly getting a second empty one.
     */
    let users = [];
    for (const [sql, param] of [
      [`${SELECT} WHERE u.firebase_uid = $1`, uid],
      phone ? [`${SELECT} WHERE u.phone = $1`, phone] : null,
      email ? [`${SELECT} WHERE lower(u.email) = $1`, email] : null,
    ].filter(Boolean)) {
      ({ rows: users } = await c.query(sql, [param]));
      if (users.length) break;
    }

    let isNew = false;
    let joinedByInvite = false;

    /*
     * An open invitation turns a brand-new sign-in into a colleague, not a new
     * business.
     *
     * Checked before creating anything: without this, an invited accountant
     * signing in with Google would get their own empty account and see no
     * books at all, which looks exactly like the invitation never worked.
     */
    if (!users.length && email) {
      const { rows: inv } = await c.query(
        `-- tenant-global: an invitation is looked up BEFORE any org is known.
         -- That is the whole point of one: this address does not belong to a
         -- business yet, and the invite is what decides which one it joins.
         -- An address may be invited by only one business at a time, which is
         -- enforced where invites are created.
         SELECT * FROM invites
          WHERE lower(email) = $1 AND accepted_at IS NULL AND revoked_at IS NULL
          ORDER BY created_at DESC LIMIT 1`, [email]);

      if (inv.length) {
        const i = inv[0];
        const { rows: created } = await c.query(
          `INSERT INTO users (org_id, phone, email, firebase_uid, role, role_id,
                              name, branch, invited_by, invited_at)
           VALUES ($1,$2,$3,$4,'member',$5,$6,$7,$8, now()) RETURNING *`,
          [i.org_id, phone, email, uid, i.role_id, i.name || '', i.branch || '', i.invited_by]);

        await c.query('UPDATE invites SET accepted_at = now() WHERE id = $1', [i.id]);

        const { rows: org } = await c.query('SELECT * FROM orgs WHERE id = $1', [i.org_id]);
        users = [{ ...created[0], org_name: org[0].name, plan: org[0].plan,
                   trial_ends_at: org[0].trial_ends_at,
                   message_credits: org[0].message_credits }];
        joinedByInvite = true;
      }
    }

    if (!users.length) {
      const { rows: org } = await c.query('INSERT INTO orgs (name) VALUES (NULL) RETURNING *');
      const { rows: created } = await c.query(
        `INSERT INTO users (org_id, phone, email, firebase_uid, role)
         VALUES ($1, $2, $3, $4, 'owner') RETURNING *`,
        [org[0].id, phone, email, uid],
      );
      users = [{ ...created[0], org_name: org[0].name, plan: org[0].plan,
                 trial_ends_at: org[0].trial_ends_at, message_credits: org[0].message_credits }];
      isNew = true;
    } else {
      /*
       * Fill in identifiers this account did not have yet, so a phone user who
       * signs in with Google once can afterwards use either - which is exactly
       * the recovery path when a SIM is lost.
       *
       * Only ever fills a blank. It never overwrites an existing phone or email,
       * because that would let a new sign-in take over an established account.
       * COALESCE does the guarding in SQL; the partial unique indexes reject a
       * value already claimed by somebody else.
       */
      const u = users[0];
      if ((phone && !u.phone) || (email && !u.email) || !u.firebase_uid) {
        const { rows } = await c.query(
          `UPDATE users
              SET phone        = COALESCE(phone, $2),
                  email        = COALESCE(email, $3),
                  firebase_uid = COALESCE(firebase_uid, $4)
            WHERE id = $1
        RETURNING *`,
          [u.id, phone, email, uid],
        );
        users = [{ ...u, ...rows[0] }];
      }
    }

    const u = users[0];

    /*
     * One live session per kind of device.
     *
     * Signing in on a new phone ends the session on the old one - which is what
     * someone expects, and what protects them when a handset is sold, lost, or
     * handed to a family member. Sessions never expire, so without this the old
     * phone stays a way in for ever.
     *
     * Per kind, not globally: the counter PC and the owner's phone are the
     * normal case and must coexist.
     */
    const { rowCount: replaced } = await c.query(
      `UPDATE sessions SET revoked_at = now()
        WHERE user_id = $1 AND device_kind = $2 AND revoked_at IS NULL`,
      [u.id, kind],
    );

    const token = auth.newToken('acc');
    await c.query(
      // No expiry: sign in once. Revoking is what ends a session.
      `INSERT INTO sessions
         (token_hash, user_id, expires_at, device_label, device_kind, last_seen_at)
       VALUES ($1, $2, NULL, $3, $4, now())`,
      [auth.hash(token), u.id, deviceLabel(ctx), kind],
    );
    return {
      access: token,
      isNewAccount: isNew,
      // So the app can welcome them into somebody else's business rather than
      // walking them through creating one.
      joinedByInvite,
      // So the app can say "we signed you out on your other phone" rather than
      // leaving somebody to discover it.
      signedOutOtherDevices: replaced,
      needsOnboarding: !(u.org_name && u.org_name.trim()),
      user: { id: u.id, name: u.name, phone: u.phone, email: u.email, role: u.role },
      org: { id: u.org_id, name: u.org_name, plan: u.plan, trialEndsAt: u.trial_ends_at },
      _audit: {
        via, isNew, kind, joinedByInvite, replaced,
        userId: u.id, orgId: u.org_id, name: u.name, email: u.email,
      },
    };
  });

  /*
   * The bookkeeping runs AFTER the transaction has committed, not inside it.
   *
   * Both of these already used their own connection so that a record of what
   * happened survives a rollback. Awaiting them inside the transaction kept it
   * open across three more round trips anyway, and an open transaction is
   * holding every row it has written.
   *
   * That matters for one account in particular. A staff account is created at
   * boot from MUNIM_OPERATOR_EMAILS with an email and no Google identity, so
   * its first sign-in - and every sign-in until one succeeds - updates the
   * users row to fill in firebase_uid. It is the only account whose sign-in
   * writes to users at all: everybody else arrived through Google and already
   * has one. So it is the only sign-in that locks a users row, and the only
   * one that can be blocked by a lock left behind on it.
   *
   * Neither call is allowed to fail the sign-in. Somebody is standing at a
   * till: an audit row that did not write is a problem for us, not a reason to
   * refuse them entry.
   */
  const a = out._audit;
  delete out._audit;

  try {
    await audit.record(ctx, `auth.${a.via}`, {
      entityId: a.userId,
      entityName: deviceLabel(ctx),
      meta: {
        isNew: a.isNew, kind: a.kind,
        joinedByInvite: a.joinedByInvite, replacedSessions: a.replaced,
      },
      session: { org: { id: a.orgId }, user: { id: a.userId, name: a.name, email: a.email } },
    });
  } catch (e) {
    console.error('  sign-in audit failed (sign-in itself was fine):', e.message);
  }

  /*
   * A successful sign-in wipes the failure record.
   *
   * Otherwise a shop owner who fumbled four times yesterday walks in one
   * mistake away from a lockout today, for no security benefit: the point of
   * counting failures is to catch a run of them, not to hold a grudge.
   */
  try {
    await security.record(ctx, {
      userId: a.userId, orgId: a.orgId, email: a.email || '', ok: true, via: a.via,
    });
    await security.clearFailures(a.userId, a.email || '');
  } catch (e) {
    console.error('  clearing sign-in failures failed:', e.message);
  }

  return out;
}

/**
 * Sign in with Google, straight from the app.
 *
 * The mobile app talks to Google directly rather than through Firebase, because
 * Google refuses OAuth inside embedded WebViews and the phone therefore uses the
 * system browser. It comes back with a Google ID token, which is a different
 * token to Firebase's - hence a separate verifier and a separate route.
 *
 * Free: Google Sign-In is included up to 50,000 monthly active users, where
 * every SMS is billed per message.
 */
async function googleSignIn(ctx) {
  // Android, iOS and web are separate OAuth clients for the same product, so
  // any of them may legitimately have minted the token.
  const clientIds = (process.env.GOOGLE_CLIENT_IDS || '')
    .split(',').map((x) => x.trim()).filter(Boolean);

  if (!clientIds.length) {
    throw new HttpError(503, 'GOOGLE_NOT_CONFIGURED',
      'Google sign-in is not configured on this server.');
  }

  // So the security log can say which device an attempt came from without
  // every call site repeating the parsing.
  ctx.deviceKind = deviceKind(ctx);
  ctx.deviceLabel = deviceLabel(ctx);

  const { idToken } = ctx.body;

  /*
   * Throttled BEFORE the signature is checked, not after.
   *
   * The check was previously after verification, where it could never fire: a
   * junk token always fails verification first, so grinding was never counted
   * at all. Verifying a signature is the expensive part, so refusing early is
   * also what actually protects the server.
   */
  await security.assertNotThrottled(ctx, google.unsafeEmailFromToken(idToken));

  let verified;
  try {
    verified = await google.verifyIdToken(idToken, clientIds);
  } catch (e) {
    // Never echo the verifier's reason: it tells an attacker which check failed.
    console.warn('  google verification failed:', e.message);
    /*
     * Logged against the address the token CLAIMS, read without verifying it.
     *
     * The signature failed, so nothing in the token is trustworthy - but an
     * attacker replaying tokens at one account still needs to be counted
     * somewhere, and the claimed address is the only handle there is. It is
     * used for counting and never for granting anything.
     */
    await security.record(ctx, {
      email: google.unsafeEmailFromToken(idToken), ok: false, via: 'google',
      reason: 'token could not be verified',
    });
    throw new HttpError(401, 'INVALID_GOOGLE_TOKEN',
      'That sign-in could not be verified. Please try again.');
  }

  if (!verified.emailVerified || !verified.email) {
    await security.record(ctx, {
      email: verified.email || '', ok: false, via: 'google',
      reason: 'no verified email on the Google account',
    });
    throw bad('NO_VERIFIED_EMAIL',
      'That Google account has no verified email address.');
  }

  // The account's own lock, which only the app sign-in code can set. Checked
  // after verification so a stranger can never trip it for somebody else.
  await security.assertNotLocked(verified.email);

  return issueSession(ctx, {
    uid: verified.uid,
    phone: null,                       // a Google sign-in carries no number
    email: verified.email.trim().toLowerCase(),
    via: 'google',
  });
}

/*
 * Signing in on the phone with a code from the web.
 *
 * Google will not do OAuth from a Web client on a handset, and giving the phone
 * its own Android client means a signing fingerprint and a native build. This
 * sidesteps all of it: the owner is already signed in on the web, looking at a
 * screen only they can see. Show a code there, type it into the app.
 *
 * The code carries a session, so the safety comes from three limits together:
 * it is short-lived, single-use, and only an already-authenticated browser can
 * ask for one.
 */
const APP_CODE_MINUTES = 10;
const APP_CODE_MAX_ATTEMPTS = 5;

// Excludes 0/O, 1/I and 5/S: this is read off one screen and typed into
// another, and a misread character is indistinguishable from a wrong code -
// which then burns one of only five attempts.
const CODE_ALPHABET = '2346789ABCDEFGHJKLMNPQRTUVWXYZ';

function newAppCode() {
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;   // ABCD-EFGH reads back easily
}

/** The signed-in web app asks for a code to read out to the phone. */
async function createAppCode(ctx) {
  const s = auth.requireUser(ctx);

  return tx(async (c) => {
    // One live code per person: a pile of valid codes is a pile of ways in, and
    // nobody needs two at once.
    await c.query(
      `DELETE FROM app_sign_in_codes WHERE user_id = $1 AND used_at IS NULL`,
      [s.user.id],
    );
    const code = newAppCode();
    await c.query(
      `INSERT INTO app_sign_in_codes (code, user_id, expires_at)
       VALUES ($1, $2, now() + ($3 || ' minutes')::interval)`,
      [code, s.user.id, String(APP_CODE_MINUTES)],
    );
    return { code, expiresInSeconds: APP_CODE_MINUTES * 60 };
  });
}

/** The phone redeems it. Unauthenticated - the code is the proof. */
async function redeemAppCode(ctx) {
  const raw = String(ctx.body?.code ?? '').trim().toUpperCase();
  // Accept it typed with or without the dash, and with stray spaces.
  const code = raw.replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.{4})$/, '$1-$2');

  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) {
    throw bad('BAD_CODE', 'That code does not look right. It looks like ABCD-EFGH.');
  }

  return tx(async (c) => {
    const { rows } = await c.query(
      `SELECT * FROM app_sign_in_codes WHERE code = $1 FOR UPDATE`, [code]);

    // One flat message whether the code is unknown, spent or stale: saying
    // which would let someone probe for live codes.
    const reject = () => bad('BAD_CODE',
      'That code is not valid any more. Get a fresh one on the web.');

    if (!rows.length) throw reject();
    const rec = rows[0];

    if (rec.used_at || rec.expires_at <= new Date()
        || rec.attempts >= APP_CODE_MAX_ATTEMPTS) {
      throw reject();
    }

    const { rows: users } = await c.query(
      `SELECT u.*, o.name AS org_name, o.plan, o.trial_ends_at
         FROM users u JOIN orgs o ON o.id = u.org_id WHERE u.id = $1`,
      [rec.user_id],
    );
    if (!users.length) throw reject();
    const u = users[0];

    // Burn it before issuing anything: a code that has produced a session must
    // never produce a second one.
    await c.query(`UPDATE app_sign_in_codes SET used_at = now() WHERE code = $1`, [code]);

    // Same rule as a normal sign-in: a new phone replaces the old one.
    const kind = deviceKind(ctx);
    await c.query(
      `UPDATE sessions SET revoked_at = now()
        WHERE user_id = $1 AND device_kind = $2 AND revoked_at IS NULL`,
      [u.id, kind],
    );

    const token = auth.newToken('acc');
    await c.query(
      `INSERT INTO sessions
         (token_hash, user_id, expires_at, device_label, device_kind, last_seen_at)
       VALUES ($1, $2, NULL, $3, $4, now())`,
      [auth.hash(token), u.id, deviceLabel(ctx), kind],
    );
    await c.query(
      `INSERT INTO audit_log (org_id, user_id, action, meta)
       VALUES ($1, $2, 'auth.app_code', $3)`,
      [u.org_id, u.id, JSON.stringify({ device: deviceLabel(ctx) })],
    );

    return {
      access: token,
      isNewAccount: false,
      needsOnboarding: !(u.org_name && u.org_name.trim()),
      user: { id: u.id, name: u.name, phone: u.phone, email: u.email, role: u.role },
      org: { id: u.org_id, name: u.org_name, plan: u.plan, trialEndsAt: u.trial_ends_at },
    };
  });
}

/** Tells the apps which sign-in method to show, so nothing is hardcoded. */
function authConfig() {
  /*
   * Two lists doing two different jobs.
   *
   * GOOGLE_CLIENT_IDS is the *verification* allowlist: any of these may have
   * minted the token we are handed, and all are accepted.
   *
   * The per-platform ids below decide which client each app should *ask* with.
   * They are not interchangeable - Google refuses a Web client from a phone,
   * and an Android client cannot run in a browser - so handing an app the wrong
   * one fails at sign-in with a policy error that names neither.
   */
  const all = (process.env.GOOGLE_CLIENT_IDS || '')
    .split(',').map((x) => x.trim()).filter(Boolean);

  // Explicit wins; otherwise guess from the list, since an Android client id
  // is the one Google never lets a browser use.
  const web = process.env.GOOGLE_CLIENT_ID_WEB
    || all.find((id) => id !== process.env.GOOGLE_CLIENT_ID_ANDROID)
    || all[0] || null;
  const android = process.env.GOOGLE_CLIENT_ID_ANDROID || null;

  return {
    provider: all.length ? 'google' : 'not-configured',
    // clientId stays the web one: it is what the browser needs, and an older
    // client that only reads this field is a browser.
    google: all.length ? { clientId: web, web, android: android || web } : null,
    configured: all.length > 0,
  };
}

async function me(ctx) {
  const s = auth.requireUser(ctx);
  const { rows: companies } = await query(
    `SELECT c.tally_guid, c.name, c.enabled, c.last_sync_at, c.gstin,
            c.number_format, c.decimals, c.date_format, c.currency, c.logo_data_uri,
            (SELECT count(*)::int FROM ledgers  l WHERE l.company_id = c.id) AS ledgers,
            (SELECT count(*)::int FROM vouchers v WHERE v.company_id = c.id) AS vouchers
       FROM companies c WHERE c.org_id = $1 ORDER BY c.name`,
    [s.org.id],
  );
  const { rows: conn } = await query(
    'SELECT count(*)::int AS n FROM connectors WHERE org_id = $1', [s.org.id],
  );

  // Carried here rather than fetched separately: the lock has to be decided
  // before the first screen paints, and a second round trip at launch would
  // show the figures for a moment before hiding them.
  const { rows: lock } = await query(
    `SELECT app_lock_hash <> '' AS enabled, app_lock_minutes, app_lock_biometric
       FROM users WHERE id = $1`, [s.user.id],
  );

  return {
    needsOnboarding: !(s.org.name && s.org.name.trim()),
    user: s.user,
    org: s.org,
    /*
     * What this customer may use. The apps render from this rather than
     * assuming - so one build serves every customer, and hiding a feature in
     * the client is presentation, not the actual control. Every route checks
     * the same row.
     */
    features: features.featuresFor(s.org),
    /*
     * The permission matrix, resolved.
     *
     * The apps hide what this person cannot use - but that is presentation
     * only. Every route checks the same matrix for itself, because a hidden
     * button is still a reachable URL.
     */
    permissions: perms.summarise(s),
    role: {
      key: s.user.roleKey ?? (s.user.role === 'owner' ? 'owner' : s.user.role),
      name: s.user.roleName ?? (s.user.role === 'owner' ? 'Owner' : s.user.role),
      isOwner: s.user.role === 'owner',
    },
    /*
     * Through the plan table, not the two legacy columns.
     *
     * Those default to nothing now and mean "raised by hand"; reading them with
     * `?? 1` told every customer their plan allowed one of everything, whatever
     * they had paid for.
     */
    limits: plans.limitsFor({
      plan: s.org.plan,
      limits: s.org.limits,
      max_connectors: s.org.maxConnectors,
      max_companies: s.org.maxCompanies,
    }),
    connectors: conn[0].n,
    appLock: {
      enabled: lock[0]?.enabled ?? false,
      minutes: lock[0]?.app_lock_minutes ?? 0,
      biometric: lock[0]?.app_lock_biometric ?? true,
    },
    companies: companies.map((c) => ({
      tallyGuid: c.tally_guid, name: c.name, enabled: c.enabled,
      lastSyncAt: c.last_sync_at, ledgers: c.ledgers, vouchers: c.vouchers,
      gstin: c.gstin,
      /*
       * Carried on every company so the apps can format money correctly from
       * the first paint. Fetching them separately would mean every screen
       * briefly showing Indian grouping before switching, which looks like a
       * glitch on the one screen a customer chose to change.
       */
      settings: {
        numberFormat: c.number_format,
        decimals: c.decimals,
        dateFormat: c.date_format,
        currency: c.currency || '\u20b9',
        logoDataUri: c.logo_data_uri || '',
      },
    })),
  };
}

/** Naming the business IS creating the company. Everything hangs off it. */
async function onboarding(ctx) {
  const s = auth.requireUser(ctx);
  const name = String(ctx.body.businessName ?? '').trim();
  if (name.length < 2) throw bad('INVALID_NAME', 'Enter your business name.');
  if (name.length > 80) throw bad('INVALID_NAME', 'That name is too long.');

  await query('UPDATE orgs SET name = $1 WHERE id = $2', [name, s.org.id]);
  const owner = String(ctx.body.ownerName ?? '').trim();
  if (owner) await query('UPDATE users SET name = $1 WHERE id = $2', [owner, s.user.id]);

  await query(
    `INSERT INTO audit_log (org_id, user_id, action, meta)
     VALUES ($1, $2, 'org.named', $3)`,
    [s.org.id, s.user.id, JSON.stringify({ name })],
  );

  return {
    needsOnboarding: false,
    org: { ...s.org, name },
    user: { ...s.user, name: owner || s.user.name },
  };
}

async function logout(ctx) {
  const s = auth.requireUser(ctx);
  // Recorded before the session is cut, while ctx still knows who this is.
  await audit.record(ctx, 'auth.signout', {
    entityId: s.user.id, entityName: s.user.name || s.user.email || '',
  });
  await auth.revokeSession(ctx.token);
  return { ok: true };
}

module.exports = {
  googleSignIn, createAppCode, redeemAppCode,
  authConfig, me, onboarding, logout,
};
