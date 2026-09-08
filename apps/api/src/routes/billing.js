'use strict';
const { query } = require('../db');
const auth = require('../lib/auth');
const perms = require('../lib/permissions');
const plans = require('../lib/plans');
const quotas = require('../lib/quotas');

/**
 * What the customer is on, what they are using, and what else they could buy.
 *
 * Read-only here. Actually taking money is a separate concern with a payment
 * gateway behind it; this is the part that has to be right whether or not that
 * exists, because a customer who cannot see why they were refused an eleventh
 * user will phone rather than upgrade.
 */

/** Their plan, their usage against it, and the ladder. */
async function overview(ctx) {
  const s = perms.require(auth.requireUser(ctx), 'settings', 'read');

  const { rows } = await query('SELECT * FROM orgs WHERE id = $1', [s.org.id]);
  const org = rows[0];
  const report = await quotas.report(org);

  const current = plans.plan(org.plan);
  const ladder = plans.catalogue();

  return {
    ...report,
    plan: {
      key: org.plan,
      label: current.label,
      pricePaise: current.pricePaise,
      blurb: current.blurb,
    },
    trial: plans.trialState(org),
    features: plans.featuresFor(org),
    /*
     * Which plans are actually a step UP from here.
     *
     * Showing a customer on Pro a card for Basic invites them to downgrade
     * themselves into a limit they are already over, and the resulting screen
     * says 140% of your allowance with no way forward.
     */
    upgrades: ladder.filter((p) => p.order > current.order || p.key === 'enterprise')
      .filter((p) => p.key !== org.plan),
    allPlans: ladder,
    note: 'Limits are counted from your data, not from a running total, so what '
        + 'you see here is what is actually there.',
  };
}

/** The price list, for a signed-out pricing page as much as a signed-in one. */
function pricing() {
  return {
    plans: plans.catalogue(),
    currency: 'INR',
    note: 'Prices exclude GST. Every plan reads your Tally data and never '
        + 'writes to it.',
  };
}

module.exports = { overview, pricing };
