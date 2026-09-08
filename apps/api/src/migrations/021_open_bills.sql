-- One row per bill, not one row per allocation.
--
-- `bills` mirrors Tally exactly: an invoice writes a "New Ref" row, and every
-- receipt against it writes an "Agst Ref" row carrying a negative amount. That
-- is faithful, and it is the wrong shape for every question anyone asks of it.
--
-- Reports were filtering `amount_paise > 0`, which keeps the invoice AND any
-- positive allocation rows while dropping the settlements that cancel them.
-- On real books that reported ₹27,60,900 outstanding where the ledgers said
-- ₹14,24,700 - the headline receivables figure, overstated by 94%.
--
-- The outstanding amount for a reference is the SUM across all its rows. This
-- view is that, and every report reads it instead.

CREATE OR REPLACE VIEW open_bills AS
SELECT
  b.company_id,
  b.ref,
  /*
   * The invoice's own party and dates, not a settlement's.
   *
   * A receipt allocates against the same reference but posts to Cash or a
   * bank, so taking any row's party at random would file half the debtors'
   * bills under "Cash". Ordering by amount picks the largest positive row,
   * which is the invoice.
   */
  (array_agg(b.party      ORDER BY b.amount_paise DESC))[1] AS party,
  (array_agg(b.bill_date  ORDER BY b.amount_paise DESC))[1] AS bill_date,
  (array_agg(b.due_date   ORDER BY b.amount_paise DESC))[1] AS due_date,
  (array_agg(b.voucher_id ORDER BY b.amount_paise DESC))[1] AS voucher_id,
  SUM(b.amount_paise)::bigint AS amount_paise,
  count(*)::int AS allocations
FROM bills b
GROUP BY b.company_id, b.ref
-- Settled and over-settled references are not outstanding, so they are not
-- here at all. A report asking this view for open bills cannot accidentally
-- include one.
HAVING SUM(b.amount_paise) > 0;
