'use strict';
const { query, tx } = require('../db');
const auth = require('../lib/auth');
const { HttpError } = require('../lib/http');

/**
 * Saved arrangements of a report.
 *
 * A view is personal by default. One accountant's preferred columns are not an
 * opinion the whole business should inherit, and a shared-by-default view
 * means the first person to save one decides for everybody.
 */

/*
 * What a view may contain.
 *
 * Validated rather than stored blind: this comes from a client, is handed back
 * to a client, and an unchecked blob is how a stored value ends up somewhere
 * it was never meant to be rendered.
 */
const SORT_DIRECTIONS = ['asc', 'desc'];
const MAX_COLUMNS = 60;

function validateConfig(raw) {
  if (raw === undefined) return {};
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HttpError(400, 'BAD_CONFIG', 'The view settings must be an object.');
  }

  const out = {};
  const str = (v, max) => String(v).slice(0, max);

  if (raw.columns !== undefined) {
    if (!Array.isArray(raw.columns)) {
      throw new HttpError(400, 'BAD_COLUMNS', 'Columns must be a list.');
    }
    if (raw.columns.length > MAX_COLUMNS) {
      throw new HttpError(400, 'BAD_COLUMNS', `At most ${MAX_COLUMNS} columns.`);
    }
    // The list IS the order, and anything not in it is hidden - one field
    // rather than three that can disagree with each other.
    out.columns = [...new Set(raw.columns.map((c) => str(c, 60)))];
  }

  if (raw.sort !== undefined) {
    if (typeof raw.sort !== 'object' || Array.isArray(raw.sort)) {
      throw new HttpError(400, 'BAD_SORT', 'Sort must be an object.');
    }
    out.sort = {
      by: str(raw.sort.by ?? '', 60),
      dir: SORT_DIRECTIONS.includes(raw.sort.dir) ? raw.sort.dir : 'desc',
    };
  }

  if (raw.groupBy !== undefined) out.groupBy = str(raw.groupBy ?? '', 60);
  if (raw.period !== undefined) out.period = str(raw.period ?? '', 30);
  if (raw.from !== undefined) out.from = str(raw.from ?? '', 10);
  if (raw.to !== undefined) out.to = str(raw.to ?? '', 10);

  if (raw.filters !== undefined) {
    if (typeof raw.filters !== 'object' || Array.isArray(raw.filters)) {
      throw new HttpError(400, 'BAD_FILTERS', 'Filters must be an object.');
    }
    const f = {};
    for (const [k, v] of Object.entries(raw.filters).slice(0, 20)) {
      f[str(k, 40)] = typeof v === 'boolean' ? v : str(v, 200);
    }
    out.filters = f;
  }

  if (raw.totals !== undefined) out.totals = !!raw.totals;
  if (raw.subtotals !== undefined) out.subtotals = !!raw.subtotals;

  if (raw.decimals !== undefined) {
    const n = Number(raw.decimals);
    if (!Number.isInteger(n) || n < 0 || n > 4) {
      throw new HttpError(400, 'BAD_DECIMALS', 'Decimals must be a whole number from 0 to 4.');
    }
    out.decimals = n;
  }

  if (raw.numberFormat !== undefined) {
    if (!['indian', 'international'].includes(raw.numberFormat)) {
      throw new HttpError(400, 'BAD_FORMAT', 'Number format must be indian or international.');
    }
    out.numberFormat = raw.numberFormat;
  }

  if (raw.exportFormat !== undefined) {
    if (!['csv', 'print'].includes(raw.exportFormat)) {
      throw new HttpError(400, 'BAD_EXPORT', 'Export format must be csv or print.');
    }
    out.exportFormat = raw.exportFormat;
  }

  return out;
}

const out = (r, userId) => ({
  id: r.id,
  report: r.report,
  name: r.name,
  config: r.config,
  isDefault: r.is_default,
  shared: r.shared,
  // Whose it is, so a screen can stop somebody editing a colleague's view
  // rather than letting them try and be refused.
  mine: r.user_id === userId,
  owner: r.owner_name ?? '',
  updatedAt: r.updated_at,
});

/** Every view this person can use for a report: their own, plus shared ones. */
async function list(ctx) {
  const s = auth.requireUser(ctx);
  const report = ctx.url.searchParams.get('report') || '';

  const args = [s.org.id, s.user.id];
  const filter = report ? ` AND v.report = $${args.push(report)}` : '';

  const { rows } = await query(
    `SELECT v.*, u.name AS owner_name
       FROM saved_views v
       LEFT JOIN users u ON u.id = v.user_id
      WHERE v.org_id = $1 AND (v.user_id = $2 OR v.shared)${filter}
      ORDER BY v.is_default DESC, v.report, v.name`, args);

  return { views: rows.map((r) => out(r, s.user.id)) };
}

async function create(ctx) {
  const s = auth.requireUser(ctx);
  const b = ctx.body || {};

  const report = String(b.report ?? '').trim().slice(0, 60);
  const name = String(b.name ?? '').trim().slice(0, 60);
  if (!report) throw new HttpError(400, 'BAD_REPORT', 'Which report is this view for?');
  if (name.length < 1) throw new HttpError(400, 'BAD_NAME', 'Give the view a name.');

  const config = validateConfig(b.config);

  return tx(async (c) => {
    if (b.isDefault) {
      // One default per person per report; the index enforces it, and clearing
      // first turns a constraint violation into the obvious behaviour.
      await c.query(
        'UPDATE saved_views SET is_default = false WHERE user_id = $1 AND report = $2',
        [s.user.id, report]);
    }

    const { rows } = await c.query(
      `INSERT INTO saved_views (org_id, user_id, report, name, config, is_default, shared)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
       ON CONFLICT (user_id, report, name) DO UPDATE SET
         config = EXCLUDED.config, is_default = EXCLUDED.is_default,
         shared = EXCLUDED.shared, updated_at = now()
       RETURNING *`,
      [s.org.id, s.user.id, report, name, JSON.stringify(config),
       !!b.isDefault, !!b.shared]);

    return { view: out(rows[0], s.user.id) };
  });
}

async function update(ctx, id) {
  const s = auth.requireUser(ctx);
  const b = ctx.body || {};

  const { rows: existing } = await query(
    'SELECT * FROM saved_views WHERE id = $1 AND org_id = $2', [id, s.org.id]);
  if (!existing.length) throw new HttpError(404, 'NOT_FOUND', 'No such view.');
  if (existing[0].user_id !== s.user.id) {
    // A shared view can be used by anybody and changed by nobody but its
    // owner - otherwise one person's edit silently rearranges a colleague's
    // screen.
    throw new HttpError(403, 'NOT_YOURS',
      'This view belongs to someone else. Save your own copy instead.');
  }

  const sets = [];
  const args = [id, s.user.id];
  if (b.name !== undefined) sets.push(`name = $${args.push(String(b.name).trim().slice(0, 60))}`);
  if (b.config !== undefined) {
    sets.push(`config = $${args.push(JSON.stringify(validateConfig(b.config)))}::jsonb`);
  }
  if (b.shared !== undefined) sets.push(`shared = $${args.push(!!b.shared)}`);
  if (!sets.length && b.isDefault === undefined) {
    throw new HttpError(400, 'NOTHING_TO_DO', 'Nothing to change.');
  }

  return tx(async (c) => {
    if (b.isDefault !== undefined) {
      await c.query(
        'UPDATE saved_views SET is_default = false WHERE user_id = $1 AND report = $2',
        [s.user.id, existing[0].report]);
      sets.push(`is_default = $${args.push(!!b.isDefault)}`);
    }
    sets.push('updated_at = now()');

    const { rows } = await c.query(
      `UPDATE saved_views SET ${sets.join(', ')}
        WHERE id = $1 AND user_id = $2 RETURNING *`, args);
    return { view: out(rows[0], s.user.id) };
  });
}

async function remove(ctx, id) {
  const s = auth.requireUser(ctx);
  const { rowCount } = await query(
    'DELETE FROM saved_views WHERE id = $1 AND org_id = $2 AND user_id = $3',
    [id, s.org.id, s.user.id]);
  if (!rowCount) {
    throw new HttpError(404, 'NOT_FOUND',
      'No such view of yours. A colleague\'s shared view can only be removed by them.');
  }
  return { deleted: true };
}

module.exports = { list, create, update, remove, validateConfig };
