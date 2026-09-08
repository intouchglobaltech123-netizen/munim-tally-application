const { test, after } = require('node:test');
const assert = require('node:assert');
const { query } = require('../src/db');
const apikeys = require('../src/lib/apikeys');
const webhooks = require('../src/lib/webhooks');
const publicapi = require('../src/routes/publicapi');
const developer = require('../src/routes/developer');

/**
 * The API other people build on.
 *
 * Two properties matter more than any individual response: a key can only read
 * what it was granted, and it can only ever read. Everything else is detail.
 */

const orgs = [];
after(async () => { for (const id of orgs) await query('DELETE FROM orgs WHERE id = $1', [id]); });

async function fixture(plan = 'pro') {
  const { rows: o } = await query(
    `INSERT INTO orgs (name, plan) VALUES ('api-test',$1) RETURNING *`, [plan]);
  orgs.push(o[0].id);
  const { rows: u } = await query(
    `INSERT INTO users (org_id, email, role) VALUES ($1,$2,'owner') RETURNING id`,
    [o[0].id, `api-${o[0].id.slice(0, 8)}@example.com`]);
  const { rows: c } = await query(
    `INSERT INTO companies (org_id, tally_guid, name) VALUES ($1,$2,'API Books') RETURNING *`,
    [o[0].id, `api-${o[0].id}`]);
  await query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
     VALUES ($1,$2,'1','Sales','2026-05-01','Ravi',500000)`, [c[0].id, `av-${c[0].id}`]);
  return { orgId: o[0].id, userId: u[0].id, co: c[0] };
}

const sessionCtx = (f, body = {}) => ({
  session: { org: { id: f.orgId, name: 'api-test' },
             user: { id: f.userId, role: 'owner', roleId: null } },
  req: { headers: {}, socket: {} }, url: new URL('http://x/'), body,
});

const apiCtx = (key, qs = '') => ({
  apiKey: key,
  req: { headers: {}, socket: {} },
  url: new URL(`http://x/api/v1/x${qs}`),
});

async function keyFor(f, scopes = Object.keys(apikeys.SCOPES)) {
  const made = await developer.createKey(sessionCtx(f, { name: 'test key', scopes }));
  return { raw: made.key, resolved: await apikeys.resolve(made.key) };
}

// --- keys -------------------------------------------------------------------

test('a key is shown once and never again', async () => {
  const f = await fixture();
  const made = await developer.createKey(sessionCtx(f, { name: 'key one', scopes: ['sales'] }));
  assert.match(made.key, /^munim_/);

  const list = await developer.overview(sessionCtx(f));
  const stored = list.keys.find((k) => k.id === made.id);
  assert.ok(!JSON.stringify(list).includes(made.key), 'the key leaked into the list');
  assert.equal(stored.prefix, made.prefix);
});

test('the key is stored only as a hash', async () => {
  const f = await fixture();
  const made = await developer.createKey(sessionCtx(f, { name: 'key one', scopes: ['sales'] }));
  const { rows } = await query('SELECT key_hash FROM api_keys WHERE id = $1', [made.id]);
  assert.notEqual(rows[0].key_hash, made.key);
  assert.equal(rows[0].key_hash, apikeys.hash(made.key));
});

test('a key with no scopes is refused', async () => {
  // A key that can read nothing is a support call waiting to happen.
  const f = await fixture();
  await assert.rejects(
    () => developer.createKey(sessionCtx(f, { name: 'key one', scopes: [] })),
    /at least one/);
});

test('an invented scope is dropped, not granted', async () => {
  const f = await fixture();
  const made = await developer.createKey(sessionCtx(f, {
    name: 'key one', scopes: ['sales', 'everything', '*'] }));
  assert.deepEqual(made.scopes, ['sales']);
});

test('a revoked key stops working immediately', async () => {
  const f = await fixture();
  const made = await developer.createKey(sessionCtx(f, { name: 'key one', scopes: ['sales'] }));
  await developer.revokeKey(sessionCtx(f), made.id);
  await assert.rejects(() => apikeys.resolve(made.key), /revoked/);
});

test('an expired key stops working', async () => {
  const f = await fixture();
  const made = await developer.createKey(sessionCtx(f, { name: 'key one', scopes: ['sales'] }));
  await query(`UPDATE api_keys SET expires_at = now() - interval '1 day' WHERE id = $1`,
    [made.id]);
  await assert.rejects(() => apikeys.resolve(made.key), /expired/);
});

test('a key on a plan without the API is refused, with the reason', async () => {
  /*
   * A key that keeps working after a downgrade is revenue given away; one that
   * fails with a bare 404 is a support call.
   */
  const f = await fixture('pro');
  const made = await developer.createKey(sessionCtx(f, { name: 'key one', scopes: ['sales'] }));
  await query(`UPDATE orgs SET plan = 'basic' WHERE id = $1`, [f.orgId]);
  await assert.rejects(() => apikeys.resolve(made.key), /not enabled on your plan/);
});

test('a plan without the API cannot create a key at all', async () => {
  const f = await fixture('basic');
  await assert.rejects(
    () => developer.createKey(sessionCtx(f, { name: 'key one', scopes: ['sales'] })),
    /not enabled/);
});

test('a member cannot create or revoke keys', async () => {
  const f = await fixture();
  const ctx = sessionCtx(f, { name: 'key one', scopes: ['sales'] });
  ctx.session.user = { id: f.userId, role: 'member', roleId: 'r',
                       permissions: { settings: ['read', 'create', 'update', 'delete'] } };
  await assert.rejects(() => developer.createKey(ctx), /Only an owner/);
});

test('a garbage token resolves to nothing rather than throwing', async () => {
  // Every request runs this, including ones carrying an ordinary session token.
  assert.equal(await apikeys.resolve('not-a-key'), null);
  assert.equal(await apikeys.resolve('acc_somesessiontoken'), null);
  assert.equal(await apikeys.resolve(undefined), null);
});

// --- scopes -----------------------------------------------------------------

test('a key can only read what it was granted', async () => {
  const f = await fixture();
  const k = await keyFor(f, ['sales']);
  await assert.rejects(() => publicapi.handle(apiCtx(k.resolved), 'GET', '/api/v1/items'),
    /cannot read/);
});

test('a scope refusal names the scope to add', async () => {
  const f = await fixture();
  const k = await keyFor(f, ['sales']);
  try {
    await publicapi.handle(apiCtx(k.resolved), 'GET', '/api/v1/gst');
    assert.fail('should have refused');
  } catch (e) {
    assert.match(e.message, /GST returns and summaries/);
    assert.match(e.message, /"gst" scope/);
  }
});

test('a key tied to one company cannot ask about another', async () => {
  /*
   * Silently answering about the wrong books is the worst outcome available
   * here, so a mismatch fails rather than being ignored.
   */
  const f = await fixture();
  const other = await fixture();
  const made = await developer.createKey(sessionCtx(f, {
    name: 'tied', scopes: ['sales'], company: f.co.tally_guid }));
  const resolved = await apikeys.resolve(made.key);

  await assert.rejects(
    () => publicapi.handle(apiCtx(resolved, `?company=${other.co.tally_guid}`),
      'GET', '/api/v1/vouchers'),
    /tied to one company/);
});

test('asking for another business\'s company is a 404', async () => {
  const a = await fixture();
  const b = await fixture();
  const k = await keyFor(b);
  await assert.rejects(
    () => publicapi.handle(apiCtx(k.resolved, `?company=${a.co.tally_guid}`),
      'GET', '/api/v1/vouchers'),
    (e) => e.status === 404);
});

// --- the surface ------------------------------------------------------------

test('the API is read-only, and says so on a write attempt', async () => {
  /*
   * A 405 rather than a 404: somebody who POSTs should learn the API is
   * read-only, not conclude they have the URL wrong.
   */
  const f = await fixture();
  const k = await keyFor(f);
  try {
    await publicapi.handle(apiCtx(k.resolved), 'POST', '/api/v1/vouchers');
    assert.fail('should have refused');
  } catch (e) {
    assert.equal(e.status, 405);
    assert.match(e.message, /only reads/);
  }
});

test('every published route is a GET', () => {
  // The moment one is not, the read-only promise on the marketing page is false.
  for (const route of Object.keys(publicapi.ROUTES)) {
    assert.ok(route.startsWith('GET '), `${route} is not a read`);
  }
});

test('an unversioned path is refused with the version to use', async () => {
  const f = await fixture();
  const k = await keyFor(f);
  await assert.rejects(
    () => publicapi.handle(apiCtx(k.resolved), 'GET', '/api/vouchers'),
    /\/api\/v1\//);
});

test('a call without a key says how to send one', async () => {
  await assert.rejects(
    () => publicapi.handle({ apiKey: null, url: new URL('http://x/') },
      'GET', '/api/v1/me'),
    /Authorization: Bearer/);
});

test('the documentation is generated from the route table', () => {
  // Hand-written docs drift; these cannot.
  const doc = publicapi.describe();
  for (const route of Object.keys(publicapi.ROUTES)) {
    assert.ok(doc.endpoints.includes(route), `${route} is undocumented`);
  }
  assert.equal(doc.readOnly, true);
});

test('vouchers come back in the documented shape', async () => {
  const f = await fixture();
  const k = await keyFor(f);
  const out = await publicapi.handle(apiCtx(k.resolved), 'GET', '/api/v1/vouchers');

  assert.equal(out.data.length, 1);
  assert.equal(out.data[0].number, '1');
  assert.equal(out.data[0].amountPaise, 500000);
  assert.equal(out.paging.total, 1);
  assert.equal(out.paging.next, null, 'nothing more to fetch');
});

test('paging reports where to go next', async () => {
  const f = await fixture();
  for (let i = 2; i <= 6; i++) {
    await query(
      `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
       VALUES ($1,$2,$3,'Sales','2026-05-01','X',1000)`,
      [f.co.id, `pg-${f.co.id}-${i}`, String(i)]);
  }
  const k = await keyFor(f);
  const out = await publicapi.handle(apiCtx(k.resolved, '?limit=2'), 'GET', '/api/v1/vouchers');
  assert.equal(out.data.length, 2);
  assert.equal(out.paging.total, 6);
  assert.equal(out.paging.next, 2);
});

test('a silly limit is clamped rather than honoured', async () => {
  const f = await fixture();
  const k = await keyFor(f);
  const out = await publicapi.handle(
    apiCtx(k.resolved, '?limit=999999'), 'GET', '/api/v1/vouchers');
  assert.ok(out.paging.limit <= 500);
});

test('an account with two companies must be told which one', async () => {
  // Guessing would answer about the wrong books roughly half the time.
  const f = await fixture();
  await query(`INSERT INTO companies (org_id, tally_guid, name) VALUES ($1,$2,'Second')`,
    [f.orgId, `two-${f.orgId}`]);
  const k = await keyFor(f);
  await assert.rejects(
    () => publicapi.handle(apiCtx(k.resolved), 'GET', '/api/v1/vouchers'),
    /Pass \?company=/);
});

test('the daily call ceiling is enforced from the plan', async () => {
  const f = await fixture();
  const k = await keyFor(f);
  await query(`UPDATE orgs SET limits = '{"apiCallsPerDay": 1}'::jsonb WHERE id = $1`,
    [f.orgId]);
  const resolved = await apikeys.resolve(k.raw);

  await query(
    `INSERT INTO api_log (org_id, method, path, status) VALUES ($1,'GET','/api/v1/me',200)`,
    [f.orgId]);

  await assert.rejects(
    () => publicapi.handle(apiCtx(resolved), 'GET', '/api/v1/me'),
    /allows 1 API calls a day/);
});

// --- webhooks ---------------------------------------------------------------

test('a webhook URL must be https', async () => {
  // The payload is the customer's accounting data.
  const f = await fixture();
  await assert.rejects(
    () => developer.createWebhook(sessionCtx(f, {
      url: 'http://example.com/h', events: ['sync.completed'] })),
    /must be https/);
});

test('a webhook cannot be pointed at an internal address', async () => {
  /*
   * Otherwise a webhook URL is a server-side request forgery primitive: point
   * one at the cloud metadata service and have Munim fetch it for you.
   */
  const f = await fixture();
  for (const url of ['https://169.254.169.254/latest/meta-data',
                     'https://127.0.0.1/x', 'https://10.0.0.1/x',
                     'https://192.168.1.1/x', 'https://localhost/x']) {
    await assert.rejects(
      () => developer.createWebhook(sessionCtx(f, { url, events: ['sync.completed'] })),
      /not reachable/, `${url} was accepted`);
  }
});

test('a public address in 172.32 is allowed, 172.16 is not', () => {
  // The private range is 172.16-172.31, not all of 172.
  assert.equal(webhooks.checkUrl('https://172.32.0.1/x').ok, true);
  assert.equal(webhooks.checkUrl('https://172.16.0.1/x').ok, false);
  assert.equal(webhooks.checkUrl('https://172.31.255.254/x').ok, false);
});

test('an invented event is dropped', async () => {
  const f = await fixture();
  const made = await developer.createWebhook(sessionCtx(f, {
    url: 'https://example.com/h', events: ['sync.completed', 'anything.goes'] }));
  assert.deepEqual(made.events, ['sync.completed']);
});

test('the signing secret is shown once and hinted at afterwards', async () => {
  const f = await fixture();
  const made = await developer.createWebhook(sessionCtx(f, {
    url: 'https://example.com/h', events: ['sync.completed'] }));
  assert.match(made.secret, /^whsec_/);

  const list = await developer.overview(sessionCtx(f));
  assert.ok(!JSON.stringify(list.webhooks).includes(made.secret),
    'the secret leaked into the list');
});

test('a signature covers the timestamp, so a delivery cannot be replayed for ever', () => {
  const a = webhooks.sign('s', 1000, '{}');
  const b = webhooks.sign('s', 2000, '{}');
  assert.notEqual(a, b);
});

test('turning a failed webhook back on clears its failure count', async () => {
  // Otherwise it is switched off again after one more bad delivery.
  const f = await fixture();
  const made = await developer.createWebhook(sessionCtx(f, {
    url: 'https://example.com/h', events: ['sync.completed'] }));
  await query(
    `UPDATE webhooks SET failures = 19, active = false, disabled_at = now() WHERE id = $1`,
    [made.id]);

  await developer.updateWebhook(sessionCtx(f, { active: true }), made.id);
  const { rows } = await query('SELECT failures, active, disabled_at FROM webhooks WHERE id = $1',
    [made.id]);
  assert.equal(rows[0].failures, 0);
  assert.equal(rows[0].active, true);
  assert.equal(rows[0].disabled_at, null);
});

test('emitting an unknown event does nothing rather than throwing', async () => {
  // A webhook is a notification about something that already happened; failing
  // to send it must not undo the thing it describes.
  const f = await fixture();
  const out = await webhooks.emit(f.orgId, 'not.a.real.event', {});
  assert.equal(out.sent, 0);
});
