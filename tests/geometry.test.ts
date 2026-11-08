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
