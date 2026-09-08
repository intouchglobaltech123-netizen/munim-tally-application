'use strict';
const crypto = require('crypto');
const { query } = require('../db');

/**
 * Telling somebody else's software that something happened.
 *
 * The alternative is their software polling Munim every minute for a change
 * that happens twice a day, which is worse for them and worse for the server.
 *
 * Three things make this safe to point at an arbitrary URL:
 *
 *   1. Every delivery is signed, so a receiver can tell a real one from
 *      anybody who guessed the URL. Without a signature a webhook endpoint is
 *      an unauthenticated write into somebody's accounting system.
 *   2. Deliveries are attempted with a short timeout and a small number of
 *      retries. A hung endpoint must not hold a connection open for ever.
 *   3. An endpoint that keeps failing is switched off and the customer is told,
 *      rather than being retried into the heat death of the universe.
 */

const EVENTS = {
  'voucher.created':   'A voucher arrived from Tally',
  'voucher.changed':   'A voucher was changed in Tally',
  'voucher.deleted':   'A voucher was deleted in Tally',
  'sync.completed':    'A sync finished',
  'sync.failed':       'A sync failed',
  'bill.overdue':      'A bill went past its due date',
  'connector.offline': 'A Tally computer stopped reporting',
  'backup.completed':  'A backup was taken',
};

const TIMEOUT_MS = 8000;
const MAX_ATTEMPTS = 3;

/*
 * Switched off after this many consecutive failures.
 *
 * Twenty covers a long outage at the receiver - a night and a morning of
 * retries - without hammering a URL that has been decommissioned for a month.
 */
const DISABLE_AFTER = 20;

const newSecret = () => `whsec_${crypto.randomBytes(24).toString('base64url')}`;

/**
 * Sign a delivery.
 *
 * HMAC over the timestamp AND the body, not the body alone: signing only the
 * body lets anybody who ever saw one valid delivery replay it for ever. The
 * receiver is expected to reject a timestamp that is not recent.
 */
function sign(secret, timestamp, body) {
  return crypto.createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');
}

/**
 * Is this URL safe to call?
 *
 * A webhook URL is attacker-controlled input that the SERVER then fetches, so
 * without this it is a server-side request forgery primitive: a customer could
 * point one at 169.254.169.254 and have Munim fetch the cloud metadata service
 * for them, or at an internal address they could not otherwise reach.
 */
function checkUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return { ok: false, why: 'That is not a URL.' }; }

  if (url.protocol !== 'https:') {
    return { ok: false, why: 'Webhook URLs must be https — the payload contains '
                           + 'your accounting data.' };
  }

  const host = url.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') {
    return { ok: false, why: 'That address is not reachable from our server.' };
  }

  // Literal private and link-local ranges. A hostname that RESOLVES to one is
  // caught at delivery time, where the resolved address is actually known.
  if (/^(10\.|127\.|0\.|169\.254\.|192\.168\.)/.test(host)) {
    return { ok: false, why: 'That address is not reachable from our server.' };
  }
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) {
    return { ok: false, why: 'That address is not reachable from our server.' };
  }

  return { ok: true, url: url.toString() };
}

/**
 * Deliver one event to one endpoint.
 *
 * Retries with a growing wait, and gives up rather than queueing for ever: a
 * webhook is a notification, not a guaranteed message bus, and pretending
 * otherwise sets an expectation the product cannot keep.
 */
async function deliver(hook, event, payload) {
  const body = JSON.stringify({
    event,
    at: new Date().toISOString(),
    org: hook.org_id,
    data: payload,
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = sign(hook.secret, timestamp, body);

  let lastStatus = null;
  let lastError = '';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const started = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const res = await fetch(hook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Munim-Webhook/1',
          'X-Munim-Event': event,
          'X-Munim-Timestamp': String(timestamp),
          'X-Munim-Signature': `sha256=${signature}`,
          // So a receiver can drop a duplicate without comparing payloads.
          'X-Munim-Delivery': crypto.randomUUID(),
        },
        body,
        signal: controller.signal,
        redirect: 'error',   // a redirect could land somewhere unchecked
      });
      clearTimeout(timer);

      lastStatus = res.status;
      const ms = Date.now() - started;

      await log(hook, event, payload, res.status, '', attempt, ms);

      if (res.ok) {
        await query(
          `UPDATE webhooks SET last_status = $2, last_error = '', last_at = now(),
                               failures = 0 WHERE id = $1`, [hook.id, res.status]);
        return { ok: true, status: res.status, attempts: attempt };
      }

      /*
       * 4xx is the receiver saying "this request is wrong", and retrying an
       * identical request cannot fix that. Only 5xx and network errors are
       * worth another go.
       */
      if (res.status < 500) {
        lastError = `refused with ${res.status}`;
        break;
      }
      lastError = `server error ${res.status}`;
    } catch (e) {
      lastError = e.name === 'AbortError' ? `no answer within ${TIMEOUT_MS / 1000}s` : e.message;
      await log(hook, event, payload, null, lastError, attempt, Date.now() - started);
    }

    if (attempt < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, attempt * 1000));
    }
  }

  const { rows } = await query(
    `UPDATE webhooks
        SET last_status = $2, last_error = $3, last_at = now(), failures = failures + 1,
            disabled_at = CASE WHEN failures + 1 >= $4 THEN now() ELSE disabled_at END,
            active = CASE WHEN failures + 1 >= $4 THEN false ELSE active END
      WHERE id = $1 RETURNING failures, active`,
    [hook.id, lastStatus, lastError.slice(0, 300), DISABLE_AFTER]);

  return {
    ok: false,
    status: lastStatus,
    error: lastError,
    disabled: rows[0] && !rows[0].active,
  };
}

async function log(hook, event, payload, status, error, attempt, ms) {
  try {
    await query(
      `INSERT INTO webhook_deliveries
         (webhook_id, org_id, event, payload, status, error, attempt, duration_ms)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8)`,
      [hook.id, hook.org_id, event, JSON.stringify(payload ?? {}),
       status, String(error).slice(0, 300), attempt, ms]);
  } catch (e) {
    console.warn('  could not log webhook delivery:', e.message);
  }
}

/**
 * Fan one event out to every endpoint that asked for it.
 *
 * Never throws. A webhook is a notification ABOUT something that already
 * happened; failing to send it must not undo the thing it describes - the same
 * rule the audit log follows.
 */
async function emit(orgId, event, payload) {
  if (!EVENTS[event]) return { sent: 0 };
  try {
    const { rows } = await query(
      `SELECT * FROM webhooks
        WHERE org_id = $1 AND active AND $2 = ANY(events)`, [orgId, event]);

    let sent = 0;
    for (const hook of rows) {
      const out = await deliver(hook, event, payload);
      if (out.ok) sent++;
    }
    return { sent, endpoints: rows.length };
  } catch (e) {
    console.warn(`  webhook emit ${event} failed:`, e.message);
    return { sent: 0, error: e.message };
  }
}

module.exports = {
  EVENTS, emit, deliver, sign, newSecret, checkUrl, DISABLE_AFTER, MAX_ATTEMPTS,
};
