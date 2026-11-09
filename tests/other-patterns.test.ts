import { describe, expect, it } from 'vitest';
import { parsePattern } from '../src/parser/parse';
import { risesUp } from '../src/graph/build';

/** Original test patterns in the wording of common free patterns (granny squares, hats, baskets, ovals). */
const counts = (text: string, piece = 0) => parsePattern(text).pieces[piece].rows.map((r) => r.computedCount);
const warnings = (text: string) => parsePattern(text).diagnostics.filter((d) => d.severity !== 'info');
const stitchCounts = (text: string, piece = 0) =>
  parsePattern(text).pieces[piece].rows.map((r) => (r.stitchTypes ? r.stitchTypes.filter((c) => c !== 'ch').length : r.computedCount));

describe('joined rounds', () => {
  it('reads the starting chain of a joined round as a starting chain, not stitches', () => {
    const text = [
      'Rnd 1: Ch 2, 10 hdc in 2nd ch from hook, join with sl st to first hdc. (10 hdc)',
      'Rnd 2: Ch 1, 2 hdc in each st around, join. (20 hdc)',
      'Rnd 3: Ch 2, *dc in next st, 2 dc in next st; repeat from * around, sl st to join. (30)',
    ].join('\n');
    expect(counts(text)).toEqual([10, 20, 30]);
    expect(warnings(text)).toEqual([]);
  });

  it('reads "Ch 3 (does not count as a st), 12 dc in 3rd ch from hook" as a ring of 12', () => {
    expect(counts('Rnd 1: Ch 3 (does not count as a st), 12 dc in 3rd ch from hook, sl st to first dc to join. (12)')).toEqual([12]);
  });

  it('reads post stitches (fpdc, bpdc, front post double crochet) as stitches into the next stitch', () => {
    const text = ['Rnd 1: Ch 2, 10 hdc in 2nd ch from hook, join. (10)', 'Rnd 2: Ch 1, *fpdc around next st, bpdc around next st; rep from * around, join. (10)', 'Rnd 3: Ch 2, front post double crochet around each st around, join. (10)'].join('\n');
    expect(counts(text)).toEqual([10, 10, 10]);
    expect(warnings(text)).toEqual([]);
  });

  it('works into chain spaces and keeps "ch 3 counts as dc" for later rounds (granny square)', () => {
    const text = [
      'Ch 4, join with a sl st to form a ring.',
      'Round 1: Ch 3 (counts as first dc), 2 dc into ring, ch 2, *3 dc into ring, ch 2; repeat from * 2 more times. Join with sl st to top of beg ch-3. (12 dc, 4 ch-2 spaces)',
      'Round 2: Sl st into next 2 dc and into ch-2 space. Ch 3, (2 dc, ch 2, 3 dc) in same space, ch 1, *(3 dc, ch 2, 3 dc) in next ch-2 space, ch 1; repeat from * 2 more times. Join. (24 dc)',
      'Round 3: Sl st into next 2 dc and into ch-2 space. Ch 3, (2 dc, ch 2, 3 dc) in same space, ch 1, 3 dc in next ch-1 space, ch 1, *(3 dc, ch 2, 3 dc) in next ch-2 space, ch 1, 3 dc in next ch-1 space, ch 1; repeat from * 2 more times. Join. (36 dc)',
    ].join('\n');
    expect(warnings(text)).toEqual([]);
    expect(stitchCounts(text).map((n, i) => (i === 0 ? n : n))).toEqual([12, 27, 39]); // with the slip stitches that move over
    // every dc of round 2 goes into a chain space of round 1, never into a dc
    const p = parsePattern(text);
    const r1 = p.pieces[0].rows[0].stitchTypes!;
    expect(r1.filter((t) => t === 'ch').length).toBe(8);
  });

  it('a basket or a hat (rounds that stop increasing) is a cup, a granny square stays flat', () => {
    const basket = parsePattern(['Rnd 1: 6 sc in MR, join. (6)', 'Rnd 2: Ch 1, 2 sc in each st around, join. (12)', 'Rnd 3: Ch 1, sc in the back loop of each st around, join. (12)', 'Rnds 4-8: Ch 1, sc in each st around, join. (12)'].join('\n'));
    expect(basket.pieces[0].rows[2].ops.some((o) => JSON.stringify(o).includes('BLO'))).toBe(true);
    expect(risesUp(basket.pieces[0])).toBe(true);
    const flat = parsePattern(['Rnd 1: 6 sc in MR, join. (6)', 'Rnd 2: Ch 1, 2 sc in each st around, join. (12)', 'Rnd 3: Ch 1, *sc in next st, 2 sc in next st; rep from * around, join. (18)', 'Rnd 4: Ch 1, sc in each st around, join. (18)'].join('\n'));
    expect(risesUp(flat.pieces[0])).toBe(false);
  });
});

describe('rows and loops', () => {
  it('reads "sc in the back loop only of each st across" and "in BLO, (3 sc, dec) x 6"', () => {
    const scarf = parsePattern('Ch 21.\nRow 1: Sc in 2nd ch from hook and in each ch across. Turn. (20 sc)\nRow 2: Ch 1, sc in the back loop only of each st across. Turn. (20)\nRows 3-5: Repeat Row 2.\nFasten off.');
    expect(scarf.pieces[0].rows.map((r) => r.computedCount)).toEqual([20, 20, 20, 20, 20]);
    expect(scarf.pieces[0].finish).toBe('open');
    const t = 'Rnd 1: 6 sc in MR (6)\nRnd 2: 6 inc (12)\nRnd 3: (1 sc, inc) x 6 (18)\nRnd 4: (2 sc, inc) x 6 (24)\nRnd 5: (3 sc, inc) x 6 (30)\nRnd 6: in BLO, (3 sc, dec) x 6 (24)';
    expect(warnings(t)).toEqual([]);
    expect(JSON.stringify(parsePattern(t).pieces[0].rows[5].ops)).toContain('BLO');
  });
});

describe('ovals, leaves and small ends', () => {
  it('works round both sides of a foundation chain (an oval) as rounds', () => {
    const text = 'Body\nCh 7.\nRnd 1: Starting in 2nd ch from hook, sc in next 5 ch, 3 sc in last ch, working on the other side of the chain, sc in next 4 ch, 2 sc in last ch. (14)\nRnd 2: inc, 4 sc, inc x3, 4 sc, inc x2 (20)\nRnd 3: sc around (20)';
    const p = parsePattern(text);
    expect(warnings(text)).toEqual([]);
    expect(p.pieces[0].construction).toBe('spiral');
    expect(p.pieces[0].oval).toBe(true);
    expect(counts(text)).toEqual([14, 20, 20]);
  });

  it('reads stitches worked back along a chain just made (leaves) without using up the round below', () => {
    const text = 'Leaves\nCh 6, join to form a ring.\nRnd 1: *ch 4, sl st in 2nd ch from hook, sc in next ch, hdc in next ch, sl st in next st of the ring; repeat from * 5 more times. (6 leaves)';
    expect(warnings(text)).toEqual([]);
  });

  it('leaves an ear that ends small without decreasing open, and closes a ball decreased to 6', () => {
    const p = parsePattern('Ears (make 2)\nRnd 1: 4 sc in MR (4)\nRnd 2: (sc, inc) x2 (6)\nRnd 3: (2 sc, inc) x2 (8)\nFasten off. Do not stuff.\n\nBall\nRnd 1: 6 sc in MR (6)\nRnd 2: inc x6 (12)\nRnd 3: dec x6 (6)\nFasten off.');
    expect(p.pieces[0].finish).not.toBe('closed');
    expect(p.pieces[1].finish).toBe('closed');
  });
});

describe('sewing', () => {
  it('sews the piece just made when the line names it by its shape, and reads "underside" as the bottom', () => {
    const p = parsePattern('Body\nRnd 1: 6 sc in MR (6)\nRnd 2: inc x6 (12)\nRnds 3-6: sc around (12)\n\nNori\nRow 1: Ch 8\nRows 2-6: 7 sc, ch 1, turn\nFasten off, leaving a long tail.\nSew the rectangle onto the lower front of the body.\n\nStem\nRnd 1: 6 sc in MR (6)\nRnds 2-4: sc around (6)\nSew the stem to the underside of the body.');
    expect(p.seams.map((s) => [s.piece, s.host, s.hint])).toEqual([['p2', 'p1', 'front'], ['p3', 'p1', 'bottom']]);
  });
  it('embroiders eyes "as shown on the chart" just above a nose sewn on at given rounds, on the head', () => {
    const head = 'Head\nRnd 1: 6 sc in MR (6)\nRnd 2: inc x6 (12)\nRnds 3-20: sc around (12)\n\n';
    const p = parsePattern(head + 'Nose\nRound 1 = 6 sc in magic ring (6)\nRound 2 = 6 inc (12)\nRound 3 = [1 inc, 1 sc] x 6 (18)\nStuff lightly and sew between rounds 12 and 16 of the head.\nWith black embroidery cotton, embroider the eyes as shown on the chart below.');
    expect(p.pieces[0].markers.map((m) => [m.kind, m.rowA])).toEqual([['embroidery', 11]]);
    expect(p.pieces[1].markers).toEqual([]);
  });
});

describe('solid granny square (corner groups, "dc in each dc", the last corner at the start)', () => {
  const text = [
    'Foundation Ring: Chain 5 and join with sl st to make a ring.',
    'Round 1: Ch 4 (counts as tr here and throughout). Into the ring, work 3 dc, (1 tr, 3 dc) three times. Join with sl st to the top of the beginning ch 4 to close the round. [16 sts - 4 corner tr and 3 dc per side]',
    "Round 2: Ch 4, 2 dc in the same stitch (which is the top of previous round's turning chain). * Dc in each dc on the first side of the square. Work (2dc, tr, 2dc) in the corner tr. Repeat from * for each side. In the last corner, work 2 dc in the base of the ch 4 to finish the corner. Join with a sl st to the top of the beginning ch 4 to close the round. [32 sts - 4 corner tr and 7 dc per side]",
  ].join('\n');

  it('reads both rounds with the stated counts and no skipped words', () => {
    expect(counts(text)).toEqual([16, 32]);
    expect(warnings(text)).toEqual([]);
  });

  it('finds the four corners of round 2, including the one split across the start and end', async () => {
    const { buildGraph } = await import('../src/graph/build');
    const { computeSizing } = await import('../src/geometry/sizing');
    const p = parsePattern(text);
    const g = buildGraph(p, computeSizing(p, { tension: 'normal' }));
    const r2 = g.instances[0].rows.find((r) => r.row === 2)!;
    expect(r2.corners?.length).toBe(4);
  });
});
