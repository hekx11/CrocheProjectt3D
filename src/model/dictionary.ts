import type { StitchType } from './types';

/** Height of each stitch relative to sc (research/gauge-and-tension.md). */
export const STITCH_HEIGHT: Record<StitchType, number> = {
  ch: 0.75, // chain length, used as width when chains form a foundation
  slst: 0.35,
  sc: 1,
  hdc: 1.4,
  dc: 1.9,
  tr: 2.6,
  dtr: 3.3,
};

/** Default sc width x height (mm) and hook per Craft Yarn Council weight. */
export const WEIGHT_DEFAULTS: Record<number, { hook: number; w: number; h: number }> = {
  0: { hook: 1.75, w: 2.5, h: 2.1 },
  1: { hook: 2.75, w: 3.8, h: 3.2 },
  2: { hook: 4.0, w: 5.6, h: 4.8 },
  3: { hook: 5.0, w: 6.9, h: 5.9 },
  4: { hook: 5.5, w: 8.0, h: 6.8 },
  5: { hook: 7.5, w: 10.5, h: 8.9 },
  6: { hook: 10, w: 12.5, h: 10.6 },
  7: { hook: 15, w: 18, h: 15 },
};

export const WEIGHT_NAMES: [RegExp, number][] = [
  [/\b(lace|thread)\b/, 0],
  [/\b(super ?fine|fingering|sock|baby)\b/, 1],
  [/\b(sport|fine)\b/, 2],
  [/\b(dk|light worsted|light)\b/, 3],
  [/\b(worsted|aran|medium)\b/, 4],
  [/\b(super ?bulky|super chunky|roving)\b/, 6],
  [/\b(bulky|chunky)\b/, 5],
  [/\b(jumbo)\b/, 7],
];

/** Fiber presets: stiffness factor, sheen, roughness, fuzz (softens stitch texture). */
export const FIBERS: Record<string, { stiffness: number; sheen: number; roughness: number; fuzz: number }> = {
  'milk cotton': { stiffness: 1.0, sheen: 0.3, roughness: 0.8, fuzz: 0.3 },
  cotton: { stiffness: 1.2, sheen: 0.05, roughness: 0.85, fuzz: 0.1 },
  acrylic: { stiffness: 1.0, sheen: 0.2, roughness: 0.75, fuzz: 0.25 },
  wool: { stiffness: 0.9, sheen: 0.35, roughness: 0.9, fuzz: 0.45 },
  chenille: { stiffness: 0.7, sheen: 1.0, roughness: 0.6, fuzz: 0.8 },
  velvet: { stiffness: 0.7, sheen: 1.0, roughness: 0.55, fuzz: 0.8 },
  mohair: { stiffness: 0.6, sheen: 0.8, roughness: 0.95, fuzz: 0.95 },
  // polyester plush / blanket yarn: like chenille, a little denser and shinier
  plush: { stiffness: 0.7, sheen: 1.0, roughness: 0.55, fuzz: 0.85 },
  // smooth plied polyester: firm, with a satin shine and almost no fuzz
  polyester: { stiffness: 1.0, sheen: 0.5, roughness: 0.5, fuzz: 0.05 },
};

export const COLORS: Record<string, string> = {
  white: '#f3f1ec', cream: '#efe6cf', ivory: '#f4efdf', black: '#222222', grey: '#8d8d8d', gray: '#8d8d8d',
  brown: '#7a4b2a', tan: '#c49a6c', beige: '#d9c3a0', red: '#c0392b', pink: '#f2a7c3', orange: '#e67e22',
  yellow: '#f4d03f', green: '#4f9d58', mint: '#a8e6cf', blue: '#3b6fb6', 'light blue': '#9cc7ec', navy: '#22315a',
  purple: '#8e5bb5', lilac: '#c8a2d8', gold: '#d4a62a', silver: '#c0c0c0', peach: '#f6c1a1', coral: '#f08070',
};

export const DEFAULT_YARN_COLOR = '#e8a87c';

/** UK → US terms (applied to whole words after normalisation). */
const UK_MAP: Record<string, string> = { dc2tog: 'dec', dtr: 'tr', tr: 'dc', htr: 'hdc', dc: 'sc', ttr: 'dtr' };
export function ukToUs(s: string): string {
  return s.replace(/\b(dc2tog|ttr|dtr|htr|tr|dc)\b/g, (m) => UK_MAP[m]);
}
