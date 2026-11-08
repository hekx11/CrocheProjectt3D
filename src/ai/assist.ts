import Anthropic from '@anthropic-ai/sdk';
import { parsePattern } from '../parser/parse';
import { extractCount } from '../parser/row';
import type { Pattern } from '../model/types';

/**
 * Optional "Ask AI" helper for lines the rule-based parser can't read.
 * It runs in the browser with the user's own Anthropic API key. The model only proposes a
 * short-syntax `=> …` annotation; the parser and the stitch count check decide whether it is usable,
 * and the user applies it by hand. Nothing is changed automatically.
 */

export type AiModel = 'claude-opus-5-5' | 'claude-haiku-5-5';
export const AI_MODELS: { id: AiModel; label: string }[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (best)' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (cheapest)' },
];

export interface AiSettings { key: string; model: AiModel }

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
- "explanation" is one short sentence for the crocheter, in plain words, saying how you read the line.`;

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

export async function suggest(text: string, p: Pattern, line: number, settings: AiSettings, signal?: AbortSignal): Promise<Suggestion> {
  if (!settings.key) throw new AiError('Add your Anthropic API key in the AI helper settings first.');
  // The key is the user's own and only goes to api.anthropic.com from their browser.
  const client = new Anthropic({ apiKey: settings.key, dangerouslyAllowBrowser: true, maxRetries: 1 });
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: describeLine(text, p, line) }];
  let last: { syntax: string; explanation: string; newLine: string; ok: boolean; message: string } | null = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    let res: Anthropic.Beta.BetaMessage;
    try {
      res = await client.beta.messages.create({
        model: settings.model,
        max_tokens: 16000,
        system: SYNTAX_GUIDE,
        messages,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
        ...(settings.model === 'claude-opus-5-5' ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      }, { signal });
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new AiError('The API key was not accepted. Check it in the AI helper settings.');
      if (e instanceof Anthropic.PermissionDeniedError) throw new AiError('This API key cannot use that model.');
      if (e instanceof Anthropic.RateLimitError) throw new AiError('Rate limited by the API. Try again in a minute.');
      if (e instanceof Anthropic.APIUserAbortError) throw new AiError('Cancelled.');
      if (e instanceof Anthropic.APIConnectionError) throw new AiError('Could not reach the Anthropic API. Check your connection.');
      if (e instanceof Anthropic.APIError) throw new AiError(`API error ${e.status ?? ''}: ${e.message}`);
      throw e;
    }
    if (res.stop_reason === 'refusal') throw new AiError('The model declined to answer this line.');
    if (res.stop_reason === 'max_tokens') throw new AiError('The answer was cut off. Try again.');
    const textBlock = res.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text');
    let out: { syntax: string; explanation: string };
    try { out = JSON.parse(textBlock?.text ?? ''); } catch { throw new AiError('The model gave an answer the app could not read. Try again.'); }
    if (!out.syntax.trim()) {
      return { line, syntax: '', explanation: out.explanation || 'No stitches in this line.', newLine: text.split('\n')[line], check: { ok: false, message: 'No short syntax suggested.' }, attempts: attempt };
    }
    const c = checkCandidate(text, line, out.syntax);
    last = { ...out, ...c, syntax: c.syntax };
    if (c.ok) break;
    // feed the parser's verdict back once, append-only
    messages.push({ role: 'assistant', content: res.content });
    messages.push({ role: 'user', content: `The app parsed "${c.syntax}" and said: ${c.message} Please correct the short syntax.` });
  }
  const l = last!;
  return { line, syntax: l.syntax, explanation: l.explanation, newLine: l.newLine, check: { ok: l.ok, message: l.message }, attempts: messages.length > 1 ? 2 : 1 };
}
