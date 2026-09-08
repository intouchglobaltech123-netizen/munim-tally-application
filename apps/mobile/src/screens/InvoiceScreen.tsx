import React from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { MessageCircle, Mail, Share2, AlertTriangle, FileText } from 'lucide-react-native';
import { useApp, useApi } from '../lib/store';
import { useMoney } from '../lib/money';
import { documentText, shareText, shareOnWhatsApp, shareByEmail } from '../lib/share';
import {
  Card, EmptyState, ErrorNote, Loading, Muted, Screen, Title, Badge,
} from '../components/ui';
import { T } from '../theme';

/**
 * The invoice on a phone, laid out to be read and sent.
 *
 * Not a shrunken copy of the printed page: a phone cannot print, and an A4
 * layout squeezed onto a handset is unreadable. What matters here is that the
 * figures are legible and the send buttons are within thumb reach - a shop
 * owner standing at the counter forwarding a bill to a customer.
 */

type Doc = {
  document: { kind: string; title: string; taxable: boolean; note?: string;
              isCommitment: boolean; isCancelled: boolean };
  template: {
    show: Record<string, boolean>;
    text: { terms: string; footer: string; signatory: string };
    bank: { name: string; account: string; ifsc: string; branch: string };
  };
  upiQr: { dataUri: string; upiId: string; amount: string } | null;
  seller: { name: string; gstin: string; phone: string; address: string; state: string };
  buyer: { name: string; gstin: string; phone: string; email: string;
           address: string; state: string };
  invoice: { number: string; date: string; dueDate: string | null; terms: string;
             narration: string; placeOfSupply: string };
  lines: { name: string; hsn: string; unit: string; qty: number;
           ratePaise: number; discountPaise: number;
           amountPaise: number; gstRatePct: number }[];
  totals: {
    subtotalPaise: number;
    tax: { cgst: number; sgst: number; igst: number; cess: number; other: number;
           total: number; supply: string | null; expectedSupply: string | null;
           mismatch: boolean };
    roundOffPaise: number; grossPaise: number; inWords: string;
    discountPaise: number;
  };
};

export default function InvoiceScreen({ route }: any) {
  const id: string = route.params?.id ?? '';
  const { company } = useApp();
  const money = useMoney();

  const { data, error, loading, reload } = useApi<Doc>(
    company ? `/v1/companies/${encodeURIComponent(company.tallyGuid)}/invoice/${id}` : null,
    [company?.tallyGuid, id]);

  if (error) return <Screen><ErrorNote message={error} onRetry={reload} /></Screen>;
  if (loading && !data) return <Loading label="Preparing the invoice…" />;
  if (!data) return <Screen><EmptyState title="Not found" icon={FileText}
    hint="No such invoice." /></Screen>;

  const doc = data;
  const t = doc.totals;

  const asText = () => documentText({
    company: doc.seller.name,
    title: `${doc.document.title} ${doc.invoice.number} · ${doc.invoice.date}`,
    lines: [
      ...doc.lines.map((l) =>
        `${l.name} — ${l.qty}${l.unit ? ' ' + l.unit : ''} × ${money(l.ratePaise)} = ${money(l.amountPaise)}`),
      ...(t.tax.total ? [`Tax: ${money(t.tax.total)}`] : []),
      `Total: ${money(t.grossPaise)}`,
      t.inWords,
      ...(doc.invoice.dueDate ? [`Due: ${doc.invoice.dueDate}`] : []),
    ],
    footer: `${doc.seller.name}${doc.seller.phone ? ` · ${doc.seller.phone}` : ''}`,
  });

  return (
    <Screen onRefresh={reload} refreshing={loading} tabBar={false}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Title>{doc.document.title}</Title>
        {doc.document.isCancelled ? <Badge tone="bad">Cancelled</Badge> : null}
      </View>
      <Muted>#{doc.invoice.number} · {doc.invoice.date}</Muted>

      {/* Sending is the reason this screen exists on a phone. */}
      <View style={s.actions}>
        <Action Icon={MessageCircle} label="WhatsApp" primary
          onPress={() => shareOnWhatsApp(asText(), doc.buyer.phone)} />
        <Action Icon={Mail} label="Email"
          onPress={() => shareByEmail(
            `${doc.document.title} ${doc.invoice.number}`, asText(), doc.buyer.email)} />
        <Action Icon={Share2} label="Share"
          onPress={() => shareText(`${doc.document.title} ${doc.invoice.number}`, asText())} />
      </View>

      {doc.document.isCommitment ? (
        <View style={[s.banner, { backgroundColor: T.greenSoft }]}>
          <Text style={[s.bannerText, { color: T.greenDark }]}>
            This is an order, not a tax invoice. Not valid for input tax credit.
          </Text>
        </View>
      ) : null}

      {t.tax.mismatch ? (
        <View style={[s.banner, { backgroundColor: T.warnSoft, flexDirection: 'row', gap: 9 }]}>
          <AlertTriangle size={16} color={T.warn} style={{ marginTop: 1 }} />
          <Text style={[s.bannerText, { flex: 1, color: T.warn }]}>
            Check this tax split. Both parties are in{' '}
            {t.tax.expectedSupply === 'intra' ? 'the same state' : 'different states'}, so it should
            be {t.tax.expectedSupply === 'intra' ? 'CGST + SGST' : 'IGST'} — but{' '}
            {t.tax.supply === 'inter' ? 'IGST' : 'CGST + SGST'} was charged. Fix it in Tally.
          </Text>
        </View>
      ) : null}

      <Text style={s.section}>Parties</Text>
      <Card>
        <Text style={s.partyLabel}>From</Text>
        <Text style={s.partyName}>{doc.seller.name}</Text>
        {doc.seller.gstin ? <Text style={s.tiny}>GSTIN {doc.seller.gstin}</Text> : null}

        <View style={{ height: 12 }} />
        <Text style={s.partyLabel}>To</Text>
        <Text style={s.partyName}>{doc.buyer.name}</Text>
        {doc.buyer.address ? <Text style={s.tiny}>{doc.buyer.address}</Text> : null}
        {doc.buyer.gstin ? <Text style={s.tiny}>GSTIN {doc.buyer.gstin}</Text> : null}
        {doc.invoice.dueDate ? (
          <Text style={s.tiny}>Due {doc.invoice.dueDate}{doc.invoice.terms ? ` · ${doc.invoice.terms}` : ''}</Text>
        ) : null}
      </Card>

      <Text style={s.section}>Items</Text>
      {doc.lines.length === 0 ? (
        <Card>
          {/* Honest rather than blank: many shops bill without inventory lines. */}
          <Muted>This entry was recorded without item lines in Tally.</Muted>
        </Card>
      ) : (
        <Card>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View>
              <View style={[s.row, s.head]}>
                <Text style={[s.cell, s.wName, s.headText]}>Item</Text>
                <Text style={[s.cell, s.wHsn, s.headText]}>HSN</Text>
                <Text style={[s.cell, s.wQty, s.headText, s.right]}>Qty</Text>
                <Text style={[s.cell, s.wRate, s.headText, s.right]}>Rate</Text>
                <Text style={[s.cell, s.wAmt, s.headText, s.right]}>Amount</Text>
              </View>
              {doc.lines.map((l, i) => (
                <View key={i} style={s.row}>
                  <Text style={[s.cell, s.wName]} numberOfLines={2}>{l.name}</Text>
                  <Text style={[s.cell, s.wHsn, s.mono]}>{l.hsn || '—'}</Text>
                  <Text style={[s.cell, s.wQty, s.right]}>{l.qty}{l.unit ? ` ${l.unit}` : ''}</Text>
                  <Text style={[s.cell, s.wRate, s.right]}>{money(l.ratePaise)}</Text>
                  <Text style={[s.cell, s.wAmt, s.right, s.bold]}>{money(l.amountPaise)}</Text>
                </View>
              ))}
            </View>
          </ScrollView>
        </Card>
      )}

      {doc.upiQr && doc.template.show.upiQr ? (
        <>
          <Text style={s.section}>Scan to pay</Text>
          <Card>
            <View style={{ alignItems: 'center' }}>
              {/* The whole reason this belongs on a phone: hold the screen up
                  and the customer's UPI app fills in the amount itself. */}
              <Image source={{ uri: doc.upiQr.dataUri }}
                style={{ width: 190, height: 190 }} />
              <Text style={s.qrAmount}>₹{doc.upiQr.amount}</Text>
              <Text style={s.tiny}>{doc.upiQr.upiId}</Text>
            </View>
          </Card>
        </>
      ) : null}

      {doc.template.bank.name && doc.template.show.bank ? (
        <>
          <Text style={s.section}>Bank details</Text>
          <Card>
            <Line k="Bank" v={doc.template.bank.name} />
            {doc.template.bank.account ? <Line k="A/c" v={doc.template.bank.account} /> : null}
            {doc.template.bank.ifsc ? <Line k="IFSC" v={doc.template.bank.ifsc} /> : null}
          </Card>
        </>
      ) : null}

      {doc.template.text.terms && doc.template.show.terms ? (
        <>
          <Text style={s.section}>Terms</Text>
          <Card><Text style={s.noteText}>{doc.template.text.terms}</Text></Card>
        </>
      ) : null}

      <Text style={s.section}>Total</Text>
      <Card>
        {doc.lines.length > 0 ? <Line k="Subtotal" v={money(t.subtotalPaise)} /> : null}
        {t.discountPaise > 0 ? <Line k="Discount" v={`− ${money(t.discountPaise)}`} /> : null}
        {t.tax.cgst > 0 ? <Line k="CGST" v={money(t.tax.cgst)} /> : null}
        {t.tax.sgst > 0 ? <Line k="SGST" v={money(t.tax.sgst)} /> : null}
        {t.tax.igst > 0 ? <Line k="IGST" v={money(t.tax.igst)} /> : null}
        {t.tax.cess > 0 ? <Line k="Cess" v={money(t.tax.cess)} /> : null}
        {t.roundOffPaise !== 0 ? <Line k="Round off" v={money(t.roundOffPaise)} /> : null}
        <View style={s.grand}>
          <Text style={s.grandLabel}>Total</Text>
          <Text style={s.grandValue}>{money(t.grossPaise)}</Text>
        </View>
        {/* The line that stops a digit being added to a printed figure. */}
        <Text style={s.words}>{t.inWords}</Text>
      </Card>

      {doc.invoice.narration ? (
        <>
          <Text style={s.section}>Note</Text>
          <Card><Text style={s.noteText}>{doc.invoice.narration}</Text></Card>
        </>
      ) : null}
    </Screen>
  );
}

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

function Line({ k, v }: { k: string; v: string }) {
  return (
    <View style={s.lineRow}>
      <Text style={s.k}>{k}</Text>
      <Text style={s.v}>{v}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  section: {
    fontFamily: T.font.bold, fontSize: 13, color: T.muted,
    textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 22, marginBottom: 10,
  },
  actions: { flexDirection: 'row', gap: 8, marginTop: 14, flexWrap: 'wrap' },
  action: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: T.lineSoft, borderRadius: T.radiusSm,
    paddingHorizontal: 13, paddingVertical: 10,
  },
  actionPrimary: { backgroundColor: T.green },
  actionText: { fontFamily: T.font.semibold, fontSize: 13, color: T.inkSoft },
  banner: { borderRadius: T.radiusSm, padding: 13, marginTop: 14 },
  bannerText: { fontFamily: T.font.regular, fontSize: 12, lineHeight: 17 },
  partyLabel: {
    fontFamily: T.font.bold, fontSize: 10, color: T.muted,
    textTransform: 'uppercase', letterSpacing: 0.5,
  },
  partyName: { fontFamily: T.font.bold, fontSize: 15, color: T.ink, marginTop: 3 },
  tiny: { fontFamily: T.font.regular, fontSize: 11, color: T.muted, marginTop: 2 },
  row: { flexDirection: 'row', paddingVertical: 8, borderTopWidth: 1, borderTopColor: T.lineSoft },
  head: { borderTopWidth: 0 },
  headText: { fontFamily: T.font.bold, fontSize: 10, color: T.muted, textTransform: 'uppercase' },
  cell: { fontFamily: T.font.regular, fontSize: 12, color: T.ink, paddingRight: 10 },
  wName: { width: 150 }, wHsn: { width: 80 }, wQty: { width: 70 },
  wRate: { width: 90 }, wAmt: { width: 100 },
  right: { textAlign: 'right' },
  bold: { fontFamily: T.font.semibold },
  mono: { fontFamily: 'monospace', fontSize: 11, color: T.muted },
  lineRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    paddingVertical: 6,
  },
  k: { fontFamily: T.font.regular, fontSize: 13, color: T.muted },
  v: { fontFamily: T.font.medium, fontSize: 13, color: T.ink },
  grand: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    borderTopWidth: 2, borderTopColor: T.ink, marginTop: 8, paddingTop: 10,
  },
  grandLabel: { fontFamily: T.font.bold, fontSize: 15, color: T.ink },
  grandValue: { fontFamily: T.font.bold, fontSize: 20, color: T.ink },
  qrAmount: { fontFamily: T.font.bold, fontSize: 20, color: T.ink, marginTop: 10 },
  words: {
    fontFamily: T.font.regular, fontSize: 11, color: T.inkSoft,
    marginTop: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: T.lineSoft,
    lineHeight: 16,
  },
  noteText: { fontFamily: T.font.regular, fontSize: 13, color: T.inkSoft, lineHeight: 19 },
});
