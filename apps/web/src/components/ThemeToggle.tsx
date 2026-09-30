'use client';

import { useEffect, useState } from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';

/**
 * Light, dark, or whatever the machine says.
 *
 * Three states rather than two, because "follow the system" is the only one
 * that is right at both ends of the day, and a two-way switch quietly takes
 * that away from somebody who already set it once for every other app.
 *
 * The choice is written to the root element as data-theme, which is what the
 * palette in globals.css keys off. localStorage is read again before paint by
 * a tiny script in layout.tsx - without that, a person who chose dark gets a
 * white flash on every page load.
 */

type Choice = 'light' | 'dark' | 'system';

export const THEME_KEY = 'munim.theme';

const NEXT: Record<Choice, Choice> = { system: 'dark', dark: 'light', light: 'system' };
const LABEL: Record<Choice, string> = {
  system: 'Theme: follows your device',
  dark: 'Theme: dark',
  light: 'Theme: light',
};

export default function ThemeToggle() {
  /*
   * Starts as 'system' on the server and on the first client render, matching
   * what the HTML says, and corrects itself in the effect below. Reading
   * localStorage during render would make the two disagree, which React
   * reports as a hydration error.
   */
  const [choice, setChoice] = useState<Choice>('system');

  useEffect(() => {
    try {
      const saved = localStorage.getItem(THEME_KEY) as Choice | null;
      if (saved === 'dark' || saved === 'light') setChoice(saved);
    } catch {
      // A browser with site data blocked still gets the system theme.
    }
  }, []);

  function choose(next: Choice) {
    setChoice(next);
    try { localStorage.setItem(THEME_KEY, next); } catch { /* not fatal */ }
    const root = document.documentElement;
    if (next === 'system') delete root.dataset.theme;
    else root.dataset.theme = next;
  }

  const Icon = choice === 'dark' ? Moon : choice === 'light' ? Sun : Monitor;

  return (
    <button
      type="button"
      onClick={() => choose(NEXT[choice])}
      title={LABEL[choice]}
      aria-label={LABEL[choice]}
      className="rounded-xl border border-line bg-surface p-2 text-muted
                 transition-colors hover:border-faint hover:text-ink"
    >
      <Icon size={16} />
    </button>
  );
}
