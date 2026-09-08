-- Account groups. Trial Balance, P&L and the Balance Sheet are all just the
-- ledger tree rolled up, so without groups none of them can be built.
CREATE TABLE IF NOT EXISTS groups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  guid          text NOT NULL,
  name          text NOT NULL,
  parent        text NOT NULL DEFAULT '',
  primary_group text NOT NULL DEFAULT '',
  alter_id      bigint NOT NULL DEFAULT 0,
  UNIQUE (company_id, guid)
);
CREATE INDEX IF NOT EXISTS groups_company_name ON groups (company_id, name);

-- Which side of the books a ledger sits on, derived from its group.
-- Tally ships a fixed set of top-level groups; everything else hangs off them.
CREATE OR REPLACE FUNCTION account_nature(grp text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN lower(grp) IN ('sales accounts','direct incomes','indirect incomes',
                        'income (direct)','income (indirect)')            THEN 'income'
    WHEN lower(grp) IN ('purchase accounts','direct expenses','indirect expenses',
                        'expenses (direct)','expenses (indirect)')        THEN 'expense'
    WHEN lower(grp) IN ('sundry debtors','cash-in-hand','bank accounts','bank od a/c',
                        'stock-in-hand','deposits (asset)','loans & advances (asset)',
                        'fixed assets','investments','current assets','misc. expenses (asset)')
                                                                          THEN 'asset'
    WHEN lower(grp) IN ('sundry creditors','duties & taxes','provisions','loans (liability)',
                        'secured loans','unsecured loans','current liabilities',
                        'capital account','reserves & surplus','branch / divisions')
                                                                          THEN 'liability'
    ELSE 'other'
  END
$$;

-- Reports the owner pinned to their dashboard.
CREATE TABLE IF NOT EXISTS pinned_reports (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  report  text NOT NULL,
  pinned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, report)
);

-- Revoking a connector must be possible from the app: a stolen or replaced
-- shop PC should stop syncing without anyone visiting it.
ALTER TABLE connectors ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
