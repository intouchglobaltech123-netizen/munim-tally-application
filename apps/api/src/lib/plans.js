'use strict';

/**
 * What a customer bought, and what that entitles them to.
 *
 * One table, used by three things that would otherwise drift apart: the pricing
 * page, the quota checks that enforce it, and the admin screen that overrides
 * it for one customer. Every time those live in separate places, the pricing
 * page eventually promises something the server refuses.
 *
 * Prices are in paise, like every other amount in this codebase. Limits are
 * counts, and null means "no ceiling" - never 0, never -1, and never a very
 * large number pretending to be infinity, because those all read as a real
 * limit somewhere downstream.
 */

/*
 * Sized for the Indian SMB this is actually sold to.
 *
 * A one-shop trader has one Tally on one counter PC and two or three people
 * looking at the numbers. A distributor runs three or four companies and a
 * dozen staff. The tiers follow that shape rather than a generic SaaS ladder,
 * which is why "companies" and "connectors" are the numbers that matter:
 * accounting rows are small, so storage never was the interesting lever.
 */
const PLANS = {
  /*
   * One plan. Munim is sold to Indian SMBs at a single price, so a ladder of
   * tiers would be three quarters of a pricing page nobody reads and three
   * quarters of a quota matrix nobody tests. The limits below are the ones
   * that protect the service, not ones designed to push an upgrade.
   */
  standard: {
    label: 'Munim',
    pricePaise: 1000000,          // Rs 10,000 a month
    order: 1,
    blurb: 'Every company, every report, every device. One price.',
    limits: {
      companies: null, users: null, connectors: null, devicesPerUser: 5,
      whatsappPerMonth: null, smsPerMonth: null,
      eInvoicesPerMonth: null, eWayBillsPerMonth: null,
    },
    features: {
      dashboard: true, outstanding: true, parties: true, reports: true,
      statements: true, stock: true, reminders: true, multiCompany: true,
      export: true,
    },
  },

  /*
   * Still here, still not listed: an account has to be on something between
   * signing up and paying, and giving that state its own row keeps the trial
   * out of every "is this a real customer" query.
   */
  trial: {
    label: 'Free trial',
    pricePaise: 0,
    days: 14,
    order: 0,
    hidden: true,
    blurb: 'The whole product, for a fortnight, with no card.',
    limits: {
      companies: 2, users: 3, connectors: 1, devicesPerUser: 2,
      whatsappPerMonth: 50, smsPerMonth: 0,
      eInvoicesPerMonth: 0, eWayBillsPerMonth: 0,
    },
    features: {
      dashboard: true, outstanding: true, parties: true, reports: true,
      statements: true, stock: true, reminders: true, multiCompany: true,
      export: true,
    },
  },

  /*
   * Not sold. Your own account, and the demo books.
   *
   * Kept in the same table rather than special-cased in code, so that a staff
   * account goes through exactly the same quota path as a customer - which is
   * the only way the quota path stays tested.
   */
  internal: {
    label: 'Internal',
    pricePaise: 0,
    order: 99,
    hidden: true,
    blurb: 'Munim\u2019s own account.',
    limits: {
      companies: null, users: null, connectors: null, devicesPerUser: 10,
      whatsappPerMonth: null, smsPerMonth: null,
      eInvoicesPerMonth: null, eWayBillsPerMonth: null,
    },
    features: {
      dashboard: true, outstanding: true, parties: true, reports: true,
      statements: true, stock: true, reminders: true, multiCompany: true,
      export: true,
    },
  },
};

/*
 * What each limit is called in front of a customer, and how it is counted.
 *
 * `noun` is written out rather than derived from `label`, because deriving it
 * means lower-casing, and lower-casing turns "Tally computers" into "tally
 * computers" and "WhatsApp messages" into "whatsapp messages". A product that
 * mangles its own brand names in an error message looks assembled rather than
 * written, and this string is read at exactly the moment somebody is deciding
 * whether to pay more.
 */
const LIMITS = {
  companies:           { label: 'Companies',           noun: 'companies',       one: 'company',        unit: 'books' },
  users:               { label: 'People',              noun: 'people',          one: 'person',         unit: 'users' },
  connectors:          { label: 'Tally computers',     noun: 'Tally computers', one: 'Tally computer', unit: 'computers' },
  devicesPerUser:      { label: 'Devices per person',  noun: 'devices each',    one: 'device each',    unit: 'devices' },
  whatsappPerMonth:    { label: 'WhatsApp messages',   noun: 'WhatsApp messages', one: 'WhatsApp message', unit: 'a month', monthly: true },
  smsPerMonth:         { label: 'SMS',                 noun: 'SMS',             one: 'SMS',            unit: 'a month', monthly: true },
  eInvoicesPerMonth:   { label: 'E-Invoices',          noun: 'E-Invoices',      one: 'E-Invoice',      unit: 'a month', monthly: true },
  eWayBillsPerMonth:   { label: 'E-Way Bills',         noun: 'E-Way Bills',     one: 'E-Way Bill',     unit: 'a month', monthly: true },
};

const plan = (key) => PLANS[key] ?? PLANS.trial;

/** The public price list, in display order, without the internal plan. */
const catalogue = () =>
  Object.entries(PLANS)
    .filter(([, p]) => !p.hidden)
    .sort((a, b) => a[1].order - b[1].order)
    .map(([key, p]) => ({
      key,
      label: p.label,
      pricePaise: p.pricePaise,
      blurb: p.blurb,
      days: p.days ?? null,
      quoted: false,
      limits: p.limits,
      features: p.features,
    }));

/**
 * One org's ceiling for one thing.
 *
 * A per-org override beats the plan, because sales promises get made and the
 * alternative is inventing a bespoke plan for every negotiation. Stored on the
 * org as a jsonb `limits` blob; an unknown key there is ignored rather than
 * trusted, the same way features already work.
 */
function limitFor(org, key) {
  const overrides = (org && org.limits) || {};
  if (Object.prototype.hasOwnProperty.call(overrides, key)) {
    const v = overrides[key];
    if (v === null) return null;                    // explicitly unlimited
    if (Number.isFinite(Number(v))) return Number(v);
  }

  /*
   * The two columns that predate this module still win where they are set.
   *
   * They are what the admin screen has been writing to for months, and quietly
   * ignoring them would silently reset every customer who has ever had their
   * ceiling raised by hand.
   */
  if (key === 'connectors' && org?.max_connectors != null) return Number(org.max_connectors);
  if (key === 'companies' && org?.max_companies != null) return Number(org.max_companies);

  return plan(org?.plan).limits[key] ?? null;
}

/** Everything at once, for a settings or admin screen. */
function limitsFor(org) {
  const out = {};
  for (const key of Object.keys(LIMITS)) out[key] = limitFor(org, key);
  return out;
}

/** Plan features, then per-org overrides, exactly like limits. */
function featuresFor(org) {
  const base = plan(org?.plan).features;
  const stored = (org && org.features) || {};
  const out = {};
  for (const key of Object.keys(base)) {
    out[key] = typeof stored[key] === 'boolean' ? stored[key] : base[key];
  }
  return out;
}

/** Is this plan still within its trial, and for how much longer? */
function trialState(org) {
  if (org?.plan !== 'trial' || !org?.trial_ends_at) return { trial: false, daysLeft: null };
  const daysLeft = Math.ceil((new Date(org.trial_ends_at) - Date.now()) / 86400000);
  return { trial: true, daysLeft, expired: daysLeft <= 0 };
}

module.exports = { PLANS, LIMITS, plan, catalogue, limitFor, limitsFor, featuresFor, trialState };
