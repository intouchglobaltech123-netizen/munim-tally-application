/**
 * Initials and a stable colour for a party disc.
 *
 * Pure, and in its own file so it can be tested without a JSX transform — and
 * so the web and the phone cannot drift on what a given customer looks like.
 *
 * The point of the disc is that somebody picks one customer out of forty
 * WITHOUT reading. That only works if the mark is stable: the same name must
 * give the same letters and the same colour on every screen, for ever. A random
 * or rotating colour would look identical and do nothing.
 */

export function initialsOf(name: string) {
  const words = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';

  /*
   * Two letters from two words, otherwise the first two of one.
   *
   * A single letter distinguishes nothing in a list where four names begin
   * with M, which is most Indian ledgers.
   */
  const letters = words.length > 1
    ? `${words[0][0]}${words[1][0]}`
    : words[0].slice(0, 2);
  return letters.toUpperCase();
}

/**
 * A stable index into a palette, derived from the name.
 *
 * Not random and not assigned in list order: a colour that changes when the
 * list is re-sorted is worse than no colour, because the eye has already
 * learned the old one.
 */
export function toneIndex(name: string, buckets: number) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(hash) % buckets;
}
