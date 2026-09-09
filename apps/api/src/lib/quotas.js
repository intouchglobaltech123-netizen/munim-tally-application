'use strict';
const { query } = require('../db');
const plans = require('./plans');
const { HttpError } = require('./http');

/**
 * How much of their plan a customer has used.
 *
 * Counted from the data rather than kept in a counter column. A counter is
 * faster and is wrong within a month: every delete, every failed write, every
 * restore drifts it, and the first time a customer is told they are at 15 of 15
 * users while looking at a list of 11, the number has cost more in support than
 * it ever saved in queries. These are small counts over indexed columns on a
 * per-tenant basis; correctness is worth more than the microseconds.
 *
 * The monthly ones are the exception and are genuinely event counts, because
 * "how many WhatsApp messages did they send in November" cannot be derived from
 * current state at all.
 */

/** Start of the current calendar month, which is how a monthly allowance runs. */
const monthStart = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
};

const dayStart = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
};

/**
 * Current usage for one tenant.
 *
 * One round trip. Twelve separate counts on a settings page load is the kind of
 * thing that looks free in development and shows up as latency the day a
 * customer has real data.
 */
async function usageFor(orgId) {
  const { rows } = await query(`
    SELECT
      /*
       * BUSINESSES, not company files.
       *
       * An accountant starts a new Tally company every 1 April, so one shop
       * keeping three years of books arrives as three files. Counting files
       * meant a customer on Basic - one company - was over their limit the day
       * they connected, and the product simply stopped working for one of the
       * most ordinary setups in the country.
       *
       * They are paying to see one shop's books. That is what is counted.
       * COALESCE covers a file not yet grouped, which counts as its own.
       */
      (SELECT count(DISTINCT COALESCE(business_id::text, id::text))
         FROM companies WHERE org_id = $1)                                     AS companies,
      (SELECT count(*) FROM companies WHERE org_id = $1)                       AS company_files,
      (SELECT count(*) FROM users      WHERE org_id = $1 AND status <> 'disabled') AS users,
      (SELECT count(*) FROM connectors WHERE org_id = $1 AND revoked_at IS NULL) AS connectors,
      (SELECT count(*) FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE u.org_id = $1 AND s.revoked_at IS NULL)                            AS devices,
      -- Counted from handed_off_at, not from the row existing: a reminder that
      -- was only ever drafted has not spent anybody's allowance. Munim hands
      -- the message to WhatsApp rather than sending it, and that hand-off is
      -- the moment the customer used one.
      (SELECT count(*) FROM reminders
        WHERE org_id = $1 AND channel = 'whatsapp'
          AND COALESCE(handed_off_at, sent_at) >= $2)                            AS whatsapp_month,
      (SELECT count(*) FROM reminders
        WHERE org_id = $1 AND channel = 'sms'
          AND COALESCE(handed_off_at, sent_at) >= $2)                            AS sms_month
  `, [orgId, monthStart()]);

  const r = rows[0];
  return {
    companies: Number(r.companies),
    /*
     * Surfaced separately so a screen can say "2 businesses, 6 years of books"
     * rather than leaving somebody to wonder why the count is lower than the
     * list they are looking at.
     */
    companyFiles: Number(r.company_files),
    users: Number(r.users),
    connectors: Number(r.connectors),
    devices: Number(r.devices),
    whatsappPerMonth: Number(r.whatsapp_month),
    smsPerMonth: Number(r.sms_month),
    // Not yet issued by Munim - both need write access to Tally and a paid GSP
    // contract. Reported as zero rather than omitted so the screen that shows
    // allowances does not have a hole in it.
    eInvoicesPerMonth: 0,
    eWayBillsPerMonth: 0,
  };
}

/**
 * Usage against allowance, ready to render.
 *
 * `pct` is capped at 100 for the bar, but `over` is honest: a customer moved
 * onto a smaller plan can legitimately be above their new ceiling, and hiding
 * that produces a screen that says 100% for ever while nothing works.
 */
async function report(org) {
  const usage = await usageFor(org.id);
  const limits = plans.limitsFor(org);

  const lines = Object.entries(plans.LIMITS)
    .filter(([key]) => key in usage)
    .map(([key, meta]) => {
      const limit = limits[key];
      const used = usage[key] ?? 0;
      return {
        key,
        label: meta.label,
        unit: meta.unit,
        used,
        limit,
        unlimited: limit === null,
        pct: limit === null || limit === 0 ? 0 : Math.min(100, Math.round((used / limit) * 100)),
        over: limit !== null && used > limit,
        // The one a customer actually reads.
        summary: limit === null
          ? `${used} — no limit on your plan`
          : `${used} of ${limit}`,
      };
    });

  return {
    plan: org.plan,
    planLabel: plans.plan(org.plan).label,
    trial: plans.trialState(org),
    usage,
    limits,
    lines,
    // Surfaced so a settings screen can lead with the problem rather than
    // making somebody read twelve rows to find it.
    atLimit: lines.filter((l) => !l.unlimited && l.used >= l.limit).map((l) => l.label),
  };
}

/**
 * Refuse to go over.
 *
 * Takes the count BEFORE the thing being added, and compares with >=, because
 * the caller is about to create one more. Getting that off by one lets every
 * plan sell one extra of everything.
 */
function assertWithin(org, key, current, opts = {}) {
  const limit = plans.limitFor(org, key);
  if (limit === null) return;
  if (current < limit) return;

  const meta = plans.LIMITS[key] ?? { label: key, unit: '' };
  const planLabel = plans.plan(org.plan).label;

  /*
   * "1 companies" is the kind of detail a shop owner reads as sloppiness in a
   * product they are trusting with their books.
   */
  const noun = limit === 1 ? (meta.one ?? meta.noun ?? meta.label)
                           : (meta.noun ?? meta.label);

  throw new HttpError(403, 'LIMIT_REACHED',
    opts.message
    ?? `${planLabel} includes ${limit} ${noun}`
       + `${meta.monthly ? ' a month' : ''}, and you are at ${current}. `
       + 'Upgrade your plan to add more.');
}

/** The same check, but it counts for you. */
async function assertCanAdd(org, key) {
  const usage = await usageFor(org.id);
  assertWithin(org, key, usage[key] ?? 0);
  return usage;
}

module.exports = { usageFor, report, assertWithin, assertCanAdd, monthStart, dayStart };
