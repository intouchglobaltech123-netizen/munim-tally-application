// API client for the Munim cloud.
//
// One place for the base URL, the auth token, money formatting and error
// shapes. Money crosses the wire as integer paise (docs/06-api-contract.md);
// it becomes rupees only at the moment of display.

export const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';

const TOKEN_KEY = 'munim.token';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null; // private mode / storage blocked
  }
}

export function setToken(t: string | null) {
  if (typeof window === 'undefined') return;
  try {
    if (t) window.localStorage.setItem(TOKEN_KEY, t);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API}${path}`, {
    ...init,
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = body?.error ?? {};
    throw new ApiError(err.code ?? `HTTP_${res.status}`,
      err.message ?? 'Something went wrong. Please try again.', res.status);
  }
  return body as T;
}

export const get = <T,>(p: string) => request<T>(p);
export const post = <T,>(p: string, body?: unknown) =>
  request<T>(p, { method: 'POST', body: JSON.stringify(body ?? {}) });
export const put = <T,>(p: string, body: unknown) =>
  request<T>(p, { method: 'PUT', body: JSON.stringify(body) });
export const patch = <T,>(p: string, body: unknown) =>
  request<T>(p, { method: 'PATCH', body: JSON.stringify(body) });

// A DELETE may carry a body - cancelling a licence records why.
export const del = <T,>(p: string, body?: unknown) =>
  request<T>(p, {
    method: 'DELETE',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

// --- types ------------------------------------------------------------------

export type Session = {
  access: string;
  isNewAccount: boolean;
  needsOnboarding: boolean;
  user: { id: string; name: string; phone: string | null; email: string | null; role: string };
  org: { id: string; name: string; plan: string; trialEndsAt: string };
};

export type CompanySettings = {
  numberFormat: 'indian' | 'international';
  decimals: number;
  dateFormat: 'dd-mm-yyyy' | 'mm-dd-yyyy' | 'yyyy-mm-dd';
  currency: string;
  logoDataUri: string;
};

export type CompanyRef = {
  tallyGuid: string; name: string; enabled: boolean; discoveredAt?: string;
  ledgers: number; vouchers: number; gstin?: string;
  lastSyncAt: string | null; lastAlterId: number;
  settings?: CompanySettings;
};

export type Me = {
  appLock?: { enabled: boolean; minutes: number; biometric: boolean };
  // What this person may see. The apps hide the rest; the server enforces it.
  permissions?: Record<string, Record<string, boolean>>;
  role?: { key: string; name: string; isOwner: boolean };
  needsOnboarding: boolean;
  user: { id: string; name: string; phone: string | null; email: string | null; role: string };
  org: { id: string; name: string; plan: string; trialEndsAt: string; messageCredits: number };
  companies: CompanyRef[];
  connectors: number;
  // What this customer may use. Sent by the server, never assumed - hiding a
  // link is presentation; the routes enforce the same values.
  features: Record<string, boolean>;
  limits: { connectors: number; companies: number };
};

export type Dashboard = {
  company: { tallyGuid: string; name: string };
  asOf: string | null;
  syncStatus: { lastSyncAt: string | null; healthy: boolean };
  tiles: {
    sales: { mtd: number; prevMtd: number; total: number; changePct: number | null };
    purchases: { mtd: number; prevMtd: number };
    receivables: { total: number; overdue: number; buckets: Record<string, number> };
    payables: { total: number };
    cashInHand: { amount: number };
    cash: { amount: number };
    bank: { amount: number };
    stock: { amount: number };
  };
  /** Last 30 and 7 days against the periods before them. */
  compare?: {
    last30: { amountPaise: number; prevPaise: number; changePct: number | null };
    last7:  { amountPaise: number; prevPaise: number; changePct: number | null };
  };
  salesTrend: { day: string; amountPaise: number }[];
  topItems: { name: string; amountPaise: number }[];
  topDebtors: { name: string; phone?: string; amountPaise: number }[];
  recentVouchers: { vchNo: string; date: string; party: string; amountPaise: number; type: string }[];
  counts: { ledgers: number; vouchers: number; bills: number; items: number };
};

// --- reports ---------------------------------------------------------------

export type TrialBalance = {
  groups: { group: string; nature: string; closingPaise: number }[];
  totals: { debitPaise: number; creditPaise: number; differencePaise: number };
  balanced: boolean;
};

export type Pnl = {
  income: { group: string; amountPaise: number }[];
  expense: { group: string; amountPaise: number }[];
  totals: { incomePaise: number; expensePaise: number; profitPaise: number };
};

export type BalanceSheet = {
  assets: { group: string; amountPaise: number }[];
  liabilities: { group: string; amountPaise: number }[];
  profitPaise: number;
  totals: { assetsPaise: number; liabilitiesPaise: number; differencePaise: number };
};

export type DayBook = {
  date: string;
  count: number;
  totalsByType: Record<string, number>;
  vouchers: { vchNo: string; vchType: string; party: string;
              amountPaise: number; narration: string; isCancelled: boolean }[];
};

export type SalesAnalysis = {
  groupBy: string;
  rows: { label: string; amountPaise: number; count: number }[];
  totalPaise: number;
};

export type Inactive = {
  days: number; asOf: string;
  parties: { name: string; phone: string; outstandingPaise: number;
             lastSeen: string | null; daysSince: number | null }[];
  items: { name: string; lastSold: string | null; daysSince: number | null }[];
};

export type Stock = {
  items: { name: string; unit: string; qty: number; valuePaise: number }[];
  totalValuePaise: number;
};

export type PartyWise = {
  rows: { name: string; salesPaise: number; purchasesPaise: number; lastTxn: string | null }[];
};

export type Expenses = {
  items: { name: string; group: string; amountPaise: number }[];
  totalPaise: number;
};

export type Devices = {
  connectors: {
    id: string; machine: string; tallyVersion: string; appVersion: string;
    status: string; tallyUp: boolean; pairedAt: string; lastSeenAt: string | null;
    revoked: boolean;
  }[];
  signIns: {
    id: string; phone: string; name: string;
    signedInAt: string; expiresAt: string; current: boolean;
  }[];
};

export type Outstanding = {
  kind: string;
  totals: { total: number; overdue: number; buckets: Record<string, number> };
  items: {
    party: string; ledgerName: string; phone: string; creditDays: number;
    totalPaise: number; overduePaise: number; oldestDays: number;
    bills: { ref: string; date: string; dueDate: string; pendingPaise: number; days: number }[];
  }[];
};

export type Statement = {
  ledger: {
    name: string; parentGroup: string; phone: string; gstin: string;
    creditDays: number; openingPaise: number; closingPaise: number;
  };
  rows: {
    date: string; vchNo: string; vchType: string; narration: string;
    amountPaise: number; balancePaise: number;
  }[];
};

export type Connector = {
  id: string; machine: string; tallyVersion: string; appVersion: string;
  pairedAt: string; lastSeenAt: string; status: string; tallyUp?: boolean;
  orgId?: string; orgName?: string;
};

export type Reminder = {
  id: string; party: string; phone: string; amountPaise: number;
  channel: string; status: string; sentAt: string; orgId?: string;
};

// --- formatting -------------------------------------------------------------

/** Indian digit grouping: 25,48,000 - never 2,548,000. */
/**
 * Money, the way this company asked to see it.
 *
 * `format` and `decimals` come from the company's settings rather than being
 * fixed: an Indian retailer wants 12,34,567 with no paise, and an exporter
 * billing abroad wants 1,234,567.00. Both are correct - for different people -
 * so neither can be hard-coded.
 *
 * Compact form (L / Cr) stays Indian in both cases, because "1.2 Cr" is what
 * anyone reading a rupee figure expects, whatever the grouping.
 */
export function inr(paise: number, opts: {
  compact?: boolean;
  format?: 'indian' | 'international';
  decimals?: number;
  symbol?: string;
} = {}): string {
  const rupees = (paise ?? 0) / 100;
  const decimals = opts.decimals ?? 0;
  const symbol = opts.symbol ?? '\u20b9';

  if (opts.compact) {
    const abs = Math.abs(rupees);
    const sign = rupees < 0 ? '-' : '';
    if (abs >= 1e7) return `${sign}${symbol}${(abs / 1e7).toFixed(2)} Cr`;
    if (abs >= 1e5) return `${sign}${symbol}${(abs / 1e5).toFixed(2)} L`;
  }

  const locale = opts.format === 'international' ? 'en-US' : 'en-IN';
  const body = new Intl.NumberFormat(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(rupees);

  // Built by hand rather than with style:'currency', so a company whose base
  // currency is not the rupee still gets its own symbol in front.
  return rupees < 0 ? `-${symbol}${body.slice(1)}` : `${symbol}${body}`;
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN',
    { day: '2-digit', month: 'short', year: '2-digit' });
}

/** "4 min ago" - an accounting figure without a freshness label is a support ticket. */
export function ago(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)} min ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)} hr ago`;
  return `${Math.floor(secs / 86400)} days ago`;
}

// --- Business insights: the figures a shop owner acts on, as opposed to the
// statements an accountant reconciles.

export type Ageing = {
  asOf: string;
  buckets: { label: string; amountPaise: number }[];
  totalPaise: number;
  overduePaise: number;
};

export type Projections = {
  asOf: string;
  next15Paise: number;
  next60Paise: number;
  overduePaise: number;
};

export type Attention = {
  asOf: string;
  quietDays: number;
  items: {
    key: string;
    label: string;
    count: number;
    amountPaise: number | null;
    tone: 'ok' | 'warn' | 'bad';
    hint: string;
  }[];
};

export type Top = {
  by: string;
  label: string;
  days: number;
  asOf: string;
  totalPaise: number;
  rows: { label: string; amountPaise: number; count: number; sharePct: number }[];
};

export type Trends = {
  asOf: string;
  // changePct is null when the previous period had no sales - a percentage
  // change from zero is not a number worth showing.
  windows: { days: number; amountPaise: number; prevPaise: number; changePct: number | null }[];
};

// --- Company management

export type CompanyHealth = {
  state: 'live' | 'quiet' | 'stale' | 'never' | 'paused';
  label: string;
  hint: string;
};

export type CompanyProfile = {
  name: string; formalName: string; address: string; state: string;
  country: string; pincode: string; phone: string; email: string;
  gstin: string; pan: string; cin: string; currency: string;
  booksFrom: string; fyStart: string; fyEnd: string; profileAt: string | null;
};

export type Completeness = {
  percent: number;
  missing: { key: string; label: string; why: string }[];
  fixHint: string;
};

export type CompanyCard = {
  tallyGuid: string;
  enabled: boolean;
  lastSyncAt: string | null;
  discoveredAt: string;
  health: CompanyHealth;
  profile: CompanyProfile;
  settings: CompanySettings;
  completeness: Completeness;
  counts: { ledgers: number; vouchers: number; items: number; customers: number };
};

export type CompanyDetail = Omit<CompanyCard, 'counts'> & {
  counts: {
    ledgers: number; vouchers: number; items: number; groups: number;
    bills: number; customers: number; suppliers: number;
  };
  span: { firstVoucher: string | null; lastVoucher: string | null };
};

export type CompanySummary = {
  company: { tallyGuid: string; name: string };
  financialYear: { from: string; to: string; booksFrom: string };
  metrics: {
    sales: number; purchases: number; receivables: number; payables: number;
    cash: number; bank: number; stock: number; expenses: number;
    gst: number; profit: number;
  };
  syncStatus: CompanyHealth & { lastSyncAt: string | null };
  connection: {
    online: boolean; machineName: string; tallyUp: boolean;
    lastSeenAt: string | null; queuedBatches: number; lastError: string;
    label: string; hint: string;
  };
};

// --- Sync and the connector

export type SyncRun = {
  id: string;
  companyName: string | null;
  startedAt: string;
  durationMs: number;
  trigger: 'auto' | 'manual' | 'startup' | 'command';
  ok: boolean;
  records: number;
  batches: number;
  vouchers: number;
  masters: number;
  error: string;
  errorKind: '' | 'network' | 'auth' | 'tally' | 'other';
};

export type SyncHistory = {
  runs: SyncRun[];
  week: {
    runs: number; failures: number; records: number; avgMs: number;
    lastOkAt: string | null; lastFailAt: string | null;
    successPct: number | null;
  };
};

export type SyncLogs = {
  lines: { at: string; level: 'info' | 'warn' | 'error'; line: string }[];
  fetchPending: boolean;
};

// --- Account security

export type SecurityStatus = {
  appLock: { enabled: boolean; minutes: number; biometric: boolean };
  devices: { active: number; trusted: number };
  accountLockedUntil: string | null;
  sessionPolicy: { expires: boolean; note: string };
};

export type LoginHistory = {
  events: {
    at: string; ok: boolean; via: string; reason: string;
    deviceKind: string; deviceLabel: string; ipPrefix: string;
  }[];
  failedLast30Days: number;
};

// --- Users, roles and permissions

export type PermissionMatrix = Record<string, Record<string, boolean>>;

export type Role = {
  id: string; key: string; name: string; description: string;
  builtIn: boolean; permissions: Record<string, string[]>; users: number;
};

export type OrgUser = {
  id: string; name: string; email: string | null; phone: string | null;
  status: 'active' | 'disabled';
  roleId: string | null; roleKey?: string; roleName: string;
  branch: string; isSalesperson: boolean; salespersonName: string;
  deviceLimit: number; lastSeenAt: string | null; invitedAt: string | null;
  createdAt: string; activeDevices: number; companies: string[]; pending: false;
};

export type PendingInvite = {
  id: string; email: string; name: string; branch: string;
  roleId: string | null; roleKey?: string; roleName: string;
  invitedAt: string; pending: true;
};

export type UsersPayload = {
  users: OrgUser[];
  invites: PendingInvite[];
  limits: { users: number | null };
};

export type RolesPayload = {
  roles: Role[];
  catalogue: {
    modules: Record<string, { label: string; hint: string }>;
    actions: Record<string, { label: string; hint: string }>;
  };
};

// --- Dashboard v2

export type Metric = {
  paise: number; prev?: number; changePct?: number | null;
  count?: number; note?: string;
};

export type Overview = {
  company: { tallyGuid: string; name: string };
  asOf: string;
  period: { key: string; from: string; to: string; label: string };
  previous: { from: string; to: string };
  financialYear: { from: string; to: string; label: string };
  scope: { party: string; item: string; salesperson: string };
  metrics: Record<string, Metric>;
  charts: {
    salesTrend: { at: string; value: number }[];
    purchaseTrend: { at: string; value: number }[];
    profitTrend: { at: string; value: number }[];
    expenseTrend: { at: string; value: number }[];
    receivableTrend: { at: string; value: number }[];
    payableTrend: { at: string; value: number }[];
    cashFlow: { at: string; in: number; out: number; net: number }[];
    topCustomers: { label: string; value: number; n: number }[];
    topSuppliers: { label: string; value: number; n: number }[];
    topProducts: { label: string; value: number; qty: number }[];
    salespeople: { label: string; value: number }[];
    categories: { label: string; value: number }[];
  };
  landscape: {
    cells: { month: string; party: string; value: number }[];
    months: string[];
    parties: string[];
  };
};

export type FilterOptions = {
  parties: string[]; items: string[]; salespeople: string[]; branches: string[];
  periods: { key: string; label: string }[];
};

// --- Masters

export type Party = {
  name: string; group: string; nature: string; kind: 'customer' | 'supplier' | 'ledger';
  openingPaise: number; closingPaise: number;
  creditDays: number; creditLimitPaise: number; overLimit: boolean;
  contact: {
    person: string; phone: string; email: string; address: string;
    state: string; country: string; pincode: string; shippingAddress: string;
  };
  tax: { gstin: string; registrationType: string; pan: string };
  bank: { name: string; account: string; ifsc: string; holder: string };
  tags: string[]; updatedAt: string;
};

export type PartiesPayload = {
  parties: Party[];
  totals: { count: number; owedToYouPaise: number; youOwePaise: number };
  tags: string[];
  readOnly: string;
};

export type PartyBehaviour = {
  bills: number; averageDays: number; worstDays: number;
  daysAgainstTerms: number | null; lateBills: number;
  onTimePercent: number; verdict: string; confident: boolean;
};

export type PartyAgeing = {
  notDuePaise: number;
  buckets: { label: string; paise: number }[];
  overduePaise: number; totalPaise: number; overduePercent: number;
};

export type PartyDetail = {
  party: Party;
  salesHistory: VoucherRef[]; purchaseHistory: VoucherRef[];
  receiptHistory: VoucherRef[]; paymentHistory: VoucherRef[];
  openBills: { ref: string; billDate: string; dueDate: string;
               amountPaise: number; current: boolean }[];
  monthly: { at: string; sales: number; receipts: number }[];
  itemsBought: { label: string; qty: number; amountPaise: number }[];
  /** Null when nothing has been settled — a new customer has no track record. */
  behaviour: PartyBehaviour | null;
  ageing: PartyAgeing;
};

export type VoucherRef = {
  id: string; no: string; type?: string; date: string;
  amountPaise: number; narration?: string;
};

export type StockItem = {
  name: string; group: string; category: string; unit: string; altUnit: string;
  hsn: string; sac: string; gstRatePct: number;
  openingQty: number; openingValuePaise: number;
  closingQty: number; closingValuePaise: number;
  purchaseRatePaise: number; salesRatePaise: number;
  minLevel: number; maxLevel: number; reorderLevel: number;
  status: 'ok' | 'out' | 'negative' | 'reorder';
  ratePaise: number; hasBatches: boolean; tags: string[];
};

export type ItemsPayload = {
  items: StockItem[];
  totals: { count: number; valuePaise: number; negative: number;
            outOfStock: number; belowReorder: number };
  groups: { name: string; count: number }[];
  categories: { name: string; count: number }[];
  readOnly: string;
};

export type ItemDetail = {
  item: StockItem;
  movement: { id: string; no: string; type: string; date: string; party: string;
              qty: number; ratePaise: number; amountPaise: number;
              direction: 'in' | 'out' }[];
  buyers: { label: string; qty: number; amountPaise: number }[];
  monthly: { at: string; sold: number; bought: number }[];
  batches: { name: string; godown: string; qty: number; valuePaise: number;
             mfgDate: string | null; expiryDate: string | null }[];
};

// --- Invoices

export type DocTemplate = {
  page: { size: string; label: string; orientation: string;
          widthMm: number; heightMm: number; marginMm: number };
  type: { font: string; sizePt: number; accent: string; borders: boolean; dense: boolean };
  show: Record<string, boolean>;
  text: { terms: string; footer: string; signatory: string };
  bank: { name: string; account: string; ifsc: string; branch: string };
  upiId: string;
};

export type DocTemplatePayload = {
  template: DocTemplate;
  blocks: Record<string, { label: string; hint: string }>;
  pages: Record<string, { width: number; height: number; label: string }>;
  note: string;
};

export type InvoiceDoc = {
  template: DocTemplate;
  upiQr: { dataUri: string; upiId: string; amount: string } | null;
  document: { kind: string; title: string; taxable: boolean; note?: string;
              isCommitment: boolean; isCancelled: boolean };
  seller: { name: string; address: string; state: string; pincode: string;
            phone: string; email: string; gstin: string; pan: string;
            logoDataUri: string;
            bank: { name: string; account: string; ifsc: string; branch: string } };
  buyer: { name: string; address: string; state: string; pincode: string;
           phone: string; email: string; gstin: string; pan: string;
           shippingAddress: string };
  invoice: { id: string; number: string;
             numbering: { raw: string; prefix: string; seq: number | null;
                          width?: number; suffix: string; series: string };
             date: string; type: string; narration: string;
             placeOfSupply: string; terms: string; dueDate: string | null };
  lines: { name: string; hsn: string; unit: string; qty: number;
           ratePaise: number; grossPaise: number; discountPaise: number;
           amountPaise: number; gstRatePct: number }[];
  hsnSummary: { hsn: string; qty: number; valuePaise: number; gstRatePct: number }[];
  totals: {
    subtotalPaise: number;
    taxes: { label: string; amountPaise: number }[];
    tax: { cgst: number; sgst: number; igst: number; cess: number; other: number;
           total: number; supply: string | null; expectedSupply: string | null;
           mismatch: boolean };
    roundOffPaise: number; grossPaise: number; inWords: string;
    discountPaise: number;
  };
  bills: { ref: string; billDate: string; dueDate: string | null;
           amountPaise: number; type: string }[];
};

export type NumberingReport = {
  invoices: number;
  series: { series: string; prefix: string; suffix: string; count: number;
            first: string; last: string; from: number; to: number;
            missing: number[]; missingCount: number;
            outOfOrder: { number: string; date: string; after: string; afterDate: string }[] }[];
  duplicates: { number: string; count: number;
                vouchers: { id: string; date: string; party: string;
                            amountPaise: number; cancelled: boolean }[] }[];
  findings: { duplicates: number; gaps: number; outOfOrder: number };
  note: string;
};

// --- GST

export type GstinCheck = {
  value: string; valid: boolean; reason?: string; message: string;
  stateCode?: string; stateName?: string; pan?: string;
  entityNumber?: string; holderType?: string; isRegular?: boolean;
};

type TaxBucket = { cgst: number; sgst: number; igst: number; cess: number; other: number };
type Leg = { taxable: number; tax: TaxBucket; count: number; taxTotal: number };

export type GstSummary = {
  company: { name: string; gstin: string; gstinCheck: GstinCheck; state: string };
  period: { key: string; from: string; to: string; label: string };
  financialYear: string;
  asOf: string;
  outward: Leg; inward: Leg; creditNotes: Leg; debitNotes: Leg;
  b2b: Leg; b2c: Leg;
  byRate: (Leg & { ratePct: number })[];
  position: {
    outputTaxPaise: number; inputTaxPaise: number; netPaise: number;
    direction: 'payable' | 'credit' | 'nil';
  };
  note: string;
};

export type GstHsn = {
  period: { from: string; to: string; label: string };
  rows: { hsn: string; unit: string; ratePct: number; qty: number;
          valuePaise: number; vouchers: number }[];
  missingHsn: { lines: number; valuePaise: number };
  note: string;
};

export type GstHealth = {
  period: { from: string; to: string; label: string };
  findings: { key: string; label: string; count: number; tone: string;
              detail: string; items?: Record<string, unknown>[] }[];
  total: number;
  note: string;
};

export type GstParties = {
  period: { from: string; to: string; label: string };
  parties: { party: string; gstin: string; state: string; sales: number;
             salesTax: number; purchases: number; purchasesTax: number;
             count: number; kind: 'b2b' | 'b2c'; gstinCheck: GstinCheck | null }[];
};

// --- Reminders

export type ReminderJob = {
  party: string; phone: string; email: string;
  amountPaise: number;
  bills: { ref: string; dueDate: string; amountPaise: number }[];
  daysOverdue: number;
  rule: { id: string; name: string; trigger: string; days: number };
  templateId: string | null; channel: string;
  message: string; reachable: boolean; remindedBefore: number;
};

export type ReminderWorklist = {
  asOf: string;
  company: { name: string };
  worklist: ReminderJob[];
  totals: { parties: number; amountPaise: number; unreachable: number };
  note: string;
};

export type ReminderConfig = {
  templates: { id: string; name: string; channel: string; body: string; isDefault: boolean }[];
  rules: { id: string; name: string; enabled: boolean; trigger: string; days: number;
           channel: string; templateId: string | null; templateName: string | null;
           minAmountPaise: number; repeatDays: number; maxReminders: number }[];
  placeholders: { key: string; what: string }[];
};

export type ReminderHistory = {
  reminders: { id: string; party: string; phone: string; amountPaise: number;
               channel: string; status: string; billRefs: string[];
               daysOverdue: number; message: string; at: string; by: string }[];
  last90Days: { total: number; sent: number; handed: number; skipped: number;
                parties: number; settledAfterReminder: number; caveat: string };
};

// --- Sharing

export type SharePreview = {
  kind: string; subject: string; recipient: string; email: string;
  templateId: string | null; message: string;
  variables: Record<string, string>;
};

export type ShareLog = {
  shares: { id: string; kind: string; subject: string; channel: string;
            recipient: string; status: string; at: string; by: string }[];
};

// --- Saved views

export type ViewConfig = {
  columns?: string[];
  sort?: { by: string; dir: 'asc' | 'desc' };
  groupBy?: string;
  period?: string; from?: string; to?: string;
  filters?: Record<string, string | boolean>;
  totals?: boolean; subtotals?: boolean;
  decimals?: number;
  numberFormat?: 'indian' | 'international';
  exportFormat?: 'csv' | 'print';
};

export type SavedView = {
  id: string; report: string; name: string; config: ViewConfig;
  isDefault: boolean; shared: boolean; mine: boolean; owner: string;
  updatedAt: string;
};




// --- Notifications

export type Notification = {
  id: string; event: string; label: string;
  level: 'info' | 'warn' | 'bad';
  title: string; body: string;
  link: { screen?: string; id?: string; name?: string; section?: string };
  companyName: string; at: string; read: boolean;
};

export type NotificationFeed = {
  notifications: Notification[];
  unread: number;
  events: Record<string, { label: string; module: string; level: string; hint: string }>;
};

export type NotificationSettings = {
  rules: { event: string; label: string; hint: string; module: string; level: string;
           enabled: boolean; minAmountPaise: number; visibleToMe: boolean }[];
  mine: { quietFrom: number; quietTo: number; muted: boolean; inQuietHoursNow: boolean };
  note: string;
};

// --- Search

export type SearchHit = {
  title: string; subtitle: string; amountPaise: number;
  link: { screen?: string; id?: string; name?: string };
};

export type SearchResults = {
  q: string;
  groups: { kind: string; label: string; results: SearchHit[] }[];
  total: number;
  hint: string;
  filters?: Record<string, string>;
};

export type SearchOptions = {
  voucherTypes: string[];
  kinds: { key: string; label: string }[];
};

// --- Audit log

export type AuditEntry = {
  id: string; action: string; label: string;
  entity: string; entityId: string; entityName: string;
  by: string; byEmail: string; companyName: string;
  ipPrefix: string; device: string; at: string;
  changes: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  meta: Record<string, unknown>;
};

export type AuditLog = {
  entries: AuditEntry[];
  actions: { key: string; label: string; count: number }[];
  actors: { id: string; name: string }[];
  note: string;
};

// --- Account lifecycle

export type AccountStatus = {
  deletion: {
    requestedAt: string; requestedBy: string; dueAt: string;
    daysLeft: number; reason: string; note: string;
  } | null;
  recovery: { email: string; phone: string; setAt: string | null; note: string };
  owners: { id: string; name: string; email: string; lastSeenAt: string | null }[];
  soleOwner: boolean;
  soleOwnerWarning: string;
  transfer: { id: string; to: string; from: string; expiresAt: string } | null;
  encryptionAtRest: boolean;
};

// --- Plans and billing

export type PlanCard = {
  key: string; label: string; pricePaise: number; blurb: string;
  days: number | null; quoted: boolean;
  limits: Record<string, number | null>;
  features: Record<string, boolean>;
};

export type UsageLine = {
  key: string; label: string; unit: string; used: number;
  limit: number | null; unlimited: boolean; pct: number; over: boolean; summary: string;
};

export type PaymentRow = {
  id: string; status: 'pending' | 'paid' | 'failed' | 'refunded';
  subtotalPaise: number; discountPaise: number; taxPaise: number; totalPaise: number;
  totalLabel: string; method: string; failureReason: string;
  periodFrom: string | null; periodUntil: string | null;
  paidAt: string | null; createdAt: string;
  invoiceNumber: string | null; invoiceId: string | null;
};

export type Billing = {
  subscription: {
    id: string; plan: string; planLabel: string; status: string; term: string;
    pricePaise: number; priceLabel: string;
    renewsAt: string | null; endsAt: string | null;
    pendingPlan: string | null; pendingPlanLabel: string | null;
    cancelAtEnd: boolean; graceUntil: string | null; coupon: string | null;
    message: string;
  } | null;
  plan: { key: string; label: string; pricePaise: number };
  trial: { trial: boolean; daysLeft: number | null; expired?: boolean };
  usage: UsageLine[];
  atLimit: string[];
  payments: PaymentRow[];
  addons: { kind: string; quantity: number; purchases: number }[];
  plans: PlanCard[];
  note: string;
};

export type PlanPreview = {
  plan?: string; planLabel?: string; term?: string; quoted?: boolean;
  quote?: {
    subtotalPaise: number; discountPaise: number; discountLabel: string;
    taxablePaise: number; cgstPaise: number; sgstPaise: number; igstPaise: number;
    taxPaise: number; taxKind: string; totalPaise: number;
  };
  proration?: { chargePaise: number; creditPaise: number; duePaise: number; daysLeft: number } | null;
  downgrade?: boolean;
  dueNowPaise?: number;
  message: string;
};

// --- Operator console

export type AdminMetrics = {
  at: string;
  business: {
    accounts: { total: number; trial: number; paid: number; closing: number;
                new30d: number; new7d: number };
    companies: { total: number; active: number };
    users: { total: number; dau: number; mau: number; stickiness: number };
    revenue: {
      mrrPaise: number; mrrLabel: string; arrPaise: number; arrLabel: string;
      arpuPaise: number; arpuLabel: string; ltvPaise: number | null; ltvLabel: string;
      lifetimePaise: number; lifetimeLabel: string;
    };
    health: {
      churnPercent: number; cancelled30d: number; conversionPercent: number;
      liveSubscriptions: number; paymentsOk: number; paymentsFailed: number;
      paymentSuccessPercent: number;
    };
    activeDefinition: string;
  };
  technical: {
    connectors: { total: number; online: number; offline: number; tallyDown: number;
                  queueDepth: number; onlinePercent: number };
    sync: { runs24h: number; ok24h: number; failed24h: number;
            successPercent: number; averageMs: number };
    database: { latencyMs: number; sizeMb: number; vouchers: number };
    api: {
      windowMinutes: number; samples: number; avgMs: number; p50Ms: number;
      p95Ms: number; p99Ms: number; maxMs: number; errors: number;
      errorRate: number; slowRequests: number;
      slowest: { route: string; calls: number; avgMs: number; maxMs: number; errors: number }[];
      busiest: { route: string; calls: number; avgMs: number; maxMs: number; errors: number }[];
      lifetime: { requests: number; errors: number; rejected: number; rateLimited: number };
    };
    system: {
      uptimeSeconds: number; nodeVersion: string; platform: string; cores: number;
      load: { one: number; five: number; fifteen: number }; loadPercent: number;
      memory: { rssMb: number; heapUsedMb: number; heapTotalMb: number;
                systemTotalMb: number; systemFreeMb: number; systemUsedPercent: number };
    };
  };
  feature: {
    window: string;
    accounting: { vouchersSynced: number; invoices: number };
    messaging: { reminders: number; whatsapp: number; sms: number;
                 emails: number; shares: number };
    documents: { pdfsAndPrints: number; csvExports: number;
                 reportsViewedSinceRestart: number };
    data: { savedViews: number; pinnedReports: number };
    compliance: { eInvoices: number; eWayBills: number; note: string };
  };
};

// --- Business KPIs

export type KpiPeriod = { from: string; to: string; label: string };

export type SalesKpi = {
  period: KpiPeriod;
  revenuePaise: number; invoices: number; averageInvoicePaise: number;
  growthPercent: number | null; priorRevenuePaise: number; priorInvoices: number;
  topCustomers: { party: string; amountPaise: number; invoices: number;
                  sharePercent: number }[];
  topProducts: { item: string; amountPaise: number; qty: number; invoices: number }[];
  monthly: { month: string; amountPaise: number; invoices: number }[];
  concentration: { topCustomerPercent: number; topFivePercent: number } | null;
  salespeople: { available: boolean; note: string };
};

export type CollectionKpi = {
  period: KpiPeriod;
  receivablePaise: number; overduePaise: number; bills: number; overdueBills: number;
  oldestOverdueDays: number; billedPaise: number; collectedPaise: number;
  collectionRatePercent: number | null; collectionRateNote: string;
  averagePaymentDays: number | null; averagePaymentBasis: string;
  dsoDays: number | null; dsoNote: string;
};

export type PurchaseKpi = {
  period: KpiPeriod;
  amountPaise: number; bills: number; growthPercent: number | null;
  priorAmountPaise: number;
  topSuppliers: { party: string; amountPaise: number; bills: number;
                  sharePercent: number }[];
  concentration: { topSupplierPercent: number; topFivePercent: number;
                   warning: string } | null;
};

export type InventoryKpi = {
  period: KpiPeriod;
  stockValuePaise: number; items: number;
  turnsBySalesValue: number | null; turnoverNote: string; daysOfStock: number | null;
  fastMoving: { item: string; qty: number; amountPaise: number; lastSold: string }[];
  slowMoving: { item: string; qty: number; amountPaise: number; lastSold: string }[];
  deadStock: {
    count: number; valuePaise: number; sharePercent: number; note: string;
    items: { item: string; qty: number; valuePaise: number }[];
  };
  lowStock: number;
  negativeStock: { count: number; valuePaise: number; note: string };
};

export type ProfitKpi = {
  period: KpiPeriod;
  salesPaise: number; purchasesPaise: number;
  directExpensesPaise: number; indirectExpensesPaise: number;
  otherIncomePaise: number; directIncomePaise: number;
  grossProfitPaise: number; grossMarginPercent: number | null;
  netProfitPaise: number; netMarginPercent: number | null;
  expenseRatioPercent: number | null;
  basis: string; reliable: boolean;
};

export type Kpis = {
  sales: SalesKpi; collection: CollectionKpi; purchases: PurchaseKpi;
  inventory: InventoryKpi; profitability: ProfitKpi;
};

// --- Personal preferences

export type Widget = { key: string; label: string; module: string; hint?: string };

export type DashboardLayout = {
  widgets: Widget[];
  hidden: Widget[];
  period: 'month' | 'quarter' | 'fy' | 'year';
  compact: boolean;
  catalogue: (Widget & { defaultOn: boolean })[];
};

export type Preferences = {
  preferences: {
    'dashboard.layout': { order: string[]; hidden: string[]; period: string; compact: boolean };
    'reports.defaults': Record<string, {
      columns: string[]; groupBy: string; sortBy: string;
      sortDir: 'asc' | 'desc'; period: string;
    }>;
    'app.preferences': { defaultCompany: string; landing: string; density: string };
  };
  dashboard: DashboardLayout;
  note: string;
};


// --- Support

export type TicketRow = {
  id: string; number: number; subject: string; category: string;
  priority: string; status: string; statusLabel: string; raisedBy: string;
  createdAt: string; updatedAt: string; firstReplyAt: string | null;
  resolvedAt: string | null; messages: number; lastAt: string | null;
  rating: number | null;
};

export type Suggestion = {
  title: string; detail: string; action: string; href: string;
};

export type HelpPayload = {
  categories: { key: string; label: string }[];
  priorities: { key: string; label: string }[];
  responseHours: Record<string, number>;
  planLabel: string;
  diagnostics: {
    plan: string;
    connectors: { machine: string; tallyRunning: boolean; tally: string;
                  connectorVersion: string; minutesSinceSeen: number | null;
                  queued: number; lastError: string | null }[];
    companies: { name: string; lastSyncAt: string | null; vouchers: number }[];
    recentSyncs: { ok: boolean; error: string; started_at: string }[];
    encryptionAtRest: boolean;
  };
  suggestions: Suggestion[];
  faq: { q: string; a: string }[];
  contact: { email: string; whatsapp: string; hours: string; phoneNote: string };
};

export type TicketDetail = {
  ticket: TicketRow;
  messages: { id: string; author: string; from_staff: boolean;
              internal: boolean; body: string; at: string }[];
  files: { id: string; filename: string; size_bytes: number; at: string }[];
  suggestions: Suggestion[];
};

// --- Partner programme


// --- Creating vouchers

export type EntryKind = {
  key: string; label: string; tallyType: string;
  wantsItems: boolean; partySide: 'debit' | 'credit' | null;
};

export type EntryLedger = { name: string; group: string; balancePaise: number };
export type EntryItem = {
  name: string; unit: string; salesRatePaise: number;
  purchaseRatePaise: number; gstRateBp: number; inStock: number;
};

export type EntryOptions = {
  writesEnabled: boolean;
  kinds: EntryKind[];
  ledgers: EntryLedger[];
  items: EntryItem[];
  voucherTypes: string[];
  note: string;
};

export type Draft = {
  id: string; kind: string; kindLabel: string; vchType: string;
  number: string | null; tallyNumber: string | null;
  date: string; party: string; narration: string;
  entries: { ledger: string; amountPaise: number }[];
  items: { item: string; qty: number; ratePaise: number; amountPaise: number }[];
  bills: { ref: string; type: string; amountPaise: number; ledger?: string }[];
  amountPaise: number;
  status: 'draft' | 'queued' | 'sending' | 'posted' | 'rejected' | 'cancelled';
  statusLabel: string;
  error: string; tallyResponse: string | null; tallyGuid: string | null;
  attempts: number; createdBy: string; createdAt: string;
  sentAt: string | null; postedAt: string | null;
  editable: boolean;
};

export type DraftList = { drafts: Draft[]; counts: Record<string, number> };

// --- Pulse: the questions totals do not answer

export type Payer = {
  party: string; bills: number; valuePaise: number;
  averageDays: number; worstDays: number;
  daysAgainstTerms: number | null; lateBills: number;
  onTimePercent: number; verdict: string;
};

export type Mover = {
  party: string; nowPaise: number; beforePaise: number; changePaise: number;
  changePercent: number | null; firstTime: boolean; stopped: boolean;
  invoices: number;
};

export type RhythmDay = {
  day: string; short: string; amountPaise: number; invoices: number;
  daysOpen: number; averagePaise: number; sharePercent: number;
};

export type Pulse = {
  payers: {
    windowDays: number; payers: Payer[]; worst: Payer[]; best: Payer[];
    note: string; basis: string;
  };
  movers: {
    windowDays: number; comparedWith: string;
    grew: Mover[]; shrank: Mover[]; won: Mover[]; lost: Mover[]; note: string;
  };
  rhythm: {
    windowDays: number; byDay: RhythmDay[];
    byMonth: { month: string; short: string; amountPaise: number;
               invoices: number; sharePercent: number }[];
    best: RhythmDay | null; worst: RhythmDay | null;
    closedOn: string[]; summary: string; note: string;
  };
  runway: {
    cashPaise: number; bankPaise: number; liquidPaise: number;
    monthlyBurnPaise: number; months: number | null;
    monthsWithReceivables: number | null; receivablePaise: number;
    basis: string; tone: 'ok' | 'warn' | 'bad' | 'unknown';
  };
};
