import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeModules, Platform } from 'react-native';

/**
 * Where the API lives.
 *
 * A phone cannot reach the laptop's localhost, so in development this has to be
 * the laptop's LAN address - and that address changes every time you join a
 * different Wi-Fi or hotspot. Hardcoding it means re-editing .env and
 * rebuilding the bundle after every network change, and the symptom of
 * forgetting is an opaque "network request failed".
 *
 * So derive it instead. Metro serves the JS bundle from the dev machine, and
 * its URL carries that machine's current address:
 *
 *     http://10.107.198.1:8081/index.bundle?platform=android&dev=true
 *              ^^^^^^^^^^^^^ the laptop, whatever its IP is today
 *
 * The API sits on the same machine at a different port, so swapping the port
 * gives the right address on any network, with nothing to keep in sync.
 *
 * EXPO_PUBLIC_API_URL still wins when set - that is how a real build points at
 * the hosted API rather than somebody's laptop.
 */
const API_PORT = 8080;

function devHost(): string | null {
  // e.g. "http://10.107.198.1:8081/index.bundle?platform=android"
  // React Native has moved this between a plain property and a getConstants()
  // call across versions, so read both rather than bet on one.
  const src = (NativeModules as Record<string, any> | undefined)?.SourceCode;
  const url: string | undefined =
    src?.scriptURL ?? src?.getConstants?.()?.scriptURL;

  const host = url?.match(/^https?:\/\/([^:/]+)/)?.[1];
  // A production bundle loads from file://, and localhost would be the phone
  // itself - neither can reach the API.
  if (!host || host === 'localhost' || host === '127.0.0.1') return null;
  return host;
}

function resolveApi(): string {
  const configured = process.env.EXPO_PUBLIC_API_URL;
  if (configured) return configured.replace(/\/$/, '');
  const host = devHost();
  return host ? `http://${host}:${API_PORT}` : '';
}

export const API = resolveApi();

/**
 * Sent on every request so the server can label this sign-in. Months later the
 * owner reads it in "Linked devices" to decide which phone to cut off - so it
 * has to mean something to a person, not be a UUID.
 */
export const DEVICE_LABEL = `${Platform.OS === 'ios' ? 'iPhone' : 'Android'} ${Platform.Version}`;

const TOKEN_KEY = 'munim.token';

let cachedToken: string | null = null;

export async function loadToken() {
  cachedToken = await AsyncStorage.getItem(TOKEN_KEY);
  return cachedToken;
}
export async function saveToken(t: string | null) {
  cachedToken = t;
  if (t) await AsyncStorage.setItem(TOKEN_KEY, t);
  else await AsyncStorage.removeItem(TOKEN_KEY);
}
export const token = () => cachedToken;

export class ApiError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  // A missing or wrong address surfaces as a bare "Network request failed",
  // which tells nobody anything. Say what is actually wrong.
  if (!API) {
    throw new ApiError('NO_API_URL',
      'Cannot work out where the API is. Set EXPO_PUBLIC_API_URL in '
      + 'apps/mobile/.env to your computer\'s LAN address, then restart Expo '
      + 'with --clear.', 0);
  }

  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'X-Munim-Device': DEVICE_LABEL,
        ...(cachedToken ? { Authorization: `Bearer ${cachedToken}` } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new ApiError('UNREACHABLE',
      `Cannot reach ${API}. Check that the API is running, that this is your `
      + 'computer\'s LAN address (not localhost), and that the phone is on the '
      + 'same Wi-Fi.', 0);
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = (body as any)?.error ?? {};
    throw new ApiError(e.code ?? `HTTP_${res.status}`,
      e.message ?? 'Something went wrong. Please try again.', res.status);
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
export const del = <T,>(p: string) => request<T>(p, { method: 'DELETE' });

// --- types (mirror docs/06-api-contract.md) ---------------------------------

export type CompanySettings = {
  numberFormat: 'indian' | 'international';
  decimals: number;
  dateFormat: 'dd-mm-yyyy' | 'mm-dd-yyyy' | 'yyyy-mm-dd';
  currency: string;
  logoDataUri: string;
};

export type CompanyRef = {
  tallyGuid: string; name: string; enabled: boolean; discoveredAt?: string;
  gstin?: string; settings?: CompanySettings;
  ledgers: number; vouchers: number;
  lastSyncAt: string | null; lastAlterId: number;
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
  // What this customer may use. Sent by the server, never assumed.
  features: Record<string, boolean>;
  limits: { connectors: number; companies: number };
};

export type AuthConfig = {
  provider: 'google' | 'not-configured';
  configured: boolean;
  // Present only when the server can verify a Google token, so the button
  // cannot appear on a half-configured deploy. `android` and `web` are
  // different OAuth clients and are not interchangeable.
  google: { clientId: string; web: string; android: string } | null;
};

export type Session = {
  access: string; isNewAccount: boolean; needsOnboarding: boolean;
  user: Me['user']; org: { id: string; name: string; plan: string; trialEndsAt: string };
};

export type Dashboard = {
  company: { tallyGuid: string; name: string };
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

// --- reports (same shapes the web app uses) ---------------------------------

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
  date: string; count: number; totalsByType: Record<string, number>;
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
    status: string; tallyUp: boolean; pairedAt: string;
    lastSeenAt: string | null; revoked: boolean;
  }[];
  signIns: {
    id: string; phone: string; name: string;
    device: string | null;
    signedInAt: string; expiresAt: string;
    lastSeenAt: string | null; current: boolean;
  }[];
};

export type OutstandingParty = {
  party: string; ledgerName: string; phone: string; creditDays: number;
  totalPaise: number; overduePaise: number; oldestDays: number;
  bills: { ref: string; date: string; dueDate: string; pendingPaise: number; days: number }[];
};

export type Outstanding = {
  kind: string;
  totals: { total: number; overdue: number; buckets: Record<string, number> };
  items: OutstandingParty[];
};

export type Statement = {
  ledger: {
    name: string; parentGroup: string; phone: string; gstin: string;
    creditDays: number; openingPaise: number; closingPaise: number;
  };
  rows: { date: string; vchNo: string; vchType: string; narration: string;
          amountPaise: number; balancePaise: number }[];
};

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

export type UsageLine = {
  key: string; label: string; unit: string; used: number;
  limit: number | null; unlimited: boolean; pct: number; over: boolean; summary: string;
};

export type PlanCard = {
  key: string; label: string; pricePaise: number; blurb: string;
  days: number | null; quoted: boolean;
  limits: Record<string, number | null>;
  features: Record<string, boolean>;
};

export type PaymentRow = {
  id: string; status: 'pending' | 'paid' | 'failed' | 'refunded';
  totalPaise: number; totalLabel: string; failureReason: string;
  paidAt: string | null; createdAt: string; invoiceNumber: string | null;
};

export type Billing = {
  subscription: {
    id: string; plan: string; planLabel: string; status: string; term: string;
    pricePaise: number; priceLabel: string;
    renewsAt: string | null; endsAt: string | null;
    pendingPlanLabel: string | null; cancelAtEnd: boolean;
    graceUntil: string | null; coupon: string | null; message: string;
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

export type KpiPeriod = { from: string; to: string; label: string };

export type Kpis = {
  sales: {
    period: KpiPeriod;
    revenuePaise: number; invoices: number; averageInvoicePaise: number;
    growthPercent: number | null; priorRevenuePaise: number;
    topCustomers: { party: string; amountPaise: number; invoices: number;
                    sharePercent: number }[];
    topProducts: { item: string; amountPaise: number; qty: number }[];
    concentration: { topCustomerPercent: number; topFivePercent: number } | null;
    salespeople: { available: boolean; note: string };
  };
  collection: {
    receivablePaise: number; overduePaise: number; bills: number; overdueBills: number;
    oldestOverdueDays: number;
    collectionRatePercent: number | null; collectionRateNote: string;
    averagePaymentDays: number | null; averagePaymentBasis: string;
    dsoDays: number | null; dsoNote: string;
  };
  purchases: {
    amountPaise: number; bills: number; growthPercent: number | null;
    topSuppliers: { party: string; amountPaise: number; sharePercent: number }[];
    concentration: { topSupplierPercent: number; warning: string } | null;
  };
  inventory: {
    stockValuePaise: number; items: number;
    turnsBySalesValue: number | null; turnoverNote: string;
    deadStock: { count: number; valuePaise: number; sharePercent: number; note: string };
    lowStock: number;
    negativeStock: { count: number; valuePaise: number; note: string };
    fastMoving: { item: string; qty: number; amountPaise: number }[];
  };
  profitability: {
    grossProfitPaise: number; grossMarginPercent: number | null;
    netProfitPaise: number; netMarginPercent: number | null;
    directExpensesPaise: number; indirectExpensesPaise: number;
    otherIncomePaise: number; expenseRatioPercent: number | null;
    basis: string; reliable: boolean;
  };
};

export type Widget = { key: string; label: string; module: string; hint?: string };

export type Preferences = {
  preferences: {
    'dashboard.layout': { order: string[]; hidden: string[]; period: string; compact: boolean };
    'reports.defaults': Record<string, unknown>;
    'app.preferences': { defaultCompany: string; landing: string; density: string };
  };
  dashboard: {
    widgets: Widget[];
    hidden: Widget[];
    period: string;
    compact: boolean;
    catalogue: (Widget & { defaultOn: boolean })[];
  };
  note: string;
};

export type Suggestion = { title: string; detail: string; action: string; href: string };

export type TicketRow = {
  id: string; number: number; subject: string; category: string;
  priority: string; status: string; statusLabel: string;
  createdAt: string; messages: number; lastAt: string | null; rating: number | null;
};

export type HelpPayload = {
  categories: { key: string; label: string }[];
  priorities: { key: string; label: string }[];
  responseHours: Record<string, number>;
  planLabel: string;
  suggestions: Suggestion[];
  faq: { q: string; a: string }[];
  contact: { email: string; whatsapp: string; hours: string; phoneNote: string };
};

export type TicketDetail = {
  ticket: TicketRow;
  messages: { id: string; author: string; from_staff: boolean;
              internal: boolean; body: string; at: string }[];
  suggestions: Suggestion[];
};

export type EntryKind = {
  key: string; label: string; tallyType: string;
  wantsItems: boolean; partySide: 'debit' | 'credit' | null;
};

export type EntryOptions = {
  writesEnabled: boolean;
  kinds: EntryKind[];
  ledgers: { name: string; group: string; balancePaise: number }[];
  items: { name: string; unit: string; salesRatePaise: number;
           purchaseRatePaise: number; gstRateBp: number; inStock: number }[];
  voucherTypes: string[];
  note: string;
};

export type Draft = {
  id: string; kind: string; kindLabel: string;
  number: string | null; tallyNumber: string | null;
  date: string; party: string; narration: string;
  entries: { ledger: string; amountPaise: number }[];
  amountPaise: number;
  status: 'draft' | 'queued' | 'sending' | 'posted' | 'rejected' | 'cancelled';
  statusLabel: string; error: string; createdBy: string; createdAt: string;
  editable: boolean;
};

export type DraftList = { drafts: Draft[]; counts: Record<string, number> };

export type Payer = {
  party: string; bills: number; valuePaise: number; averageDays: number;
  worstDays: number; daysAgainstTerms: number | null; lateBills: number;
  onTimePercent: number; verdict: string;
};

export type Mover = {
  party: string; nowPaise: number; beforePaise: number; changePaise: number;
  changePercent: number | null; firstTime: boolean; stopped: boolean; invoices: number;
};

export type RhythmDay = {
  day: string; short: string; amountPaise: number; invoices: number;
  daysOpen: number; averagePaise: number; sharePercent: number;
};

export type Pulse = {
  payers: { windowDays: number; payers: Payer[]; worst: Payer[]; best: Payer[];
            note: string; basis: string };
  movers: { windowDays: number; comparedWith: string;
            grew: Mover[]; shrank: Mover[]; won: Mover[]; lost: Mover[]; note: string };
  rhythm: { byDay: RhythmDay[]; best: RhythmDay | null; worst: RhythmDay | null;
            closedOn: string[]; summary: string; note: string };
  runway: { cashPaise: number; bankPaise: number; liquidPaise: number;
            monthlyBurnPaise: number; months: number | null;
            monthsWithReceivables: number | null; receivablePaise: number;
            basis: string; tone: 'ok' | 'warn' | 'bad' | 'unknown' };
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
  party: {
    name: string; parentGroup: string; phone: string; email: string;
    gstin: string; creditDays: number; closingPaise: number;
  };
  openBills: { ref: string; billDate: string; dueDate: string;
               amountPaise: number; current: boolean }[];
  itemsBought: { label: string; qty: number; amountPaise: number }[];
  /** Null when nothing has been settled — a new customer has no track record. */
  behaviour: PartyBehaviour | null;
  ageing: PartyAgeing;
};
