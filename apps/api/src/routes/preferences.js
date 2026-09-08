'use strict';
const { query } = require('../db');
const auth = require('../lib/auth');
const { HttpError, bad } = require('../lib/http');

/**
 * What each person wants their copy of Munim to look like.
 *
 * Per person, not per business. Two people looking at the same books want
 * different things on top - the owner wants cash and receivables, the
 * accountant wants the day book, the salesperson wants their own customers -
 * and an org-level layout means one of them loses every time.
 *
 * The catalogue below is the whole contract. A client cannot invent a
 * preference key, and cannot store a shape the server does not recognise:
 * this table is read back into the UI, so anything accepted here is something
 * a future version has to keep understanding.
 */

/*
 * Dashboard widgets, in the order they appear by default.
 *
 * The default order is not alphabetical and not arbitrary: it is the order a
 * shop owner asks the questions. Is there money, who owes me, what sold, what
 * is stuck. Everything below that is for somebody who came looking.
 */
/*
 * These are the sections the dashboard actually renders, named for what the
 * screen calls them. Offering a widget the dashboard does not have would make
 * this whole screen a lie the first time somebody turned one on and nothing
 * changed.
 */
const WIDGETS = {
  today:     { label: 'Today',           module: 'dashboard',   default: true,
               hint: 'Sold, bought, received and paid since this morning.' },
  trading:   { label: 'Trading',         module: 'dashboard',   default: true,
               hint: 'Sales, purchases and profit for the period.' },
  money:     { label: 'Money',           module: 'dashboard',   default: true,
               hint: 'Receivables, payables, cash, bank, stock, GST.' },
  invoices:  { label: 'Invoices',        module: 'outstanding', default: true,
               hint: 'How many are unpaid and how many are overdue.' },
  cashflow:  { label: 'Cash flow',       module: 'cashbank',    default: true,
               hint: 'Money in against money out, month by month.' },
  landscape: { label: 'Sales landscape', module: 'sales',       default: true,
               hint: 'The 3D view: months across, customers back, sales up.' },
  rankings:  { label: 'Rankings',        module: 'insights',    default: true,
               hint: 'Top customers, suppliers, products and salespeople.' },

  /*
   * The pulse widgets, off by default.
   *
   * They answer questions the totals cannot, but a dashboard that grows a new
   * section every release becomes a scroll. Somebody who wants them turns them
   * on, and the ones above stay as they were for everybody who does not.
   */
  runway:    { label: 'How long the money lasts', module: 'cashbank', default: false,
               hint: 'Cash against what it costs to keep going.' },
  slowPayers:{ label: 'Slowest to pay',  module: 'outstanding', default: false,
               hint: 'Customers who pay past the terms they were given.' },
  movers:    { label: 'What changed',    module: 'insights',    default: false,
               hint: 'Who is buying more, less, or has stopped.' },
  rhythm:    { label: 'When you sell',   module: 'sales',       default: false,
               hint: 'Which days of the week carry the takings.' },
};

const DEFAULT_ORDER = Object.keys(WIDGETS);

/** Every preference Munim knows, with how to validate one. */
const CATALOGUE = {
  'dashboard.layout': {
    perCompany: true,
    label: 'Dashboard layout',
    /*
     * Stored as an order plus a hidden set rather than as a list of visible
     * widgets. That way a widget added in a later release appears for everybody
     * who has not deliberately hidden something, instead of being invisible to
     * every existing customer because it was not in a list saved last year.
     */
    validate(v) {
      const order = Array.isArray(v?.order)
        ? v.order.filter((k) => typeof k === 'string' && k in WIDGETS)
        : [];
      const hidden = Array.isArray(v?.hidden)
        ? v.hidden.filter((k) => typeof k === 'string' && k in WIDGETS)
        : [];
      return {
        order: [...new Set(order)],
        hidden: [...new Set(hidden)],
        period: ['month', 'quarter', 'fy', 'year'].includes(v?.period) ? v.period : 'fy',
        compact: v?.compact === true,
      };
    },
    fallback: () => ({ order: [], hidden: [], period: 'fy', compact: false }),
  },

  'reports.defaults': {
    perCompany: true,
    label: 'Report defaults',
    validate(v) {
      const out = {};
      for (const [report, cfg] of Object.entries(v ?? {})) {
        if (typeof report !== 'string' || report.length > 40) continue;
        out[report] = {
          columns: Array.isArray(cfg?.columns)
            ? cfg.columns.filter((c) => typeof c === 'string').slice(0, 40) : [],
          groupBy: typeof cfg?.groupBy === 'string' ? cfg.groupBy.slice(0, 40) : '',
          sortBy: typeof cfg?.sortBy === 'string' ? cfg.sortBy.slice(0, 40) : '',
          sortDir: cfg?.sortDir === 'asc' ? 'asc' : 'desc',
          period: typeof cfg?.period === 'string' ? cfg.period.slice(0, 20) : '',
        };
      }
      return out;
    },
    fallback: () => ({}),
  },

  'app.preferences': {
    perCompany: false,
    label: 'App preferences',
    validate(v) {
      return {
        // Which book opens on sign-in. Somebody who runs four companies opens
        // the same one nine times out of ten.
        defaultCompany: typeof v?.defaultCompany === 'string'
          ? v.defaultCompany.slice(0, 80) : '',
        landing: ['dashboard', 'outstanding', 'reports', 'kpi'].includes(v?.landing)
          ? v.landing : 'dashboard',
        density: ['comfortable', 'compact'].includes(v?.density) ? v.density : 'comfortable',
      };
    },
    fallback: () => ({ defaultCompany: '', landing: 'dashboard', density: 'comfortable' }),
  },
};

/**
 * Resolve the dashboard layout into what to actually render.
 *
 * Kept on the server so the web and the phone cannot drift apart on what "a
 * new widget" means, and so the permission filter happens once. A widget whose
 * module the person cannot read is removed here rather than being hidden in the
 * client - the difference matters because hiding it in the client still ships
 * them the data.
 */
function resolveLayout(saved, can) {
  const stored = saved ?? CATALOGUE['dashboard.layout'].fallback();
  const hidden = new Set(stored.hidden ?? []);

  // Anything explicitly ordered first, then everything the customer has never
  // expressed an opinion about, in the default order.
  const ordered = (stored.order ?? []).filter((k) => k in WIDGETS);

  /*
   * Two kinds of widget, and they behave differently for somebody who has never
   * touched their layout.
   *
   *   default: true  - part of the dashboard. A new one added in a later
   *                    release appears for everybody, which is the point of
   *                    storing an order and a hidden set rather than a list of
   *                    what to show.
   *
   *   default: false - opt-in. It appears only once somebody has deliberately
   *                    placed it. Otherwise every release quietly makes the
   *                    dashboard longer, and a screen that grows on its own is
   *                    one people stop reading.
   *
   * `ordered` is the record of a deliberate choice, so an opt-in widget found
   * there has been chosen and belongs.
   */
  const rest = DEFAULT_ORDER.filter(
    (k) => !ordered.includes(k) && WIDGETS[k].default);

  const widgets = [...ordered, ...rest]
    .filter((k) => !hidden.has(k))
    .filter((k) => !can || can(WIDGETS[k].module))
    .map((k) => ({
      key: k, label: WIDGETS[k].label, module: WIDGETS[k].module, hint: WIDGETS[k].hint,
    }));

  return {
    widgets,
    /*
     * Everything not currently shown, so a settings screen can offer it back -
     * both the widgets somebody hid and the opt-in ones they have not added.
     * Without the second group there is no way to discover they exist.
     */
    hidden: DEFAULT_ORDER
      .filter((k) => hidden.has(k) || (!WIDGETS[k].default && !ordered.includes(k)))
      .map((k) => ({
        key: k, label: WIDGETS[k].label, module: WIDGETS[k].module,
        hint: WIDGETS[k].hint, optional: !WIDGETS[k].default,
      })),
    period: stored.period ?? 'fy',
    compact: stored.compact === true,
    /*
     * Sent so a settings screen can offer every widget without hardcoding the
     * list, which is how the web and the phone end up offering different ones.
     */
    catalogue: DEFAULT_ORDER.map((k) => ({
      key: k, label: WIDGETS[k].label, module: WIDGETS[k].module,
      hint: WIDGETS[k].hint, defaultOn: WIDGETS[k].default,
    })),
  };
}

async function companyIdFor(session, guid) {
  if (!guid) return null;
  const { rows } = await query(
    'SELECT id FROM companies WHERE org_id = $1 AND tally_guid = $2', [session.org.id, guid]);
  if (!rows.length) throw new HttpError(404, 'NOT_FOUND', 'No such company.');
  return rows[0].id;
}

/** Everything this person has set, resolved and ready to render. */
async function get(ctx) {
  const s = auth.requireUser(ctx);
  const guid = ctx.url.searchParams.get('company') || '';
  const companyId = await companyIdFor(s, guid);

  const { rows } = await query(
    `SELECT key, value, company_id FROM preferences
      WHERE user_id = $1 AND (company_id = $2 OR company_id IS NULL)`,
    [s.user.id, companyId]);

  const perms = require('../lib/permissions');
  const can = (module) => perms.can(s, module, 'read');

  const stored = {};
  for (const r of rows) stored[r.key] = r.value;

  const out = {};
  for (const [key, def] of Object.entries(CATALOGUE)) {
    out[key] = stored[key] ? def.validate(stored[key]) : def.fallback();
  }

  return {
    preferences: out,
    dashboard: resolveLayout(out['dashboard.layout'], can),
    note: 'These are yours alone. Other people on this account keep their own.',
  };
}

/** Save one. */
async function set(ctx) {
  const s = auth.requireUser(ctx);
  const key = String(ctx.body?.key ?? '');
  const def = CATALOGUE[key];
  if (!def) throw bad('BAD_KEY', 'Munim does not know that preference.');

  const guid = ctx.body?.company || '';
  const companyId = def.perCompany ? await companyIdFor(s, guid) : null;
  if (def.perCompany && !companyId) {
    throw bad('COMPANY_REQUIRED', 'That preference belongs to one set of books.');
  }

  // Validated into a known shape, never stored as sent. This table is read back
  // into the UI, so anything accepted is something a future version must keep
  // understanding.
  const value = def.validate(ctx.body?.value);

  /*
   * Two upserts because the unique constraints differ: the primary key covers
   * the per-company rows, and a partial index covers the global ones, since
   * NULL is not equal to itself and the primary key alone would let a person
   * accumulate a new global row on every save.
   */
  if (companyId) {
    await query(
      `INSERT INTO preferences (user_id, company_id, key, value)
       VALUES ($1,$2,$3,$4::jsonb)
       ON CONFLICT (user_id, key, company_id) WHERE company_id IS NOT NULL
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [s.user.id, companyId, key, JSON.stringify(value)]);
  } else {
    await query(
      `INSERT INTO preferences (user_id, company_id, key, value)
       VALUES ($1,NULL,$2,$3::jsonb)
       ON CONFLICT (user_id, key) WHERE company_id IS NULL
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [s.user.id, key, JSON.stringify(value)]);
  }

  return { key, value, saved: true };
}

/** Put a preference back to how it ships. */
async function reset(ctx) {
  const s = auth.requireUser(ctx);
  const key = String(ctx.body?.key ?? '');
  if (!CATALOGUE[key]) throw bad('BAD_KEY', 'Munim does not know that preference.');

  await query('DELETE FROM preferences WHERE user_id = $1 AND key = $2', [s.user.id, key]);
  return { key, value: CATALOGUE[key].fallback(), reset: true };
}

module.exports = { get, set, reset, resolveLayout, WIDGETS, CATALOGUE, DEFAULT_ORDER };
