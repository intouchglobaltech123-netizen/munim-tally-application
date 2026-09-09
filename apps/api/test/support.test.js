const { test, after } = require('node:test');
const assert = require('node:assert');
const { query } = require('../src/db');
const support = require('../src/routes/support');

/**
 * Getting help without leaving the product.
 *
 * The properties that matter: a ticket carries what broke, an internal note is
 * never visible to the customer, and the queue puts a stopped business ahead of
 * a feature request.
 */

const orgs = [];
after(async () => { for (const id of orgs) await query('DELETE FROM orgs WHERE id = $1', [id]); });

async function fixture(plan = 'standard') {
  const { rows: o } = await query(
    `INSERT INTO orgs (name, plan) VALUES ('sup-test',$1) RETURNING *`, [plan]);
  orgs.push(o[0].id);
  const { rows: u } = await query(
    `INSERT INTO users (org_id, email, role, name) VALUES ($1,$2,'owner','Owner') RETURNING id`,
    [o[0].id, `sup-${o[0].id.slice(0, 8)}@example.com`]);
  const { rows: c } = await query(
    `INSERT INTO companies (org_id, tally_guid, name) VALUES ($1,$2,'Books') RETURNING *`,
    [o[0].id, `sup-${o[0].id}`]);
  return { orgId: o[0].id, userId: u[0].id, co: c[0] };
}

const ctxFor = (f, body = {}) => ({
  session: { org: { id: f.orgId }, user: { id: f.userId, role: 'owner', roleId: null,
                                           name: 'Owner', email: 'o@x.com' } },
  req: { headers: {}, socket: {} }, url: new URL('http://x/'), body,
});

const staffCtx = (body = {}) => ({
  session: { org: { id: null }, user: { id: null, role: 'platform_admin', name: 'Support' } },
  req: { headers: {}, socket: {} }, url: new URL('http://x/'), body,
});

// --- raising ----------------------------------------------------------------

test('a ticket carries what the system looked like when it broke', async () => {
  /*
   * Taken at the moment it is raised, not when somebody reads it: by then the
   * connector has often been restarted and the thing that broke is gone.
   */
  const f = await fixture();
  await query(
    `INSERT INTO connectors (org_id, machine_name, token_hash, tally_up, last_seen_at)
     VALUES ($1,'SHOP-PC',$2,false, now() - interval '3 hours')`,
    [f.orgId, `t-${f.orgId}`]);

  const made = await support.createTicket(ctxFor(f, {
    subject: 'Numbers stopped updating', body: 'Nothing since yesterday morning.',
    category: 'sync' }));

  const { rows } = await query('SELECT diagnostics FROM tickets WHERE id = $1', [made.id]);
  const d = rows[0].diagnostics;
  assert.equal(d.connectors.length, 1);
  assert.equal(d.connectors[0].machine, 'SHOP-PC');
  assert.equal(d.connectors[0].tallyRunning, false);
  assert.ok(d.connectors[0].minutesSinceSeen > 100);
});

test('the customer is told the diagnostics were attached', async () => {
  // Somebody who can see what was sent about their system trusts it; somebody
  // who finds out later does not.
  const f = await fixture();
  const made = await support.createTicket(ctxFor(f, {
    subject: 'A question about GST', body: 'How do I read the B2B summary?' }));
  assert.ok(made.diagnosticsAttached > 0);
  assert.match(made.message, /connector and sync details/);
});

test('a ticket number is unique across the platform', async () => {
  // So support never has to ask "whose number 14?".
  const a = await fixture();
  const b = await fixture();
  const one = await support.createTicket(ctxFor(a, {
    subject: 'First problem', body: 'Something went wrong here.' }));
  const two = await support.createTicket(ctxFor(b, {
    subject: 'Second problem', body: 'Something went wrong here too.' }));
  assert.notEqual(one.number, two.number);
});

test('a too-short description is refused', async () => {
  // "It's broken" costs two round trips to turn into something actionable.
  const f = await fixture();
  await assert.rejects(
    () => support.createTicket(ctxFor(f, { subject: 'Broken', body: 'help' })),
    /Tell us a little more/);
});

test('the reply target comes from the plan and is published', async () => {
  /*
   * An unpublished target is not a promise, it is an excuse.
   */
  const pro = await fixture('standard');
  const trial = await fixture('trial');
  const p = await support.help(ctxFor(pro));
  const t = await support.help(ctxFor(trial));
  assert.ok(p.responseHours.urgent < t.responseHours.urgent);
});

// --- troubleshooting before the ticket --------------------------------------

test('a connector that stopped reporting is diagnosed before anybody writes', async () => {
  /*
   * A customer told "that computer has not reported for two hours — is it
   * switched on?" often does not need a ticket at all.
   */
  const out = support.troubleshoot({
    connectors: [{ machine: 'SHOP-PC', minutesSinceSeen: 140, tallyRunning: true }],
  }, null);
  assert.ok(out.some((x) => /stopped reporting/i.test(x.title)));
});

test('Tally being closed is diagnosed separately from the computer being off', async () => {
  // They are different fixes and telling somebody the wrong one wastes an hour.
  const out = support.troubleshoot({
    connectors: [{ machine: 'PC', minutesSinceSeen: 1, tallyRunning: false }],
  }, null);
  assert.ok(out.some((x) => /Tally is not running/i.test(x.title)));
  assert.ok(!out.some((x) => /stopped reporting/i.test(x.title)));
});

test('no connector at all is its own diagnosis', () => {
  const out = support.troubleshoot({ connectors: [] }, null);
  assert.ok(out.some((x) => /No Tally computer/i.test(x.title)));
});

test('a "wrong figure" report is met with the usual cause first', () => {
  const out = support.troubleshoot(
    { connectors: [{ machine: 'PC', minutesSinceSeen: 1, tallyRunning: true }] }, 'numbers');
  assert.ok(out.some((x) => /check the period/i.test(x.title)));
});

// --- the conversation -------------------------------------------------------

test('an internal note is never returned to the customer', async () => {
  /*
   * Excluded in the query rather than filtered after: a read-time filter is one
   * forgotten condition away from showing a customer what was said about them,
   * and that mistake is unrecoverable.
   */
  const f = await fixture();
  const made = await support.createTicket(ctxFor(f, {
    subject: 'Something is wrong', body: 'Please take a look at this.' }));

  await support.reply(staffCtx({ body: 'Looks like their own Tally is misconfigured.',
                                 internal: true }), made.id);
  await support.reply(staffCtx({ body: 'Could you check Tally is open on that PC?' }),
    made.id);

  const seen = await support.ticket(ctxFor(f), made.id);
  const text = JSON.stringify(seen);
  assert.ok(!text.includes('misconfigured'), 'the internal note leaked');
  assert.equal(seen.messages.length, 2, 'their message and the real reply');
});

test('staff can see the internal note', async () => {
  const f = await fixture();
  const made = await support.createTicket(ctxFor(f, {
    subject: 'Something is wrong', body: 'Please take a look at this.' }));
  await support.reply(staffCtx({ body: 'internal thought', internal: true }), made.id);

  const seen = await support.ticket(staffCtx(), made.id);
  assert.ok(JSON.stringify(seen).includes('internal thought'));
});

test('an internal note does not change the status', async () => {
  // Marking a ticket "with us" because somebody left themselves a note would
  // make the queue lie.
  const f = await fixture();
  const made = await support.createTicket(ctxFor(f, {
    subject: 'Something is wrong', body: 'Please take a look at this.' }));
  await support.reply(staffCtx({ body: 'note to self', internal: true }), made.id);

  const { rows } = await query('SELECT status, first_reply_at FROM tickets WHERE id = $1',
    [made.id]);
  assert.equal(rows[0].status, 'open');
  assert.equal(rows[0].first_reply_at, null);
});

test('a staff reply moves it to waiting on the customer', async () => {
  const f = await fixture();
  const made = await support.createTicket(ctxFor(f, {
    subject: 'Something is wrong', body: 'Please take a look at this.' }));
  await support.reply(staffCtx({ body: 'Have you tried restarting Tally?' }), made.id);

  const { rows } = await query('SELECT status, first_reply_at FROM tickets WHERE id = $1',
    [made.id]);
  assert.equal(rows[0].status, 'waiting_on_you');
  assert.ok(rows[0].first_reply_at);
});

test('a customer replying to a resolved ticket reopens it', async () => {
  const f = await fixture();
  const made = await support.createTicket(ctxFor(f, {
    subject: 'Something is wrong', body: 'Please take a look at this.' }));
  await support.setStatus(staffCtx({ status: 'resolved' }), made.id);
  await support.reply(ctxFor(f, { body: 'It is still happening.' }), made.id);

  const { rows } = await query('SELECT status FROM tickets WHERE id = $1', [made.id]);
  assert.equal(rows[0].status, 'open');
});

test('a customer cannot mark their own ticket resolved', async () => {
  // That would hide it from the queue without anybody having looked at it.
  const f = await fixture();
  const made = await support.createTicket(ctxFor(f, {
    subject: 'Something is wrong', body: 'Please take a look at this.' }));
  await assert.rejects(
    () => support.setStatus(ctxFor(f, { status: 'resolved' }), made.id),
    /not a status you can set/);
});

test('a customer can close and reopen their own ticket', async () => {
  const f = await fixture();
  const made = await support.createTicket(ctxFor(f, {
    subject: 'Never mind', body: 'I worked it out myself, thanks.' }));
  await support.setStatus(ctxFor(f, { status: 'closed' }), made.id);
  await support.setStatus(ctxFor(f, { status: 'open' }), made.id);
  const { rows } = await query('SELECT status FROM tickets WHERE id = $1', [made.id]);
  assert.equal(rows[0].status, 'open');
});

test('one business cannot read another business\'s ticket', async () => {
  const a = await fixture();
  const b = await fixture();
  const made = await support.createTicket(ctxFor(a, {
    subject: 'Private problem', body: 'Something confidential happened.' }));
  await assert.rejects(() => support.ticket(ctxFor(b), made.id), (e) => e.status === 404);
});

test('a ticket can be rated once', async () => {
  const f = await fixture();
  const made = await support.createTicket(ctxFor(f, {
    subject: 'All sorted now', body: 'Thanks for the quick help earlier.' }));
  await support.rate(ctxFor(f, { rating: 5 }), made.id);
  await assert.rejects(() => support.rate(ctxFor(f, { rating: 1 }), made.id),
    /already rated/);
});

test('a nonsense rating is refused', async () => {
  const f = await fixture();
  const made = await support.createTicket(ctxFor(f, {
    subject: 'A question', body: 'Just wondering about something.' }));
  await assert.rejects(() => support.rate(ctxFor(f, { rating: 11 }), made.id), /1 to 5/);
});

// --- the queue --------------------------------------------------------------

test('a stopped business is ahead of a feature request', async () => {
  // A queue sorted only by age lets an urgent ticket wait behind a suggestion.
  const f = await fixture();
  await support.createTicket(ctxFor(f, {
    subject: 'Could you add dark mode', body: 'Would be nice to have one day.',
    priority: 'low' }));
  await support.createTicket(ctxFor(f, {
    subject: 'Cannot see any sales', body: 'The whole shop is stopped right now.',
    priority: 'urgent' }));

  const q = await support.queue(staffCtx());
  const mine = q.tickets.filter((t) => t.subject.match(/dark mode|any sales/));
  assert.match(mine[0].subject, /any sales/);
});

test('a missed response target is flagged', async () => {
  const f = await fixture('standard');
  const made = await support.createTicket(ctxFor(f, {
    subject: 'Urgent problem here', body: 'Everything is stopped.', priority: 'urgent' }));
  await query(`UPDATE tickets SET created_at = now() - interval '2 days' WHERE id = $1`,
    [made.id]);

  const q = await support.queue(staffCtx());
  const t = q.tickets.find((x) => x.id === made.id);
  assert.equal(t.breached, true);
  assert.ok(t.ageHours > 24);
});

test('a customer cannot read the queue', async () => {
  const f = await fixture();
  await assert.rejects(() => support.queue(ctxFor(f)),
    (e) => e.status === 401 || e.status === 403);
});

test('the FAQ answers the write question first, and answers it honestly', () => {
  /*
   * It is the question every accountant asks before letting this near Tally,
   * and the answer changed when writing was added. It has to say BOTH halves:
   * that Munim can write, and that it only writes what somebody typed here and
   * deliberately sent. An answer that still said "never writes" would be a lie,
   * and one that just said "it writes" would lose the customer.
   */
  assert.match(support.FAQ[0].q, /change anything in my Tally/i);
  assert.match(support.FAQ[0].a, /deliberately create/i);
  assert.match(support.FAQ[0].a, /never edits or\s+deletes/i);
});

test('nothing in the FAQ still claims Munim never writes', () => {
  // A single stale sentence is worse than either promise, because a customer
  // who finds it will not know which one to believe.
  for (const item of support.FAQ) {
    assert.ok(!/never writes/i.test(item.a), `stale claim in: ${item.q}`);
  }
});

// --- attachments ------------------------------------------------------------

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

async function withTicket() {
  const f = await fixture();
  const made = await support.createTicket(ctxFor(f, {
    subject: 'Screenshot attached', body: 'Here is what the error looks like.' }));
  return { f, id: made.id };
}

test('a screenshot can be attached', async () => {
  // The single most useful thing a customer can send.
  const { f, id } = await withTicket();
  const out = await support.attach(ctxFor(f, {
    filename: 'error.png', contentType: 'image/png',
    data: png.toString('base64') }), id);
  assert.equal(out.file.filename, 'error.png');
  assert.equal(out.file.size_bytes, png.length);
});

test('only a narrow set of file types is accepted', async () => {
  /*
   * An allowlist, not a blocklist: a blocklist is one missing entry away from
   * serving somebody's SVG - which is a script - from our own origin.
   */
  const { f, id } = await withTicket();
  for (const type of ['image/svg+xml', 'text/html', 'application/javascript',
                      'application/x-msdownload']) {
    await assert.rejects(
      () => support.attach(ctxFor(f, {
        filename: 'x', contentType: type, data: png.toString('base64') }), id),
      /not accepted/, `${type} was accepted`);
  }
});

test('a filename cannot smuggle anything into the response header', async () => {
  /*
   * The name ends up in Content-Disposition. "report.pdf\r\nX-Evil: 1" is the
   * whole attack, and rebuilding the name removes the class rather than one
   * instance of it.
   */
  const { f, id } = await withTicket();
  const out = await support.attach(ctxFor(f, {
    filename: 'evil"\r\nX-Injected: yes.png',
    contentType: 'image/png', data: png.toString('base64') }), id);

  assert.ok(!out.file.filename.includes('\r'));
  assert.ok(!out.file.filename.includes('"'));
  assert.match(out.file.filename, /\.png$/);
});

test('an oversized file is refused with its actual size', async () => {
  const { f, id } = await withTicket();
  const big = Buffer.alloc(6 * 1024 * 1024).toString('base64');
  await assert.rejects(
    () => support.attach(ctxFor(f, {
      filename: 'big.png', contentType: 'image/png', data: big }), id),
    /6\.0MB.*limit is 5MB/);
});

test('a file is handed back as a download, never inline', async () => {
  // Inline would render a customer-supplied file in our own origin.
  const { f, id } = await withTicket();
  const made = await support.attach(ctxFor(f, {
    filename: 'shot.png', contentType: 'image/png',
    data: png.toString('base64') }), id);

  const out = await support.file(ctxFor(f), id, made.file.id);
  assert.match(out._raw.headers['Content-Disposition'], /^attachment;/);
  assert.equal(out._raw.headers['X-Content-Type-Options'], 'nosniff');
  assert.deepEqual(out._raw.body, png);
});

test('one business cannot download another business\'s attachment', async () => {
  const { f, id } = await withTicket();
  const other = await fixture();
  const made = await support.attach(ctxFor(f, {
    filename: 'private.png', contentType: 'image/png',
    data: png.toString('base64') }), id);

  await assert.rejects(() => support.file(ctxFor(other), id, made.file.id),
    (e) => e.status === 404);
});

test('a ticket cannot be used as a file host', async () => {
  const { f, id } = await withTicket();
  for (let i = 0; i < 10; i++) {
    await support.attach(ctxFor(f, {
      filename: `f${i}.png`, contentType: 'image/png',
      data: png.toString('base64') }), id);
  }
  await assert.rejects(
    () => support.attach(ctxFor(f, {
      filename: 'eleven.png', contentType: 'image/png',
      data: png.toString('base64') }), id),
    /can hold 10 files/);
});
