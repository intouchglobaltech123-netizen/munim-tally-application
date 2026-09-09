'use strict';
// Munim API.
//
// Node's http server plus Postgres. No framework: this surface is about twenty
// routes, and a framework would be more code than the thing it organises.
//
// Three audiences, three credentials, never interchangeable:
//   device token  -> connector      : ingest + heartbeat only
//   access token  -> customer app   : that org's data only
//   access token  -> platform_admin : cross-tenant, admin routes only

// Load apps/api/.env if present, so configuration is a file rather than a
// shell incantation everyone has to remember. Node has done this natively
// since 20.6 - no dotenv dependency.
try {
  const path = require('path');
  const fs = require('fs');
  const envFile = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envFile) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(envFile);
  }
} catch (e) {
  console.warn('  could not read .env:', e.message);
}

const http = require('http');
const { URL } = require('url');
const { migrate, pool, query } = require('./db');
const secrets = require('./lib/secrets');
const ratelimit = require('./lib/ratelimit');
const scheduler = require('./lib/scheduler');
const metrics = require('./lib/metrics');
const {
  send, fail, HttpError, readBody, json, bearer,
} = require('./lib/http');
const auth = require('./lib/auth');

const authRoutes = require('./routes/auth');
const connectors = require('./routes/connectors');
const ingest = require('./routes/ingest');
const reports = require('./routes/reports');
const misc = require('./routes/misc');
const statements = require('./routes/statements');
const vouchers = require('./routes/vouchers');
const devices = require('./routes/devices');
const installer = require('./routes/installer');
const licences = require('./routes/licences');
const insights = require('./routes/insights');
const company = require('./routes/company');
const sync = require('./routes/sync');
const security = require('./routes/security');
const users = require('./routes/users');
const perms = require('./lib/permissions');
const dash = require('./routes/dashboard');
const masters = require('./routes/masters');
const invoices = require('./routes/invoices');
const gst = require('./routes/gst');
const books = require('./routes/books');
const reminders = require('./routes/reminders');
const share = require('./routes/share');
const views = require('./routes/views');
const notifications = require('./routes/notifications');
const search = require('./routes/search');
const audit = require('./routes/audit');
const account = require('./routes/account');
const billing = require('./routes/billing');
const subscription = require('./routes/subscription');
const admin = require('./routes/admin');
const kpi = require('./routes/kpi');
const pulse = require('./routes/pulse');
const businesses = require('./routes/businesses');
const preferences = require('./routes/preferences');
const support = require('./routes/support');
const entry = require('./routes/entry');
const { ipPrefix } = require('./lib/audit');

const PORT = Number(process.env.PORT || 8080);

const routes = {
  'GET  /v1/health': async () => ({ ok: true, service: 'munim-api' }),

  'GET  /v1/auth/config': async () => authRoutes.authConfig(),
  'POST /v1/auth/google': authRoutes.googleSignIn,
  'POST /v1/auth/app-code': authRoutes.createAppCode,
  'POST /v1/auth/app-code/redeem': authRoutes.redeemAppCode,
  'GET  /v1/me': authRoutes.me,
  'POST /v1/onboarding': authRoutes.onboarding,
  'POST /v1/auth/logout': authRoutes.logout,

  'POST /v1/auth/intent': connectors.createIntent,
  'GET  /v1/auth/intent': connectors.pollIntent,
  'POST /v1/auth/intent/approve': connectors.approveIntent,
  'POST /v1/connectors/companies/discover': connectors.discover,
  'POST /v1/connectors/heartbeat': connectors.heartbeat,

  'POST /v1/ingest': ingest.ingest,

  // From the connector.
  'POST /v1/sync/run': sync.reportRun,
  'POST /v1/sync/logs': sync.uploadLogs,
  'POST /v1/sync/reconcile': sync.reconcile,
  'POST /v1/sync/command': sync.reportCommand,

  // For the apps.
  'GET  /v1/users': users.list,
  'POST /v1/users/invite': users.invite,
  'GET  /v1/roles': users.listRoles,
  'POST /v1/roles': users.createRole,

  'GET  /v1/security': security.status,
  'GET  /v1/security/logins': security.loginHistory,
  'POST /v1/security/app-lock': security.setAppLock,
  'POST /v1/security/app-lock/check': security.checkAppLock,

  'GET  /v1/sync/history': sync.history,
  'GET  /v1/sync/logs': sync.logs,
  'POST /v1/sync/request': sync.request,
  'PATCH /v1/sync/settings': sync.updateSettings,

  'GET  /v1/companies': reports.listCompanies,
  'GET  /v1/companies/all': company.list,
  'POST /v1/companies/sync': reports.setCompanySync,
  'GET  /v1/connectors': reports.listConnectors,
  /*
   * The old POST /v1/reminders/send recorded a reminder as "sent" and charged
   * a message credit while sending nothing at all. It is gone: the honest
   * shape is a worklist, and a record of what the owner handed to WhatsApp.
   */
  'GET  /v1/reminders': misc.listReminders,
  'GET  /v1/reminders/history': reminders.history,
  'GET  /v1/share/templates': share.templates,
  'GET  /v1/share/log': share.log,

  'GET  /v1/connector/outbox': entry.outbox,
  'PUT  /v1/settings/writes': entry.setWrites,

  'GET  /v1/help': support.help,
  'GET  /v1/tickets': support.listTickets,
  'POST /v1/tickets': support.createTicket,
  'GET  /v1/admin/support': support.queue,


  'GET  /v1/businesses': businesses.list,

  'GET  /v1/preferences': preferences.get,
  'PUT  /v1/preferences': preferences.set,
  'POST /v1/preferences/reset': preferences.reset,

  'GET  /v1/billing': subscription.overview,
  'GET  /v1/billing/usage': billing.overview,
  'GET  /v1/billing/preview': subscription.preview,
  'POST /v1/billing/subscribe': subscription.subscribe,
  'POST /v1/billing/cancel': subscription.cancel,
  'POST /v1/billing/resume': subscription.resume,
  'PUT  /v1/billing/details': subscription.setBilling,
  'GET  /v1/billing/invoices': subscription.invoices,
  'GET  /v1/pricing': billing.pricing,

  'GET  /v1/account': account.status,
  'PUT  /v1/account/recovery': account.setRecovery,
  'POST /v1/account/delete': account.requestDelete,
  'POST /v1/account/delete/cancel': account.cancelDelete,
  'GET  /v1/account/export': account.exportAll,
  'POST /v1/account/transfer': account.offerTransfer,

  'GET  /v1/audit': audit.list,
  'POST /v1/audit/event': audit.clientEvent,

  'GET  /v1/notifications': notifications.feed,
  'POST /v1/notifications/read': notifications.markRead,
  'GET  /v1/notifications/settings': notifications.settings,
  'POST /v1/notifications/rules': notifications.setRule,
  'PATCH /v1/notifications/mine': notifications.setMine,


  'GET  /v1/views': views.list,
  'POST /v1/views': views.create,
  'GET  /v1/reminders/config': reminders.listConfig,
  'POST /v1/reminders/templates': reminders.saveTemplate,

  'GET  /v1/devices': devices.list,
  'GET  /v1/connector/installer': installer.download,
  'GET  /v1/connector/install-command': installer.oneLiner,
  'POST /v1/devices/signins/revoke-others': devices.revokeOtherSignIns,

  'GET  /v1/admin/stats': misc.adminStats,
  'GET  /v1/admin/metrics': admin.overview,
  'GET  /v1/admin/metrics/business': admin.businessMetrics,
  'GET  /v1/admin/metrics/technical': admin.technicalMetrics,
  'GET  /v1/admin/metrics/features': admin.featureMetrics,
  'GET  /v1/admin/orgs': misc.adminOrgs,
  'GET  /v1/admin/connectors': misc.adminConnectors,
  'GET  /v1/admin/catalogue': misc.adminCatalogue,
  'GET  /v1/admin/licences': licences.list,
  'POST /v1/admin/licences': licences.issue,
  // Redeemed by the connector during setup, before it has any credential of
  // its own - the key in the body is what is being checked.
  'POST /v1/licence/redeem': licences.redeem,
};

// /v1/companies/:tallyGuid/<view>
const COMPANY_VIEW = new RegExp(
  '^/v1/companies/([^/]+)/(dashboard|outstanding|ledgers|statement|daybook|' +
  'trial-balance|pnl|balance-sheet|expenses|sales-analysis|purchase-analysis|' +
  'inactive|stock|party-wise|cash-bank|' +
  'ageing|projections|attention|top|trends|profile|summary|overview|filters|' +
  'parties|items|groups|numbering|gst|gst-hsn|gst-parties|gst-health|' +
  'cash-book|bank-book|group-summary|sales-register|purchase-register|due-soon|expiry|reminders|doc-template|notify-sweep|search|search-options|' +
  'kpi|kpi-sales|kpi-collection|kpi-purchases|kpi-inventory|kpi-profit|' +
  'entry-options|entries|' +
  'pulse|pulse-payers|pulse-movers|pulse-rhythm|pulse-runway)$');

// /v1/companies/:tallyGuid              (DELETE - remove Munim's copy)
// /v1/companies/:tallyGuid/settings     (PATCH)
const COMPANY_ONE = /^\/v1\/companies\/([^/]+)$/;
// A named master: /v1/companies/:guid/parties/:name  (and /items/:name)
const MASTER_ONE = /^\/v1\/companies\/([^/]+)\/(parties|items)\/(.+)$/;
const INVOICE_DOC = /^\/v1\/companies\/([^/]+)\/invoice\/([0-9a-f-]{36})$/;
const REMINDER_RECORD = /^\/v1\/companies\/([^/]+)\/reminders\/record$/;
const SHARE_PREVIEW = /^\/v1\/companies\/([^/]+)\/share$/;
const SHARE_RECORD = /^\/v1\/companies\/([^/]+)\/share\/record$/;
const SHARE_TEMPLATE = /^\/v1\/share\/templates\/([0-9a-f-]{36})$/;
const VIEW_ONE = /^\/v1\/views\/([0-9a-f-]{36})$/;
const AUDIT_ENTITY = /^\/v1\/audit\/([a-z]+)\/(.+)$/;
const BUSINESS_REGROUP = /^\/v1\/businesses\/companies\/(.+)$/;
const ENTRY_NEW = /^\/v1\/companies\/([^/]+)\/entries$/;
const ENTRY_ONE = /^\/v1\/entries\/([0-9a-f-]{36})(?:\/(send|cancel))?$/;
const OUTBOX_RESULT = /^\/v1\/connector\/outbox\/([0-9a-f-]{36})$/;
const TICKET_ONE = /^\/v1\/tickets\/([0-9a-f-]{36})(?:\/(reply|status|rate|files))?$/;
const TICKET_FILE = /^\/v1\/tickets\/([0-9a-f-]{36})\/files\/([0-9a-f-]{36})$/;
const BILLING_INVOICE = /^\/v1\/billing\/invoices\/([0-9a-f-]{36})$/;
const TRANSFER_ONE = /^\/v1\/account\/transfer\/([0-9a-f-]{36})\/(accept|decline|cancel)$/;
const REMINDER_OPTOUT = /^\/v1\/companies\/([^/]+)\/reminders\/party\/(.+)$/;
const REMINDER_RULE = /^\/v1\/reminders\/rules\/([0-9a-f-]{36})$/;
const REMINDER_TEMPLATE = /^\/v1\/reminders\/templates\/([0-9a-f-]{36})$/;
const PARTY_TAGS = /^\/v1\/companies\/([^/]+)\/parties\/(.+)\/tags$/;
const COMPANY_SETTINGS = /^\/v1\/companies\/([^/]+)\/settings$/;
const DOC_TEMPLATE = /^\/v1\/companies\/([^/]+)\/doc-template$/;

// /v1/devices/<connectors|signins>/:id  (DELETE)
const DEVICE_REVOKE = /^\/v1\/devices\/(connectors|signins)\/([^/]+)$/;
// Naming a device, or trusting it.
const DEVICE_UPDATE = /^\/v1\/devices\/signins\/([^/]+)$/;

// People and roles.
const USER_ONE = /^\/v1\/users\/([0-9a-f-]{36})$/;
const USER_STATUS = /^\/v1\/users\/([0-9a-f-]{36})\/status$/;
const USER_COMPANIES = /^\/v1\/users\/([0-9a-f-]{36})\/companies$/;
const INVITE_ONE = /^\/v1\/invites\/([0-9a-f-]{36})$/;
const ROLE_ONE = /^\/v1\/roles\/([0-9a-f-]{36})$/;

/*
 * Which permission each report needs.
 *
 * Kept beside the routing rather than inside each handler so that adding a
 * view without deciding who may see it is visible here as a missing entry -
 * and a missing entry denies, rather than quietly allowing.
 */
const VIEW_MODULE = {
  dashboard: 'dashboard',
  outstanding: 'outstanding',
  ledgers: 'ledgers',
  statement: 'ledgers',
  'party-wise': 'ledgers',
  daybook: 'reports',
  'trial-balance': 'reports',
  pnl: 'reports',
  'balance-sheet': 'reports',
  expenses: 'reports',
  'sales-analysis': 'sales',
  'purchase-analysis': 'purchase',
  inactive: 'insights',
  ageing: 'outstanding',
  projections: 'outstanding',
  attention: 'insights',
  top: 'insights',
  trends: 'insights',
  stock: 'inventory',
  'cash-bank': 'cashbank',
  profile: 'settings',
  summary: 'dashboard',
  overview: 'dashboard',
  filters: 'dashboard',
  parties: 'ledgers',
  items: 'inventory',
  groups: 'ledgers',
  numbering: 'sales',
  gst: 'reports',
  'gst-hsn': 'reports',
  'gst-parties': 'reports',
  'gst-health': 'reports',
  'cash-book': 'cashbank',
  'bank-book': 'cashbank',
  'group-summary': 'reports',
  'sales-register': 'sales',
  'purchase-register': 'purchase',
  'due-soon': 'outstanding',
  expiry: 'inventory',
  reminders: 'outstanding',
  'doc-template': 'settings',
  // The KPI set spans several modules, so each one is gated on the module its
  // own numbers come from rather than all of them on 'reports'.
  kpi: 'reports',
  'kpi-sales': 'sales',
  'kpi-collection': 'outstanding',
  'kpi-purchases': 'purchase',
  'kpi-inventory': 'inventory',
  'kpi-profit': 'reports',
  // The entry screens gate per voucher kind inside the handler, since one
  // screen creates sales, receipts and journals - three different modules.
  'entry-options': 'dashboard',
  entries: 'dashboard',
  pulse: 'insights',
  'pulse-payers': 'outstanding',
  'pulse-movers': 'insights',
  'pulse-rhythm': 'sales',
  'pulse-runway': 'cashbank',
  'notify-sweep': 'dashboard',
  // Search gates each kind of result for itself, so the route only needs a
  // signed-in caller.
  search: 'dashboard',
  'search-options': 'dashboard',
};

/** Which permission each transaction section needs. */
const SECTION_MODULE = {
  sales: 'sales', 'credit-note': 'sales',
  purchase: 'purchase', 'debit-note': 'purchase',
  receipt: 'cashbank', payment: 'cashbank', contra: 'cashbank',
  journal: 'reports', all: 'reports',
};

// The connector installer fetches its own script from here. Public by design:
// the single-use code in the path is the credential.
const INSTALL_SCRIPT = /^\/install\/([A-Za-z0-9_-]{6,64})$/;
const LICENCE_REVOKE = /^\/v1\/admin\/licences\/([0-9a-f-]{36})$/;
const ADMIN_ORG = /^\/v1\/admin\/orgs\/([0-9a-f-]{36})$/;

/*
 * Browsing transactions. One shape serves every section of the left-hand nav -
 * sales, purchase, receipts and the rest are the same screen with a filter.
 *
 *   /v1/companies/:guid/txn/:section          rolled up or listed
 *   /v1/companies/:guid/txn/:section/:id      one voucher in full
 *   /v1/companies/:guid/find                  one box that searches everything
 */
const TXN_LIST = new RegExp(
  '^/v1/companies/([^/]+)/txn/([a-z-]+)$');
const TXN_ONE = new RegExp(
  '^/v1/companies/([^/]+)/txn/([a-z-]+)/([0-9a-f-]{36})$');
const FIND = new RegExp('^/v1/companies/([^/]+)/find$');

const server = http.createServer(async (req, res) => {
  // The apps run on their own ports in development.
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Headers',
    'Content-Type,Authorization,Idempotency-Key,Content-Encoding');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, 'http://localhost');
  const started = Date.now();

  try {
    const raw = req.method === 'GET' ? Buffer.alloc(0) : await readBody(req);
    const token = bearer(req);

    // Resolve both credentials once. A route then asks for the one it needs;
    // a device token can never satisfy requireUser, and vice versa.
    const [session, connector] = await Promise.all([
      auth.sessionFor(token),
      auth.connectorFor(token),
    ]);

    // Parse the body lazily. Ingest sends NDJSON, not JSON - parsing eagerly
    // rejected every batch with BAD_JSON before the route ever ran.
    const ctx = {
      req, res, url, token, session, connector, raw,
      headers: req.headers,
      get body() {
        if (this._body === undefined) {
          this._body = req.method === 'GET' ? {} : json(raw);
        }
        return this._body;
      },
    };

    /*
     * Metered after the credentials are resolved, so a signed-in customer is
     * counted as themselves rather than as their office's shared IP address -
     * otherwise a twenty-person shop would share one bucket and the limiter
     * would punish exactly the customers who bought the most seats.
     */
    const limit = ratelimit.check(ctx, req.method, url.pathname);
    res.setHeader('X-RateLimit-Limit', String(limit.limit));
    if (!limit.ok) {
      // Retry-After is the whole value of a 429: without it a client can only
      // guess, and a client that guesses wrong retries into the same wall.
      res.setHeader('Retry-After', String(limit.retryAfter));
      throw new HttpError(429, 'RATE_LIMITED',
        limit.tier === 'heavy'
          ? 'That is a heavy request and it is being asked for too often. '
            + `Try again in ${limit.retryAfter} seconds.`
          : `Too many requests. Try again in ${limit.retryAfter} seconds.`);
    }
    res.setHeader('X-RateLimit-Remaining', String(limit.remaining));

    const install = url.pathname.match(INSTALL_SCRIPT);
    const view = url.pathname.match(COMPANY_VIEW);
    const revoke = url.pathname.match(DEVICE_REVOKE);
    const deviceUpdate = url.pathname.match(DEVICE_UPDATE);
    const userOne = url.pathname.match(USER_ONE);
    const userStatus = url.pathname.match(USER_STATUS);
    const userCompanies = url.pathname.match(USER_COMPANIES);
    const inviteOne = url.pathname.match(INVITE_ONE);
    const roleOne = url.pathname.match(ROLE_ONE);
    let result;

    const licRevoke = url.pathname.match(LICENCE_REVOKE);

    const adminOrg = url.pathname.match(ADMIN_ORG);
    const txnOne = url.pathname.match(TXN_ONE);
    const txnList = url.pathname.match(TXN_LIST);
    const find = url.pathname.match(FIND);
    const coOne = url.pathname.match(COMPANY_ONE);
    const coSettings = url.pathname.match(COMPANY_SETTINGS);
    const docTpl = url.pathname.match(DOC_TEMPLATE);
    const masterOne = url.pathname.match(MASTER_ONE);
    const invoiceDoc = url.pathname.match(INVOICE_DOC);
    const remRecord = url.pathname.match(REMINDER_RECORD);
    const sharePreview = url.pathname.match(SHARE_PREVIEW);
    const shareRecord = url.pathname.match(SHARE_RECORD);
    const shareTemplate = url.pathname.match(SHARE_TEMPLATE);
    const viewOne = url.pathname.match(VIEW_ONE);
    const auditEntity = url.pathname.match(AUDIT_ENTITY);
    const remOptOut = url.pathname.match(REMINDER_OPTOUT);
    const remRule = url.pathname.match(REMINDER_RULE);
    const remTemplate = url.pathname.match(REMINDER_TEMPLATE);
    const partyTags = url.pathname.match(PARTY_TAGS);

    const transferOne = url.pathname.match(TRANSFER_ONE);

    const billingInvoice = url.pathname.match(BILLING_INVOICE);

    const ticketOne = url.pathname.match(TICKET_ONE);

    const ticketFile = url.pathname.match(TICKET_FILE);
    const entryNew = url.pathname.match(ENTRY_NEW);
    const entryOne = url.pathname.match(ENTRY_ONE);
    const outboxResult = url.pathname.match(OUTBOX_RESULT);

    const bizRegroup = url.pathname.match(BUSINESS_REGROUP);

    if (bizRegroup && req.method === 'PUT') {
      result = await businesses.regroup(ctx, bizRegroup[1]);
    } else if (entryNew && req.method === 'POST') {
      result = await entry.create(ctx, decodeURIComponent(entryNew[1]));
    } else if (entryOne && !entryOne[2] && req.method === 'GET') {
      result = await entry.one(ctx, entryOne[1]);
    } else if (entryOne && !entryOne[2] && req.method === 'PATCH') {
      result = await entry.update(ctx, entryOne[1]);
    } else if (entryOne && entryOne[2] === 'send' && req.method === 'POST') {
      result = await entry.send(ctx, entryOne[1]);
    } else if (entryOne && entryOne[2] === 'cancel' && req.method === 'POST') {
      result = await entry.cancel(ctx, entryOne[1]);
    } else if (outboxResult && req.method === 'POST') {
      result = await entry.result(ctx, outboxResult[1]);
    } else if (ticketFile && req.method === 'GET') {
      result = await support.file(ctx, ticketFile[1], ticketFile[2]);
    } else if (ticketOne && ticketOne[2] === 'files' && req.method === 'POST') {
      result = await support.attach(ctx, ticketOne[1]);
    } else if (ticketOne && !ticketOne[2] && req.method === 'GET') {
      result = await support.ticket(ctx, ticketOne[1]);
    } else if (ticketOne && ticketOne[2] === 'reply' && req.method === 'POST') {
      result = await support.reply(ctx, ticketOne[1]);
    } else if (ticketOne && ticketOne[2] === 'status' && req.method === 'POST') {
      result = await support.setStatus(ctx, ticketOne[1]);
    } else if (ticketOne && ticketOne[2] === 'rate' && req.method === 'POST') {
      result = await support.rate(ctx, ticketOne[1]);
    } else if (billingInvoice && req.method === 'GET') {
      result = await subscription.invoice(ctx, billingInvoice[1]);
    } else if (transferOne && req.method === 'POST') {
      result = await account.settleTransfer(ctx, transferOne[1], transferOne[2]);
    } else if (auditEntity && req.method === 'GET') {
      result = await audit.forEntity(ctx, auditEntity[1], decodeURIComponent(auditEntity[2]));
    } else if (viewOne && req.method === 'PATCH') {
      result = await views.update(ctx, viewOne[1]);
    } else if (viewOne && req.method === 'DELETE') {
      result = await views.remove(ctx, viewOne[1]);
    } else if (shareRecord && req.method === 'POST') {
      result = await share.record(ctx, decodeURIComponent(shareRecord[1]));
    } else if (sharePreview && req.method === 'GET') {
      result = await share.preview(ctx, decodeURIComponent(sharePreview[1]));
    } else if (shareTemplate && req.method === 'PATCH') {
      result = await share.saveTemplate(ctx, shareTemplate[1]);
    } else if (remRecord && req.method === 'POST') {
      result = await reminders.record(ctx, decodeURIComponent(remRecord[1]));
    } else if (remOptOut && req.method === 'PUT') {
      result = await reminders.setOptOut(ctx, decodeURIComponent(remOptOut[1]),
        decodeURIComponent(remOptOut[2]));
    } else if (remRule && req.method === 'PATCH') {
      result = await reminders.saveRule(ctx, remRule[1]);
    } else if (remTemplate && req.method === 'PATCH') {
      result = await reminders.saveTemplate(ctx, remTemplate[1]);
    } else if (invoiceDoc && req.method === 'GET') {
      result = await invoices.document(ctx, decodeURIComponent(invoiceDoc[1]), invoiceDoc[2]);
    } else if (partyTags && req.method === 'PUT') {
      result = await masters.setTags(ctx, decodeURIComponent(partyTags[1]),
        decodeURIComponent(partyTags[2]));
    } else if (masterOne && req.method === 'GET') {
      const guid = decodeURIComponent(masterOne[1]);
      const name = decodeURIComponent(masterOne[3]);
      result = masterOne[2] === 'parties'
        ? await masters.party(ctx, guid, name)
        : await masters.item(ctx, guid, name);
    } else if (userStatus && req.method === 'POST') {
      result = await users.setStatus(ctx, userStatus[1]);
    } else if (userCompanies && req.method === 'PUT') {
      result = await users.setCompanies(ctx, userCompanies[1]);
    } else if (userOne && req.method === 'PATCH') {
      result = await users.update(ctx, userOne[1]);
    } else if (userOne && req.method === 'DELETE') {
      result = await users.remove(ctx, userOne[1]);
    } else if (inviteOne && req.method === 'DELETE') {
      result = await users.revokeInvite(ctx, inviteOne[1]);
    } else if (roleOne && req.method === 'PATCH') {
      result = await users.updateRole(ctx, roleOne[1]);
    } else if (roleOne && req.method === 'DELETE') {
      result = await users.deleteRole(ctx, roleOne[1]);
    } else if (docTpl && req.method === 'PATCH') {
      result = await company.updateDocTemplate(ctx, decodeURIComponent(docTpl[1]));
    } else if (coSettings && req.method === 'PATCH') {
      result = await company.updateSettings(ctx, decodeURIComponent(coSettings[1]));
    } else if (coOne && req.method === 'DELETE') {
      result = await company.remove(ctx, decodeURIComponent(coOne[1]));
    } else if (txnOne && req.method === 'GET') {
      if (ctx.session) perms.require(ctx.session, SECTION_MODULE[txnOne[2]] ?? 'reports', 'read');
      result = await vouchers.detail(ctx, decodeURIComponent(txnOne[1]), txnOne[3]);
    } else if (txnList && req.method === 'GET') {
      if (ctx.session) perms.require(ctx.session, SECTION_MODULE[txnList[2]] ?? 'reports', 'read');
      result = await vouchers.list(ctx, decodeURIComponent(txnList[1]), txnList[2]);
    } else if (find && req.method === 'GET') {
      result = await vouchers.search(ctx, decodeURIComponent(find[1]));
    } else if (adminOrg && req.method === 'GET') {
      result = await admin.customer(ctx, adminOrg[1]);
    } else if (adminOrg && req.method === 'PATCH') {
      result = await misc.adminUpdateOrg(ctx, adminOrg[1]);
    } else if (licRevoke && req.method === 'DELETE') {
      result = await licences.revoke(ctx, licRevoke[1]);
    } else if (install && req.method === 'GET') {
      result = await installer.publicScript(ctx, install[1]);
    } else if (deviceUpdate && req.method === 'PATCH') {
      result = await security.updateDevice(ctx, deviceUpdate[1]);
    } else if (revoke && req.method === 'DELETE') {
      result = revoke[1] === 'connectors'
        ? await devices.revokeConnector(ctx, revoke[2])
        : await devices.revokeSignIn(ctx, revoke[2]);
    } else if (view && req.method === 'GET') {
      const guid = decodeURIComponent(view[1]);
      const handler = {
        dashboard: reports.dashboard,
        outstanding: reports.outstanding,
        ledgers: reports.ledgers,
        statement: reports.statement,
        daybook: statements.dayBook,
        'trial-balance': statements.trialBalance,
        pnl: statements.profitAndLoss,
        'balance-sheet': statements.balanceSheet,
        expenses: statements.expenses,
        'sales-analysis': statements.salesAnalysis,
        inactive: statements.inactive,
        stock: statements.stock,
        'party-wise': statements.partyWise,
        'cash-bank': statements.cashAndBank,
        'purchase-analysis': statements.purchaseAnalysis,
        ageing: insights.ageing,
        projections: insights.projections,
        attention: insights.attention,
        top: insights.top,
        trends: insights.trends,
        profile: company.detail,
        summary: company.summary,
        overview: dash.overview,
        filters: dash.filterOptions,
        parties: masters.parties,
        items: masters.items,
        groups: masters.groups,
        numbering: invoices.numbering,
        gst: gst.summary,
        'gst-hsn': gst.hsn,
        'gst-parties': gst.byParty,
        'gst-health': gst.health,
        'cash-book': (c, g) => books.cashBook(c, g),
        // The bank book is the same report over a different set of groups, so
        // it is the same handler rather than a copy that can drift.
        'bank-book': (c, g) => {
          c.url.searchParams.set('kind', 'bank');
          return books.cashBook(c, g);
        },
        'group-summary': books.groupSummary,
        'sales-register': (c, g) => books.register(c, g, 'sales'),
        'purchase-register': (c, g) => books.register(c, g, 'purchase'),
        'due-soon': books.dueSoon,
        expiry: books.expiry,
        reminders: reminders.worklist,
        kpi: kpi.all,
        'kpi-sales': kpi.sales,
        'kpi-collection': kpi.collection,
        'kpi-purchases': kpi.purchases,
        'kpi-inventory': kpi.inventory,
        'kpi-profit': kpi.profitability,
        'entry-options': entry.options,
        entries: entry.list,
        pulse: pulse.all,
        'pulse-payers': pulse.payers,
        'pulse-movers': pulse.movers,
        'pulse-rhythm': pulse.rhythm,
        'pulse-runway': pulse.runway,
        'doc-template': company.docTemplate,
        'notify-sweep': notifications.sweep,
        search: search.find,
        'search-options': search.options,
      }[view[2]];
      // An unknown view is a 404, not a crash on calling undefined.
      if (!handler) {
        return fail(res, 404, 'NOT_FOUND', `No report "${view[2]}"`);
      }
      /*
       * Checked here, on the server, every time.
       *
       * The apps hide what a person cannot use, but that is presentation - a
       * hidden button is still a reachable URL, and a salesperson who knows
       * the address of the balance sheet must still be refused.
       */
      if (ctx.session) perms.require(ctx.session, VIEW_MODULE[view[2]] ?? 'reports', 'read');
      result = await handler(ctx, guid);
    } else {
      const key = `${req.method.padEnd(4)} ${url.pathname}`;
      const handler = routes[key];
      if (!handler) {
        return fail(res, 404, 'NOT_FOUND', `No route ${req.method} ${url.pathname}`);
      }
      result = await handler(ctx);
    }

    send(res, 200, result);
    log(req, url, 200, started);
  } catch (e) {
    if (e instanceof HttpError) {
      fail(res, e.status, e.code, e.message);
      log(req, url, e.status, started);
      return;
    }
    console.error(`  ${req.method} ${url.pathname} ->`, e);
    fail(res, 500, 'INTERNAL', 'Something went wrong on our side.');
    log(req, url, 500, started);
  }
});

function log(req, url, status, started) {
  const ms = Date.now() - started;
  /*
   * Observed before the QUIET check, not after.
   *
   * The tests run with QUIET=1, and metrics that only exist when logging is on
   * are metrics that are never exercised - which is how you find out they are
   * broken in production rather than in a test.
   */
  metrics.observe({ method: req.method, path: url.pathname, status, ms });

  if (process.env.QUIET === '1') return;
  // Never log request bodies: they carry customers' accounting data.
  console.log(`  ${status} ${req.method.padEnd(4)} ${url.pathname} ${ms}ms`);
}

async function start() {
  /*
   * Checked before anything else: a production server that would write
   * customers' books to disk unencrypted should never reach the point of
   * accepting a request. See lib/secrets.js for why this throws rather than
   * warning.
   */
  const enc = secrets.assertConfigured();

  await migrate();

  /*
   * Your own staff accounts, created if missing.
   *
   * Keyed on EMAIL, not phone: sign-in is Google, and Google proves an email
   * address. An operator row with only a phone number can never be signed into,
   * which is how the admin area became unreachable once SMS was removed.
   *
   * Listing an email here also promotes an account that already exists, so you
   * can sign up as a normal customer first and become staff afterwards.
   */
  const operators = (process.env.MUNIM_OPERATOR_EMAILS || '')
    .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

  if (!operators.length) {
    console.warn('  !! MUNIM_OPERATOR_EMAILS is not set - nobody can reach /admin.');
    console.warn('  !! Put your Google address in apps/api/.env and restart.');
  }

  for (const email of operators) {
    const { rows } = await query('SELECT id, role FROM users WHERE lower(email) = $1', [email]);

    if (!rows.length) {
      const { rows: org } = await query(
        `INSERT INTO orgs (name, plan, features, max_connectors, max_companies)
         VALUES ('Munim Technologies', 'internal',
                 '{"reminders":true,"multiCompany":true,"export":true}'::jsonb,
                 99, 99)
         RETURNING id`);
      await query(
        `INSERT INTO users (org_id, email, name, role)
         VALUES ($1, $2, 'Operator', 'platform_admin')`,
        [org[0].id, email]);
      console.log(`  staff account created for ${email}`);
    } else if (rows[0].role !== 'platform_admin') {
      await query(`UPDATE users SET role = 'platform_admin' WHERE id = $1`, [rows[0].id]);
      console.log(`  ${email} promoted to staff`);
    }
  }

  /*
   * A busy port is the single most common way to start this thing wrongly, and
   * Node's default is a twenty-line stack trace that never mentions the actual
   * problem - so the old server keeps serving old code while you read it.
   * Say what happened and what to type.
   */
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`\n  Port ${PORT} is already in use.`);
      console.error('  Munim is probably already running - open http://localhost:'
        + `${PORT}/v1/health to check.\n`);
      console.error('  To stop it and start fresh:');
      console.error('      npm run api:stop     then     npm run api\n');
      process.exit(1);
    }
    if (e.code === 'EACCES') {
      console.error(`\n  Not allowed to listen on port ${PORT}.`);
      console.error('  Choose another with  PORT=8090 npm run api\n');
      process.exit(1);
    }
    throw e;
  });

  server.listen(PORT, () => {
    console.log(`\n  munim api on http://localhost:${PORT}`);
    console.log(`  database: ${(process.env.DATABASE_URL || 'local socket /munim')}`);
    console.log(`  encryption at rest: ${enc.encryption}`);
    console.log(`  scheduled jobs: ${scheduler.start().jobs.join(', ')}`);
    console.log(operators.length
      ? `  staff sign-in: ${operators.join(', ')}\n`
      : '  staff sign-in: none configured - set MUNIM_OPERATOR_EMAILS\n');
  });
}

const shutdown = async () => {
  scheduler.stop();
  server.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start().catch((e) => { console.error('  failed to start:', e.message); process.exit(1); });
