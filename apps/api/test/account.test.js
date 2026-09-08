const { test, after } = require('node:test');
const assert = require('node:assert');
const { query } = require('../src/db');
const account = require('../src/routes/account');

/**
 * Closing an account, and getting back into one.
 *
 * The destructive path in the whole product. These tests care most about the
 * ways it must refuse.
 */

const orgs = [];
after(async () => { for (const id of orgs) await query('DELETE FROM orgs WHERE id = $1', [id]); });

async function fixture(name = 'Acme Traders') {
  const { rows: o } = await query('INSERT INTO orgs (name) VALUES ($1) RETURNING *', [name]);
  orgs.push(o[0].id);
  const { rows: u } = await query(
    `INSERT INTO users (org_id, email, role, name)
     VALUES ($1,$2,'owner','Alice') RETURNING id`,
    [o[0].id, `acc-${o[0].id.slice(0, 8)}@example.com`]);
  const { rows: c } = await query(
    `INSERT INTO companies (org_id, tally_guid, name) VALUES ($1,$2,'Acme Books') RETURNING *`,
    [o[0].id, `acc-${o[0].id}`]);
  return { orgId: o[0].id, userId: u[0].id, co: c[0], name };
}

const ctxFor = (f, body = {}, userId, role = 'owner') => ({
  session: {
    org: { id: f.orgId },
    user: { id: userId ?? f.userId, role, roleId: null, name: 'Alice',
            email: `acc-${f.orgId.slice(0, 8)}@example.com` },
  },
  req: { headers: {}, socket: {} },
  url: new URL('http://x/'), body,
});

async function addMember(f, name) {
  const { rows } = await query(
    `INSERT INTO users (org_id, email, role, name) VALUES ($1,$2,'member',$3) RETURNING id`,
    [f.orgId, `${name}-${f.orgId.slice(0, 8)}@example.com`, name]);
  return rows[0].id;
}

// --- deleting ---------------------------------------------------------------

test('deleting requires typing the business name', async () => {
  // The gap between "delete a company" and "delete the account" is otherwise
  // one tap, and only one of those is recoverable.
  const f = await fixture();
  await assert.rejects(() => account.requestDelete(ctxFor(f, { confirm: 'wrong' })),
    /Type the business name/);
  await assert.rejects(() => account.requestDelete(ctxFor(f, {})), /Type the business name/);
});

test('the name check ignores case and stray spaces', async () => {
  // Refusing "acme traders " when the business is "Acme Traders" is pedantry
  // that teaches people to paste rather than read.
  const f = await fixture();
  const r = await account.requestDelete(ctxFor(f, { confirm: '  acme traders ' }));
  assert.equal(r.daysLeft, account.GRACE_DAYS);
});

test('nothing is actually deleted when deletion is requested', async () => {
  const f = await fixture();
  await account.requestDelete(ctxFor(f, { confirm: f.name }));
  const { rows } = await query('SELECT count(*)::int n FROM companies WHERE org_id = $1',
    [f.orgId]);
  assert.equal(rows[0].n, 1, 'the books are untouched during the grace period');
});

test('the deletion can be called off', async () => {
  const f = await fixture();
  await account.requestDelete(ctxFor(f, { confirm: f.name }));
  await account.cancelDelete(ctxFor(f));
  const st = await account.status(ctxFor(f));
  assert.equal(st.deletion, null);
});

test('a second request while one is pending is refused', async () => {
  const f = await fixture();
  await account.requestDelete(ctxFor(f, { confirm: f.name }));
  await assert.rejects(() => account.requestDelete(ctxFor(f, { confirm: f.name })),
    /already scheduled/);
});

test('cancelling when nothing is scheduled says so', async () => {
  const f = await fixture();
  await assert.rejects(() => account.cancelDelete(ctxFor(f)), /not scheduled/);
});

test('a member cannot delete the business', async () => {
  // The settings permission is for somebody who configures the product, not
  // somebody who can close the company.
  const f = await fixture();
  const bob = await addMember(f, 'Bob');
  await assert.rejects(
    () => account.requestDelete({
      ...ctxFor(f, { confirm: f.name }, bob, 'member'),
      session: { org: { id: f.orgId },
                 user: { id: bob, role: 'member', roleId: null,
                         permissions: { settings: ['read', 'update', 'delete', 'export'] } } },
    }),
    /Only an owner/);
});

test('a deletion that has come due removes everything', async () => {
  const f = await fixture();
  await account.requestDelete(ctxFor(f, { confirm: f.name }));
  await query('UPDATE orgs SET delete_due_at = now() - interval \'1 day\' WHERE id = $1',
    [f.orgId]);

  const r = await account.runDueDeletions();
  assert.ok(r.deleted >= 1);

  for (const t of ['orgs', 'companies', 'users']) {
    const col = t === 'orgs' ? 'id' : 'org_id';
    const { rows } = await query(
      `SELECT count(*)::int n FROM ${t} WHERE ${col} = $1`, [f.orgId]);
    assert.equal(rows[0].n, 0, `${t} still holds rows for a deleted account`);
  }
});

test('a deletion that is not yet due is left alone', async () => {
  const f = await fixture();
  await account.requestDelete(ctxFor(f, { confirm: f.name }));
  await account.runDueDeletions();
  const { rows } = await query('SELECT count(*)::int n FROM orgs WHERE id = $1', [f.orgId]);
  assert.equal(rows[0].n, 1);
});

test('every table that holds customer data cascades from the account', async () => {
  /*
   * The deletion relies entirely on ON DELETE CASCADE. A table added later
   * without one would silently leave a customer's data behind after they asked
   * for it to be gone - which is the exact promise this feature makes.
   */
  const { rows } = await query(`
    SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND EXISTS (SELECT 1 FROM pg_attribute a
                    WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped)
       AND NOT EXISTS (
         SELECT 1 FROM pg_constraint fk
          WHERE fk.conrelid = c.oid AND fk.contype = 'f'
            AND fk.confrelid = 'orgs'::regclass
            AND fk.confdeltype IN ('c', 'n'))`);

  assert.deepEqual(rows.map((r) => r.table_name), [],
    'these tables hold org_id but would survive the account being deleted');
});

// --- recovery ---------------------------------------------------------------

test('a recovery address cannot be one that already signs in', async () => {
  /*
   * Losing that Google account is the single most likely reason to need
   * recovery. A recovery address on the same account fails exactly when it is
   * needed, which is worse than none.
   */
  const f = await fixture();
  const { rows } = await query('SELECT email FROM users WHERE id = $1', [f.userId]);
  await assert.rejects(
    () => account.setRecovery(ctxFor(f, { email: rows[0].email })),
    /different address/);
});

test('a recovery contact is saved and reported', async () => {
  const f = await fixture();
  await account.setRecovery(ctxFor(f, { email: 'spouse@example.com', phone: '+919876543210' }));
  const st = await account.status(ctxFor(f));
  assert.equal(st.recovery.email, 'spouse@example.com');
  assert.match(st.recovery.note, /cannot be used to sign in/);
});

test('a nonsense address is refused', async () => {
  const f = await fixture();
  await assert.rejects(() => account.setRecovery(ctxFor(f, { email: 'not-an-address' })),
    /does not look like/);
});

test('a sole owner is warned', async () => {
  // One lost phone away from nobody being able to run the business.
  const f = await fixture();
  const st = await account.status(ctxFor(f));
  assert.equal(st.soleOwner, true);
  assert.match(st.soleOwnerWarning, /second owner/);
});

// --- handing over -----------------------------------------------------------

test('a handover needs the other person to accept', async () => {
  const f = await fixture();
  const bob = await addMember(f, 'Bob');
  await account.offerTransfer(ctxFor(f, { userId: bob }));

  const { rows } = await query('SELECT role FROM users WHERE id = $1', [bob]);
  assert.equal(rows[0].role, 'member', 'nothing changes until it is accepted');
});

test('accepting makes them an owner', async () => {
  const f = await fixture();
  const bob = await addMember(f, 'Bob');
  const offer = await account.offerTransfer(ctxFor(f, { userId: bob }));
  await account.settleTransfer(ctxFor(f, {}, bob, 'member'), offer.id, 'accept');

  const { rows } = await query('SELECT role FROM users WHERE id = $1', [bob]);
  assert.equal(rows[0].role, 'owner');
});

test('accepting does not demote the person handing over', async () => {
  // A handover is usually a handover, not an ejection. Automatic demotion ends
  // with somebody locked out of their own shop.
  const f = await fixture();
  const bob = await addMember(f, 'Bob');
  const offer = await account.offerTransfer(ctxFor(f, { userId: bob }));
  await account.settleTransfer(ctxFor(f, {}, bob, 'member'), offer.id, 'accept');

  const { rows } = await query('SELECT role FROM users WHERE id = $1', [f.userId]);
  assert.equal(rows[0].role, 'owner');
});

test('only the person it was offered to can accept', async () => {
  const f = await fixture();
  const bob = await addMember(f, 'Bob');
  const carol = await addMember(f, 'Carol');
  const offer = await account.offerTransfer(ctxFor(f, { userId: bob }));
  await assert.rejects(
    () => account.settleTransfer(ctxFor(f, {}, carol, 'member'), offer.id, 'accept'),
    /not made to you/);
});

test('two handovers cannot be open at once', async () => {
  // Both could otherwise be accepted, and the second would silently demote the
  // first new owner.
  const f = await fixture();
  const bob = await addMember(f, 'Bob');
  const carol = await addMember(f, 'Carol');
  await account.offerTransfer(ctxFor(f, { userId: bob }));
  await assert.rejects(() => account.offerTransfer(ctxFor(f, { userId: carol })),
    /already an offer/);
});

test('a lapsed offer cannot be accepted', async () => {
  const f = await fixture();
  const bob = await addMember(f, 'Bob');
  const offer = await account.offerTransfer(ctxFor(f, { userId: bob }));
  await query(`UPDATE owner_transfers SET expires_at = now() - interval '1 day' WHERE id = $1`,
    [offer.id]);
  await assert.rejects(
    () => account.settleTransfer(ctxFor(f, {}, bob, 'member'), offer.id, 'accept'),
    /lapsed/);
});

test('handing the business to yourself is refused', async () => {
  const f = await fixture();
  await assert.rejects(() => account.offerTransfer(ctxFor(f, { userId: f.userId })),
    /already own/);
});

// --- exporting --------------------------------------------------------------

test('an export carries the books and never a credential', async () => {
  /*
   * Somebody closing an account is exactly the person who most needs a copy of
   * their data - and an export that leaks a token hash is a second problem.
   */
  const f = await fixture();
  const out = await account.exportAll(ctxFor(f));
  const parsed = JSON.parse(out.archive);

  assert.equal(parsed.companies.length, 1);
  assert.equal(parsed.people.length, 1);
  assert.ok(!/token_hash|firebase_uid|password/i.test(out.archive),
    'the export leaks something that could sign somebody in');
});
