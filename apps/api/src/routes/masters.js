'use strict';
const { query } = require('../db');
const auth = require('../lib/auth');
const VT = require('../lib/vouchertypes');
const perms = require('../lib/permissions');
const { HttpError } = require('../lib/http');
const { companyFor } = require('./reports');

/**
 * The masters: who you trade with, and what you trade in.
 *
 * All of it read from Tally. Creating, editing and deleting a ledger or an
 * item happen in Tally and arrive here on the next sync - Munim never writes
 * to a customer's books, and the screens say so rather than offering a button
 * that would have to be explained away.
 *
 * The one exception is tags, which Tally has no concept of. Those are Munim's
 * own, and survive every sync.
 */

const DEBTOR = 'sundry debtors';
const CREDITOR = 'sundry creditors';

/** A party as every screen wants it. */
const partyOut = (r) => ({
  name: r.name,
  group: r.parent_group,
  nature: r.nature,
  kind: r.kind,
  openingPaise: Number(r.opening_paise),
  closingPaise: Number(r.closing_paise),
  creditDays: r.credit_days,
  creditLimitPaise: Number(r.credit_limit_paise ?? 0),
  // Over their limit is the single fact that decides whether to sell to
  // somebody today, so it is computed here rather than left to each screen.
  overLimit: Number(r.credit_limit_paise ?? 0) > 0
    && Number(r.closing_paise) > Number(r.credit_limit_paise),
  contact: {
    person: r.contact_person, phone: r.phone, email: r.email,
    address: r.address, state: r.state, country: r.country, pincode: r.pincode,
    shippingAddress: r.shipping_address,
  },
  tax: { gstin: r.gstin, registrationType: r.gst_reg_type, pan: r.pan },
  bank: {
    name: r.bank_name, account: r.bank_account,
    ifsc: r.bank_ifsc, holder: r.bank_holder,
  },
  tags: r.tags ?? [],
  updatedAt: r.updated_at,
});

/**
 * Customers, suppliers, or every ledger.
 *
 * One handler for all three because they differ only by which group they sit
 * in - and a shop that files a customer under a group of its own invention
 * would fall out of a list that hard-coded the names.
 */
async function parties(ctx, tallyGuid) {
  const s = perms.require(auth.requireUser(ctx), 'ledgers', 'read');
  const co = await companyFor(s, tallyGuid);
  const q = ctx.url.searchParams;

  const kind = q.get('kind') || 'all';        // customer | supplier | all
  const search = (q.get('q') || '').trim();
  const sort = q.get('sort') || 'balance';
  const limit = Math.min(Math.max(parseInt(q.get('limit') ?? '200', 10) || 200, 1), 1000);
  const onlyOwing = q.get('owing') === '1';
  const tag = (q.get('tag') || '').trim();

  const where = ['l.company_id = $1'];
  const args = [co.id];
  if (kind === 'customer') { where.push(`lower(l.parent_group) = $${args.push(DEBTOR)}`); }
  if (kind === 'supplier') { where.push(`lower(l.parent_group) = $${args.push(CREDITOR)}`); }
  if (search) {
    // Name, GSTIN or phone: an owner remembers whichever of the three they
    // last used, and making them pick a field first is a barrier.
    const i = args.push(`%${search.toLowerCase()}%`);
    where.push(`(lower(l.name) LIKE $${i} OR lower(l.gstin) LIKE $${i} OR l.phone LIKE $${i})`);
  }
  if (tag) where.push(`$${args.push(tag)} = ANY(l.tags)`);
  if (onlyOwing) where.push('l.closing_paise <> 0');

  const order = {
    balance: 'abs(l.closing_paise) DESC',
    name: 'l.name',
    recent: 'l.updated_at DESC',
  }[sort] ?? 'abs(l.closing_paise) DESC';

  const { rows } = await query(
    `SELECT l.*,
            resolved_nature(l.company_id, l.parent_group) AS nature,
            CASE WHEN lower(l.parent_group) = '${DEBTOR}' THEN 'customer'
                 WHEN lower(l.parent_group) = '${CREDITOR}' THEN 'supplier'
                 ELSE 'ledger' END AS kind
       FROM ledgers l
      WHERE ${where.join(' AND ')}
      ORDER BY ${order} LIMIT $${args.push(limit)}`, args);

  const { rows: totals } = await query(
    `SELECT count(*)::int AS n,
            COALESCE(SUM(closing_paise) FILTER (WHERE closing_paise > 0), 0)::bigint AS owed_to_you,
            COALESCE(-SUM(closing_paise) FILTER (WHERE closing_paise < 0), 0)::bigint AS you_owe
       FROM ledgers l WHERE ${where.join(' AND ')}`, args.slice(0, -1));

  const { rows: tags } = await query(
    `SELECT DISTINCT unnest(tags) AS t FROM ledgers WHERE company_id = $1 ORDER BY 1`, [co.id]);

  return {
    parties: rows.map(partyOut),
    totals: {
      count: totals[0].n,
      owedToYouPaise: Number(totals[0].owed_to_you),
      youOwePaise: Number(totals[0].you_owe),
    },
    tags: tags.map((r) => r.t),
    readOnly: 'Parties are created and edited in Tally. Munim shows them.',
  };
}

/** One party, with everything anyone would open the screen to find. */
async function party(ctx, tallyGuid, name) {
  const s = perms.require(auth.requireUser(ctx), 'ledgers', 'read');
  const co = await companyFor(s, tallyGuid);

  const { rows } = await query(
    `SELECT l.*, resolved_nature(l.company_id, l.parent_group) AS nature,
            CASE WHEN lower(l.parent_group) = '${DEBTOR}' THEN 'customer'
                 WHEN lower(l.parent_group) = '${CREDITOR}' THEN 'supplier'
                 ELSE 'ledger' END AS kind
       FROM ledgers l WHERE l.company_id = $1 AND lower(l.name) = lower($2)`,
    [co.id, name]);
  if (!rows.length) throw new HttpError(404, 'NOT_FOUND', 'No such party in this company.');

  const [sales, purchases, receipts, payments, bills, monthly, items,
         behaviour, ageing] = await Promise.all([
    query(
      `SELECT v.id, v.vch_no, v.vch_type, v.vch_date, v.amount_paise, v.narration
         FROM vouchers v
        WHERE v.company_id = $1 AND v.party = $2 AND NOT v.is_cancelled
          AND ${VT.sales('v')}
        ORDER BY v.vch_date DESC LIMIT 50`, [co.id, rows[0].name]),
    query(
      `SELECT v.id, v.vch_no, v.vch_type, v.vch_date, v.amount_paise, v.narration
         FROM vouchers v
        WHERE v.company_id = $1 AND v.party = $2 AND NOT v.is_cancelled
          AND ${VT.purchases('v')}
        ORDER BY v.vch_date DESC LIMIT 50`, [co.id, rows[0].name]),
    query(
      `SELECT v.id, v.vch_no, v.vch_date, v.amount_paise
         FROM vouchers v
        WHERE v.company_id = $1 AND v.party = $2 AND NOT v.is_cancelled
          AND v.vch_type ILIKE '%receipt%'
        ORDER BY v.vch_date DESC LIMIT 50`, [co.id, rows[0].name]),
    query(
      `SELECT v.id, v.vch_no, v.vch_date, v.amount_paise
         FROM vouchers v
        WHERE v.company_id = $1 AND v.party = $2 AND NOT v.is_cancelled
          AND v.vch_type ILIKE '%payment%'
        ORDER BY v.vch_date DESC LIMIT 50`, [co.id, rows[0].name]),

    // Open bills with their due dates - the reason most people open a party.
    query(
      `SELECT b.ref, b.bill_date, b.amount_paise,
              effective_due(b.due_date, b.bill_date, $3) AS due,
              (SELECT max(vch_date) FROM vouchers WHERE company_id = $1) < 
                effective_due(b.due_date, b.bill_date, $3) AS current
         FROM open_bills b
        WHERE b.company_id = $1 AND b.party = $2
        ORDER BY due`, [co.id, rows[0].name, rows[0].credit_days]),

    query(
      `SELECT to_char(date_trunc('month', v.vch_date), 'YYYY-MM-DD') AS at,
              COALESCE(SUM(abs(v.amount_paise)) FILTER (
                WHERE ${VT.SALES}), 0)::bigint AS sales,
              COALESCE(SUM(abs(v.amount_paise)) FILTER (
                WHERE v.vch_type ILIKE '%receipt%'), 0)::bigint AS receipts
         FROM vouchers v
        WHERE v.company_id = $1 AND v.party = $2 AND NOT v.is_cancelled
        GROUP BY 1 ORDER BY 1`, [co.id, rows[0].name]),

    query(
      `SELECT vi.item_name AS label, SUM(vi.qty)::float AS qty,
              SUM(abs(vi.amount_paise))::bigint AS amount
         FROM voucher_items vi JOIN vouchers v ON v.id = vi.voucher_id
        WHERE v.company_id = $1 AND v.party = $2 AND NOT v.is_cancelled
          AND vi.item_name <> ''
        GROUP BY 1 ORDER BY 3 DESC LIMIT 15`, [co.id, rows[0].name]),

    /*
     * How this one actually pays.
     *
     * The same terms-aware measure the Pulse screen ranks everybody by, asked
     * about one party. It is the question somebody has in mind when they open a
     * customer at all - "can I give them another load on credit" - and the
     * balance alone does not answer it.
     *
     * Settled bills only: an open one flatters early and ruins late, so
     * including them would make this move daily with nothing having happened.
     */
    query(
      `WITH settled AS (
         SELECT b.bill_date, b.due_date,
                (SELECT max(v2.vch_date)
                   FROM bills b2 JOIN vouchers v2 ON v2.id = b2.voucher_id
                  WHERE b2.company_id = b.company_id AND b2.ref = b.ref
                    AND b2.amount_paise < 0) AS paid_on
           FROM bills b
          WHERE b.company_id = $1 AND b.party = $2
            AND b.amount_paise > 0 AND b.bill_date IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM open_bills o
                             WHERE o.company_id = b.company_id AND o.ref = b.ref)
       )
       SELECT count(*)::int AS bills,
              avg(paid_on - bill_date)::numeric AS avg_days,
              max(paid_on - bill_date)::int AS worst_days,
              /*
               * effective_due, not due_date, so this agrees with the ageing
               * buckets below. Tally often carries no due date on a bill; the
               * party's own credit period is the terms in that case, and
               * treating the absence as "no terms" made every customer read as
               * unjudgeable while the ageing panel right beside it happily
               * called them overdue.
               */
              avg(paid_on - effective_due(due_date, bill_date, $3))::numeric
                AS avg_vs_terms,
              count(*) FILTER (
                WHERE paid_on > effective_due(due_date, bill_date, $3))::int AS late
         FROM settled WHERE paid_on IS NOT NULL`,
      [co.id, rows[0].name, rows[0].credit_days]),

    /*
     * What is overdue, in buckets.
     *
     * "₹2,00,000 outstanding" and "₹2,00,000 outstanding, all of it past ninety
     * days" are different situations and the first is the one people act on.
     */
    query(
      `SELECT
         COALESCE(SUM(amount_paise) FILTER (
           WHERE effective_due(due_date, bill_date, $3) >= CURRENT_DATE), 0)::bigint
           AS not_due,
         COALESCE(SUM(amount_paise) FILTER (
           WHERE CURRENT_DATE - effective_due(due_date, bill_date, $3)
                 BETWEEN 1 AND 30), 0)::bigint AS d30,
         COALESCE(SUM(amount_paise) FILTER (
           WHERE CURRENT_DATE - effective_due(due_date, bill_date, $3)
                 BETWEEN 31 AND 60), 0)::bigint AS d60,
         COALESCE(SUM(amount_paise) FILTER (
           WHERE CURRENT_DATE - effective_due(due_date, bill_date, $3)
                 BETWEEN 61 AND 90), 0)::bigint AS d90,
         COALESCE(SUM(amount_paise) FILTER (
           WHERE CURRENT_DATE - effective_due(due_date, bill_date, $3) > 90), 0)::bigint
           AS over90
         FROM open_bills
        WHERE company_id = $1 AND party = $2`, [co.id, rows[0].name, rows[0].credit_days]),
  ]);

  const vch = (r) => ({
    id: r.id, no: r.vch_no, type: r.vch_type, date: r.vch_date,
    amountPaise: Number(r.amount_paise), narration: r.narration,
  });

  return {
    party: partyOut(rows[0]),
    salesHistory: sales.rows.map(vch),
    purchaseHistory: purchases.rows.map(vch),
    receiptHistory: receipts.rows.map(vch),
    paymentHistory: payments.rows.map(vch),
    openBills: bills.rows.map((b) => ({
      ref: b.ref, billDate: b.bill_date, dueDate: b.due,
      amountPaise: Number(b.amount_paise), current: b.current,
    })),
    monthly: monthly.rows.map((r) => ({
      at: r.at, sales: Number(r.sales), receipts: Number(r.receipts) })),
    itemsBought: items.rows.map((r) => ({
      label: r.label, qty: Number(r.qty), amountPaise: Number(r.amount) })),

    /*
     * How they pay, in words as well as numbers.
     *
     * `null` when there is nothing settled to judge from - a new customer has
     * no track record, and inventing a verdict for one is worse than saying so.
     */
    behaviour: Number(behaviour.rows[0]?.bills) >= 1 ? (() => {
      const b = behaviour.rows[0];
      const vsTerms = b.avg_vs_terms === null
        ? null : Math.round(Number(b.avg_vs_terms));
      return {
        bills: b.bills,
        averageDays: Math.round(Number(b.avg_days)),
        worstDays: b.worst_days,
        // Negative is early. Named so nobody reads it as "days late".
        daysAgainstTerms: vsTerms,
        lateBills: b.late,
        onTimePercent: b.bills
          ? Math.round(((b.bills - b.late) / b.bills) * 100) : 100,
        /*
         * Said against whatever terms actually applied - the bill's own due
         * date where Tally recorded one, otherwise this party's credit period.
         */
        verdict: vsTerms === null ? `Averages ${Math.round(Number(b.avg_days))} days to pay`
          : vsTerms > 15 ? 'Consistently late'
          : vsTerms > 3 ? 'Usually a little late'
          : vsTerms < -3 ? 'Pays early'
          : 'Pays on time',
        // One settled bill is a fact, not a pattern, and the screen should say
        // which it is looking at.
        confident: b.bills >= 3,
      };
    })() : null,

    ageing: (() => {
      const a = ageing.rows[0] ?? {};
      const n = (k) => Number(a[k] ?? 0);
      const overdue = n('d30') + n('d60') + n('d90') + n('over90');
      return {
        notDuePaise: n('not_due'),
        buckets: [
          { label: '1–30 days', paise: n('d30') },
          { label: '31–60 days', paise: n('d60') },
          { label: '61–90 days', paise: n('d90') },
          { label: 'Over 90 days', paise: n('over90') },
        ],
        overduePaise: overdue,
        totalPaise: n('not_due') + overdue,
        /*
         * The share of what they owe that is already late. A customer with
         * everything current and one with everything ninety days past are the
         * same number and completely different problems.
         */
        overduePercent: n('not_due') + overdue
          ? Math.round((overdue / (n('not_due') + overdue)) * 100) : 0,
      };
    })(),
  };
}

/** Tags are Munim's own: Tally has no concept of them, so they survive syncs. */
async function setTags(ctx, tallyGuid, name) {
  const s = perms.require(auth.requireUser(ctx), 'ledgers', 'update');
  const co = await companyFor(s, tallyGuid);
  const raw = Array.isArray(ctx.body.tags) ? ctx.body.tags : [];

  const tags = [...new Set(raw
    .map((t) => String(t).trim().slice(0, 30))
    .filter(Boolean))].slice(0, 12);

  const { rowCount } = await query(
    'UPDATE ledgers SET tags = $3 WHERE company_id = $1 AND lower(name) = lower($2)',
    [co.id, name, tags]);
  if (!rowCount) throw new HttpError(404, 'NOT_FOUND', 'No such party.');
  return { tags };
}

// ---------------------------------------------------------------------- items

const itemOut = (r) => ({
  name: r.name,
  group: r.parent_group,
  category: r.category,
  unit: r.unit,
  altUnit: r.alt_unit,
  hsn: r.hsn,
  sac: r.sac,
  gstRatePct: (r.gst_rate_bp ?? 0) / 100,
  openingQty: Number(r.opening_qty ?? 0),
  openingValuePaise: Number(r.opening_value_paise ?? 0),
  closingQty: Number(r.closing_qty),
  closingValuePaise: Number(r.closing_value_paise),
  purchaseRatePaise: Number(r.purchase_rate_paise ?? 0),
  salesRatePaise: Number(r.sales_rate_paise ?? 0),
  minLevel: Number(r.min_level ?? 0),
  maxLevel: Number(r.max_level ?? 0),
  reorderLevel: Number(r.reorder_level ?? 0),
  // The three states a shop acts on, decided here so every screen agrees.
  status: Number(r.closing_qty) < 0 ? 'negative'
    : Number(r.reorder_level ?? 0) > 0 && Number(r.closing_qty) <= Number(r.reorder_level)
      ? 'reorder'
      : Number(r.closing_qty) === 0 ? 'out' : 'ok',
  // Value per unit, which is the figure that exposes a mispriced item.
  ratePaise: Number(r.closing_qty) !== 0
    ? Math.round(Number(r.closing_value_paise) / Number(r.closing_qty)) : 0,
  hasBatches: r.has_batches,
  tags: r.tags ?? [],
});

async function items(ctx, tallyGuid) {
  const s = perms.require(auth.requireUser(ctx), 'inventory', 'read');
  const co = await companyFor(s, tallyGuid);
  const q = ctx.url.searchParams;

  const search = (q.get('q') || '').trim();
  const group = (q.get('group') || '').trim();
  const category = (q.get('category') || '').trim();
  const status = q.get('status') || '';        // ok | out | negative | reorder
  const sort = q.get('sort') || 'value';
  const limit = Math.min(Math.max(parseInt(q.get('limit') ?? '300', 10) || 300, 1), 2000);

  const where = ['i.company_id = $1'];
  const args = [co.id];
  if (search) {
    const n = args.push(`%${search.toLowerCase()}%`);
    where.push(`(lower(i.name) LIKE $${n} OR lower(i.hsn) LIKE $${n})`);
  }
  if (group) where.push(`i.parent_group = $${args.push(group)}`);
  if (category) where.push(`i.category = $${args.push(category)}`);
  if (status === 'negative') where.push('i.closing_qty < 0');
  if (status === 'out') where.push('i.closing_qty = 0');
  if (status === 'ok') where.push('i.closing_qty > 0');
  if (status === 'reorder') {
    where.push('i.reorder_level > 0 AND i.closing_qty <= i.reorder_level');
  }

  const order = {
    value: 'i.closing_value_paise DESC',
    qty: 'i.closing_qty DESC',
    name: 'i.name',
  }[sort] ?? 'i.closing_value_paise DESC';

  const [list, totals, groups, cats] = await Promise.all([
    query(`SELECT i.* FROM stock_items i WHERE ${where.join(' AND ')}
            ORDER BY ${order} LIMIT $${args.push(limit)}`, args),
    query(
      `SELECT count(*)::int AS n,
              COALESCE(SUM(closing_value_paise), 0)::bigint AS value,
              count(*) FILTER (WHERE closing_qty < 0)::int AS negative,
              count(*) FILTER (WHERE closing_qty = 0)::int AS out_of_stock,
              count(*) FILTER (WHERE reorder_level > 0 AND closing_qty <= reorder_level)::int AS reorder
         FROM stock_items i WHERE i.company_id = $1`, [co.id]),
    query(
      `SELECT parent_group AS v, count(*)::int AS n FROM stock_items
        WHERE company_id = $1 AND parent_group <> '' GROUP BY 1 ORDER BY 1`, [co.id]),
    query(
      `SELECT category AS v, count(*)::int AS n FROM stock_items
        WHERE company_id = $1 AND category <> '' GROUP BY 1 ORDER BY 1`, [co.id]),
  ]);

  return {
    items: list.rows.map(itemOut),
    totals: {
      count: totals.rows[0].n,
      valuePaise: Number(totals.rows[0].value),
      negative: totals.rows[0].negative,
      outOfStock: totals.rows[0].out_of_stock,
      belowReorder: totals.rows[0].reorder,
    },
    groups: groups.rows.map((r) => ({ name: r.v, count: r.n })),
    categories: cats.rows.map((r) => ({ name: r.v, count: r.n })),
    readOnly: 'Items are created and edited in Tally. Munim shows them.',
  };
}

/** One item, with how it has actually moved. */
async function item(ctx, tallyGuid, name) {
  const s = perms.require(auth.requireUser(ctx), 'inventory', 'read');
  const co = await companyFor(s, tallyGuid);

  const { rows } = await query(
    'SELECT * FROM stock_items WHERE company_id = $1 AND lower(name) = lower($2)',
    [co.id, name]);
  if (!rows.length) throw new HttpError(404, 'NOT_FOUND', 'No such item in this company.');

  const [movement, buyers, monthly, batches] = await Promise.all([
    query(
      `SELECT v.id, v.vch_no, v.vch_type, v.vch_date, v.party,
              vi.qty, vi.rate_paise, vi.amount_paise
         FROM voucher_items vi JOIN vouchers v ON v.id = vi.voucher_id
        WHERE v.company_id = $1 AND vi.item_name = $2 AND NOT v.is_cancelled
        ORDER BY v.vch_date DESC LIMIT 60`, [co.id, rows[0].name]),
    query(
      `SELECT v.party AS label, SUM(vi.qty)::float AS qty,
              SUM(abs(vi.amount_paise))::bigint AS amount
         FROM voucher_items vi JOIN vouchers v ON v.id = vi.voucher_id
        WHERE v.company_id = $1 AND vi.item_name = $2 AND NOT v.is_cancelled
          AND ${VT.sales('v')} AND v.party <> ''
        GROUP BY 1 ORDER BY 3 DESC LIMIT 10`, [co.id, rows[0].name]),
    query(
      `SELECT to_char(date_trunc('month', v.vch_date), 'YYYY-MM-DD') AS at,
              COALESCE(SUM(vi.qty) FILTER (WHERE ${VT.sales('v')}), 0)::float AS sold,
              COALESCE(SUM(vi.qty) FILTER (WHERE ${VT.purchases('v')}), 0)::float AS bought
         FROM voucher_items vi JOIN vouchers v ON v.id = vi.voucher_id
        WHERE v.company_id = $1 AND vi.item_name = $2 AND NOT v.is_cancelled
        GROUP BY 1 ORDER BY 1`, [co.id, rows[0].name]),
    query(
      `SELECT batch_name, godown, qty, value_paise, mfg_date, expiry_date
         FROM stock_batches
        WHERE company_id = $1 AND item_name = $2
        ORDER BY expiry_date NULLS LAST`, [co.id, rows[0].name]),
  ]);

  return {
    item: itemOut(rows[0]),
    movement: movement.rows.map((r) => ({
      id: r.id, no: r.vch_no, type: r.vch_type, date: r.vch_date, party: r.party,
      qty: Number(r.qty), ratePaise: Number(r.rate_paise),
      amountPaise: Number(r.amount_paise),
      // In or out, decided from the voucher type rather than the sign, which
      // Tally uses inconsistently across voucher types.
      direction: /purchase|receipt note/i.test(r.vch_type) ? 'in' : 'out',
    })),
    buyers: buyers.rows.map((r) => ({
      label: r.label, qty: Number(r.qty), amountPaise: Number(r.amount) })),
    monthly: monthly.rows.map((r) => ({
      at: r.at, sold: Number(r.sold), bought: Number(r.bought) })),
    batches: batches.rows.map((r) => ({
      name: r.batch_name, godown: r.godown, qty: Number(r.qty),
      valuePaise: Number(r.value_paise), mfgDate: r.mfg_date, expiryDate: r.expiry_date,
    })),
  };
}

/** The account tree, as Tally holds it. */
async function groups(ctx, tallyGuid) {
  const s = perms.require(auth.requireUser(ctx), 'ledgers', 'read');
  const co = await companyFor(s, tallyGuid);

  const { rows } = await query(
    `SELECT g.name, g.parent, g.primary_group,
            resolved_nature(g.company_id, g.name) AS nature,
            (SELECT count(*)::int FROM ledgers l
              WHERE l.company_id = g.company_id AND l.parent_group = g.name) AS ledgers,
            (SELECT COALESCE(SUM(l.closing_paise), 0)::bigint FROM ledgers l
              WHERE l.company_id = g.company_id AND l.parent_group = g.name) AS balance
       FROM groups g WHERE g.company_id = $1 ORDER BY g.name`, [co.id]);

  return {
    groups: rows.map((r) => ({
      name: r.name, parent: r.parent, primaryGroup: r.primary_group,
      nature: r.nature, ledgers: r.ledgers, balancePaise: Number(r.balance),
    })),
    // Said plainly, because an empty tree looks like a fault rather than a
    // connector that has not run since this was added.
    note: rows.length === 0
      ? 'No groups synced yet. Restart the connector on the shop\'s PC.'
      : '',
  };
}

module.exports = { parties, party, setTags, items, item, groups };
