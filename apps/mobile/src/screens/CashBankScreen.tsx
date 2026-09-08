import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Wallet, Landmark, CreditCard } from 'lucide-react-native';
import { useApp, useApi } from '../lib/store';
import { inr, shortDate, mask } from '../lib/format';
import {
  Card, EmptyState, ErrorNote, Label, LineRow, Loading, Muted, OfflineBar,
  Screen, StatTile, Title,
} from '../components/ui';
import { T } from '../theme';

/**
 * How much money there actually is.
 *
 * Overdraft is shown apart from the total, never netted into it. It is borrowed
 * money, and a figure that quietly mixes the two tells an owner they are richer
 * than they are.
 */

type CashBank = {
  asOf: string;
  accounts: { name: string; group: string; balancePaise: number;
              kind: 'cash' | 'bank' | 'overdraft' }[];
  cashPaise: number; bankPaise: number; overdraftPaise: number; totalPaise: number;
};

export default function CashBankScreen() {
  const { company, privacy } = useApp();
  const { data, error, loading, reload, stale, offline } = useApi<CashBank>(
    company ? `/v1/companies/${encodeURIComponent(company.tallyGuid)}/cash-bank` : null,
    [company?.tallyGuid],
  );

  const money = (p: number, compact = false) =>
    privacy ? mask(inr(p, { compact })) : inr(p, { compact });

  if (error) return <Screen><ErrorNote message={error} onRetry={reload} /></Screen>;
  if (loading || !data) return <Loading label="Counting your cash…" />;

  const groups: { title: string; kind: CashBank['accounts'][number]['kind'];
                  icon: typeof Wallet }[] = [
    { title: 'Cash', kind: 'cash', icon: Wallet },
    { title: 'Bank accounts', kind: 'bank', icon: Landmark },
    { title: 'Overdraft', kind: 'overdraft', icon: CreditCard },
  ];

  return (
    <Screen onRefresh={reload} refreshing={loading} tabBar={false}>
      <OfflineBar offline={offline} ageMs={stale} />
      <Title>Cash & Bank</Title>
      <Muted>As Tally last reported, to {shortDate(data.asOf)}.</Muted>

      <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
        <StatTile label="Cash in hand" icon={Wallet}
          value={money(data.cashPaise, true)} exact={money(data.cashPaise)} />
        <StatTile label="In the bank" icon={Landmark}
          value={money(data.bankPaise, true)} exact={money(data.bankPaise)} />
      </View>

      {data.overdraftPaise !== 0 ? (
        <View style={{ marginTop: 10 }}>
          <StatTile label="Overdraft used" icon={CreditCard} tone="bad"
            value={money(Math.abs(data.overdraftPaise), true)}
            sub={<Text style={s.sub}>borrowed, not yours</Text>} />
        </View>
      ) : null}

      {data.accounts.length === 0 ? (
        <Card style={{ marginTop: 14 }}>
          <EmptyState icon={Wallet} title="No cash or bank ledgers"
            hint="Tally reports no accounts under Cash-in-Hand or Bank Accounts." />
        </Card>
      ) : groups.map((g) => {
        const rows = data.accounts.filter((a) => a.kind === g.kind);
        if (rows.length === 0) return null;
        const Icon = g.icon;
        return (
          <Card key={g.kind} style={{ marginTop: 14 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 4 }}>
              <Icon size={14} strokeWidth={2.2} color={T.faint} />
              <Label>{g.title}</Label>
            </View>
            {rows.map((a) => (
              <LineRow key={a.name} left={a.name} sub={a.group}
                right={money(a.balancePaise)} danger={a.balancePaise < 0} />
            ))}
          </Card>
        );
      })}
    </Screen>
  );
}

const s = StyleSheet.create({
  sub: { fontSize: 11.5, color: T.muted, fontFamily: T.font.regular },
});
