import { describe, expect, it } from 'vitest';
import { parsePattern } from '../src/parser/parse';

/**
 * Written-out instructions read without any AI: phrase rewrites, arithmetic on the previous
 * row's count, row references and a count-guided search over the other readings of a line.
 * Lines are original test phrasings in the style of real patterns.
 */
const RNDS = ['6 sc in MR (6)', 'inc x6 (12)', '(sc, inc) x6 (18)', '(2 sc, inc) x6 (24)', '(3 sc, inc) x6 (30)'];
function read(prev: 6 | 12 | 18 | 24 | 30, line: string) {
  const before = RNDS.slice(0, prev / 6).map((r, i) => `Rnd ${i + 1}: ${r}`);
  const text = [...before, `Rnd ${before.length + 1}: ${line}`].join('\n');
  const p = parsePattern(text);
  const li = before.length;
  const row = p.pieces[0].rows.find((r) => r.line === li)!;
  const diags = p.diagnostics.filter((d) => d.line === li);
  return { count: row.computedCount, status: row.status, diags, warnings: diags.filter((d) => d.severity !== 'info') };
}
function flat(line: string) {
  const text = `Ch 11.\nRow 1: sc in 2nd ch from hook and in each ch across, turn. (10)\nRow 2: ${line}`;
  const p = parsePattern(text);
  const row = p.pieces[0].rows[1];
  return { row, warnings: p.diagnostics.filter((d) => d.line === 2 && d.severity !== 'info') };
}

describe('written-out phrasings, no AI', () => {
  it.each([
    [18, '*skip 2, sc in each of next 4; rep from * around (12)', 12],
    [18, 'Sc in each st around until 2 sts remain, dec (17)', 17],
    [12, 'Sc in each st to last st, 2 sc in last st (13)', 13],
    [24, 'Work 1 sc in each of the next 3 stitches, then 2 sc in the next stitch. Repeat 5 more times. (30)', 30],
    [24, 'Single crochet around, decreasing 6 sts evenly (18)', 18],
    [24, 'Increase 6 stitches evenly around (30)', 30],
    [18, 'Increase 5 sts evenly around (23)', 23],
    [30, 'Dec 6 times evenly spaced (24)', 24],
    [18, 'Sc in the first 5 sts, hdc in next 3, dc in next 2, hdc in next 3, sc in remaining 5 (18)', 18],
    [18, 'sc 2, inc, repeat around (24)', 24],
    [18, 'inc in each of the next 3, sc in the following 15 (21)', 21],
    [12, 'Single crochet in the next two stitches, then increase once; do this four times in total (16)', 16],
    [6, 'Work 3 sc in next st, sc in each of next 5 (8)', 8],
    [18, 'Working in front loops only, sl st around (18)', 18],
  ] as const)('prev %i: %s', (prev, line, want) => {
    const r = read(prev, line);
    expect(r.warnings).toEqual([]);
    expect(r.count).toBe(want);
  });

  it('flat shaping with "to last 3 sts"', () => {
    const { row, warnings } = flat('Ch 1, turn. Sc in first st, sc2tog, sc to last 3 sts, sc2tog, sc in last st (8)');
    expect(warnings).toEqual([]);
    expect(row.computedCount).toBe(8);
  });

  it('a group worked into one stitch', () => {
    const { row, warnings } = flat('Ch 1, turn. (sc, ch 2, sc) in first st, sc in each st across to last st, (sc, ch 2, sc) in last st (12)');
    expect(warnings).toEqual([]);
    expect(row.ops.length).toBeGreaterThan(0);
  });

  it('the count settles the scope of "x6" and says so', () => {
    const r = read(18, '2sc, inc x6 (24)');
    expect(r.count).toBe(24);
    expect(r.status).toBe('assumption');
    expect(r.diags[0].readings).toEqual(['(2sc, inc) x6 (24)']);
  });

  it('a stated count that includes chains is accepted as an assumption', () => {
    const r = read(18, 'Sc in next 6 sts, ch 6, skip 6 sts, sc in remaining 6 sts (18)');
    expect(r.warnings).toEqual([]);
    expect(r.diags[0].message).toMatch(/includes the chains/);
  });

  it('repeat a row by reference', () => {
    const p = parsePattern('Rnd 1: 6 sc in MR (6)\nRnd 2: inc x6 (12)\nRnd 3: (sc, inc) x6 (18)\nRnds 4-6: sc around (18)\nRnd 7: repeat rnd 6.\nRnd 8: work as for round 3');
    expect(p.pieces[0].rows.map((r) => r.computedCount)).toEqual([6, 12, 18, 18, 18, 18, 18, 18]);
    expect(p.pieces[0].rows[7].ops).toBe(p.pieces[0].rows[2].ops);
    expect(p.diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
  });

  it('never drops words silently', () => {
    const r = read(12, 'Popcorn in next st, sc in next st; rep around (12)');
    expect(r.status).toBe('ambiguous');
    expect(r.warnings[0].message).toMatch(/popcorn/);
  });
});
