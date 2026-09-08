'use strict';
// Mock Tally XML gateway. Emulates Tally Prime / ERP 9 on port 9000 so the
// connector can be developed and CI-tested without a Windows PC.
//
//   node src/index.js [--port 9000]
//
// Fault injection (query string on the request URL):
//   ?fault=malformed | truncated | timeout | no_company | alterid_reset | html
// Control endpoints (GET):
//   /_state                        current alter-id cursors
//   /_mutate?company=<guid>        bump one voucher's AlterID (proves incremental sync)
//   /_delete?company=<guid>        remove one voucher   (proves deletion reconcile)
//   /_reset_alterid?company=<guid> simulate a backup restore

const http = require('http');
const { URL } = require('url');
const seed = require('./seed');
const R = require('./render');

const state = seed.build();
const PORT = Number(process.argv[process.argv.indexOf('--port') + 1]) || 9000;

// --- request parsing -------------------------------------------------------
// Tally requests are XML; we only need a few things out of them.
function parseRequest(xml) {
  const id = (xml.match(/<ID>([^<]*)<\/ID>/i) || [])[1] || '';
  const type = (xml.match(/<TYPE>([^<]*)<\/TYPE>/gi) || [])
    .map((s) => s.replace(/<\/?TYPE>/gi, ''))
    .find((t) => !/^(Collection|Object|Data)$/i.test(t)) || '';
  const company = (xml.match(/<SVCURRENTCOMPANY>([^<]*)<\/SVCURRENTCOMPANY>/i) || [])[1] || '';
  // The whole point: honour "$AlterID > N"
  const m = xml.match(/\$AlterID\s*(?:&gt;|>)\s*(\d+)/i);
  const alterId = m ? Number(m[1]) : -1;
  const month = (xml.match(/<SVMONTH>([^<]*)<\/SVMONTH>/i) || [])[1] || '';
  return { id, type, company, alterId, month };
}

function companyByName(name) {
  return state.companies.find((c) => c.name === name) || state.companies[0];
}

function route(req) {
  const { type, company, alterId, id, month } = req;
  const c = companyByName(company);
  const d = state.db[c.guid];
  const above = (arr) => arr.filter((x) => x.alterId > alterId);

  if (/company/i.test(type) || /ListOfCompanies/i.test(id)) return R.companies(state.companies);
  if (/^group$/i.test(type)) return R.groups(above(d.groups));
  if (/^ledger$/i.test(type)) return R.ledgers(above(d.ledgers));
  if (/^stockitem$/i.test(type)) return R.stockItems(above(d.stockItems));
  if (/^vouchertype$/i.test(type)) return R.voucherTypes(d.vchTypes);
  if (/^voucher$/i.test(type)) {
    if (/reconcile/i.test(id)) {
      const list = month ? d.vouchers.filter((v) => v.date.startsWith(month)) : d.vouchers;
      return R.guidList(list);
    }
    return R.vouchers(above(d.vouchers));
  }
  return R.companies([]); // unknown collection -> empty, never an error
}

// --- fault injection -------------------------------------------------------
function applyFault(fault, xml, res) {
  switch (fault) {
    case 'malformed':
      return xml.replace('</ENVELOPE>', '</ENVELOP');            // unclosed tag
    case 'truncated':
      return xml.slice(0, Math.floor(xml.length / 2));
    case 'no_company':
      return '<ENVELOPE><HEADER><STATUS>0</STATUS></HEADER><BODY><DESC><LINEERROR>' +
             'Could not set "Company" to current company' +
             '</LINEERROR></DESC></BODY></ENVELOPE>';
    case 'html':
      res.setHeader('Content-Type', 'text/html');
      return '<html><body><h1>Tally is busy</h1></body></html>';
    default:
      return xml;
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // control endpoints
  if (req.method === 'GET') {
    const guid = url.searchParams.get('company') || state.companies[0].guid;
    const d = state.db[guid];
    if (url.pathname === '/_state') {
      return json(res, state.companies.map((c) => ({
        guid: c.guid,
        name: c.name,
        maxMasterAlterId: Math.max(...state.db[c.guid].ledgers.map((l) => l.alterId)),
        maxVoucherAlterId: Math.max(...state.db[c.guid].vouchers.map((v) => v.alterId)),
        vouchers: state.db[c.guid].vouchers.length,
      })));
    }
    if (url.pathname === '/_mutate') {
      const max = Math.max(...d.vouchers.map((v) => v.alterId));
      const v = d.vouchers[Math.floor(d.vouchers.length / 2)];
      v.alterId = max + 1;
      v.amount = v.amount - 1000;
      return json(res, { mutated: v.guid, newAlterId: v.alterId });
    }
    if (url.pathname === '/_delete') {
      const v = d.vouchers.pop();
      return json(res, { deleted: v.guid, remaining: d.vouchers.length });
    }
    if (url.pathname === '/_reset_alterid') {
      d.vouchers.forEach((v, i) => { v.alterId = 1 + i; });
      return json(res, { reset: true, maxVoucherAlterId: d.vouchers.length });
    }
    res.writeHead(405).end('POST XML to / , or use /_state');
    return;
  }

  let body = '';
  req.on('data', (ch) => { body += ch; });
  req.on('end', () => {
    const fault = url.searchParams.get('fault');
    if (fault === 'timeout') return;                              // never respond

    const parsed = parseRequest(body);
    if (fault === 'alterid_reset') parsed.alterId = -1;

    let xml;
    try {
      xml = route(parsed);
    } catch (e) {
      xml = '<ENVELOPE><BODY><DESC><LINEERROR>' + e.message + '</LINEERROR></DESC></BODY></ENVELOPE>';
    }

    res.setHeader('Content-Type', 'text/xml');
    xml = applyFault(fault, xml, res);

    // Real Tally prefixes junk control bytes and speaks CP-1252, not UTF-8.
    const junk = Buffer.from([0x04, 0x00, 0x1b]);
    const payload = Buffer.concat([junk, Buffer.from(xml, 'latin1')]);
    res.writeHead(200);
    res.end(payload);
  });
});

function json(res, obj) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj, null, 2));
}

server.listen(PORT, () => {
  console.log(`mock-tally listening on http://localhost:${PORT}`);
  for (const c of state.companies) {
    const d = state.db[c.guid];
    console.log(`  ${c.name}  ledgers=${d.ledgers.length} vouchers=${d.vouchers.length}`);
  }
});
