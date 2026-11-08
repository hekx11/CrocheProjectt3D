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
  instances: { nodeIds: number[]; stuffed: number; closed?: boolean; shape?: { triangle?: boolean; flatBottom?: boolean; oval?: boolean }; flat: boolean; side?: number[]; planeNormal: [number, number, number]; hAvg: number; crease: number[] }[];
  smoothing: number; // 0..1 (stiffer yarn → smoother)
  /**
   * Per edge, how hard the edge resists being stretched past its rest length (1 = rigid, the default).
   * Stuffed fabric isn't rigid: the yarn gives a little under the stuffing's pressure, more where the
   * fabric is flat (increase rounds, straight sides), which is what rounds out a stuffed ball.
   */
  give?: Float32Array;
  /** [patchNode, hostNode, offset]*: the patch node is held offset out along the host node's normal */
  stick?: Float32Array;
  fixed?: Uint8Array; // 1 = do not move (virtual / pinned)
}

/** How far stuffed yarn can give before it is taut (fraction of rest length). */
export const STRETCH_CAP = 0.1;
/** Extra smoothing on stuffed pieces (stuffing evens the shape out). */
export const ROUNDING = 0.1;
/** How firmly a flattened pouch (ears) is held flat; low lets it cup a little instead of crumpling. */
export const PUCKER = 0.15;
export const POUCH_SMOOTH = 0.3;

export class Solver {
  pos: Float32Array;
  private prev: Float32Array;
  private nrm: Float32Array;
  private nbrStart: Uint32Array;
  private nbr: Uint32Array;
  private inst: SolverInput['instances'];
  private crease: Uint8Array;
  private pouchMask?: Uint8Array;
  private shapeBase = new Map<object, number>();
  /** how hard stuffing rounds each node out: firmer stuffing rounds more (stuffed²) */
  private roundWeight?: Float32Array;
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
    // mask of nodes NOT on a closed stuffed piece (laplace() skips "fixed" nodes); open pieces sewn
    // on (a snout) keep their dome: smoothing an open edge would flatten it
    if (this.inst.some((pi) => pi.stuffed > 0)) {
      this.stuffedMask = new Uint8Array(N).fill(1);
      this.roundWeight = new Float32Array(N);
      for (const pi of this.inst) if (pi.stuffed > 0 && pi.closed !== false) for (const id of pi.nodeIds) { this.stuffedMask[id] = input.fixed?.[id] ?? 0; this.roundWeight[id] = pi.stuffed * pi.stuffed; }
    }
    // mask of nodes NOT on a flattened pouch (ears): those get extra smoothing so the soft
    // double layer evens out instead of crumpling where its round end can't lie flat
    if (this.inst.some((pi) => pi.side)) {
      this.pouchMask = new Uint8Array(N).fill(1);
      for (const pi of this.inst) if (pi.side) for (const id of pi.nodeIds) this.pouchMask[id] = input.fixed?.[id] ?? 0;
    }
    this.crease = new Uint8Array(N);
    for (const pi of this.inst) for (const id of pi.crease) this.crease[id] = 1;
  }

  private laplace(lam: number, fixed?: Uint8Array, weight?: Float32Array) {
    const p = this.pos;
    const N = p.length / 3;
    const d = this.nrm; // reuse as scratch, overwritten by computeNormals later
    for (let i = 0; i < N; i++) {
      const s0 = this.nbrStart[i], s1 = this.nbrStart[i + 1];
      if ((fixed && fixed[i]) || s1 - s0 < 2) { d[i * 3] = d[i * 3 + 1] = d[i * 3 + 2] = 0; continue; }
      let cx = 0, cy = 0, cz = 0;
      for (let j = s0; j < s1; j++) { const q = this.nbr[j] * 3; cx += p[q]; cy += p[q + 1]; cz += p[q + 2]; }
      const inv = 1 / (s1 - s0);
      const l = (this.crease[i] ? lam * 0.2 : lam) * (weight ? weight[i] : 1);
      d[i * 3] = (cx * inv - p[i * 3]) * l;
      d[i * 3 + 1] = (cy * inv - p[i * 3 + 1]) * l;
      d[i * 3 + 2] = (cz * inv - p[i * 3 + 2]) * l;
    }
    for (let i = 0; i < p.length; i++) p[i] += d[i];
  }

  /**
   * Hand shaping of a stuffed piece, as a gentle pull toward the shape (world up = +y, front = +z):
   * triangle = width tapers toward the top and the piece is a bit thinner front to back (onigiri);
   * flatBottom = nodes below a base plane are pushed up onto it; oval = taller than wide.
   */
  private shapeBy(pi: { nodeIds: number[]; shape?: { triangle?: boolean; flatBottom?: boolean; oval?: boolean } }) {
    const p = this.pos, ids = pi.nodeIds, sh = pi.shape!;
    let cx = 0, cy = 0, cz = 0, y0 = Infinity, y1 = -Infinity;
    for (const id of ids) { cx += p[id * 3]; cy += p[id * 3 + 1]; cz += p[id * 3 + 2]; y0 = Math.min(y0, p[id * 3 + 1]); y1 = Math.max(y1, p[id * 3 + 1]); }
    cx /= ids.length; cy /= ids.length; cz /= ids.length;
    const H = Math.max(1e-6, y1 - y0), k = 0.08;
    for (const id of ids) {
      const i = id * 3;
      if (sh.triangle) {
        const t = (p[i + 1] - y0) / H; // 0 bottom … 1 top
        const sx = 1.35 - 1.0 * t;
        p[i] += (cx + (p[i] - cx) * sx - p[i]) * k;
        p[i + 2] += (cz + (p[i + 2] - cz) * 0.8 - p[i + 2]) * k;
      }
      if (sh.oval) {
        p[i + 1] += (cy + (p[i + 1] - cy) * 1.15 - p[i + 1]) * k;
        p[i] += (cx + (p[i] - cx) * 0.93 - p[i]) * k;
        p[i + 2] += (cz + (p[i + 2] - cz) * 0.93 - p[i + 2]) * k;
      }
      if (sh.flatBottom || sh.triangle) {
        // the base plane is set once, where it first sits (pushing it up every step would creep)
        const base = this.shapeBase.get(pi) ?? (this.shapeBase.set(pi, y0 + H * 0.12), y0 + H * 0.12);
        if (p[i + 1] < base) p[i + 1] += (base - p[i + 1]) * 0.3;
      }
    }
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
      if (this.stuffedMask) this.laplace(ROUNDING, this.stuffedMask, this.roundWeight);
      if (this.pouchMask) { this.laplace(POUCH_SMOOTH, this.pouchMask); this.laplace(-POUCH_SMOOTH * 1.04, this.pouchMask); }
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
      if (pi.shape) this.shapeBy(pi);
      if (pi.flat) {
        // pull toward the best-fit plane through the centroid (normal = average normal)
        let cx = 0, cy = 0, cz = 0, nx = 0, ny = 0, nz = 0;
        for (const id of pi.nodeIds) { const i = id * 3; cx += p[i]; cy += p[i + 1]; cz += p[i + 2]; }
        const k = 1 / Math.max(1, pi.nodeIds.length);
        cx *= k; cy *= k; cz *= k;
        [nx, ny, nz] = pi.planeNormal;
        // flattened pouches keep their two layers a yarn apart (side = -1 back, 1 front, 0 fold)
        const half = pi.hAvg * 0.3;
        for (let j = 0; j < pi.nodeIds.length; j++) {
          const id = pi.nodeIds[j];
          const i = id * 3;
          const sd = pi.side ? pi.side[j] : 0;
          const d = (p[i] - cx) * nx + (p[i + 1] - cy) * ny + (p[i + 2] - cz) * nz - sd * half;
          // a pouch may cup outward (its round end can't lie perfectly flat) but its layers never
          // cross: strong push back when a layer comes inside, only a gentle pull otherwise
          const k = sd !== 0 && d * sd < 0 ? 0.6 : pi.side ? PUCKER : 0.3;
          p[i] -= d * nx * k; p[i + 1] -= d * ny * k; p[i + 2] -= d * nz * k;
        }
      }
    }
    const st = this.input.stick;
    if (st) {
      for (let k = 0; k < st.length; k += 3) {
        const a = st[k] * 3, b = st[k + 1] * 3, off = st[k + 2];
        for (let c = 0; c < 3; c++) p[a + c] += (p[b + c] + this.nrm[b + c] * off - p[a + c]) * 0.5;
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
