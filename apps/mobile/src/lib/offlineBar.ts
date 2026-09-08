/**
 * When to interrupt somebody with a connection warning.
 *
 * One predicate, in its own file, because getting it wrong is not a cosmetic
 * problem: a warning that appears on every click is one nobody believes when it
 * finally means something.
 *
 * The bar used to trigger on `ageMs !== null` — the age of cached data. But the
 * hook paints cached figures on EVERY navigation, for the few hundred
 * milliseconds before the fresh ones arrive. So every click flashed
 * "No connection" and withdrew it. Being briefly on cached data is the cache
 * working, not an outage.
 */
export type BarState =
  | { show: false }
  | { show: true; text: string };

export function offlineBar(
  offline: boolean,
  ageMs: number | null,
  ageLabel: (ms: number) => string,
): BarState {
  // Connectivity only. Cached-and-fetching is not an outage.
  if (!offline) return { show: false };

  /*
   * Once we really are offline the age matters, because a stale figure
   * presented as current is how somebody chases the wrong customer.
   */
  return {
    show: true,
    text: ageMs === null
      ? 'No connection'
      : `No connection — showing figures from ${ageLabel(ageMs)}`,
  };
}
