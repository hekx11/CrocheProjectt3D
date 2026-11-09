import { describe, expect, it } from 'vitest';
import { parsePattern } from '../src/parser/parse';
import { CASES } from './held-out-cases';
import { goldRead, patternFor, readLine, same } from './held-out-score';

/**
 * 50 written-out lines the phrase rules were not written from. A line must either be read right
 * or be flagged for the user to check: a wrong reading with no warning is the one bad outcome.
 */
describe('held-out written-out lines', () => {
  const results = CASES.map((c) => {
    const { text, line } = patternFor(c);
    const r = readLine(text, line);
    const g = goldRead(c);
    return { c, r, outcome: r.flagged ? 'flagged' : c.gold !== null && same(r, g) ? 'right' : 'wrong' };
  });

  it('every gold answer reads cleanly', () => {
    expect(CASES.filter((c) => c.gold && goldRead(c)!.flagged).map((c) => c.id)).toEqual([]);
  });

  it('never reads a line wrong without saying so', () => {
    expect(results.filter((x) => x.outcome === 'wrong').map((x) => `${x.c.id}: ${x.c.line}`)).toEqual([]);
  });

  it('reads at least 30 of the 50 lines right', () => {
    expect(results.filter((x) => x.outcome === 'right').length).toBeGreaterThanOrEqual(30);
  });
});

describe('words vs reading', () => {
  const at = (line: string) => {
    const p = parsePattern(`Rnd 1: 6 sc in MR (6)\nRnd 2: inc x6 (12)\nRnd 3: ${line}`);
    return { row: p.pieces[0].rows[2], diags: p.diagnostics.filter((d) => d.line === 2 && d.severity !== 'info') };
  };
  it('flags a reading whose count matches but that adds a stitch the words don\'t name', () => {
    const { diags } = at('tr in next 6 sts, sc in remaining sts (12)');
    expect(diags.map((d) => d.code)).toEqual(['words-mismatch']);
    expect(diags[0].message).toMatch(/sl st/);
  });
  it('reads "2 sc in last st" and "2 sc in the next st" as increases into one stitch', () => {
    expect(at('Sc in each st to last st, 2 sc in last st (13)').diags).toEqual([]);
    expect(at('1 sc in the first st, 2 sc in the next st, repeat this sequence 5 more times (18)').diags).toEqual([]);
  });
  it('does not complain about a sl st that only ends the round, or about a short-syntax line', () => {
    expect(at('12sc, slst (12)').diags).toEqual([]);
    expect(at('Sc in every st around, join with sl st to first sc (12)').diags).toEqual([]);
  });
  it('leaves a line with "=> …" alone', () => {
    expect(at('tr in next 6 sts, sc in remaining sts (12)  => 6 tr, 6 sc (12)').diags).toEqual([]);
  });
});
