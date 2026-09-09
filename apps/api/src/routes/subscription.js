'use strict';
const { query, tx } = require('../db');
const auth = require('../lib/auth');
const perms = require('../lib/permissions');
const plans = require('../lib/plans');
const quotas = require('../lib/quotas');
const money = require('../lib/money');
const audit = require('../lib/audit');
const { HttpError, bad } = require('../lib/http');

/**
 * Selling the thing.
 *
 * No gateway is wired up here. That is deliberate: taking money needs a
 * merchant account and a signed contract, and every part of subscription
 * handling that can be wrong independently of the gateway - proration, tax,
 * grace periods, invoice numbering - is wrong in exactly the same way whether
 * the money arrives through Razorpay or a bank transfer. So the ledger is
 * built and correct first, and `recordPayment` is the seam a gateway webhook
 * plugs into later.
 */

/*
 * Fourteen days after a payment fails before anything stops working.
 *
 * A shop that loses its numbers the hour a card expires does not renew; it
 * phones, angry, and then leaves. Two weeks covers a replaced card, a bank
 * holiday and an owner who was travelling, which is most real failures.
 */
const GRACE_DAYS = 14;

const addMonths = (d, n) => {
  const out = new Date(d);
  const day = out.getDate();
  out.setMonth(out.getMonth() + n);
  /*
   * The 31st of a month that has no 31st.
   *
   * JavaScript rolls that into the next month, so a subscription starting on
   * 31 January would renew on 3 March and drift a few days every year. Clamped
   * to the last day instead.
   */
  if (out.getDate() < day) out.setDate(0);
  return out;
};

const periodEnd = (from, term) => addMonths(from, term === 'yearly' ? 12 : 1);

/** Yearly is ten months' money for twelve, which is the usual bargain. */
function priceFor(planKey, term) {
  const monthly = plans.plan(planKey).pricePaise;
  return term === 'yearly' ? monthly * 10 : monthly;
}

/** The live subscription, or null. */
async function current(orgId) {
  const { rows } = await query(
    `SELECT * FROM subscriptions
      WHERE org_id = $1 AND status IN ('trialing','active','past_due','grace')
      ORDER BY created_at DESC LIMIT 1`, [orgId]);
  return rows[0] ?? null;
}

/** Everything a billing screen needs, in one call. */
async function overview(ctx) {
  const s = perms.require(auth.requireUser(ctx), 'settings', 'read');

  const { rows: orgRows } = await query('SELECT * FROM orgs WHERE id = $1', [s.org.id]);
  const org = orgRows[0];
  const sub = await current(s.org.id);

  const { rows: history } = await query(
    `SELECT p.*, i.number AS invoice_number, i.id AS invoice_id
       FROM payments p
       LEFT JOIN billing_invoices i ON i.payment_id = p.id
      WHERE p.org_id = $1 ORDER BY p.created_at DESC LIMIT 50`, [s.org.id]);

  const { rows: extras } = await query(
    `SELECT kind, sum(quantity)::int AS quantity, count(*)::int AS purchases
       FROM addons WHERE org_id = $1 AND (expires_at IS NULL OR expires_at > now())
      GROUP BY kind`, [s.org.id]);

  const report = await quotas.report(org);
  const planNow = plans.plan(org.plan);

  return {
    subscription: sub ? {
      id: sub.id,
      plan: sub.plan,
      planLabel: plans.plan(sub.plan).label,
      status: sub.status,
      term: sub.term,
      pricePaise: Number(sub.price_paise),
      priceLabel: money.rupees(sub.price_paise),
      renewsAt: sub.cancel_at_end ? null : sub.current_until,
      endsAt: sub.cancel_at_end ? sub.current_until : null,
      pendingPlan: sub.pending_plan,
      pendingPlanLabel: sub.pending_plan ? plans.plan(sub.pending_plan).label : null,
      cancelAtEnd: sub.cancel_at_end,
      graceUntil: sub.grace_until,
      coupon: sub.coupon_code || null,
      /*
       * Said in words, because "past_due" in front of a shop owner is not a
       * status, it is a puzzle.
       */
      message: statusMessage(sub),
    } : null,

    plan: {
      key: org.plan,
      label: planNow.label,
      pricePaise: planNow.pricePaise,
    },
    trial: plans.trialState(org),
    usage: report.lines,
    atLimit: report.atLimit,
    payments: history.map(paymentOut),
    addons: extras,
    plans: plans.catalogue(),
    note: 'Prices exclude GST. An invoice is issued for every payment.',
  };
}

function statusMessage(sub) {
  const until = new Date(sub.current_until).toDateString();
  switch (sub.status) {
    case 'trialing':
      return `Free trial until ${until}.`;
    case 'active':
      return sub.cancel_at_end
        ? `Cancelled. Everything keeps working until ${until}.`
        : `Renews on ${until}.`;
    case 'past_due':
      return 'The last payment did not go through. Everything still works — '
           + 'please update your payment method.';
    case 'grace':
      return `The last payment did not go through. Everything keeps working `
           + `until ${new Date(sub.grace_until).toDateString()}.`;
    case 'cancelled': return 'Cancelled.';
    default: return 'Expired.';
  }
}

const paymentOut = (p) => ({
  id: p.id,
  status: p.status,
  subtotalPaise: Number(p.subtotal_paise),
  discountPaise: Number(p.discount_paise),
  taxPaise: Number(p.tax_paise),
  totalPaise: Number(p.total_paise),
  totalLabel: money.rupees(p.total_paise),
  method: p.method,
  failureReason: p.failure_reason,
  periodFrom: p.period_from,
  periodUntil: p.period_until,
  paidAt: p.paid_at,
  createdAt: p.created_at,
  invoiceNumber: p.invoice_number ?? null,
  invoiceId: p.invoice_id ?? null,
});

/** What a plan change would cost, before anybody commits to it. */
async function preview(ctx) {
  const s = perms.require(auth.requireUser(ctx), 'settings', 'read');
  const planKey = String(ctx.body?.plan ?? ctx.url.searchParams.get('plan') ?? '');
  const term = ctx.body?.term ?? ctx.url.searchParams.get('term') ?? 'monthly';

  if (!plans.PLANS[planKey] || planKey === 'internal') throw bad('BAD_PLAN', 'No such plan.');
  const coupon = await couponFor(ctx.body?.coupon ?? ctx.url.searchParams.get('coupon'), planKey);
  const { rows: org } = await query('SELECT * FROM orgs WHERE id = $1', [s.org.id]);
  const sub = await current(s.org.id);
  const price = priceFor(planKey, term);

  const q = money.quote({
    pricePaise: price,
    coupon,
    buyerState: org[0].billing_state ?? '',
  });

  /*
   * A mid-term change is prorated; a fresh subscription is not.
   *
   * Quoting a full month to somebody three weeks into one they already paid
   * for is how a customer decides the billing is not to be trusted.
   */
  let proration = null;
  if (sub && sub.status !== 'trialing' && sub.plan !== planKey) {
    proration = money.prorate({
      fromPaise: Number(sub.price_paise),
      toPaise: price,
      periodFrom: sub.current_from,
      periodUntil: sub.current_until,
    });
  }

  const downgrade = sub && plans.plan(planKey).order < plans.plan(sub.plan).order;

  return {
    plan: planKey,
    planLabel: plans.plan(planKey).label,
    term,
    quote: q,
    proration,
    downgrade,
    /*
     * A downgrade takes effect at the end of the period, so it must not be
     * quoted as if money changes hands today.
     */
    dueNowPaise: downgrade ? 0 : (proration ? proration.duePaise : q.totalPaise),
    message: downgrade
      ? `You keep ${plans.plan(sub.plan).label} until `
        + `${new Date(sub.current_until).toDateString()}, then move to `
        + `${plans.plan(planKey).label}. Nothing is charged today.`
      : proration
        ? `${money.rupees(proration.duePaise)} for the ${proration.daysLeft} days `
          + 'left in this period, then the full price after that.'
        : `${money.rupees(q.totalPaise)} including GST.`,
  };
}

/** Look a coupon up and check it may actually be used. */
async function couponFor(code, planKey) {
  const c = String(code ?? '').trim().toUpperCase();
  if (!c) return null;

  const { rows } = await query('SELECT * FROM coupons WHERE upper(code) = $1', [c]);
  if (!rows.length) throw bad('BAD_COUPON', 'That code is not one of ours.');
  const coupon = rows[0];

  if (!coupon.active) throw bad('BAD_COUPON', 'That code is no longer active.');
  if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
    throw bad('BAD_COUPON', 'That code has expired.');
  }
  if (coupon.max_redemptions != null && coupon.redeemed >= coupon.max_redemptions) {
    throw bad('BAD_COUPON', 'That code has been used up.');
  }
  if (coupon.plans.length && planKey && !coupon.plans.includes(planKey)) {
    throw bad('BAD_COUPON',
      `That code works on ${coupon.plans.map((p) => plans.plan(p).label).join(' or ')}.`);
  }
  return coupon;
}

/**
 * Start, upgrade or downgrade.
 *
 * One entry point rather than three, because they are the same decision with
 * different arithmetic, and three routes would drift into three different
 * answers to "when does this take effect".
 */
async function subscribe(ctx) {
  const s = perms.require(auth.requireUser(ctx), 'settings', 'update');
  if (s.user.role !== 'owner' && s.user.role !== 'platform_admin') {
    throw new HttpError(403, 'OWNER_ONLY', 'Only an owner can change the plan.');
  }

  const planKey = String(ctx.body?.plan ?? '');
  const term = ctx.body?.term === 'yearly' ? 'yearly' : 'monthly';
  if (!plans.PLANS[planKey] || planKey === 'internal') throw bad('BAD_PLAN', 'No such plan.');
  const coupon = await couponFor(ctx.body?.coupon, planKey);
  const sub = await current(s.org.id);
  const price = priceFor(planKey, term);

  return tx(async (c) => {
    const now = new Date();

    /*
     * A downgrade is scheduled, not applied.
     *
     * They paid for this period at the higher plan. Cutting them to the lower
     * one today takes away what they already bought, and the customer is
     * always right about that.
     */
    if (sub && sub.status !== 'trialing'
        && plans.plan(planKey).order < plans.plan(sub.plan).order) {
      await c.query(
        `UPDATE subscriptions SET pending_plan = $2, pending_term = $3, updated_at = now()
          WHERE id = $1 AND org_id = $4`, [sub.id, planKey, term, s.org.id]);

      await audit.record(ctx, 'billing.downgrade', {
        entityId: sub.id, before: { plan: sub.plan }, after: { plan: planKey },
      });

      return {
        scheduled: true,
        effectiveAt: sub.current_until,
        message: `You keep ${plans.plan(sub.plan).label} until `
               + `${new Date(sub.current_until).toDateString()}, then move to `
               + `${plans.plan(planKey).label}. Nothing is charged today.`,
      };
    }

    const from = now;
    const until = periodEnd(from, term);

    if (sub) {
      await c.query(
        `UPDATE subscriptions
            SET plan = $2, term = $3, price_paise = $4, status = 'active',
                current_from = $5, current_until = $6, pending_plan = NULL,
                pending_term = NULL, cancel_at_end = false, grace_until = NULL,
                coupon_code = $7, updated_at = now()
          WHERE id = $1 AND org_id = $8`,
        [sub.id, planKey, term, price, from, until, coupon?.code ?? '', s.org.id]);
    } else {
      await c.query(
        `INSERT INTO subscriptions
           (org_id, plan, status, term, price_paise, current_from, current_until, coupon_code)
         VALUES ($1,$2,'active',$3,$4,$5,$6,$7)`,
        [s.org.id, planKey, term, price, from, until, coupon?.code ?? '']);
    }

    // The plan on the org is what every quota check reads, so it moves with the
    // subscription or the two disagree about what the customer bought.
    await c.query('UPDATE orgs SET plan = $2 WHERE id = $1', [s.org.id, planKey]);

    if (coupon) {
      await c.query('UPDATE coupons SET redeemed = redeemed + 1 WHERE code = $1', [coupon.code]);
    }

    await audit.record(ctx, 'billing.subscribe', {
      entityName: plans.plan(planKey).label,
      before: sub ? { plan: sub.plan, term: sub.term } : null,
      after: { plan: planKey, term, coupon: coupon?.code ?? '' },
    });

    return {
      plan: planKey,
      planLabel: plans.plan(planKey).label,
      term,
      renewsAt: until,
      message: `You are on ${plans.plan(planKey).label}. `
             + `It renews on ${until.toDateString()}.`,
    };
  });
}

/**
 * Cancel.
 *
 * At the end of the period they paid for, never immediately. An immediate
 * cancel is a refund question, and refunds are a human decision.
 */
async function cancel(ctx) {
  const s = perms.require(auth.requireUser(ctx), 'settings', 'update');
  const sub = await current(s.org.id);
  if (!sub) throw bad('NO_SUBSCRIPTION', 'There is nothing to cancel.');

  await query(
    `UPDATE subscriptions SET cancel_at_end = true, cancelled_at = now(), updated_at = now()
      WHERE id = $1 AND org_id = $2`, [sub.id, s.org.id]);

  await audit.record(ctx, 'billing.cancel', { entityId: sub.id });

  return {
    endsAt: sub.current_until,
    message: `Cancelled. Everything keeps working until `
           + `${new Date(sub.current_until).toDateString()}, and you can undo this `
           + 'any time before then.',
  };
}

/** Changed their mind before the period ran out. */
async function resume(ctx) {
  const s = perms.require(auth.requireUser(ctx), 'settings', 'update');
  const sub = await current(s.org.id);
  if (!sub || !sub.cancel_at_end) throw bad('NOT_CANCELLED', 'This is not cancelled.');

  await query(
    `UPDATE subscriptions SET cancel_at_end = false, cancelled_at = NULL, updated_at = now()
      WHERE id = $1 AND org_id = $2`, [sub.id, s.org.id]);
  await audit.record(ctx, 'billing.resume', { entityId: sub.id });

  return { message: `Back on. It renews on ${new Date(sub.current_until).toDateString()}.` };
}

/**
 * Record a payment, successful or not.
 *
 * The seam a gateway webhook plugs into. Idempotent on (gateway, gateway_ref),
 * enforced by a unique index rather than by checking first: a gateway retries
 * webhooks, sometimes concurrently, and a check-then-insert loses that race and
 * double-charges the invoice sequence.
 */
async function recordPayment(orgId, {
  subscriptionId = null, status, gateway = '', gatewayRef = '', method = '',
  subtotalPaise = 0, discountPaise = 0, taxPaise = 0, totalPaise = 0,
  failureReason = '', periodFrom = null, periodUntil = null, ctx = null,
}) {
  return tx(async (c) => {
    /*
     * ON CONFLICT DO NOTHING rather than catching the unique violation.
     *
     * Catching it works outside a transaction and not inside one: the failed
     * statement aborts the whole transaction, and every command after it -
     * including the SELECT that fetches the row already there - is refused
     * with "current transaction is aborted". A savepoint would work; letting
     * Postgres skip the row is simpler and has no failed statement at all.
     */
    const { rows: inserted } = await c.query(
      `INSERT INTO payments (org_id, subscription_id, status, gateway, gateway_ref, method,
                             subtotal_paise, discount_paise, tax_paise, total_paise,
                             failure_reason, period_from, period_until, paid_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
               CASE WHEN $3 = 'paid' THEN now() ELSE NULL END)
       ON CONFLICT (gateway, gateway_ref) WHERE gateway_ref <> '' DO NOTHING
       RETURNING *`,
      [orgId, subscriptionId, status, gateway, gatewayRef, method,
       subtotalPaise, discountPaise, taxPaise, totalPaise,
       failureReason, periodFrom, periodUntil]);

    if (!inserted.length) {
      // Already applied. Hand back what was recorded the first time rather than
      // erroring: a webhook that gets a 500 retries for ever.
      const { rows } = await c.query(
        `SELECT p.*, i.number AS invoice_number FROM payments p
           LEFT JOIN billing_invoices i ON i.payment_id = p.id
          WHERE p.gateway = $1 AND p.gateway_ref = $2 AND p.org_id = $3`,
        [gateway, gatewayRef, orgId]);
      return { payment: paymentOut(rows[0]), invoice: null, replayed: true };
    }
    const payment = inserted[0];

    if (status === 'failed') {
      /*
       * A failed payment does not stop anything today. It starts the clock.
       */
      if (subscriptionId) {
        await c.query(
          `UPDATE subscriptions
              SET status = 'grace', grace_until = now() + ($2 || ' days')::interval,
                  updated_at = now()
            WHERE id = $1 AND org_id = $3 AND status IN ('active','past_due')`,
          [subscriptionId, String(GRACE_DAYS), orgId]);
      }
      return { payment: paymentOut(payment), invoice: null, replayed: false };
    }

    if (status !== 'paid') {
      return { payment: paymentOut(payment), invoice: null, replayed: false };
    }

    // Paid: the period is extended and an invoice is issued.
    if (subscriptionId) {
      await c.query(
        `UPDATE subscriptions
            SET status = 'active', grace_until = NULL,
                current_from = COALESCE($2, current_from),
                current_until = COALESCE($3, current_until),
                updated_at = now()
          WHERE id = $1 AND org_id = $4`, [subscriptionId, periodFrom, periodUntil, orgId]);
    }

    const invoice = await issueInvoice(c, orgId, payment);

    /*
     * The introducing partner earns here, in the same breath as the invoice.
     *
     * Deliberately not on a nightly job: a partner watching their dashboard
     * after closing a sale should see it, and a job that runs at 2am means the
     * first thing they see is nothing.
     *
     * Never allowed to fail the payment - the money has already moved, and a
     * commission line can be reconciled later where a lost payment cannot.
     */
    try {
      const partners = require('./partners');
      await partners.earnOn(payment);
    } catch (e) {
      console.warn('  could not record partner commission:', e.message);
    }

    return { payment: paymentOut(payment), invoice, replayed: false };
  });
}

/**
 * Munim's own GST invoice for one payment.
 *
 * The number is a legal sequence with no gaps, so it is allocated under a
 * transaction-scoped advisory lock rather than from max(seq)+1 read outside
 * one. Two payments landing in the same millisecond - which is exactly what a
 * gateway retrying a batch looks like - would otherwise both read the same
 * maximum and one would fail the unique index after the money had moved.
 *
 * Issued only for a payment that succeeded: a declined card must not consume a
 * number, because the gap it leaves is the thing an auditor asks about.
 */
async function issueInvoice(c, orgId, payment) {
  const { rows: org } = await c.query('SELECT * FROM orgs WHERE id = $1', [orgId]);
  const o = org[0];
  const fy = money.financialYear(payment.created_at);

  // One writer at a time per financial year, released when the transaction ends.
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`munim-invoice-${fy}`]);

  const { rows: last } = await c.query(
    'SELECT COALESCE(max(seq), 0) AS n FROM billing_invoices WHERE fy = $1', [fy]);
  const seq = Number(last[0].n) + 1;
  const number = `MUN/${fy}/${String(seq).padStart(5, '0')}`;

  const state = o.billing_state ?? '';
  const gst = money.gstFor(
    Number(payment.subtotal_paise) - Number(payment.discount_paise), state);

  const { rows } = await c.query(
    `INSERT INTO billing_invoices
       (org_id, payment_id, number, fy, seq, bill_to_name, bill_to_gstin, bill_to_state,
        bill_to_address, place_of_supply, description, subtotal_paise, discount_paise,
        cgst_paise, sgst_paise, igst_paise, total_paise)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING *`,
    [orgId, payment.id, number, fy, seq,
     o.billing_name || o.name || '', o.billing_gstin || '', state,
     o.billing_address || '', state || money.HOME_STATE,
     'Munim subscription', payment.subtotal_paise, payment.discount_paise,
     gst.cgst, gst.sgst, gst.igst, payment.total_paise]);

  return invoiceOut(rows[0]);
}

const invoiceOut = (i) => ({
  id: i.id,
  number: i.number,
  issuedAt: i.issued_at,
  billTo: {
    name: i.bill_to_name, gstin: i.bill_to_gstin,
    state: i.bill_to_state, address: i.bill_to_address,
  },
  placeOfSupply: i.place_of_supply,
  description: i.description,
  hsn: i.hsn,
  subtotalPaise: Number(i.subtotal_paise),
  discountPaise: Number(i.discount_paise),
  cgstPaise: Number(i.cgst_paise),
  sgstPaise: Number(i.sgst_paise),
  igstPaise: Number(i.igst_paise),
  totalPaise: Number(i.total_paise),
  seller: {
    name: 'Munim', state: money.HOME_STATE, stateCode: money.HOME_STATE_CODE,
    gstin: process.env.MUNIM_GSTIN || '',
  },
});

/** The customer's own copy of one of Munim's invoices. */
async function invoice(ctx, id) {
  const s = perms.require(auth.requireUser(ctx), 'settings', 'read');
  const { rows } = await query(
    'SELECT * FROM billing_invoices WHERE id = $1 AND org_id = $2', [id, s.org.id]);
  if (!rows.length) throw new HttpError(404, 'NOT_FOUND', 'No such invoice.');
  return { invoice: invoiceOut(rows[0]) };
}

/** Every invoice Munim has issued this customer. */
async function invoices(ctx) {
  const s = perms.require(auth.requireUser(ctx), 'settings', 'read');
  const { rows } = await query(
    `SELECT * FROM billing_invoices WHERE org_id = $1 ORDER BY issued_at DESC LIMIT 200`,
    [s.org.id]);
  return { invoices: rows.map(invoiceOut) };
}

/** Where the invoice should be addressed, and which GST applies. */
async function setBilling(ctx) {
  const s = perms.require(auth.requireUser(ctx), 'settings', 'update');
  const b = ctx.body || {};

  const gstin = String(b.gstin ?? '').trim().toUpperCase();
  if (gstin) {
    const { isValidGstin } = require('../lib/gstin');
    if (!isValidGstin(gstin)) throw bad('BAD_GSTIN', 'That GSTIN is not valid.');
  }

  const { rows: before } = await query(
    'SELECT billing_name, billing_gstin, billing_state FROM orgs WHERE id = $1', [s.org.id]);

  await query(
    `UPDATE orgs SET billing_name = $2, billing_gstin = $3, billing_state = $4,
                     billing_address = $5
      WHERE id = $1`,
    [s.org.id, String(b.name ?? '').slice(0, 200), gstin,
     String(b.state ?? '').slice(0, 60), String(b.address ?? '').slice(0, 500)]);

  await audit.record(ctx, 'billing.details', {
    before: before[0], after: { name: b.name, gstin, state: b.state },
  });

  return {
    ok: true,
    /*
     * Which pair of taxes applies is decided by the state, and a customer who
     * gets IGST when they expected CGST+SGST cannot claim it. Better they see
     * it now than after the invoice is filed.
     */
    taxKind: money.gstFor(100, b.state).kind,
    message: 'Saved. Future invoices will be addressed this way.',
  };
}

/**
 * Renewals, grace periods and expiries, run on a schedule.
 *
 * Everything here is driven by a date having arrived, which means none of it
 * happens unless something asks - and a subscription that never expires is a
 * product given away.
 */
async function runBilling() {
  const out = { downgraded: 0, renewed: 0, expired: 0, ended: 0 };

  // A scheduled downgrade whose period has run out.
  const { rows: due } = await query(
    `-- tenant-global: the renewal job. It runs for every customer by design,
     -- on a timer, and is never reachable from a request - see lib/scheduler.js.
     SELECT * FROM subscriptions
      WHERE pending_plan IS NOT NULL AND current_until <= now()
        AND status IN ('active','grace','past_due')`);
  for (const sub of due) {
    const term = sub.pending_term || sub.term;
    const until = periodEnd(new Date(), term);
    await query(
      `UPDATE subscriptions
          SET plan = pending_plan, term = $2, price_paise = $3,
              pending_plan = NULL, pending_term = NULL,
              current_from = now(), current_until = $4, updated_at = now()
        WHERE id = $1 AND org_id = $5`,
      [sub.id, term, priceFor(sub.pending_plan, term), until, sub.org_id]);
    await query('UPDATE orgs SET plan = $2 WHERE id = $1', [sub.org_id, sub.pending_plan]);
    out.downgraded++;
  }

  // Cancelled, and the period they paid for has run out.
  const { rows: ending } = await query(
    `-- tenant-global: the renewal job, as above.
     SELECT * FROM subscriptions
      WHERE cancel_at_end = true AND current_until <= now()
        AND status IN ('active','grace','past_due')`);
  for (const sub of ending) {
    await query(
      `UPDATE subscriptions SET status = 'cancelled', updated_at = now()
        WHERE id = $1 AND org_id = $2`, [sub.id, sub.org_id]);
    /*
     * Dropped to trial rather than to nothing.
     *
     * A customer who stops paying should lose the paid features, not their
     * data and not their ability to sign in and export it. Locking somebody out
     * of their own books over a lapsed subscription is how a billing system
     * turns into a hostage situation.
     */
    await query(`UPDATE orgs SET plan = 'trial' WHERE id = $1`, [sub.org_id]);
    out.ended++;
  }

  // Grace ran out without a payment.
  const { rows: lapsed } = await query(
    `-- tenant-global: the renewal job, as above.
     SELECT * FROM subscriptions
      WHERE status = 'grace' AND grace_until IS NOT NULL AND grace_until <= now()`);
  for (const sub of lapsed) {
    await query(
      `UPDATE subscriptions SET status = 'expired', updated_at = now()
        WHERE id = $1 AND org_id = $2`, [sub.id, sub.org_id]);
    await query(`UPDATE orgs SET plan = 'trial' WHERE id = $1`, [sub.org_id]);
    out.expired++;
  }

  return out;
}

module.exports = {
  overview, preview, subscribe, cancel, resume, recordPayment,
  invoice, invoices, setBilling, runBilling, current, couponFor,
  priceFor, periodEnd, GRACE_DAYS,
};
