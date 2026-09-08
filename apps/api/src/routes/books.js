'use strict';
const { query } = require('../db');
const auth = require('../lib/auth');
const perms = require('../lib/permissions');
const VT = require('../lib/vouchertypes');
const { HttpError } = require('../lib/http');
const { companyFor } = require('./reports');
const { resolvePeriod } = require('./dashboard');

/**
 * The books an accountant asks for by name.
 *
 * Everything here is a different arrangement of the same ledger postings, so
 * the arrangements have to agree: a Cash Book that does not tie to the Trial
 * Balance is worse than no Cash Book, because somebody will trust it.
 */

const iso = (d) => d.toISOString().slice(0, 10);

async function periodFor(ctx, companyId) {
  const { rows } = await query(
    'SELECT COALESCE(max(vch_date), CURRENT_DATE) AS d FROM vouchers WHERE company_id = $1',
    [companyId]);
  const asOf = new Date(rows[0].d);
  const q = ctx.url.searchParams;
  const p = resolvePeriod(q.get('period') || 'fy', asOf, q.get('from'), q.get('to'));
  return { asOf, from: iso(p.from), to: iso(p.to), label: p.label };
}

/**
 * Cash Book and Bank Book: every movement through an account, in order, with
 * the balance after each one.
 *
 * The running balance is the whole point. A list of receipts and payments is
 * a bank statement nobody can reconcile; the balance after each line is what
 * lets somebody find the day it went wrong.
 *
 * Computed here rather than in the client because the opening balance has to
 * be carried in from before the period, and a client that only has the visible
 * rows cannot know it.
 */
async function cashBook(ctx, tallyGuid) {
  const s = perms.require(auth.requireUser(ctx), 'cashbank', 'read');
  const co = await companyFor(s, tallyGuid);
  const q = ctx.url.searchParams;
  const period = await periodFor(ctx, co.id);

  // 'cash' | 'bank' | a specific ledger name.
  const kind = q.get('kind') || 'cash';
  const account = (q.get('account') || '').trim();

  /*
   * Matched in lower case, but named to the customer as Tally spells them.
   *
   * Telling somebody to look for "cash-in-hand" sends them hunting for a group
   * that does not appear anywhere in their software.
   */
  const groups = kind === 'bank'
    ? ['bank accounts', 'bank od a/c']
    : ['cash-in-hand'];
  const groupLabels = kind === 'bank'
    ? ['Bank Accounts', 'Bank OD A/c']
    : ['Cash-in-Hand'];

  const args = [co.id];
  let scope;
  if (account) {
    scope = `lower(l.name) = lower($${args.push(account)})`;
  } else {
    scope = `lower(l.parent_group) = ANY($${args.push(groups)})`;
  }

  const { rows: accounts } = await query(
    `SELECT l.name, l.parent_group, l.opening_paise, l.closing_paise
       FROM ledgers l WHERE l.company_id = $1 AND ${scope}
      ORDER BY l.name`, args);

  if (!accounts.length) {
    return {
      period, kind, accounts: [], rows: [],
      openingPaise: 0, closingPaise: 0,
      note: account
        ? `No ledger named "${account}" in this company.`
        : `No ${kind} accounts found. Tally groups them under `
          + `${groupLabels.map((g) => `"${g}"`).join(' or ')}.`,
    };
  }

  const names = accounts.map((a) => a.name);

  /*
   * Everything posted to these ledgers, in date order.
   *
   * The contra ledger - the other side of the entry - is what makes a line
   * readable: "5,000 to HDFC Bank" rather than "5,000". Taken as the largest
   * opposing leg, which is the one a person would name.
   */
  const { rows } = await query(
    `SELECT v.id, v.vch_no, v.vch_type, v.vch_date::text AS date, v.party,
            v.narration, e.ledger_name AS account, e.amount_paise,
            (SELECT o.ledger_name FROM voucher_entries o
              WHERE o.voucher_id = v.id
                AND o.ledger_name <> e.ledger_name
                AND sign(o.amount_paise) <> sign(e.amount_paise)
              ORDER BY abs(o.amount_paise) DESC LIMIT 1) AS contra
       FROM voucher_entries e
       JOIN vouchers v ON v.id = e.voucher_id
      WHERE v.company_id = $1 AND ${VT.LIVE}
        AND e.ledger_name = ANY($2)
        AND v.vch_date BETWEEN $3::date AND $4::date
      ORDER BY v.vch_date, v.vch_no, v.id`,
    [co.id, names, period.from, period.to]);

  /*
   * The opening balance for the window.
   *
   * Taken as the ledger's own opening plus everything posted before the period
   * starts - not as the closing balance minus the period, which would hide an
   * error rather than reveal it.
   */
  const { rows: before } = await query(
    `SELECT COALESCE(SUM(e.amount_paise), 0)::bigint AS moved
       FROM voucher_entries e
       JOIN vouchers v ON v.id = e.voucher_id
      WHERE v.company_id = $1 AND ${VT.LIVE}
        AND e.ledger_name = ANY($2) AND v.vch_date < $3::date`,
    [co.id, names, period.from]);

  const opening = accounts.reduce((n, a) => n + Number(a.opening_paise), 0)
    + Number(before[0].moved);

  let running = opening;
  const lines = rows.map((r) => {
    const amount = Number(r.amount_paise);
    running += amount;
    return {
      id: r.id,
      no: r.vch_no,
      type: r.vch_type,
      date: r.date,
      account: r.account,
      /*
       * A debit to a cash account is money arriving.
       *
       * The connector already flipped Tally's sign, so positive is a debit
       * here. Reading it the other way labelled every receipt as a payment.
       */
      inPaise: amount > 0 ? amount : 0,
      outPaise: amount < 0 ? Math.abs(amount) : 0,
      contra: r.contra || r.party || '',
      narration: r.narration,
      balancePaise: running,
    };
  });

  return {
    period,
    kind,
    accounts: accounts.map((a) => ({
      name: a.name, group: a.parent_group,
      closingPaise: Number(a.closing_paise),
    })),
    openingPaise: opening,
    closingPaise: running,
    totals: {
      inPaise: lines.reduce((n, l) => n + l.inPaise, 0),
      outPaise: lines.reduce((n, l) => n + l.outPaise, 0),
    },
    rows: lines,
  };
}

/**
 * Group Summary: the account tree with balances rolled up through it.
 *
 * Only possible now that the connector syncs groups. A flat list of ledgers
 * answers "what is this account worth"; the tree answers "what are all my
 * current assets worth", which is the question a balance sheet is built from.
 */
async function groupSummary(ctx, tallyGuid) {
  const s = perms.require(auth.requireUser(ctx), 'reports', 'read');
  const co = await companyFor(s, tallyGuid);

  const [groups, ledgers] = await Promise.all([
    query(`SELECT name, parent, primary_group FROM groups WHERE company_id = $1`, [co.id]),
    query(
      `SELECT parent_group AS grp, count(*)::int AS n,
              COALESCE(SUM(closing_paise), 0)::bigint AS balance
         FROM ledgers WHERE company_id = $1 GROUP BY parent_group`, [co.id]),
  ]);

  const direct = new Map(ledgers.rows.map((r) => [r.grp.toLowerCase(), r]));

  /*
   * A ledger may sit in a group Tally never sent us - an older connector, or a
   * group deleted after the ledger moved. Those are kept as roots of their own
   * rather than dropped, because their money is real and has to appear
   * somewhere.
   */
  const known = new Set(groups.rows.map((g) => g.name.toLowerCase()));
  const orphanGroups = [...direct.keys()]
    .filter((g) => g && !known.has(g))
    .map((g) => ({ name: direct.get(g).grp, parent: '', primary_group: '', orphan: true }));

  const all = [...groups.rows, ...orphanGroups];
  const byName = new Map(all.map((g) => [g.name.toLowerCase(), {
    name: g.name,
    parent: g.parent || '',
    primaryGroup: g.primary_group || '',
    orphan: !!g.orphan,
    ledgers: direct.get(g.name.toLowerCase())?.n ?? 0,
    ownBalancePaise: Number(direct.get(g.name.toLowerCase())?.balance ?? 0),
    children: [],
    totalBalancePaise: 0,
    totalLedgers: 0,
  }]));

  const roots = [];
  for (const node of byName.values()) {
    const parent = node.parent ? byName.get(node.parent.toLowerCase()) : null;
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }

  /*
   * Roll up, with a depth guard.
   *
   * Tally will let a group be its own ancestor after a bad import, and an
   * unguarded recursion would hang the report rather than merely get it wrong.
   */
  const seen = new Set();
  function roll(node, depth = 0) {
    if (depth > 20 || seen.has(node)) {
      return { balance: node.ownBalancePaise, ledgers: node.ledgers };
    }
    seen.add(node);
    let balance = node.ownBalancePaise;
    let ledgerCount = node.ledgers;
    for (const c of node.children) {
      const r = roll(c, depth + 1);
      balance += r.balance;
      ledgerCount += r.ledgers;
    }
    node.totalBalancePaise = balance;
    node.totalLedgers = ledgerCount;
    return { balance, ledgers: ledgerCount };
  }
  for (const r of roots) roll(r);

  // Sorted by size so the groups that matter are at the top of each level.
  const sortTree = (nodes) => {
    nodes.sort((a, b) => Math.abs(b.totalBalancePaise) - Math.abs(a.totalBalancePaise));
    for (const n of nodes) sortTree(n.children);
    return nodes;
  };

  return {
    groups: sortTree(roots),
    counts: { groups: groups.rows.length, roots: roots.length },
    note: groups.rows.length === 0
      ? 'No groups synced yet. Restart the connector on the shop\'s PC — '
        + 'until then only the flat list of ledger groups is available.'
      : '',
  };
}

/**
 * A register: every invoice in the period with its tax columns.
 *
 * What an accountant reconciles a return against, and what Tally makes you
 * print one page at a time.
 */
async function register(ctx, tallyGuid, which) {
  const s = perms.require(auth.requireUser(ctx),
    which === 'purchase' ? 'purchase' : 'sales', 'read');
  const co = await companyFor(s, tallyGuid);
  const period = await periodFor(ctx, co.id);

  const match = which === 'purchase' ? VT.PURCHASES : VT.SALES;
  const returns = which === 'purchase'
    ? "v.vch_type ILIKE '%debit note%' OR v.vch_type ILIKE '%purchase return%'"
    : "v.vch_type ILIKE '%credit note%' OR v.vch_type ILIKE '%sales return%'";
  const includeReturns = ctx.url.searchParams.get('returns') === '1';

  const { rows } = await query(
    `SELECT v.id, v.vch_no, v.vch_type, v.vch_date::text AS date, v.party,
            abs(v.amount_paise)::bigint AS gross, v.narration,
            l.gstin AS party_gstin, l.state AS party_state,
            COALESCE(SUM(abs(e.amount_paise)) FILTER (
              WHERE e.ledger_name ~* '(cgst|central)'), 0)::bigint AS cgst,
            COALESCE(SUM(abs(e.amount_paise)) FILTER (
              WHERE e.ledger_name ~* '(sgst|utgst|state gst)'), 0)::bigint AS sgst,
            COALESCE(SUM(abs(e.amount_paise)) FILTER (
              WHERE e.ledger_name ~* '(igst|integrated)'), 0)::bigint AS igst,
            COALESCE(SUM(abs(e.amount_paise)) FILTER (
              WHERE e.ledger_name ~* 'cess'), 0)::bigint AS cess
       FROM vouchers v
       LEFT JOIN ledgers l ON l.company_id = v.company_id AND lower(l.name) = lower(v.party)
       LEFT JOIN voucher_entries e ON e.voucher_id = v.id
      WHERE v.company_id = $1 AND ${VT.LIVE}
        AND (${match}${includeReturns ? ` OR ${returns}` : ''})
        AND v.vch_date BETWEEN $2::date AND $3::date
      GROUP BY v.id, l.gstin, l.state
      ORDER BY v.vch_date, v.vch_no`,
    [co.id, period.from, period.to]);

  const lines = rows.map((r) => {
    const tax = Number(r.cgst) + Number(r.sgst) + Number(r.igst) + Number(r.cess);
    const isReturn = /return|credit note|debit note/i.test(r.vch_type);
    return {
      id: r.id, no: r.vch_no, type: r.vch_type, date: r.date,
      party: r.party, gstin: r.party_gstin || '', state: r.party_state || '',
      // Taxable value derived by subtraction: books that post through a
      // control account carry no separate taxable leg to read.
      taxablePaise: Math.max(0, Number(r.gross) - tax),
      cgstPaise: Number(r.cgst), sgstPaise: Number(r.sgst),
      igstPaise: Number(r.igst), cessPaise: Number(r.cess),
      taxPaise: tax,
      grossPaise: Number(r.gross),
      isReturn,
      narration: r.narration,
    };
  });

  const sum = (f) => lines.reduce((n, l) => n + (l.isReturn ? -l[f] : l[f]), 0);

  return {
    period,
    which,
    includeReturns,
    rows: lines,
    totals: {
      count: lines.length,
      // Returns subtract, so the total is what the period actually traded.
      taxablePaise: sum('taxablePaise'),
      cgstPaise: sum('cgstPaise'),
      sgstPaise: sum('sgstPaise'),
      igstPaise: sum('igstPaise'),
      cessPaise: sum('cessPaise'),
      taxPaise: sum('taxPaise'),
      grossPaise: sum('grossPaise'),
    },
  };
}

/**
 * What falls due today, this week and this month.
 *
 * The ageing report answers "how old is this money". This answers "who do I
 * ring this morning", which is a different and more useful question.
 */
async function dueSoon(ctx, tallyGuid) {
  const s = perms.require(auth.requireUser(ctx), 'outstanding', 'read');
  const co = await companyFor(s, tallyGuid);

  const { rows: last } = await query(
    'SELECT COALESCE(max(vch_date), CURRENT_DATE) AS d FROM vouchers WHERE company_id = $1',
    [co.id]);
  const asOf = iso(new Date(last[0].d));

  const { rows } = await query(
    `SELECT b.ref, b.party, b.bill_date::text AS bill_date,
            effective_due(b.due_date, b.bill_date, l.credit_days)::text AS due,
            b.amount_paise, l.phone, l.email,
            (effective_due(b.due_date, b.bill_date, l.credit_days) - $2::date) AS days
       FROM open_bills b
       LEFT JOIN ledgers l ON l.company_id = b.company_id AND l.name = b.party
      WHERE b.company_id = $1
      ORDER BY due`, [co.id, asOf]);

  const bucket = (days) =>
    days < 0 ? 'overdue'
      : days === 0 ? 'today'
      : days <= 7 ? 'week'
      : days <= 31 ? 'month'
      : 'later';

  const groups = {
    overdue: [], today: [], week: [], month: [], later: [],
  };
  for (const r of rows) {
    groups[bucket(Number(r.days))].push({
      ref: r.ref, party: r.party, billDate: r.bill_date, dueDate: r.due,
      amountPaise: Number(r.amount_paise), days: Number(r.days),
      phone: r.phone || '', email: r.email || '',
    });
  }

  const totals = Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, {
    count: v.length,
    amountPaise: v.reduce((n, x) => n + x.amountPaise, 0),
  }]));

  return { asOf, groups, totals };
}

/**
 * Batches going out of date.
 *
 * Only meaningful where a business tracks batches at all, and it says so
 * rather than showing an empty table that looks like a fault.
 */
async function expiry(ctx, tallyGuid) {
  const s = perms.require(auth.requireUser(ctx), 'inventory', 'read');
  const co = await companyFor(s, tallyGuid);

  const { rows: last } = await query(
    'SELECT COALESCE(max(vch_date), CURRENT_DATE) AS d FROM vouchers WHERE company_id = $1',
    [co.id]);
  const asOf = iso(new Date(last[0].d));

  const { rows } = await query(
    `SELECT b.item_name, b.batch_name, b.godown, b.qty, b.value_paise,
            b.expiry_date::text AS expiry,
            (b.expiry_date - $2::date) AS days
       FROM stock_batches b
      WHERE b.company_id = $1 AND b.expiry_date IS NOT NULL AND b.qty > 0
      ORDER BY b.expiry_date`, [co.id, asOf]);

  const { rows: anyBatch } = await query(
    'SELECT count(*)::int AS n FROM stock_batches WHERE company_id = $1', [co.id]);

  const out = rows.map((r) => ({
    item: r.item_name, batch: r.batch_name, godown: r.godown,
    qty: Number(r.qty), valuePaise: Number(r.value_paise),
    expiryDate: r.expiry, days: Number(r.days),
    status: Number(r.days) < 0 ? 'expired'
      : Number(r.days) <= 30 ? 'soon'
      : Number(r.days) <= 90 ? 'watch' : 'ok',
  }));

  return {
    asOf,
    rows: out,
    totals: {
      expired: out.filter((r) => r.status === 'expired').length,
      expiredValuePaise: out.filter((r) => r.status === 'expired')
        .reduce((n, r) => n + r.valuePaise, 0),
      soon: out.filter((r) => r.status === 'soon').length,
      soonValuePaise: out.filter((r) => r.status === 'soon')
        .reduce((n, r) => n + r.valuePaise, 0),
    },
    note: anyBatch[0].n === 0
      ? 'This business does not track batches in Tally, so there is nothing to expire.'
      : rows.length === 0
        ? 'Batches are tracked, but none carry an expiry date.'
        : '',
  };
}

module.exports = { cashBook, groupSummary, register, dueSoon, expiry };
