const { test, after } = require('node:test');
const assert = require('node:assert');
const { query } = require('../src/db');
const users = require('../src/routes/users');
const perms = require('../src/lib/permissions');

/**
 * Permissions are only real if the server enforces them. These test the rule
 * that matters most: absent means denied.
 */

const orgs = [];
after(async () => { for (const id of orgs) await query('DELETE FROM orgs WHERE id = $1', [id]); });

async function fixture() {
  const { rows: o } = await query('INSERT INTO orgs (name) VALUES ($1) RETURNING id', ['user-test']);
  orgs.push(o[0].id);
  const { rows: u } = await query(
    `INSERT INTO users (org_id, email, role) VALUES ($1,$2,'owner') RETURNING *`,
    [o[0].id, `own-${o[0].id.slice(0, 8)}@example.com`]);
  await users.ensureRoles(o[0].id);
  return { orgId: o[0].id, owner: u[0] };
}

/** A session for the owner, who may do anything. */
const ownerCtx = (f, body = {}) => ({
  session: {
    org: { id: f.orgId, name: 'user-test' },
    user: { id: f.owner.id, role: 'owner', roleId: null },
  },
  url: new URL('http://x/'), body,
});

/** A session carrying a specific role's matrix. */
const asRole = (f, roleKey, permissions, userId = 'u') => ({
  session: {
    org: { id: f.orgId },
    user: { id: userId, role: 'member', roleId: 'r', roleKey, permissions },
  },
  url: new URL('http://x/'), body: {},
});

// --- the matrix -------------------------------------------------------------

test('a module absent from a role grants nothing', () => {
  const s = { user: { role: 'member', roleId: 'r', permissions: { sales: ['read'] } } };
  assert.equal(perms.can(s, 'sales', 'read'), true);
  // The rule the whole model rests on. Defaulting the other way means one
  // forgotten entry hands a salesperson the balance sheet.
  assert.equal(perms.can(s, 'reports', 'read'), false);
  assert.equal(perms.can(s, 'settings', 'read'), false);
});

test('an action absent from a module grants nothing', () => {
  const s = { user: { role: 'member', roleId: 'r', permissions: { reports: ['read'] } } };
  assert.equal(perms.can(s, 'reports', 'read'), true);
  assert.equal(perms.can(s, 'reports', 'export'), false);
  assert.equal(perms.can(s, 'reports', 'delete'), false);
});

test('a salesperson cannot see purchases or the balance sheet', () => {
  const sp = perms.BUILT_IN.find((r) => r.key === 'salesperson');
  const s = { user: { role: 'member', roleId: 'r', permissions: sp.permissions } };
  // What a shop pays for its stock is the figure owners are least willing to
  // show the people selling it.
  assert.equal(perms.can(s, 'purchase', 'read'), false);
  assert.equal(perms.can(s, 'reports', 'read'), false);
  assert.equal(perms.can(s, 'sales', 'read'), true);
  assert.equal(perms.can(s, 'outstanding', 'read'), true);
});

test('an accountant sees the statements but not the user list', () => {
  const acc = perms.BUILT_IN.find((r) => r.key === 'accountant');
  const s = { user: { role: 'member', roleId: 'r', permissions: acc.permissions } };
  assert.equal(perms.can(s, 'reports', 'read'), true);
  assert.equal(perms.can(s, 'reports', 'export'), true);
  assert.equal(perms.can(s, 'users', 'read'), false);
  assert.equal(perms.can(s, 'settings', 'update'), false);
});

test('an owner with no role row still has everything', () => {
  // Accounts created before roles existed must not lose access on deploy.
  const s = { user: { role: 'owner', roleId: null } };
  assert.equal(perms.can(s, 'settings', 'delete'), true);
  assert.equal(perms.can(s, 'users', 'create'), true);
});

test('require throws a 403 that names what is missing', () => {
  const s = { user: { role: 'member', roleId: 'r', permissions: {} } };
  assert.throws(() => perms.require(s, 'reports', 'read'), (e) => {
    assert.equal(e.status, 403);
    assert.match(e.message, /Reports/);
    return true;
  });
});

test('an unsigned-in caller can do nothing', () => {
  assert.equal(perms.can(null, 'dashboard', 'read'), false);
  assert.equal(perms.can({}, 'dashboard', 'read'), false);
});

test('permissions naming a module or action we do not have are refused', () => {
  assert.throws(() => perms.validate({ nonsense: ['read'] }), (e) => e.status === 400);
  assert.throws(() => perms.validate({ sales: ['destroy'] }), (e) => e.status === 400);
  assert.throws(() => perms.validate({ sales: 'read' }), (e) => e.status === 400);
  assert.throws(() => perms.validate([]), (e) => e.status === 400);
});

test('an empty action list is dropped, not stored', () => {
  // "granted nothing" and "not granted" behave identically, so they must not
  // be two different stored states.
  assert.deepEqual(perms.validate({ sales: [], reports: ['read'] }), { reports: ['read'] });
});

test('duplicate actions are collapsed', () => {
  assert.deepEqual(perms.validate({ sales: ['read', 'read', 'export'] }),
    { sales: ['read', 'export'] });
});

// --- roles ------------------------------------------------------------------

test('every business gets the built-in roles', async () => {
  const f = await fixture();
  const r = await users.listRoles(ownerCtx(f));
  const keys = r.roles.map((x) => x.key).sort();
  assert.deepEqual(keys,
    ['accountant', 'admin', 'employee', 'manager', 'owner', 'salesperson'].sort());
  assert.ok(r.roles.every((x) => x.builtIn));
});

test('a custom role can be created and used', async () => {
  const f = await fixture();
  const made = await users.createRole({
    ...ownerCtx(f),
    body: { name: 'Counter staff', permissions: { sales: ['read'], inventory: ['read'] } },
  });
  assert.equal(made.role.builtIn, false);
  assert.deepEqual(made.role.permissions, { sales: ['read'], inventory: ['read'] });
});

test('the Owner role cannot be edited', async () => {
  const f = await fixture();
  const { rows } = await query(
    `SELECT id FROM roles WHERE org_id = $1 AND key = 'owner'`, [f.orgId]);
  // Editing it is how an account locks itself out with no way back.
  await assert.rejects(
    () => users.updateRole({ ...ownerCtx(f), body: { permissions: {} } }, rows[0].id),
    (e) => e.status === 400);
});

test('a built-in role cannot be deleted', async () => {
  const f = await fixture();
  const { rows } = await query(
    `SELECT id FROM roles WHERE org_id = $1 AND key = 'accountant'`, [f.orgId]);
  await assert.rejects(() => users.deleteRole(ownerCtx(f), rows[0].id), (e) => e.status === 400);
});

test('a role still in use cannot be deleted', async () => {
  const f = await fixture();
  const made = await users.createRole({
    ...ownerCtx(f), body: { name: 'Temp', permissions: { sales: ['read'] } } });
  await query(
    `INSERT INTO users (org_id, email, role, role_id) VALUES ($1,$2,'member',$3)`,
    [f.orgId, `t-${f.orgId.slice(0, 8)}@example.com`, made.role.id]);
  // Deleting would silently drop that person to no access at all, which looks
  // like the product breaking.
  await assert.rejects(() => users.deleteRole(ownerCtx(f), made.role.id),
    (e) => e.status === 409 && /using this role/i.test(e.message));
});

test('a role from another business is invisible', async () => {
  const a = await fixture();
  const b = await fixture();
  const made = await users.createRole({
    ...ownerCtx(a), body: { name: 'Theirs', permissions: { sales: ['read'] } } });
  await assert.rejects(
    () => users.updateRole({ ...ownerCtx(b), body: { name: 'Mine' } }, made.role.id),
    (e) => e.status === 404);
});

// --- invitations ------------------------------------------------------------

test('somebody is invited by the address they sign in with', async () => {
  const f = await fixture();
  const r = await users.invite({
    ...ownerCtx(f), body: { email: 'Accountant@Example.com', roleKey: 'accountant' } });
  assert.equal(r.invite.email, 'accountant@example.com');
  // No email is sent, so the note has to tell the owner what to say.
  assert.match(r.note, /sign in/i);

  const list = await users.list(ownerCtx(f));
  assert.equal(list.invites.length, 1);
  assert.equal(list.invites[0].roleKey, 'accountant');
});

test('a malformed address is refused', async () => {
  const f = await fixture();
  for (const bad of ['nope', 'a@b', '', 'a b@c.com']) {
    await assert.rejects(
      () => users.invite({ ...ownerCtx(f), body: { email: bad } }), (e) => e.status === 400);
  }
});

test('an address already in another business is refused', async () => {
  const a = await fixture();
  const b = await fixture();
  // One address, one business - otherwise "whose books am I seeing" has no
  // answer at sign-in.
  await assert.rejects(
    () => users.invite({ ...ownerCtx(b), body: { email: a.owner.email } }),
    (e) => e.status === 409);
});

test('re-inviting the same address updates rather than duplicating', async () => {
  const f = await fixture();
  const addr = `dup-${f.orgId.slice(0, 8)}@example.com`;
  await users.invite({ ...ownerCtx(f), body: { email: addr, roleKey: 'employee' } });
  await users.invite({ ...ownerCtx(f), body: { email: addr, roleKey: 'manager' } });
  const list = await users.list(ownerCtx(f));
  assert.equal(list.invites.length, 1);
  assert.equal(list.invites[0].roleKey, 'manager');
});

test('an invitation can be revoked before it is used', async () => {
  const f = await fixture();
  const r = await users.invite({
    ...ownerCtx(f), body: { email: `rev-${f.orgId.slice(0, 8)}@example.com` } });
  await users.revokeInvite(ownerCtx(f), r.invite.id);
  const list = await users.list(ownerCtx(f));
  assert.equal(list.invites.length, 0);
});

// --- user controls ----------------------------------------------------------

async function withMember(f, roleKey = 'employee') {
  const { rows: role } = await query(
    'SELECT id FROM roles WHERE org_id = $1 AND key = $2', [f.orgId, roleKey]);
  const { rows } = await query(
    `INSERT INTO users (org_id, email, role, role_id, name)
     VALUES ($1,$2,'member',$3,'Staffer') RETURNING *`,
    [f.orgId, `m-${Math.random().toString(36).slice(2, 8)}@example.com`, role[0].id]);
  return rows[0];
}

test('disabling somebody signs out every device they hold, at once', async () => {
  const f = await fixture();
  const m = await withMember(f);
  await query(
    `INSERT INTO sessions (token_hash, user_id, device_kind) VALUES ($1,$2,'mobile'), ($3,$2,'web')`,
    [`d1-${m.id}`, m.id, `d2-${m.id}`]);

  const r = await users.setStatus({ ...ownerCtx(f), body: { status: 'disabled' } }, m.id);
  // The point of disabling somebody is that it reaches the phone already in
  // their pocket, which is signed in and never expires.
  assert.equal(r.signedOutDevices, 2);

  const { rows } = await query(
    'SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL', [m.id]);
  assert.equal(rows[0].n, 0);
});

test('a disabled user can be enabled again', async () => {
  const f = await fixture();
  const m = await withMember(f);
  await users.setStatus({ ...ownerCtx(f), body: { status: 'disabled' } }, m.id);
  const r = await users.setStatus({ ...ownerCtx(f), body: { status: 'active' } }, m.id);
  assert.equal(r.status, 'active');
});

test('the account owner cannot be disabled or removed', async () => {
  const f = await fixture();
  // There must always be a way back into the account.
  await assert.rejects(
    () => users.setStatus({ ...ownerCtx(f), body: { status: 'disabled' } }, f.owner.id),
    (e) => e.status === 400);
  await assert.rejects(() => users.remove(ownerCtx(f), f.owner.id), (e) => e.status === 400);
});

test('you cannot disable or remove yourself', async () => {
  const f = await fixture();
  const m = await withMember(f);
  const self = {
    session: { org: { id: f.orgId }, user: { id: m.id, role: 'owner', roleId: null } },
    url: new URL('http://x/'), body: { status: 'disabled' },
  };
  await assert.rejects(() => users.setStatus(self, m.id), (e) => e.status === 400);
});

test('role, branch, salesperson and device limit can all be set', async () => {
  const f = await fixture();
  const m = await withMember(f);
  const r = await users.update({
    ...ownerCtx(f),
    body: { roleKey: 'salesperson', branch: 'Ranipet', isSalesperson: true,
            salespersonName: 'R. Kumar', deviceLimit: 2 },
  }, m.id);
  assert.equal(r.user.branch, 'Ranipet');
  assert.equal(r.user.isSalesperson, true);
  assert.equal(r.user.salespersonName, 'R. Kumar');
  assert.equal(r.user.deviceLimit, 2);
  assert.equal(r.user.roleKey, undefined, 'roleKey is resolved on read, not written back');
});

test('a silly device limit is refused', async () => {
  const f = await fixture();
  const m = await withMember(f);
  for (const bad of [-1, 21, 1.5]) {
    await assert.rejects(
      () => users.update({ ...ownerCtx(f), body: { deviceLimit: bad } }, m.id),
      (e) => e.status === 400);
  }
});

test('books can be assigned, and none means all of them', async () => {
  const f = await fixture();
  const m = await withMember(f);
  const { rows: co } = await query(
    `INSERT INTO companies (org_id, tally_guid, name) VALUES ($1,$2,'Book A') RETURNING *`,
    [f.orgId, `bk-${f.orgId}`]);

  const r = await users.setCompanies(
    { ...ownerCtx(f), body: { companies: [co[0].tally_guid] } }, m.id);
  assert.equal(r.companies.length, 1);

  const none = await users.setCompanies({ ...ownerCtx(f), body: { companies: [] } }, m.id);
  assert.match(none.note, /every book/i);
});

test('a person from another business cannot be touched', async () => {
  const a = await fixture();
  const b = await fixture();
  const m = await withMember(a);
  await assert.rejects(
    () => users.update({ ...ownerCtx(b), body: { branch: 'theirs' } }, m.id),
    (e) => e.status === 404);
  await assert.rejects(
    () => users.setStatus({ ...ownerCtx(b), body: { status: 'disabled' } }, m.id),
    (e) => e.status === 404);
});

// --- enforcement ------------------------------------------------------------

test('somebody without users permission cannot list or invite', async () => {
  const f = await fixture();
  const sp = perms.BUILT_IN.find((r) => r.key === 'salesperson');
  const ctx = asRole(f, 'salesperson', sp.permissions);

  await assert.rejects(() => users.list(ctx), (e) => e.status === 403);
  await assert.rejects(
    () => users.invite({ ...ctx, body: { email: 'x@example.com' } }), (e) => e.status === 403);
});

test('read permission alone does not allow inviting', async () => {
  const f = await fixture();
  // Read and create are separate actions for exactly this reason.
  const ctx = asRole(f, 'viewer', { users: ['read'] });
  const listed = await users.list(ctx);
  assert.ok(Array.isArray(listed.users));
  await assert.rejects(
    () => users.invite({ ...ctx, body: { email: 'x@example.com' } }), (e) => e.status === 403);
});
