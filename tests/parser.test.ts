import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { parsePattern } from '../src/parser/parse';
import { countOf, execute, parseRowText } from '../src/parser/row';

const fx = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
const counts = (p: ReturnType<typeof parsePattern>, i = 0) =>
  p.pieces[i].rows.map((r) => countOf(execute(r.ops, prevCount(p, i, r.index), r.index === 1 && p.pieces[i].start.kind !== 'chain'), r.expectedCount?.unit ?? 'st'));
function prevCount(p: ReturnType<typeof parsePattern>, i: number, idx: number) {
  const pc = p.pieces[i];
  if (idx === 1) return pc.start.kind === 'chain' && !pc.start.ring ? pc.start.n : 0;
  return pc.rows[idx - 2].computedCount;
}
const noWarnings = (p: ReturnType<typeof parsePattern>) => p.diagnostics.filter((d) => d.severity !== 'info');

describe('row grammar', () => {
  const src = { from: 0, to: 0 };
  const run = (s: string, prev: number, ring = false) => {
    const r = parseRowText(s, { terms: 'US', leadingChIsTurning: false, src });
    return { r, n: countOf(execute(r.ops, prev, ring), r.expectedCount?.unit ?? 'st') };
  };
  it.each([
    ['6 sc in MR', 0, 6, true],
    ['inc x6 (12)', 6, 12, false],
    ['(sc, inc) x6 (18)', 12, 18, false],
    ['(2 sc, inc) x6 (24)', 18, 24, false],
    ['*Sc in next 2 sts, inc in next st; rep from * around (24)', 18, 24, false],
    ['sc in next 2 sts, inc; repeat 5 more times', 18, 24, false],
    ['(inc in every stitch) * 6 [12]', 6, 12, false],
    ['dec around (6)', 12, 6, false],
    ['2 dc in each st around', 12, 24, false],
    ['sc in BLO around', 12, 12, false],
    ['skip next st, 5 sc', 6, 5, false],
  ] as const)('%s', (s, prev, expected, ring) => {
    expect(run(s, prev, ring).n).toBe(expected);
  });
  it('reads colour, tension and loop from a Lil Big Cig round', () => {
    const { r, n } = run('Change color to white and do loose sl st around in back loop only [18]', 18);
    expect(n).toBe(18);
    expect(r.colorChange).toBe('white');
    const st = execute(r.ops, 18, false).stitches[0];
    expect(st.type).toBe('slst');
    expect(st.loop).toBe('BLO');
    expect(st.tension).toBeGreaterThan(1);
  });
});

describe('corpus fixtures', () => {
  it('B ball', () => {
    const p = parsePattern(fx('ball.txt'));
    expect(p.pieces).toHaveLength(1);
    expect(counts(p)).toEqual([6, 12, 18, 24, 24, 24, 24, 24, 18, 12, 6]);
    expect(p.pieces[0].finish).toBe('closed');
    expect(p.pieces[0].stuffing).toBe('firm');
    expect(noWarnings(p)).toEqual([]);
  });
  it('C coaster (flat rows, gauge)', () => {
    const p = parsePattern(fx('coaster.txt'));
    expect(p.pieces[0].construction).toBe('rows');
    expect(counts(p)).toEqual(Array(15).fill(15));
    expect(p.materials.gauge).toMatchObject({ kind: 'grid', stitches: 16, rows: 18 });
    expect(noWarnings(p)).toEqual([]);
  });
  it('D bear head (several pieces + seams)', () => {
    const p = parsePattern(fx('bear-head.txt'));
    expect(p.pieces.map((x) => [x.name, x.quantity])).toEqual([['Head', 1], ['Ears', 2], ['Snout', 1]]);
    expect(counts(p, 0)).toEqual([6, 12, 18, 24, 24, 24, 24, 24, 24, 24, 18, 12, 6]);
    expect(p.pieces[0].markers[0]).toMatchObject({ kind: 'safety-eyes', rowA: 7, rowB: 8, spacingSts: 5 });
    expect(p.pieces[1]).toMatchObject({ finish: 'open-with-tail', stuffing: 'none', flatten: true });
    expect(p.seams.map((s) => [s.piece, s.host, s.rowA, s.rowB, s.hint])).toEqual([
      ['p2', 'p1', 3, 6, 'top'],
      ['p3', 'p1', 8, 11, 'below-eyes'],
    ]);
    expect(noWarnings(p)).toEqual([]);
  });
  it('E flower (joined rounds, written-out sentences)', () => {
    const p = parsePattern(fx('flower.txt'));
    expect(p.pieces[0].construction).toBe('joined-rounds');
    expect(counts(p)).toEqual([12, 24, 12]);
    expect(noWarnings(p)).toEqual([]);
  });
  it('F UK terms', () => {
    const p = parsePattern(fx('uk-ball.txt'));
    expect(p.terms).toBe('UK');
    expect(counts(p)).toEqual([6, 12, 18, 18, 18, 18, 12, 6]);
    expect(noWarnings(p)).toEqual([]);
  });
  const lil = new URL('../fixtures/private/lil-big-cig.txt', import.meta.url);
  it.skipIf(!existsSync(lil))('A Lil Big Cig (private fixture)', () => {
    const p = parsePattern(readFileSync(lil, 'utf8'));
    expect(p.pieces).toHaveLength(1);
    const pc = p.pieces[0];
    expect(pc.rows).toHaveLength(47);
    expect(pc.sections.map((s) => s.yarnId)).toEqual(['brown', 'white', 'brown']);
    expect(pc.markers.map((m) => [m.kind, m.rowA, m.rowB])).toEqual([['safety-eyes', 23, 24], ['embroidery', 22, undefined]]);
    expect(p.materials).toMatchObject({ hookMm: 4.25, weight: 6, fiber: 'chenille', eyeMm: 14 });
    expect(noWarnings(p)).toEqual([]);
  });
});

describe('pattern-sheet wordings (seen in shared amigurumi sheets)', () => {
  it('reads "* repeat N times", "Round a - Round b", {N rounds} and BLO24sc', () => {
    const p = parsePattern(`Test
Part
Round 1: 6sc in the magic ring (6)
Round 2: 6inc (12)
Round 3: (sc, inc) * repeat 6 times (18)
Round 4: dec, (sc, dec)*2, 9sc (14)
Round 5 - Round 7: 14sc (14) {3 rounds}
Round 8: BLO14sc (14)
`);
    expect(counts(p)).toEqual([6, 12, 18, 14, 14, 14, 14, 14]);
    expect(JSON.stringify(p.pieces[0].rows[7].ops)).toContain('"loop":"BLO"');
    expect(noWarnings(p)).toEqual([]);
  });
  it('reads an unlabelled single round, "make two" and "Use … yarn"', () => {
    const p = parsePattern(`Test
Head
Rnd 1: 6 sc in MR (6)
Rnd 2: inc x6 (12)
Rnds 3-4: sc around (12)
Fasten off.

Ear (make two)
Use black yarn
6hdc in the magic ring (6)
Fasten off. Sew the ear between Round 2 and Round 3 of the head.
`);
    expect(p.pieces.map((q) => [q.name, q.quantity, q.rows.length])).toEqual([['Head', 1, 4], ['Ear', 2, 1]]);
    expect(p.seams.map((s) => [s.rowA, s.rowB])).toEqual([[2, 3]]);
  });
  it('reads "mr, 6sc", a closing slst, "Row 1: Ch 8" and "ch 1, turn"', () => {
    const p = parsePattern(`Test
Cup
R1: mr, 6sc (6)
R2: 6inc (12)
R3-R4: 12sc, slst (12)
Fasten off.

Patch
Row 1: Ch 8
Rows 2-3: 7 sc, ch 1, turn
Fasten off. Sew the patch to the front of the cup.
`);
    expect(counts(p)).toEqual([6, 12, 12, 12]);
    expect(counts(p, 1)).toEqual([7, 7]);
    expect(p.pieces[1].start).toEqual({ kind: 'chain', n: 8, ring: false });
  });
  it('joins a piece with as many stitches as an open edge on as a lid', () => {
    const p = parsePattern(`Test
Cup
R1: mr, 6sc (6)
R2: 6inc (12)
R3-R5: 12sc (12)
Don't cut the yarn

Coffee
R1: mr, 6sc (6)
R2: 6inc, slst (12)
Fasten off. Attach the coffee to the cup, joining through the back loop of the coffee. Stuff it before finishing the round.
`);
    expect(p.seams.map((s) => s.hint)).toEqual(['lid']);
    expect(p.pieces.map((q) => q.stuffing)).toEqual(['firm', 'firm']);
  });
});

describe('shaping words and yarn types', () => {
  it('reads "shape into a triangle", "flatten the bottom" and polyester / plush yarn', () => {
    const p = parsePattern(`Test
Hook: 3 mm, white polyester yarn, polyester stuffing
Body
Rnd 1: 6 sc in MR (6)
Rnd 2: inc x6 (12)
Rnds 3-4: sc around (12)
Stuff firmly and shape into a triangle. Flatten the bottom.
Rnd 5: dec x6 (6)
Fasten off.
`);
    expect(p.pieces[0].shape).toEqual({ triangle: true, flatBottom: true });
    expect(p.materials.fiber).toBe('polyester');
    expect(parsePattern('Test\nHook: 5 mm, plush chenille yarn\nRnd 1: 6 sc in MR (6)\n').materials.fiber).toBe('chenille');
  });
});
