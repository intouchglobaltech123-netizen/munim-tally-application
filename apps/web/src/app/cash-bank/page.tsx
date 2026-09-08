'use client';

import Link from 'next/link';
import { Wallet, Landmark, CreditCard, ChevronRight } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useApi } from '../../lib/useApi';
import { inr, shortDate } from '../../lib/api';
import {
  Card, PageTitle, SectionTitle, Spinner, ErrorNote, Empty, OfflineBar, StatTile,
} from '../../components/ui';

/**
 * How much money there actually is.
 *
 * The question no other screen answers: the dashboard shows sales, the balance
 * sheet buries cash under assets, and receivables are money you are owed rather
 * than money you have.
 *
 * Overdraft is listed apart from the total rather than netted into it. It is
 * borrowed money, and a figure that quietly mixes the two tells an owner they
 * are richer than they are.
 */

type CashBank = {
  asOf: string;
  accounts: { name: string; group: string; balancePaise: number;
              kind: 'cash' | 'bank' | 'overdraft' }[];
  cashPaise: number; bankPaise: number; overdraftPaise: number; totalPaise: number;
};

export default function CashBankPage() {
  const { company } = useAuth();
  const { data, error, loading, reload, stale, offline } = useApi<CashBank>(
    company ? `/v1/companies/${encodeURIComponent(company.tallyGuid)}/cash-bank` : null,
    [company?.tallyGuid],
  );

  if (!company) {
    return <Empty title="No company yet" hint="Connect the computer that runs Tally first." />;
  }
  if (error) return <ErrorNote message={error} onRetry={reload} />;
  if (loading || !data) return <Spinner label="Counting your cash…" />;

  const cash = data.accounts.filter((a) => a.kind === 'cash');
  const bank = data.accounts.filter((a) => a.kind === 'bank');
  const od = data.accounts.filter((a) => a.kind === 'overdraft');

  return (
    <>
      <PageTitle
        title="Cash & Bank"
        subtitle={`As Tally last reported, to ${shortDate(data.asOf)}`}
        right={
          <div className="text-right">
            <div className="figure text-2xl font-bold leading-none">
              {inr(data.totalPaise, { compact: true })}
            </div>
            <div className="mt-1 text-xs text-muted">available</div>
          </div>
        }
      />
      <OfflineBar offline={offline} ageMs={stale} />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <StatTile label="Cash in hand" paise={data.cashPaise} icon={Wallet} />
        <StatTile label="In the bank" paise={data.bankPaise} icon={Landmark} />
        <StatTile label="Overdraft used" paise={Math.abs(data.overdraftPaise)}
          icon={CreditCard} tone={data.overdraftPaise !== 0 ? 'bad' : 'neutral'} />
      </div>

      {data.accounts.length === 0 ? (
        <Card>
          <Empty icon={Wallet} title="No cash or bank ledgers"
            hint="Tally reports no accounts under Cash-in-Hand or Bank Accounts." />
        </Card>
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          <AccountList title="Cash" icon={Wallet} rows={cash}
            empty="No cash ledgers in these books." />
          <AccountList title="Bank accounts" icon={Landmark} rows={bank}
            empty="No bank ledgers in these books." />
          {od.length > 0 ? (
            <AccountList title="Overdraft" icon={CreditCard} rows={od}
              empty="" note="borrowed, not yours" />
          ) : null}
        </div>
      )}

      <Card className="mt-5">
        <SectionTitle>Where the money moved</SectionTitle>
        <div className="flex flex-wrap gap-2">
          <Link href="/txn/receipt"
            className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-2
                       text-sm font-semibold transition hover:bg-canvas">
            Receipts <ChevronRight size={13} strokeWidth={2.5} />
          </Link>
          <Link href="/txn/payment"
            className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-2
                       text-sm font-semibold transition hover:bg-canvas">
            Payments <ChevronRight size={13} strokeWidth={2.5} />
          </Link>
          <Link href="/txn/contra"
            className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-2
                       text-sm font-semibold transition hover:bg-canvas">
            Contra <ChevronRight size={13} strokeWidth={2.5} />
          </Link>
        </div>
      </Card>
    </>
  );
}

function AccountList({ title, icon, rows, empty, note }: {
  title: string; icon: typeof Wallet;
  rows: CashBank['accounts']; empty: string; note?: string;
}) {
  return (
    <Card>
      <SectionTitle icon={icon} note={note}>{title}</SectionTitle>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">{empty}</p>
      ) : (
        <ul className="divide-y divide-line-soft">
          {rows.map((a) => (
            <li key={a.name} className="flex items-center gap-3 py-2.5 text-sm">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{a.name}</div>
                <div className="text-xs text-faint">{a.group}</div>
              </div>
              <span className={`figure shrink-0 font-semibold ${
                a.balancePaise < 0 ? 'text-negative' : ''}`}>
                {inr(a.balancePaise)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
