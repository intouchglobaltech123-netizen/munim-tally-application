'use strict';
const { query } = require('../db');
const auth = require('../lib/auth');
const perms = require('../lib/permissions');
const VT = require('../lib/vouchertypes');
const { HttpError } = require('../lib/http');

/**
 * The questions the totals do not answer.
 *
 * Everything else in Munim reports magnitude - what is biggest, what the total
 * is, how it compares to last year. That leaves four questions a shop owner
 * asks constantly and no screen answered:
 *
 *   Who actually pays me late?   - not who owes most, who is SLOW
 *   What changed?                - not who is biggest, who MOVED
 *   When do I sell?              - which days carry the week
 *   How long can I last?         - cash against what it costs to keep going
 *
 * They are grouped here rather than bolted onto the dashboard because each one
 * needs a different window over the same data, and mixing them into the
 * existing queries would make every dashboard load pay for all four.
 */

async function companyFor(session, guid) {
  const { rows } = await query(
    'SELECT * FROM companies WHERE org_id = $1 AND tally_guid = $2',
    [session.org.id, guid]);
  if (!rows.length) throw new HttpError(404, 'NOT_FOUND', 'No such company.');
  return rows[0];
}

const days = (n) => `now() - interval '${Number(n) || 365} days'`;

/**
 * Who pays late, and who pays early.
 *
 * Measured on bills that have actually been SETTLED. Including open ones would
 * flatter every customer early in a bill's life and ruin them later, and the
 * ranking would reshuffle daily without anybody having done anything.
 *
 * The number that matters is not "days since the invoice" but days against the
 * terms they were given: a customer on 60-day terms paying in 45 is early, and
 * one on 7-day terms paying in 20 is late, even though the second number is
 * smaller. Ranking on raw days would put the good customer at the bottom.
 */
async function payers(ctx, guid) {
  const s = perms.require(auth.requireUser(ctx), 'outstanding', 'read');
  const co = await companyFor(s, guid);
  const window = Number(ctx.url.searchParams.get('days')) || 365;

  const { rows } = await query(`
    WITH settled AS (
      SELECT b.party,
             b.ref,
             b.bill_date,
             b.due_date,
             b.amount_paise,
             (SELECT max(v2.vch_date)
                FROM bills b2 JOIN vouchers v2 ON v2.id = b2.voucher_id
               WHERE b2.company_id = b.company_id AND b2.ref = b.ref
                 AND b2.amount_paise < 0) AS paid_on
        FROM bills b
       WHERE b.company_id = $1
         AND b.amount_paise > 0
         AND b.bill_date IS NOT NULL
         AND b.bill_date >= ${days(window)}
         -- Settled only: nothing still open counts.
         AND NOT EXISTS (SELECT 1 FROM open_bills o
                          WHERE o.company_id = b.company_id AND o.ref = b.ref)
    )
    SELECT s.party,
           count(*)::int                                   AS bills,
           SUM(s.amount_paise)::bigint                     AS value,
           avg(s.paid_on - s.bill_date)::numeric           AS avg_days,
           max(s.paid_on - s.bill_date)::int               AS worst_days,
           /*
            * Against the terms that actually applied, which is the only fair
            * comparison between customers on different credit periods.
            *
            * effective_due falls back to the party's own credit period where
            * Tally recorded no due date on the bill - which is most of them.
            * Requiring an explicit due_date made every customer unrankable and
            * the whole screen empty.
            */
           avg(s.paid_on - effective_due(s.due_date, s.bill_date, l.credit_days))::numeric
             AS avg_vs_terms,
           count(*) FILTER (
             WHERE s.paid_on > effective_due(s.due_date, s.bill_date, l.credit_days)
           )::int AS late_count
      FROM settled s
      LEFT JOIN ledgers l ON l.company_id = $1 AND l.name = s.party
     WHERE s.paid_on IS NOT NULL
     GROUP BY s.party
    HAVING count(*) >= 2
     ORDER BY avg_vs_terms DESC NULLS LAST, avg_days DESC
     LIMIT 40`, [co.id]);

  const out = rows.map((r) => {
    const vsTerms = r.avg_vs_terms === null ? null : Math.round(Number(r.avg_vs_terms));
    return {
      party: r.party,
      bills: r.bills,
      valuePaise: Number(r.value),
      averageDays: Math.round(Number(r.avg_days)),
      worstDays: r.worst_days,
      /*
       * Negative is early. Said in the field name because a bare number here
       * is read as "days late" and half of them are not.
       */
      daysAgainstTerms: vsTerms,
      lateBills: r.late_count,
      onTimePercent: r.bills ? Math.round(((r.bills - r.late_count) / r.bills) * 100) : 100,
      verdict: vsTerms === null ? `Averages ${Math.round(Number(r.avg_days))} days`
        : vsTerms > 15 ? 'Consistently late'
        : vsTerms > 3 ? 'Usually a little late'
        : vsTerms < -3 ? 'Pays early'
        : 'Pays on time',
    };
  });

  return {
    windowDays: window,
    payers: out,
    worst: out.filter((p) => (p.daysAgainstTerms ?? 0) > 15).slice(0, 5),
    best: [...out].reverse().filter((p) => (p.daysAgainstTerms ?? 0) < 0).slice(0, 5),
    note: 'Measured on bills that have been settled, against the credit terms '
        + 'each customer was given — so somebody on 60 days paying in 45 counts '
        + 'as early, not as slow.',
    basis: out.length
      ? `${out.reduce((a, p) => a + p.bills, 0)} settled bills across ${out.length} parties`
      : 'Nothing settled in this window yet',
  };
}

/**
 * What moved.
 *
 * A top-ten list is a list of the biggest, and the biggest rarely change. A
 * customer who halved their orders is still in the top ten and looks fine
 * there - which is exactly the customer worth a phone call this week.
 *
 * Both directions, and both matter: a supplier whose billing doubled is as
 * worth knowing about as a customer who stopped.
 */
async function movers(ctx, guid) {
  const s = perms.require(auth.requireUser(ctx), 'insights', 'read');
  const co = await companyFor(s, guid);
  const window = Number(ctx.url.searchParams.get('days')) || 90;

  const { rows } = await query(`
    SELECT v.party,
           COALESCE(SUM(abs(v.amount_paise)) FILTER (
             WHERE v.vch_date >= ${days(window)}), 0)::bigint AS now_paise,
           COALESCE(SUM(abs(v.amount_paise)) FILTER (
             WHERE v.vch_date >= ${days(window * 2)}
               AND v.vch_date <  ${days(window)}), 0)::bigint AS before_paise,
           count(*) FILTER (WHERE v.vch_date >= ${days(window)})::int AS now_count
      FROM vouchers v
     WHERE v.company_id = $1 AND v.party <> ''
       AND NOT v.is_cancelled AND NOT v.is_optional
       AND ${VT.SALES}
       AND v.vch_date >= ${days(window * 2)}
     GROUP BY v.party`, [co.id]);

  const scored = rows.map((r) => {
    const now = Number(r.now_paise);
    const before = Number(r.before_paise);
    return {
      party: r.party,
      nowPaise: now,
      beforePaise: before,
      changePaise: now - before,
      /*
       * Null rather than a percentage when there is no base. "+100%" against
       * zero is not growth, it is a first order - which is a different and more
       * interesting fact, carried by `firstTime`.
       */
      changePercent: before > 0 ? Math.round(((now - before) / before) * 100) : null,
      firstTime: before === 0 && now > 0,
      stopped: before > 0 && now === 0,
      invoices: r.now_count,
    };
  });

  /*
   * Ranked by rupees moved, not by percentage.
   *
   * A tiny customer tripling from ₹300 to ₹900 outranks a large one falling by
   * two lakh on any percentage sort, and the second is the one that matters.
   */
  const byMove = [...scored].sort((a, b) => Math.abs(b.changePaise) - Math.abs(a.changePaise));

  return {
    windowDays: window,
    comparedWith: `the ${window} days before that`,
    grew: byMove.filter((p) => p.changePaise > 0 && !p.firstTime).slice(0, 10),
    shrank: byMove.filter((p) => p.changePaise < 0 && !p.stopped).slice(0, 10),
    won: scored.filter((p) => p.firstTime)
      .sort((a, b) => b.nowPaise - a.nowPaise).slice(0, 10),
    lost: scored.filter((p) => p.stopped)
      .sort((a, b) => b.beforePaise - a.beforePaise).slice(0, 10),
    note: 'Ranked by rupees moved rather than percentage — a small customer '
        + 'tripling matters less than a large one halving.',
  };
}

/**
 * When the shop actually sells.
 *
 * Drives two decisions nothing else in Munim informs: which days to staff, and
 * when to hold stock. A shop that does forty per cent of its week on Saturday
 * is running the wrong rota if it does not know that.
 */
async function rhythm(ctx, guid) {
  const s = perms.require(auth.requireUser(ctx), 'sales', 'read');
  const co = await companyFor(s, guid);
  const window = Number(ctx.url.searchParams.get('days')) || 365;

  const [dow, monthly] = await Promise.all([
    query(`
      SELECT EXTRACT(DOW FROM v.vch_date)::int AS dow,
             COALESCE(SUM(abs(v.amount_paise)), 0)::bigint AS amount,
             count(*)::int AS invoices,
             count(DISTINCT v.vch_date)::int AS days_open
        FROM vouchers v
       WHERE v.company_id = $1 AND NOT v.is_cancelled AND NOT v.is_optional
         AND ${VT.SALES} AND v.vch_date >= ${days(window)}
       GROUP BY 1 ORDER BY 1`, [co.id]),
    query(`
      SELECT EXTRACT(MONTH FROM v.vch_date)::int AS month,
             COALESCE(SUM(abs(v.amount_paise)), 0)::bigint AS amount,
             count(*)::int AS invoices
        FROM vouchers v
       WHERE v.company_id = $1 AND NOT v.is_cancelled AND NOT v.is_optional
         AND ${VT.SALES} AND v.vch_date >= ${days(Math.max(window, 365))}
       GROUP BY 1 ORDER BY 1`, [co.id]),
  ]);

  const NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday',
                 'Friday', 'Saturday'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                  'August', 'September', 'October', 'November', 'December'];

  const total = dow.rows.reduce((a, r) => a + Number(r.amount), 0);

  const byDay = NAMES.map((name, i) => {
    const r = dow.rows.find((x) => x.dow === i);
    const amount = r ? Number(r.amount) : 0;
    return {
      day: name,
      short: name.slice(0, 3),
      amountPaise: amount,
      invoices: r?.invoices ?? 0,
      /*
       * The average for a day the shop was actually open, not the average over
       * every calendar Sunday. A shop closed on Sundays would otherwise look
       * like it has terrible Sundays rather than no Sundays.
       */
      daysOpen: r?.days_open ?? 0,
      averagePaise: r?.days_open ? Math.round(amount / r.days_open) : 0,
      sharePercent: total ? Math.round((amount / total) * 1000) / 10 : 0,
    };
  });

  const open = byDay.filter((d) => d.daysOpen > 0);
  const best = [...open].sort((a, b) => b.averagePaise - a.averagePaise)[0] ?? null;
  const worst = [...open].sort((a, b) => a.averagePaise - b.averagePaise)[0] ?? null;

  const monthTotal = monthly.rows.reduce((a, r) => a + Number(r.amount), 0);
  const byMonth = MONTHS.map((name, i) => {
    const r = monthly.rows.find((x) => x.month === i + 1);
    return {
      month: name,
      short: name.slice(0, 3),
      amountPaise: r ? Number(r.amount) : 0,
      invoices: r?.invoices ?? 0,
      sharePercent: monthTotal
        ? Math.round((Number(r?.amount ?? 0) / monthTotal) * 1000) / 10 : 0,
    };
  });

  return {
    windowDays: window,
    byDay,
    byMonth,
    best,
    worst,
    closedOn: byDay.filter((d) => d.daysOpen === 0).map((d) => d.day),
    summary: best && worst && best.day !== worst.day
      ? `${best.day} is your strongest day; ${worst.day} is your quietest.`
      : 'Not enough trading days yet to see a pattern.',
    note: 'Averages are per day the shop actually traded, so a day you are '
        + 'closed does not drag the figure down.',
  };
}

/**
 * How long the money lasts.
 *
 * The question every owner asks in a bad month and no report answers. Cash and
 * bank against what it costs to keep the doors open - not against turnover,
 * which says nothing about survival.
 */
async function runway(ctx, guid) {
  const s = perms.require(auth.requireUser(ctx), 'cashbank', 'read');
  const co = await companyFor(s, guid);

  const { rows } = await query(`
    SELECT
      COALESCE(SUM(l.closing_paise) FILTER (
        WHERE l.parent_group ILIKE '%cash%'), 0)::bigint AS cash,
      COALESCE(SUM(l.closing_paise) FILTER (
        WHERE l.parent_group ILIKE '%bank%'), 0)::bigint AS bank
      FROM ledgers l WHERE l.company_id = $1`, [co.id]);

  /*
   * The burn is measured over ninety days rather than one month.
   *
   * A single month is dominated by whatever happened to fall in it - a rent
   * quarter, an insurance renewal - and a runway that swings between four
   * months and eleven depending on which month you ask is not a number anybody
   * can act on.
   */
  const { rows: burn } = await query(`
    SELECT COALESCE(SUM(abs(e.amount_paise)), 0)::bigint AS spent
      FROM voucher_entries e
      JOIN vouchers v ON v.id = e.voucher_id
      LEFT JOIN ledgers l ON l.company_id = v.company_id AND l.name = e.ledger_name
     WHERE v.company_id = $1
       AND v.vch_date >= ${days(90)}
       AND NOT v.is_cancelled AND NOT v.is_optional
       AND (l.parent_group ILIKE 'indirect exp%' OR l.parent_group ILIKE 'direct exp%')`,
    [co.id]);

  const cash = Number(rows[0].cash);
  const bank = Number(rows[0].bank);
  const liquid = cash + bank;
  const monthlyBurn = Math.round(Number(burn[0].spent) / 3);

  const { rows: due } = await query(
    `SELECT COALESCE(SUM(amount_paise), 0)::bigint AS owed
       FROM open_bills WHERE company_id = $1`, [co.id]);

  return {
    cashPaise: cash,
    bankPaise: bank,
    liquidPaise: liquid,
    monthlyBurnPaise: monthlyBurn,
    /*
     * Null rather than Infinity when nothing is being spent. A shop with no
     * recorded expenses has not achieved infinite runway; Munim just cannot
     * see its costs, and printing ∞ would be a lie with a symbol.
     */
    months: monthlyBurn > 0 ? Math.round((liquid / monthlyBurn) * 10) / 10 : null,
    /*
     * With receivables collected. Almost always the more useful of the two,
     * because the money is owed and most of it does arrive.
     */
    monthsWithReceivables: monthlyBurn > 0
      ? Math.round(((liquid + Number(due[0].owed)) / monthlyBurn) * 10) / 10 : null,
    receivablePaise: Number(due[0].owed),
    basis: monthlyBurn > 0
      ? 'Average spend over the last 90 days, so one heavy month does not distort it.'
      : 'Munim cannot see any expenses in the last 90 days, so it cannot work '
        + 'out how long the money lasts.',
    /*
     * Unknown is its own state, not 'ok'.
     *
     * A shop whose expenses Munim cannot see is not a shop with healthy
     * runway - it is a shop we know nothing about, and colouring that green
     * says the opposite of the truth at exactly the wrong moment.
     */
    tone: monthlyBurn <= 0 ? 'unknown'
      : liquid / monthlyBurn < 1.5 ? 'bad'
      : liquid / monthlyBurn < 3 ? 'warn'
      : 'ok',
  };
}

/** All four, for one screen. */
async function all(ctx, guid) {
  const [p, m, r, w] = await Promise.all([
    payers(ctx, guid), movers(ctx, guid), rhythm(ctx, guid), runway(ctx, guid),
  ]);
  return { payers: p, movers: m, rhythm: r, runway: w };
}

module.exports = { all, payers, movers, rhythm, runway };
