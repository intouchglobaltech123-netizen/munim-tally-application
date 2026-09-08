-- A report, arranged the way one person likes to read it.
--
-- Two accountants open the same Trial Balance and want different things: one
-- groups by nature and hides the opening column, the other sorts by size and
-- wants subtotals. Making them redo that on every visit is how a report stops
-- being opened.

CREATE TABLE IF NOT EXISTS saved_views (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  -- Whose view. A view is personal by default: one person's preferred columns
  -- are not an opinion the whole business should inherit.
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  report     text NOT NULL,
  name       text NOT NULL,

  /*
   * The arrangement: columns, order, hidden, sort, grouping, filters, date
   * range, totals, decimals.
   *
   * One jsonb rather than a column each, because every report has different
   * knobs and a migration per knob is not a reasonable trade. Validated in the
   * API against what the report actually offers.
   */
  config     jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Opened automatically when this person opens this report.
  is_default boolean NOT NULL DEFAULT false,
  -- Offered to colleagues. Still owned and edited by whoever made it.
  shared     boolean NOT NULL DEFAULT false,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  UNIQUE (user_id, report, name)
);

CREATE INDEX IF NOT EXISTS saved_views_lookup
  ON saved_views (org_id, report);

/*
 * At most one default per person per report.
 *
 * Enforced here rather than in code: two defaults means the report opens
 * differently depending on row order, which is the kind of bug nobody can
 * reproduce.
 */
CREATE UNIQUE INDEX IF NOT EXISTS saved_views_one_default
  ON saved_views (user_id, report) WHERE is_default;
