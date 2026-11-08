import { computeNormals } from './mesh';

/**
 * Position-based relaxation (option B, spec/geometry-ux-joining.md).
 * Plain data in, plain data out, so it can run in a Web Worker.
 */
export interface SolverInput {
  pos: Float32Array; // 3N
  edges: Float32Array; // [a, b, rest, stiffness, slack] * E — slack: allowed compression ratio (stuffed fabric bunches, it doesn't push back)
  tris: Uint32Array;
  triPiece: Uint16Array;
  instances: { nodeIds: number[]; stuffed: number; flat: boolean; planeNormal: [number, number, number]; hAvg: number; crease: number[] }[];
  smoothing: number; // 0..1 (stiffer yarn → smoother)
  /**
   * Per edge, how hard the edge resists being stretched past its rest length (1 = rigid, the default).
   * Stuffed fabric isn't rigid: the yarn gives a little under the stuffing's pressure, more where the
   * fabric is flat (increase rounds, straight sides), which is what rounds out a stuffed ball.
   */
  give?: Float32Array;
  fixed?: Uint8Array; // 1 = do not move (virtual / pinned)
}

/** How far stuffed yarn can give before it is taut (fraction of rest length). */
export const STRETCH_CAP = 0.1;
/** Extra smoothing on stuffed pieces (stuffing evens the shape out). */
export const ROUNDING = 0.1;

export class Solver {
  pos: Float32Array;
  private prev: Float32Array;
  private nrm: Float32Array;
  private nbrStart: Uint32Array;
  private nbr: Uint32Array;
  private inst: SolverInput['instances'];
  private crease: Uint8Array;
  private stuffedMask: Uint8Array | null = null;
  energy = Infinity;

  constructor(private input: SolverInput) {
    this.pos = input.pos.slice();
    this.prev = input.pos.slice();
    this.nrm = new Float32Array(input.pos.length);
    this.inst = input.instances;
    const N = input.pos.length / 3;
    // neighbour lists from edges (for smoothing)
    const deg = new Uint32Array(N + 1);
    const E = input.edges.length / 5;
    for (let e = 0; e < E; e++) { deg[input.edges[e * 5]]++; deg[input.edges[e * 5 + 1]]++; }
    this.nbrStart = new Uint32Array(N + 1);
    for (let i = 0; i < N; i++) this.nbrStart[i + 1] = this.nbrStart[i] + deg[i];
    this.nbr = new Uint32Array(this.nbrStart[N]);
    const fill = this.nbrStart.slice();
    for (let e = 0; e < E; e++) {
      const a = input.edges[e * 5], b = input.edges[e * 5 + 1];
      this.nbr[fill[a]++] = b;
      this.nbr[fill[b]++] = a;
    }
    // mask of nodes NOT on a stuffed piece (laplace() skips "fixed" nodes)
    if (this.inst.some((pi) => pi.stuffed > 0)) {
      this.stuffedMask = new Uint8Array(N).fill(1);
      for (const pi of this.inst) if (pi.stuffed > 0) for (const id of pi.nodeIds) this.stuffedMask[id] = input.fixed?.[id] ?? 0;
    }
    this.crease = new Uint8Array(N);
    for (const pi of this.inst) for (const id of pi.crease) this.crease[id] = 1;
  }

  private laplace(lam: number, fixed?: Uint8Array) {
    const p = this.pos;
    const N = p.length / 3;
    const d = this.nrm; // reuse as scratch, overwritten by computeNormals later
    for (let i = 0; i < N; i++) {
      const s0 = this.nbrStart[i], s1 = this.nbrStart[i + 1];
      if ((fixed && fixed[i]) || s1 - s0 < 2) { d[i * 3] = d[i * 3 + 1] = d[i * 3 + 2] = 0; continue; }
      let cx = 0, cy = 0, cz = 0;
      for (let j = s0; j < s1; j++) { const q = this.nbr[j] * 3; cx += p[q]; cy += p[q + 1]; cz += p[q + 2]; }
      const inv = 1 / (s1 - s0);
      const l = this.crease[i] ? lam * 0.2 : lam;
      d[i * 3] = (cx * inv - p[i * 3]) * l;
      d[i * 3 + 1] = (cy * inv - p[i * 3 + 1]) * l;
      d[i * 3 + 2] = (cz * inv - p[i * 3 + 2]) * l;
    }
    for (let i = 0; i < p.length; i++) p[i] += d[i];
  }

  /** Run `iters` iterations; returns the largest node movement (mm). */
  step(iters = 8): number {
    const { edges, tris, triPiece, fixed, give } = this.input;
    const p = this.pos;
    const E = edges.length / 5;
    this.prev.set(p);
    let energy = 0;
    for (let it = 0; it < iters; it++) {
      // 1. distance constraints
      energy = 0;
      for (let e = 0; e < E; e++) {
        const a = edges[e * 5] * 3, b = edges[e * 5 + 1] * 3, rest = edges[e * 5 + 2], k = edges[e * 5 + 3], slack = edges[e * 5 + 4];
        const dx = p[b] - p[a], dy = p[b + 1] - p[a + 1], dz = p[b + 2] - p[a + 2];
        const L = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
        let target = rest;
        let kk = k;
        if (L < rest) { if (L >= rest * slack) continue; target = rest * slack; }
        else if (give && give[e] < 1) {
          // loose yarn: gives softly for the first few percent, then the yarn is taut
          if (L <= rest * (1 + STRETCH_CAP)) kk = k * give[e];
          else target = rest * (1 + STRETCH_CAP);
        }
        const diff = (L - target) / L;
        energy += Math.abs(L - rest);
        const fa = fixed && fixed[a / 3] ? 0 : 1;
        const fb = fixed && fixed[b / 3] ? 0 : 1;
        const sum = fa + fb;
        if (!sum) continue;
        const s = (diff * kk) / sum;
        p[a] += dx * s * fa; p[a + 1] += dy * s * fa; p[a + 2] += dz * s * fa;
        p[b] -= dx * s * fb; p[b + 1] -= dy * s * fb; p[b + 2] -= dz * s * fb;
      }
      // 2. Taubin smoothing (λ then −μ) so the surface stays smooth without shrinking;
      //    weaker on crease rows (BLO/FLO) so those edges can fold.
      const lam = this.input.smoothing;
      this.laplace(lam, fixed);
      this.laplace(-lam * 1.04, fixed);
      // stuffing fills the fabric out evenly: on stuffed pieces, extra smoothing without the
      // shrink-back step rounds off flat ends and sharp rims (pressure keeps the volume up)
      if (this.stuffedMask) this.laplace(ROUNDING, this.stuffedMask);
    }
    // 3. pressure for stuffed pieces, planarity for flat ones
    computeNormals(p, tris, triPiece, this.inst as any, this.nrm);
    for (const pi of this.inst) {
      if (pi.stuffed > 0) {
        const f = pi.stuffed * pi.hAvg * 0.1;
        for (const id of pi.nodeIds) {
          if (fixed && fixed[id]) continue;
          const i = id * 3;
          p[i] += this.nrm[i] * f; p[i + 1] += this.nrm[i + 1] * f; p[i + 2] += this.nrm[i + 2] * f;
        }
      }
      if (pi.flat) {
        // pull toward the best-fit plane through the centroid (normal = average normal)
        let cx = 0, cy = 0, cz = 0, nx = 0, ny = 0, nz = 0;
        for (const id of pi.nodeIds) { const i = id * 3; cx += p[i]; cy += p[i + 1]; cz += p[i + 2]; }
        const k = 1 / Math.max(1, pi.nodeIds.length);
        cx *= k; cy *= k; cz *= k;
        [nx, ny, nz] = pi.planeNormal;
        for (const id of pi.nodeIds) {
          const i = id * 3;
          const d = (p[i] - cx) * nx + (p[i + 1] - cy) * ny + (p[i + 2] - cz) * nz;
          p[i] -= d * nx * 0.3; p[i + 1] -= d * ny * 0.3; p[i + 2] -= d * nz * 0.3;
        }
      }
    }
    let maxMove = 0;
    for (let i = 0; i < p.length; i++) {
      if (!Number.isFinite(p[i])) p[i] = this.prev[i];
      maxMove = Math.max(maxMove, Math.abs(p[i] - this.prev[i]));
    }
    this.energy = energy;
    return maxMove;
  }
}
