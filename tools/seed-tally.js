'use strict';
/**
 * Puts realistic test data INTO your Tally company.
 *
 *   node tools/seed-tally.js --tally http://172.21.128.1:9000
 *
 * ---------------------------------------------------------------------------
 * THIS TOOL WRITES TO TALLY. The Munim connector never does - that is enforced
 * by a test (TestNoRequestCanWriteToTally). This is a separate developer tool,
 * kept outside connector/ on purpose, for putting sample data into a company
 * YOU created for testing. Never point it at real books.
 * ---------------------------------------------------------------------------
 *
 * It creates:
 *   - a Sales ledger and a few Sundry Debtor parties (bill-wise on)
 *   - sales invoices across several months, each with a bill reference
 *   - receipts against some of them, so outstanding is realistic
 *
 * TallyPrime in Educational mode only accepts vouchers dated the 1st, 2nd or
 * 31st of a month, so every date generated here is one of those. That keeps
 * this working without a licence.
 */

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};

const TALLY = (arg('tally', 'http://localhost:9000')).replace(/\/$/, '');
// Tally's company-list request answers inconsistently depending on the HTTP
// client (Go gets the list; Node gets a <CMPINFO> summary of counts for the
// same bytes). Rather than fight that, let the name be passed in - the
// connector prints it with `lkp-agent companies`.
const COMPANY = arg('company', '');

// --- tally plumbing ---------------------------------------------------------

async function tally(xml) {
  const res = await fetch(TALLY, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml;charset=utf-8' },
    body: xml,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Tally returned HTTP ${res.status}`);
  return text;
}

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Wraps masters/vouchers in an Import envelope aimed at one company. */
function importEnvelope(company, payload) {
  return `<ENVELOPE>
 <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
 <BODY>
  <IMPORTDATA>
   <REQUESTDESC>
    <REPORTNAME>All Masters</REPORTNAME>
    <STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES>
   </REQUESTDESC>
   <REQUESTDATA>${payload}</REQUESTDATA>
  </IMPORTDATA>
 </BODY>
</ENVELOPE>`;
}

async function openCompany() {
  // Use the same envelope the connector uses. A request without
  // SVIsSimpleCompany and the full native-method list makes Tally answer with a
  // <CMPINFO> summary of counts instead of the actual company list - which
  // reads as "no companies" even when one is open.
  const xml = await tally(`<ENVELOPE>
 <HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST>
 <TYPE>Collection</TYPE><ID>ListOfCompanies</ID></HEADER>
 <BODY><DESC>
  <STATICVARIABLES>
   <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
   <SVIsSimpleCompany>No</SVIsSimpleCompany>
  </STATICVARIABLES>
  <TDL><TDLMESSAGE>
   <COLLECTION NAME="ListOfCompanies" ISINITIALIZE="Yes">
    <TYPE>Company</TYPE>
    <NATIVEMETHOD>Name,StartingFrom,EndingAt,GUID,AlterID</NATIVEMETHOD>
   </COLLECTION>
  </TDLMESSAGE></TDL>
 </DESC></BODY></ENVELOPE>`);

  // Only look inside <COMPANY> elements, so the CMPINFO counters can never be
  // mistaken for a name.
  const blocks = [...xml.matchAll(/<COMPANY\b[^>]*>([\s\S]*?)<\/COMPANY>/gi)];
  for (const b of blocks) {
    const m = b[1].match(/<NAME>([^<]+)<\/NAME>/i);
    if (m && m[1].trim()) return m[1].trim();
  }
  return null;
}

// --- the data ---------------------------------------------------------------

const PARTIES = [
  'Anand Traders', 'R & K Hardware', 'Sri Balaji Steels', 'Perfect Electricals',
  'Laxmi Distributors', 'M/s. Verma & Sons', 'New Deepak Agency', 'Royal Tiles',
];

const ITEMS = [
  ['Cement OPC 53', 'Bag', 420],
  ['TMT Bar 12mm', 'Kg', 68],
  ['PVC Pipe 4 inch', 'Nos', 310],
  ['Wire 1.5 sqmm', 'Mtr', 22],
  ['Switch 6A', 'Nos', 95],
];

// Educational mode accepts only these days of the month.
const LEGAL_DAYS = [1, 2, 31];

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(7);

// Bill references must be unique across runs. Restarting at INV-0001 every time
// makes the same reference belong to two different parties, and bill-wise
// netting then settles the wrong invoice.
const RUN = Date.now().toString(36).slice(-4).toUpperCase();
const pick = (a) => a[Math.floor(rnd() * a.length)];
const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Dates going back `months` from today, only on days Tally will accept. */
function dates(months) {
  const out = [];
  const now = new Date();
  for (let m = months - 1; m >= 0; m--) {
    const d = new Date(now.getFullYear(), now.getMonth() - m, 1);
    for (const day of LEGAL_DAYS) {
      const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      if (day > last) continue;
      const dt = new Date(d.getFullYear(), d.getMonth(), day);
      if (dt <= now) out.push(`${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(day)}`);
    }
  }
  return out;
}

function ledgerXml() {
  const parties = PARTIES.map((name) => `
    <LEDGER NAME="${esc(name)}" ACTION="Create">
     <NAME>${esc(name)}</NAME>
     <PARENT>Sundry Debtors</PARENT>
     <ISBILLWISEON>Yes</ISBILLWISEON>
     <!-- Real parties have agreed terms. This is what ageing measures from. -->
     <BILLCREDITPERIOD>30 Days</BILLCREDITPERIOD>
     <LEDGERMOBILE>9${Math.floor(rnd() * 900000000 + 100000000)}</LEDGERMOBILE>
     <OPENINGBALANCE>0</OPENINGBALANCE>
    </LEDGER>`).join('');

  const sales = `
    <LEDGER NAME="Sales" ACTION="Create">
     <NAME>Sales</NAME><PARENT>Sales Accounts</PARENT>
    </LEDGER>`;

  return `<TALLYMESSAGE xmlns:UDF="TallyUDF">${sales}${parties}</TALLYMESSAGE>`;
}

function stockXml() {
  const items = ITEMS.map(([name, unit]) => `
    <STOCKITEM NAME="${esc(name)}" ACTION="Create">
     <NAME>${esc(name)}</NAME>
     <BASEUNITS>${unit}</BASEUNITS>
    </STOCKITEM>`).join('');
  const units = [...new Set(ITEMS.map(([, u]) => u))].map((u) => `
    <UNIT NAME="${u}" ACTION="Create"><NAME>${u}</NAME><ISSIMPLEUNIT>Yes</ISSIMPLEUNIT></UNIT>`).join('');
  return `<TALLYMESSAGE xmlns:UDF="TallyUDF">${units}${items}</TALLYMESSAGE>`;
}

function salesVoucher(n, date, party, amount, billRef) {
  return `
    <VOUCHER VCHTYPE="Sales" ACTION="Create" OBJVIEW="Accounting Voucher View">
     <DATE>${date}</DATE>
     <EFFECTIVEDATE>${date}</EFFECTIVEDATE>
     <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
     <VOUCHERNUMBER>${n}</VOUCHERNUMBER>
     <PARTYLEDGERNAME>${esc(party)}</PARTYLEDGERNAME>
     <NARRATION>Goods sold vide bill ${billRef}</NARRATION>
     <ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>${esc(party)}</LEDGERNAME>
      <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
      <AMOUNT>-${amount}</AMOUNT>
      <BILLALLOCATIONS.LIST>
       <NAME>${billRef}</NAME>
       <BILLTYPE>New Ref</BILLTYPE>
       <!-- Real books carry a credit period. Without one there is no due date,
            so nothing is ever overdue and ageing has nothing to measure. -->
       <BILLCREDITPERIOD>30 Days</BILLCREDITPERIOD>
       <AMOUNT>-${amount}</AMOUNT>
      </BILLALLOCATIONS.LIST>
     </ALLLEDGERENTRIES.LIST>
     <ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>Sales</LEDGERNAME>
      <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
      <AMOUNT>${amount}</AMOUNT>
     </ALLLEDGERENTRIES.LIST>
    </VOUCHER>`;
}

function receiptVoucher(n, date, party, amount, billRef) {
  return `
    <VOUCHER VCHTYPE="Receipt" ACTION="Create" OBJVIEW="Accounting Voucher View">
     <DATE>${date}</DATE>
     <VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME>
     <VOUCHERNUMBER>R${n}</VOUCHERNUMBER>
     <PARTYLEDGERNAME>${esc(party)}</PARTYLEDGERNAME>
     <NARRATION>Received against ${billRef}</NARRATION>
     <ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>Cash</LEDGERNAME>
      <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
      <AMOUNT>-${amount}</AMOUNT>
     </ALLLEDGERENTRIES.LIST>
     <ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>${esc(party)}</LEDGERNAME>
      <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
      <AMOUNT>${amount}</AMOUNT>
      <BILLALLOCATIONS.LIST>
       <NAME>${billRef}</NAME>
       <BILLTYPE>Agst Ref</BILLTYPE>
       <AMOUNT>${amount}</AMOUNT>
      </BILLALLOCATIONS.LIST>
     </ALLLEDGERENTRIES.LIST>
    </VOUCHER>`;
}

function summarise(label, xml) {
  const created = (xml.match(/<CREATED>(\d+)<\/CREATED>/) ?? [])[1] ?? '0';
  const altered = (xml.match(/<ALTERED>(\d+)<\/ALTERED>/) ?? [])[1] ?? '0';
  const errors = (xml.match(/<ERRORS>(\d+)<\/ERRORS>/) ?? [])[1] ?? '0';
  const line = (xml.match(/<LINEERROR>([^<]*)<\/LINEERROR>/) ?? [])[1];
  console.log(`  ${label.padEnd(22)} created ${created}  altered ${altered}  errors ${errors}`);
  if (line) console.log(`      ${line}`);
  return Number(errors) === 0;
}

// --- main -------------------------------------------------------------------

async function main() {
  console.log(`  Tally: ${TALLY}`);
  const company = COMPANY || await openCompany();
  if (!company) {
    console.error('\n  Could not work out which company is open.');
    console.error('  Find it with:  lkp-agent companies --tally ' + TALLY);
    console.error('  Then pass it:  --company "Your Company Name"');
    process.exit(1);
  }
  console.log(`  Company: ${company}\n`);

  summarise('ledgers', await tally(importEnvelope(company, ledgerXml())));
  summarise('stock items', await tally(importEnvelope(company, stockXml())));

  const days = dates(5);
  let vno = 1, receipts = 0;
  const bills = [];
  let batch = '';

  for (const date of days) {
    // two or three invoices per allowed date
    for (let k = 0; k < 2 + Math.floor(rnd() * 2); k++) {
      const party = pick(PARTIES);
      const amount = Math.round((rnd() * 40000 + 3000) / 100) * 100;
      const ref = `INV-${RUN}-${pad(vno, 4)}`;
      batch += salesVoucher(vno, date, party, amount, ref);
      bills.push({ date, party, amount, ref });
      vno++;
    }
  }

  // Settle roughly two thirds of the older bills, so outstanding is realistic
  // rather than every invoice ever raised.
  const older = bills.slice(0, Math.floor(bills.length * 0.7));
  for (const b of older) {
    if (rnd() > 0.65) continue;
    const later = days[Math.min(days.length - 1, days.indexOf(b.date) + 2)];
    batch += receiptVoucher(++receipts, later, b.party, b.amount, b.ref);
  }

  const ok = summarise('vouchers', await tally(
    importEnvelope(company, `<TALLYMESSAGE xmlns:UDF="TallyUDF">${batch}</TALLYMESSAGE>`)));

  console.log(`\n  ${bills.length} invoices, ${receipts} receipts across ${days.length} dates`);
  if (!ok) {
    console.log('\n  Some vouchers were rejected. In Educational mode Tally only');
    console.log('  accepts the 1st, 2nd and 31st of each month.');
  }
  console.log('\n  Now run:  lkp-agent sync --tally ' + TALLY);
}

main().catch((e) => {
  console.error('\n  Failed:', e.message);
  console.error('  Is Tally open, with Enable ODBC = Yes on port 9000?');
  process.exit(1);
});
