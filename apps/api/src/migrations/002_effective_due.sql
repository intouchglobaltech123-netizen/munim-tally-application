-- Tally does not echo a bill's credit period back in the voucher export, so the
-- due date usually arrives NULL. An accountant would fall back to the party's
-- agreed credit terms, and failing that treat the invoice as due on
-- presentation. Without this every bill looks "not due" and ageing is empty -
-- which is the single screen customers actually pay for.
CREATE OR REPLACE FUNCTION effective_due(
  due date, billed date, credit_days integer
) RETURNS date
LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(due, billed + COALESCE(credit_days, 0))
$$;
