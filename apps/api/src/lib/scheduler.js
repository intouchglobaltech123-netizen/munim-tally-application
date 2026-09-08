'use strict';
const { query } = require('../db');

/**
 * The jobs nobody triggers.
 *
 * Most of Munim happens because somebody opened a screen or a connector sent a
 * batch. A few things have to happen because a date arrived, and without a
 * runner they simply never do: an account scheduled for deletion would sit
 * "pending" for ever, which is the opposite of the promise made to the customer
 * who asked for it.
 *
 * In-process and deliberately small. A separate worker is the right answer at
 * scale, but it is another thing to deploy and another thing to be down, and at
 * this size a missed tick costs an hour of latency on a job measured in days.
 */

const HOURLY = 60 * 60 * 1000;

const jobs = [];
let timer = null;

/*
 * Every job is wrapped so one failure cannot stop the others.
 *
 * A scheduler that dies on the first bad row is worse than none: it stops
 * silently, and the thing it stopped doing is usually the thing nobody watches.
 */
async function runAll(reason) {
  for (const job of jobs) {
    try {
      const started = Date.now();
      const out = await job.run();
      const took = Date.now() - started;
      // Only log work, not the ninety-nine ticks that found nothing to do.
      if (out && Object.values(out).some((v) => typeof v === 'number' && v > 0)) {
        console.log(`  scheduler: ${job.name} ${JSON.stringify(out)} (${took}ms, ${reason})`);
      }
    } catch (e) {
      console.error(`  scheduler: ${job.name} failed:`, e.message);
    }
  }
}

/** Offers that were never answered. */
async function expireTransfers() {
  const { rowCount } = await query(
    `UPDATE owner_transfers SET status = 'expired', settled_at = now()
      WHERE status = 'pending' AND expires_at <= now()`);
  return { expired: rowCount };
}

/**
 * Backups past their retention limit lose their file, not their history.
 *
 * Run centrally as well as after each backup: a customer who stops taking
 * backups would otherwise keep the last batch for ever, which is a retention
 * policy that quietly does not apply to the accounts that left.
 */
async function pruneBackups() {
  const { rows } = await query(
    `SELECT id, backup_keep FROM orgs WHERE backup_keep IS NOT NULL`);
  let pruned = 0;
  for (const org of rows) {
    const { rowCount } = await query(
      `UPDATE backups SET payload = NULL, size_bytes = 0, enc_alg = 'none',
                          enc_iv = NULL, enc_tag = NULL
        WHERE org_id = $1 AND payload IS NOT NULL AND id NOT IN (
          SELECT id FROM backups WHERE org_id = $1 AND payload IS NOT NULL
           ORDER BY created_at DESC LIMIT $2)`,
      [org.id, org.backup_keep]);
    pruned += rowCount;
  }
  return { pruned };
}

/**
 * Tell people their Tally computer has stopped reporting.
 *
 * This check already existed, but only on the notification sweep that runs when
 * somebody OPENS the app - which is exactly backwards. The whole point of the
 * alert is to reach an owner who is not looking, and a shop whose PC died on
 * Friday and whose owner does not open Munim until Monday was told nothing for
 * three days while every figure quietly went stale.
 *
 * On a timer it reaches them where they are: the same raise() feeds the app's
 * notification list and push.
 */
const OFFLINE_HOURS = 6;

async function watchConnectors() {
  const events = require('./events');

  const { rows } = await query(`
    -- tenant-global: a scheduled sweep across every customer, on a timer, and
    -- never reachable from a request.
    SELECT o.id AS org_id,
           k.machine_name,
           k.last_seen_at,
           EXTRACT(EPOCH FROM (now() - k.last_seen_at)) / 3600 AS hours
      FROM orgs o
      JOIN LATERAL (
        SELECT machine_name, last_seen_at FROM connectors c
         WHERE c.org_id = o.id AND c.revoked_at IS NULL
         ORDER BY c.last_seen_at DESC NULLS LAST
         LIMIT 1
      ) k ON true
     WHERE o.delete_due_at IS NULL
       AND k.last_seen_at IS NOT NULL
       AND k.last_seen_at < now() - ($1 || ' hours')::interval`,
    [String(OFFLINE_HOURS)]);

  let told = 0;
  for (const r of rows) {
    const hours = Math.round(Number(r.hours));
    const raised = await events.raise(r.org_id, 'connector.offline', {
      title: 'The computer running Tally is offline',
      body: `${r.machine_name || 'It'} has not checked in for ${hours} hours. `
          + 'Figures in Munim are not current until it comes back.',
      link: { screen: 'sync' },
      /*
       * Once a day per business, not once per tick. An hourly job would
       * otherwise raise this twenty-four times before anybody read one, and a
       * notification list full of the same line is one nobody reads at all.
       */
      dedupeKey: `offline-${r.org_id}-${new Date().toISOString().slice(0, 10)}`,
    });
    if (raised) told++;
  }
  return { offlineAlerts: told };
}

function register(name, run) { jobs.push({ name, run }); }

function start() {
  // Required late: routes pull in lib/, so requiring one at module load would
  // close a cycle.
  const account = require('../routes/account');

  const subscription = require('../routes/subscription');

  register('due deletions', account.runDueDeletions);
  register('billing', subscription.runBilling);
  register('expire handovers', expireTransfers);
  register('prune backups', pruneBackups);
  register('offline connectors', watchConnectors);

  /*
   * Not run at boot.
   *
   * A restart loop would otherwise carry out every due deletion on every crash,
   * at the worst possible moment - while somebody is trying to work out why the
   * server keeps restarting. An hour's wait costs nothing on a job measured in
   * days.
   */
  timer = setInterval(() => runAll('hourly'), HOURLY);
  timer.unref?.();
  return { jobs: jobs.map((j) => j.name) };
}

const stop = () => { if (timer) clearInterval(timer); timer = null; };

module.exports = {
  start, stop, runAll, register, expireTransfers, pruneBackups, watchConnectors, jobs,
};
