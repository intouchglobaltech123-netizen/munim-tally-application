'use strict';
const { query, tx } = require('../db');
const { HttpError, bad, notFound } = require('../lib/http');
const auth = require('../lib/auth');
const features = require('../lib/features');
const plans = require('../lib/plans');

async function listReminders(ctx) {
  const s = auth.requireUser(ctx);
  features.requireFeature(s, 'reminders');
  const { rows } = await query(
    `SELECT id, party, phone, amount_paise, channel, status, sent_at
       FROM reminders WHERE org_id = $1 ORDER BY sent_at DESC LIMIT 100`,
    [s.org.id],
  );
  return {
    reminders: rows.map((r) => ({
      id: r.id, party: r.party, phone: r.phone,
      amountPaise: Number(r.amount_paise), channel: r.channel,
      status: r.status, sentAt: r.sent_at,
    })),
    creditsRemaining: s.org.messageCredits,
  };
}

/**
 * Credits are decremented in the same transaction that records the reminder, so
 * two taps cannot both spend the last credit. WhatsApp is a real per-message
 * cost - it must never be possible to go negative.
 */
// ------------------------------------------------------------------ admin --
// The only routes that read across tenants. Hence their own role check.

async function adminStats(ctx) {
  auth.requireAdmin(ctx);
  const { rows } = await query(`
    -- tenant-global: the platform operator's own dashboard. Counts across every
    -- customer by design, which is why requireAdmin sits directly above it and
    -- why nothing here returns a customer's rows - only totals.
    SELECT (SELECT count(*)::int FROM orgs)       AS orgs,
           (SELECT count(*)::int FROM users)      AS users,
           (SELECT count(*)::int FROM companies)  AS companies,
           (SELECT count(*)::int FROM vouchers)   AS vouchers,
           (SELECT count(*)::int FROM connectors) AS connectors,
           (SELECT count(*)::int FROM connectors
             WHERE status = 'ok' AND last_seen_at > now() - interval '30 minutes')
             AS connectors_healthy,
           (SELECT count(*)::int FROM reminders)  AS reminders_sent,
           (SELECT COALESCE(sum(message_credits),0)::int FROM orgs) AS credits`);
  const r = rows[0];
  return {
    orgs: r.orgs, users: r.users, companies: r.companies, vouchers: r.vouchers,
    connectors: r.connectors, connectorsHealthy: r.connectors_healthy,
    remindersSent: r.reminders_sent, credits: r.credits,
    records: r.vouchers, batches: 0,
  };
}

async function adminOrgs(ctx) {
  auth.requireAdmin(ctx);
  const { rows } = await query(`
    SELECT o.id, o.name, o.plan, o.trial_ends_at, o.created_at, o.message_credits, o.features,
            o.max_connectors, o.max_companies, o.notes,
           (SELECT count(*)::int FROM users u      WHERE u.org_id = o.id) AS users,
           (SELECT count(*)::int FROM connectors k WHERE k.org_id = o.id) AS connectors,
           (SELECT count(*)::int FROM companies c  WHERE c.org_id = o.id) AS companies,
           (SELECT count(*)::int FROM vouchers v
              JOIN companies c ON c.id = v.company_id WHERE c.org_id = o.id) AS vouchers,
           (SELECT max(c.last_sync_at) FROM companies c WHERE c.org_id = o.id) AS last_sync_at
      FROM orgs o ORDER BY o.created_at`);
  return {
    orgs: rows.map((r) => ({
      id: r.id, name: r.name ?? '(unnamed)', onboarded: !!(r.name && r.name.trim()),
      plan: r.plan, trialEndsAt: r.trial_ends_at, createdAt: r.created_at,
      messageCredits: r.message_credits, users: r.users, connectors: r.connectors,
      companies: r.companies, vouchers: r.vouchers, lastSyncAt: r.last_sync_at,
      // What this customer may use, and their ceilings - the admin screen edits
      // these in place rather than on a separate page.
      features: plans.featuresFor(r),
      /*
       * Resolved through the plan, not read raw.
       *
       * These columns are overrides now and are NULL unless somebody raised a
       * ceiling by hand, so reading them directly showed "null computers" on
       * every account that had never been touched.
       */
      maxConnectors: plans.limitFor(r, 'connectors'),
      maxCompanies: plans.limitFor(r, 'companies'),
      planLabel: plans.plan(r.plan).label,
      // The override itself, so the operator can see whether a ceiling was set
      // by hand or is just the plan.
      overrides: { connectors: r.max_connectors, companies: r.max_companies },
      notes: r.notes,
    })),
  };
}

async function adminConnectors(ctx) {
  auth.requireAdmin(ctx);
  const { rows } = await query(`
    SELECT k.id, k.machine_name, k.tally_version, k.app_version, k.status,
           k.tally_up, k.paired_at, k.last_seen_at, k.org_id, o.name AS org_name
      FROM connectors k JOIN orgs o ON o.id = k.org_id
     ORDER BY k.last_seen_at DESC NULLS LAST`);
  return {
    connectors: rows.map((r) => ({
      id: r.id, machine: r.machine_name, tallyVersion: r.tally_version,
      appVersion: r.app_version, status: r.status, tallyUp: r.tally_up,
      pairedAt: r.paired_at, lastSeenAt: r.last_seen_at,
      orgId: r.org_id, orgName: r.org_name ?? '(unnamed)',
    })),
  };
}

/**
 * Change what one customer can do. Staff only.
 *
 * Deliberately narrow: features, the two ceilings, plan, and a note. Not name,
 * not users, not their data - an operator screen that can edit everything is
 * an operator screen that eventually does.
 */
async function adminUpdateOrg(ctx, orgId) {
  auth.requireAdmin(ctx);
  const body = ctx.body ?? {};

  // Only keys the catalogue knows, and only booleans. A client cannot invent a
  // feature by sending one.
  let featurePatch = null;
  if (body.features && typeof body.features === 'object') {
    featurePatch = {};
    for (const key of Object.keys(features.CATALOGUE)) {
      if (typeof body.features[key] === 'boolean') featurePatch[key] = body.features[key];
    }
  }

  const clamp = (v, lo, hi) => Math.min(Math.max(parseInt(v, 10) || lo, lo), hi);

  /*
   * Three states, not two: absent, a number, and explicitly cleared.
   *
   * These columns are overrides now - NULL means "let the plan decide" - so
   * COALESCE alone made a ceiling impossible to remove once set. The boolean
   * says whether this request is touching the field at all, which is the
   * distinction COALESCE cannot carry on its own.
   */
  const touchingConnectors = body.maxConnectors !== undefined;
  const touchingCompanies = body.maxCompanies !== undefined;
  const asOverride = (v) =>
    (v === null || v === '' ? null : clamp(v, 1, 999));

  if (body.plan !== undefined && !plans.PLANS[body.plan]) {
    throw bad('BAD_PLAN', `No such plan: ${body.plan}.`);
  }

  const { rows } = await query(
    `UPDATE orgs SET
       features       = COALESCE($2::jsonb, features),
       max_connectors = CASE WHEN $3 THEN $4::int ELSE max_connectors END,
       max_companies  = CASE WHEN $5 THEN $6::int ELSE max_companies END,
       plan           = COALESCE($7, plan),
       notes          = COALESCE($8, notes)
     WHERE id = $1
     RETURNING id, name, plan, features, max_connectors, max_companies, notes`,
    [
      orgId,
      featurePatch ? JSON.stringify(featurePatch) : null,
      touchingConnectors, touchingConnectors ? asOverride(body.maxConnectors) : null,
      touchingCompanies, touchingCompanies ? asOverride(body.maxCompanies) : null,
      typeof body.plan === 'string' ? body.plan.slice(0, 24) : null,
      typeof body.notes === 'string' ? body.notes.slice(0, 500) : null,
    ],
  );
  if (!rows.length) throw notFound('No such business.');

  const o = rows[0];
  return {
    id: o.id, name: o.name, plan: o.plan,
    features: plans.featuresFor(o),
    planLabel: plans.plan(o.plan).label,
    maxConnectors: plans.limitFor(o, 'connectors'),
    maxCompanies: plans.limitFor(o, 'companies'),
    overrides: { connectors: o.max_connectors, companies: o.max_companies },
    notes: o.notes,
  };
}

/** The feature list itself, so the admin screen is not a hardcoded copy. */
async function adminCatalogue(ctx) {
  auth.requireAdmin(ctx);
  return { features: features.catalogue() };
}

module.exports = {
  adminUpdateOrg, adminCatalogue, listReminders, adminStats, adminOrgs, adminConnectors };
