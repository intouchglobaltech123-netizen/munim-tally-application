const { test, after } = require('node:test');
const assert = require('node:assert');
const { query } = require('../src/db');
const notify = require('../src/routes/notifications');
const { EVENTS, raise, inQuietHours } = require('../src/lib/events');
const perms = require('../src/lib/permissions');

/**
 * Telling somebody something happened, without becoming noise.
 *
 * Two things decide whether a notification feature is kept or muted: whether
 * it repeats itself, and whether it tells people things they should not see.
 */

const orgs = [];
after(async () => { for (const id of orgs) await query('DELETE FROM orgs WHERE id = $1', [id]); });

async function fixture() {
  const { rows: o } = await query('INSERT INTO orgs (name) VALUES ($1) RETURNING id', ['nt-test']);
  orgs.push(o[0].id);
  const { rows: u } = await query(
    `INSERT INTO users (org_id, email, role) VALUES ($1,$2,'owner') RETURNING id`,
    [o[0].id, `nt-${o[0].id.slice(0, 8)}@example.com`]);
  const { rows: c } = await query(
    `INSERT INTO companies (org_id, tally_guid, name) VALUES ($1,$2,'Nt Co') RETURNING *`,
    [o[0].id, `nt-${o[0].id}`]);
  return { orgId: o[0].id, userId: u[0].id, co: c[0] };
}

const ownerCtx = (f, body = {}, qs = '') => ({
  session: { org: { id: f.orgId }, user: { id: f.userId, role: 'owner', roleId: null } },
  url: new URL(`http://x/${qs}`), body,
});

const asRole = (f, permissions, qs = '') => ({
  session: {
    org: { id: f.orgId },
    user: { id: f.userId, role: 'member', roleId: 'r', permissions },
  },
  url: new URL(`http://x/${qs}`), body: {},
});

// --- quiet hours ------------------------------------------------------------

test('quiet hours wrap midnight, which is the normal case', () => {
  const night = { quietFrom: 22, quietTo: 7 };
  // 22 to 7 means the whole night, not "never" - the case most
  // implementations get wrong.
  assert.equal(inQuietHours(night, new Date(2026, 0, 1, 23)), true);
  assert.equal(inQuietHours(night, new Date(2026, 0, 1, 3)), true);
  assert.equal(inQuietHours(night, new Date(2026, 0, 1, 7)), false);
  assert.equal(inQuietHours(night, new Date(2026, 0, 1, 14)), false);
});

test('a window inside one day still works', () => {
  const day = { quietFrom: 13, quietTo: 16 };
  assert.equal(inQuietHours(day, new Date(2026, 0, 1, 14)), true);
  assert.equal(inQuietHours(day, new Date(2026, 0, 1, 17)), false);
  assert.equal(inQuietHours(day, new Date(2026, 0, 1, 3)), false);
});

test('muted means always quiet', () => {
  assert.equal(inQuietHours({ notifyMuted: true }, new Date(2026, 0, 1, 12)), true);
});

// --- raising ----------------------------------------------------------------

test('the same event is not announced twice', async () => {
  const f = await fixture();
  const first = await raise(f.orgId, 'bill.overdue', {
    title: 'Acme overdue', dedupeKey: 'INV-1-2026-05-01' });
  const again = await raise(f.orgId, 'bill.overdue', {
    title: 'Acme overdue', dedupeKey: 'INV-1-2026-05-01' });

  assert.ok(first);
  // A bill 40 days overdue is not 40 notifications.
  assert.equal(again, null);
});

test('an unknown event is ignored rather than stored', async () => {
  const f = await fixture();
  assert.equal(await raise(f.orgId, 'nonsense.thing', { title: 'x' }), null);
});

test('raising never throws, whatever it is given', async () => {
  // An event is a side effect of something that already succeeded; failing to
  // announce a sale must not fail the sale.
  assert.equal(await raise('not-a-uuid', 'sale.new', { title: 'x' }), null);
  assert.equal(await raise(null, 'sale.new', {}), null);
});

test('a turned-off event raises nothing', async () => {
  const f = await fixture();
  await notify.setRule(ownerCtx(f, { event: 'sale.new', enabled: false }));
  assert.equal(await raise(f.orgId, 'sale.new', {
    title: 'A sale', dedupeKey: 'v1' }), null);
});

test('a threshold suppresses the small stuff', async () => {
  const f = await fixture();
  await notify.setRule(ownerCtx(f, { event: 'sale.new', minAmountPaise: 100000 }));

  assert.equal(await raise(f.orgId, 'sale.new', {
    title: 'Small', amountPaise: 5000, dedupeKey: 'small' }), null);
  assert.ok(await raise(f.orgId, 'sale.new', {
    title: 'Big', amountPaise: 500000, dedupeKey: 'big' }));
});

// --- who sees what ----------------------------------------------------------

test('what somebody hears follows what they can already see', async () => {
  const f = await fixture();
  await raise(f.orgId, 'sale.new', { title: 'A sale', dedupeKey: 's1' });
  await raise(f.orgId, 'purchase.new', { title: 'A bill', dedupeKey: 'p1' });

  // A salesperson who cannot open purchases is not told about a new bill.
  const salesOnly = asRole(f, { sales: ['read'] });
  const seen = await notify.feed(salesOnly);
  assert.equal(seen.notifications.length, 1);
  assert.equal(seen.notifications[0].title, 'A sale');
});

test('somebody who can see nothing gets an empty feed, not an error', async () => {
  const f = await fixture();
  await raise(f.orgId, 'sale.new', { title: 'A sale', dedupeKey: 's1' });
  const nobody = await notify.feed(asRole(f, {}));
  assert.deepEqual(nobody.notifications, []);
  assert.equal(nobody.unread, 0);
});

test('every event names a module that exists', () => {
  // Otherwise an event would be visible to nobody, silently.
  for (const [key, def] of Object.entries(EVENTS)) {
    assert.ok(perms.MODULES[def.module], `${key} points at "${def.module}"`);
  }
});

// --- read state -------------------------------------------------------------

test('read state is per person', async () => {
  const f = await fixture();
  const { rows: other } = await query(
    `INSERT INTO users (org_id, email, role) VALUES ($1,$2,'owner') RETURNING id`,
    [f.orgId, `two-${f.orgId.slice(0, 8)}@example.com`]);

  await raise(f.orgId, 'sale.new', { title: 'A sale', dedupeKey: 's1' });
  await notify.markRead(ownerCtx(f));

  const mine = await notify.feed(ownerCtx(f));
  assert.equal(mine.unread, 0);

  // One event goes to several people; each reads it at their own time.
  const theirs = await notify.feed({
    session: { org: { id: f.orgId }, user: { id: other[0].id, role: 'owner', roleId: null } },
    url: new URL('http://x/'), body: {},
  });
  assert.equal(theirs.unread, 1);
});

test('marking specific ones read leaves the others', async () => {
  const f = await fixture();
  const a = await raise(f.orgId, 'sale.new', { title: 'One', dedupeKey: 'a' });
  await raise(f.orgId, 'sale.new', { title: 'Two', dedupeKey: 'b' });

  await notify.markRead(ownerCtx(f, { ids: [a] }));
  const feed = await notify.feed(ownerCtx(f));
  assert.equal(feed.unread, 1);
  assert.equal(feed.notifications.find((n) => n.title === 'One').read, true);
});

test('unread-only filters the feed', async () => {
  const f = await fixture();
  const a = await raise(f.orgId, 'sale.new', { title: 'One', dedupeKey: 'a' });
  await raise(f.orgId, 'sale.new', { title: 'Two', dedupeKey: 'b' });
  await notify.markRead(ownerCtx(f, { ids: [a] }));

  const only = await notify.feed(ownerCtx(f, {}, '?unread=1'));
  assert.equal(only.notifications.length, 1);
  assert.equal(only.notifications[0].title, 'Two');
});

// --- the sweep --------------------------------------------------------------

async function overdueBill(f, ref, amount, dueDate) {
  const { rows } = await query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
     VALUES ($1,$2,$3,'Sales','2026-01-01','Acme',$4) RETURNING id`,
    [f.co.id, `v-${ref}`, ref, amount]);
  await query(
    `INSERT INTO bills (company_id, voucher_id, ref, party, bill_date, due_date,
                        amount_paise, bill_type)
     VALUES ($1,$2,$3,'Acme','2026-01-01',$4,$5,'New Ref')`,
    [f.co.id, rows[0].id, ref, dueDate, amount]);
  // An anchor so "today" is well past the due date.
  await query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
     VALUES ($1,'anchor','0','Sales','2026-06-01','Anchor',1)
     ON CONFLICT DO NOTHING`, [f.co.id]);
}

test('the sweep finds overdue bills and does not repeat them', async () => {
  const f = await fixture();
  await overdueBill(f, 'INV-1', 500000, '2026-03-01');

  const first = await notify.sweep(ownerCtx(f), f.co.tally_guid);
  assert.ok(first.raised >= 1);

  // Checked whenever somebody opens the app, so it must be idempotent.
  const second = await notify.sweep(ownerCtx(f), f.co.tally_guid);
  assert.equal(second.raised, 0);
});

test('the sweep finds negative and low stock, and tells them apart', async () => {
  const f = await fixture();
  await query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
     VALUES ($1,'a','0','Sales','2026-06-01','A',1)`, [f.co.id]);
  await query(
    `INSERT INTO stock_items (company_id, guid, name, unit, closing_qty, reorder_level)
     VALUES ($1,'i1','Oversold','Nos',-3,0), ($1,'i2','Running out','Nos',2,10)`, [f.co.id]);

  await notify.sweep(ownerCtx(f), f.co.tally_guid);
  const feed = await notify.feed(ownerCtx(f));
  const events = feed.notifications.map((n) => n.event);
  // A bookkeeping fault and a purchasing decision are different things.
  assert.ok(events.includes('stock.negative'));
  assert.ok(events.includes('stock.low'));
});

test('a connector quiet for hours is reported once a day', async () => {
  const f = await fixture();
  await query(
    `INSERT INTO connectors (org_id, machine_name, token_hash, last_seen_at)
     VALUES ($1,'SHOP-PC',$2, now() - interval '10 hours')`, [f.orgId, `t-${f.orgId}`]);
  await query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
     VALUES ($1,'a','0','Sales','2026-06-01','A',1)`, [f.co.id]);

  await notify.sweep(ownerCtx(f), f.co.tally_guid);
  const feed = await notify.feed(ownerCtx(f));
  const offline = feed.notifications.find((n) => n.event === 'connector.offline');
  assert.ok(offline);
  // The consequence, not just the fact.
  assert.match(offline.body, /not current/i);
});

test('a healthy connector raises nothing', async () => {
  const f = await fixture();
  await query(
    `INSERT INTO connectors (org_id, machine_name, token_hash, last_seen_at)
     VALUES ($1,'SHOP-PC',$2, now())`, [f.orgId, `t-${f.orgId}`]);
  await query(
    `INSERT INTO vouchers (company_id, guid, vch_no, vch_type, vch_date, party, amount_paise)
     VALUES ($1,'a','0','Sales','2026-06-01','A',1)`, [f.co.id]);

  await notify.sweep(ownerCtx(f), f.co.tally_guid);
  const feed = await notify.feed(ownerCtx(f));
  assert.equal(feed.notifications.filter((n) => n.event === 'connector.offline').length, 0);
});

// --- settings ---------------------------------------------------------------

test('settings list every event, with defaults for ones never configured', async () => {
  const f = await fixture();
  const s = await notify.settings(ownerCtx(f));
  assert.equal(s.rules.length, Object.keys(EVENTS).length);
  // Absent means the built-in default, so a new event works everywhere
  // without a backfill.
  assert.ok(s.rules.every((r) => r.enabled));
});

test('quiet hours are personal, not a business setting', async () => {
  const f = await fixture();
  await notify.setMine(ownerCtx(f, { quietFrom: 21, quietTo: 8 }));
  const s = await notify.settings(ownerCtx(f));
  assert.equal(s.mine.quietFrom, 21);
  assert.equal(s.mine.quietTo, 8);
});

test('a silly hour or unknown event is refused', async () => {
  const f = await fixture();
  await assert.rejects(
    () => notify.setMine(ownerCtx(f, { quietFrom: 30 })), (e) => e.status === 400);
  await assert.rejects(
    () => notify.setRule(ownerCtx(f, { event: 'nope' })), (e) => e.status === 400);
});

test('notifications never cross businesses', async () => {
  const a = await fixture();
  const b = await fixture();
  await raise(a.orgId, 'sale.new', { title: 'Theirs', dedupeKey: 's1' });
  const mine = await notify.feed(ownerCtx(b));
  assert.equal(mine.notifications.length, 0);
});
