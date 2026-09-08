'use strict';
const { HttpError } = require('./http');

/**
 * What each person may see and do.
 *
 * Two rules hold this together, and both matter more than the matrix itself:
 *
 *   1. Absent means denied. A module missing from a role's permissions grants
 *      nothing. Defaulting the other way means one forgotten entry hands a
 *      salesperson the balance sheet.
 *
 *   2. The server decides. The apps read the same matrix to hide what a person
 *      cannot use, but hiding a button is presentation - every route checks
 *      for itself, because a hidden button is still a reachable URL.
 */

/*
 * Modules, as a shop owner would name them.
 *
 * Deliberately not one per screen. "Can the accountant see purchases" is a
 * question people can answer; "can they see /txn/debit-note" is not, and a
 * permission nobody understands gets granted to everyone to make the
 * complaints stop.
 */
const MODULES = {
  dashboard:   { label: 'Dashboard', hint: 'The home screen and its totals.' },
  sales:       { label: 'Sales', hint: 'Sales invoices, credit notes, sales analysis.' },
  purchase:    { label: 'Purchase', hint: 'Purchase bills, debit notes, supplier analysis.' },
  outstanding: { label: 'Outstanding', hint: 'Who owes money, ageing, reminders.' },
  ledgers:     { label: 'Ledgers & parties', hint: 'Party balances and statements.' },
  inventory:   { label: 'Stock', hint: 'Items, quantities and stock value.' },
  reports:     { label: 'Reports', hint: 'Trial balance, P&L, balance sheet, day book.' },
  insights:    { label: 'Insights', hint: 'Rankings, ageing and what needs attention.' },
  cashbank:    { label: 'Cash & bank', hint: 'Cash and bank balances.' },
  sync:        { label: 'Sync & connector', hint: 'Connector health, history and logs.' },
  users:       { label: 'Users & roles', hint: 'Inviting people and setting what they see.' },
  settings:    { label: 'Settings', hint: 'Company settings, licences, devices.' },
};

/*
 * Actions.
 *
 * `read` is the only one most of these modules can currently do anything with,
 * because Munim reads Tally and never writes to it. The rest are real for the
 * things Munim itself owns - users, settings, reminders - and are defined now
 * so a role written today still means the same thing when more is possible.
 */
const ACTIONS = {
  read:    { label: 'View', hint: 'See this section at all.' },
  create:  { label: 'Create', hint: 'Add new records.' },
  update:  { label: 'Edit', hint: 'Change existing records.' },
  delete:  { label: 'Delete', hint: 'Remove records.' },
  export:  { label: 'Export', hint: 'Download as PDF, Excel or CSV.' },
  share:   { label: 'Share', hint: 'Send by WhatsApp or email.' },
  print:   { label: 'Print', hint: 'Print a document.' },
  approve: { label: 'Approve', hint: 'Sign off something another person entered.' },
};

const ALL = Object.keys(MODULES);
const READ_ONLY = (mods) => Object.fromEntries(mods.map((m) => [m, ['read']]));

/*
 * The roles a business actually has.
 *
 * Every one of these is a real job in an Indian SMB, and the differences
 * between them are the ones owners care about: the accountant sees the
 * statements but not the user list; the salesperson sees what they sold and
 * who owes for it, and never the profit.
 */
const BUILT_IN = [
  {
    key: 'owner',
    name: 'Owner',
    description: 'Full access, including users, licences and settings.',
    permissions: Object.fromEntries(
      ALL.map((m) => [m, Object.keys(ACTIONS)])),
  },
  {
    key: 'admin',
    name: 'Admin',
    description: 'Everything except the things that cost money or close the account.',
    permissions: {
      ...Object.fromEntries(ALL.map((m) => [m, ['read', 'export', 'share', 'print']])),
      users: ['read', 'create', 'update'],
      sync: ['read', 'update'],
      settings: ['read', 'update'],
    },
  },
  {
    key: 'accountant',
    name: 'Accountant',
    description: 'Every figure and statement. Cannot change users or settings.',
    permissions: {
      ...READ_ONLY(['dashboard', 'sales', 'purchase', 'outstanding', 'ledgers',
                    'inventory', 'reports', 'insights', 'cashbank']),
      // The reason an accountant is given this product at all.
      reports: ['read', 'export', 'print', 'share'],
      ledgers: ['read', 'export', 'print', 'share'],
      outstanding: ['read', 'export', 'print', 'share'],
      sync: ['read'],
    },
  },
  {
    key: 'manager',
    name: 'Manager',
    description: 'Day-to-day trading and collections. No balance sheet, no settings.',
    permissions: {
      ...READ_ONLY(['dashboard', 'sales', 'purchase', 'outstanding', 'ledgers',
                    'inventory', 'insights', 'cashbank']),
      outstanding: ['read', 'export', 'share', 'print'],
      sales: ['read', 'export', 'share', 'print'],
      sync: ['read'],
    },
  },
  {
    key: 'salesperson',
    name: 'Salesperson',
    description: 'Their own sales and the money owed against them. No profit, no purchases.',
    permissions: {
      // No `purchase` and no `reports`: what a shop pays for its stock is the
      // one figure owners are most reluctant to show the people selling it.
      ...READ_ONLY(['dashboard', 'sales', 'outstanding', 'ledgers', 'inventory']),
      outstanding: ['read', 'share'],
    },
  },
  {
    key: 'employee',
    name: 'Employee',
    description: 'Look up a party or an item. Nothing financial.',
    permissions: READ_ONLY(['ledgers', 'inventory']),
  },
];

/** Reject anything that is not a real module/action pair. */
function validate(permissions) {
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) {
    throw new HttpError(400, 'BAD_PERMISSIONS', 'Permissions must be an object.');
  }
  const clean = {};
  for (const [mod, acts] of Object.entries(permissions)) {
    if (!MODULES[mod]) {
      throw new HttpError(400, 'BAD_MODULE', `There is no "${mod}" section.`);
    }
    if (!Array.isArray(acts)) {
      throw new HttpError(400, 'BAD_ACTIONS', `Actions for "${mod}" must be a list.`);
    }
    for (const a of acts) {
      if (!ACTIONS[a]) throw new HttpError(400, 'BAD_ACTION', `There is no "${a}" action.`);
    }
    // An empty list is the same as not being here at all, so it is dropped
    // rather than stored - otherwise "granted nothing" and "not granted" are
    // two states that read identically and behave identically.
    const uniq = [...new Set(acts)];
    if (uniq.length) clean[mod] = uniq;
  }
  return clean;
}

/**
 * May this session do this?
 *
 * The owner short-circuit is not a convenience: an account whose only user
 * locks themselves out of `users` has no way back in without support, and
 * every role can be edited by someone.
 */
function can(session, moduleKey, action = 'read') {
  if (!session?.user) return false;
  if (session.user.role === 'platform_admin') return true;
  if (session.user.role === 'owner' && !session.user.roleId) return true;

  const perms = session.user.permissions;
  // No role resolved yet - an account created before roles existed. Treated as
  // owner, because the alternative is locking existing customers out of their
  // own books on deploy.
  if (!perms) return session.user.role === 'owner';

  const acts = perms[moduleKey];
  return Array.isArray(acts) && acts.includes(action);
}

function require_(session, moduleKey, action = 'read') {
  if (!can(session, moduleKey, action)) {
    const m = MODULES[moduleKey]?.label ?? moduleKey;
    const a = ACTIONS[action]?.label?.toLowerCase() ?? action;
    throw new HttpError(403, 'FORBIDDEN',
      `You do not have permission to ${a} ${m}. Ask the account owner.`);
  }
  return session;
}

/** The shape the apps render their navigation from. */
const summarise = (session) => Object.fromEntries(
  ALL.map((m) => [m, Object.fromEntries(
    Object.keys(ACTIONS).map((a) => [a, can(session, m, a)]))]));

module.exports = {
  MODULES, ACTIONS, BUILT_IN, validate, can, require: require_, summarise,
};
