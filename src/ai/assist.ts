import { parsePattern } from '../parser/parse';
import { extractCount } from '../parser/row';
import type { Pattern } from '../model/types';

/**
 * Optional "Ask AI" helper for lines the rule-based parser can't read.
 * The model is free and runs on the user's own device (see local.ts); nothing leaves the browser.
 * It only proposes a short-syntax `=> …` annotation; the parser and the stitch count check decide
 * whether it is usable, and the user applies it by hand. Nothing is changed automatically.
 */

/** One chat completion: system + user prompt in, JSON text out. */
export type Complete = (system: string, user: string, schema: object, signal?: AbortSignal) => Promise<string>;

export interface Suggestion {
  line: number;
  syntax: string; // the text after "=>"
  explanation: string;
  /** Full replacement for the editor line. */
  newLine: string;
  check: { ok: boolean; message: string };
  attempts: number;
}

export const SYNTAX_GUIDE = `You convert one line of a crochet pattern into the short syntax of the Crochet 3D app.
Answer with the short syntax only for the instruction part of the line (no row label).

Short syntax (US terms):
- Stitches: ch, slst, sc, hdc, dc, tr, dtr. "inc" = 2 sc in one stitch, "dec" = sc2tog. A number before a stitch repeats it: "6 sc" = one sc in each of the next 6 stitches.
- Several stitches into one stitch: "3 dc in next st", "2 sc in same st". Into the magic ring: "6 sc in mr".
- Repeats: "(sc, inc) x6", "[2 sc, dec] x 4", "(sc, inc) around" (repeat until the previous round runs out).
- Skip stitches: "sk 1", "sk 2".
- Chains in a row: "ch 3" makes 3 chain stitches; "ch 1, turn" at the start of a row is a turning chain; "ch 3 (counts as dc)".
- Foundation rows: "sc in 2nd ch from hook, sc across".
- Loops: "blo" or "flo" after a stitch or for the whole line, e.g. "18 sc blo".
- Tension words: "loose", "tight" after a stitch, e.g. "18 slst blo loose".
- Colour change: "change color to white" at the start.
- Joins and turns: ", join" at the end of a joined round; ", turn" at the end of a flat row.
- Fasten off: ", fasten off" at the end.
- Stitch count at the end in round brackets: "(18)". Always end with the count the line states, or the count you worked out.

Rules:
- Use the previous row's stitch count to make the count work: every stitch of the previous row should normally be worked into once.
- Keep the meaning of the original. If the line is only a note with no stitches, answer with an empty "syntax" and say so.
- If the line refers to an earlier row ("as round 3", "repeat rows 2-4"), expand it from the context you are given.
- "explanation" is one short sentence for the crocheter, in plain words, saying how you read the line.
- Answer only with JSON: {"syntax": "...", "explanation": "..."}.

Examples (previous row count, line -> syntax):
- 12, "Rnd 3: *sc in next st, 2 sc in next st; repeat from * around (18)" -> "(sc, inc) x6 (18)"
- 10, "Row 2: ch 1 and turn, then single crochet in every stitch across (10)" -> "ch 1, turn, 10 sc (10)"
- 24, "Rnd 6: work the round in the back loops only with one sc in each st" -> "24 sc blo (24)"
- 18, "Rnd 7: make a decrease, then 1 sc in each of the next 4, all the way around (15)" -> "(dec, 4 sc) x3 (15)"`;

const SCHEMA = {
  type: 'object',
  properties: {
    syntax: { type: 'string', description: 'Short syntax for the instruction, without the row label and without "=>".' },
    explanation: { type: 'string', description: 'One short sentence on how the line was read.' },
  },
  required: ['syntax', 'explanation'],
  additionalProperties: false,
} as const;

/** Lines worth offering the helper on: rows that are unreadable or whose count doesn't match. */
export function needsHelp(p: Pattern, line: number): boolean {
  return p.diagnostics.some((d) => d.line === line && (d.code === 'unknown-token' || d.code === 'count-mismatch' || d.code === 'ambiguous'));
}

function splitLine(raw: string) {
  const ann = raw.indexOf('=>');
  return { body: ann >= 0 ? raw.slice(0, ann).trimEnd() : raw.trimEnd() };
}

/** Put `=> syntax` on the line, re-parse the whole pattern and see whether the line now reads cleanly. */
export function checkCandidate(text: string, line: number, syntax: string): { newLine: string; syntax: string; ok: boolean; message: string } {
  const lines = text.split('\n');
  const { body } = splitLine(lines[line] ?? '');
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
  const assumed = p.diagnostics.find((d) => d.line === line && d.severity === 'info');
  return { newLine, syntax: s, ok: true, message: `Reads cleanly${row ? `: ${row.computedCount} stitches` : ''}${assumed ? ` (assumed: ${assumed.message})` : ''}.` };
}

/** What the model sees: the line, its neighbours, the previous row's count and the parser's complaint. */
export function describeLine(text: string, p: Pattern, line: number): string {
  const lines = text.split('\n');
  const info = p.lines[line];
  const piece = p.pieces.find((pc) => pc.id === info?.piece);
  const rows = piece?.rows ?? [];
  const here = rows.find((r) => r.line === line);
  const prev = here ? rows[here.index - 2] : undefined;
  const from = Math.max(0, line - 8), to = Math.min(lines.length, line + 3);
  const ctx = lines.slice(from, to).map((l, i) => `${from + i === line ? '>>' : '  '} ${l}`).join('\n');
  const issues = p.diagnostics.filter((d) => d.line === line).map((d) => `- ${d.message}`).join('\n');
  return [
    `Pattern terms: ${p.terms}.`,
    piece ? `Piece: ${piece.name} (${piece.construction === 'rows' ? 'flat rows' : 'rounds'}).` : '',
    prev ? `The previous row (${prev.label}) has ${prev.computedCount} stitches.` : here?.index === 1 ? 'This is the first row of the piece.' : '',
    `Context (the line to convert is marked >>):\n${ctx}`,
    issues ? `What the parser said about it:\n${issues}` : '',
    `Line to convert: ${splitLine(lines[line] ?? '').body.trim()}`,
  ].filter(Boolean).join('\n\n');
}

export class AiError extends Error {}

const ATTEMPTS = 3;

export async function suggest(text: string, p: Pattern, line: number, complete: Complete, signal?: AbortSignal): Promise<Suggestion> {
  const base = describeLine(text, p, line);
  let feedback = '';
  let last: Suggestion | null = null;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const raw = await complete(SYNTAX_GUIDE, base + feedback, SCHEMA, signal);
    let out: { syntax?: string; explanation?: string };
    try { out = JSON.parse(raw); } catch { out = {}; }
    const syntax = (out.syntax ?? '').trim();
    const explanation = (out.explanation ?? '').trim();
    if (!syntax) {
      last = { line, syntax: '', explanation: explanation || 'No short syntax suggested.', newLine: text.split('\n')[line], check: { ok: false, message: 'No short syntax suggested.' }, attempts: attempt };
      feedback = '\n\nYour previous answer had no usable "syntax". Answer with the short syntax for the line.';
      continue;
    }
    const c = checkCandidate(text, line, syntax);
    last = { line, syntax: c.syntax, explanation, newLine: c.newLine, check: { ok: c.ok, message: c.message }, attempts: attempt };
    if (c.ok) break;
    // small local models: give the parser's verdict back in a fresh prompt (no chat history needed)
    feedback = `\n\nA previous answer was "${c.syntax}", and the app said: ${c.message} Give a corrected short syntax.`;
  }
  return last!;
}
