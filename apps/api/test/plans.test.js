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

async function org(plan = 'basic', extra = {}) {
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
  const keys = Object.keys(plans.PLANS.pro.features);
  for (const [name, p] of Object.entries(plans.PLANS)) {
    for (const k of keys) {
      assert.ok(k in p.features, `plan "${name}" says nothing about "${k}"`);
    }
  }
});

test('the plans get more generous as they get more expensive', () => {
  // A ladder where a dearer plan allows less of something is a support call
  // and a refund, and it is the kind of thing a hand-edited table grows.
  const ladder = ['trial', 'basic', 'pro', 'enterprise'];
  const countable = ['companies', 'users', 'connectors', 'storageMb', 'backupKeep'];

  for (const key of countable) {
    let prev = -1;
    for (const name of ladder.slice(1)) {         // trial is deliberately generous
      const v = plans.PLANS[name].limits[key];
      const asNumber = v === null ? Infinity : v;
      assert.ok(asNumber >= prev,
        `${name} allows less ${key} (${v}) than the plan below it (${prev})`);
      prev = asNumber;
    }
  }
});

test('null means unlimited and nothing else does', () => {
  // Not 0, not -1, not a very large number: each of those reads as a real
  // limit somewhere downstream.
  assert.equal(plans.limitFor({ plan: 'enterprise' }, 'companies'), null);
  for (const p of Object.values(plans.PLANS)) {
    for (const v of Object.values(p.limits)) {
      assert.ok(v === null || (Number.isInteger(v) && v >= 0),
        `a limit is ${v}, which is neither null nor a count`);
    }
  }
});

test('a per-org override beats the plan', async () => {
  // Sales promises get made. The alternative is a bespoke plan per negotiation.
  const o = await org('basic', { companies: 7 });
  assert.equal(plans.limitFor(o, 'companies'), 7);
});

test('an override of null means unlimited for that customer', async () => {
  const o = await org('basic', { companies: null });
  assert.equal(plans.limitFor(o, 'companies'), null);
});

test('the older max_companies column still wins where it is set', async () => {
  /*
   * That column is what the admin screen has been writing to for months.
   * Ignoring it would silently reset every customer whose ceiling was raised
   * by hand, which is the worst possible day to discover a refactor.
   */
  const o = await org('basic');
  await query('UPDATE orgs SET max_companies = 4 WHERE id = $1', [o.id]);
  const { rows } = await query('SELECT * FROM orgs WHERE id = $1', [o.id]);
  assert.equal(plans.limitFor(rows[0], 'companies'), 4);
});

test('an unknown key in the overrides is ignored, not trusted', async () => {
  const o = await org('basic', { nonsense: 999 });
  assert.equal(plans.limitFor(o, 'companies'), 1);
});

test('a limit message names the plan, the number and where they are', () => {
  try {
    quotas.assertWithin({ plan: 'basic' }, 'users', 3);
    assert.fail('should have refused');
  } catch (e) {
    assert.match(e.message, /Basic/);
    assert.match(e.message, /3 people/);
    assert.match(e.message, /you are at 3/);
    assert.equal(e.status, 403);
    assert.equal(e.code, 'LIMIT_REACHED');
  }
});

test('a limit of one is written in the singular', () => {
  // "Basic includes 1 companies" is the kind of detail that reads as
  // sloppiness in a product somebody is trusting with their books.
  try {
    quotas.assertWithin({ plan: 'basic' }, 'companies', 1);
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
      quotas.assertWithin({ plan: 'pro' }, key, 99999);
    } catch (e) {
      assert.match(e.message, expect);
    }
  }
});

test('being exactly at the limit refuses the next one', () => {
  // Off by one here lets every plan sell one extra of everything.
  assert.throws(() => quotas.assertWithin({ plan: 'basic' }, 'companies', 1));
  assert.doesNotThrow(() => quotas.assertWithin({ plan: 'basic' }, 'companies', 0));
});

test('unlimited never refuses', () => {
  assert.doesNotThrow(() => quotas.assertWithin({ plan: 'enterprise' }, 'users', 10_000));
});

test('usage is counted from the data, not a stored total', async () => {
  /*
   * A counter drifts on every delete, failed write and restore. The first time
   * a customer is told they are at 15 of 15 users while looking at a list of
   * 11, the number has cost more in support than it ever saved in queries.
   */
  const o = await org('pro');
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
  const o = await org('pro');
  await query(`INSERT INTO users (org_id, email, role, status)
               VALUES ($1,$2,'owner','active'), ($1,$3,'member','disabled')`,
    [o.id, `qa-${o.id}@example.com`, `qb-${o.id}@example.com`]);
  const usage = await quotas.usageFor(o.id);
  assert.equal(usage.users, 1);
});

test('the report says what is left, and flags what is over', async () => {
  const o = await org('basic');
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
  const o = await org('enterprise');
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

test('the price list hides the internal plan', () => {
  const keys = plans.catalogue().map((p) => p.key);
  assert.ok(!keys.includes('internal'));
  assert.deepEqual(keys, ['trial', 'basic', 'pro', 'enterprise']);
});
