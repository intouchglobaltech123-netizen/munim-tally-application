'use strict';
// Deterministic seed data. Same output every run so tests are reproducible.

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = mulberry32(42);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

// Names deliberately include the characters that break naive parsers.
const PARTY_FIRST = ['Sri', 'New', 'Shree', 'R & K', 'Bharat', 'Anand', 'Krishna',
  'M/s. Verma', 'Gupta & Sons', 'Laxmi', 'Deepak', 'Royal', 'Star', 'Perfect'];
const PARTY_LAST = ['Traders', 'Enterprises', 'Agency', 'Industries', 'Steel Co.',
  'Marketing', '& Company', 'Distributors', 'Hardware', 'Electricals'];
const ITEMS = ['Cement OPC 53', 'TMT Bar 12mm', 'PVC Pipe 4"', 'Paint <Interior>',
  'Wire 1.5sqmm', 'Switch 6A', 'Tile 2x2 Glossy', 'Adhesive 20kg'];

const VCH_TYPES = [
  { name: 'Sales', parent: 'Sales' },
  { name: 'GST Sales', parent: 'Sales' },      // custom type: never hardcode 'Sales'
  { name: 'Purchase', parent: 'Purchase' },
  { name: 'Receipt', parent: 'Receipt' },
  { name: 'Payment', parent: 'Payment' },
];

function pad(n, w) { return String(n).padStart(w, '0'); }
function tallyDate(d) {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1, 2)}${pad(d.getUTCDate(), 2)}`;
}
// Indian grouping: 12,34,567.00
function inr(n) {
  const neg = n < 0;
  const [i, f] = Math.abs(n).toFixed(2).split('.');
  let out = i.length > 3 ? i.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + i.slice(-3) : i;
  return (neg ? '-' : '') + out + '.' + f;
}

// isOpen decides whether an invoice is still unpaid on the books.
function isOpen(day, lastDay, rnd) {
  const ageDays = Math.floor((lastDay - day) / 86400000);
  if (ageDays <= 45) return true;          // recent: normally still open
  if (ageDays <= 120) return rnd() < 0.35; // some slow payers
  return rnd() < 0.04;                     // a few long-overdue stragglers
}

function build() {
  let alter = 1000;                       // masters share one sequence
  let vAlter = 5000;                      // vouchers have their own

  const companies = [
    { guid: 'c1-9f2a-4b11', name: 'R & K Traders', fyStart: '20250401', alterId: ++alter },
    { guid: 'c2-7e3b-8d44', name: 'Munim Tech Pvt Ltd', fyStart: '20250401', alterId: ++alter },
  ];

  const groups = [
    { guid: 'g1', name: 'Sundry Debtors', parent: 'Current Assets', primary: 'Current Assets', alterId: ++alter },
    { guid: 'g2', name: 'Sundry Creditors', parent: 'Current Liabilities', primary: 'Current Liabilities', alterId: ++alter },
    { guid: 'g3', name: 'Cash-in-Hand', parent: 'Current Assets', primary: 'Current Assets', alterId: ++alter },
    { guid: 'g4', name: 'Bank Accounts', parent: 'Current Assets', primary: 'Current Assets', alterId: ++alter },
    { guid: 'g5', name: 'Sales Accounts', parent: 'Primary', primary: 'Income', alterId: ++alter },
  ];

  const db = {};
  for (const c of companies) {
    const ledgers = [
      { guid: `${c.guid}-l-cash`, name: 'Cash', parent: 'Cash-in-Hand', opening: 45000, closing: 235000, phone: '', gstin: '', creditDays: 0, alterId: ++alter },
      { guid: `${c.guid}-l-bank`, name: 'HDFC Bank A/c', parent: 'Bank Accounts', opening: 800000, closing: 832000, phone: '', gstin: '', creditDays: 0, alterId: ++alter },
      { guid: `${c.guid}-l-sales`, name: 'Sales GST 18%', parent: 'Sales Accounts', opening: 0, closing: -2548000, phone: '', gstin: '', creditDays: 0, alterId: ++alter },
    ];
    const debtorCount = c.guid === 'c1-9f2a-4b11' ? 60 : 25;
    for (let i = 0; i < debtorCount; i++) {
      const nm = `${pick(PARTY_FIRST)} ${pick(PARTY_LAST)}`;
      ledgers.push({
        guid: `${c.guid}-l-d${i}`, name: `${nm} ${i}`, parent: 'Sundry Debtors',
        opening: 0, closing: Math.round(rnd() * 400000),
        phone: `9${Math.floor(rnd() * 900000000 + 100000000)}`,
        gstin: `33AABCU${Math.floor(rnd() * 9000 + 1000)}L1Z${Math.floor(rnd() * 9)}`,
        creditDays: pick([0, 15, 30, 45, 60]), alterId: ++alter,
      });
    }
    for (let i = 0; i < 15; i++) {
      ledgers.push({
        guid: `${c.guid}-l-c${i}`, name: `${pick(PARTY_FIRST)} Supplies ${i}`, parent: 'Sundry Creditors',
        opening: 0, closing: -Math.round(rnd() * 300000), phone: `9${Math.floor(rnd() * 900000000 + 100000000)}`,
        gstin: '', creditDays: 30, alterId: ++alter,
      });
    }

    const stockItems = ITEMS.map((n, i) => ({
      guid: `${c.guid}-s${i}`, name: n, unit: pick(['Nos', 'Kg', 'Mtr', 'Bag']),
      closingQty: Math.round(rnd() * 500), closingValue: Math.round(rnd() * 200000), alterId: ++alter,
    }));

    // Two years of vouchers, ~4 per business day
    const vouchers = [];
    const start = new Date(Date.UTC(2024, 3, 1));
    const end = new Date(Date.UTC(2026, 2, 31));
    const debtors = ledgers.filter((l) => l.parent === 'Sundry Debtors');
    let vno = 1;
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      if (d.getUTCDay() === 0) continue;                  // closed Sundays
      const n = 2 + Math.floor(rnd() * 4);
      for (let k = 0; k < n; k++) {
        const vt = pick(VCH_TYPES);
        const party = pick(debtors);
        const amount = Math.round((rnd() * 180000 + 2000) / 10) * 10;
        const isSale = vt.parent === 'Sales';
        const items = isSale
          ? Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => {
              const it = pick(stockItems);
              const qty = 1 + Math.floor(rnd() * 40);
              const rate = Math.round(amount / (qty * 2));
              return { name: it.name, guid: it.guid, qty, rate, amount: qty * rate };
            })
          : [];
        const dueDays = party.creditDays || 30;
        const due = new Date(d.getTime() + dueDays * 86400000);
        vouchers.push({
          guid: `${c.guid}-v${vno}`,
          vchNo: String(vno),
          vchType: vt.name,
          vchTypeParent: vt.parent,
          date: tallyDate(d),
          party: party.name,
          partyGuid: party.guid,
          amount: isSale ? -amount : amount,   // Tally sign convention
          narration: rnd() < 0.3 ? `Being goods sold vide bill no ${vno} <urgent>` : '',
          isCancelled: rnd() < 0.01,
          alterId: ++vAlter,
          items,
          // A real book settles most invoices. Only recent ones, plus a small
          // tail of genuinely overdue stragglers, stay open - otherwise
          // outstanding grows without bound and contradicts the ledger.
          bill: isSale && isOpen(d, end, rnd)
            ? { ref: `INV-${pad(vno, 5)}`, date: tallyDate(d), dueDate: tallyDate(due), amount, kind: 'receivable' }
            : null,
        });
        vno++;
      }
    }

    // Derive each debtor's closing balance from their open bills so the
    // dashboard tiles and the outstanding screen agree to the rupee.
    const openByParty = new Map();
    for (const v of vouchers) {
      if (!v.bill || v.isCancelled) continue;
      openByParty.set(v.party, (openByParty.get(v.party) || 0) + v.bill.amount);
    }
    // The statement's running balance must land exactly on the ledger's
    // closing figure, or the app shows two different numbers for the same
    // party. The opening balance is what carries everything before the first
    // voucher we hold, so derive it: opening = closing - sum(entries).
    const entrySum = new Map();
    for (const v of vouchers) {
      if (v.isCancelled) continue;
      // The party's own ledger entry is the opposite sign of the voucher.
      entrySum.set(v.party, (entrySum.get(v.party) || 0) + -v.amount);
    }
    for (const l of ledgers) {
      if (l.parent !== 'Sundry Debtors') continue;
      l.closing = openByParty.get(l.name) || 0;
      l.opening = l.closing - (entrySum.get(l.name) || 0);
    }

    db[c.guid] = { company: c, groups, ledgers, stockItems, vouchers, vchTypes: VCH_TYPES };
  }
  return { companies, db, inr };
}

module.exports = { build, inr };
