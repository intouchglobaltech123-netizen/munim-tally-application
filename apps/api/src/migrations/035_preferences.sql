-- Per-person preferences.
--
-- Deliberately per USER, not per org. Two people looking at the same books want
-- different things on top: the owner wants cash and receivables, the accountant
-- wants the day book, the salesperson wants their own customers. An org-level
-- layout means one of them loses every time.
--
-- A key/value table rather than a column per preference, because the set grows
-- with every screen and a migration per checkbox is how a settings table ends
-- up with ninety columns and no shape.
CREATE TABLE IF NOT EXISTS preferences (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Scoped to a company where it makes sense (a dashboard layout differs per
  -- book), and to the empty string where it does not.
  company_id uuid REFERENCES companies(id) ON DELETE CASCADE,
  key        text NOT NULL,
  value      jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key, company_id)
);

-- PRIMARY KEY does not deduplicate rows where company_id IS NULL, because NULL
-- is not equal to itself. Without this a person accumulates a new global
-- preference row on every save and the newest one wins only by luck.
CREATE UNIQUE INDEX IF NOT EXISTS preferences_global_uniq
  ON preferences (user_id, key) WHERE company_id IS NULL;
