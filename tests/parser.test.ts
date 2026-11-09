import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { parsePattern } from '../src/parser/parse';
import { countMade, countOf, execute, parseRowText } from '../src/parser/row';

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

describe('tested doll and coaster wordings', () => {
  it('joins two legs into a body, grows a skirt from front loops, and reads "in all N st" / "repeat N times"', () => {
    const p = parsePattern(`Doll
LEGS
Make 2, start in white yarn:
Rnd 1: start 5 sc in a magic ring [5]
Rnd 2: inc in all 5 st [10]
Rnd 3 – 4: change to skin color yarn, sc in all 10 st [10]
Fasten off on the first leg. Don't fasten off on the second leg.
BODY
In white yarn:
Rnd 5: ch 2, sc in the marked stitch on the first leg, sc in next 9 st on the first leg, sc in next 2 ch, sc in next 10 st on the second leg, sc in the opposite side of the next 2 ch [24]
Rnd 6: (sc in next 3 st, inc in next st) repeat 6 times [30]
Stuff the legs and the body firmly with fiberfill.
Rnd 7: BLO sc in all 30 st [30]
Rnd 8: (sc in next 3 st, dec) repeat 6 times [24]
Rnd 9: (sc in next 2 st, dec) repeat 6 times [18]
Rnd 10: dec 9 times [9]
Fasten off.
SKIRT
In white yarn:
Pull up a loop of white yarn in one of the leftover front loops of round 6 of the body.
Rnd 1: FLO sc in all 30 st [30]
Rnd 2: (sc in next 2 st, inc in next st) repeat 10 times [40]
Fasten off and weave in the yarn end.
`);
    expect(noWarnings(p)).toEqual([]);
    expect(p.pieces.map((q) => [q.name, q.quantity])).toEqual([['Legs', 2], ['Body', 1], ['Skirt', 1]]);
    expect(p.pieces[0].stuffing).toBe('firm');
    expect(p.pieces[1].base?.map((b) => (b.kind === 'ch' ? `ch${b.n}${b.back ? 'b' : ''}` : `${b.piece}:${b.inst}:${b.row}`))).toEqual(['p1:0:4', 'ch2', 'p1:1:4', 'ch2b']);
    expect(p.pieces[1].rows.map((r) => r.computedCount)).toEqual([24, 30, 30, 24, 18, 9]);
    // "round 6" has 30 stitches left in front loops (round 7 is worked in back loops)
    expect(p.pieces[2].base).toEqual([{ kind: 'row', piece: 'p2', inst: 0, row: 2, loop: 'FLO' }]);
    expect(p.pieces[0].rows.map((r) => r.yarnId)).toEqual(['white', 'white', 'skin color', 'skin color']);
  });

  it('reads a coaster with a part round, re-attached colours, star repeats and "(-) all in one stitch"', () => {
    const p = parsePattern(`Moon
(-) All in one stitch
Start by making a magic ring with light blue.
R1: Make 16 dc’s and sl st to first st to join. Fasten off (16)
Attach Pale yellow or camel yarn where you fastened off.
R2: Ch 1, 1 sc in the next st. 1 hdc in each of the next 2 sts, (1 hdc, 1 dc), 2 dc’s in each of the next 2 sts, (2 hdc), 1 hdc, 1 sc, sl st to the next st to join and fasten off. (20 sts)
Attach light blue or Aster where you fastened off.
R3: *Inc, 1 sc in each of the next 3 sts* repeat around. Sl st to first sc to join. ( 25 sts)
R4: Ch 1 (does not count as a st), *Inc, 1 sc in each of the next 4 sts* Repeat around. Sl st to first sc to join. (30 sts)
Attach Gold or Dark yellow where you fastened off.
R5: *Ch 1, sl st to the next st* Repeat around ensuring to keep your sl sts loose. (30 sc and 30 ch 1's)
Fasten off and weave in the ends.
`);
    expect(noWarnings(p)).toEqual([]);
    expect(p.pieces).toHaveLength(1);
    expect(p.pieces[0].rows.map((r) => r.computedCount)).toEqual([16, 20, 25, 30, 60]);
    expect(p.pieces[0].rows.map((r) => r.yarnId)).toEqual(['light blue', 'pale yellow', 'light blue', 'light blue', 'gold']);
    expect(p.seams).toEqual([]);
  });

  it('sews named pieces to named hosts, wraps a strip round the shoulders, and skips "sew it closed"', () => {
    const p = parsePattern(`Doll
BODY
Rnd 1: 6 sc in a magic ring [6]
Rnd 2: inc in all 6 st [12]
Rnd 3: (sc in next st, inc in next st) repeat 6 times [18]
Rnd 4 – 8: sc in all 18 st [18]
Rnd 9: (sc in next st, dec) repeat 6 times [12]
Rnd 10: dec 6 times [6]
Fasten off.
ARMS
Make 2, in skin color yarn:
Rnd 1: start 6 sc in a magic ring [6]
Rnd 2 – 5: sc in all 6 st [6]
Fasten off. Flatten the arm and sew it closed. Sew the arms to both sides of the body, over rounds 4 and 5.
COLLAR
Ch 13. Crochet in rows.
Rnd 1: start in second ch from hook, slst in next 2 ch, sc in next 8 ch, slst in next 2 ch [12]
Fasten off. Wrap the collar around the shoulders and sew the ends together at the front.
BUN
Rnd 1: start 6 sc in a magic ring [6]
Rnd 2: inc in all 6 st [12]
Fasten off.
ASSEMBLY
Place the bun to the top of the body, stuff it lightly and sew it on. Glue a stick to the middle of the body.
`);
    expect(noWarnings(p)).toEqual([]);
    expect(p.seams.map((s) => [s.piece, s.host, s.hint, s.rowA, s.rowB])).toEqual([
      ['p2', 'p1', 'side', 4, 5], ['p3', 'p1', 'wrap', undefined, undefined], ['p4', 'p1', 'top', undefined, undefined],
    ]);
    expect(p.pieces[2].rows[0].computedCount).toBe(12);
  });
});

describe('legs joined by a note before the body', () => {
  it('reads "Leg 2: Ch 6, insert hook into leg 1", "With pink:" and F/O', () => {
    const p = parsePattern(`Toy
Stuff firmly as your work progresses.
Legs (make 2)
With white:
Round 1 = 6 sc in magic ring (6)
Round 2 = 6 inc (12)
Leg 1: F/O. Hide tail.
Leg 2: Ch 3, insert hook into leg 1: 1 sc.
Continue working around both legs and the chain.
Body
Round 1 = 30 sc (30)
Round 2 = 30 sc (30)
F/O. Leave long tail for sewing.
Nose
With pink:
Round 1 = 6 sc in magic ring (6)
F/O. Leave long tail for sewing.
`);
    expect(noWarnings(p)).toEqual([]);
    expect(p.pieces[1].base?.map((b) => b.kind)).toEqual(['row', 'ch', 'row', 'ch']);
    expect(p.pieces[1].stuffing).toBe('firm');
    expect(p.pieces[2].rows[0].yarnId).toBe('pink');
  });
});

describe('chain straps, hosts with a where-clause, cheeks', () => {
  const p = parsePattern(`Doll
In gray yarn:
BODY
Rnd 1: 6 sc in a magic ring [6]
Rnd 2: inc in all 6 st [12]
Rnd 3 – 8: sc in all 12 st [12]
EYES: Insert the safety eyes between round 6 and 7, with an interspace of 5 stitches.
Embroider the cheeks with pink yarn.
Fasten off.
STRAPS
Make 2, start in gray yarn:
Pull up a loop of gray yarn in the first loop of round 3 at the back of the body.
Ch 20, leaving a long yarn tail. You may need to bring the chain over the shoulders.
TIE
In gray yarn:
Ch 6. Crochet in rows.
Row 1: start in second ch from hook, sc in next 5 ch [5]
Fasten off. Sew the tie to the front of the body, just below the head and in between the straps.
`);
  it('makes a chain-only piece that starts on the named round', () => {
    const s = p.pieces.find((q) => q.name.toLowerCase().includes('strap'))!;
    expect(s.quantity).toBe(2);
    expect(s.rows.length).toBe(0);
    expect(s.start).toMatchObject({ kind: 'chain', n: 20, ring: false }); // "bring" is not "ring"
    expect(s.strap?.host).toBe(p.pieces[0].id);
    expect(s.strap?.row).toBe(3);
  });
  it('sews to the piece named first, not one in a later where-clause', () => {
    const tie = p.pieces.find((q) => q.name.toLowerCase().includes('tie'))!;
    expect(p.seams.find((q) => q.piece === tie.id)?.host).toBe(p.pieces[0].id);
  });
  it('puts cheeks beside the eyes when no round is given', () => {
    const cheeks = p.pieces[0].markers.filter((m) => m.kind === 'embroidery');
    expect(cheeks.length).toBe(1);
    expect(cheeks[0].rowA).toBe(6);
    const eyes = p.pieces[0].markers.find((m) => m.kind === 'safety-eyes')!;
    expect(cheeks[0].spacingSts).toBe((eyes.spacingSts ?? 6) + 6);
  });
});

describe('hair strands', () => {
  it('counts strands worked off the last round, with their chain lengths', () => {
    const p = parsePattern(`Hair
Rnd 1: 6 sc in a magic ring [6]
Rnd 2: inc in all 6 st [12]
Rnd 3: sc in all 12 st [12]
Rnd 4: (ch 30, start in second ch from hook, sc in next 29 ch, slst in next st of hair base) repeat 2 times, (ch 31, start in second ch from hook, sc in next 30 ch, slst in next st of hair base) repeat 2 times [4 strands in total]
`);
    const r = p.pieces[0].rows[p.pieces[0].rows.length - 1];
    expect(r.skipGeometry).toBe(true);
    expect(r.strands?.map((s) => s.len)).toEqual([30, 30, 31, 31]);
  });
});

describe('a point worked into part of a row (a tiara)', () => {
  const text = `BAND
Ch 21. Crochet in rows.
Row 1: start in second ch from hook, sc in next 20 st [20]
Row 2: slst in this st, sc in next st, hdc + dc in next st, ch 2, start in second ch from hook, sc in this st, dc + hdc in next st, sc in next st, slst in next st. [10]
Fasten off.`;
  const p = parsePattern(text);
  const row = p.pieces[0].rows[1];
  const ex = execute(row.ops, 20, false);

  it('reads "hdc + dc in next st" as both stitches in one stitch', () => {
    expect(ex.stitches.filter((s) => !s.isChain && s.onChain === undefined).map((s) => `${s.type}${s.targets[0]}`)).toEqual(
      ['slst0', 'sc1', 'hdc2', 'dc2', 'dc3', 'hdc3', 'sc4', 'slst5']);
    expect(ex.leftover).toBe(14);
  });

  it('works the sc after "ch 2, start in second ch from hook" back into the chain', () => {
    expect(ex.stitches.map((s) => s.type).join(' ')).toBe('slst sc hdc dc ch ch sc dc hdc sc slst');
    expect(ex.stitches[6].onChain).toBe(4);
  });

  it('accepts the stated count, which counts the chain and the stitch in it', () => {
    expect(p.diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
    expect(row.status).toBe('assumption');
    expect(countMade(ex)).toBe(10);
  });

  it('still reports a count that no way of counting gives', () => {
    const bad = parsePattern(text.replace('[10]', '[12]'));
    expect(bad.diagnostics.some((d) => d.code === 'count-mismatch' && /I count 7 stitches, the pattern says 12 \(I don't count chains, stitches worked into them or the slip stitch at the start\)/.test(d.message))).toBe(true);
  });
});
