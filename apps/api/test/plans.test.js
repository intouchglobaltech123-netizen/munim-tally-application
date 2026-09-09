const { test, after } = require('node:test');
const assert = require('node:assert');
const { query } = require('../src/db');
const plans = require('../src/lib/plans');
const quotas = require('../src/lib/quotas');

/**
 * Plans and quotas.
 *
 * The limit message is read at exactly the moment somebody is deciding whether
 * to pay more, so it gets as much attention here as the arithmetic.
 */

const orgs = [];
after(async () => { for (const id of orgs) await query('DELETE FROM orgs WHERE id = $1', [id]); });

async function org(plan = 'standard', extra = {}) {
  const { rows } = await query(
    `INSERT INTO orgs (name, plan, limits) VALUES ($1,$2,$3::jsonb) RETURNING *`,
    ['plan-test', plan, JSON.stringify(extra)]);
  orgs.push(rows[0].id);
  return rows[0];
}

test('every plan defines every limit', () => {
  // A plan missing a key silently inherits null, which means unlimited - so a
  // typo in the table gives something away for free.
  const keys = Object.keys(plans.LIMITS);
  for (const [name, p] of Object.entries(plans.PLANS)) {
    for (const k of keys) {
      assert.ok(k in p.limits, `plan "${name}" has no limit for "${k}"`);
    }
  }
});

test('every plan defines every feature', () => {
  const keys = Object.keys(plans.PLANS.standard.features);
  for (const [name, p] of Object.entries(plans.PLANS)) {
    for (const k of keys) {
      assert.ok(k in p.features, `plan "${name}" says nothing about "${k}"`);
    }
  }
});

test('paying is never worse than trialling', () => {
  // There is one plan now, so there is no ladder to keep in order. What is
  // left is the promise the trial makes: it advertises the paid product, so
  // paying must not take anything away. A customer whose trial ended and who
  // then found they could connect fewer computers would be right to ask for
  // their money back.
  const countable = ['companies', 'users', 'connectors', 'devicesPerUser'];

  for (const key of countable) {
    const trial = plans.PLANS.trial.limits[key];
    const paid = plans.PLANS.standard.limits[key];
    const n = (v) => (v === null ? Infinity : v);
    assert.ok(n(paid) >= n(trial),
      `paying allows less ${key} (${paid}) than the trial did (${trial})`);
  }
});

test('there is exactly one plan for sale', () => {
  // The pricing page, the quota checks and the admin override all read this
  // table. If a second sellable plan ever reappears it has to be deliberate.
  const sold = plans.catalogue();
  assert.equal(sold.length, 1);
  assert.equal(sold[0].key, 'standard');
  assert.equal(sold[0].pricePaise, 1000000, 'Rs 10,000 a month, in paise');
});

test('null means unlimited and nothing else does', () => {
  // Not 0, not -1, not a very large number: each of those reads as a real
  // limit somewhere downstream.
  assert.equal(plans.limitFor({ plan: 'standard' }, 'companies'), null);
  for (const p of Object.values(plans.PLANS)) {
    for (const v of Object.values(p.limits)) {
      assert.ok(v === null || (Number.isInteger(v) && v >= 0),
        `a limit is ${v}, which is neither null nor a count`);
    }
  }
});

test('a per-org override beats the plan', async () => {
  // Sales promises get made. The alternative is a bespoke plan per negotiation.
  const o = await org('standard', { companies: 7 });
  assert.equal(plans.limitFor(o, 'companies'), 7);
});

test('an override of null means unlimited for that customer', async () => {
  const o = await org('standard', { companies: null });
  assert.equal(plans.limitFor(o, 'companies'), null);
});

test('the older max_companies column still wins where it is set', async () => {
  /*
   * That column is what the admin screen has been writing to for months.
   * Ignoring it would silently reset every customer whose ceiling was raised
   * by hand, which is the worst possible day to discover a refactor.
   */
  const o = await org('standard');
  await query('UPDATE orgs SET max_companies = 4 WHERE id = $1', [o.id]);
  const { rows } = await query('SELECT * FROM orgs WHERE id = $1', [o.id]);
  assert.equal(plans.limitFor(rows[0], 'companies'), 4);
});

test('an unknown key in the overrides is ignored, not trusted', async () => {
  const o = await org('standard', { nonsense: 999 });
  // The junk key must not disturb a real limit: companies falls through to
  // the plan, which sets no ceiling. (limitFor is only ever asked about keys
  // in the LIMITS table, so a junk key is inert rather than rejected.)
  assert.equal(plans.limitFor(o, 'companies'), null);
});

test('a limit message names the plan, the number and where they are', () => {
  try {
    quotas.assertWithin({ plan: 'trial' }, 'users', 3);
    assert.fail('should have refused');
  } catch (e) {
    assert.match(e.message, /Free trial/);
    assert.match(e.message, /3 people/);
    assert.match(e.message, /you are at 3/);
    assert.equal(e.status, 403);
    assert.equal(e.code, 'LIMIT_REACHED');
  }
});

test('a limit of one is written in the singular', () => {
  // "Free trial includes 1 companies" is the kind of detail that reads as
  // sloppiness in a product somebody is trusting with their books.
  try {
    quotas.assertWithin({ plan: 'trial', limits: { companies: 1 } }, 'companies', 1);
  } catch (e) {
    assert.match(e.message, /1 company,/);
  }
});

test('brand names survive the message', () => {
  // "whatsapp messages" and "tally computers" look assembled, not written.
  for (const [key, count, expect] of [
    ['whatsappPerMonth', 100, /WhatsApp messages/],
    ['connectors', 1, /Tally computer/],
    ['eWayBillsPerMonth', 500, /E-Way Bills/],
  ]) {
    try {
      quotas.assertWithin({ plan: 'trial' }, key, 99999);
    } catch (e) {
      assert.match(e.message, expect);
    }
  }
});

test('being exactly at the limit refuses the next one', () => {
  // Off by one here lets every ceiling sell one extra of everything.
  const capped = { plan: 'standard', limits: { companies: 1 } };
  assert.throws(() => quotas.assertWithin(capped, 'companies', 1));
  assert.doesNotThrow(() => quotas.assertWithin(capped, 'companies', 0));
});

test('unlimited never refuses', () => {
  assert.doesNotThrow(() => quotas.assertWithin({ plan: 'standard' }, 'users', 10_000));
});

test('usage is counted from the data, not a stored total', async () => {
  /*
   * A counter drifts on every delete, failed write and restore. The first time
   * a customer is told they are at 15 of 15 users while looking at a list of
   * 11, the number has cost more in support than it ever saved in queries.
   */
  const o = await org('standard');
  await query(
    `INSERT INTO companies (org_id, tally_guid, name) VALUES ($1,$2,'A'),($1,$3,'B')`,
    [o.id, `q-${o.id}-1`, `q-${o.id}-2`]);
  await query(
    `INSERT INTO users (org_id, email, role) VALUES ($1,$2,'owner')`,
    [o.id, `q-${o.id}@example.com`]);

  const usage = await quotas.usageFor(o.id);
  assert.equal(usage.companies, 2);
  assert.equal(usage.users, 1);
});

test('a disabled person does not use a seat', async () => {
  const o = await org('standard');
  await query(`INSERT INTO users (org_id, email, role, status)
               VALUES ($1,$2,'owner','active'), ($1,$3,'member','disabled')`,
    [o.id, `qa-${o.id}@example.com`, `qb-${o.id}@example.com`]);
  const usage = await quotas.usageFor(o.id);
  assert.equal(usage.users, 1);
});

test('the report says what is left, and flags what is over', async () => {
  // An override, since the sold plan has no company ceiling. Being over a
  // limit is still reachable - an admin lowers one, or a customer is moved to
  // a tighter override after the fact - and the report has to say so rather
  // than showing a tidy 100%.
  const o = await org('standard', { companies: 1 });
  await query(`INSERT INTO companies (org_id, tally_guid, name) VALUES ($1,$2,'A'),($1,$3,'B')`,
    [o.id, `r-${o.id}-1`, `r-${o.id}-2`]);

  const r = await quotas.report(o);
  const companies = r.lines.find((l) => l.key === 'companies');
  assert.equal(companies.used, 2);
  assert.equal(companies.limit, 1);
  assert.equal(companies.over, true, 'a customer moved to a smaller plan can be over');
  assert.equal(companies.pct, 100, 'the bar is capped even when the truth is not');
  assert.ok(r.atLimit.includes('Companies'));
});

test('an unlimited line reads as unlimited rather than as 0%', async () => {
  const o = await org('standard');
  const r = await quotas.report(o);
  const companies = r.lines.find((l) => l.key === 'companies');
  assert.equal(companies.unlimited, true);
  assert.match(companies.summary, /no limit/);
});

test('the trial reports how long is left', async () => {
  const o = await org('trial');
  await query(`UPDATE orgs SET trial_ends_at = now() + interval '5 days' WHERE id = $1`, [o.id]);
  const { rows } = await query('SELECT * FROM orgs WHERE id = $1', [o.id]);
  const st = plans.trialState(rows[0]);
  assert.equal(st.trial, true);
  assert.ok(st.daysLeft >= 4 && st.daysLeft <= 5);
});

test('an expired trial says so', async () => {
  const o = await org('trial');
  await query(`UPDATE orgs SET trial_ends_at = now() - interval '1 day' WHERE id = $1`, [o.id]);
  const { rows } = await query('SELECT * FROM orgs WHERE id = $1', [o.id]);
  assert.equal(plans.trialState(rows[0]).expired, true);
});

test('the database refuses a plan Munim does not sell', async () => {
  // Without this a typo in an admin screen silently drops somebody onto trial
  // limits, and nobody notices until they are refused a second company.
  await assert.rejects(
    () => query(`INSERT INTO orgs (name, plan) VALUES ('bad','gold')`),
    /orgs_plan_known|violates check constraint/);
});

test('the price list shows only what is for sale', () => {
  const keys = plans.catalogue().map((p) => p.key);
  assert.ok(!keys.includes('internal'), 'Munim\u2019s own account is not a product');
  assert.ok(!keys.includes('trial'), 'the trial is a state, not something to buy');
  assert.deepEqual(keys, ['standard']);
});
