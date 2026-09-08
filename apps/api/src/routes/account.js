'use strict';
const { query, tx } = require('../db');
const auth = require('../lib/auth');
const perms = require('../lib/permissions');
const audit = require('../lib/audit');
const secrets = require('../lib/secrets');
const { HttpError, bad } = require('../lib/http');

/**
 * The end of the relationship, and the way back into it.
 *
 * Two features that look unrelated and are the same one: what happens when the
 * person holding the account is no longer the person who should hold it. A shop
 * changes hands, an owner dies, a partnership splits, somebody taps delete in
 * anger on a Friday evening. None of those are rare over the life of a business
 * and all of them end with a customer on the phone asking for their books.
 */

/*
 * Thirty days, and the reason is not "everyone does thirty days".
 *
 * A month covers the realistic discovery window: an owner away for a wedding, a
 * seasonal shop shut for a festival, an accountant who only looks at the books
 * at month end. It is also long enough that a malicious deletion by somebody
 * with a borrowed phone is noticed by the real owner before it completes.
 */
const GRACE_DAYS = 30;

/** How the account stands: pending deletion, recovery contact, who owns it. */
async function status(ctx) {
  const s = perms.require(auth.requireUser(ctx), 'settings', 'read');

  const { rows } = await query(
    `SELECT o.*, u.name AS requested_by_name
       FROM orgs o LEFT JOIN users u ON u.id = o.delete_requested_by
      WHERE o.id = $1`, [s.org.id]);
  const org = rows[0];

  const { rows: owners } = await query(
    `SELECT id, name, email, last_seen_at FROM users
      WHERE org_id = $1 AND role = 'owner' AND status <> 'disabled'
      ORDER BY created_at`, [s.org.id]);

  const { rows: pending } = await query(
    `SELECT t.*, f.name AS from_name, t2.name AS to_name, t2.email AS to_email
       FROM owner_transfers t
       LEFT JOIN users f  ON f.id  = t.from_user_id
       LEFT JOIN users t2 ON t2.id = t.to_user_id
      WHERE t.org_id = $1 AND t.status = 'pending'`, [s.org.id]);

  const days = org.delete_due_at
    ? Math.max(0, Math.ceil((new Date(org.delete_due_at) - Date.now()) / 86400000))
    : null;

  return {
    deletion: org.delete_requested_at ? {
      requestedAt: org.delete_requested_at,
      requestedBy: org.requested_by_name ?? 'Somebody who has since been removed',
      dueAt: org.delete_due_at,
      daysLeft: days,
      reason: org.delete_reason,
      note: `Everything is still here. Nothing is deleted until ${
        new Date(org.delete_due_at).toDateString()}, and anybody who owns this `
        + 'account can call it off before then.',
    } : null,

    recovery: {
      email: org.recovery_email,
      phone: org.recovery_phone,
      setAt: org.recovery_set_at,
      /*
       * Said plainly because it is the part people get wrong: a recovery
       * contact is not a second login. Somebody who reads that address cannot
       * sign in with it.
       */
      note: org.recovery_email || org.recovery_phone
        ? 'Used to warn you if somebody asks to delete this account, and to '
          + 'get you back in if you lose access. It cannot be used to sign in.'
        : 'Nothing set. If you lose access to your Google account there is no '
          + 'other way for us to know who you are.',
    },

    owners: owners.map((o) => ({
      id: o.id, name: o.name, email: o.email, lastSeenAt: o.last_seen_at,
    })),
    /*
     * A business with one owner is one lost phone away from nobody being able
     * to add a user, change a setting, or close the account. Flagged rather
     * than forced: it is the customer's business, not ours.
     */
    soleOwner: owners.length === 1,
    soleOwnerWarning: owners.length === 1
      ? 'Only one person owns this account. If they lose access, nobody else '
        + 'can add users or change settings. Consider making a second owner.'
      : '',

    transfer: pending.length ? {
      id: pending[0].id,
      to: pending[0].to_name || pending[0].to_email,
      from: pending[0].from_name ?? '',
      expiresAt: pending[0].expires_at,
    } : null,

    encryptionAtRest: secrets.enabled(),
  };
}

/** A second address for when the first one stops working. */
async function setRecovery(ctx) {
  const s = perms.require(auth.requireUser(ctx), 'settings', 'update');
  requireOwner(s, 'set the recovery contact');

  const email = String(ctx.body?.email ?? '').trim().toLowerCase();
  const phone = String(ctx.body?.phone ?? '').replace(/[^\d+]/g, '');

  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw bad('BAD_EMAIL', 'That does not look like an email address.');
  }
  if (phone && !/^\+?\d{10,15}$/.test(phone)) {
    throw bad('BAD_PHONE', 'That does not look like a phone number.');
  }

  /*
   * The recovery address must not be the address that already signs in.
   *
   * Losing that Google account is the single most likely reason to need
   * recovery, and a recovery contact that fails at exactly the moment it is
   * needed is worse than none: it is a promise the product does not keep.
   */
  const { rows: mine } = await query(
    `SELECT 1 FROM users WHERE org_id = $1 AND lower(email) = $2 LIMIT 1`,
    [s.org.id, email]);
  if (email && mine.length) {
    throw bad('SAME_ADDRESS',
      'Use a different address to the one you sign in with. If you lose access '
      + 'to that Google account, a recovery address on the same account cannot '
      + 'help you.');
  }

  const { rows: before } = await query(
    'SELECT recovery_email, recovery_phone FROM orgs WHERE id = $1', [s.org.id]);

  await query(
    `UPDATE orgs SET recovery_email = $2, recovery_phone = $3,
                     recovery_set_at = CASE WHEN $2 = '' AND $3 = '' THEN NULL ELSE now() END
      WHERE id = $1`, [s.org.id, email, phone]);

  await audit.record(ctx, 'security.recovery', {
    before: { email: before[0].recovery_email, phone: before[0].recovery_phone },
    after: { email, phone },
  });

  return {
    ok: true,
    message: email || phone
      ? 'Saved. We will use this if somebody asks to delete this account.'
      : 'Recovery contact removed.',
  };
}

/**
 * Ask for the account to be deleted.
 *
 * Scheduled, never immediate. See GRACE_DAYS for why.
 */
async function requestDelete(ctx) {
  const s = perms.require(auth.requireUser(ctx), 'settings', 'delete');
  requireOwner(s, 'delete this account');

  const { rows } = await query(
    'SELECT delete_due_at, recovery_email FROM orgs WHERE id = $1', [s.org.id]);
  if (rows[0].delete_due_at) {
    throw bad('ALREADY_REQUESTED', 'This account is already scheduled for deletion.');
  }

  /*
   * Typing the business name is not decoration.
   *
   * This is the one action in Munim that destroys a customer's books, and the
   * gap between "I meant to delete a company" and "I deleted the account" is
   * one tap otherwise.
   */
  const { rows: org } = await query('SELECT name FROM orgs WHERE id = $1', [s.org.id]);
  const typed = String(ctx.body?.confirm ?? '').trim();
  if (typed.toLowerCase() !== String(org[0].name ?? '').trim().toLowerCase()) {
    throw bad('CONFIRM_NAME',
      `Type the business name exactly — "${org[0].name}" — to confirm.`);
  }

  const due = new Date(Date.now() + GRACE_DAYS * 86400000);
  await query(
    `UPDATE orgs SET delete_requested_at = now(), delete_requested_by = $2,
                     delete_due_at = $3, delete_reason = $4
      WHERE id = $1`,
    [s.org.id, s.user.id, due, String(ctx.body?.reason ?? '').slice(0, 500)]);

  await audit.record(ctx, 'account.delete.request', {
    entityName: org[0].name,
    after: { dueAt: due.toISOString(), reason: String(ctx.body?.reason ?? '').slice(0, 200) },
  });

  return {
    dueAt: due,
    daysLeft: GRACE_DAYS,
    /*
     * The export is offered here rather than left for the customer to find.
     * Somebody closing an account is exactly the person who most needs a copy
     * of their data, and after the due date it does not exist to offer.
     */
    note: `Nothing is deleted yet. Everything stays until ${due.toDateString()}, `
        + `${GRACE_DAYS} days from now, and any owner can call this off before `
        + 'then. Download an export before that date — afterwards there is '
        + 'nothing left to export.',
    recoveryNotified: rows[0].recovery_email || null,
  };
}

/** Call it off. */
async function cancelDelete(ctx) {
  const s = perms.require(auth.requireUser(ctx), 'settings', 'delete');
  requireOwner(s, 'cancel the deletion');

  const { rowCount } = await query(
    `UPDATE orgs SET delete_requested_at = NULL, delete_requested_by = NULL,
                     delete_due_at = NULL, delete_reason = ''
      WHERE id = $1 AND delete_due_at IS NOT NULL`, [s.org.id]);
  if (!rowCount) throw bad('NOT_SCHEDULED', 'This account is not scheduled for deletion.');

  await audit.record(ctx, 'account.delete.cancel', {});
  return { ok: true, message: 'Deletion called off. Nothing was removed.' };
}

/**
 * Everything Munim holds, in one file.
 *
 * Separate from a backup, which is per company and meant for restoring. This is
 * the whole account - every company, every person, the settings, the audit log -
 * and it exists so that closing an account is never the same as losing the data.
 */
async function exportAll(ctx) {
  const s = perms.require(auth.requireUser(ctx), 'settings', 'export');
  requireOwner(s, 'export the whole account');

  const one = async (sql, args) => (await query(sql, args)).rows;

  const companies = await one(
    'SELECT * FROM companies WHERE org_id = $1 ORDER BY name', [s.org.id]);
  const ids = companies.map((c) => c.id);

  const perCompany = {};
  for (const c of companies) {
    perCompany[c.tally_guid] = {
      ledgers: await one('SELECT * FROM ledgers WHERE company_id = $1', [c.id]),
      groups: await one('SELECT * FROM groups WHERE company_id = $1', [c.id]),
      stockItems: await one('SELECT * FROM stock_items WHERE company_id = $1', [c.id]),
      vouchers: await one('SELECT * FROM vouchers WHERE company_id = $1', [c.id]),
      entries: ids.length ? await one(
        `SELECT e.* FROM voucher_entries e
           JOIN vouchers v ON v.id = e.voucher_id WHERE v.company_id = $1`, [c.id]) : [],
      items: await one(
        `SELECT i.* FROM voucher_items i
           JOIN vouchers v ON v.id = i.voucher_id WHERE v.company_id = $1`, [c.id]),
      bills: await one('SELECT * FROM bills WHERE company_id = $1', [c.id]),
    };
  }

  const archive = {
    format: 'munim-account-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    org: (await one(
      `SELECT id, name, plan, created_at, features FROM orgs WHERE id = $1`, [s.org.id]))[0],
    // Never the token hashes, and never anything that could sign somebody in.
    people: await one(
      `SELECT id, name, email, phone, role, branch, status, created_at
         FROM users WHERE org_id = $1`, [s.org.id]),
    roles: await one('SELECT * FROM roles WHERE org_id = $1', [s.org.id]),
    companies,
    data: perCompany,
    auditLog: await one(
      `SELECT action, actor_name, entity, entity_name, at FROM audit_log
        WHERE org_id = $1 ORDER BY at DESC LIMIT 5000`, [s.org.id]),
  };

  await audit.record(ctx, 'account.export', {
    meta: { companies: companies.length, people: archive.people.length },
  });

  return {
    filename: `munim_account_${String(archive.org.name || 'export')
      .replace(/[^a-zA-Z0-9]+/g, '-')}_${new Date().toISOString().slice(0, 10)}.json`,
    archive: JSON.stringify(archive, null, 2),
    note: 'Everything Munim holds for this account. Your Tally data files are '
        + 'separate and untouched.',
  };
}

// --- handing the business over ---------------------------------------------

const TRANSFER_DAYS = 7;

/**
 * Offer the business to somebody else.
 *
 * Two-step, with the other person having to accept. A one-step transfer would
 * let an owner hand the account to a colleague who does not want it, or - worse
 * - to somebody who has since left, leaving nobody able to accept.
 */
async function offerTransfer(ctx) {
  const s = perms.require(auth.requireUser(ctx), 'users', 'update');
  requireOwner(s, 'hand this business over');

  const toId = String(ctx.body?.userId ?? '');
  if (toId === s.user.id) throw bad('SELF', 'You already own this account.');

  const { rows: to } = await query(
    `SELECT id, name, email, status FROM users WHERE id = $1 AND org_id = $2`,
    [toId, s.org.id]);
  if (!to.length) throw new HttpError(404, 'NOT_FOUND', 'No such person in this account.');
  if (to[0].status === 'disabled') {
    throw bad('DISABLED', 'That person is disabled. Enable them first.');
  }

  const expires = new Date(Date.now() + TRANSFER_DAYS * 86400000);
  let row;
  try {
    ({ rows: [row] } = await query(
      `INSERT INTO owner_transfers (org_id, from_user_id, to_user_id, expires_at)
       VALUES ($1,$2,$3,$4) RETURNING *`, [s.org.id, s.user.id, toId, expires]));
  } catch (e) {
    // The partial unique index. Two racing offers could otherwise both be
    // accepted, and the second would silently demote the first new owner.
    if (e.code === '23505') {
      throw bad('ALREADY_OFFERED', 'There is already an offer waiting to be accepted.');
    }
    throw e;
  }

  await audit.record(ctx, 'owner.transfer.offer', {
    entityId: toId, entityName: to[0].name || to[0].email,
    after: { expiresAt: expires.toISOString() },
  });

  return {
    id: row.id,
    to: to[0].name || to[0].email,
    expiresAt: expires,
    message: `${to[0].name || to[0].email} has to accept before anything changes. `
           + `The offer lapses in ${TRANSFER_DAYS} days.`,
  };
}

/** Accept, decline, or call it off. */
async function settleTransfer(ctx, id, action) {
  const s = auth.requireUser(ctx);

  const { rows } = await query(
    `SELECT * FROM owner_transfers WHERE id = $1 AND org_id = $2 AND status = 'pending'`,
    [id, s.org.id]);
  if (!rows.length) throw new HttpError(404, 'NOT_FOUND', 'No offer waiting.');
  const t = rows[0];

  if (new Date(t.expires_at) < new Date()) {
    await query(`UPDATE owner_transfers SET status='expired', settled_at=now()
        WHERE id=$1 AND org_id=$2`, [id, s.org.id]);
    throw bad('EXPIRED', 'That offer has lapsed. Ask for a new one.');
  }

  if (action === 'cancel') {
    if (t.from_user_id !== s.user.id) {
      throw new HttpError(403, 'FORBIDDEN', 'Only the person who offered it can call it off.');
    }
    await query(`UPDATE owner_transfers SET status='cancelled', settled_at=now()
        WHERE id=$1 AND org_id=$2`, [id, s.org.id]);
    await audit.record(ctx, 'owner.transfer.cancel', { entityId: id });
    return { ok: true, message: 'Handover called off.' };
  }

  // Only the person being handed the business may answer for it.
  if (t.to_user_id !== s.user.id) {
    throw new HttpError(403, 'FORBIDDEN', 'This offer was not made to you.');
  }

  if (action === 'decline') {
    await query(`UPDATE owner_transfers SET status='declined', settled_at=now()
        WHERE id=$1 AND org_id=$2`, [id, s.org.id]);
    await audit.record(ctx, 'owner.transfer.decline', { entityId: id });
    return { ok: true, message: 'Declined. Nothing changed.' };
  }

  /*
   * Accepting makes the new person an owner. It deliberately does NOT demote
   * the old one.
   *
   * Handing over a business is usually a handover, not an ejection - the
   * previous owner stays on to help - and demoting them automatically is the
   * kind of surprise that ends with a support call from somebody locked out of
   * their own shop. Removing them is a separate, deliberate act.
   */
  return tx(async (c) => {
    await c.query(
      `UPDATE users SET role = 'owner', role_id = NULL WHERE id = $1`, [t.to_user_id]);
    await c.query(
      `UPDATE owner_transfers SET status='accepted', settled_at=now()
        WHERE id=$1 AND org_id=$2`, [id, s.org.id]);

    await audit.record(ctx, 'owner.transfer.accept', {
      entityId: id, after: { newOwner: s.user.name || s.user.email },
    });

    return {
      ok: true,
      message: 'You now own this account. The person who handed it over is still '
             + 'an owner too — remove them separately if that was the intention.',
    };
  });
}

/**
 * Owner-only, said in words rather than by a permission bit.
 *
 * These actions end or hand over the business itself. A custom role with the
 * settings permission is meant for somebody who configures the product, not
 * somebody who can close the company.
 */
function requireOwner(s, what) {
  if (s.user.role === 'owner' || s.user.role === 'platform_admin') return;
  throw new HttpError(403, 'OWNER_ONLY', `Only an owner can ${what}.`);
}

/**
 * Carry out deletions that have come due.
 *
 * Run on a schedule. Deliberately a plain function rather than a route: nothing
 * a customer does should be able to trigger the moment of destruction.
 */
async function runDueDeletions() {
  const { rows } = await query(
    `SELECT id, name FROM orgs WHERE delete_due_at IS NOT NULL AND delete_due_at <= now()`);

  for (const org of rows) {
    // Every table hangs off orgs by ON DELETE CASCADE, so this is the whole of
    // it - and the cascade is checked by a test, because a table added later
    // without one would leave a customer's data behind after they asked for it
    // to be gone.
    await query('DELETE FROM orgs WHERE id = $1', [org.id]);
    console.log(`  deleted account ${org.name} (${org.id}) — grace period expired`);
  }
  return { deleted: rows.length };
}

module.exports = {
  status, setRecovery, requestDelete, cancelDelete, exportAll,
  offerTransfer, settleTransfer, runDueDeletions, GRACE_DAYS, TRANSFER_DAYS,
};
