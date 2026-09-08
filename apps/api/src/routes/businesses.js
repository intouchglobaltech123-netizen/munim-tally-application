'use strict';
const auth = require('../lib/auth');
const perms = require('../lib/permissions');
const audit = require('../lib/audit');
const lib = require('../lib/businesses');
const quotas = require('../lib/quotas');
const { query } = require('../db');
const { HttpError, bad } = require('../lib/http');

/**
 * Which Tally files are the same shop.
 *
 * Worth a screen of its own rather than being invisible, for two reasons: the
 * grouping decides what a customer is charged for, and the guess can be wrong.
 * Anything that affects a bill and can be wrong has to be visible and
 * correctable.
 */

async function list(ctx) {
  const s = perms.require(auth.requireUser(ctx), 'settings', 'read');

  const { rows: org } = await query('SELECT * FROM orgs WHERE id = $1', [s.org.id]);
  const groups = await lib.list(s.org.id);
  const usage = await quotas.usageFor(s.org.id);

  return {
    businesses: groups,
    /*
     * Both counts, side by side. "2 of 5 companies" next to a list of six files
     * looks like a bug unless the screen explains that the six are two shops.
     */
    counts: {
      businesses: usage.companies,
      files: usage.companyFiles,
      limit: require('../lib/plans').limitFor(org[0], 'companies'),
    },
    note: groups.some((g) => g.companies > 1)
      ? 'Your plan counts businesses, not Tally files — several years of the '
        + 'same shop count once.'
      : 'If you start a new Tally company each financial year, Munim groups '
        + 'those years together on its own.',
  };
}

/** Put a file with another shop, or split it out on its own. */
async function regroup(ctx, tallyGuid) {
  const s = perms.require(auth.requireUser(ctx), 'settings', 'update');

  const target = ctx.body?.businessId ?? null;
  if (target !== null && typeof target !== 'string') {
    throw bad('BAD_TARGET', 'Give a business to move it to, or nothing to split it out.');
  }

  const out = await lib.regroup(s.org.id, decodeURIComponent(tallyGuid), target);
  if (!out) throw new HttpError(404, 'NOT_FOUND', 'No such company, or no such business.');

  await audit.record(ctx, 'company.regroup', {
    entityId: tallyGuid,
    meta: { movedTo: target ?? 'its own business' },
  });

  return {
    businesses: out,
    message: target
      ? 'Moved. Those years now count as one business on your plan.'
      : 'Split out. It counts as its own business from now on.',
  };
}

module.exports = { list, regroup };
