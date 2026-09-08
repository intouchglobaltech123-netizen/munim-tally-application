'use strict';
const { query } = require('../db');

/**
 * Writing down who did what.
 *
 * One helper, used everywhere, because an audit log assembled differently in
 * each module is one where half the entries are missing a field and nobody
 * notices until it is needed.
 *
 * Two rules hold throughout:
 *
 *   1. It never throws. An audit entry is a record OF something that already
 *      happened; failing to write it must not undo the thing it describes.
 *   2. It records the actor's name and address as text, not only as a foreign
 *      key. A trail whose entries turn anonymous when somebody leaves the
 *      company is exactly the wrong way round.
 */

/**
 * What a person did, in words.
 *
 * Kept beside the code that raises them so the two cannot drift, and phrased
 * as a completed action because that is what a log line is.
 */
const ACTIONS = {
  'auth.google': { label: 'Signed in', entity: 'session' },
  'auth.signout': { label: 'Signed out', entity: 'session' },
  'auth.device.revoked': { label: 'Signed a device out', entity: 'device' },

  'user.invite': { label: 'Invited someone', entity: 'user' },
  'user.update': { label: 'Changed a person\'s details', entity: 'user' },
  'user.disable': { label: 'Disabled a person', entity: 'user' },
  'user.enable': { label: 'Enabled a person', entity: 'user' },
  'user.delete': { label: 'Removed a person', entity: 'user' },
  'user.companies': { label: 'Changed which books a person sees', entity: 'user' },

  'role.create': { label: 'Created a role', entity: 'role' },
  'role.update': { label: 'Changed what a role can do', entity: 'role' },
  'role.delete': { label: 'Deleted a role', entity: 'role' },

  'company.settings': { label: 'Changed company settings', entity: 'company' },
  'company.template': { label: 'Changed the document design', entity: 'company' },
  'company.remove': { label: 'Removed a book from Munim', entity: 'company' },
  'company.regroup': { label: 'Changed which business a book belongs to', entity: 'company' },

  'sync.request': { label: 'Asked the connector to sync', entity: 'connector' },
  'sync.settings': { label: 'Changed sync settings', entity: 'connector' },
  'sync.reconcile.delete': { label: 'Removed records Tally no longer has', entity: 'company' },

  /*
   * Changes that happened in Tally, not in Munim.
   *
   * Munim never writes to Tally, so nobody "does" these through the app - they
   * are noticed during sync. They are here because the app otherwise shows only
   * the latest state of a voucher, and a voucher quietly edited or deleted
   * weeks after it was entered is exactly what an owner needs to see.
   *
   * Ordinary same-day entry is not recorded: the voucher itself is already on
   * screen, and logging every one would bury the three entries that matter
   * under ten thousand that do not.
   */
  'voucher.changed': { label: 'A voucher was changed in Tally', entity: 'voucher' },
  'voucher.deleted': { label: 'A voucher was deleted in Tally', entity: 'voucher' },
  'voucher.backdated': { label: 'A back-dated voucher was entered in Tally', entity: 'voucher' },

  'backup.create': { label: 'Took a backup', entity: 'backup' },
  'backup.restore': { label: 'Restored a backup', entity: 'backup' },
  'backup.settings': { label: 'Changed backup settings', entity: 'backup' },

  'share.sent': { label: 'Shared a document', entity: 'document' },
  'reminder.sent': { label: 'Chased a payment', entity: 'party' },
  'export.csv': { label: 'Exported a report', entity: 'report' },
  'doc.download': { label: 'Downloaded a document', entity: 'document' },

  'security.applock': { label: 'Changed the app lock', entity: 'security' },
  'security.recovery': { label: 'Changed the recovery contact', entity: 'security' },

  'billing.subscribe': { label: 'Changed the plan', entity: 'billing' },
  'billing.downgrade': { label: 'Scheduled a downgrade', entity: 'billing' },
  'billing.cancel': { label: 'Cancelled the subscription', entity: 'billing' },
  'billing.resume': { label: 'Restarted the subscription', entity: 'billing' },
  'billing.details': { label: 'Changed the billing details', entity: 'billing' },

  /*
   * Writing into Tally. Recorded harder than anything else in this file: these
   * are the only actions in Munim that change a customer's actual books.
   */
  'entry.draft': { label: 'Created a voucher in Munim', entity: 'voucher' },
  'entry.sent': { label: 'Sent a voucher to Tally', entity: 'voucher' },
  'entry.cancelled': { label: 'Withdrew a voucher before it was sent', entity: 'voucher' },
  'entry.writes': { label: 'Changed whether Munim may write to Tally', entity: 'settings' },

  'support.ticket': { label: 'Raised a support ticket', entity: 'ticket' },

  'partner.update': { label: 'Changed a partner', entity: 'partner' },
  'partner.payout': { label: 'Paid a partner', entity: 'partner' },

  'api.key.create': { label: 'Created an API key', entity: 'apikey' },
  'api.key.revoke': { label: 'Revoked an API key', entity: 'apikey' },
  'api.webhook.create': { label: 'Added a webhook', entity: 'webhook' },
  'api.webhook.update': { label: 'Changed a webhook', entity: 'webhook' },
  'api.webhook.delete': { label: 'Removed a webhook', entity: 'webhook' },

  'account.delete.request': { label: 'Asked for the account to be deleted', entity: 'account' },
  'account.delete.cancel': { label: 'Called off the account deletion', entity: 'account' },
  'account.export': { label: 'Exported everything in the account', entity: 'account' },
  'owner.transfer.offer': { label: 'Offered the business to somebody else', entity: 'account' },
  'owner.transfer.accept': { label: 'Took over the business', entity: 'account' },
  'owner.transfer.decline': { label: 'Declined the business', entity: 'account' },
  'owner.transfer.cancel': { label: 'Called off the handover', entity: 'account' },
  'notify.rule': { label: 'Changed a notification rule', entity: 'settings' },
};

/** The /24 only. Same rule as the sign-in log: enough, and no more. */
function ipPrefix(ctx) {
  const raw = String(
    ctx?.req?.headers?.['x-forwarded-for']?.split(',')[0]
    ?? ctx?.req?.socket?.remoteAddress ?? '').trim();
  if (!raw) return '';
  const v4 = raw.replace(/^::ffff:/, '');
  const parts = v4.split('.');
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  const g = v4.split(':').filter(Boolean);
  return g.length >= 4 ? `${g.slice(0, 4).join(':')}::/64` : '';
}

/**
 * Only what actually differed.
 *
 * A settings save that touched one checkbox should read as one line. Storing
 * the whole record twice makes the log expensive to keep and impossible to
 * skim, which is the same as not keeping one.
 */
/*
 * A date column, as YYYY-MM-DD.
 *
 * pg hands a DATE back as a JS Date at local midnight, and String() on that is
 * "Fri Jan 10 2026 ...". Slicing ten characters off it yields "Fri Jan 10",
 * which never equals the "2026-01-10" arriving from the connector - so every
 * re-sent voucher would look changed and the audit log would fill with noise.
 * toISOString() is not the fix either: it converts to UTC, and in IST that
 * moves a local midnight back to the previous day.
 */
function dateOnly(v) {
  if (!v) return '';
  if (typeof v === 'string') return v.slice(0, 10);
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function diff(before, after) {
  if (!before || !after) return { before: before ?? null, after: after ?? null };
  const b = {};
  const a = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const was = before[key];
    const now = after[key];
    if (JSON.stringify(was) === JSON.stringify(now)) continue;
    b[key] = was ?? null;
    a[key] = now ?? null;
  }
  return Object.keys(a).length ? { before: b, after: a } : { before: null, after: null };
}

/** Write one entry. Never throws. */
/**
 * Write one entry.
 *
 * `session` is an override for the one moment ctx.session does not exist yet:
 * signing in. Everywhere else it is left alone and the caller's session is used.
 */
async function record(ctx, action, {
  companyId = null, entityId = '', entityName = '', before = null, after = null, meta = {},
  session = null,
} = {}) {
  try {
    const s = session ?? ctx?.session;
    const def = ACTIONS[action] ?? { entity: '' };
    const changes = diff(before, after);

    await query(
      `INSERT INTO audit_log (org_id, user_id, company_id, action, meta,
                              actor_name, actor_email, ip_prefix, device,
                              entity, entity_id, entity_name, before_val, after_val)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb)`,
      [s?.org?.id ?? null, s?.user?.id ?? null, companyId, action,
       JSON.stringify(meta ?? {}),
       s?.user?.name ?? '', s?.user?.email ?? '',
       ipPrefix(ctx),
       String(ctx?.req?.headers?.['x-munim-device'] ?? '').slice(0, 80),
       def.entity, String(entityId).slice(0, 80), String(entityName).slice(0, 120),
       changes.before ? JSON.stringify(changes.before) : null,
       changes.after ? JSON.stringify(changes.after) : null]);
  } catch (e) {
    // An audit entry is a record OF something that already happened. Failing
    // to write it must not undo the thing it describes.
    console.warn(`  could not write audit entry ${action}:`, e.message);
  }
}

module.exports = { record, diff, ipPrefix, dateOnly, ACTIONS };
