import { parsePattern } from '../parser/parse';
import { execute, extractCount } from '../parser/row';
import type { Op, Pattern } from '../model/types';

/**
 * Optional "Ask AI" helper for lines the rule-based reader can't read. The model is small and runs
 * on the user's own device (see local.ts); nothing leaves the browser. It only proposes a short
 * syntax `=> …` annotation. The parser and the stitch count check decide whether it is usable, and
 * the user applies it by hand.
 */

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
/** One chat completion: messages in, plain answer text out. */
export type Complete = (messages: ChatMessage[], signal?: AbortSignal) => Promise<string>;

export interface Suggestion {
  line: number;
  syntax: string; // the text after "=>"
  /** Full replacement for the editor line. */
  newLine: string;
  check: { ok: boolean; message: string };
  attempts: number;
}

// Kept short on purpose: models under 1B parameters follow a few examples better than long rules.
export const SYNTAX_GUIDE = `Rewrite one crochet instruction in short syntax. Answer with the short syntax only, on one line.
Stitches: ch, slst, sc, hdc, dc, tr. inc = 2 sc in one stitch. dec = sc2tog. "6 sc" = sc in each of the next 6 stitches.
Repeats: "(sc, inc) x6". Skip: "sk 2". Loops: "blo" or "flo" after a stitch. Flat rows start with "ch 1, turn,".
Every stitch of the previous row is worked once unless the line says otherwise. End with the stitch count in brackets.`;

const SHOTS: [string, string][] = [
  ['Previous round: 12 stitches.\nLine: *sc in next st, 2 sc in next st; repeat from * around (18)', '(sc, inc) x6 (18)'],
  ['Previous row: 10 stitches.\nLine: ch 1 and turn, then single crochet in every stitch across (10)', 'ch 1, turn, 10 sc (10)'],
  ['Previous round: 24 stitches.\nLine: work the round in the back loops only with one sc in each st (24)', '24 sc blo (24)'],
  ['Previous round: 18 stitches.\nLine: make a decrease, then 1 sc in each of the next 4, all the way around (15)', '(dec, 4 sc) x3 (15)'],
  ['Previous round: 12 stitches.\nLine: hdc in next 4 sts, dc in next 4 sts, hdc in last 4 (12)', '4 hdc, 4 dc, 4 hdc (12)'],
];

/** Lines worth offering the helper on: rows that are unreadable or whose count doesn't match. */
export const HELP_CODES = new Set(['unknown-token', 'count-mismatch', 'ambiguous']);
export function needsHelp(p: Pattern, line: number): boolean {
  return p.diagnostics.some((d) => d.line === line && HELP_CODES.has(d.code));
}

const bodyOf = (raw: string) => { const ann = raw.indexOf('=>'); return ann >= 0 ? raw.slice(0, ann).trimEnd() : raw.trimEnd(); };
const instructionOf = (raw: string) => bodyOf(raw).replace(/^\s*(?:rnds?|rounds?|rows?|r)\s*\d+(?:\s*[-–]\s*(?:r\s*)?\d+)?\s*[:.)]?\s*/i, '').trim();

/** Put `=> syntax` on the line, re-parse the whole pattern and see whether the line now reads cleanly. */
export function checkCandidate(text: string, line: number, syntax: string): { newLine: string; syntax: string; ok: boolean; message: string } {
  const lines = text.split('\n');
  const body = bodyOf(lines[line] ?? '');
  let s = syntax.trim().replace(/^=>\s*/, '');
  // keep the count the pattern states, so the count check still referees the suggestion
  const stated = extractCount(body).count;
  if (stated && !extractCount(s).count) s = `${s} (${stated.n})`;
  const newLine = `${body}  => ${s}`;
  lines[line] = newLine;
  const p = parsePattern(lines.join('\n'));
  const info = p.lines[line];
  const problems = p.diagnostics.filter((d) => d.line === line && d.severity !== 'info');
  if (!info || info.kind !== 'row') return { newLine, syntax: s, ok: false, message: 'The line is no longer read as a row.' };
  if (problems.length) return { newLine, syntax: s, ok: false, message: problems.map((d) => d.message).join(' ') };
  const row = p.pieces.flatMap((pc) => pc.rows).find((r) => r.line === line);
  const piece = p.pieces.find((pc) => pc.rows.includes(row!));
  const prev = row && piece ? piece.rows[row.index - 2] : undefined;
  const why = row ? inconsistent(body, row.ops, prev?.computedCount ?? 0, !prev) : null;
  if (why) return { newLine, syntax: s, ok: false, message: why };
  return { newLine, syntax: s, ok: true, message: `Reads cleanly${row ? `: ${row.computedCount} stitches` : ''}.` };
}

// ---------------------------------------------------------------------------
// A second referee. A matching count alone lets a small model through with "18 sc (18)" for any
// line that doesn't change the count, so a suggestion must also use the stitches the line names.

const KINDS: [string, RegExp][] = [
  ['hdc', /\bhdc\b|half[\s-]double/i],
  ['dc', /\bdc\b|(?<!half[\s-])double crochet/i],
  ['tr', /\btr\b|\btreble\b|\btriple\b/i],
  ['slst', /\bsl\s?st\b|\bslst\b|\bslip st/i],
  ['inc', /\binc|increas|\b(?<!next )(?:2|two)\s+(?:sc|hdc|dc|tr|single|half|double)\b/i],
  ['dec', /\bdec|decreas|2\s?tog|sc2tog|\btogether\b/i],
  ['BLO', /\bblo\b|back loop/i],
  ['FLO', /\bflo\b|front loop/i],
];
const SPECIAL = /\b(puff|popcorn|bobble|cluster|picot|shell|bead|spike|loop st|bullion|cable)\b/i;

function kindsOf(ops: Op[], out = new Set<string>()): Set<string> {
  for (const op of ops) {
    if (op.kind === 'repeat') kindsOf(op.ops, out);
    else if (op.kind === 'evenly') { out.add(op.change); if (op.stitch !== 'sc') out.add(op.stitch); if (op.loop !== 'both') out.add(op.loop); }
    else if (op.kind === 'stitch') {
      if (op.type !== 'sc' && op.type !== 'ch') out.add(op.type);
      if (op.consumes > 1) out.add('dec');
      if (op.target.kind === 'same') out.add('inc');
      if (op.loop !== 'both') out.add(op.loop);
    }
  }
  return out;
}

/** Why a suggestion doesn't fit the line it is for, or null when it does. */
export function inconsistent(line: string, ops: Op[], prevCount: number, ring: boolean): string | null {
  const text = line.replace(/\([^)]*\bcounts?\b[^)]*\)/gi, ' ');
  if (SPECIAL.test(text)) return `The line uses a special stitch ("${SPECIAL.exec(text)![1]}") the app can't draw yet.`;
  const said = new Set(KINDS.filter(([, re]) => re.test(text)).map(([k]) => k));
  const got = kindsOf(ops);
  const missing = [...said].filter((k) => !got.has(k));
  const extra = [...got].filter((k) => !said.has(k));
  if (missing.length) return `The suggestion leaves out ${missing.join(', ')}, which the line asks for.`;
  if (extra.length) return `The suggestion adds ${extra.join(', ')}, which the line doesn't mention.`;
  if (!ring && prevCount > 0) {
    const left = execute(ops, prevCount, false).leftover;
    if (left > 0 && !/\b(leave|leaving|unworked|remaining sts? unworked)\b/i.test(text)) return `The suggestion leaves ${left} stitch(es) of the previous row unworked.`;
  }
  return null;
}

/** What the model sees: the previous row's count and the instruction itself. */
export function describeLine(text: string, p: Pattern, line: number): string {
  const info = p.lines[line];
  const piece = p.pieces.find((pc) => pc.id === info?.piece);
  const rows = piece?.rows ?? [];
  const here = rows.find((r) => r.line === line);
  const prev = here ? rows[here.index - 2] : undefined;
  const unit = piece?.construction === 'rows' ? 'row' : 'round';
  const head = prev ? `Previous ${unit}: ${prev.computedCount} stitches.` : `This is the first ${unit}.`;
  return `${head}\nLine: ${instructionOf(text.split('\n')[line] ?? '')}`;
}

/** Take the first line of the answer and strip quotes, labels and a leading "=>". */
export function cleanAnswer(raw: string): string {
  const first = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim().split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return first.replace(/^(?:short syntax|answer|syntax)\s*:\s*/i, '').replace(/^=>\s*/, '').replace(/^[`"']+|[`"']+$/g, '').trim();
}

export function buildMessages(user: string): ChatMessage[] {
  return [
    { role: 'system', content: SYNTAX_GUIDE },
    ...SHOTS.flatMap(([u, a]): ChatMessage[] => [{ role: 'user', content: u }, { role: 'assistant', content: a }]),
    { role: 'user', content: user },
  ];
}

const ATTEMPTS = 3;

export async function suggest(text: string, p: Pattern, line: number, complete: Complete, signal?: AbortSignal, attempts = ATTEMPTS): Promise<Suggestion> {
  const base = describeLine(text, p, line);
  let feedback = '';
  let last: Suggestion | null = null;
  const tried = new Set<string>();
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const syntax = cleanAnswer(await complete(buildMessages(base + feedback), signal));
    if (!syntax) {
      last = { line, syntax: '', newLine: text.split('\n')[line], check: { ok: false, message: 'No short syntax suggested.' }, attempts: attempt };
      continue;
    }
    const c = checkCandidate(text, line, syntax);
    last = { line, syntax: c.syntax, newLine: c.newLine, check: { ok: c.ok, message: c.message }, attempts: attempt };
    if (c.ok) break;
    if (tried.has(c.syntax)) break; // the model repeats itself; another try won't help
    tried.add(c.syntax);
    // small models: give the parser's verdict back in a fresh prompt (no chat history needed)
    feedback = `\nA previous answer "${c.syntax}" was wrong: ${c.message}`;
  }
  return last!;
}
