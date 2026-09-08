'use strict';
const { query } = require('../db');
const auth = require('../lib/auth');
const metrics = require('../lib/metrics');
const plans = require('../lib/plans');
const money = require('../lib/money');
const secrets = require('../lib/secrets');
const { HttpError } = require('../lib/http');

/**
 * The operator's own dashboard.
 *
 * Every query here reads across tenants, which is the one place in this codebase
 * that is allowed to - hence requireAdmin on every route and nothing else in
 * this file. Nothing here returns a customer's actual books: totals, counts and
 * health, never a voucher.
 *
 * The business numbers come from the database and survive a restart. The
 * technical ones come from lib/metrics.js and do not. That split is deliberate
 * and is explained there.
 */

/*
 * "Active" is 30 days.
 *
 * Accounting is not a daily habit for a small shop - a trader who looks at
 * receivables every Monday and nothing else is a perfectly healthy customer,
 * and a 7-day definition would report three quarters of the book as churned.
 */
const ACTIVE_DAYS = 30;

/** Everything a business would ask about the business. */
async function businessMetrics(ctx) {
  auth.requireAdmin(ctx);

  const { rows } = await query(`
    -- tenant-global: the operator's own metrics. Counts across every customer
    -- by design, behind requireAdmin, and returns no customer data.
    SELECT
      (SELECT count(*) FROM orgs WHERE delete_due_at IS NULL)          AS accounts,
      (SELECT count(*) FROM companies)                                 AS companies,
      (SELECT count(DISTINCT c.id) FROM companies c
        WHERE c.last_sync_at > now() - interval '30 days')              AS companies_active,
      (SELECT count(*) FROM users WHERE status <> 'disabled')          AS users,
      (SELECT count(*) FROM users
        WHERE last_seen_at > now() - interval '1 day')                  AS dau,
      (SELECT count(*) FROM users
        WHERE last_seen_at > now() - interval '30 days')                AS mau,
      (SELECT count(*) FROM orgs
        WHERE created_at > now() - interval '30 days')                  AS new_30d,
      (SELECT count(*) FROM orgs
        WHERE created_at > now() - interval '7 days')                   AS new_7d,
      (SELECT count(*) FROM orgs WHERE plan = 'trial')                 AS trial_accounts,
      (SELECT count(*) FROM orgs
        WHERE plan IN ('basic','pro','enterprise'))                     AS paid_accounts,
      (SELECT count(*) FROM orgs WHERE delete_due_at IS NOT NULL)      AS closing,
      (SELECT count(*) FROM subscriptions
        WHERE status IN ('active','grace','past_due'))                  AS live_subs,
      (SELECT count(*) FROM subscriptions
        WHERE status = 'cancelled'
          AND updated_at > now() - interval '30 days')                  AS cancelled_30d,
      (SELECT count(*) FROM subscriptions
        WHERE status IN ('active','grace','past_due')
          AND updated_at < now() - interval '30 days')                  AS subs_30d_ago,
      (SELECT COALESCE(sum(
         CASE WHEN term = 'yearly' THEN price_paise / 12 ELSE price_paise END), 0)
         FROM subscriptions WHERE status IN ('active','grace','past_due'))
                                                                        AS mrr_paise,
      (SELECT COALESCE(sum(total_paise), 0) FROM payments
        WHERE status = 'paid')                                          AS lifetime_paise,
      (SELECT count(*) FROM payments WHERE status = 'paid')            AS payments_ok,
      (SELECT count(*) FROM payments WHERE status = 'failed')          AS payments_failed
  `);

  const r = rows[0];
  const n = (k) => Number(r[k]);

  const mrr = n('mrr_paise');
  const paid = n('paid_accounts');
  const subsAgo = n('subs_30d_ago');

  /*
   * Churn as cancellations over the base that COULD have cancelled, which is
   * the number of subscriptions that existed at the start of the window - not
   * the number now. Dividing by the current count flatters a shrinking business
   * and punishes a growing one, which is exactly backwards.
   */
  const churnBase = subsAgo + n('cancelled_30d');
  const churnPct = churnBase ? (n('cancelled_30d') / churnBase) * 100 : 0;

  const trials = n('trial_accounts');
  const conversion = (trials + paid) ? (paid / (trials + paid)) * 100 : 0;
  const arpu = paid ? Math.round(mrr / paid) : 0;

  /*
   * LTV as ARPU divided by monthly churn - the standard formula, and it is
   * meaningless until there is real churn to divide by. Reported as null rather
   * than as a made-up number, because "LTV ₹4,80,000" from two months of data
   * is the kind of figure that ends up in a pitch deck.
   */
  const monthlyChurn = churnPct / 100;
  const ltv = monthlyChurn > 0.001 ? Math.round(arpu / monthlyChurn) : null;

  return {
    accounts: {
      total: n('accounts'),
      trial: trials,
      paid,
      closing: n('closing'),
      new30d: n('new_30d'),
      new7d: n('new_7d'),
    },
    companies: { total: n('companies'), active: n('companies_active') },
    users: { total: n('users'), dau: n('dau'), mau: n('mau'),
             stickiness: n('mau') ? Math.round((n('dau') / n('mau')) * 100) : 0 },
    revenue: {
      mrrPaise: mrr,
      mrrLabel: money.rupees(mrr),
      arrPaise: mrr * 12,
      arrLabel: money.rupees(mrr * 12),
      arpuPaise: arpu,
      arpuLabel: money.rupees(arpu),
      ltvPaise: ltv,
      ltvLabel: ltv === null ? 'Not enough history' : money.rupees(ltv),
      lifetimePaise: n('lifetime_paise'),
      lifetimeLabel: money.rupees(n('lifetime_paise')),
    },
    health: {
      churnPercent: Math.round(churnPct * 100) / 100,
      cancelled30d: n('cancelled_30d'),
      conversionPercent: Math.round(conversion * 100) / 100,
      liveSubscriptions: n('live_subs'),
      paymentsOk: n('payments_ok'),
      paymentsFailed: n('payments_failed'),
      paymentSuccessPercent: (n('payments_ok') + n('payments_failed'))
        ? Math.round((n('payments_ok') / (n('payments_ok') + n('payments_failed'))) * 10000) / 100
        : 100,
    },
    activeDefinition: `Seen in the last ${ACTIVE_DAYS} days.`,
  };
}

/** Connectors, syncs, the API and the machine. */
async function technicalMetrics(ctx) {
  auth.requireAdmin(ctx);

  const { rows } = await query(`
    -- tenant-global: operator health metrics, behind requireAdmin.
    SELECT
      (SELECT count(*) FROM connectors WHERE revoked_at IS NULL)        AS connectors,
      (SELECT count(*) FROM connectors
        WHERE revoked_at IS NULL AND last_seen_at > now() - interval '10 minutes')
                                                                        AS online,
      (SELECT count(*) FROM connectors
        WHERE revoked_at IS NULL AND (last_seen_at IS NULL
              OR last_seen_at <= now() - interval '10 minutes'))         AS offline,
      (SELECT count(*) FROM connectors
        WHERE revoked_at IS NULL AND tally_up = false)                   AS tally_down,
      (SELECT COALESCE(sum(queued_batches), 0) FROM connectors
        WHERE revoked_at IS NULL)                                        AS queue_depth,
      (SELECT count(*) FROM sync_runs
        WHERE started_at > now() - interval '24 hours')                  AS syncs_24h,
      (SELECT count(*) FROM sync_runs
        WHERE started_at > now() - interval '24 hours' AND ok)           AS syncs_ok_24h,
      (SELECT COALESCE(avg(duration_ms), 0) FROM sync_runs
        WHERE started_at > now() - interval '24 hours' AND ok)           AS sync_avg_ms,
      (SELECT count(*) FROM backups
        WHERE created_at > now() - interval '7 days' AND status = 'ok')  AS backups_ok,
      (SELECT count(*) FROM backups
        WHERE created_at > now() - interval '7 days' AND status <> 'ok') AS backups_failed,
      (SELECT COALESCE(sum(size_bytes), 0) FROM backups
        WHERE payload IS NOT NULL)                                       AS backup_bytes,
      (SELECT count(*) FROM vouchers)                                    AS vouchers,
      (SELECT pg_database_size(current_database()))                      AS db_bytes
  `);
  const r = rows[0];
  const n = (k) => Number(r[k]);

  // Timed here rather than guessed: one trivial round trip is what "is the
  // database slow" actually means from this process.
  const t0 = process.hrtime.bigint();
  await query('SELECT 1');
  const dbMs = Number(process.hrtime.bigint() - t0) / 1e6;

  const syncs = n('syncs_24h');

  return {
    connectors: {
      total: n('connectors'),
      online: n('online'),
      offline: n('offline'),
      tallyDown: n('tally_down'),
      queueDepth: n('queue_depth'),
      onlinePercent: n('connectors')
        ? Math.round((n('online') / n('connectors')) * 100) : 0,
    },
    sync: {
      runs24h: syncs,
      ok24h: n('syncs_ok_24h'),
      failed24h: syncs - n('syncs_ok_24h'),
      successPercent: syncs ? Math.round((n('syncs_ok_24h') / syncs) * 10000) / 100 : 100,
      averageMs: Math.round(n('sync_avg_ms')),
    },
    backups: {
      ok7d: n('backups_ok'),
      failed7d: n('backups_failed'),
      successPercent: (n('backups_ok') + n('backups_failed'))
        ? Math.round((n('backups_ok') / (n('backups_ok') + n('backups_failed'))) * 10000) / 100
        : 100,
      storedMb: Math.round(n('backup_bytes') / 1048576),
      encrypted: secrets.enabled(),
    },
    database: {
      latencyMs: Math.round(dbMs * 100) / 100,
      sizeMb: Math.round(n('db_bytes') / 1048576),
      vouchers: n('vouchers'),
    },
    api: metrics.apiHealth(),
    system: metrics.system(),
  };
}

/** What customers actually use, which is what tells you what to build next. */
async function featureMetrics(ctx) {
  auth.requireAdmin(ctx);

  const { rows } = await query(`
    -- tenant-global: usage counts across every customer, behind requireAdmin.
    SELECT
      (SELECT count(*) FROM vouchers WHERE synced_at > now() - interval '30 days')
                                                                        AS vouchers_30d,
      (SELECT count(*) FROM vouchers v
        WHERE v.vch_type ILIKE '%sale%' AND v.vch_type NOT ILIKE '%order%'
          AND v.synced_at > now() - interval '30 days')                  AS invoices_30d,
      (SELECT count(*) FROM reminders
        WHERE COALESCE(handed_off_at, sent_at) > now() - interval '30 days')
                                                                        AS reminders_30d,
      (SELECT count(*) FROM reminders WHERE channel = 'whatsapp'
        AND COALESCE(handed_off_at, sent_at) > now() - interval '30 days')
                                                                        AS whatsapp_30d,
      (SELECT count(*) FROM reminders WHERE channel = 'sms'
        AND COALESCE(handed_off_at, sent_at) > now() - interval '30 days')
                                                                        AS sms_30d,
      (SELECT count(*) FROM share_log
        WHERE at > now() - interval '30 days')                           AS shares_30d,
      (SELECT count(*) FROM share_log WHERE channel = 'email'
        AND at > now() - interval '30 days')                             AS emails_30d,
      (SELECT count(*) FROM backups
        WHERE created_at > now() - interval '30 days')                   AS backups_30d,
      (SELECT count(*) FROM audit_log WHERE action = 'backup.restore'
        AND at > now() - interval '30 days')                             AS restores_30d,
      (SELECT count(*) FROM audit_log WHERE action = 'export.csv'
        AND at > now() - interval '30 days')                             AS exports_30d,
      (SELECT count(*) FROM audit_log WHERE action = 'doc.download'
        AND at > now() - interval '30 days')                             AS pdfs_30d,
      (SELECT count(*) FROM saved_views)                                 AS saved_views,
      (SELECT count(*) FROM pinned_reports)                              AS pinned_reports
  `);
  const r = rows[0];
  const n = (k) => Number(r[k]);

  /*
   * Reports viewed comes from the request log rather than the database: nothing
   * writes a row when somebody opens a P&L, and adding one purely to count it
   * would put a write on every read of every report.
   */
  const api = metrics.apiHealth(24 * 60 * 60 * 1000);
  const reportViews = api.busiest
    .filter((r2) => /\/v1\/(reports|statements|companies\/.*\/(txn|book))/.test(r2.route))
    .reduce((sum, r2) => sum + r2.calls, 0);

  return {
    window: 'Last 30 days',
    accounting: {
      vouchersSynced: n('vouchers_30d'),
      invoices: n('invoices_30d'),
    },
    messaging: {
      reminders: n('reminders_30d'),
      whatsapp: n('whatsapp_30d'),
      sms: n('sms_30d'),
      emails: n('emails_30d'),
      shares: n('shares_30d'),
    },
    documents: {
      pdfsAndPrints: n('pdfs_30d'),
      csvExports: n('exports_30d'),
      // Since the last restart only, and said so rather than implied.
      reportsViewedSinceRestart: reportViews,
    },
    data: {
      backups: n('backups_30d'),
      restores: n('restores_30d'),
      savedViews: n('saved_views'),
      pinnedReports: n('pinned_reports'),
    },
    /*
     * Not issued by Munim: both need write access to Tally and a paid GSP
     * contract. Reported as zero with the reason attached rather than left out,
     * so a blank on the dashboard is never mistaken for nobody using them.
     */
    compliance: {
      eInvoices: 0,
      eWayBills: 0,
      note: 'Munim does not issue these. Both need write access to Tally and a '
          + 'GSP contract — see sections 10 and 11.',
    },
  };
}

/** Everything at once, for the admin home. */
async function overview(ctx) {
  auth.requireAdmin(ctx);
  const [business, technical, feature] = await Promise.all([
    businessMetrics(ctx), technicalMetrics(ctx), featureMetrics(ctx),
  ]);
  return { business, technical, feature, at: new Date().toISOString() };
}

/**
 * One customer, in full.
 *
 * The screen a support call is answered from, so it leads with what goes wrong:
 * is their connector up, when did it last sync, are they at a limit, did their
 * last payment fail.
 */
async function customer(ctx, orgId) {
  auth.requireAdmin(ctx);

  const { rows: org } = await query('SELECT * FROM orgs WHERE id = $1', [orgId]);
  if (!org.length) throw new HttpError(404, 'NOT_FOUND', 'No such account.');
  const o = org[0];

  const quotas = require('../lib/quotas');
  const [report, companies, people, conns, subs, pays, runs] = await Promise.all([
    quotas.report(o),
    query(`SELECT tally_guid, name, enabled, last_sync_at,
                  (SELECT count(*) FROM vouchers v WHERE v.company_id = c.id) AS vouchers
             FROM companies c WHERE org_id = $1 ORDER BY name`, [orgId]),
    query(`SELECT id, name, email, role, status, last_seen_at, created_at
             FROM users WHERE org_id = $1 ORDER BY created_at`, [orgId]),
    query(`SELECT id, machine_name, status, tally_up, tally_version, app_version,
                  last_seen_at, paired_at, revoked_at, queued_batches
             FROM connectors WHERE org_id = $1 ORDER BY paired_at DESC`, [orgId]),
    query(`SELECT * FROM subscriptions WHERE org_id = $1
            ORDER BY created_at DESC LIMIT 5`, [orgId]),
    query(`SELECT id, status, total_paise, failure_reason, created_at
             FROM payments WHERE org_id = $1 ORDER BY created_at DESC LIMIT 10`, [orgId]),
    query(`SELECT ok, duration_ms, started_at, error, error_kind
             FROM sync_runs WHERE org_id = $1
            ORDER BY started_at DESC LIMIT 10`, [orgId]),
  ]);

  const live = conns.rows.filter((c) => !c.revoked_at);
  const onlineNow = live.filter(
    (c) => c.last_seen_at && Date.now() - new Date(c.last_seen_at) < 10 * 60 * 1000);

  return {
    account: {
      id: o.id, name: o.name, plan: o.plan, planLabel: plans.plan(o.plan).label,
      createdAt: o.created_at, trialEndsAt: o.trial_ends_at,
      messageCredits: o.message_credits, notes: o.notes,
      closingAt: o.delete_due_at,
      billing: { name: o.billing_name, gstin: o.billing_gstin, state: o.billing_state },
    },
    /*
     * The first four things a support call is about, together at the top.
     */
    headline: {
      connectorOnline: onlineNow.length > 0,
      connectors: `${onlineNow.length} of ${live.length} online`,
      lastSync: companies.rows
        .map((c) => c.last_sync_at).filter(Boolean)
        .sort().reverse()[0] ?? null,
      atLimit: report.atLimit,
      lastPaymentFailed: pays.rows[0]?.status === 'failed'
        ? pays.rows[0].failure_reason || 'declined' : null,
    },
    usage: report.lines,
    companies: companies.rows.map((c) => ({
      guid: c.tally_guid, name: c.name, enabled: c.enabled,
      lastSyncAt: c.last_sync_at, vouchers: Number(c.vouchers),
    })),
    people: people.rows,
    connectors: conns.rows,
    subscriptions: subs.rows,
    payments: pays.rows.map((p) => ({
      ...p, totalLabel: money.rupees(p.total_paise),
    })),
    recentSyncs: runs.rows,
  };
}

module.exports = { overview, businessMetrics, technicalMetrics, featureMetrics, customer };
