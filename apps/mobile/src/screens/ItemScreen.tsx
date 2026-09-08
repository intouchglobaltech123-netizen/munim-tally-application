import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  Package, ArrowDownLeft, ArrowUpRight, Users, Hash, Layers, CalendarClock,
} from 'lucide-react-native';
import { useApp, useApi } from '../lib/store';
import { useMoney } from '../lib/money';
import { shortDate } from '../lib/format';
import {
  Badge, Card, EmptyState, ErrorNote, Loading, Muted, Screen, Title,
} from '../components/ui';
import { TrendChart, RankBars } from '../components/charts';
import ShareSheet from '../components/ShareSheet';
import { T } from '../theme';

/** One item: what it is, how it moves, and who buys it. */

type Detail = {
  item: {
    name: string; group: string; category: string; unit: string; altUnit: string;
    hsn: string; sac: string; gstRatePct: number;
    openingQty: number; openingValuePaise: number;
    closingQty: number; closingValuePaise: number; ratePaise: number;
    minLevel: number; maxLevel: number; reorderLevel: number;
    status: 'ok' | 'out' | 'negative' | 'reorder';
  };
  movement: { id: string; no: string; type: string; date: string; party: string;
              qty: number; amountPaise: number; direction: 'in' | 'out' }[];
  buyers: { label: string; qty: number; amountPaise: number }[];
  monthly: { at: string; sold: number; bought: number }[];
  batches: { name: string; godown: string; qty: number;
             expiryDate: string | null }[];
};

export default function ItemScreen({ route }: any) {
  const name: string = route.params?.name ?? '';
  const { company } = useApp();
  const money = useMoney();

  const { data, error, loading, reload } = useApi<Detail>(
    company
      ? `/v1/companies/${encodeURIComponent(company.tallyGuid)}/items/${encodeURIComponent(name)}`
      : null,
    [company?.tallyGuid, name]);

  if (error) return <Screen><ErrorNote message={error} onRetry={reload} /></Screen>;
  if (loading && !data) return <Loading label="Loading…" />;
  if (!data) return <Screen><EmptyState title="Not found" icon={Package}
    hint="No such item in this company." /></Screen>;

  const i = data.item;

  return (
    <Screen onRefresh={reload} refreshing={loading} tabBar={false}>
      <Title>{i.name}</Title>
      <Muted>{[i.group, i.category].filter(Boolean).join(' · ') || 'Ungrouped'}</Muted>

      <View style={{ flexDirection: 'row', marginTop: 12 }}>
        <ShareSheet kind="item" subject={i.name} label="Share stock & price" />
      </View>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 9, marginTop: 14 }}>
        <Stat label="In stock" value={`${i.closingQty.toLocaleString('en-IN')} ${i.unit}`}
          tone={i.closingQty < 0 ? T.negative : undefined} />
        <Stat label="Value" value={money(i.closingValuePaise, { compact: true })} />
        <Stat label="Rate per unit" value={i.ratePaise ? money(i.ratePaise) : '—'} />
        <Stat label="Reorder at"
          value={i.reorderLevel > 0 ? `${i.reorderLevel} ${i.unit}` : 'Not set'} />
      </View>

      <Text style={s.section}>Classification</Text>
      <Card>
        <Row k="Unit" v={i.unit} />
        <Row k="Alternate unit" v={i.altUnit} />
        <Row k="HSN" v={i.hsn} />
        <Row k="SAC" v={i.sac} />
        <Row k="GST rate" v={i.gstRatePct > 0 ? `${i.gstRatePct}%` : ''} />
      </Card>

      <Text style={s.section}>Levels</Text>
      <Card>
        <Row k="Opening stock" v={`${i.openingQty} ${i.unit}`} />
        <Row k="Opening value" v={money(i.openingValuePaise)} />
        <Row k="Minimum" v={i.minLevel > 0 ? `${i.minLevel} ${i.unit}` : ''} />
        <Row k="Maximum" v={i.maxLevel > 0 ? `${i.maxLevel} ${i.unit}` : ''} />
      </Card>

      {data.batches.length > 0 ? (
        <>
          <Text style={s.section}>Batches</Text>
          <Card>
            {data.batches.map((b) => {
              const soon = b.expiryDate
                && new Date(b.expiryDate).getTime() - Date.now() < 60 * 86_400_000;
              return (
                <View key={`${b.name}-${b.godown}`} style={s.batch}>
                  <View style={{ flex: 1 }}>
                    <Text style={s.batchName}>{b.name}</Text>
                    {b.godown ? <Text style={s.tiny}>{b.godown}</Text> : null}
                  </View>
                  <Text style={s.batchQty}>{b.qty}</Text>
                  {b.expiryDate
                    ? <Badge tone={soon ? 'bad' : 'ok'}>{shortDate(b.expiryDate)}</Badge>
                    : null}
                </View>
              );
            })}
          </Card>
        </>
      ) : null}

      {data.monthly.length > 1 ? (
        <>
          <Text style={s.section}>Quantity sold</Text>
          <Card>
            <TrendChart data={data.monthly.map((m) => ({ at: m.at, value: m.sold }))}
              money={(v) => String(v)} />
          </Card>
        </>
      ) : null}

      <Text style={s.section}>Who buys it</Text>
      {data.buyers.length === 0 ? (
        <EmptyState title="No buyers yet" icon={Users}
          hint="No sales recorded against this item." />
      ) : (
        <Card>
          <RankBars data={data.buyers.map((b) => ({
            label: `${b.label} (${b.qty})`, value: b.amountPaise }))} money={money} />
        </Card>
      )}

      <Text style={s.section}>Recent movement</Text>
      {data.movement.length === 0 ? (
        <EmptyState title="No movement" icon={Package}
          hint="This item has not appeared on a voucher yet." />
      ) : (
        <Card>
          {data.movement.slice(0, 30).map((m) => (
            <View key={m.id} style={s.move}>
              {m.direction === 'in'
                ? <ArrowDownLeft size={14} color={T.positive} />
                : <ArrowUpRight size={14} color={T.negative} />}
              <View style={{ flex: 1 }}>
                <Text style={s.moveTop}>{m.party || m.type}</Text>
                <Text style={s.tiny}>{m.no} · {shortDate(m.date)}</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={s.moveQty}>{m.qty}</Text>
                <Text style={s.tiny}>{money(m.amountPaise, { compact: true })}</Text>
              </View>
            </View>
          ))}
        </Card>
      )}
    </Screen>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <View style={s.row}>
      <Text style={s.k}>{k}</Text>
      <Text style={[s.v, !v && { color: T.faint, fontFamily: T.font.regular }]}>
        {v || 'Not set in Tally'}
      </Text>
    </View>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <View style={s.stat}>
      <Text style={s.statLabel}>{label}</Text>
      <Text style={[s.statValue, tone ? { color: tone } : null]}>{value}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  section: {
    fontFamily: T.font.bold, fontSize: 13, color: T.muted,
    textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 24, marginBottom: 10,
  },
  stat: {
    flexGrow: 1, flexBasis: '46%', backgroundColor: T.card,
    borderRadius: T.radiusSm, padding: 11, ...T.shadow,
  },
  statLabel: { fontFamily: T.font.medium, fontSize: 10, color: T.muted },
  statValue: { fontFamily: T.font.bold, fontSize: 16, color: T.ink, marginTop: 3 },
  row: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 9, borderTopWidth: 1, borderTopColor: T.lineSoft,
  },
  k: { color: T.muted, fontSize: 13, fontFamily: T.font.regular },
  v: { color: T.ink, fontFamily: T.font.semibold, fontSize: 13 },
  batch: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 9, borderTopWidth: 1, borderTopColor: T.lineSoft,
  },
  batchName: { fontFamily: T.font.semibold, fontSize: 13, color: T.ink },
  batchQty: { fontFamily: T.font.bold, fontSize: 13, color: T.ink },
  move: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 9, borderTopWidth: 1, borderTopColor: T.lineSoft,
  },
  moveTop: { fontFamily: T.font.semibold, fontSize: 13, color: T.ink },
  moveQty: { fontFamily: T.font.bold, fontSize: 13, color: T.ink },
  tiny: { fontFamily: T.font.regular, fontSize: 10, color: T.muted, marginTop: 2 },
});
