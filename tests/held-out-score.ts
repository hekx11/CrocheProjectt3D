import { parsePattern } from '../src/parser/parse';
import { execute } from '../src/parser/row';

import type { Case } from './held-out-cases';

const LADDER = ['6 sc in MR (6)', 'inc x6 (12)', '(sc, inc) x6 (18)', '(2 sc, inc) x6 (24)', '(3 sc, inc) x6 (30)', '(4 sc, inc) x6 (36)'];

/** The case as a small pattern; returns the text and the editor line of the case's row. */
export function patternFor(c: Case, instr = c.line): { text: string; line: number } {
  if (c.kind === 'flat') {
    const text = `Ch ${c.prev + 1}.\nRow 1: sc in 2nd ch from hook and in each ch across, turn. (${c.prev})\nRow 2: ${instr}`;
    return { text, line: 2 };
  }
  const before = LADDER.slice(0, c.prev / 6).map((r, i) => `Rnd ${i + 1}: ${r}`);
  return { text: [...before, `Rnd ${before.length + 1}: ${instr}`].join('\n'), line: before.length };
}

export interface Read { status: string; flagged: boolean; count: number; strict: string; loose: string; messages: string[] }

/** Read one line of a pattern and fingerprint the stitches it makes. */
export function readLine(text: string, line: number): Read {
  const p = parsePattern(text);
  const piece = p.pieces[0];
  const row = piece?.rows.find((r) => r.line === line);
  const diags = p.diagnostics.filter((d) => d.line === line);
  const flagged = !row || diags.some((d) => d.severity !== 'info');
  if (!row) return { status: 'unreadable', flagged, count: 0, strict: '', loose: '', messages: diags.map((d) => d.message) };
  const prev = piece.rows[row.index - 2];
  const ex = execute(row.ops, prev?.computedCount ?? 0, !prev);
  const sts = ex.stitches.filter((s) => !s.isChain || s.targets.length);
  const strict = sts.map((s) => `${s.type}/${s.loop}/${s.targets.join('.')}`).join(' ');
  // shape-equivalent: same stitch kinds, same number of incs and decs, every stitch worked
  const per = new Map<number, number>();
  for (const s of sts) for (const t of new Set(s.targets)) per.set(t, (per.get(t) ?? 0) + 1);
  const hist = [...per.values()].sort().join('');
  const kinds = sts.map((s) => `${s.type}/${s.loop}/${s.targets.length}`).sort().join(' ');
  return { status: row.status, flagged, count: row.computedCount, strict, loose: `${kinds}|${hist}|left${ex.leftover}`, messages: diags.map((d) => d.message) };
}

export function goldRead(c: Case): Read | null {
  if (!c.gold) return null;
  const { text, line } = patternFor(c, c.gold);
  return readLine(text, line);
}

/** right: same stitches as the gold reading. */
export const same = (a: Read, g: Read | null) => !!g && a.loose === g.loose;
