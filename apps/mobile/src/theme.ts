/**
 * One palette, shared by every screen, and mirrored by the web app's CSS
 * variables so the two read as one product.
 *
 * The choices, and why:
 *
 * - A deep emerald rather than a bright one. Bright green reads as a messaging
 *   app; a darker, desaturated green reads as a bank. This screen shows
 *   somebody their money, and it should feel like it.
 * - A gold accent, used sparingly - never for buttons, only for the figure that
 *   matters on a screen. Two loud colours cancel each other out.
 * - Warm neutrals. Cool greys next to green look like a hospital; a trace of
 *   warmth makes plain white cards feel deliberate.
 * - Money colours are not the brand colour. Positive and negative have to be
 *   readable as good and bad without knowing the brand, so they stay red/green
 *   in their conventional sense, and the brand green is kept off numbers.
 */

const emerald = {
  900: '#06351F',
  800: '#0A4A2C',
  700: '#0E6039',   // primary - headers, buttons
  600: '#12784A',
  500: '#189459',
  100: '#D6EBDF',
  50:  '#EDF6F1',
};

const gold = {
  700: '#8A6B12',
  500: '#C8A227',   // accent - the one number that matters
  100: '#F6ECCE',
  50:  '#FBF6E7',
};

const neutral = {
  900: '#101614',   // primary text
  700: '#33413B',
  500: '#5F6E67',   // secondary text
  300: '#9DA9A3',
  200: '#DFE5E2',   // borders
  100: '#EFF2F0',
  50:  '#F7F9F8',   // page background
  0:   '#FFFFFF',
};

export const T = {
  // --- brand -------------------------------------------------------------
  green: emerald[700],
  greenDark: emerald[800],
  greenDeep: emerald[900],
  greenMid: emerald[600],
  greenSoft: emerald[50],
  greenTint: emerald[100],

  gold: gold[500],
  goldDark: gold[700],
  goldSoft: gold[50],

  // --- text and surfaces -------------------------------------------------
  ink: neutral[900],
  inkSoft: neutral[700],
  muted: neutral[500],
  faint: neutral[300],
  line: neutral[200],
  lineSoft: neutral[100],
  bg: neutral[50],
  card: neutral[0],

  // --- money -------------------------------------------------------------
  // Deliberately not the brand green: "you are owed this" must read as good
  // without the reader knowing anything about Munim.
  positive: '#0E7A47',
  positiveSoft: '#E7F4EC',
  negative: '#B3261E',
  negativeSoft: '#FCEBEA',
  warn: '#9A6300',
  warnSoft: '#FFF4E0',
  info: '#0B5A8A',
  infoSoft: '#E7F1F8',

  /*
   * Kept so existing screens read correctly. red/amber were the old names for
   * what money colours now express; they point at the same values rather than
   * a second, drifting set.
   */
  red: '#B3261E',
  redSoft: '#FCEBEA',
  amber: '#9A6300',
  amberSoft: '#FFF4E0',

  /*
   * Type. Inter, loaded in App.tsx.
   *
   * Named by weight rather than by role, because the same weight does different
   * jobs on different screens - and a name like "cardTitle" stops being true
   * the moment a screen needs it somewhere else.
   */
  font: {
    regular: 'Inter_400Regular',
    medium: 'Inter_500Medium',
    semibold: 'Inter_600SemiBold',
    bold: 'Inter_700Bold',
  },

  // --- shape -------------------------------------------------------------
  radius: 16,
  radiusSm: 10,
  radiusLg: 22,
  // Tap targets are for 45-year-old shop owners, not designers.
  tap: 48,

  // A single soft shadow, used at one depth only. Several depths on one screen
  // just look uncertain.
  shadow: {
    shadowColor: '#06351F',
    shadowOpacity: 0.07,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
} as const;

export const scale = { emerald, gold, neutral };
