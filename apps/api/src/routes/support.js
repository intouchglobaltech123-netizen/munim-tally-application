'use strict';
const { query, tx } = require('../db');
const auth = require('../lib/auth');
const audit = require('../lib/audit');
const secrets = require('../lib/secrets');
const plans = require('../lib/plans');
const { HttpError, bad } = require('../lib/http');

/**
 * Getting help without leaving the product.
 *
 * A ticket raised here already knows which account it came from, which Tally
 * version, whether the connector is up and when it last synced. An email does
 * not, and the first three replies of every email thread are spent asking.
 *
 * The diagnostics snapshot is the whole point and is taken at the moment the
 * ticket is raised, not when somebody reads it: by then the connector has often
 * been restarted and the very thing that broke is gone.
 */

const CATEGORIES = {
  connector:  'The Tally connector',
  sync:       'Data not syncing or wrong',
  numbers:    'A figure looks wrong',
  billing:    'Plan, payment or invoice',
  access:     'Signing in, users, permissions',
  feature:    'A request or suggestion',
  other:      'Something else',
};

const PRIORITIES = {
  low:    'Whenever you get to it',
  normal: 'Normal',
  high:   'Blocking work today',
  urgent: 'The business is stopped',
};

/*
 * Response targets, by plan.
 *
 * Published because an unpublished target is not a promise, it is an excuse.
 * These are first-response times in working hours, not resolution times -
 * promising a resolution time for "a figure looks wrong" would be dishonest,
 * since the answer sometimes lives in the customer's own Tally.
 */
const RESPONSE_HOURS = {
  trial: { urgent: 24, high: 24, normal: 48, low: 72 },
  standard: { urgent: 4, high: 8, normal: 12, low: 24 },
  internal: { urgent: 1, high: 1, normal: 1, low: 1 },
};

/**
 * What was true when this broke.
 *
 * Collected server-side rather than sent by the client, because a client that
 * is misbehaving is exactly the client whose self-report cannot be trusted -
 * and because half of this is not visible to the browser at all.
 */
async function collectDiagnostics(orgId, companyId) {
  const [conns, companies, syncs, org] = await Promise.all([
    query(`SELECT machine_name, status, tally_up, tally_version, tally_release,
                  app_version, last_seen_at, queued_batches, last_error
             FROM connectors WHERE org_id = $1 AND revoked_at IS NULL`, [orgId]),
    query(`SELECT tally_guid, name, last_sync_at,
                  (SELECT count(*) FROM vouchers v WHERE v.company_id = c.id) AS vouchers
             FROM companies c WHERE org_id = $1`, [orgId]),
    query(`SELECT ok, error, error_kind, started_at, duration_ms
             FROM sync_runs WHERE org_id = $1 ORDER BY started_at DESC LIMIT 5`, [orgId]),
    query('SELECT plan, created_at FROM orgs WHERE id = $1', [orgId]),
  ]);

  return {
    at: new Date().toISOString(),
    plan: org.rows[0]?.plan,
    accountAgeDays: org.rows[0]
      ? Math.floor((Date.now() - new Date(org.rows[0].created_at)) / 86400000) : null,
    connectors: conns.rows.map((c) => ({
      machine: c.machine_name,
      status: c.status,
      tallyRunning: c.tally_up,
      tally: `${c.tally_version ?? ''} ${c.tally_release ?? ''}`.trim(),
      connectorVersion: c.app_version,
      lastSeenAt: c.last_seen_at,
      minutesSinceSeen: c.last_seen_at
        ? Math.round((Date.now() - new Date(c.last_seen_at)) / 60000) : null,
      queued: c.queued_batches,
      lastError: c.last_error || null,
    })),
    companies: companies.rows.map((c) => ({
      name: c.name, lastSyncAt: c.last_sync_at, vouchers: Number(c.vouchers),
      isTheOneAsking: companyId ? undefined : undefined,
    })),
    recentSyncs: syncs.rows,
    encryptionAtRest: secrets.enabled(),
  };
}

/**
 * The first thing to try, chosen from the diagnostics.
 *
 * Most support tickets in this product have one of about six causes, and a
 * customer who is told "your connector has not reported for two hours - is that
 * computer switched on?" often does not need a ticket at all. Offering that
 * before the Send button is worth more than answering faster afterwards.
 */
function troubleshoot(diagnostics, category) {
  const out = [];
  const conns = diagnostics.connectors ?? [];

  if (!conns.length) {
    out.push({
      title: 'No Tally computer is linked',
      detail: 'Munim reads your books through a small program on the PC where '
            + 'Tally runs. Nothing syncs until one is linked.',
      action: 'Link a computer',
      href: '/connect',
    });
  }

  const stale = conns.filter((c) => c.minutesSinceSeen === null || c.minutesSinceSeen > 15);
  if (stale.length) {
    out.push({
      title: `${stale.length === 1 ? 'A computer has' : `${stale.length} computers have`} `
           + 'stopped reporting',
      detail: `${stale.map((c) => c.machine).join(', ')} last checked in `
            + `${stale[0].minutesSinceSeen === null ? 'never'
                : `${stale[0].minutesSinceSeen} minutes ago`}. `
            + 'Usually that computer is switched off, asleep, or off the network.',
      action: 'Check sync status',
      href: '/sync',
    });
  }

  const down = conns.filter((c) => c.tallyRunning === false);
  if (down.length) {
    out.push({
      title: 'Tally is not running',
      detail: 'The connector is fine but cannot reach Tally. Open Tally on that '
            + 'computer, load the company, and make sure Gateway of Tally → F1 → '
            + 'Advanced → "Enable ODBC" is Yes.',
      action: 'How to check',
      href: '/sync',
    });
  }

  const failed = (diagnostics.recentSyncs ?? []).filter((s) => !s.ok);
  if (failed.length >= 3) {
    out.push({
      title: 'The last few syncs failed',
      detail: failed[0].error || 'No detail was recorded.',
      action: 'See sync history',
      href: '/sync',
    });
  }

  if (category === 'numbers' && !out.length) {
    out.push({
      title: 'Before you write: check the period',
      detail: 'Most "wrong figure" reports come down to a different date range '
            + 'or a company filter still applied from an earlier screen. Munim '
            + 'also excludes orders and quotations from sales, which Tally\'s own '
            + 'reports sometimes include.',
      action: 'Open key numbers',
      href: '/kpi',
    });
  }

  return out;
}

/** Everything the help screen needs before somebody writes anything. */
async function help(ctx) {
  const s = auth.requireUser(ctx);
  const { rows: org } = await query('SELECT plan FROM orgs WHERE id = $1', [s.org.id]);
  const plan = org[0]?.plan ?? 'trial';

  const diagnostics = await collectDiagnostics(s.org.id, null);

  return {
    categories: Object.entries(CATEGORIES).map(([key, label]) => ({ key, label })),
    priorities: Object.entries(PRIORITIES).map(([key, label]) => ({ key, label })),
    responseHours: RESPONSE_HOURS[plan] ?? RESPONSE_HOURS.trial,
    planLabel: plans.plan(plan).label,
    diagnostics,
    suggestions: troubleshoot(diagnostics, null),
    faq: FAQ,
    contact: {
      email: process.env.SUPPORT_EMAIL || 'help@munim.app',
      whatsapp: process.env.SUPPORT_WHATSAPP || '',
      hours: 'Monday to Saturday, 10am to 7pm IST.',
      /*
       * Said plainly rather than implied by an absent phone number. A customer
       * hunting for a number that does not exist is more annoyed than one who
       * was told there isn't one.
       */
      phoneNote: process.env.SUPPORT_PHONE
        ? `Call ${process.env.SUPPORT_PHONE} during those hours.`
        : 'We do not have a phone line yet. Tickets and WhatsApp are answered '
          + 'the same day.',
    },
  };
}

/*
 * The questions that actually get asked, in the order they get asked.
 *
 * In the code rather than a database table because they change with the
 * product, not with the customer, and a table would need an editor nobody would
 * ever build.
 */
const FAQ = [
  {
    q: 'Does Munim change anything in my Tally?',
    a: 'Only what you deliberately create here. Munim reads your books, and the '
     + 'one thing it writes is a voucher you typed in Munim and pressed Send on '
     + '— and only if an owner has switched writing on. It never edits or '
     + 'deletes anything already in your books.',
  },
  {
    q: 'Why is a figure different from the same report in Tally?',
    a: 'Almost always the date range, or that Tally\'s report includes orders and '
     + 'quotations while Munim counts only real sales. Check the period first, '
     + 'then whether a party or item filter is still applied.',
  },
  {
    q: 'My numbers have stopped updating.',
    a: 'The connector runs on the PC where Tally is installed. If that computer '
     + 'is off, asleep, or Tally is closed, nothing syncs. The Sync screen shows '
     + 'when each computer last checked in.',
  },
  {
    q: 'Do I need to keep taking Tally backups?',
    a: 'Yes. Munim backs up its own copy of your books, which is not the same '
     + 'thing as your Tally company file. Keep doing both.',
  },
  {
    q: 'Can my staff see everything?',
    a: 'Only what you allow. Users & roles controls twelve areas separately, and '
     + 'anything not granted is refused by the server, not just hidden.',
  },
  {
    q: 'What happens to my data if I stop paying?',
    a: 'You keep your data and your sign-in. You lose the paid features, not the '
     + 'books, and you can export everything at any time from Account.',
  },
  {
    q: 'Can Munim create an E-Invoice or an E-Way Bill?',
    a: 'Not today. Both need write access to Tally and a contract with a GST '
     + 'Suvidha Provider. Munim shows you what would go on one, but does not '
     + 'file it.',
  },
];

/** Raise one. */
async function createTicket(ctx) {
  const s = auth.requireUser(ctx);

  const subject = String(ctx.body?.subject ?? '').trim();
  if (subject.length < 5 || subject.length > 150) {
    throw bad('BAD_SUBJECT', 'Give it a subject of 5 to 150 characters.');
  }
  const body = String(ctx.body?.body ?? '').trim();
  if (body.length < 10) {
    throw bad('BAD_BODY', 'Tell us a little more — what you did, and what happened.');
  }

  const category = ctx.body?.category in CATEGORIES ? ctx.body.category : 'other';
  const priority = ctx.body?.priority in PRIORITIES ? ctx.body.priority : 'normal';

  let companyId = null;
  if (ctx.body?.company) {
    const { rows } = await query(
      'SELECT id FROM companies WHERE org_id = $1 AND tally_guid = $2',
      [s.org.id, ctx.body.company]);
    companyId = rows[0]?.id ?? null;
  }

  const diagnostics = await collectDiagnostics(s.org.id, companyId);

  return tx(async (c) => {
    // From a sequence, not max()+1: two people pressing Send in the same moment
    // would both read the same maximum.
    const { rows: n } = await c.query("SELECT nextval('ticket_number_seq') AS n");

    const { rows } = await c.query(
      `INSERT INTO tickets (org_id, number, user_id, raised_by, raised_email,
                            company_id, subject, category, priority, diagnostics)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING *`,
      [s.org.id, Number(n[0].n), s.user.id, s.user.name ?? '', s.user.email ?? '',
       companyId, subject, category, priority, JSON.stringify(diagnostics)]);

    await c.query(
      `INSERT INTO ticket_messages (ticket_id, org_id, user_id, author, body)
       VALUES ($1,$2,$3,$4,$5)`,
      [rows[0].id, s.org.id, s.user.id, s.user.name ?? '', body]);

    await audit.record(ctx, 'support.ticket', {
      entityId: rows[0].id, entityName: `#${rows[0].number} ${subject}`,
      meta: { category, priority },
    });

    const { rows: org } = await c.query('SELECT plan FROM orgs WHERE id = $1', [s.org.id]);
    const hours = (RESPONSE_HOURS[org[0].plan] ?? RESPONSE_HOURS.trial)[priority];

    return {
      id: rows[0].id,
      number: rows[0].number,
      subject,
      priority,
      status: 'open',
      /*
       * The diagnostics are shown back rather than silently attached. A
       * customer who can see what was sent about their system trusts it; one
       * who finds out later does not.
       */
      diagnosticsAttached: Object.keys(diagnostics).length,
      message: `Ticket #${rows[0].number} raised. We aim to reply within `
             + `${hours} working hours, and we already have your connector and `
             + 'sync details — you will not be asked for them.',
    };
  });
}

/** Their tickets. */
async function listTickets(ctx) {
  const s = auth.requireUser(ctx);
  const { rows } = await query(
    `SELECT t.*,
            (SELECT count(*) FROM ticket_messages m
              WHERE m.ticket_id = t.id AND NOT m.internal)::int AS messages,
            (SELECT max(m.at) FROM ticket_messages m
              WHERE m.ticket_id = t.id AND NOT m.internal) AS last_at
       FROM tickets t WHERE t.org_id = $1
      ORDER BY t.created_at DESC LIMIT 100`, [s.org.id]);

  return {
    tickets: rows.map(ticketOut),
    open: rows.filter((t) => ['open', 'waiting_on_us', 'waiting_on_you'].includes(t.status))
      .length,
  };
}

const ticketOut = (t) => ({
  id: t.id,
  number: t.number,
  subject: t.subject,
  category: CATEGORIES[t.category] ?? t.category,
  priority: t.priority,
  status: t.status,
  statusLabel: {
    open: 'Open',
    waiting_on_us: 'With us',
    waiting_on_you: 'Waiting for you',
    resolved: 'Resolved',
    closed: 'Closed',
  }[t.status] ?? t.status,
  raisedBy: t.raised_by,
  createdAt: t.created_at,
  updatedAt: t.updated_at,
  firstReplyAt: t.first_reply_at,
  resolvedAt: t.resolved_at,
  messages: t.messages,
  lastAt: t.last_at,
  rating: t.rating,
});

/** One ticket and its conversation. */
async function ticket(ctx, id) {
  const s = auth.requireUser(ctx);
  const staff = s.user.role === 'platform_admin';

  const { rows } = await query(
    `SELECT * FROM tickets WHERE id = $1 ${staff ? '' : 'AND org_id = $2'}`,
    staff ? [id] : [id, s.org.id]);
  if (!rows.length) throw new HttpError(404, 'NOT_FOUND', 'No such ticket.');

  /*
   * Internal notes are excluded in the QUERY, not filtered after.
   *
   * A read-time filter is one forgotten condition away from showing a customer
   * what was said about them, and that mistake is unrecoverable.
   */
  const { rows: messages } = await query(
    `SELECT id, author, from_staff, internal, body, at FROM ticket_messages
      WHERE ticket_id = $1 AND org_id = $2 ${staff ? '' : 'AND NOT internal'}
      ORDER BY at`, [id, rows[0].org_id]);

  // org_id as well as ticket_id. The ticket above is already scoped, so this is
  // belt and braces - but it makes the query tenant-safe on its own rather than
  // only in combination with the line above it.
  const { rows: files } = await query(
    `SELECT id, filename, content_type, size_bytes, at FROM ticket_files
      WHERE ticket_id = $1 AND org_id = $2 ORDER BY at`, [id, rows[0].org_id]);

  return {
    ticket: ticketOut(rows[0]),
    messages,
    files,
    // Only staff see what the customer's system looked like; a customer sees
    // that it was attached, which is on the ticket itself.
    diagnostics: staff ? rows[0].diagnostics : undefined,
    suggestions: troubleshoot(rows[0].diagnostics ?? {}, rows[0].category),
  };
}

/** Reply to one. */
async function reply(ctx, id) {
  const s = auth.requireUser(ctx);
  const staff = s.user.role === 'platform_admin';
  const body = String(ctx.body?.body ?? '').trim();
  if (!body) throw bad('EMPTY', 'Write something first.');

  const internal = staff && ctx.body?.internal === true;

  const { rows: t } = await query(
    `SELECT * FROM tickets WHERE id = $1 ${staff ? '' : 'AND org_id = $2'}`,
    staff ? [id] : [id, s.org.id]);
  if (!t.length) throw new HttpError(404, 'NOT_FOUND', 'No such ticket.');

  await query(
    `INSERT INTO ticket_messages (ticket_id, org_id, user_id, author, from_staff,
                                  internal, body)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, t[0].org_id, s.user.id, s.user.name ?? '', staff, internal, body]);

  /*
   * An internal note changes nothing the customer can see, including the
   * status. Marking a ticket "with us" because somebody left themselves a note
   * would make the queue lie.
   */
  if (!internal) {
    await query(
      `UPDATE tickets
          SET status = CASE WHEN status IN ('resolved','closed') THEN 'open'
                            WHEN $2 THEN 'waiting_on_you' ELSE 'waiting_on_us' END,
              first_reply_at = COALESCE(first_reply_at, CASE WHEN $2 THEN now() END),
              updated_at = now()
        WHERE id = $1 AND org_id = $3`, [id, staff, t[0].org_id]);
  }

  return { ok: true, internal };
}

/** Close it, or reopen it. */
async function setStatus(ctx, id) {
  const s = auth.requireUser(ctx);
  const staff = s.user.role === 'platform_admin';
  const status = String(ctx.body?.status ?? '');

  const allowed = staff
    ? ['open', 'waiting_on_us', 'waiting_on_you', 'resolved', 'closed']
    // A customer can close their own ticket or reopen it; they cannot mark it
    // resolved on our behalf, which would hide it from the queue.
    : ['open', 'closed'];
  if (!allowed.includes(status)) {
    throw bad('BAD_STATUS', 'That is not a status you can set.');
  }

  const { rows } = await query(
    `UPDATE tickets SET status = $2, updated_at = now(),
            resolved_at = CASE WHEN $2 IN ('resolved','closed') THEN now() ELSE NULL END
      WHERE id = $1 ${staff ? '' : 'AND org_id = $3'} RETURNING *`,
    staff ? [id, status] : [id, status, s.org.id]);
  if (!rows.length) throw new HttpError(404, 'NOT_FOUND', 'No such ticket.');

  return { ok: true, status };
}

/** How did we do? Asked once, at the end. */
async function rate(ctx, id) {
  const s = auth.requireUser(ctx);
  const rating = Number(ctx.body?.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw bad('BAD_RATING', 'Rate it from 1 to 5.');
  }

  const { rows } = await query(
    `UPDATE tickets SET rating = $2, rating_note = $3
      WHERE id = $1 AND org_id = $4 AND rating IS NULL RETURNING number`,
    [id, rating, String(ctx.body?.note ?? '').slice(0, 500), s.org.id]);
  if (!rows.length) {
    throw new HttpError(404, 'NOT_FOUND', 'No such ticket, or it is already rated.');
  }
  return { ok: true, message: 'Thank you — that goes straight to the person who helped.' };
}

/** The operator's queue. */
async function queue(ctx) {
  auth.requireAdmin(ctx);

  const { rows } = await query(`
    -- tenant-global: the support queue spans every customer by design, behind
    -- requireAdmin, and is the one screen where that is the point.
    SELECT t.*, o.name AS org_name, o.plan,
           (SELECT count(*) FROM ticket_messages m
             WHERE m.ticket_id = t.id AND NOT m.internal)::int AS messages
      FROM tickets t JOIN orgs o ON o.id = t.org_id
     WHERE t.status IN ('open', 'waiting_on_us', 'waiting_on_you')
     ORDER BY
       -- Urgent first, then oldest. A queue sorted only by age lets a stopped
       -- business wait behind a feature request.
       CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1
                       WHEN 'normal' THEN 2 ELSE 3 END,
       t.created_at
     LIMIT 200`);

  const { rows: stats } = await query(`
    -- tenant-global: operator support statistics.
    SELECT count(*) FILTER (WHERE status IN ('open','waiting_on_us'))::int AS open,
           count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS new_7d,
           count(*) FILTER (WHERE resolved_at > now() - interval '7 days')::int AS closed_7d,
           COALESCE(avg(EXTRACT(EPOCH FROM (first_reply_at - created_at)) / 3600)
             FILTER (WHERE first_reply_at IS NOT NULL
                       AND created_at > now() - interval '30 days'), 0)::numeric
             AS avg_first_reply_hours,
           COALESCE(avg(rating) FILTER (WHERE rating IS NOT NULL), 0)::numeric AS rating
      FROM tickets`);

  return {
    tickets: rows.map((t) => ({
      ...ticketOut(t),
      account: t.org_name,
      plan: t.plan,
      // How long it has been waiting, which is the number that decides what to
      // pick up next.
      ageHours: Math.round((Date.now() - new Date(t.created_at)) / 3600000),
      target: (RESPONSE_HOURS[t.plan] ?? RESPONSE_HOURS.trial)[t.priority],
      breached: !t.first_reply_at
        && (Date.now() - new Date(t.created_at)) / 3600000
           > (RESPONSE_HOURS[t.plan] ?? RESPONSE_HOURS.trial)[t.priority],
    })),
    stats: {
      open: stats[0].open,
      new7d: stats[0].new_7d,
      closed7d: stats[0].closed_7d,
      averageFirstReplyHours: Math.round(Number(stats[0].avg_first_reply_hours) * 10) / 10,
      averageRating: Math.round(Number(stats[0].rating) * 10) / 10,
    },
  };
}

/*
 * Attachments, stored inline like backups.
 *
 * A screenshot of a Tally error is the single most useful thing a customer can
 * send, and making them find a file host to do it means they send a description
 * instead - which costs two more round trips.
 */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_FILES_PER_TICKET = 10;

/*
 * A narrow allowlist, not a blocklist.
 *
 * These files are handed back to a browser, and a blocklist is one missing
 * entry away from serving somebody's SVG - which is a script - from our own
 * origin. Images and PDFs cover every real support attachment.
 */
const ALLOWED = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
};

/** Attach a file to a ticket. */
async function attach(ctx, id) {
  const s = auth.requireUser(ctx);

  const { rows: t } = await query(
    'SELECT id, org_id FROM tickets WHERE id = $1 AND org_id = $2', [id, s.org.id]);
  if (!t.length) throw new HttpError(404, 'NOT_FOUND', 'No such ticket.');

  const contentType = String(ctx.body?.contentType ?? '').toLowerCase().split(';')[0].trim();
  if (!ALLOWED[contentType]) {
    throw bad('BAD_TYPE',
      'Send a screenshot (PNG or JPEG), a PDF, or a text file. '
      + 'Other kinds are not accepted.');
  }

  const b64 = String(ctx.body?.data ?? '');
  const data = Buffer.from(b64.replace(/^data:[^,]*,/, ''), 'base64');
  if (!data.length) throw bad('EMPTY', 'That file is empty.');
  if (data.length > MAX_FILE_BYTES) {
    throw bad('TOO_BIG',
      `That file is ${(data.length / 1048576).toFixed(1)}MB. The limit is 5MB — `
      + 'a screenshot is usually well under that.');
  }

  const { rows: count } = await query(
    'SELECT count(*)::int AS n FROM ticket_files WHERE ticket_id = $1 AND org_id = $2',
    [id, s.org.id]);
  if (count[0].n >= MAX_FILES_PER_TICKET) {
    throw bad('TOO_MANY', `A ticket can hold ${MAX_FILES_PER_TICKET} files.`);
  }

  /*
   * The name is rebuilt from the declared type rather than trusted.
   *
   * A filename arrives from the client and ends up in a Content-Disposition
   * header; "report.pdf\r\nX-Evil: 1" is the whole attack. Stripping to a safe
   * set and re-appending our own extension removes the class rather than one
   * instance of it.
   */
  const stem = String(ctx.body?.filename ?? 'attachment')
    .replace(/\.[^.]*$/, '')
    .replace(/[^A-Za-z0-9 _-]/g, '')
    .slice(0, 60) || 'attachment';
  const filename = `${stem}.${ALLOWED[contentType]}`;

  const { rows } = await query(
    `INSERT INTO ticket_files (ticket_id, org_id, filename, content_type, size_bytes,
                               data, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, filename, size_bytes, at`,
    [id, s.org.id, filename, contentType, data.length, data, s.user.id]);

  return { file: rows[0] };
}

/** Hand one back. */
async function file(ctx, ticketId, fileId) {
  const s = auth.requireUser(ctx);
  const staff = s.user.role === 'platform_admin';

  const { rows } = await query(
    `SELECT f.* FROM ticket_files f
      WHERE f.id = $1 AND f.ticket_id = $2 ${staff ? '' : 'AND f.org_id = $3'}`,
    staff ? [fileId, ticketId] : [fileId, ticketId, s.org.id]);
  if (!rows.length) throw new HttpError(404, 'NOT_FOUND', 'No such file.');

  return {
    _raw: {
      body: rows[0].data,
      contentType: rows[0].content_type,
      headers: {
        /*
         * attachment, never inline, and nosniff.
         *
         * Inline would render a customer-supplied file in our own origin, which
         * turns any HTML-ish upload into a script running as them. Downloading
         * it cannot.
         */
        'Content-Disposition':
          `attachment; filename="${rows[0].filename}"`,
        'X-Content-Type-Options': 'nosniff',
      },
    },
  };
}

module.exports = {
  help, createTicket, listTickets, ticket, reply, setStatus, rate, queue, attach, file,
  troubleshoot, collectDiagnostics, CATEGORIES, PRIORITIES, RESPONSE_HOURS, FAQ,
};
