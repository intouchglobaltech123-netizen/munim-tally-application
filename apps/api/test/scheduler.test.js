const { test, after } = require('node:test');
const assert = require('node:assert');
const { query } = require('../src/db');
const scheduler = require('../src/lib/scheduler');

/**
 * The jobs nobody triggers.
 *
 * Everything here happens because a date arrived, which means none of it
 * happens unless something asks - and a job that silently stopped running looks
 * exactly like a job with nothing to do.
 */

const orgs = [];
after(async () => { for (const id of orgs) await query('DELETE FROM orgs WHERE id = $1', [id]); });

async function shopWithConnector(hoursAgo) {
  const { rows: o } = await query(
    `INSERT INTO orgs (name, plan) VALUES ('sched-test','internal') RETURNING *`);
  orgs.push(o[0].id);
  await query(
    `INSERT INTO users (org_id, email, role) VALUES ($1,$2,'owner')`,
    [o[0].id, `sc-${o[0].id.slice(0, 8)}@example.com`]);
  await query(
    `INSERT INTO connectors (org_id, machine_name, token_hash, last_seen_at)
     VALUES ($1,'SHOP-PC',$2, now() - ($3 || ' hours')::interval)`,
    [o[0].id, `sc-${o[0].id}`, String(hoursAgo)]);
  return o[0].id;
}

const alertsFor = async (orgId) => (await query(
  `SELECT count(*)::int AS n FROM notifications
    WHERE org_id = $1 AND event = 'connector.offline'`, [orgId])).rows[0].n;

test('a shop whose Tally computer died is told without anyone opening the app', async () => {
  /*
   * This check used to live only on the sweep that runs when somebody opens
   * Munim, which is exactly backwards: the whole point is to reach an owner who
   * is NOT looking. A PC that died on Friday told nobody until Monday.
   */
  const orgId = await shopWithConnector(30);
  await scheduler.watchConnectors();
  assert.equal(await alertsFor(orgId), 1);
});

test('a healthy connector raises nothing', async () => {
  const orgId = await shopWithConnector(1);
  await scheduler.watchConnectors();
  assert.equal(await alertsFor(orgId), 0);
});

test('the same shop is told once a day, not once a tick', async () => {
  // An hourly job would otherwise raise this twenty-four times before anybody
  // read one, and a list full of the same line is one nobody reads at all.
  const orgId = await shopWithConnector(30);
  await scheduler.watchConnectors();
  await scheduler.watchConnectors();
  await scheduler.watchConnectors();
  assert.equal(await alertsFor(orgId), 1);
});

test('an account on its way out is left alone', async () => {
  // Nagging somebody who has asked to close their account is noise.
  const orgId = await shopWithConnector(30);
  await query(
    `UPDATE orgs SET delete_requested_at = now(),
            delete_due_at = now() + interval '30 days' WHERE id = $1`, [orgId]);
  await scheduler.watchConnectors();
  assert.equal(await alertsFor(orgId), 0);
});

test('a connector that has never reported is not treated as newly offline', async () => {
  /*
   * last_seen_at NULL means it was paired and never once checked in - that is a
   * setup that did not finish, not a computer that stopped. Telling somebody it
   * "went offline" sends them looking for a machine that was never working.
   */
  const { rows: o } = await query(
    `INSERT INTO orgs (name, plan) VALUES ('never-seen','internal') RETURNING *`);
  orgs.push(o[0].id);
  await query(
    `INSERT INTO connectors (org_id, machine_name, token_hash) VALUES ($1,'NEW-PC',$2)`,
    [o[0].id, `ns-${o[0].id}`]);

  await scheduler.watchConnectors();
  assert.equal(await alertsFor(o[0].id), 0);
});

test('every registered job runs even when one of them throws', async () => {
  /*
   * A scheduler that dies on the first bad row is worse than none: it stops
   * silently, and the thing it stopped doing is usually the thing nobody
   * watches.
   */
  const ran = [];
  scheduler.jobs.length = 0;
  scheduler.register('explodes', async () => { throw new Error('boom'); });
  scheduler.register('still runs', async () => { ran.push('yes'); return { done: 1 }; });

  await scheduler.runAll('test');
  assert.deepEqual(ran, ['yes']);
  scheduler.jobs.length = 0;
});
