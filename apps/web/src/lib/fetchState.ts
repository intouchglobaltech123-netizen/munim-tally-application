/**
 * What to show while a request is in flight.
 *
 * Pulled out of useApi so it can be reasoned about and tested on its own: it is
 * three booleans, and getting them wrong is the difference between a filter
 * that feels instant and one that blanks the page every time it is pressed.
 */

/**
 * The endpoint, without its query string.
 *
 * The whole rule turns on this. Two requests to the same endpoint with
 * different parameters return the SAME SHAPE — a sales report for 30 days and
 * for 90 days have identical fields. Two requests to different endpoints do
 * not, and rendering one over the other crashes on a field that is not there.
 *
 * The company id lives in the PATH, not the query, so switching company counts
 * as a different endpoint and correctly clears. Showing one company's figures
 * while another loads would be far worse than a flicker.
 */
export const shapeOf = (p: string | null) => (p ? p.split('?')[0] : null);

export type FetchState = {
  /** There is something worth rendering. */
  usable: boolean;
  /** There is nothing at all to show — the only time a skeleton is right. */
  loading: boolean;
  /** What is on screen is about to be replaced; grey it, do not remove it. */
  refreshing: boolean;
};

export function fetchState(
  forPath: string | null,
  path: string | null,
  loading: boolean,
): FetchState {
  const matches = forPath === path;

  const sameShape = !matches && !!forPath && !!path
    && shapeOf(forPath) === shapeOf(path);

  const usable = matches || sameShape;

  return {
    usable,
    loading: (loading && !usable) || (!!path && !usable),
    refreshing: (loading || sameShape) && usable,
  };
}
