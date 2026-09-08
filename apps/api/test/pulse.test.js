const { test, after } = require('node:test');
const assert = require('node:assert');
const { query } = require('../src/db');
const pulse = require('../src/routes/pulse');

/**
 * The questions the totals do not answer.
 *
 * Each of these ranks or judges something, so the tests are mostly about the
 * judgement: ranking on the right thing, and refusing to judge when the data
 * cannot support it.
 */

const orgs = [];
after(async () => { for (const id of orgs) await query('DELETE FROM orgs WHERE id = $1', [id]); });

async function shop() {
  const { rows: o } = await query(
    `INSERT INTO orgs (name, plan) VALUES ('pulse-test','internal') RETURNING *`);
  orgs.push(o[0].id);
  const { rows: u } = await query(
    `INSERT INTO users (org_id, email, role) VALUES ($1,$2,'owner') RETURNING id`,
    [o[0].id, `pu-${o[0].id.slice(0, 8)}@example.com`]);
  const { rows: c } = await query(
    `INSERT INTO companies (org_id, tally_guid, name) VALUES ($1,$2,'Pulse Books') RETURNING *`,
    [o[0].id, `pu-${o[0].id}`]);
  return { orgId: o[0].id, userId: u[0].id, co: c[0] };
}

const ctxFor = (f, qs = '') => ({
  session: { org: { id: f.orgId }, user: { id: f.userId, role: 'owner', roleId: null } },
  req: { headers: {}, socket: {} }, url: new URL(`http://x/${qs}`), body: {},
});

let seq = 0;
async function sale(f, { party, amount, daysAgo }) {
  const { rows } = await query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
     VALUES ($1,$2,$3,'Sales', (now() - ($4 || ' days')::interval)::date, $5, $6)
     RETURNING id, vch_date`,
    [f.co.id, `pv-${f.co.id}-${++seq}`, String(seq), String(daysAgo), party, amount]);
  return rows[0];
}

/** An invoice and the receipt that settled it, `took` days later. */
async function settled(f, { party, amount, daysAgo, took, termDays }) {
  const inv = await sale(f, { party, amount, daysAgo });
  const { rows: rec } = await query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
     VALUES ($1,$2,$3,'Receipt', (now() - ($4 || ' days')::interval)::date, $5, $6)
     RETURNING id`,
    [f.co.id, `pr-${f.co.id}-${++seq}`, String(seq), String(daysAgo - took), party, -amount]);

  const ref = `INV-${seq}`;
  await query(
    `INSERT INTO bills (company_id, voucher_id, ref, party, bill_date, due_date,
                        amount_paise, bill_type)
     VALUES ($1,$2,$3,$4, (now() - ($5 || ' days')::interval)::date,
             (now() - (($5::int - $6::int) || ' days')::interval)::date, $7, 'New Ref'),
            ($1,$8,$3,$4, (now() - (($5::int - $9::int) || ' days')::interval)::date,
             NULL, $10, 'Agst Ref')`,
    [f.co.id, inv.id, ref, party, String(daysAgo), String(termDays ?? 30),
     amount, rec[0].id, String(took), -amount]);
}

// --- who pays late ----------------------------------------------------------

test('a customer is judged against the terms they were given', async () => {
  /*
   * Somebody on 60-day terms paying in 45 is EARLY. Ranking on raw days would
   * put them below a customer on 7-day terms paying in 20, which is backwards.
   */
  const f = await shop();
  for (let i = 0; i < 2; i++) {
    await settled(f, { party: 'Long Terms', amount: 100000, daysAgo: 200 - i * 10,
                       took: 45, termDays: 60 });
    await settled(f, { party: 'Short Terms', amount: 100000, daysAgo: 200 - i * 10,
                       took: 20, termDays: 7 });
  }

  const out = await pulse.payers(ctxFor(f), f.co.tally_guid);
  const long = out.payers.find((p) => p.party === 'Long Terms');
  const short = out.payers.find((p) => p.party === 'Short Terms');

  assert.ok(long.daysAgainstTerms < 0, 'paying inside terms reads as early');
  assert.ok(short.daysAgainstTerms > 0, 'paying past terms reads as late');
  assert.equal(long.verdict, 'Pays early');
  // And the slow one is ranked first, despite the smaller raw number.
  assert.equal(out.payers[0].party, 'Short Terms');
});

test('open bills never count towards payment behaviour', async () => {
  /*
   * Including them flatters every customer early in a bill's life and ruins
   * them later, so the ranking would reshuffle daily with nothing happening.
   */
  const f = await shop();
  const inv = await sale(f, { party: 'Still Owing', amount: 500000, daysAgo: 100 });
  await query(
    `INSERT INTO bills (company_id, voucher_id, ref, party, bill_date, due_date,
                        amount_paise, bill_type)
     VALUES ($1,$2,'OPEN-1','Still Owing', now()::date, now()::date, 500000, 'New Ref')`,
    [f.co.id, inv.id]);

  const out = await pulse.payers(ctxFor(f), f.co.tally_guid);
  assert.ok(!out.payers.some((p) => p.party === 'Still Owing'));
});

test('one settled bill is not a pattern', async () => {
  // A single data point says nothing about how somebody pays.
  const f = await shop();
  await settled(f, { party: 'Once', amount: 100000, daysAgo: 100, took: 40, termDays: 10 });
  const out = await pulse.payers(ctxFor(f), f.co.tally_guid);
  assert.ok(!out.payers.some((p) => p.party === 'Once'));
});

test('the verdict is words, not a number to interpret', async () => {
  const f = await shop();
  for (let i = 0; i < 3; i++) {
    await settled(f, { party: 'Very Late', amount: 100000, daysAgo: 200 - i * 20,
                       took: 60, termDays: 15 });
  }
  const out = await pulse.payers(ctxFor(f), f.co.tally_guid);
  assert.equal(out.payers.find((p) => p.party === 'Very Late').verdict,
    'Consistently late');
});

// --- what moved -------------------------------------------------------------

test('movers rank by rupees moved, not by percentage', async () => {
  /*
   * A tiny customer tripling outranks a large one halving on any percentage
   * sort, and the second is the one worth a phone call.
   */
  const f = await shop();
  // Small customer triples: +600 rupees.
  await sale(f, { party: 'Tiny', amount: 30000, daysAgo: 120 });
  await sale(f, { party: 'Tiny', amount: 90000, daysAgo: 30 });
  // Large customer halves: -5,00,000.
  await sale(f, { party: 'Large', amount: 1000000, daysAgo: 120 });
  await sale(f, { party: 'Large', amount: 500000, daysAgo: 30 });

  const out = await pulse.movers(ctxFor(f), f.co.tally_guid);
  assert.equal(out.shrank[0].party, 'Large');
  assert.ok(Math.abs(out.shrank[0].changePaise) > Math.abs(out.grew[0].changePaise));
});

test('a first order is not reported as infinite growth', async () => {
  // "+100%" against zero is not growth, it is a new customer - a different and
  // more interesting fact.
  const f = await shop();
  await sale(f, { party: 'Brand New', amount: 200000, daysAgo: 20 });

  const out = await pulse.movers(ctxFor(f), f.co.tally_guid);
  const found = out.won.find((p) => p.party === 'Brand New');
  assert.ok(found, 'a new customer should appear as won');
  assert.equal(found.changePercent, null);
  assert.equal(found.firstTime, true);
});

test('a customer who stopped is called out separately', async () => {
  // The most actionable thing on the screen, and invisible in a top-ten list.
  const f = await shop();
  await sale(f, { party: 'Gone Quiet', amount: 800000, daysAgo: 120 });

  const out = await pulse.movers(ctxFor(f), f.co.tally_guid);
  assert.ok(out.lost.some((p) => p.party === 'Gone Quiet'));
});

// --- when the shop sells ----------------------------------------------------

test('a day the shop is closed does not drag its average down', async () => {
  /*
   * Averaging over every calendar Sunday makes a shop that never opens on
   * Sunday look like it has terrible Sundays rather than no Sundays.
   */
  const f = await shop();
  // Three Mondays only. Find a recent Monday to anchor on.
  const today = new Date();
  const backToMonday = (today.getDay() + 6) % 7;
  for (let w = 0; w < 3; w++) {
    await sale(f, { party: 'Walk-in', amount: 100000,
                    daysAgo: backToMonday + w * 7 });
  }

  const out = await pulse.rhythm(ctxFor(f), f.co.tally_guid);
  const monday = out.byDay.find((d) => d.day === 'Monday');
  assert.equal(monday.daysOpen, 3);
  assert.equal(monday.averagePaise, 100000, 'averaged over trading days only');
  assert.ok(out.closedOn.includes('Sunday'));
});

test('rhythm says so plainly when there is no pattern yet', async () => {
  const f = await shop();
  const out = await pulse.rhythm(ctxFor(f), f.co.tally_guid);
  assert.match(out.summary, /Not enough trading days/);
});

// --- how long the money lasts -----------------------------------------------

test('runway is withheld rather than shown as infinite', async () => {
  /*
   * A shop with no recorded expenses has not achieved infinite runway; Munim
   * simply cannot see its costs. Printing ∞ would be a lie with a symbol.
   */
  const f = await shop();
  await query(
    `INSERT INTO ledgers (company_id, guid, name, parent_group, closing_paise)
     VALUES ($1,$2,'Cash','Cash-in-Hand',500000)`, [f.co.id, `lc-${f.co.id}`]);

  const out = await pulse.runway(ctxFor(f), f.co.tally_guid);
  assert.equal(out.months, null);
  assert.equal(out.tone, 'unknown', 'unknown must not read as healthy');
  assert.match(out.basis, /cannot see any expenses/);
});

test('runway is computed over ninety days, not one month', async () => {
  /*
   * A single month is dominated by whatever fell in it - a rent quarter, an
   * insurance renewal - and a figure that swings between four months and eleven
   * depending on when you ask is not one anybody can act on.
   */
  const f = await shop();
  await query(
    `INSERT INTO ledgers (company_id, guid, name, parent_group, closing_paise)
     VALUES ($1,$2,'Cash','Cash-in-Hand',900000),
            ($1,$3,'Rent','Indirect Expenses',0)`,
    [f.co.id, `lc2-${f.co.id}`, `lr-${f.co.id}`]);

  // 3,00,000 of rent spread across the window: 1,00,000 a month.
  for (const daysAgo of [10, 40, 70]) {
    const v = await sale(f, { party: 'x', amount: 0, daysAgo });
    await query(
      `INSERT INTO voucher_entries (voucher_id, ledger_name, amount_paise)
       VALUES ($1,'Rent',100000)`, [v.id]);
  }

  const out = await pulse.runway(ctxFor(f), f.co.tally_guid);
  assert.equal(out.monthlyBurnPaise, 100000);
  assert.equal(out.months, 9, '9,000 of cash against 1,000 a month');
});

test('runway counts receivables separately, not silently', async () => {
  // Money owed usually does arrive, but it is not in the bank today, and one
  // number that quietly mixes the two overstates safety.
  const f = await shop();
  await query(
    `INSERT INTO ledgers (company_id, guid, name, parent_group, closing_paise)
     VALUES ($1,$2,'Cash','Cash-in-Hand',100000), ($1,$3,'Rent','Indirect Expenses',0)`,
    [f.co.id, `lc3-${f.co.id}`, `lr3-${f.co.id}`]);
  const v = await sale(f, { party: 'x', amount: 0, daysAgo: 30 });
  await query(`INSERT INTO voucher_entries (voucher_id, ledger_name, amount_paise)
               VALUES ($1,'Rent',300000)`, [v.id]);

  const inv = await sale(f, { party: 'Owes Us', amount: 400000, daysAgo: 10 });
  await query(
    `INSERT INTO bills (company_id, voucher_id, ref, party, bill_date, amount_paise, bill_type)
     VALUES ($1,$2,'R-1','Owes Us', now()::date, 400000, 'New Ref')`, [f.co.id, inv.id]);

  const out = await pulse.runway(ctxFor(f), f.co.tally_guid);
  assert.ok(out.monthsWithReceivables > out.months);
  assert.equal(out.receivablePaise, 400000);
});

// --- shape ------------------------------------------------------------------

test('every section can be fetched at once', async () => {
  const f = await shop();
  const out = await pulse.all(ctxFor(f), f.co.tally_guid);
  for (const k of ['payers', 'movers', 'rhythm', 'runway']) assert.ok(out[k], k);
});

test('none of it crosses businesses', async () => {
  const a = await shop();
  const b = await shop();
  for (const fn of [pulse.payers, pulse.movers, pulse.rhythm, pulse.runway]) {
    await assert.rejects(() => fn(ctxFor(b), a.co.tally_guid), (e) => e.status === 404);
  }
});
