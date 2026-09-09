const { test, after } = require('node:test');
const assert = require('node:assert');
const { query } = require('../src/db');
const businesses = require('../src/lib/businesses');
const quotas = require('../src/lib/quotas');

/**
 * One business, several years of Tally companies.
 *
 * An accountant closes the books on 31 March and starts a new company file for
 * the next year, so a shop arrives as three files that are one shop.
 *
 * The bias throughout is against grouping. Two files wrongly merged mixes two
 * customers' books in every report; two files wrongly left apart is a tidiness
 * problem somebody fixes in a click. These tests care mostly about the refusals.
 */

const orgs = [];
after(async () => { for (const id of orgs) await query('DELETE FROM orgs WHERE id = $1', [id]); });

async function org() {
  const { rows } = await query(
    `INSERT INTO orgs (name, plan) VALUES ('biz-test','standard') RETURNING *`);
  orgs.push(rows[0].id);
  return rows[0].id;
}

let seq = 0;
async function file(orgId, { name, gstin = '', fyStart = '' }) {
  const { rows } = await query(
    `INSERT INTO companies (org_id, tally_guid, name, gstin, fy_start)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [orgId, `biz-${orgId}-${++seq}`, name, gstin, fyStart]);
  await businesses.assign(rows[0].id);
  return rows[0];
}

const businessOf = async (companyId) => (await query(
  'SELECT business_id FROM companies WHERE id = $1', [companyId])).rows[0].business_id;

// --- grouping ---------------------------------------------------------------

test('the same shop across two years becomes one business', async () => {
  const o = await org();
  const a = await file(o, { name: 'Acme Traders 2024-25', gstin: '33AABCU9603R1ZM' });
  const b = await file(o, { name: 'Acme Traders 2025-26', gstin: '33AABCU9603R1ZM' });

  assert.equal(await businessOf(a.id), await businessOf(b.id));
});

test('a shared GSTIN groups them even when the names differ', async () => {
  /*
   * One registration is one legal business. Accountants rename files - "Acme
   * Traders" one year, "Acme Trading Co" the next - and the GSTIN is what
   * survives that.
   */
  const o = await org();
  const a = await file(o, { name: 'Acme Traders 2024-25', gstin: '33AABCU9603R1ZM' });
  const b = await file(o, { name: 'Acme Trading Co 2025-26', gstin: '33AABCU9603R1ZM' });

  assert.equal(await businessOf(a.id), await businessOf(b.id));
  const list = await businesses.list(o);
  assert.equal(list.length, 1);
  assert.equal(list[0].matchedOn, 'gstin');
  assert.match(list[0].why, /share a GSTIN/);
});

test('the same name groups them when no GSTIN is recorded', async () => {
  // Many small shops are not registered, and the first year's file often has
  // no GSTIN even when the business is.
  const o = await org();
  const a = await file(o, { name: 'Kumar Stores 2024-25' });
  const b = await file(o, { name: 'Kumar Stores 2025-26' });

  assert.equal(await businessOf(a.id), await businessOf(b.id));
  assert.equal((await businesses.list(o))[0].matchedOn, 'name');
});

test('two DIFFERENT GSTINs are never merged, whatever they are called', async () => {
  /*
   * The most important refusal here. Two branches or two franchisees can be
   * called exactly the same thing and be separate legal businesses - merging
   * them would combine their books in every report, and the name looking right
   * is exactly why nobody would question it.
   */
  const o = await org();
  const a = await file(o, { name: 'Sharma Stores 2025-26', gstin: '33AABCU9603R1ZM' });
  const b = await file(o, { name: 'Sharma Stores 2025-26', gstin: '29AABCU9603R1ZX' });

  assert.notEqual(await businessOf(a.id), await businessOf(b.id));
  assert.equal((await businesses.list(o)).length, 2);
});

test('two genuinely different shops stay apart', async () => {
  const o = await org();
  const a = await file(o, { name: 'Acme Traders 2025-26' });
  const b = await file(o, { name: 'Bharat Steel 2025-26' });
  assert.notEqual(await businessOf(a.id), await businessOf(b.id));
});

test('every way an accountant writes the year is recognised', async () => {
  const o = await org();
  const made = [];
  for (const name of [
    'Verma & Sons 2023-24',
    'Verma & Sons (2024-2025)',
    'Verma & Sons FY25-26',
    'Verma & Sons F.Y. 2026-27',
  ]) made.push(await file(o, { name }));

  const ids = new Set();
  for (const m of made) ids.add(await businessOf(m.id));
  assert.equal(ids.size, 1, 'four years of one shop became more than one business');
});

test('a single file is its own business, and says so', async () => {
  const o = await org();
  await file(o, { name: 'Only Shop' });
  const list = await businesses.list(o);
  assert.equal(list[0].matchedOn, 'single');
  assert.equal(list[0].why, '', 'nothing to explain when nothing was grouped');
});

// --- the year label ---------------------------------------------------------

test('the financial year is read from Tally\'s own start date', async () => {
  const o = await org();
  const a = await file(o, { name: 'Dated Shop', fyStart: '20250401' });
  const { rows } = await query('SELECT fy_label FROM companies WHERE id = $1', [a.id]);
  assert.equal(rows[0].fy_label, '2025-26');
});

test('a book starting before April belongs to the year that began the previous April', () => {
  // A file opened in January 2025 is still FY 2024-25.
  assert.equal(businesses.fyLabel('20250101'), '2024-25');
  assert.equal(businesses.fyLabel('20250401'), '2025-26');
  assert.equal(businesses.fyLabel('20250331'), '2024-25');
});

test('a missing start date gives no label rather than a wrong one', () => {
  assert.equal(businesses.fyLabel(''), '');
  assert.equal(businesses.fyLabel(null), '');
});

// --- what it unblocks -------------------------------------------------------

test('three years of one shop count as ONE company against the plan', async () => {
  /*
   * The reason this exists. Counting files meant a customer on a one-company
   * ceiling was over their limit the day they connected, and the product
   * stopped working for one of the most ordinary setups in the country.
   */
  const o = await org();
  for (const y of ['2023-24', '2024-25', '2025-26']) {
    await file(o, { name: `Acme Traders ${y}`, gstin: '33AABCU9603R1ZM' });
  }

  const usage = await quotas.usageFor(o);
  assert.equal(usage.companies, 1, 'they are paying to see one shop');
  assert.equal(usage.companyFiles, 3, 'and the file count is still reported');

  /*
   * And they fit inside a one-company ceiling rather than blowing through it.
   *
   * Asserted against an explicit override rather than the plan: the sold plan
   * has no company limit, which would make this pass for the wrong reason and
   * keep passing if grouping broke. An override of 1 is the tightest ceiling
   * the product can express, and three years of one shop must still fit.
   *
   * Not asserted through assertWithin, which is a BEFORE-ADDING check and
   * correctly refuses a second business on a one-business ceiling. What matters
   * here is that three years of one shop does not by itself exceed the limit -
   * before this change it counted as three and did.
   */
  const plans = require('../src/lib/plans');
  const ceiling = plans.limitFor({ plan: 'standard', limits: { companies: 1 } }, 'companies');
  assert.equal(ceiling, 1, 'the override is what is being tested against');
  assert.ok(usage.companies <= ceiling,
    `${usage.companies} businesses against a limit of ${ceiling}`);
});

test('two real businesses still count as two', async () => {
  const o = await org();
  await file(o, { name: 'Acme Traders 2025-26', gstin: '33AABCU9603R1ZM' });
  await file(o, { name: 'Bharat Steel 2025-26', gstin: '29AABCU9603R1ZX' });

  assert.equal((await quotas.usageFor(o)).companies, 2);
});

// --- correcting it by hand --------------------------------------------------

test('two files can be put together by hand', async () => {
  // The heuristics will not catch a shop renamed entirely, so a person can say.
  const o = await org();
  const a = await file(o, { name: 'Old Name' });
  const b = await file(o, { name: 'Completely New Name' });
  assert.notEqual(await businessOf(a.id), await businessOf(b.id));

  await businesses.regroup(o, b.tally_guid, await businessOf(a.id));
  assert.equal(await businessOf(a.id), await businessOf(b.id));
  assert.equal((await businesses.list(o))[0].matchedOn, 'manual');
});

test('a file wrongly grouped can be split out again', async () => {
  const o = await org();
  const a = await file(o, { name: 'Same Name 2024-25' });
  const b = await file(o, { name: 'Same Name 2025-26' });
  assert.equal(await businessOf(a.id), await businessOf(b.id));

  await businesses.regroup(o, b.tally_guid, null);
  assert.notEqual(await businessOf(a.id), await businessOf(b.id));
});

test('splitting the last file out does not leave an empty business behind', async () => {
  // An empty business would sit in the switcher for ever with nothing under it.
  const o = await org();
  const a = await file(o, { name: 'Solo 2024-25' });
  const b = await file(o, { name: 'Solo 2025-26' });
  await businesses.regroup(o, b.tally_guid, null);

  const list = await businesses.list(o);
  assert.equal(list.length, 2);
  for (const biz of list) assert.ok(biz.companies > 0, 'an empty business survived');
});

test('regrouping never reaches a different account\'s files', async () => {
  const a = await org();
  const b = await org();
  const mine = await file(a, { name: 'Mine' });
  const theirs = await file(b, { name: 'Theirs' });

  const out = await businesses.regroup(b, mine.tally_guid, await businessOf(theirs.id));
  assert.equal(out, null, 'a company from another account was not found');
  assert.notEqual(await businessOf(mine.id), await businessOf(theirs.id));
});

// --- finding last year ------------------------------------------------------

test('a business can find the file for a given year', async () => {
  /*
   * What makes a year-on-year comparison possible at all: last year's figures
   * are in a different file, and this is how a report finds it.
   */
  const o = await org();
  const a = await file(o, { name: 'Acme 2024-25', gstin: '33AABCU9603R1ZM', fyStart: '20240401' });
  await file(o, { name: 'Acme 2025-26', gstin: '33AABCU9603R1ZM', fyStart: '20250401' });

  const bizId = await businessOf(a.id);
  const lastYear = await businesses.companyForYear(bizId, '2024-25');
  assert.equal(lastYear.fy_label, '2024-25');

  const newest = await businesses.companyForYear(bizId, '');
  assert.equal(newest.fy_label, '2025-26', 'no year asked for gives the latest');
});
