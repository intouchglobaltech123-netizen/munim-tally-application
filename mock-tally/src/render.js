'use strict';
const { inr } = require('./seed');

// Tally does NOT escape everything correctly. It emits bare & in names and
// sprinkles control characters. We reproduce that faithfully so the connector's
// sanitizer is tested against reality, not against well-formed XML.
const SOH = String.fromCharCode(0x04);

function dirty(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&')            // left bare, exactly like Tally
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Tally leaves & bare in element TEXT, but it does escape quotes inside
// ATTRIBUTE values - otherwise its own output would be unparseable.
function attr(s) {
  return dirty(s).replace(/"/g, '&quot;');
}

const wrap = (inner) =>
  `<ENVELOPE>\n <BODY>\n  <DATA>\n   <COLLECTION>${inner}\n   </COLLECTION>\n  </DATA>\n </BODY>\n</ENVELOPE>`;

function companies(list) {
  return wrap(list.map((c) => `
    <COMPANY>
     <NAME>${dirty(c.name)}</NAME>
     <GUID>${c.guid}</GUID>
     <STARTINGFROM>${c.fyStart}</STARTINGFROM>
     <ALTERID>${c.alterId}</ALTERID>
    </COMPANY>`).join(''));
}

function groups(list) {
  return wrap(list.map((g) => `
    <GROUP NAME="${attr(g.name)}">
     <NAME>${dirty(g.name)}</NAME>
     <GUID>${g.guid}</GUID>
     <PARENT>${dirty(g.parent)}</PARENT>
     <PRIMARYGROUP>${dirty(g.primary)}</PRIMARYGROUP>
     <ALTERID>${g.alterId}</ALTERID>
    </GROUP>`).join(''));
}

function ledgers(list) {
  return wrap(list.map((l) => `
    <LEDGER NAME="${attr(l.name)}">
     <NAME>${dirty(l.name)}</NAME>
     <GUID>${l.guid}</GUID>
     <PARENT>${dirty(l.parent)}</PARENT>
     <OPENINGBALANCE>${inr(l.opening)}</OPENINGBALANCE>
     <CLOSINGBALANCE>${inr(l.closing)}</CLOSINGBALANCE>
     <LEDGERPHONE>${l.phone || ''}</LEDGERPHONE>
     <LEDGERMOBILE>${l.phone || ''}</LEDGERMOBILE>
     <EMAIL></EMAIL>
     <PARTYGSTIN>${l.gstin || ''}</PARTYGSTIN>
     <BILLCREDITPERIOD>${l.creditDays ? l.creditDays + ' Days' : ''}</BILLCREDITPERIOD>
     <ALTERID>${l.alterId}</ALTERID>
    </LEDGER>`).join(''));
}

function stockItems(list) {
  return wrap(list.map((s) => `
    <STOCKITEM NAME="${attr(s.name)}">
     <NAME>${dirty(s.name)}</NAME>
     <GUID>${s.guid}</GUID>
     <BASEUNITS>${s.unit}</BASEUNITS>
     <CLOSINGBALANCE>${s.closingQty} ${s.unit}</CLOSINGBALANCE>
     <CLOSINGVALUE>${inr(s.closingValue)}</CLOSINGVALUE>
     <ALTERID>${s.alterId}</ALTERID>
    </STOCKITEM>`).join(''));
}

function voucherTypes(list) {
  return wrap(list.map((v, i) => `
    <VOUCHERTYPE NAME="${attr(v.name)}">
     <NAME>${dirty(v.name)}</NAME>
     <GUID>vt-${i}</GUID>
     <PARENT>${v.parent}</PARENT>
    </VOUCHERTYPE>`).join(''));
}

function vouchers(list) {
  return wrap(list.map((v) => {
    const items = v.items.map((it) => `
      <ALLINVENTORYENTRIES.LIST>
       <STOCKITEMNAME>${dirty(it.name)}</STOCKITEMNAME>
       <ACTUALQTY>${it.qty} Nos</ACTUALQTY>
       <RATE>${inr(it.rate)}/Nos</RATE>
       <AMOUNT>${inr(-it.amount)}</AMOUNT>
      </ALLINVENTORYENTRIES.LIST>`).join('');

    const bill = v.bill ? `
      <BILLALLOCATIONS.LIST>
       <NAME>${v.bill.ref}</NAME>
       <BILLTYPE>New Ref</BILLTYPE>
       <BILLCREDITPERIOD>${v.bill.dueDate}</BILLCREDITPERIOD>
       <AMOUNT>${inr(-v.bill.amount)}</AMOUNT>
      </BILLALLOCATIONS.LIST>` : '';

    return `
    <VOUCHER VCHTYPE="${attr(v.vchType)}" ACTION="Create">
     <GUID>${v.guid}</GUID>
     <DATE>${v.date}</DATE>
     <VOUCHERTYPENAME>${dirty(v.vchType)}</VOUCHERTYPENAME>
     <VOUCHERNUMBER>${v.vchNo}</VOUCHERNUMBER>
     <PARTYLEDGERNAME>${dirty(v.party)}</PARTYLEDGERNAME>
     <NARRATION>${dirty(v.narration)}</NARRATION>
     <AMOUNT>${inr(v.amount)}</AMOUNT>
     <ISCANCELLED>${v.isCancelled ? 'Yes' : 'No'}</ISCANCELLED>
     <ISOPTIONAL>No</ISOPTIONAL>
     <ALTERID>${v.alterId}</ALTERID>
     <ALLLEDGERENTRIES.LIST>
      <LEDGERNAME>${dirty(v.party)}</LEDGERNAME>
      <ISDEEMEDPOSITIVE>${v.amount < 0 ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>
      <AMOUNT>${inr(-v.amount)}</AMOUNT>${bill}
     </ALLLEDGERENTRIES.LIST>${items}
    </VOUCHER>`;
  }).join(''));
}

// GUID-only listing used by the nightly deletion reconcile
function guidList(list) {
  return wrap(list.map((v) => `
    <VOUCHER><GUID>${v.guid}</GUID><ALTERID>${v.alterId}</ALTERID></VOUCHER>`).join(''));
}

module.exports = { companies, groups, ledgers, stockItems, voucherTypes, vouchers, guidList, SOH };
