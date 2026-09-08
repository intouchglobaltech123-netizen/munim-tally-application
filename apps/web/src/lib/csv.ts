'use client';

import { post } from './api';

/**
 * Exporting what is on screen.
 *
 * Done in the browser, from the rows already displayed, rather than by asking
 * the server to build the report again. Two reasons, and the second is the
 * important one:
 *
 *   1. It works offline, on cached data, like the rest of the app.
 *   2. What you export is exactly what you were looking at. A server-side
 *      export re-runs the query and re-formats the numbers, and any drift
 *      between the two - a different period default, a rounding difference -
 *      produces a file that disagrees with the screen it came from. That is
 *      the class of bug this codebase has already been bitten by twice.
 */

export type Column<T> = {
  key: string;
  label: string;
  /** The value as it should appear in the file. */
  value: (row: T) => string | number | null | undefined;
};

/**
 * One CSV field, escaped.
 *
 * Quoted whenever it contains a comma, a quote, a newline, or leading and
 * trailing spaces that a spreadsheet would otherwise eat.
 */
function field(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = String(v);

  /*
   * A leading =, +, - or @ makes Excel treat the cell as a formula.
   *
   * A party genuinely named "=Sons & Co" would otherwise execute as one, which
   * is both wrong and a known way to attack whoever opens the file. Prefixing
   * a single quote is the standard defence and is invisible in the sheet.
   *
   * A plain number is exempt, and that exemption matters: an accounting export
   * is full of negative amounts, and guarding "-5000" would turn every credit
   * balance into text that Excel cannot sum.
   */
  const looksNumeric = typeof v === 'number' || /^-?\d+(\.\d+)?$/.test(s);
  const guarded = !looksNumeric && /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;

  return /[",\n\r]|^\s|\s$/.test(guarded)
    ? `"${guarded.replace(/"/g, '""')}"`
    : guarded;
}

/** Rows and columns to a CSV string. */
export function toCsv<T>(rows: T[], columns: Column<T>[]): string {
  const head = columns.map((c) => field(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => field(c.value(r))).join(','));
  // CRLF, because that is what Excel on Windows expects and this product's
  // customers are on Windows.
  return [head, ...body].join('\r\n');
}

/**
 * Hand the browser a file to save.
 *
 * The BOM is not decoration: without it Excel opens a UTF-8 CSV as Latin-1 and
 * every ₹, every name with a Tamil or Devanagari character, arrives as
 * mojibake. It is the single most common complaint about CSV exports in India.
 */
export function downloadCsv(filename: string, csv: string) {
  /*
   * Tell the server an export happened.
   *
   * The file never touches the server, so this is the only way an export shows
   * up in the audit log - and an export is data leaving the business, which is
   * precisely the thing an owner wants a record of. Fire and forget: a failed
   * beacon must never stop somebody saving their own report.
   */
  post('/v1/audit/event', {
    action: 'export.csv',
    name: filename,
    rows: Math.max(0, csv.split('\r\n').length - 1),
    format: 'csv',
  }).catch(() => {});

  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Freed on the next tick: revoking immediately cancels the download in
  // some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A filename that sorts and does not need quoting. */
export function exportName(report: string, company?: string, period?: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
  return [company && clean(company), clean(report), period && clean(period),
    new Date().toISOString().slice(0, 10)]
    .filter(Boolean).join('_');
}
