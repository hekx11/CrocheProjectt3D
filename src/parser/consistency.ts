import type { ExecResult } from './row';

/**
 * A second check on a reading, besides the stitch count: the stitches the reading makes must match
 * the stitches the words name (hdc, dc, tr, sl st, increases, decreases, back or front loops), with
 * none left out and none added. A matching count can hide a wrong reading: "sc in each st,
 * increasing in every other st (18)" read as 18 sc has the right count but no increases.
 * Works on the normalized text (US terms), so UK patterns are compared after translation, and on
 * what the reading actually makes (the executed stitches), so any way of writing it compares alike.
 */

const NB = '(?<![a-z])';
const NA = '(?![a-z])';
const ST = '(?:sc|hdc|dc|tr|dtr|slst)';
// "2 sc in next st", "3 dc in same st", "(sc, ch 2, sc) in first st", "5 sc in ring" — but not "sc in next 2 st"
const INTO_ONE = `\\b(?:in|into)\\s+(?:the\\s+)?(?:same|next|last|first|each|every|this|corner|ring|mr|base|top|beg\\w*|\\d+(?:st|nd|rd|th)|ch-?\\s*\\d*\\s*-?\\s*(?:sp|space)|sp|space)\\b(?!\\s*\\d)`;
const KINDS: [string, RegExp][] = [
  ['hdc', new RegExp(`${NB}hdc${NA}`)],
  ['dc', new RegExp(`${NB}dc${NA}`)],
  ['tr', new RegExp(`${NB}d?tr${NA}`)],
  ['slst', new RegExp(`${NB}slst${NA}`)],
  ['inc', new RegExp(`(?<![a-z])inc|increas|${NB}(?:[2-9]|\\d{2}|two|three|four|five)\\s*${ST}${NA}[^,;]*?${INTO_ONE}|\\)\\s*${INTO_ONE}|\\+[^,;]*${INTO_ONE}|\\bsame\\b`)],
  ['dec', /(?<![a-z])dec|decreas|\d?\s*tog\b|together/],
  ['BLO', /\bblo\b|back loop/],
  ['FLO', /\bflo\b|front loop/],
];

function made(ex: ExecResult, intoRow: boolean): Set<string> {
  const out = new Set<string>();
  const per = new Map<number, number>();
  for (const s of ex.stitches) {
    if (s.isChain) continue;
    if (s.type === 'dtr') out.add('tr');
    else if (s.type !== 'sc') out.add(s.type);
    if (s.loop !== 'both') out.add(s.loop);
    if (new Set(s.targets).size > 1) out.add('dec');
    for (const t of new Set(s.targets)) per.set(t, (per.get(t) ?? 0) + 1);
  }
  if (intoRow && [...per.values()].some((n) => n > 1)) out.add('inc');
  return out;
}

const NAMES: Record<string, string> = { inc: 'increases', dec: 'decreases', slst: 'sl st', BLO: 'back loops', FLO: 'front loops' };

/** What the words name and the reading leaves out or adds, as a sentence; null when they agree.
 *  intoRow: the row is worked into a row before it (not a magic ring or the starting chain). */
export function wordsVsReading(normalized: string, ex: ExecResult, intoRow: boolean, groupsInOne = false, prevTrusted = true): string | null {
  const text = normalized.toLowerCase()
    .replace(/(sc|hdc|dc|tr|slst)\s*[’']?s\b/g, '$1') // "16 dc’s", "sl sts"
    .replace(/\([^)]*\bcounts?\b[^)]*\)/g, ' ') // "ch 3 (counts as dc)"
    .replace(/,\s*slst\s*(?=[\[(]\s*\d|[.]?\s*$)/, ' join '); // "36sc, slst (36)": the sl st that ends the round
  // the reading must not run past the end of the row before: the count only matched by luck
  // (only when the row before was read without problems, so one misread row isn't reported twice)
  if (intoRow && prevTrusted && ex.overflow > 0) return `I run out of stitches of the row before ${ex.overflow}×, so this reading can't be right. Check the line or add "=> …" with short syntax.`;
  const said = new Set(KINDS.filter(([, re]) => re.test(text)).map(([k]) => k));
  const got = made(ex, intoRow);
  // the pattern's legend says "(…) all in one stitch"
  if (groupsInOne && /\([^)]*,[^)]*\)/.test(text)) said.add('inc');
  if (!intoRow) said.delete('inc');
  // a sl st that joins the round may or may not be read as a stitch
  if (/\bjoin/.test(text)) { said.delete('slst'); got.delete('slst'); }
  const missing = [...said].filter((k) => !got.has(k)).map((k) => NAMES[k] ?? k);
  const extra = [...got].filter((k) => !said.has(k)).map((k) => NAMES[k] ?? k);
  if (missing.length) return `The line mentions ${missing.join(' and ')}, but I read none. Check the line or add "=> …" with short syntax.`;
  if (extra.length) return `I read ${extra.join(' and ')}, which the line doesn't mention. Check the line or add "=> …" with short syntax.`;
  return null;
}
