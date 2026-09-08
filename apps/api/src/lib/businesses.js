'use strict';
const { query } = require('../db');

/**
 * Working out which Tally files are the same shop.
 *
 * An accountant closes the books on 31 March and starts a new company for the
 * next year, so one business arrives as "Acme Traders 2024-25", "Acme Traders
 * 2025-26", and so on. They are different files with different GUIDs and they
 * are the same shop.
 *
 * The bias throughout is towards NOT grouping. Two files wrongly treated as one
 * business merges two customers' books in every report - the worst thing this
 * product could do - while two files wrongly left apart is a tidiness problem
 * somebody can fix in one click. So a match needs real evidence, and the
 * evidence is recorded on the row so anybody can see what it was.
 */

/**
 * The year label out of a company name.
 *
 * Tally names carry the year in every format a human might type it, and the
 * name minus that year is the thing worth comparing.
 */
const YEAR_PATTERNS = [
  // 2024-25, 2024-2025, 2024_25, 2024/25
  /\b(20\d{2})\s*[-_/]\s*(20\d{2}|\d{2})\b/,
  // FY 2024-25, F.Y.2024-25, FY24-25
  /\bF\.?\s?Y\.?\s*(20\d{2}|\d{2})\s*[-_/]\s*(20\d{2}|\d{2})\b/i,
  // A bare year at the end: "Acme Traders 2025"
  /\b(20\d{2})\b\s*$/,
];

/**
 * The name with any financial year taken out.
 *
 * Also strips the punctuation and spacing that differ between years - somebody
 * types "Acme Traders (2024-25)" one April and "Acme Traders 2025-26" the next.
 */
function baseName(name) {
  let out = String(name ?? '');
  for (const re of YEAR_PATTERNS) out = out.replace(re, ' ');
  return out
    .replace(/\bF\.?\s?Y\.?\b/gi, ' ')
    .replace(/[()\[\]{}._\-\/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** A readable label for the year a file covers, from Tally's own dates. */
function fyLabel(fyStart) {
  if (!fyStart) return '';
  // Tally reports YYYYMMDD, sometimes as a string, sometimes already a date.
  const text = String(fyStart).replace(/[^0-9]/g, '');
  if (text.length < 6) return '';
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(4, 6));
  if (!year || !month) return '';
  // A book starting in April 2025 is FY 2025-26; one starting in January is
  // still the year that began the previous April.
  const start = month >= 4 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/**
 * Decide which business a company belongs to, creating one if needed.
 *
 * Two signals, and only two:
 *
 *   GSTIN  - the strongest evidence there is. One registration is one legal
 *            business, and an accountant carries it into every year's file.
 *   NAME   - the same name once the financial year is stripped out. Weaker, so
 *            it only applies when the GSTIN is absent on one side or the other;
 *            two files with DIFFERENT GSTINs are never merged whatever they are
 *            called, because that is two businesses that share a name.
 */
async function assign(companyId) {
  const { rows } = await query('SELECT * FROM companies WHERE id = $1', [companyId]);
  if (!rows.length) return null;
  const co = rows[0];

  const gstin = String(co.gstin ?? '').trim().toUpperCase();
  const base = baseName(co.name);
  const label = fyLabel(co.fy_start);

  // Everything else this org has, to compare against.
  const { rows: siblings } = await query(
    `SELECT c.*, b.id AS business_id, b.gstin AS business_gstin
       FROM companies c
       LEFT JOIN businesses b ON b.id = c.business_id
      WHERE c.org_id = $1 AND c.id <> $2`, [co.org_id, co.id]);

  let match = null;
  let matchedOn = null;

  if (gstin) {
    /*
     * Same registration, same business. Nothing overrides this - not a
     * different name, not a different year.
     */
    const byGstin = siblings.find(
      (x) => String(x.gstin ?? '').trim().toUpperCase() === gstin && x.business_id);
    if (byGstin) { match = byGstin.business_id; matchedOn = 'gstin'; }
  }

  if (!match && base) {
    const byName = siblings.find((x) => {
      if (!x.business_id) return false;
      if (baseName(x.name) !== base) return false;

      /*
       * Refuse when both sides have a GSTIN and they differ.
       *
       * Two shops genuinely called the same thing - a franchise, two branches
       * registered separately - would otherwise be merged, and their combined
       * books would be wrong in a way nobody would question because the name
       * looks right.
       */
      const theirs = String(x.gstin ?? '').trim().toUpperCase();
      if (gstin && theirs && gstin !== theirs) return false;
      return true;
    });
    if (byName) { match = byName.business_id; matchedOn = 'name'; }
  }

  if (!match) {
    const { rows: made } = await query(
      `INSERT INTO businesses (org_id, name, matched_on, gstin)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [co.org_id, co.name.replace(/\s+/g, ' ').trim(), 'single', gstin]);
    match = made[0].id;
    matchedOn = 'single';
  }

  await query(
    `UPDATE companies SET business_id = $2, fy_label = $3
      WHERE id = $1 AND org_id = $4`, [co.id, match, label, co.org_id]);

  /*
   * Keep the business named after its most recent file, and carry a GSTIN up
   * once one is known - the first year's file often has none, and the second
   * year's does.
   */
  if (matchedOn !== 'single') {
    await query(
      `UPDATE businesses SET
         name = COALESCE(NULLIF($2,''), name),
         gstin = COALESCE(NULLIF(gstin,''), $3),
         matched_on = CASE WHEN matched_on = 'single' THEN $4 ELSE matched_on END
       WHERE id = $1`,
      [match, co.name.replace(/\s*\b(20\d{2}\s*[-_/]\s*(20\d{2}|\d{2}))\b\s*/g, ' ')
        .replace(/\s+/g, ' ').trim(), gstin, matchedOn]);
  }

  return { businessId: match, matchedOn, fyLabel: label };
}

/** The businesses an org has, with the years under each. */
async function list(orgId) {
  const { rows } = await query(
    `SELECT b.id, b.name, b.matched_on, b.gstin,
            json_agg(json_build_object(
              'tallyGuid', c.tally_guid,
              'name', c.name,
              'fyLabel', c.fy_label,
              'lastSyncAt', c.last_sync_at,
              'enabled', c.enabled
            ) ORDER BY c.fy_label DESC NULLS LAST, c.name) AS years,
            count(c.id)::int AS company_count
       FROM businesses b
       JOIN companies c ON c.business_id = b.id
      WHERE b.org_id = $1
      GROUP BY b.id
      ORDER BY b.name`, [orgId]);

  return rows.map((b) => ({
    id: b.id,
    name: b.name,
    gstin: b.gstin || null,
    matchedOn: b.matched_on,
    years: b.years,
    companies: b.company_count,
    /*
     * Said in words on the screen, because "why are these two together" is the
     * first question anybody asks and the honest answer differs.
     */
    why: b.matched_on === 'gstin'
      ? 'Grouped because these files share a GSTIN.'
      : b.matched_on === 'name'
        ? 'Grouped because these files have the same name apart from the year.'
        : b.matched_on === 'manual'
          ? 'Grouped by you.'
          : '',
  }));
}

/**
 * The company in this business that covers a given year, or the newest.
 *
 * What makes a year-on-year comparison possible at all: last year's figures are
 * in a different file, and this is how a report finds it.
 */
async function companyForYear(businessId, fyLabel) {
  const { rows } = await query(
    `SELECT * FROM companies
      WHERE business_id = $1 AND ($2 = '' OR fy_label = $2)
      ORDER BY fy_label DESC NULLS LAST LIMIT 1`, [businessId, fyLabel ?? '']);
  return rows[0] ?? null;
}

/** Put two files together, or split one out, by hand. */
async function regroup(orgId, tallyGuid, businessId) {
  const { rows } = await query(
    'SELECT * FROM companies WHERE org_id = $1 AND tally_guid = $2', [orgId, tallyGuid]);
  if (!rows.length) return null;

  if (businessId) {
    const { rows: b } = await query(
      'SELECT id FROM businesses WHERE id = $1 AND org_id = $2', [businessId, orgId]);
    if (!b.length) return null;
    await query('UPDATE companies SET business_id = $2 WHERE id = $1',
      [rows[0].id, businessId]);
    await query(`UPDATE businesses SET matched_on = 'manual' WHERE id = $1`, [businessId]);
  } else {
    // Split out: its own business again.
    const { rows: made } = await query(
      `INSERT INTO businesses (org_id, name, matched_on, gstin)
       VALUES ($1,$2,'manual',$3) RETURNING id`,
      [orgId, rows[0].name, String(rows[0].gstin ?? '')]);
    await query('UPDATE companies SET business_id = $2 WHERE id = $1',
      [rows[0].id, made[0].id]);
  }

  /*
   * A business nobody is in should not linger in the switcher.
   */
  await query(
    `DELETE FROM businesses b
      WHERE b.org_id = $1
        AND NOT EXISTS (SELECT 1 FROM companies c WHERE c.business_id = b.id)`,
    [orgId]);

  return list(orgId);
}

module.exports = { assign, list, regroup, companyForYear, baseName, fyLabel };
