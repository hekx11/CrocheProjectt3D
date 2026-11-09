import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parsePattern } from '../src/parser/parse';
import { buildModel } from '../src/geometry/pipeline';
import { Solver } from '../src/geometry/solver';

const fx = (name: string) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

function solve(text: string, frames = 400) {
  const model = buildModel(parsePattern(text), { tension: 'normal' });
  const s = new Solver(model.solverInput);
  for (let f = 0; f < frames; f++) if (s.step(10) < 0.002) break;
  const p = s.pos;
  const ext = [0, 1, 2].map((a) => {
    let mn = Infinity, mx = -Infinity;
    for (let i = a; i < p.length; i += 3) { mn = Math.min(mn, p[i]); mx = Math.max(mx, p[i]); }
    return mx - mn;
  });
  return { model, pos: p, ext };
}

describe('flat row-worked pieces', () => {
  it('coaster solves to a flat square, not a wavy sheet', () => {
    const { ext, model, pos } = solve(fx('coaster.txt'));
    const { w, h } = model.sizing;
    const [x, y, z] = ext;
    expect(z).toBeLessThan(w * 0.5); // no out-of-plane wobble
    // 15 sc × 15 rows at 16 sts / 18 rows per 10 cm ≈ 9.5 × 8.5 cm
    expect(x).toBeGreaterThan(13 * w);
    expect(x / y).toBeGreaterThan(0.95);
    expect(x / y).toBeLessThan(1.25);
    // every row stays straight (no rippling) and as wide as the others (no gathering at the chain)
    const rows = model.graph.instances[0].rows.filter((r) => r.row > 0);
    const widths: number[] = [];
    for (const r of rows) {
      const ys = r.nodes.map((id) => pos[id * 3 + 1]);
      const xs = r.nodes.map((id) => pos[id * 3]);
      expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(h * 0.5);
      widths.push(Math.max(...xs) - Math.min(...xs));
    }
    expect(Math.min(...widths) / Math.max(...widths)).toBeGreaterThan(0.95);
  });
});

describe('graph rules from tested patterns', () => {
  it('ties chain loops in a row to the stitch below them (scallops stay on the edge)', () => {
    const model = buildModel(parsePattern(`Cup
Rnd 1: 6 sc in a magic ring [6]
Rnd 2: inc in all 6 st [12]
Rnd 3: (ch 2, slst in next st) repeat 12 times [36]
`), { tension: 'normal' });
    const g = model.graph;
    const last = g.instances[0].rows[g.instances[0].rows.length - 1];
    const chains = last.nodes.filter((id) => g.nodes[id].type === 'ch');
    expect(chains.length).toBe(24);
    for (const id of chains) expect(g.edges.some((e) => e.kind === 'into' && e.b === id)).toBe(true);
  });
  it('works a round after short rows into the stitches they left unworked', () => {
    const model = buildModel(parsePattern(`Cap
Rnd 1: 6 sc in a magic ring [6]
Rnd 2: inc in all 6 st [12]
Rnd 3 – 4: sc in all 12 st [12]
Rnd 5: sc in next 6 st, ch 1, turn [6] Leave the remaining stitches unworked.
Rnd 6: sc in next 6 st [6]
Do not turn and continue crocheting in rounds.
Rnd 7: sc in next 12 st [12]
`), { tension: 'normal' });
    const g = model.graph;
    const rows = g.instances[0].rows;
    const r7 = rows[rows.length - 1];
    const r4 = rows.find((r) => r.row === 4)!;
    // round 7 reaches the six stitches of round 4 that round 5 skipped
    const into = new Set(g.edges.filter((e) => e.kind === 'into' && r7.nodes.includes(e.b)).map((e) => e.a));
    expect(r4.nodes.filter((id) => into.has(id)).length).toBe(6);
    // short rows are open rows (their two ends are not joined into a ring)
    expect(rows.find((r) => r.row === 5)!.closed).toBe(false);
    expect(rows.find((r) => r.row === 4)!.closed).toBe(true);
  });
});

describe('pieces wrapped round another piece', () => {
  it('hangs the worked part of a wrapped chain at the back, outside the piece it is wrapped round', () => {
    const model = buildModel(parsePattern(`Ball
Rnd 1: 6 sc in a magic ring [6]
Rnd 2: inc in all 6 st [12]
Rnd 3: (sc, inc) repeat 6 times [18]
Rnd 4: (2 sc, inc) repeat 6 times [24]
Rnd 5 – 8: sc in all 24 st [24]
Rnd 9: (2 sc, dec) repeat 6 times [18]
Rnd 10: (sc, dec) repeat 6 times [12]
Stuff firmly.
Rnd 11: dec 6 times [6]
Fasten off.

Veil
Ch 30. Crochet in rows.
Row 1: start in second ch from hook, sc in next 8 st [8] Leave the remaining stitches unworked.
Row 2: ch 1, turn, 2 sc in each st [16]
Row 3: ch 1, turn, sc in each st [16]
Fasten off.

Assembly
Wrap the foundation chain of the veil around the ball.
`), { tension: 'normal' });
    const s = new Solver(model.solverInput);
    for (let f = 0; f < 300; f++) if (s.step(10) < 0.002) break;
    const [ball, veil] = model.graph.instances;
    expect(model.solverInput.instances[1].flat).toBe(false);
    const c = [0, 1, 2].map((k) => ball.nodeIds.reduce((a, id) => a + s.pos[id * 3 + k], 0) / ball.nodeIds.length);
    const R = ball.nodeIds.reduce((a, id) => a + Math.hypot(s.pos[id * 3] - c[0], s.pos[id * 3 + 1] - c[1], s.pos[id * 3 + 2] - c[2]), 0) / ball.nodeIds.length;
    const hanging = veil.rows.slice(1).flatMap((r) => r.nodes);
    const z = hanging.reduce((a, id) => a + s.pos[id * 3 + 2], 0) / hanging.length;
    expect(z).toBeLessThan(c[2]); // behind: the front (+z) stays clear
    const inside = hanging.filter((id) => Math.hypot(s.pos[id * 3] - c[0], s.pos[id * 3 + 1] - c[1], s.pos[id * 3 + 2] - c[2]) < R * 0.9);
    expect(inside.length).toBe(0);
  });
});

describe('hat brims', () => {
  it('holds a brim out flat at its full width instead of crumpling it', () => {
    const model = buildModel(parsePattern(`Hat
Rnd 1: 5 sc in a magic ring [5]
Rnd 2: inc in all 5 st [10]
Rnd 3: (sc, inc) repeat 5 times [15]
Rnd 4: (2 sc, inc) repeat 5 times [20]
Rnd 5: BLO sc in all 20 st [20]
Rnd 6 – 9: sc in all 20 st [20]
Rnd 10: FLO sc in all 20 st [20]
Rnd 11: inc in all 20 st [40]
Rnd 12: sc in all 40 st [40]
Fasten off.
`), { tension: 'normal' });
    expect(model.solverInput.instances[0].brim?.rings.length).toBe(2);
    const s = new Solver(model.solverInput);
    for (let f = 0; f < 300; f++) if (s.step(10) < 0.002) break;
    const rows = model.graph.instances[0].rows;
    const last = rows[rows.length - 1].nodes;
    const c = [0, 1, 2].map((k) => last.reduce((a, id) => a + s.pos[id * 3 + k], 0) / last.length);
    const r = last.reduce((a, id) => a + Math.hypot(s.pos[id * 3] - c[0], s.pos[id * 3 + 1] - c[1], s.pos[id * 3 + 2] - c[2]), 0) / last.length;
    const nominal = last.reduce((a, id) => a + model.graph.nodes[id].w, 0) / (2 * Math.PI);
    expect(r).toBeGreaterThan(nominal * 0.8);
  });
});

describe('motifs and cups worked in joined rounds', () => {
  const granny = [
    'Ch 4, join with a sl st to form a ring.',
    'Round 1: Ch 3 (counts as first dc), 2 dc into ring, ch 2, *3 dc into ring, ch 2; repeat from * 2 more times. Join with sl st to top of beg ch-3. (12 dc, 4 ch-2 spaces)',
    'Round 2: Sl st into next 2 dc and into ch-2 space. Ch 3, (2 dc, ch 2, 3 dc) in same space, ch 1, *(3 dc, ch 2, 3 dc) in next ch-2 space, ch 1; repeat from * 2 more times. Join. (24 dc)',
    'Round 3: Sl st into next 2 dc and into ch-2 space. Ch 3, (2 dc, ch 2, 3 dc) in same space, ch 1, 3 dc in next ch-1 space, ch 1, *(3 dc, ch 2, 3 dc) in next ch-2 space, ch 1, 3 dc in next ch-1 space, ch 1; repeat from * 2 more times. Join. (36 dc)',
  ].join('\n');

  it('a granny square lies flat at its full size, each round about a dc taller than the last', () => {
    const { ext, model, pos } = solve(granny);
    const { h } = model.sizing;
    expect(ext[1]).toBeLessThan(h);
    const rows = model.graph.instances[0].rows.filter((r) => r.row > 0);
    const radius = rows.map((r) => {
      const c = [0, 2].map((k) => r.nodes.reduce((a, id) => a + pos[id * 3 + k], 0) / r.nodes.length);
      return r.nodes.reduce((a, id) => a + Math.hypot(pos[id * 3] - c[0], pos[id * 3 + 2] - c[1]), 0) / r.nodes.length;
    });
    // dc are ~1.9 sc tall: each round adds well over one sc height (they used to bunch up at 2–3 mm)
    expect(radius[2] - radius[0]).toBeGreaterThan(2 * h * 1.2);
  });

  it('a granny square blocks to a square: four corners stick out further than the middle of each side', () => {
    const { model, pos } = solve(granny);
    const pi = model.graph.instances[0];
    const last = pi.rows[pi.rows.length - 1];
    expect(last.corners?.length).toBe(4);
    const c = [0, 2].map((k) => pi.nodeIds.reduce((a, id) => a + pos[id * 3 + k], 0) / pi.nodeIds.length);
    const rad = (j: number) => Math.hypot(pos[last.nodes[j] * 3] - c[0], pos[last.nodes[j] * 3 + 2] - c[1]);
    const cs = last.corners!;
    const corner = cs.reduce((a, j) => a + rad(j), 0) / 4;
    const mid = cs.reduce((a, j, i) => a + rad(Math.floor((j + (cs[(i + 1) % 4] + (i === 3 ? last.nodes.length : 0))) / 2) % last.nodes.length), 0) / 4;
    // a square's corners are √2 ≈ 1.41× as far out as the middle of its sides; a circle would be 1
    expect(corner / mid).toBeGreaterThan(1.2);
  });

  it('a granny square\'s corners stack straight out from the middle, round on round (no pinwheel twist)', () => {
    const { model, pos } = solve(granny);
    const pi = model.graph.instances[0];
    const rc = model.solverInput.instances[0].ringCorners!;
    const rings = model.solverInput.instances[0].rings!;
    const c = [0, 2].map((k) => pi.nodeIds.reduce((a, id) => a + pos[id * 3 + k], 0) / pi.nodeIds.length);
    const ang = (id: number) => Math.atan2(pos[id * 3 + 2] - c[1], pos[id * 3] - c[0]);
    const corners = (ri: number) => rc[ri]!.map((j) => ang(rings[ri][j])).sort((a, b) => a - b);
    const outer = corners(rings.length - 1);
    for (let ri = 0; ri < rings.length - 1; ri++) {
      for (const a of corners(ri)) {
        const d = Math.min(...outer.map((b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)))));
        expect(d).toBeLessThan(0.3); // within ~17°: each corner sits under the corner above it
      }
    }
  });

  it('a granny square opens up to its real size: clusters stand side by side along their space', () => {
    const { ext, model } = solve(granny);
    // three rounds of dc out from a small ring, each round a dc tall (~1.9 sc) on every side, and
    // a little more as the clusters stand apart round the corners: about 4" in worsted
    expect(Math.min(ext[0], ext[2])).toBeGreaterThan(2 * 3 * 1.9 * model.sizing.h * 1.15);
  });

  it('leaves the chain spaces of a granny square open, but not the stitches of a solid circle', () => {
    const g = buildModel(parsePattern(granny), { tension: 'normal' });
    expect(g.holes.some((h) => h)).toBe(true);
    const solid = buildModel(parsePattern('Rnd 1: 6 sc in a magic ring [6]\nRnd 2: inc in all 6 st [12]\nRnd 3: (sc, inc) repeat 6 times [18]'), { tension: 'normal' });
    expect(solid.holes.some((h) => h)).toBe(false);
  });

  it('a basket (rounds that stop increasing) stands up instead of lying flat', () => {
    const basket = 'Rnd 1: Ch 3 (does not count as a st), 12 dc in 3rd ch from hook, sl st to first dc to join. (12)\nRnd 2: Ch 2, 2 dc in each st around, sl st to join. (24)\nRnd 3: Ch 1, sc in the back loop of each st around, sl st to join. (24)\nRnds 4-12: Ch 1, sc in each st around, sl st to join. (24)';
    const { ext, model } = solve(basket);
    expect(ext[1]).toBeGreaterThan(model.sizing.h * 5);
  });
});

describe('stalks and flattened pieces on a head (the Moogle)', () => {
  const head = `Head
Round 1 = 6 sc in magic ring (6)
Round 2 = 6 inc (12)
Round 3 = [1 inc, 1 sc] x 6 (18)
Round 4 = [1 sc, 1 inc, 1 sc] x 6 (24)
Round 5 = [1 inc, 3 sc] x 6 (30)
Round 6 = [2 sc, 1 inc, 2 sc] x 6 (36)
Rounds 7-14 = 36 sc (36)
Round 15 = [2 sc, 1 dec, 2 sc] x 6 (30)
Round 16 = [1 dec, 3 sc] x 6 (24)
Round 17 = [1 sc, 1 dec, 1 sc] x 6 (18)
Round 18 = [1 dec, 1 sc] x 6 (12)
Round 19 = 6 dec (6)
Stuff firmly.
`;

  it('a pompom on a long narrow stem stands up off the head instead of folding the stem flat', () => {
    const { model, pos } = solve(head + `
Pompom
Round 1 = 6 sc in magic ring (6)
Round 2 = 6 inc (12)
Round 3 = [1 inc, 1 sc] x 6 (18)
Round 4 = [1 sc, 1 inc, 1 sc] x 6 (24)
Rounds 5-7 = 24 sc (24)
Round 8 = [1 sc, 1 dec, 1 sc] x 6 (18)
Round 9 = [1 dec, 1 sc] x 6 (12)
Round 10 = 6 dec (6)
Rounds 11-20 = 6 sc (6)
Stuff firmly.
Sew the stem to the top of the head.
`);
    const pom = model.graph.instances[1];
    const rows = pom.rows.filter((r) => r.row > 0);
    const y = (r: { nodes: number[] }) => r.nodes.reduce((a, id) => a + pos[id * 3 + 1], 0) / r.nodes.length;
    // ten rounds of stem: most of ten stitch heights between the ball and the stem's end
    expect(Math.abs(y(rows[9]) - y(rows[rows.length - 1]))).toBeGreaterThan(model.sizing.h * 7.5);
  });

  it('a flattened ear sewn "between round 3 and 9" is sewn along all of those rounds', () => {
    const model = buildModel(parsePattern(head + `
Ears (make 2)
Round 1 = 6 sc in magic ring (6)
Round 2 = 6 inc (12)
Rounds 3-4 = 12 sc (12)
Flatten your work.
Sew the ears to the head, between round 3 and 9.
`), { tension: 'normal' });
    const [h, ear] = model.graph.instances;
    const edge = new Set(ear.rows[ear.rows.length - 1].nodes);
    const rowOf = new Map<number, number>();
    for (const r of h.rows) for (const id of r.nodes) rowOf.set(id, r.row);
    const e = model.solverInput.edges;
    const hostRows = new Set<number>();
    for (let i = 0; i < e.length; i += 5) {
      if (edge.has(e[i]) && rowOf.has(e[i + 1])) hostRows.add(rowOf.get(e[i + 1])!);
      if (edge.has(e[i + 1]) && rowOf.has(e[i])) hostRows.add(rowOf.get(e[i])!);
    }
    expect(Math.min(...hostRows)).toBeLessThanOrEqual(4);
    expect(Math.max(...hostRows)).toBeGreaterThanOrEqual(8);
  });

  it('a flattened ear stands out from the head instead of lying down on it', () => {
    const { model, pos } = solve(head + `
Ears (make 2)
Round 1 = 6 sc in magic ring (6)
Round 2 = 6 inc (12)
Round 3 = 12 sc (12)
Round 4 = [1 inc, 1 sc] x 6 (18)
Rounds 5-6 = 18 sc (18)
Flatten your work.
Sew the ears to the head, between round 4 and 10.
`);
    const [h, ear] = model.graph.instances;
    const c = [0, 1, 2].map((k) => h.nodeIds.reduce((a, id) => a + pos[id * 3 + k], 0) / h.nodeIds.length);
    const d = (id: number) => Math.hypot(pos[id * 3] - c[0], pos[id * 3 + 1] - c[1], pos[id * 3 + 2] - c[2]);
    const R = Math.max(...h.nodeIds.map(d));
    const tip = ear.rows.find((r) => r.row === 1)!.nodes;
    expect(tip.reduce((a, id) => a + d(id), 0) / tip.length - R).toBeGreaterThan(model.sizing.h * 2);
  });
});

describe('arms with their tops flattened and sewn on at the sides', () => {
  it('droop down and out from the shoulder instead of standing straight out', () => {
    const body = `Body
Round 1 = 6 sc in magic ring (6)
Round 2 = 6 inc (12)
Round 3 = [1 inc, 1 sc] x 6 (18)
Round 4 = [1 inc, 2 sc] x 6 (24)
Rounds 5-14 = 24 sc (24)
Round 15 = [1 dec, 2 sc] x 6 (18)
Stuff firmly.

Arms (make 2)
Round 1 = 6 sc in magic ring (6)
Round 2 = 6 inc (12)
Rounds 3-10 = 12 sc (12)
Stuff lightly.
Flatten the upper parts of the arms and close them. Then sew them to each side of the body, on round 12.
`;
    expect(parsePattern(body).pieces[1].flatEdge).toBe(true);
    const { model, pos } = solve(body);
    const arm = model.graph.instances[1];
    const y = (ids: number[]) => ids.reduce((a, id) => a + pos[id * 3 + 1], 0) / ids.length;
    const tip = arm.rows.find((r) => r.row === 1)!.nodes, top = arm.rows[arm.rows.length - 1].nodes;
    expect(y(top) - y(tip)).toBeGreaterThan(model.sizing.h * 2);
  });
});

describe('seeding a tall piece', () => {
  it('stacks each stitch over the one it is worked into: round 30 is not turned against round 5', () => {
    const model = buildModel(parsePattern('Tube\nRnd 1: 6 sc in a magic ring [6]\nRnd 2: inc in all 6 st [12]\nRnd 3: (sc, inc) repeat 6 times [18]\nRnd 4: (2 sc, inc) repeat 6 times [24]\nRnd 5 - 30: sc in all 24 st [24]\n'), { tension: 'normal' });
    const p = model.solverInput.pos;
    const rows = model.graph.instances[0].rows;
    const ang = (row: number) => { const id = rows.find((r) => r.row === row)!.nodes[0]; return Math.atan2(p[id * 3 + 2], p[id * 3]); };
    let d = ang(30) - ang(5);
    d = Math.atan2(Math.sin(d), Math.cos(d));
    // stitch 0 of every plain round is worked into stitch 0 of the round below
    expect(Math.abs(d)).toBeLessThan((2 * Math.PI) / 24);
  });
});

describe('a doll with a bow tie sewn to its chest', () => {
  // the groom from a bride & groom pattern: legs joined into one body and head, a little
  // row-worked bow sewn on the front just under the head
  const doll = `LEGS
Make 2:
Rnd 1: start 5 sc in a magic ring [5]
Rnd 2: inc in all 5 st [10]
Rnd 3 – 7: sc in all 10 st [10]
Fasten off on the first leg. Don’t fasten off on the second leg.

BODY AND HEAD
In the next round, we’ll join both legs together to create the body.
Rnd 8: ch 2, sc in the marked stitch on the first leg, sc in next 9 st on the first leg, sc in next 2 ch, sc in next 10 st on the second leg, sc in the opposite side of the next 2 ch [24]
Rnd 9: sc in all 24 st [24]
Rnd 10: (sc in next 3 st, inc in next st) repeat 6 times [30]
Rnd 11 – 12: sc in all 30 st [30]
Rnd 13: BLO sc in all 30 st [30]
Rnd 14: (sc in next 3 st, dec) repeat 6 times [24]
Rnd 15: sc in all 24 st [24]
Rnd 16: (sc in next 2 st, dec) repeat 6 times [18]
Rnd 17 – 18: sc in all 18 st [18]
Rnd 19: (sc in next st, dec) repeat 6 times [12]
Rnd 20: sc in all 12 st [12]
Rnd 21: BLO sc in all 12 st [12]
Rnd 22: inc in all 12 st [24]
Rnd 23: (sc in next 3 st, inc in next st) repeat 6 times [30]
Rnd 24: (sc in next 4 st, inc in next st) repeat 6 times [36]
Rnd 25: (sc in next 5 st, inc in next st) repeat 6 times [42]
Rnd 26 – 34: sc in all 42 st [42]
Rnd 35: (sc in next 5 st, dec) repeat 6 times [36]
Rnd 36: (sc in next 4 st, dec) repeat 6 times [30]
Rnd 37: (sc in next 3 st, dec) repeat 6 times [24]
Rnd 38: (sc in next 2 st, dec) repeat 6 times [18]
Rnd 39: (sc in next st, dec) repeat 6 times [12]
Rnd 40: dec 6 times [6]
Fasten off. Weave the yarn tail through the front loop of each remaining stitch and pull tight to close.

BOW
Ch 6. Crochet in rows.
Row 1: start in second ch from hook, sc in next 2 ch, slst in next ch, sc in next 2 ch, ch 1, turn.
Row 2: BLO sc in next 2 st, slst in next st, sc in next 2 st [5]
Fasten off. Sew the bow tie to the front of the body, just below of the head.
`;
  it('stands upright: the bow does not push the chest forward', () => {
    const { model, pos } = solve(doll);
    const body = model.graph.instances.find((pi) => /body/i.test(pi.piece.name))!;
    const rows = body.rows.filter((r) => r.row > 0 && r.nodes.length);
    const c = (ids: number[]) => [0, 1, 2].map((k) => ids.reduce((a, id) => a + pos[id * 3 + k], 0) / ids.length);
    // the torso: from where the legs join to the neck
    const a = c(rows[0].nodes), b = c(rows[11].nodes);
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const lean = (Math.acos(d[1] / Math.hypot(...d)) * 180) / Math.PI;
    expect(lean).toBeLessThan(5); // 9° forward when the bow was sewn on twice
  }, 60000);
});
