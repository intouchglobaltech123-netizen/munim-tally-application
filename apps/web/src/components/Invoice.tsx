'use client';

import { type InvoiceDoc } from '../lib/api';
import { AlertTriangle } from 'lucide-react';

/**
 * The invoice as a document, laid out for paper.
 *
 * This is the thing a customer actually sends somebody, so it follows the
 * conventions of an Indian tax invoice rather than the house style of the rest
 * of the app: seller and buyer blocks side by side, HSN against every line,
 * the tax split shown separately, and the amount in words underneath.
 *
 * Printed through the browser's own dialogue, which is also where "Save as
 * PDF" lives. The page is deliberately plain - a printer renders shadows and
 * rounded corners as grey mush, and toner costs the customer money.
 */
const FONTS: Record<string, string> = {
  sans: 'ui-sans-serif, system-ui, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, "Courier New", monospace',
};

export default function Invoice({ doc, money }: {
  doc: InvoiceDoc;
  money: (p: number) => string;
}) {
  const d = doc.document;
  const t = doc.totals;
  const tpl = doc.template;
  const show = tpl.show;
  const hasTax = t.tax.total > 0;
  const dense = tpl.type.dense;

  // Any line with a discount switches the column on, so a shop that never
  // discounts never sees an empty column.
  const anyDiscount = show.discount && doc.lines.some((l) => l.discountPaise > 0);

  const cell = dense ? 'px-1 py-0.5' : 'px-2 py-1.5';
  const rule = tpl.type.borders ? 'border border-slate-300' : 'border-0';

  return (
    <div
      className="print-area mx-auto bg-white text-slate-900"
      style={{
        /* Millimetres, so what is on screen is what comes out of the printer. */
        width: `${tpl.page.widthMm}mm`,
        maxWidth: '100%',
        padding: `${tpl.page.marginMm}mm`,
        fontFamily: FONTS[tpl.type.font] ?? FONTS.sans,
        fontSize: `${tpl.type.sizePt}px`,
        ['--accent' as string]: tpl.type.accent,
      }}>
      {/* Heading. The wording is load-bearing: a Bill of Supply must not be
          headed "Tax Invoice". */}
      <div className="flex items-start justify-between gap-6 pb-4"
        style={{ borderBottom: `2px solid ${tpl.type.accent}` }}>
        <div className="flex items-start gap-4">
          {show.logo && doc.seller.logoDataUri && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img src={doc.seller.logoDataUri} alt="" className="h-16 w-16 object-contain" />
          )}
          <div>
            <div className="text-lg font-bold">{doc.seller.name}</div>
            {doc.seller.address && <div className="text-xs">{doc.seller.address}</div>}
            <div className="text-xs">
              {[doc.seller.state, doc.seller.pincode].filter(Boolean).join(' - ')}
            </div>
            {doc.seller.phone && <div className="text-xs">Phone: {doc.seller.phone}</div>}
            {doc.seller.email && <div className="text-xs">{doc.seller.email}</div>}
            {show.sellerGstin && doc.seller.gstin && (
              <div className="text-xs font-semibold">GSTIN: {doc.seller.gstin}</div>
            )}
            {show.sellerPan && doc.seller.pan && (
              <div className="text-xs">PAN: {doc.seller.pan}</div>
            )}
          </div>
        </div>
        <div className="text-right">
          <div className="text-xl font-bold uppercase tracking-wide"
            style={{ color: tpl.type.accent }}>{d.title}</div>
          {d.note && <div className="text-[11px] text-slate-500">{d.note}</div>}
        </div>
      </div>

      {d.isCancelled && (
        <div className="mt-3 border-2 border-rose-600 px-3 py-1.5 text-center text-sm
                        font-bold uppercase text-rose-700">
          Cancelled
        </div>
      )}
      {d.isCommitment && (
        <div className="mt-3 border border-slate-400 px-3 py-1.5 text-center text-xs">
          This is an order, not a tax invoice. Not valid for input tax credit.
        </div>
      )}

      {/* Parties and invoice particulars. */}
      <div className="mt-4 grid grid-cols-2 gap-0 border border-slate-300">
        <div className="border-r border-slate-300 p-3">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-slate-500">
            Billed to
          </div>
          <div className="font-semibold">{doc.buyer.name}</div>
          {show.buyerAddress && doc.buyer.address && (
            <div className="text-xs">{doc.buyer.address}</div>
          )}
          {show.buyerAddress && (
            <div className="text-xs">
              {[doc.buyer.state, doc.buyer.pincode].filter(Boolean).join(' - ')}
            </div>
          )}
          {doc.buyer.phone && <div className="text-xs">{doc.buyer.phone}</div>}
          {show.buyerGstin && doc.buyer.gstin && (
            <div className="mt-1 text-xs font-semibold">GSTIN: {doc.buyer.gstin}</div>
          )}
          {show.shipping && doc.buyer.shippingAddress && (
            <div className="mt-2">
              <div className="text-[10px] font-bold uppercase text-slate-500">Shipped to</div>
              <div className="text-xs">{doc.buyer.shippingAddress}</div>
            </div>
          )}
        </div>
        <div className="p-3">
          <Field k="Invoice no." v={doc.invoice.number} />
          <Field k="Date" v={doc.invoice.date} />
          {doc.invoice.dueDate && <Field k="Due date" v={doc.invoice.dueDate} />}
          {doc.invoice.terms && <Field k="Terms" v={doc.invoice.terms} />}
          {doc.invoice.placeOfSupply && (
            <Field k="Place of supply" v={doc.invoice.placeOfSupply} />
          )}
        </div>
      </div>

      {/* Lines. */}
      <table className={`mt-4 w-full border-collapse ${rule}`}>
        <thead>
          <tr className="bg-slate-100 text-left text-[10px] uppercase tracking-wide">
            <th className="border border-slate-300 px-2 py-1.5">#</th>
            <th className="border border-slate-300 px-2 py-1.5">Description</th>
            {show.hsn && <th className={`${rule} ${cell}`}>HSN/SAC</th>}
            <th className={`${rule} ${cell} text-right`}>Qty</th>
            <th className={`${rule} ${cell} text-right`}>Rate</th>
            {anyDiscount && <th className={`${rule} ${cell} text-right`}>Disc.</th>}
            {show.taxColumn && hasTax && <th className={`${rule} ${cell} text-right`}>GST</th>}
            <th className={`${rule} ${cell} text-right`}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {doc.lines.length === 0 ? (
            <tr>
              <td colSpan={hasTax ? 7 : 6}
                className="border border-slate-300 px-2 py-3 text-center text-xs text-slate-500">
                {/* Honest rather than blank: many shops bill without inventory
                    lines, and an empty table looks like a fault. */}
                This entry was recorded without item lines in Tally.
              </td>
            </tr>
          ) : doc.lines.map((l, i) => (
            <tr key={l.name} className="avoid-break">
              <td className={`${rule} ${cell}`}>{i + 1}</td>
              <td className={`${rule} ${cell}`}>{l.name}</td>
              {show.hsn && (
                <td className={`${rule} ${cell} font-mono text-xs`}>{l.hsn || '—'}</td>
              )}
              <td className={`${rule} ${cell} text-right tabular-nums`}>{l.qty} {l.unit}</td>
              <td className={`${rule} ${cell} text-right tabular-nums`}>{money(l.ratePaise)}</td>
              {anyDiscount && (
                <td className={`${rule} ${cell} text-right tabular-nums`}>
                  {l.discountPaise > 0 ? money(l.discountPaise) : '—'}
                </td>
              )}
              {show.taxColumn && hasTax && (
                <td className={`${rule} ${cell} text-right tabular-nums`}>
                  {l.gstRatePct > 0 ? `${l.gstRatePct}%` : '—'}
                </td>
              )}
              <td className={`${rule} ${cell} text-right tabular-nums font-semibold`}>
                {money(l.amountPaise)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Totals. */}
      <div className="mt-4 flex justify-end">
        <table className="w-72">
          <tbody>
            {doc.lines.length > 0 && (
              <Total k="Subtotal" v={money(t.subtotalPaise)} />
            )}
            {t.discountPaise > 0 && <Total k="Discount" v={`− ${money(t.discountPaise)}`} />}
            {show.taxBreakup && t.tax.cgst > 0 && <Total k="CGST" v={money(t.tax.cgst)} />}
            {show.taxBreakup && t.tax.sgst > 0 && <Total k="SGST" v={money(t.tax.sgst)} />}
            {show.taxBreakup && t.tax.igst > 0 && <Total k="IGST" v={money(t.tax.igst)} />}
            {t.tax.cess > 0 && <Total k="Cess" v={money(t.tax.cess)} />}
            {t.tax.other > 0 && <Total k="Other tax" v={money(t.tax.other)} />}
            {t.roundOffPaise !== 0 && <Total k="Round off" v={money(t.roundOffPaise)} />}
            <tr style={{ borderTop: `2px solid ${tpl.type.accent}` }}>
              <td className="py-2 font-bold">Total</td>
              <td className="py-2 text-right text-base font-bold tabular-nums">
                {money(t.grossPaise)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* The line that stops a digit being added to a printed figure. */}
      {show.inWords && (
        <div className="mt-3 border-t border-slate-300 pt-2 text-xs">
          <span className="font-semibold">Amount in words: </span>
          {t.inWords}
        </div>
      )}

      {/* Where to pay, and the fastest way to do it. */}
      {(show.bank || show.upiQr) && (doc.seller.bank.name || doc.upiQr) && (
        <div className="mt-4 flex flex-wrap items-start justify-between gap-6
                        border-t border-slate-300 pt-3">
          {show.bank && doc.seller.bank.name && (
            <div className="text-xs">
              <div className="mb-0.5 font-bold uppercase tracking-wide text-slate-500">
                Bank details
              </div>
              <div>{doc.seller.bank.name}{doc.seller.bank.branch ? `, ${doc.seller.bank.branch}` : ''}</div>
              {doc.seller.bank.account && <div>A/c: {doc.seller.bank.account}</div>}
              {doc.seller.bank.ifsc && <div>IFSC: {doc.seller.bank.ifsc}</div>}
            </div>
          )}
          {show.upiQr && doc.upiQr && (
            <div className="text-center text-xs">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={doc.upiQr.dataUri} alt="UPI payment QR"
                className="h-24 w-24" />
              <div className="mt-1 font-semibold">Scan to pay ₹{doc.upiQr.amount}</div>
              <div className="text-[10px] text-slate-500">{doc.upiQr.upiId}</div>
            </div>
          )}
        </div>
      )}

      {show.terms && tpl.text.terms && (
        <div className="mt-4 border-t border-slate-300 pt-2 text-xs">
          <div className="mb-0.5 font-bold uppercase tracking-wide text-slate-500">Terms</div>
          {tpl.text.terms.split('\n').map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}

      {t.tax.mismatch && (
        <div className="no-print mt-4 flex items-start gap-2 border border-amber-400
                        bg-amber-50 p-3 text-xs">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-600" />
          <span>
            <b>Check this tax split.</b> Both parties are in{' '}
            {t.tax.expectedSupply === 'intra' ? 'the same state' : 'different states'}, so this
            should be {t.tax.expectedSupply === 'intra' ? 'CGST + SGST' : 'IGST'} — but{' '}
            {t.tax.supply === 'inter' ? 'IGST' : 'CGST + SGST'} was charged. The buyer may not be
            able to claim the credit. Fix it in Tally.
          </span>
        </div>
      )}

      {show.hsnSummary && doc.hsnSummary.length > 0 && (
        <div className="mt-5">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-slate-500">
            HSN summary
          </div>
          <table className="w-full border-collapse border border-slate-300 text-xs">
            <thead>
              <tr className="bg-slate-100 text-left">
                <th className="border border-slate-300 px-2 py-1">HSN/SAC</th>
                <th className="border border-slate-300 px-2 py-1 text-right">Qty</th>
                <th className="border border-slate-300 px-2 py-1 text-right">Rate</th>
                <th className="border border-slate-300 px-2 py-1 text-right">Value</th>
              </tr>
            </thead>
            <tbody>
              {doc.hsnSummary.map((h) => (
                <tr key={h.hsn}>
                  <td className="border border-slate-300 px-2 py-1 font-mono">{h.hsn}</td>
                  <td className="border border-slate-300 px-2 py-1 text-right tabular-nums">{h.qty}</td>
                  <td className="border border-slate-300 px-2 py-1 text-right tabular-nums">
                    {h.gstRatePct > 0 ? `${h.gstRatePct}%` : '—'}
                  </td>
                  <td className="border border-slate-300 px-2 py-1 text-right tabular-nums">
                    {money(h.valuePaise)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {doc.invoice.narration && (
        <div className="mt-4 text-xs">
          <span className="font-semibold">Note: </span>{doc.invoice.narration}
        </div>
      )}

      <div className="mt-10 flex items-end justify-between gap-6">
        <div className="text-[10px] text-slate-500">
          {show.footer && tpl.text.footer
            ? tpl.text.footer
            : 'This is a computer-generated document from Munim, read from Tally.'}
        </div>
        {show.signature && (
          <div className="text-center">
            <div className="h-12" />
            <div className="border-t border-slate-400 px-8 pt-1 text-xs">
              For {doc.seller.name}
            </div>
            <div className="text-[10px] text-slate-500">
              {tpl.text.signatory || 'Authorised signatory'}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function Field({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3 py-0.5 text-xs">
      <span className="text-slate-500">{k}</span>
      <span className="font-semibold">{v}</span>
    </div>
  );
}

function Total({ k, v }: { k: string; v: string }) {
  return (
    <tr>
      <td className="py-1 text-xs text-slate-600">{k}</td>
      <td className="py-1 text-right text-xs tabular-nums">{v}</td>
    </tr>
  );
}
