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
