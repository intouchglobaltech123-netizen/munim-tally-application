'use strict';
const { query, tx } = require('../db');
const audit = require('../lib/audit');
const quotas = require('../lib/quotas');
const auth = require('../lib/auth');
const perms = require('../lib/permissions');
const { HttpError } = require('../lib/http');

/**
 * The people who may see the books, and what each of them sees.
 *
 * Sign-in is Google-only, so nobody here is handed a password - there is none
 * to hand. A user is invited by email address, and whoever proves to Google
 * that they own that address becomes that user. That is a stronger guarantee
 * than a password we emailed, and it costs nothing to send.
 */

/** Make sure this org has its built-in roles. Idempotent, safe to call often. */
async function ensureRoles(orgId) {
  for (const r of perms.BUILT_IN) {
    await query(
      `INSERT INTO roles (org_id, key, name, description, built_in, permissions)
       VALUES ($1,$2,$3,$4,true,$5::jsonb)
       ON CONFLICT (org_id, key) DO UPDATE SET
         -- Built-ins follow the product: if a new module appears, every
         -- customer's "Accountant" should learn about it without an
         -- administrator editing six roles by hand. Custom roles are never
         -- touched, because those are the customer's own decisions.
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         permissions = EXCLUDED.permissions
       WHERE roles.built_in`,
      [orgId, r.key, r.name, r.description, JSON.stringify(r.permissions)]);
  }
}

const roleOut = (r) => ({
  id: r.id, key: r.key, name: r.name, description: r.description,
  builtIn: r.built_in, permissions: r.permissions, users: r.users ?? 0,
});

async function listRoles(ctx) {
  const s = perms.require(auth.requireUser(ctx), 'users', 'read');
  await ensureRoles(s.org.id);
  const { rows } = await query(
    `SELECT r.*, (SELECT count(*)::int FROM users u WHERE u.role_id = r.id) AS users
       FROM roles r WHERE r.org_id = $1
      ORDER BY r.built_in DESC, r.name`, [s.org.id]);
  return {
    roles: rows.map(roleOut),
    catalogue: { modules: perms.MODULES, actions: perms.ACTIONS },
  };
}

async function createRole(ctx) {
  const s = perms.require(auth.requireUser(ctx), 'users', 'create');
  const name = String(ctx.body.name ?? '').trim();
  if (name.length < 2 || name.length > 40) {
    throw new HttpError(400, 'BAD_NAME', 'Give the role a name of 2 to 40 characters.');
  }
  const permissions = perms.validate(ctx.body.permissions ?? {});
  const key = `custom-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 24)}-${Date.now().toString(36)}`;

  const { rows } = await query(
    `INSERT INTO roles (org_id, key, name, description, built_in, permissions)
     VALUES ($1,$2,$3,$4,false,$5::jsonb) RETURNING *`,
    [s.org.id, key, name, String(ctx.body.description ?? '').slice(0, 200),
     JSON.stringify(permissions)]);

  await audit.record(ctx, 'role.create', {
    entityId: rows[0].id, entityName: name,
    after: { name, description: rows[0].description, permissions },
  });
  return { role: roleOut(rows[0]) };
}

async function updateRole(ctx, id) {
  const s = perms.require(auth.requireUser(ctx), 'users', 'update');
  const { rows: existing } = await query(
    'SELECT * FROM roles WHERE id = $1 AND org_id = $2', [id, s.org.id]);
  if (!existing.length) throw new HttpError(404, 'NOT_FOUND', 'No such role.');

  if (existing[0].built_in && existing[0].key === 'owner') {
    // Editing Owner is how an account locks itself out of its own settings
    // with no way back that does not involve support.
    throw new HttpError(400, 'PROTECTED_ROLE',
      'The Owner role always has full access and cannot be changed.');
  }

  const sets = [];
  const args = [id, s.org.id];
  if (ctx.body.name !== undefined) {
    sets.push(`name = $${args.push(String(ctx.body.name).trim().slice(0, 40))}`);
  }
  if (ctx.body.description !== undefined) {
    sets.push(`description = $${args.push(String(ctx.body.description).slice(0, 200))}`);
  }
  if (ctx.body.permissions !== undefined) {
    sets.push(`permissions = $${args.push(JSON.stringify(perms.validate(ctx.body.permissions)))}::jsonb`);
  }
  if (!sets.length) throw new HttpError(400, 'NOTHING_TO_DO', 'Nothing to change.');

  const { rows } = await query(
    `UPDATE roles SET ${sets.join(', ')} WHERE id = $1 AND org_id = $2 RETURNING *`, args);

  // Who can do what is the change most worth being able to look up later.
  await audit.record(ctx, 'role.update', {
    entityId: id, entityName: rows[0].name,
    before: { permissions: existing[0].permissions, name: existing[0].name },
    after: { permissions: rows[0].permissions, name: rows[0].name },
  });
  return { role: roleOut(rows[0]) };
}

async function deleteRole(ctx, id) {
  const s = perms.require(auth.requireUser(ctx), 'users', 'delete');
  const { rows } = await query(
    'SELECT built_in FROM roles WHERE id = $1 AND org_id = $2', [id, s.org.id]);
  if (!rows.length) throw new HttpError(404, 'NOT_FOUND', 'No such role.');
  if (rows[0].built_in) {
    throw new HttpError(400, 'PROTECTED_ROLE', 'Built-in roles cannot be deleted.');
  }

  const { rows: used } = await query(
    'SELECT count(*)::int AS n FROM users WHERE role_id = $1', [id]);
  if (used[0].n > 0) {
    // Deleting it would silently drop those people to no permissions at all,
    // which looks like the product breaking rather than a role being removed.
    throw new HttpError(409, 'ROLE_IN_USE',
      `${used[0].n} ${used[0].n === 1 ? 'person is' : 'people are'} using this role. `
      + 'Move them to another role first.');
  }
  await query('DELETE FROM roles WHERE id = $1 AND org_id = $2', [id, s.org.id]);
  await audit.record(ctx, 'role.delete', { entityId: id });
  return { deleted: true };
}

// ---------------------------------------------------------------------- users

const userOut = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  phone: u.phone,
  status: u.status,
  roleId: u.role_id,
  roleKey: u.role_key,
  roleName: u.role_name ?? (u.role === 'owner' ? 'Owner' : u.role),
  branch: u.branch,
  isSalesperson: u.is_salesperson,
  salespersonName: u.salesperson_name,
  deviceLimit: u.device_limit,
  lastSeenAt: u.last_seen_at,
  invitedAt: u.invited_at,
  createdAt: u.created_at,
  activeDevices: u.devices ?? 0,
  companies: u.companies ?? [],
  pending: false,
});

async function list(ctx) {
  const s = perms.require(auth.requireUser(ctx), 'users', 'read');
  await ensureRoles(s.org.id);

  const { rows } = await query(
    `SELECT u.*, r.key AS role_key, r.name AS role_name,
            (SELECT count(*)::int FROM sessions se
              WHERE se.user_id = u.id AND se.revoked_at IS NULL) AS devices,
            COALESCE((SELECT array_agg(c.tally_guid) FROM user_companies uc
                        JOIN companies c ON c.id = uc.company_id
                       WHERE uc.user_id = u.id), '{}') AS companies
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
      WHERE u.org_id = $1
      ORDER BY u.created_at`, [s.org.id]);

  const { rows: pending } = await query(
    `SELECT i.*, r.key AS role_key, r.name AS role_name
       FROM invites i LEFT JOIN roles r ON r.id = i.role_id
      WHERE i.org_id = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL
      ORDER BY i.created_at`, [s.org.id]);

  return {
    users: rows.map(userOut),
    // Shown alongside real users rather than on a separate screen: "who can
    // see my books" includes anyone who has been invited and not yet arrived.
    invites: pending.map((i) => ({
      id: i.id, email: i.email, name: i.name, branch: i.branch,
      roleId: i.role_id, roleKey: i.role_key, roleName: i.role_name,
      invitedAt: i.created_at, pending: true,
    })),
    limits: { users: s.org.maxUsers ?? null },
  };
}

/** Invite somebody by the Google address they will sign in with. */
async function invite(ctx) {
  const s = perms.require(auth.requireUser(ctx), 'users', 'create');
  await ensureRoles(s.org.id);

  /*
   * Checked before the address is even validated.
   *
   * Somebody at their seat limit should be told that in one step, not asked to
   * type a colleague's details and then refused. Pending invites count: they
   * become people the moment they sign in, and not counting them lets a plan
   * be oversubscribed by however many invites are outstanding.
   */
  const { rows: org } = await query('SELECT * FROM orgs WHERE id = $1', [s.org.id]);
  const { rows: seats } = await query(
    `SELECT (SELECT count(*) FROM users WHERE org_id = $1 AND status <> 'disabled')
          + (SELECT count(*) FROM invites
              WHERE org_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL) AS n`,
    [s.org.id]);
  quotas.assertWithin(org[0], 'users', Number(seats[0].n));

  const email = String(ctx.body.email ?? '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new HttpError(400, 'BAD_EMAIL', 'Enter the Google address they sign in with.');
  }

  const { rows: already } = await query(
    'SELECT id, status FROM users WHERE org_id = $1 AND lower(email) = $2', [s.org.id, email]);
  if (already.length) {
    throw new HttpError(409, 'ALREADY_HERE', 'That person is already on this account.');
  }

  // An address may belong to exactly one business. Two orgs claiming the same
  // person would make "which books am I looking at" unanswerable at sign-in.
  const { rows: elsewhere } = await query(
    'SELECT id FROM users WHERE lower(email) = $1', [email]);
  if (elsewhere.length) {
    throw new HttpError(409, 'EMAIL_IN_USE',
      'That address already belongs to another Munim account.');
  }

  const roleId = await resolveRole(s.org.id, ctx.body.roleId, ctx.body.roleKey);

  const { rows } = await query(
    `INSERT INTO invites (org_id, email, role_id, name, branch, invited_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (org_id, email) DO UPDATE SET
       role_id = EXCLUDED.role_id, name = EXCLUDED.name, branch = EXCLUDED.branch,
       revoked_at = NULL, created_at = now()
     RETURNING *`,
    [s.org.id, email, roleId, String(ctx.body.name ?? '').trim().slice(0, 60),
     String(ctx.body.branch ?? '').trim().slice(0, 60), s.user.id]);

  await audit.record(ctx, 'user.invite', {
    entityId: rows[0].id, entityName: email, after: { email, roleId },
  });

  return {
    invite: { id: rows[0].id, email, roleId, pending: true },
    // No email is sent: sending costs money and needs a domain. They sign in
    // with Google and are recognised. The UI tells the owner to say so.
    note: `Ask them to sign in at Munim with ${email}. They will land straight in your books.`,
  };
}

async function resolveRole(orgId, roleId, roleKey) {
  if (roleId) {
    const { rows } = await query(
      'SELECT id FROM roles WHERE id = $1 AND org_id = $2', [roleId, orgId]);
    if (!rows.length) throw new HttpError(400, 'BAD_ROLE', 'No such role.');
    return rows[0].id;
  }
  const key = roleKey || 'employee';
  const { rows } = await query(
    'SELECT id FROM roles WHERE org_id = $1 AND key = $2', [orgId, key]);
  if (!rows.length) throw new HttpError(400, 'BAD_ROLE', 'No such role.');
  return rows[0].id;
}

async function revokeInvite(ctx, id) {
  const s = perms.require(auth.requireUser(ctx), 'users', 'delete');
  const { rowCount } = await query(
    `UPDATE invites SET revoked_at = now()
      WHERE id = $1 AND org_id = $2 AND accepted_at IS NULL`, [id, s.org.id]);
  if (!rowCount) throw new HttpError(404, 'NOT_FOUND', 'No such invitation.');
  return { revoked: true };
}

/** Change somebody's role, branch, device limit or salesperson mapping. */
async function update(ctx, id) {
  const s = perms.require(auth.requireUser(ctx), 'users', 'update');
  const { rows: target } = await query(
    'SELECT * FROM users WHERE id = $1 AND org_id = $2', [id, s.org.id]);
  if (!target.length) throw new HttpError(404, 'NOT_FOUND', 'No such person.');
  const t = target[0];

  const b = ctx.body || {};
  const sets = [];
  const args = [id, s.org.id];

  if (b.roleId !== undefined || b.roleKey !== undefined) {
    if (t.role === 'owner') {
      // There must always be a way back into the account.
      throw new HttpError(400, 'PROTECTED_USER',
        'The account owner\'s role cannot be changed.');
    }
    sets.push(`role_id = $${args.push(await resolveRole(s.org.id, b.roleId, b.roleKey))}`);
  }
  if (b.name !== undefined) sets.push(`name = $${args.push(String(b.name).trim().slice(0, 60))}`);
  if (b.branch !== undefined) sets.push(`branch = $${args.push(String(b.branch).trim().slice(0, 60))}`);
  if (b.isSalesperson !== undefined) sets.push(`is_salesperson = $${args.push(!!b.isSalesperson)}`);
  if (b.salespersonName !== undefined) {
    // The name as Tally spells it, which is how their figures are found.
    sets.push(`salesperson_name = $${args.push(String(b.salespersonName).trim().slice(0, 80))}`);
  }
  if (b.deviceLimit !== undefined) {
    const n = Number(b.deviceLimit);
    if (!Number.isInteger(n) || n < 0 || n > 20) {
      throw new HttpError(400, 'BAD_LIMIT', 'Device limit must be a whole number up to 20.');
    }
    sets.push(`device_limit = $${args.push(n)}`);
  }

  if (!sets.length) throw new HttpError(400, 'NOTHING_TO_DO', 'Nothing to change.');
  const { rows } = await query(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $1 AND org_id = $2 RETURNING *`, args);

  await query(
    `INSERT INTO audit_log (org_id, user_id, action, meta) VALUES ($1,$2,$3,$4)`,
    [s.org.id, s.user.id, 'user.update', JSON.stringify({ target: id, changed: Object.keys(b) })]);

  return { user: userOut(rows[0]) };
}

/**
 * Stop somebody getting in, without losing who they were.
 *
 * Their sessions go immediately - the point of disabling a person is that it
 * reaches the phone already in their pocket, which is signed in and, by
 * design, never expires.
 */
async function setStatus(ctx, id) {
  const s = perms.require(auth.requireUser(ctx), 'users', 'update');
  const disable = ctx.body.status === 'disabled';

  const { rows: target } = await query(
    'SELECT id, role, name, email FROM users WHERE id = $1 AND org_id = $2', [id, s.org.id]);
  if (!target.length) throw new HttpError(404, 'NOT_FOUND', 'No such person.');
  if (target[0].role === 'owner' && disable) {
    throw new HttpError(400, 'PROTECTED_USER', 'The account owner cannot be disabled.');
  }
  if (id === s.user.id && disable) {
    throw new HttpError(400, 'SELF', 'You cannot disable yourself.');
  }

  return tx(async (c) => {
    await c.query(
      `UPDATE users SET status = $3, disabled_at = CASE WHEN $3 = 'disabled' THEN now() END
        WHERE id = $1 AND org_id = $2`,
      [id, s.org.id, disable ? 'disabled' : 'active']);

    let revoked = 0;
    if (disable) {
      const r = await c.query(
        `UPDATE sessions SET revoked_at = now()
          WHERE user_id = $1 AND revoked_at IS NULL`, [id]);
      revoked = r.rowCount;
    }

    await c.query(
      `INSERT INTO audit_log (org_id, user_id, action, meta) VALUES ($1,$2,$3,$4)`,
      [s.org.id, s.user.id, disable ? 'user.disable' : 'user.enable',
       JSON.stringify({ target: id, email: target[0].email, revokedSessions: revoked })]);

    return {
      status: disable ? 'disabled' : 'active',
      signedOutDevices: revoked,
      note: disable
        ? `${target[0].name || target[0].email} was signed out of ${revoked} device(s) straight away.`
        : 'They can sign in again with Google.',
    };
  });
}

/**
 * Remove somebody entirely.
 *
 * Offered because the spec asks for it, and warned about because disabling is
 * almost always the right answer: deleting throws away which person did what,
 * which is exactly what an audit trail exists to preserve.
 */
async function remove(ctx, id) {
  const s = perms.require(auth.requireUser(ctx), 'users', 'delete');
  const { rows: target } = await query(
    'SELECT role, email FROM users WHERE id = $1 AND org_id = $2', [id, s.org.id]);
  if (!target.length) throw new HttpError(404, 'NOT_FOUND', 'No such person.');
  if (target[0].role === 'owner') {
    throw new HttpError(400, 'PROTECTED_USER', 'The account owner cannot be removed.');
  }
  if (id === s.user.id) throw new HttpError(400, 'SELF', 'You cannot remove yourself.');

  await query('DELETE FROM users WHERE id = $1 AND org_id = $2', [id, s.org.id]);
  await query(
    `INSERT INTO audit_log (org_id, user_id, action, meta) VALUES ($1,$2,$3,$4)`,
    [s.org.id, s.user.id, 'user.delete', JSON.stringify({ email: target[0].email })]);
  return { deleted: true };
}

/** Which books this person may open. No rows means all of them. */
async function setCompanies(ctx, id) {
  const s = perms.require(auth.requireUser(ctx), 'users', 'update');
  const guids = Array.isArray(ctx.body.companies) ? ctx.body.companies : [];

  const { rows: target } = await query(
    `SELECT u.role, u.name, u.email,
            COALESCE(array_agg(c.tally_guid ORDER BY c.tally_guid)
                     FILTER (WHERE c.tally_guid IS NOT NULL), '{}') AS guids
       FROM users u
       LEFT JOIN user_companies uc ON uc.user_id = u.id
       LEFT JOIN companies c ON c.id = uc.company_id
      WHERE u.id = $1 AND u.org_id = $2
      GROUP BY u.id`, [id, s.org.id]);
  if (!target.length) throw new HttpError(404, 'NOT_FOUND', 'No such person.');

  const wasGuids = target[0].guids ?? [];

  return tx(async (c) => {
    await c.query('DELETE FROM user_companies WHERE user_id = $1', [id]);
    for (const g of guids) {
      await c.query(
        `INSERT INTO user_companies (user_id, company_id)
         SELECT $1, id FROM companies WHERE org_id = $2 AND tally_guid = $3
         ON CONFLICT DO NOTHING`, [id, s.org.id, g]);
    }
    /*
     * Which books somebody can see is an access decision, so it is recorded
     * like one - with the before and after lists, not just "it changed".
     */
    await audit.record(ctx, 'user.companies', {
      entityId: id, entityName: target[0].name || target[0].email || '',
      before: { companies: wasGuids },
      after: { companies: guids },
    });

    return {
      companies: guids,
      note: guids.length === 0
        ? 'They can see every book in this account.'
        : `They can see ${guids.length} book(s).`,
    };
  });
}

module.exports = {
  ensureRoles, listRoles, createRole, updateRole, deleteRole,
  list, invite, revokeInvite, update, setStatus, remove, setCompanies,
};
