import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  Package, Scale, Receipt, Share2, MessageCircle, Mail, CheckCircle2,
  Clock3, AlertTriangle, ArrowLeftRight, Info, FileText,
} from 'lucide-react-native';
import { documentText, shareText, shareOnWhatsApp, shareByEmail } from '../lib/share';
import { useApp, useApi } from '../lib/store';
import { inr, shortDate, mask } from '../lib/format';
import {
  Badge, Card, EmptyState, ErrorNote, Label, LineRow, Loading, Muted,
  OfflineBar, Screen, Title,
} from '../components/ui';
import { T } from '../theme';

/**
 * One voucher, in full.
 *
 * The same three parts as the web: what was sold, what tax was charged, which
 * ledgers moved. The ledger postings are shown rather than hidden - they are
 * the actual accounting entry, and the accountant a shop owner forwards this to
 * will look for them first.
 */

type Detail = {
  id: string; vchNo: string; vchType: string; date: string;
  party: string; narration: string; amountPaise: number; isCancelled: boolean;
  items: { name: string; qty: number; ratePaise: number; amountPaise: number }[];
  entries: { ledger: string; amountPaise: number; side: 'debit' | 'credit' }[];
  taxes: { label: string; amountPaise: number }[];
  roundOffPaise: number;
  bills: { ref: string; billDate: string; dueDate: string | null;
           amountPaise: number; type: string }[];
  isCommitment: boolean;
  paymentStatus: 'paid' | 'part-paid' | 'unpaid' | null;
  outstandingPaise: number | null;
  paidPaise: number | null;
  against: { kind: 'against-invoice' | 'advance'; invoices: string[]; multiple: boolean } | null;
  contra: { from: string; to: string; label: string } | null;
};

const PAID = {
  paid: { bg: T.positiveSoft, fg: T.positive, label: 'Paid in full', Icon: CheckCircle2 },
  'part-paid': { bg: T.warnSoft, fg: T.warn, label: 'Part paid', Icon: Clock3 },
  unpaid: { bg: T.negativeSoft, fg: T.negative, label: 'Unpaid', Icon: AlertTriangle },
} as const;

export default function VoucherScreen({ route, navigation }: any) {
  const { section, id } = route.params ?? {};
  const { company, privacy } = useApp();

  const { data, error, loading, reload, stale, offline } = useApi<Detail>(
    company ? `/v1/companies/${encodeURIComponent(company.tallyGuid)}/txn/${section}/${id}` : null,
    [id],
  );

  const money = (p: number) => (privacy ? mask(inr(p)) : inr(p));

  if (error) return <Screen><ErrorNote message={error} onRetry={reload} /></Screen>;
  if (loading || !data) return <Loading label="Opening voucher…" />;

  const doc = data;

  /*
   * The document as text.
   *
   * Written to be readable on its own: somebody receiving this on WhatsApp
   * should be able to act on it without opening anything.
   */
  const asText = () => documentText({
    company: company?.name ?? 'Munim',
    title: `${doc.vchType} #${doc.vchNo} · ${shortDate(doc.date)}`,
    lines: [
      doc.party ? `Party: ${doc.party}` : '',
      ...doc.items.map((i) => `${i.name} — ${i.qty} × ${inr(i.ratePaise)} = ${inr(i.amountPaise)}`),
      ...(doc.taxes.length ? [`Tax: ${inr(doc.taxes.reduce((n, t) => n + t.amountPaise, 0))}`] : []),
      `Total: ${inr(doc.amountPaise)}`,
      ...(doc.paymentStatus === 'unpaid' || doc.paymentStatus === 'part-paid'
        ? [`Outstanding: ${inr(doc.outstandingPaise ?? 0)}`] : []),
      ...doc.bills.map((b) => `Bill ${b.ref}${b.dueDate ? ` · due ${shortDate(b.dueDate)}` : ''}`),
    ].filter(Boolean),
    footer: 'Sent from Munim',
  });

  const itemsTotal = data.items.reduce((n, i) => n + i.amountPaise, 0);
  const taxTotal = data.taxes.reduce((n, t) => n + t.amountPaise, 0);

  return (
    <Screen onRefresh={reload} refreshing={loading} tabBar={false}>
      <OfflineBar offline={offline} ageMs={stale} />

      {/* Sharing is a hand-off to the phone's own apps: it sends from the
          shop's own number, which is what a customer recognises. */}
      <View style={s.actions}>
        <Action Icon={MessageCircle} label="WhatsApp" primary
          onPress={() => shareOnWhatsApp(asText())} />
        <Action Icon={Mail} label="Email"
          onPress={() => shareByEmail(`${doc.vchType} #${doc.vchNo}`, asText())} />
        <Action Icon={Share2} label="Share"
          onPress={() => shareText(`${doc.vchType} #${doc.vchNo}`, asText())} />
        {/* The printable document, with the letterhead and tax split. */}
        <Action Icon={FileText} label="Invoice"
          onPress={() => navigation.navigate('Invoice', { id: doc.id })} />
      </View>

      {doc.paymentStatus ? (
        <View style={[s.status, { backgroundColor: PAID[doc.paymentStatus].bg }]}>
          {(() => { const I = PAID[doc.paymentStatus!].Icon;
            return <I size={17} color={PAID[doc.paymentStatus!].fg} />; })()}
          <View style={{ flex: 1 }}>
            <Text style={[s.statusTitle, { color: PAID[doc.paymentStatus].fg }]}>
              {PAID[doc.paymentStatus].label}
            </Text>
            {doc.paymentStatus !== 'paid' ? (
              <Text style={s.statusBody}>
                {money(doc.paidPaise ?? 0)} received of {money(doc.amountPaise)} ·{' '}
                {money(doc.outstandingPaise ?? 0)} outstanding
              </Text>
            ) : null}
          </View>
        </View>
      ) : null}

      {doc.isCommitment ? (
        <View style={[s.status, { backgroundColor: T.greenSoft }]}>
          <Info size={16} color={T.greenDark} />
          <Text style={[s.statusBody, { flex: 1, color: T.greenDark }]}>
            This is an order, not an invoice — a commitment to trade. It is not
            counted in sales or profit until it becomes an invoice in Tally.
          </Text>
        </View>
      ) : null}

      {doc.against ? (
        <View style={[s.status, { backgroundColor: T.lineSoft }]}>
          <Receipt size={15} color={T.muted} />
          <Text style={[s.statusBody, { flex: 1 }]}>
            {doc.against.kind === 'advance'
              ? 'Advance — money taken before any bill was raised.'
              : `Settles ${doc.against.multiple ? 'invoices' : 'invoice'} ${doc.against.invoices.join(', ')}.`}
          </Text>
        </View>
      ) : null}

      {doc.contra?.label ? (
        <View style={[s.status, { backgroundColor: T.lineSoft }]}>
          <ArrowLeftRight size={15} color={T.muted} />
          <Text style={[s.statusTitle, { color: T.ink }]}>{doc.contra.label}</Text>
        </View>
      ) : null}

      <Title>{data.party || data.vchType}</Title>
      <Muted>{data.vchType} · #{data.vchNo} · {shortDate(data.date)}</Muted>

      <Card style={{ marginTop: 14 }}>
        <Label>Gross total</Label>
        <Text style={s.total}>{money(data.amountPaise)}</Text>
        {data.isCancelled ? (
          <View style={{ marginTop: 10, flexDirection: 'row' }}>
            <Badge tone="bad">Cancelled in Tally</Badge>
          </View>
        ) : null}
        {data.narration ? <Text style={s.narration}>{data.narration}</Text> : null}
      </Card>

      <Card style={{ marginTop: 14 }}>
        <View style={s.cardHead}>
          <Package size={14} strokeWidth={2.2} color={T.faint} />
          <Label>Items</Label>
        </View>
        {data.items.length === 0 ? (
          <Muted>
            This voucher posts straight to ledgers — Tally records no stock
            against it.
          </Muted>
        ) : (
          <>
            {data.items.map((i, n) => (
              <LineRow key={`${i.name}-${n}`}
                left={i.name}
                sub={i.qty ? `${i.qty} × ${money(i.ratePaise)}` : undefined}
                right={money(i.amountPaise)} />
            ))}
            <LineRow strong left="Total" right={money(itemsTotal)} />
          </>
        )}
      </Card>

      <Card style={{ marginTop: 14 }}>
        <View style={s.cardHead}>
          <Receipt size={14} strokeWidth={2.2} color={T.faint} />
          <Label>Summary</Label>
        </View>
        <LineRow left="Items" right={money(itemsTotal)} />
        {data.taxes.map((t) => (
          <LineRow key={t.label} left={t.label} right={money(t.amountPaise)} />
        ))}
        {data.roundOffPaise !== 0
          ? <LineRow left="Round off" right={money(data.roundOffPaise)} /> : null}
        {taxTotal > 0 ? <LineRow left="Total tax" right={money(taxTotal)} /> : null}
        <LineRow strong left="Gross total" right={money(data.amountPaise)} />
        {data.taxes.length === 0 ? (
          <Text style={s.note}>
            No tax ledgers on this voucher. If your books charge GST, the tax
            appears here automatically.
          </Text>
        ) : null}
      </Card>

      <Card style={{ marginTop: 14 }}>
        <View style={s.cardHead}>
          <Scale size={14} strokeWidth={2.2} color={T.faint} />
          <Label>Ledger postings</Label>
        </View>
        {data.entries.map((e, n) => (
          <View key={`${e.ledger}-${n}`} style={s.entry}>
            <Text style={s.entryName} numberOfLines={1}>{e.ledger}</Text>
            <View style={[s.tag, e.side === 'debit' ? s.tagDr : s.tagCr]}>
              <Text style={[s.tagText, { color: e.side === 'debit' ? T.info : T.gold }]}>
                {e.side === 'debit' ? 'DR' : 'CR'}
              </Text>
            </View>
            <Text style={s.entryAmount}>{money(Math.abs(e.amountPaise))}</Text>
          </View>
        ))}
      </Card>

      {data.bills.length > 0 ? (
        <Card style={{ marginTop: 14 }}>
          <Label>Against bills</Label>
          {data.bills.map((b, n) => (
            <LineRow key={`${b.ref}-${n}`}
              left={b.ref || '—'}
              sub={`${b.type}${b.dueDate ? ` · due ${shortDate(b.dueDate)}` : ''}`}
              right={money(Math.abs(b.amountPaise))} />
          ))}
        </Card>
      ) : null}
    </Screen>
  );
}

const s = StyleSheet.create({
  actions: { flexDirection: 'row', gap: 8, marginBottom: 14, flexWrap: 'wrap' },
  action: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: T.lineSoft, borderRadius: T.radiusSm,
    paddingHorizontal: 13, paddingVertical: 10,
  },
  actionPrimary: { backgroundColor: T.green },
  actionText: { fontFamily: T.font.semibold, fontSize: 13, color: T.inkSoft },
  status: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: T.radiusSm, padding: 13, marginBottom: 12,
  },
  statusTitle: { fontFamily: T.font.semibold, fontSize: 14 },
  statusBody: { fontFamily: T.font.regular, fontSize: 12, color: T.inkSoft, lineHeight: 17, marginTop: 2 },
  total: { fontSize: 28, fontFamily: T.font.bold, color: T.ink,
           marginTop: 6, letterSpacing: -0.6, fontVariant: ['tabular-nums'] },
  narration: { fontSize: 13, color: T.muted, marginTop: 12, lineHeight: 19,
               fontFamily: T.font.regular },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 4 },
  note: { fontSize: 12, color: T.faint, marginTop: 12, lineHeight: 17,
          fontFamily: T.font.regular },
  entry: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 9,
           borderTopWidth: 1, borderTopColor: T.lineSoft },
  entryName: { flex: 1, fontSize: 14, color: T.ink, fontFamily: T.font.medium },
  entryAmount: { fontSize: 14, fontFamily: T.font.semibold, color: T.ink,
                 letterSpacing: -0.2, fontVariant: ['tabular-nums'] },
  tag: { paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4 },
  tagDr: { backgroundColor: T.infoSoft },
  tagCr: { backgroundColor: T.goldSoft },
  tagText: { fontSize: 9.5, fontFamily: T.font.bold, letterSpacing: 0.5 },
});


function Action({ Icon, label, onPress, primary }: {
  Icon: typeof Share2; label: string; onPress: () => void; primary?: boolean;
}) {
  return (
    <Pressable onPress={onPress} style={[s.action, primary && s.actionPrimary]}>
      <Icon size={15} color={primary ? T.card : T.inkSoft} />
      <Text style={[s.actionText, primary && { color: T.card }]}>{label}</Text>
    </Pressable>
  );
}
