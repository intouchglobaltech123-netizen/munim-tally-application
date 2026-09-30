'use client';

import { Fragment, useState } from 'react';
import Link from 'next/link';
import { useAuth } from '../lib/auth';
import { useApi } from '../lib/useApi';
import { useMoney } from '../lib/money';
import {
  ago, type Overview, type FilterOptions, type Metric,
  type DashboardLayout, type Preferences,
} from '../lib/api';
import {
  Badge, Card, Empty, ErrorNote, OfflineBar, PageTitle, SectionTitle, Spinner,
  Settling, TileSkeleton,
} from '../components/ui';
import {
  TrendChart, CashFlowChart, RankBars, Donut, Spark, axisMoney,
} from '../components/charts';
import SalesLandscape from '../components/SalesLandscape';
import {
  TrendingUp, TrendingDown, Minus, ShoppingCart, ArrowDownLeft, ArrowUpRight,
  Wallet, Landmark, Package, Receipt, FileWarning, Clock3, Percent, Coins,
  Users, Truck, Boxes, UserCheck, Layers, Filter, X, CalendarRange, Box,
} from 'lucide-react';

/**
 * The whole business on one screen.
 *
 * Ordered the way an owner actually reads it: today first (because that is
 * what they opened the app to see), then the period totals, then the money
 * they are owed, then the trends that explain all of it.
 */

const PERIODS = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
  { key: 'last-month', label: 'Last month' },
  { key: 'quarter', label: 'Quarter' },
  { key: 'year', label: 'Year' },
  { key: 'fy', label: 'Financial year' },
];

export default function DashboardPage() {
  const { me, company, loading } = useAuth();
  const money = useMoney();

  const [period, setPeriod] = useState('fy');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [party, setParty] = useState('');
  const [item, setItem] = useState('');
  const [salesperson, setSalesperson] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  const qs = new URLSearchParams({ period });
  if (period === 'custom') { qs.set('from', from); qs.set('to', to); }
  if (party) qs.set('party', party);
  if (item) qs.set('item', item);
  if (salesperson) qs.set('salesperson', salesperson);

  const base = company ? `/v1/companies/${encodeURIComponent(company.tallyGuid)}` : null;
  const { data, error, loading: busy, refreshing, reload, stale, offline } =
    useApi<Overview>(base && `${base}/overview?${qs}`,
      [company?.tallyGuid, period, from, to, party, item, salesperson]);
  const opts = useApi<FilterOptions>(base && `${base}/filters`, [company?.tallyGuid]);

  /*
   * The layout comes from the server, not from localStorage, so it follows
   * somebody from the shop computer to their phone. A section they have no
   * permission for is dropped server-side rather than merely hidden here -
   * hiding it in the browser would still have shipped them the data.
   */
  const prefs = useApi<Preferences>(
    company ? `/v1/preferences?company=${encodeURIComponent(company.tallyGuid)}` : null,
    [company?.tallyGuid]);

  if (loading) return <Spinner />;

  if (me && me.companies.length === 0) {
    return (
      <>
        <PageTitle title={`Welcome, ${me.org.name}`}
          subtitle="One step left: connect the computer that runs Tally." />
        <Card className="max-w-2xl">
          <p className="text-sm text-body">
            Munim reads your books straight from Tally. Nothing to import, and
            nothing to keep updating by hand.
          </p>
          <Link href="/connect"
            className="mt-5 inline-block rounded-lg bg-brand-700 px-4 py-2 text-sm
                       font-semibold text-white transition hover:bg-brand-800">
            Connect your Tally
          </Link>
          <p className="mt-5 rounded-lg bg-brand-50 px-3 py-2 text-xs text-brand-900">
            Munim <b>reads</b> your Tally data. The only thing it ever writes is
            a voucher you create here and send, and never without an owner
            switching that on first.
          </p>
        </Card>
      </>
    );
  }

  if (error) return <ErrorNote message={error} onRetry={reload} />;
  /*
   * The skeleton is for a first load only. Changing the period or a filter
   * keeps the whole dashboard on screen and greys the figures - see the
   * Settling wrapper around the sections below.
   */
  if (busy && !data) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <TileSkeleton count={8} />
      </div>
    );
  }
  if (!data) return <Empty title="Nothing yet" hint="Connect Tally to see your dashboard." />;

  const m = data.metrics;
  const scoped = !!(party || item || salesperson);

  /*
   * Everything, in file order, until the preferences arrive. A dashboard that
   * renders nothing for a moment reads as broken, and a first paint that shows
   * the default is right for almost everybody anyway.
   */
  const layout: Pick<DashboardLayout, 'widgets'> = prefs.data?.dashboard ?? {
    widgets: ['today', 'trading', 'health', 'money', 'invoices', 'cashflow', 'landscape', 'rankings']
      .map((key) => ({ key, label: key, module: 'dashboard' })),
  };

  /*
   * Each dashboard section, keyed by the name the preferences catalogue uses.
   * Defined here rather than at module scope because every one of them closes
   * over `data`, `money` and the current filters.
   */
  const SECTIONS: Record<string, () => React.ReactNode> = {
    today: () => (
      <>
        {/* Today. First because it is why the app was opened. */}
        <SectionTitle icon={Clock3} note={`as on ${data.asOf}`}>Today</SectionTitle>
        <div className="mb-7 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile label="Sales today" m={m.todaySales} icon={TrendingUp} money={money}
            size="lg" />
          <Tile label="Received today" m={m.todayReceipts} icon={ArrowDownLeft} money={money}
            size="lg" />
          <Tile label="Purchases today" m={m.todayPurchases} icon={ShoppingCart} money={money}
            betterWhen="neutral" />
          <Tile label="Paid today" m={m.todayPayments} icon={ArrowUpRight} money={money}
            betterWhen="neutral" />
        </div>

      </>
    ),
    trading: () => (
      <>
        {/* Trading, for the chosen period. */}
        <SectionTitle icon={TrendingUp} note={data.period.label}>Trading</SectionTitle>
        <div className="mb-7 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile label="Sales" m={m.sales} icon={TrendingUp} money={money}
            size="lg" spark={data.charts.salesTrend} />
          {/*
            * Buying more is not by itself good or bad - a shop restocking before
            * a festival and a shop over-ordering look identical here - so no
            * arrow claims to know which.
            */}
          <Tile label="Purchases" m={m.purchases} icon={ShoppingCart} money={money}
            betterWhen="neutral" spark={data.charts.purchaseTrend} />
          <Tile label="Gross profit" m={m.grossProfit} icon={Percent} money={money}
            size="lg" alert={m.grossProfit.paise < 0} spark={data.charts.profitTrend} />
          <Tile label="Net profit" m={m.netProfit} icon={Coins} money={money}
            alert={m.netProfit.paise < 0} />
        </div>

      </>
    ),
    /*
     * How the business is RUNNING, as opposed to what it holds.
     *
     * Every tile here is a ratio the server computed from the same snapshot as
     * the totals above, so they cannot disagree. These are the numbers an
     * accountant asks for first and no phone app for Tally puts on the front
     * screen: a shop can be selling well, be profitable on paper, and still run
     * out of money because customers take 70 days to pay.
     */
    health: () => (
      <>
        <SectionTitle icon={Clock3} note={data.period.label}>How it is running</SectionTitle>
        <div className="mb-7 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Ratio
            label="Customers take"
            value={m.daysToCollect.days == null ? null : `${m.daysToCollect.days} days`}
            caption={m.daysToCollect.note}
            icon={Clock3}
            /* Beyond two months, money owed is money at risk. */
            alert={(m.daysToCollect.days ?? 0) > 60}
          />
          <Ratio
            label="You pay in"
            value={m.daysToPay.days == null ? null : `${m.daysToPay.days} days`}
            caption={m.daysToPay.note}
            icon={CalendarRange}
          />
          <Ratio
            label="Collected of billed"
            value={m.collectionRate.percent == null ? null : `${m.collectionRate.percent}%`}
            caption={m.collectionRate.note}
            icon={Percent}
            /* Under 80% for a period means the debt pile grew this period. */
            alert={(m.collectionRate.percent ?? 100) < 80}
          />
          <Ratio
            label="Cash lasts"
            value={m.cashRunwayDays.days == null ? null : `${m.cashRunwayDays.days} days`}
            caption={m.cashRunwayDays.note}
            icon={Wallet}
            alert={(m.cashRunwayDays.days ?? 999) < 30}
          />
          <Ratio
            label="Average sale"
            value={money(m.averageSale.paise)}
            caption={`Across ${(m.averageSale.count ?? 0).toLocaleString('en-IN')} sales.`}
            icon={Receipt}
          />
          <Ratio
            label="Sales per day"
            value={money(m.dailyRunRate.paise)}
            caption={m.dailyRunRate.note}
            icon={TrendingUp}
          />
          {/*
            * Against last year, not against last month.
            *
            * A Diwali month beats the month before it every single year, so
            * period-on-period flatters a seasonal business and then frightens
            * it in January. The same dates a year ago is the comparison a shop
            * owner actually makes.
            */}
          <Ratio
            label="Same dates last year"
            value={money(m.salesLastYear.paise)}
            caption={m.salesLastYear.changePct == null
              ? 'No sales in that period last year.'
              : `This period is ${m.salesLastYear.changePct > 0 ? '+' : ''}`
                + `${m.salesLastYear.changePct}% on last year.`}
            icon={CalendarRange}
            alert={(m.salesLastYear.changePct ?? 0) < 0}
          />
          <Ratio
            label="Working capital"
            value={money(m.workingCapital.paise)}
            caption={m.workingCapital.note}
            icon={Coins}
            alert={m.workingCapital.paise < 0}
          />
        </div>
      </>
    ),
    money: () => (
      <>
        {/* Money. */}
        <SectionTitle icon={Wallet} note="what you hold and what you owe">Money</SectionTitle>

        {/*
          * The three figures a shop owner actually asks for, given room.
          *
          * Working capital is computed here rather than fetched: it is
          * receivables plus cash plus bank less payables, and every part of it
          * is already on this screen. It is the number that answers "can I pay
          * for the next load of stock", which none of the others do on their own.
          */}
        <div className="mb-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Tile label="Money owed to you" m={m.receivables} icon={ArrowDownLeft}
            money={money} size="lg" betterWhen="neutral"
            spark={data.charts.receivableTrend} />
          <Tile label="Money you owe" m={m.payables} icon={ArrowUpRight}
            money={money} size="lg" betterWhen="down"
            spark={data.charts.payableTrend} />
          {/*
            * From the server, not computed here.
            *
            * The browser used to do this arithmetic itself and left stock out
            * of it, so the same words meant two different numbers depending on
            * which screen you read. One definition, one place.
            */}
          <Tile label="Working capital" m={m.workingCapital} icon={Coins} money={money}
            size="lg" alert={m.workingCapital.paise < 0} />
        </div>

        <div className="mb-7 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Tile label="Cash in hand" m={m.cash} icon={Wallet} money={money}
            betterWhen="neutral" />
          <Tile label="Bank" m={m.bank} icon={Landmark} money={money}
            betterWhen="neutral" />
          <Tile label="Stock value" m={m.stock} icon={Package} money={money}
            betterWhen="neutral" />
          <Tile label="Expenses" m={m.expenses} icon={Receipt} money={money}
            betterWhen="down" spark={data.charts.expenseTrend} />
          {/*
            * GST net, not two tiles that the reader has to subtract.
            *
            * What gets paid to the government is payable less credit, and that
            * is the number on the challan. The two halves stay in the note for
            * anybody reconciling.
            */}
          <Tile label="GST payable, net" icon={FileWarning} money={money}
            betterWhen="down"
            m={{
              paise: m.gstPayable.paise - m.gstReceivable.paise,
              note: `${money(m.gstPayable.paise)} due less `
                  + `${money(m.gstReceivable.paise)} credit`,
            }} />
        </div>

      </>
    ),
    invoices: () => (
      <>
        {/* Invoices. Counts as well as amounts - "99 overdue" lands differently
            from the rupee figure alone. */}
        <div className="mb-7 grid gap-3 sm:grid-cols-2">
          <Card>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-medium text-muted">Open invoices</div>
                <div className="mt-1 text-2xl font-bold tabular-nums text-ink">
                  {money(m.outstandingInvoices.paise)}
                </div>
                <div className="text-xs text-faint">
                  {m.outstandingInvoices.count} unpaid bills
                </div>
              </div>
              <Receipt size={22} className="text-faint" />
            </div>
          </Card>
          <Card>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs font-medium text-negative">Overdue</div>
                <div className="mt-1 text-2xl font-bold tabular-nums text-negative">
                  {money(m.overdueInvoices.paise)}
                </div>
                <div className="text-xs text-faint">
                  {m.overdueInvoices.count} past their due date
                </div>
              </div>
              <FileWarning size={22} className="text-negative/50" />
            </div>
          </Card>
        </div>

      </>
    ),
    cashflow: () => (
      <>
        {/* Charts. */}
        <SectionTitle icon={Coins} note="money in against money out">Cash flow</SectionTitle>
        <Card className="mb-6">
          <CashFlowChart data={data.charts.cashFlow} money={money} />
          <div className="mt-2 flex gap-4 text-xs text-muted">
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm bg-positive" /> In
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-sm bg-negative" /> Out
            </span>
          </div>
        </Card>

        <div className="mb-6 grid gap-4 lg:grid-cols-2">
          <ChartCard title="Sales trend" icon={TrendingUp}>
            <TrendChart data={data.charts.salesTrend} money={money} />
          </ChartCard>
          <ChartCard title="Purchase trend" icon={ShoppingCart}>
            <TrendChart data={data.charts.purchaseTrend} colour="#0B5A8A" money={money} />
          </ChartCard>
          <ChartCard title="Profit trend" icon={Percent}>
            <TrendChart data={data.charts.profitTrend} colour="#C9A227" money={money} />
          </ChartCard>
          <ChartCard title="Payments out" icon={Receipt}>
            <TrendChart data={data.charts.expenseTrend} colour="#B3261E" money={money} />
          </ChartCard>
        </div>

      </>
    ),
    landscape: () => (
      <>
        <SectionTitle icon={Box} note="months across, customers back, sales up">
          Sales landscape
        </SectionTitle>
        <Card className="mb-6">
          <SalesLandscape cells={data.landscape.cells} months={data.landscape.months}
            parties={data.landscape.parties} money={money} />
        </Card>

      </>
    ),
    rankings: () => (
      <>
        <div className="mb-6 grid gap-4 lg:grid-cols-2">
          <ChartCard title="Top customers" icon={Users}>
            <RankBars data={data.charts.topCustomers} money={money} />
          </ChartCard>
          <ChartCard title="Top suppliers" icon={Truck}>
            <RankBars data={data.charts.topSuppliers} colour="#0B5A8A" money={money} />
          </ChartCard>
          <ChartCard title="Top products" icon={Boxes}>
            <RankBars data={data.charts.topProducts} colour="#C9A227" money={money} />
          </ChartCard>
          <ChartCard title="Salesperson performance" icon={UserCheck}>
            {data.charts.salespeople.length === 0 ? (
              <p className="py-6 text-center text-xs text-faint">
                Mark people as salespeople in Users &amp; roles, and set the name
                Tally writes in the narration.
              </p>
            ) : (
              <RankBars data={data.charts.salespeople} colour="#6FA82B" money={money} />
            )}
          </ChartCard>
        </div>

        <ChartCard title="Sales by category" icon={Layers}>
          <Donut data={data.charts.categories} money={money} />
        </ChartCard>
      </>
    ),
  };

  return (
    <>
      <PageTitle
        title={data.company.name}
        subtitle={`${data.period.label} · ${data.period.from} to ${data.period.to} · books to ${data.asOf}`}
      />
      <OfflineBar offline={offline} ageMs={stale} />

      {/* Filters. Period first because it is the one people change constantly. */}
      <div className="mb-6 space-y-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {PERIODS.map((p) => (
            <button key={p.key} onClick={() => setPeriod(p.key)}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                period === p.key ? 'bg-brand-700 text-white'
                                 : 'bg-line-soft text-body hover:bg-line'}`}>
              {p.label}
            </button>
          ))}
          <button onClick={() => setPeriod('custom')}
            className={`inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs
                        font-semibold transition ${
              period === 'custom' ? 'bg-brand-700 text-white'
                                  : 'bg-line-soft text-body hover:bg-line'}`}>
            <CalendarRange size={13} /> Custom
          </button>
          <button onClick={() => setShowFilters(!showFilters)}
            className={`inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs
                        font-semibold transition ${
              scoped ? 'bg-warn text-white' : 'bg-line-soft text-body hover:bg-line'}`}>
            <Filter size={13} /> {scoped ? 'Filtered' : 'Filter'}
          </button>
        </div>

        {period === 'custom' && (
          <div className="flex flex-wrap items-center gap-2">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
              className="rounded-lg border border-line px-3 py-1.5 text-sm" />
            <span className="text-sm text-faint">to</span>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)}
              className="rounded-lg border border-line px-3 py-1.5 text-sm" />
          </div>
        )}

        {showFilters && (
          <Card>
            <div className="grid gap-3 sm:grid-cols-3">
              <Picker label="Customer or supplier" value={party} onChange={setParty}
                options={opts.data?.parties ?? []} />
              <Picker label="Item" value={item} onChange={setItem}
                options={opts.data?.items ?? []} />
              <Picker label="Salesperson" value={salesperson} onChange={setSalesperson}
                options={opts.data?.salespeople ?? []} />
            </div>
            {scoped && (
              <button onClick={() => { setParty(''); setItem(''); setSalesperson(''); }}
                className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-negative">
                <X size={13} /> Clear filters
              </button>
            )}
          </Card>
        )}
      </div>


      {/*
        * Rendered in the order this person chose, not the order this file
        * happens to be written in.
        *
        * The layout comes from the server rather than from localStorage, so
        * it follows somebody from the shop computer to their phone - and so
        * a section they cannot see is dropped server-side rather than merely
        * hidden here, which would still ship them the data.
        */}
      <Settling when={refreshing}>
        {layout.widgets.map((w) => {
          const render = SECTIONS[w.key];
          return render ? <Fragment key={w.key}>{render()}</Fragment> : null;
        })}
      </Settling>
    </>
  );
}

/**
 * One figure.
 *
 * Three deliberate rules, and the first two are what separate this from the
 * version it replaced:
 *
 *  1. THE FIGURE IS ALWAYS INK. It used to be painted green for "Sales" and red
 *     for "Payables" from a static prop - so the colour said nothing except
 *     which row of the file the tile was declared in. Sales of zero were still
 *     green. A wall of coloured numbers reads as decoration, and once every
 *     figure is coloured, none of them can raise an alarm.
 *
 *  2. COLOUR MEANS A STATE, and only the small text carries it: the change
 *     against the previous period, or a genuine problem (money overdue, a loss).
 *     That is the whole status vocabulary, so when something IS red it is worth
 *     looking at.
 *
 *  3. Whether a rise is good depends on the measure. Sales up is good; expenses
 *     up is not. `betterWhen` says which, so the arrow and its colour tell the
 *     truth instead of assuming every increase is progress.
 */
/**
 * A tile for a figure that is not money: days, a percentage, a comparison.
 *
 * Separate from Tile rather than another flag on it, because everything Tile
 * does - the trend arrow, the sparkline, better-when-up - is meaningless for
 * "45 days" and would have to be switched off one prop at a time.
 *
 * A null value prints an em dash and says why underneath. The alternative is
 * printing 0, which reads as a fact and is a lie.
 */
function Ratio({ label, value, caption, icon: Icon, alert }: {
  label: string;
  value: string | null;
  caption?: string;
  icon: typeof TrendingUp;
  alert?: boolean;
}) {
  return (
    <Card className={alert && value ? 'border-negative/30' : undefined}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold uppercase tracking-[0.07em] text-muted">
            {label}
          </div>
          <div className={`figure mt-1.5 truncate text-[22px] font-bold leading-none tabular-nums ${
            value == null ? 'text-faint' : alert ? 'text-negative' : 'text-ink'
          }`}>
            {value ?? '\u2014'}
          </div>
          {caption && (
            <div className="mt-2 text-xs leading-snug text-faint">
              {value == null ? 'Not enough trade in this period to say.' : caption}
            </div>
          )}
        </div>
        <span className="rounded-lg bg-canvas p-1.5 text-muted"><Icon size={15} /></span>
      </div>
    </Card>
  );
}

function Tile({ label, m, icon: Icon, money, spark, size = 'md', betterWhen = 'up', alert }: {
  label: string;
  m: Metric;
  icon: typeof TrendingUp;
  money: (p: number) => string;
  spark?: { at: string; value: number }[];
  size?: 'lg' | 'md';
  betterWhen?: 'up' | 'down' | 'neutral';
  /** A real problem worth colouring the figure for - overdue money, a loss. */
  alert?: boolean;
}) {
  const flat = m.changePct == null || m.changePct === 0;
  const up = (m.changePct ?? 0) > 0;
  const Delta = flat ? Minus : up ? TrendingUp : TrendingDown;

  const good = betterWhen === 'neutral' ? null : betterWhen === 'up' ? up : !up;
  const deltaTone = flat || good === null ? 'text-muted'
    : good ? 'text-positive' : 'text-negative';

  return (
    <Card className={alert ? 'border-negative/30' : undefined}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold uppercase tracking-[0.07em] text-muted">
            {label}
          </div>
          <div
            className={`figure mt-1.5 truncate font-bold leading-none tabular-nums ${
              size === 'lg' ? 'text-[30px]' : 'text-[22px]'
            } ${alert ? 'text-negative' : 'text-ink'}`}
            title={money(m.paise)}
          >
            {money(m.paise)}
          </div>

          {m.changePct != null && (
            <div className={`mt-2 flex items-center gap-1 text-xs font-semibold ${deltaTone}`}>
              <Delta size={12} strokeWidth={2.5} />
              {m.changePct > 0 ? '+' : ''}{m.changePct}%
              <span className="font-normal text-faint">vs previous</span>
            </div>
          )}
          {m.count != null && m.changePct == null && (
            <div className="mt-2 text-xs text-faint">
              {m.count.toLocaleString('en-IN')} {m.count === 1 ? 'entry' : 'entries'}
            </div>
          )}
          {m.note && (
            <div className="mt-1.5 text-[11px] leading-snug text-faint">{m.note}</div>
          )}
        </div>

        <Icon size={16} strokeWidth={2} className="mt-0.5 shrink-0 text-faint" />
      </div>

      {spark && spark.length > 1 && (
        <div className="mt-3">
          {/*
            * The sparkline takes the brand hue regardless of direction.
            *
            * Colouring the line by whether the trend is up would put a second,
            * louder answer next to the delta that already says so - and they
            * disagree the moment a falling expense is a good thing.
            */}
          <Spark data={spark} colour="var(--color-brand-600)" />
        </div>
      )}
    </Card>
  );
}

function ChartCard({ title, icon: Icon, children }: {
  title: string; icon: typeof TrendingUp; children: React.ReactNode;
}) {
  return (
    <Card>
      <div className="mb-3 flex items-center gap-2">
        <Icon size={15} className="text-faint" />
        <h3 className="text-sm font-semibold text-body">{title}</h3>
      </div>
      {children}
    </Card>
  );
}

/** A searchable list, because a shop can have hundreds of parties. */
function Picker({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void; options: string[];
}) {
  return (
    <div>
      <label className="text-xs font-semibold text-body">{label}</label>
      <input list={`opt-${label}`} value={value} onChange={(e) => onChange(e.target.value)}
        placeholder="Everything"
        className="mt-1 w-full rounded-lg border border-line px-3 py-2 text-sm
                   outline-none focus:border-brand-500" />
      <datalist id={`opt-${label}`}>
        {options.slice(0, 500).map((o) => <option key={o} value={o} />)}
      </datalist>
    </div>
  );
}
