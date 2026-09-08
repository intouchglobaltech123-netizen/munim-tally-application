'use strict';
const { HttpError } = require('./http');

/**
 * What each customer is allowed to do.
 *
 * Ten customers on one server will not all buy the same thing, so features are
 * data on the org rather than a build per customer. This module is the only
 * place that decides, which matters for two reasons:
 *
 *  - the apps ask the server what to show, so a customer editing their own
 *    client cannot turn a paid feature on
 *  - a new feature is one entry here plus an UPDATE, not a migration
 *
 * Defaults are deliberately generous for the things every customer needs and
 * closed for the things that cost money or imply a bigger plan.
 */

const CATALOGUE = {
  // Always on: without these there is no product.
  dashboard:   { label: 'Dashboard',            default: true },
  outstanding: { label: 'Outstanding & ageing', default: true },
  parties:     { label: 'Party statements',     default: true },

  // Ordinary paid features.
  reports:     { label: 'Reports',              default: true },
  statements:  { label: 'Day Book, P&L, Balance Sheet', default: true },
  stock:       { label: 'Stock & items',        default: true },

  // Cost real money or imply a larger plan.
  reminders:   { label: 'WhatsApp reminders',   default: false, note: 'Uses message credits' },
  multiCompany:{ label: 'Multiple companies',   default: false, note: 'More than one book' },
  export:      { label: 'Export to Excel / PDF', default: false },
  api:         { label: 'API access',           default: false, note: 'For their own tools' },
};

/** Everything the catalogue knows, for the admin screen. */
const catalogue = () =>
  Object.entries(CATALOGUE).map(([key, v]) => ({ key, ...v }));

/**
 * Resolve one org's features: catalogue defaults, overridden by whatever is
 * stored. An unknown key in the database is ignored rather than trusted.
 */
function featuresFor(org) {
  const stored = (org && org.features) || {};
  const out = {};
  for (const [key, v] of Object.entries(CATALOGUE)) {
    out[key] = typeof stored[key] === 'boolean' ? stored[key] : v.default;
  }
  return out;
}

const has = (org, key) => featuresFor(org)[key] === true;

/**
 * Refuse a request for a feature this customer does not have.
 *
 * 403 with a message they can act on - "ask us to enable it" - rather than a
 * 404, because the feature does exist and pretending otherwise makes support
 * calls longer.
 */
function requireFeature(session, key) {
  if (has(session.org, key)) return;
  const label = CATALOGUE[key]?.label ?? key;
  throw new HttpError(403, 'FEATURE_NOT_ENABLED',
    `${label} is not enabled on your plan. Contact Munim to add it.`);
}

/*
 * Ceilings used to live here as requireWithinLimit(). They are in lib/quotas.js
 * now, against lib/plans.js, because two places deciding a limit is how a
 * pricing page ends up promising something the server refuses. This module is
 * about yes/no features only.
 */

module.exports = { catalogue, featuresFor, has, requireFeature, CATALOGUE };
