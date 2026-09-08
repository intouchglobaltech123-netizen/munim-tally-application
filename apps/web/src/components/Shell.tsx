'use client';

import { useState } from 'react';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import NotificationBell from './NotificationBell';
import GlobalSearch from './GlobalSearch';
import {
  LayoutDashboard, Users, FileBarChart, MessageSquare, Settings,
  Building2, Server, KeyRound, Gauge, TrendingUp, ShoppingCart, Wallet,
  Package, ChevronDown, Lightbulb, RefreshCw, ShieldCheck, UsersRound, Hash, Receipt, FileText, Database, ScrollText, LifeBuoy, CreditCard, Activity, PieChart, FilePlus2,
} from 'lucide-react';

type NavLeaf = { href: string; label: string };
type NavItem = {
  href?: string;
  label: string;
  icon: typeof LayoutDashboard;
  feature?: string;
  children?: NavLeaf[];
};
import { useAuth } from '../lib/auth';
import { ago } from '../lib/api';

/*
 * Hints removed from the sidebar.
 *
 * Two lines per item on eight items is sixteen lines of text competing with the
 * page itself, and "Today at a glance" tells nobody anything they did not
 * already know from the word Dashboard. An icon and one word reads faster.
 */
/*
 * Grouped navigation.
 *
 * A flat list of eight links was fine when there were eight screens. With
 * sales, purchases, receipts, payments, cash, bank, parties, items and a dozen
 * reports it becomes a wall - so related things collapse under one heading,
 * the way an accountant already thinks about them.
 *
 * Only one group is open at a time. Two open groups push everything else off
 * the screen, which is the problem this was meant to solve.
 */
/*
 * Grouped navigation, modelled on how an accountant already files things.
 *
 * This list had grown to twenty-two entries in one column - every screen added
 * over the last few sections went in at the top level, and a sidebar you have
 * to read rather than scan is the single loudest signal that a tool was
 * assembled rather than designed.
 *
 * Ten entries, and only one group open at a time. The rule for what earns top
 * level is simple: things opened daily are flat, things opened when something
 * needs configuring are grouped. Dashboard is flat because it is why the app
 * gets opened; Parties and Items are flat because a shopkeeper looks somebody
 * up mid-conversation.
 */
const CUSTOMER_NAV: NavItem[] = [
  { href: '/', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/entry', label: 'New entry', icon: FilePlus2 },

  {
    label: 'Sales', icon: TrendingUp, feature: 'reports',
    children: [
      { href: '/txn/sales', label: 'Sales' },
      { href: '/txn/credit-note', label: 'Credit notes' },
      { href: '/txn/receipt', label: 'Receipts' },
      { href: '/outstanding?kind=receivable', label: 'Receivables' },
    ],
  },
  {
    label: 'Purchase', icon: ShoppingCart, feature: 'reports',
    children: [
      { href: '/txn/purchase', label: 'Purchases' },
      { href: '/txn/debit-note', label: 'Debit notes' },
      { href: '/txn/payment', label: 'Payments' },
      { href: '/outstanding?kind=payable', label: 'Payables' },
    ],
  },
  {
    label: 'Cash & bank', icon: Wallet, feature: 'reports',
    children: [
      { href: '/cash-bank', label: 'Balances' },
      { href: '/txn/contra', label: 'Contra' },
      { href: '/txn/journal', label: 'Journal' },
    ],
  },

  { href: '/parties', label: 'Parties', icon: Users },
  { href: '/items', label: 'Items & stock', icon: Package, feature: 'stock' },

  {
    label: 'Reports', icon: FileBarChart, feature: 'reports',
    children: [
      { href: '/reports', label: 'All reports' },
      { href: '/kpi', label: 'Key numbers' },
      { href: '/insights', label: 'Insights' },
      { href: '/pulse', label: 'Pulse' },
      { href: '/gst', label: 'GST' },
    ],
  },
  {
    label: 'Collections', icon: MessageSquare, feature: 'reminders',
    children: [
      { href: '/outstanding', label: 'Outstanding' },
      { href: '/reminders', label: 'Reminders' },
    ],
  },

  {
    label: 'Setup', icon: Settings,
    children: [
      { href: '/companies', label: 'Companies' },
      { href: '/connect', label: 'Connect Tally' },
      { href: '/sync', label: 'Sync' },
      { href: '/devices', label: 'Devices' },
      { href: '/users', label: 'Users & roles' },
      { href: '/numbering', label: 'Invoice numbering' },
      { href: '/document', label: 'Document design' },
      { href: '/customise', label: 'Customise' },
      { href: '/settings', label: 'Settings' },
    ],
  },
  {
    label: 'Safety', icon: ShieldCheck,
    children: [
      { href: '/security', label: 'Security' },
      { href: '/backup', label: 'Backup' },
      { href: '/audit', label: 'Audit log' },
      { href: '/account', label: 'Account' },
    ],
  },
  {
    label: 'Account', icon: CreditCard,
    children: [
      { href: '/billing', label: 'Plan & billing' },
      { href: '/developer', label: 'Developers' },
      { href: '/partner', label: 'Partner programme' },
      { href: '/help', label: 'Help' },
    ],
  },
];

const ADMIN_NAV: NavItem[] = [
  { href: '/admin', label: 'Platform', icon: Gauge },
  { href: '/admin/metrics', label: 'Metrics', icon: Activity },
  { href: '/admin/orgs', label: 'Businesses', icon: Building2 },
  { href: '/admin/connectors', label: 'Fleet', icon: Server },
  { href: '/admin/licences', label: 'Licences', icon: KeyRound },
];

export default function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const { me, company, setCompanyGuid, signOut } = useAuth();

  /*
   * EVERY hook runs before the first early return, without exception.
   *
   * This useState used to sit below the `/login` check. That meant Shell called
   * two hooks on the login page and three everywhere else, and React matches
   * hooks positionally: on the first navigation after signing in, the hook list
   * changed length and React's state fell out of step with the component.
   *
   * The symptom was not a crash. It was clicks that did nothing - a stale
   * handler bound to a fiber React had already moved past - until enough
   * re-renders happened to realign it, which is why it "worked on the third or
   * fourth click". Anything conditional belongs below this line, never a hook.
   */
  const [openGroup, setOpenGroup] = useState<string | null>(null);

  // Login and onboarding are full-page: no sidebar, nothing to navigate to yet.
  if (path === '/login' || path === '/onboarding') return <>{children}</>;
  const isAdminArea = path.startsWith('/admin');

  /*
   * Only show what this customer actually has.
   *
   * Not a security boundary - every route checks the same values server-side.
   * This is so a customer who has not bought reminders never sees a link that
   * leads to a wall, which is worse than not offering it at all.
   */
  const nav = isAdminArea
    ? ADMIN_NAV
    : CUSTOMER_NAV.filter((item) =>
        !item.feature || me?.features?.[item.feature] !== false);

  /*
   * The sidebar stays put; only the page scrolls.
   *
   * `min-h-screen` on the grid let the whole page scroll as one, so navigation
   * slid away as soon as a report ran past the fold - and getting back to it
   * meant scrolling to the top first. Pinning the height to the viewport and
   * giving each column its own overflow is what makes this behave like an
   * application rather than a long document.
   *
   * Desktop only. On a phone the sidebar stacks above the content, so a fixed
   * viewport height would hand the whole screen to navigation and leave the
   * page unreachable - there, ordinary document scrolling is correct.
   */
  return (
    <div className="grid min-h-screen grid-cols-1 md:h-screen md:grid-cols-[248px_1fr] md:overflow-hidden">
      <aside className={`flex flex-col p-6 text-white md:overflow-y-auto ${
        isAdminArea
          ? 'bg-gradient-to-b from-ink to-body'
          : 'bg-gradient-to-b from-brand-800 to-brand-600'}`}>
        <div className="mb-1 flex items-center gap-2.5">
          <span className={`grid h-8 w-8 place-items-center rounded-lg bg-white text-lg font-extrabold ${
            isAdminArea ? 'text-ink' : 'text-brand-700'}`}>M</span>
          <span className="text-xl font-bold tracking-tight">Munim</span>
        </div>
        <p className="mb-7 ml-11 text-xs text-white/70">
          {isAdminArea ? 'Operator console' : 'Tally on your mobile'}
        </p>

        {!isAdminArea && me && me.companies.length > 0 ? (
          <label className="mb-6 block">
            <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-white/60">
              Company
            </span>
            <select
              value={company?.tallyGuid ?? ''}
              onChange={(e) => setCompanyGuid(e.target.value)}
              className="w-full rounded-lg border border-white/25 bg-white/15 px-2.5 py-2 text-sm font-medium text-white outline-none"
            >
              {me.companies.map((c) => (
                <option key={c.tallyGuid} value={c.tallyGuid} className="text-ink">
                  {c.name}
                </option>
              ))}
            </select>
            {/* Freshness on every screen: a number without a timestamp is not trusted. */}
            <span className="mt-1.5 block text-[11px] text-white/60">
              Synced {ago(company?.lastSyncAt)}
            </span>
          </label>
        ) : null}

        <nav className="flex flex-col gap-0.5">
          {nav.map((item) => {
            const Icon = item.icon;

            if (item.children) {
              // Open when you are inside it, or when you opened it by hand.
              const inside = item.children.some((c) => path.startsWith(c.href.split('?')[0]));
              const isOpen = openGroup === item.label || (openGroup === null && inside);
              return (
                <div key={item.label}>
                  <button
                    onClick={() => setOpenGroup(isOpen ? '' : item.label)}
                    className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm
                                font-semibold transition ${
                      inside ? 'text-white' : 'text-white/70 hover:bg-white/10 hover:text-white'}`}>
                    <Icon size={17} strokeWidth={2.1} className="shrink-0" />
                    <span className="flex-1 text-left">{item.label}</span>
                    <ChevronDown size={14} strokeWidth={2.4}
                      className={`shrink-0 transition-transform ${isOpen ? '' : '-rotate-90'}`} />
                  </button>

                  {isOpen ? (
                    <div className="mb-1 ml-[30px] flex flex-col border-l border-white/15 pl-3">
                      {item.children.map((c) => {
                        const on = path === c.href.split('?')[0]
                          || path.startsWith(`${c.href.split('?')[0]}/`);
                        return (
                          <Link key={c.href} href={c.href}
                            className={`rounded-lg px-2.5 py-2 text-[13px] font-medium transition ${
                              on ? 'bg-white/20 text-white'
                                 : 'text-white/60 hover:bg-white/10 hover:text-white'}`}>
                            {c.label}
                          </Link>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              );
            }

            const href = item.href!;
            const active = href === path
              || (href !== '/' && href !== '/admin' && path.startsWith(href));
            return (
              <Link key={href} href={href}
                className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm
                            font-semibold transition ${
                  active
                    ? 'bg-white/20 text-white'
                    : 'text-white/70 hover:bg-white/10 hover:text-white'}`}>
                <Icon size={17} strokeWidth={2.1} className="shrink-0" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto pt-6 text-xs text-white/60">
          {me ? (
            <>
              <p className="font-semibold text-white/90">{me.org.name}</p>
              <p>{me.user.phone}</p>
              {/* Staff can cross over; customers never see this link. */}
              {me.user.role === 'platform_admin' ? (
                <Link href={isAdminArea ? '/' : '/admin'}
                  className="mt-2 inline-block underline hover:text-white">
                  {isAdminArea ? 'Customer view' : 'Operator console'}
                </Link>
              ) : null}
              <button onClick={signOut} className="mt-2 block underline hover:text-white">
                Sign out
              </button>
            </>
          ) : null}
        </div>
      </aside>

      {/* Its own scroll container, so the sidebar is always one click away.
          The inner max-width keeps line lengths readable on a wide monitor -
          a table stretched to 2560px is unreadable. */}
      <main className="p-6 md:overflow-y-auto md:overscroll-contain md:p-9">
        <div className="mx-auto max-w-[1400px]">
          {/* Sits above the page rather than inside the sidebar: the sidebar
              scrolls out of reach on a phone, and this is the one control that
              has to be reachable from every screen. */}
          <div className="no-print mb-2 flex items-center justify-end gap-2">
            <GlobalSearch />
            <NotificationBell />
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
