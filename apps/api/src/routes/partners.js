'use strict';
const crypto = require('crypto');
const { query, tx } = require('../db');
const auth = require('../lib/auth');
const money = require('../lib/money');
const audit = require('../lib/audit');
const plans = require('../lib/plans');
const { HttpError, bad } = require('../lib/http');

/**
 * The channel.
 *
 * Tally is sold in India through a dealer network, and those dealers are
 * already inside their customers' books every month. They are the distribution
 * for this product. A channel that cannot see what it has sold and what it is
 * owed stops selling, so this is a real dashboard rather than a form that emails
 * somebody.
 *
 * A partner is NOT a tenant. They sign in as a person, like everybody else, and
 * partner_users says which partner that person can act for - because a dealer is
 * very often also a Munim customer for their own shop, and those are two
 * different hats on one person.
 */

/*
 * Twenty per cent, for as long as the customer keeps paying.
 *
 * A one-off finder's fee makes a partner sell once and never look at the
 * customer again; a recurring share makes keeping them alive worth something,
 * which is the behaviour that actually matters for churn. Per-partner overrides
 * exist because a large dealer will negotiate.
 */
const DEFAULT_COMMISSION_BPS = 2000;

/** A referral code somebody can read down a phone line. */
function codeFrom(name) {
  const base = String(name).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'PARTNER';
  // Excludes 0/O and 1/I: this gets read aloud and written on paper.
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = crypto.randomBytes(4);
  let tail = '';
  for (let i = 0; i < 4; i++) tail += alphabet[bytes[i] % alphabet.length];
  return `${base}-${tail}`;
}

/** Which partner, if any, this person may act for. */
async function partnerFor(session) {
  const { rows } = await query(
    `SELECT p.*, pu.role AS my_role FROM partners p
       JOIN partner_users pu ON pu.partner_id = p.id
      WHERE pu.user_id = $1 LIMIT 1`, [session.user.id]);
  return rows[0] ?? null;
}

function requirePartner(p) {
  if (!p) throw new HttpError(403, 'NOT_A_PARTNER', 'This account is not a partner.');
  if (p.status === 'pending') {
    throw new HttpError(403, 'PARTNER_PENDING',
      'Your application is still being reviewed. We will email you.');
  }
  if (p.status !== 'active') {
    throw new HttpError(403, 'PARTNER_INACTIVE', 'This partner account is not active.');
  }
  return p;
}

/** Apply to join. Open to anybody signed in. */
async function apply(ctx) {
  const s = auth.requireUser(ctx);

  const existing = await partnerFor(s);
  if (existing) {
    throw bad('ALREADY_APPLIED',
      existing.status === 'pending'
        ? 'You have already applied. We will email you when it is reviewed.'
        : 'You are already a partner.');
  }

  const name = String(ctx.body?.name ?? '').trim();
  if (name.length < 3 || name.length > 80) {
    throw bad('BAD_NAME', 'Give your business name, 3 to 80 characters.');
  }
  const email = String(ctx.body?.email ?? s.user.email ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw bad('BAD_EMAIL', 'Give an email address we can reach you on.');
  }

  const gstin = String(ctx.body?.gstin ?? '').trim().toUpperCase();
  if (gstin) {
    const { isValidGstin } = require('../lib/gstin');
    if (!isValidGstin(gstin)) throw bad('BAD_GSTIN', 'That GSTIN is not valid.');
  }

  /*
   * The code is generated, not chosen.
   *
   * A partner picking their own would take "TALLY" or "MUNIM" and the link
   * would look like it came from us rather than from them.
   */
  let code = codeFrom(name);
  for (let i = 0; i < 5; i++) {
    const { rows } = await query('SELECT 1 FROM partners WHERE lower(code) = lower($1)',
      [code]);
    if (!rows.length) break;
    code = codeFrom(name);
  }

  return tx(async (c) => {
    let partner;
    try {
      const { rows } = await c.query(
        `INSERT INTO partners (name, code, contact_name, email, phone, city, state,
                               gstin, pan, commission_bps)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [name, code, String(ctx.body?.contactName ?? s.user.name ?? '').slice(0, 80),
         email, String(ctx.body?.phone ?? '').replace(/[^\d+]/g, '').slice(0, 15),
         String(ctx.body?.city ?? '').slice(0, 60),
         String(ctx.body?.state ?? '').slice(0, 60),
         gstin, String(ctx.body?.pan ?? '').trim().toUpperCase().slice(0, 10),
         DEFAULT_COMMISSION_BPS]);
      partner = rows[0];
    } catch (e) {
      if (e.code === '23505') {
        throw bad('EMAIL_IN_USE', 'A partner is already registered with that email.');
      }
      throw e;
    }

    await c.query(
      `INSERT INTO partner_users (partner_id, user_id, role) VALUES ($1,$2,'owner')`,
      [partner.id, s.user.id]);

    return {
      id: partner.id,
      name: partner.name,
      code: partner.code,
      status: 'pending',
      message: 'Thanks — we review applications within two working days. Your '
             + `referral code is ${partner.code}, and it starts working the moment `
             + 'you are approved.',
    };
  });
}

/** The partner's own dashboard. */
async function dashboard(ctx) {
  const s = auth.requireUser(ctx);
  const p = await partnerFor(s);

  // A pending application still gets a screen, showing where it stands. An
  // error page for somebody who just applied reads as a rejection.
  if (!p) return { partner: null, canApply: true };
  if (p.status !== 'active') {
    return {
      partner: { name: p.name, code: p.code, status: p.status },
      canApply: false,
      message: p.status === 'pending'
        ? 'Your application is being reviewed. We will email you.'
        : 'This partner account is not active. Get in touch if that is unexpected.',
    };
  }

  const [customers, leads, earnings, recent, payouts] = await Promise.all([
    query(`SELECT o.id, o.name, o.plan, o.partner_at, o.created_at,
                  (SELECT status FROM subscriptions su
                    WHERE su.org_id = o.id
                      AND su.status IN ('active','grace','past_due','trialing')
                    LIMIT 1) AS sub_status,
                  (SELECT COALESCE(sum(total_paise),0) FROM payments pa
                    WHERE pa.org_id = o.id AND pa.status = 'paid') AS paid
             FROM orgs o WHERE o.partner_id = $1 ORDER BY o.partner_at DESC`, [p.id]),
    query(`SELECT * FROM partner_leads WHERE partner_id = $1
            ORDER BY updated_at DESC LIMIT 200`, [p.id]),
    query(`SELECT status, COALESCE(sum(amount_paise),0)::bigint AS total, count(*)::int AS n
             FROM commissions WHERE partner_id = $1 GROUP BY status`, [p.id]),
    query(`SELECT c.*, o.name AS current_name FROM commissions c
             LEFT JOIN orgs o ON o.id = c.org_id
            WHERE c.partner_id = $1 ORDER BY c.earned_at DESC LIMIT 50`, [p.id]),
    query(`SELECT * FROM payouts WHERE partner_id = $1
            ORDER BY created_at DESC LIMIT 20`, [p.id]),
  ]);

  const by = Object.fromEntries(earnings.rows.map((r) => [r.status, r]));
  const sum = (k) => Number(by[k]?.total ?? 0);

  const paying = customers.rows.filter(
    (c) => c.sub_status && ['active', 'grace', 'past_due'].includes(c.sub_status));

  return {
    partner: {
      id: p.id, name: p.name, code: p.code, status: p.status,
      commissionPercent: p.commission_bps / 100,
      commissionMonths: p.commission_months,
      commissionNote: p.commission_months
        ? `${p.commission_bps / 100}% of what each customer pays, for their first `
          + `${p.commission_months} months.`
        : `${p.commission_bps / 100}% of what each customer pays, for as long as `
          + 'they keep paying.',
      referralLink: `${process.env.PUBLIC_WEB_URL || ''}/?ref=${p.code}`,
    },

    summary: {
      customers: customers.rows.length,
      payingCustomers: paying.length,
      leads: leads.rows.filter((l) => !['won', 'lost'].includes(l.status)).length,
      /*
       * Four separate figures rather than one "earnings" number, because they
       * mean four different things to somebody deciding whether to keep
       * selling: what is owed, what is agreed, what has arrived, and what fell
       * through.
       */
      pendingPaise: sum('pending'),
      approvedPaise: sum('approved'),
      paidPaise: sum('paid'),
      reversedPaise: sum('reversed'),
      pendingLabel: money.rupees(sum('pending')),
      approvedLabel: money.rupees(sum('approved')),
      paidLabel: money.rupees(sum('paid')),
      // What could actually be paid out today.
      dueLabel: money.rupees(sum('approved')),
    },

    customers: customers.rows.map((c) => ({
      id: c.id,
      name: c.name || '(not named yet)',
      plan: plans.plan(c.plan).label,
      subscription: c.sub_status ?? 'none',
      introducedAt: c.partner_at,
      // What THEY have paid, which is what the commission is a share of.
      paidPaise: Number(c.paid),
      paidLabel: money.rupees(c.paid),
    })),

    leads: leads.rows,
    commissions: recent.rows.map((c) => ({
      id: c.id,
      customer: c.current_name ?? c.org_name,
      basePaise: Number(c.base_paise),
      ratePercent: c.rate_bps / 100,
      amountPaise: Number(c.amount_paise),
      amountLabel: money.rupees(c.amount_paise),
      status: c.status,
      earnedAt: c.earned_at,
      note: c.note,
    })),
    payouts: payouts.rows.map((x) => ({
      ...x,
      amountLabel: money.rupees(x.amount_paise),
    })),
  };
}

/** Add or update a lead. */
async function saveLead(ctx, id) {
  const s = auth.requireUser(ctx);
  const p = requirePartner(await partnerFor(s));

  const business = String(ctx.body?.business ?? '').trim();
  if (!id && (business.length < 2 || business.length > 100)) {
    throw bad('BAD_BUSINESS', 'Give the business a name.');
  }

  const status = ['new', 'contacted', 'demo', 'trial', 'won', 'lost']
    .includes(ctx.body?.status) ? ctx.body.status : null;

  if (id) {
    const { rows } = await query(
      `UPDATE partner_leads
          SET business = COALESCE(NULLIF($3,''), business),
              contact_name = COALESCE($4, contact_name),
              phone = COALESCE($5, phone),
              email = COALESCE($6, email),
              city = COALESCE($7, city),
              notes = COALESCE($8, notes),
              status = COALESCE($9, status),
              lost_reason = COALESCE($10, lost_reason),
              updated_at = now()
        WHERE id = $1 AND partner_id = $2 RETURNING *`,
      [id, p.id, business,
       ctx.body?.contactName ?? null, ctx.body?.phone ?? null, ctx.body?.email ?? null,
       ctx.body?.city ?? null, ctx.body?.notes ?? null, status,
       ctx.body?.lostReason ?? null]);
    if (!rows.length) throw new HttpError(404, 'NOT_FOUND', 'No such lead.');
    return { lead: rows[0] };
  }

  const { rows } = await query(
    `INSERT INTO partner_leads (partner_id, business, contact_name, phone, email,
                                city, notes, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8,'new')) RETURNING *`,
    [p.id, business, String(ctx.body?.contactName ?? '').slice(0, 80),
     String(ctx.body?.phone ?? '').slice(0, 20),
     String(ctx.body?.email ?? '').slice(0, 120),
     String(ctx.body?.city ?? '').slice(0, 60),
     String(ctx.body?.notes ?? '').slice(0, 1000), status]);
  return { lead: rows[0] };
}

async function deleteLead(ctx, id) {
  const s = auth.requireUser(ctx);
  const p = requirePartner(await partnerFor(s));
  const { rowCount } = await query(
    'DELETE FROM partner_leads WHERE id = $1 AND partner_id = $2', [id, p.id]);
  if (!rowCount) throw new HttpError(404, 'NOT_FOUND', 'No such lead.');
  return { deleted: true };
}

/**
 * Attribute a new account to a partner.
 *
 * Called at sign-up with whatever referral code was carried through. Silently
 * does nothing for an unknown or inactive code rather than failing the sign-up:
 * a customer must never be blocked from creating an account because a partner's
 * status changed while they were reading the landing page.
 */
async function attribute(orgId, code) {
  if (!code) return { attributed: false };
  try {
    const { rows } = await query(
      `SELECT id FROM partners WHERE lower(code) = lower($1) AND status = 'active'`,
      [String(code).trim()]);
    if (!rows.length) return { attributed: false, reason: 'unknown code' };

    /*
     * Only if the account has no partner yet. An account belongs to exactly one
     * introducing partner for ever - re-attributing later is how two partners
     * end up claiming the same customer.
     */
    const { rowCount } = await query(
      `UPDATE orgs SET partner_id = $2, partner_at = now()
        WHERE id = $1 AND partner_id IS NULL`, [orgId, rows[0].id]);

    return { attributed: rowCount > 0, partnerId: rows[0].id };
  } catch (e) {
    console.warn('  could not attribute referral:', e.message);
    return { attributed: false, error: e.message };
  }
}

/**
 * Turn one paid payment into a commission line.
 *
 * Idempotent on (partner, payment) through a unique index rather than a check:
 * a webhook replay or a re-run of the earning job must never pay twice, and
 * check-then-insert loses that race.
 */
async function earnOn(payment) {
  const { rows: org } = await query(
    `SELECT o.id, o.name, o.partner_id, o.partner_at, p.commission_bps,
            p.commission_months, p.status
       FROM orgs o JOIN partners p ON p.id = o.partner_id
      WHERE o.id = $1`, [payment.org_id]);
  if (!org.length) return { earned: false, reason: 'no partner' };

  const o = org[0];
  if (o.status !== 'active') return { earned: false, reason: 'partner not active' };

  /*
   * A commission window that has run out earns nothing more.
   *
   * Checked against when the customer was introduced, not when they paid: the
   * promise was "their first N months", and measuring from each payment would
   * make the window never close.
   */
  if (o.commission_months) {
    const months = (Date.now() - new Date(o.partner_at)) / (30.44 * 86400000);
    if (months > o.commission_months) {
      return { earned: false, reason: 'commission period ended' };
    }
  }

  /*
   * Computed on the money before tax, not the invoice total.
   *
   * GST collected is not revenue - it is passed to the government - and paying
   * a share of it would mean paying commission out of tax.
   */
  const base = Math.max(0, Number(payment.subtotal_paise) - Number(payment.discount_paise));
  const amount = money.roundHalfUp((base * o.commission_bps) / 10000);
  if (amount <= 0) return { earned: false, reason: 'nothing to earn on' };

  const { rows } = await query(
    `INSERT INTO commissions (partner_id, org_id, org_name, payment_id, base_paise,
                              rate_bps, amount_paise)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (partner_id, payment_id) WHERE payment_id IS NOT NULL DO NOTHING
     RETURNING *`,
    [o.partner_id, o.id, o.name ?? '', payment.id, base, o.commission_bps, amount]);

  if (!rows.length) return { earned: false, reason: 'already earned' };
  return { earned: true, amountPaise: amount, commission: rows[0] };
}

/**
 * Reverse a commission when the payment behind it is refunded.
 *
 * Marked reversed rather than deleted, so a partner can see why a figure moved.
 * A number that quietly shrinks is the fastest way to lose a channel's trust.
 */
async function reverseFor(paymentId, note = 'payment refunded') {
  const { rowCount } = await query(
    `UPDATE commissions SET status = 'reversed', note = $2
      WHERE payment_id = $1 AND status IN ('pending', 'approved')`, [paymentId, note]);
  return { reversed: rowCount };
}

// --- what the operator does -------------------------------------------------

/** Every partner, for the admin console. */
async function list(ctx) {
  auth.requireAdmin(ctx);
  const { rows } = await query(`
    -- tenant-global: the partner programme spans every customer by design and
    -- is only reachable behind requireAdmin.
    SELECT p.*,
           (SELECT count(*) FROM orgs o WHERE o.partner_id = p.id)::int AS customers,
           (SELECT count(*) FROM partner_leads l WHERE l.partner_id = p.id)::int AS leads,
           (SELECT COALESCE(sum(c.amount_paise),0) FROM commissions c
             WHERE c.partner_id = p.id AND c.status = 'approved') AS due,
           (SELECT COALESCE(sum(c.amount_paise),0) FROM commissions c
             WHERE c.partner_id = p.id AND c.status = 'paid') AS paid
      FROM partners p ORDER BY p.applied_at DESC`);

  return {
    partners: rows.map((p) => ({
      id: p.id, name: p.name, code: p.code, email: p.email, phone: p.phone,
      city: p.city, state: p.state, gstin: p.gstin,
      status: p.status,
      commissionPercent: p.commission_bps / 100,
      commissionMonths: p.commission_months,
      customers: p.customers, leads: p.leads,
      duePaise: Number(p.due), dueLabel: money.rupees(p.due),
      paidPaise: Number(p.paid), paidLabel: money.rupees(p.paid),
      appliedAt: p.applied_at, approvedAt: p.approved_at,
      // Never the full account number, even to staff. The last four is enough
      // to confirm a payout went to the right place.
      bank: p.bank_account
        ? `${p.bank_name} ····${p.bank_account.slice(-4)}` : '',
    })),
    defaultCommissionPercent: DEFAULT_COMMISSION_BPS / 100,
  };
}

/** Approve, pause or change a partner's terms. */
async function update(ctx, id) {
  auth.requireAdmin(ctx);
  const b = ctx.body || {};

  const status = ['pending', 'active', 'paused', 'rejected'].includes(b.status)
    ? b.status : null;

  /*
   * A rate is taken in per cent from the screen and stored in basis points, so
   * 12.5% survives. Clamped rather than rejected: a typo of 200% should become
   * something sane, not a support ticket.
   */
  const bps = b.commissionPercent === undefined ? null
    : Math.max(0, Math.min(10000, Math.round(Number(b.commissionPercent) * 100)));

  const { rows } = await query(
    `UPDATE partners
        SET status = COALESCE($2, status),
            commission_bps = COALESCE($3, commission_bps),
            commission_months = CASE WHEN $4 THEN $5::int ELSE commission_months END,
            notes = COALESCE($6, notes),
            bank_name = COALESCE($7, bank_name),
            bank_account = COALESCE($8, bank_account),
            bank_ifsc = COALESCE($9, bank_ifsc),
            approved_at = CASE WHEN $2 = 'active' AND approved_at IS NULL
                               THEN now() ELSE approved_at END,
            approved_by = CASE WHEN $2 = 'active' AND approved_by IS NULL
                               THEN $10 ELSE approved_by END
      WHERE id = $1 RETURNING *`,
    [id, status, bps,
     b.commissionMonths !== undefined,
     b.commissionMonths === null ? null : Number(b.commissionMonths) || null,
     b.notes ?? null, b.bankName ?? null, b.bankAccount ?? null, b.bankIfsc ?? null,
     ctx.session?.user?.id ?? null]);
  if (!rows.length) throw new HttpError(404, 'NOT_FOUND', 'No such partner.');

  await audit.record(ctx, 'partner.update', {
    entityId: id, entityName: rows[0].name, after: { status: rows[0].status },
  });

  return { partner: { id: rows[0].id, name: rows[0].name, status: rows[0].status } };
}

/** Approve the commissions that are ready to be paid. */
async function approveCommissions(ctx, partnerId) {
  auth.requireAdmin(ctx);
  const { rowCount } = await query(
    `UPDATE commissions SET status = 'approved'
      WHERE partner_id = $1 AND status = 'pending'`, [partnerId]);
  return { approved: rowCount };
}

/**
 * Pay a partner what is approved.
 *
 * The payout and the lines it covers move together, so a crash halfway cannot
 * leave money marked paid with no payout, or a payout covering nothing.
 */
async function payout(ctx, partnerId) {
  auth.requireAdmin(ctx);

  return tx(async (c) => {
    const { rows: lines } = await c.query(
      `SELECT id, amount_paise FROM commissions
        WHERE partner_id = $1 AND status = 'approved' FOR UPDATE`, [partnerId]);
    if (!lines.length) throw bad('NOTHING_DUE', 'There is nothing approved to pay.');

    const total = lines.reduce((a, l) => a + Number(l.amount_paise), 0);

    const { rows: p } = await c.query(
      `INSERT INTO payouts (partner_id, amount_paise, lines, reference, created_by, note)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [partnerId, total, lines.length,
       String(ctx.body?.reference ?? '').slice(0, 80),
       ctx.session?.user?.id ?? null, String(ctx.body?.note ?? '').slice(0, 300)]);

    await c.query(
      `UPDATE commissions SET status = 'paid', payout_id = $2
        WHERE id = ANY($1::uuid[])`, [lines.map((l) => l.id), p[0].id]);

    await audit.record(ctx, 'partner.payout', {
      entityId: partnerId,
      entityName: money.rupees(total),
      meta: { lines: lines.length },
    });

    return {
      payout: { ...p[0], amountLabel: money.rupees(total) },
      message: `${money.rupees(total)} across ${lines.length} commission `
             + `line${lines.length === 1 ? '' : 's'} marked paid.`,
    };
  });
}

module.exports = {
  apply, dashboard, saveLead, deleteLead, attribute, earnOn, reverseFor,
  list, update, approveCommissions, payout, partnerFor,
  DEFAULT_COMMISSION_BPS, codeFrom,
};
