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
  instances: { nodeIds: number[]; stuffed: number; closed?: boolean; drape?: number; rings?: number[][]; ringR?: number[]; ringCorners?: (number[] | undefined)[]; brim?: { top: number[]; fold: number[]; rings: number[][]; radius: number[] }; stalk?: number[]; shape?: { triangle?: boolean; flatBottom?: boolean; oval?: boolean }; flat: boolean; side?: number[]; planeNormal: [number, number, number]; hAvg: number; crease: number[] }[];
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
  private stalkMask?: Uint8Array;
  energy = Infinity;
  private comp?: Int32Array;
  private stickB?: Uint32Array;
  private owner?: Int32Array;
  /** move a clearance stick's surface stitch to a neighbour (same piece) nearer its stitch */
  private nearestOnSurface(k: number) {
    const p = this.pos, a = this.input.stick![k] * 3, sb = this.stickB!, own = this.owner!;
    let b = sb[k / 3];
    const d2 = (j: number) => (p[j * 3] - p[a]) ** 2 + (p[j * 3 + 1] - p[a + 1]) ** 2 + (p[j * 3 + 2] - p[a + 2]) ** 2;
    for (let it = 0; it < 4; it++) {
      let best = b, bd = d2(b);
      for (let q = this.nbrStart[b]; q < this.nbrStart[b + 1]; q++) {
        const j = this.nbr[q];
        if (own[j] !== own[b]) continue;
        const d = d2(j);
        if (d < bd) { bd = d; best = j; }
      }
      if (best === b) break;
      b = best;
    }
    sb[k / 3] = b;
  }
  private compSize?: Float32Array;

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
      // a stalk has no stuffing to round it out or push it open
      this.stalkMask = new Uint8Array(N);
      for (const pi of this.inst) for (const id of pi.stalk ?? []) { this.stuffedMask[id] = 1; this.stalkMask[id] = 1; }
    }
    // mask of nodes NOT on a flattened pouch (ears): those get extra smoothing so the soft
    // double layer evens out instead of crumpling where its round end can't lie flat
    if (this.inst.some((pi) => pi.side)) {
      this.pouchMask = new Uint8Array(N).fill(1);
      for (const pi of this.inst) if (pi.side) for (const id of pi.nodeIds) this.pouchMask[id] = input.fixed?.[id] ?? 0;
    }
    // joined pieces (edges and sticks): draping one part must not make the whole toy sink
    if (this.inst.some((pi) => pi.drape)) {
      const par = new Int32Array(N).map((_, i) => i);
      const find = (i: number): number => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
      const join = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) par[rb] = ra; };
      for (let e = 0; e < E; e++) join(input.edges[e * 5], input.edges[e * 5 + 1]);
      const st = input.stick;
      if (st) for (let k = 0; k < st.length; k += 3) join(st[k], st[k + 1]);
      this.comp = new Int32Array(N);
      for (let i = 0; i < N; i++) this.comp[i] = find(i);
      this.compSize = new Float32Array(N);
      for (let i = 0; i < N; i++) this.compSize[this.comp[i]]++;
    }
    if (input.stick) {
      this.stickB = new Uint32Array(input.stick.length / 3);
      for (let k = 0; k < this.stickB.length; k++) this.stickB[k] = input.stick[k * 3 + 1];
      this.owner = new Int32Array(N).fill(-1);
      this.inst.forEach((pi, j) => { for (const id of pi.nodeIds) this.owner![id] = j; });
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
  /**
   * A flat circle (a coaster) blocks round: increases stacked in the same place would otherwise
   * leave corners. Each round is pulled gently toward a circle of its own mean radius.
   */
  /**
   * A brim (rounds after a front-loop fold that grow much wider): it stands out from the fold as a
   * flat ring at its full width. Unstuffed, nothing else holds it out, and smoothing pulls the
   * free edge in until the brim crumples.
   */
  private holdBrim(b: { top: number[]; fold: number[]; rings: number[][]; radius: number[] }) {
    const p = this.pos;
    const cen = (ids: number[]) => {
      const c = [0, 0, 0];
      for (const id of ids) for (let k = 0; k < 3; k++) c[k] += p[id * 3 + k] / ids.length;
      return c;
    };
    const C = cen(b.fold), T = cen(b.top);
    let ax = [C[0] - T[0], C[1] - T[1], C[2] - T[2]];
    const al = Math.hypot(ax[0], ax[1], ax[2]);
    if (al < 1e-6) return;
    ax = ax.map((v) => v / al);
    b.rings.forEach((r, j) => {
      const R = b.radius[j];
      for (const id of r) {
        const v = [p[id * 3] - C[0], p[id * 3 + 1] - C[1], p[id * 3 + 2] - C[2]];
        const a = v[0] * ax[0] + v[1] * ax[1] + v[2] * ax[2];
        const rad = [v[0] - a * ax[0], v[1] - a * ax[1], v[2] - a * ax[2]];
        const L = Math.hypot(rad[0], rad[1], rad[2]) || 1e-6;
        const kr = ((R - L) / L) * 0.3;
        for (let c = 0; c < 3; c++) p[id * 3 + c] += rad[c] * kr - a * ax[c] * 0.3;
      }
    });
  }

  private roundOut(rings: number[][], n: [number, number, number], ringR?: number[], corners?: (number[] | undefined)[]) {
    const p = this.pos;
    let cx = 0, cy = 0, cz = 0, m = 0;
    for (const r of rings) for (const id of r) { cx += p[id * 3]; cy += p[id * 3 + 1]; cz += p[id * 3 + 2]; m++; }
    if (!m) return;
    cx /= m; cy /= m; cz /= m;
    // plane basis
    const a = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const dot = a[0] * n[0] + a[1] * n[1] + a[2] * n[2];
    let u = [a[0] - dot * n[0], a[1] - dot * n[1], a[2] - dot * n[2]];
    const ul = Math.hypot(u[0], u[1], u[2]); u = u.map((x) => x / ul);
    const w = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
    const all = rings.map((r) => r.map((id) => {
      let dx = p[id * 3] - cx, dy = p[id * 3 + 1] - cy, dz = p[id * 3 + 2] - cz;
      const d = dx * n[0] + dy * n[1] + dz * n[2];
      dx -= d * n[0]; dy -= d * n[1]; dz -= d * n[2];
      return [dx, dy, dz, Math.hypot(dx, dy, dz) || 1e-6];
    }));
    const angOf = (vs: number[][]) => (j: number) => Math.atan2(vs[j][0] * w[0] + vs[j][1] * w[1] + vs[j][2] * w[2], vs[j][0] * u[0] + vs[j][1] * u[1] + vs[j][2] * u[2]);
    // a motif's corners stack straight out from the middle, round on round (each corner group is
    // worked into the corner space below it): one turn and one winding for every round, or the
    // rounds twist against each other like a pinwheel
    let sx = 0, sy = 0, wd = 0, k = 0;
    rings.forEach((r, ri) => {
      const cs = corners?.[ri];
      if (!cs || cs.length < 3 || r.length < 6) return;
      k = cs.length;
      const ang = angOf(all[ri]);
      const dir = this.windingOf(cs, ang);
      wd += dir * r.length;
      cs.forEach((j, i) => { const d = (ang(j) - (dir || 1) * i * (2 * Math.PI / k)) * k; sx += Math.cos(d) * r.length; sy += Math.sin(d) * r.length; });
    });
    // (k-fold symmetric: the turn is only known modulo one corner step, so average k × angle)
    const phi0 = Math.atan2(sy, sx) / (k || 1);
    const dir = Math.sign(wd) || 1;
    rings.forEach((r, ri) => {
      if (r.length < 6) return;
      const vs = all[ri];
      // at least most of its own width: stitches fanned out of one space (a granny square's corner
      // groups) otherwise bunch up where they are worked and the round folds into spikes
      const R = Math.max(vs.reduce((acc, v) => acc + v[3], 0) / vs.length, (ringR?.[ri] ?? 0) * 0.9);
      const cs = corners?.[ri];
      if (cs && cs.length >= 3) { this.toPolygon(r, cs, vs, R, [cx, cy, cz], u, w, phi0, dir, angOf(vs)); return; }
      r.forEach((id, j) => {
        const [dx, dy, dz, L] = vs[j];
        const f = ((R - L) / L) * 0.25;
        p[id * 3] += dx * f; p[id * 3 + 1] += dy * f; p[id * 3 + 2] += dz * f;
      });
    });
  }

  /** Pull a round toward a regular polygon with its corners at the given stitches (a granny square). */
  private toPolygon(r: number[], cs: number[], vs: number[][], R: number, c: number[], u: number[], w: number[], phi0: number, dir: number, ang: (j: number) => number) {
    const p = this.pos;
    const k = cs.length;
    const step = (2 * Math.PI) / k;
    // which of the k turns of the common phase this round's first corner sits nearest
    let best = 0, bd = Infinity;
    for (let q = 0; q < k; q++) {
      let d = ang(cs[0]) - (phi0 + q * step);
      d = Math.atan2(Math.sin(d), Math.cos(d));
      if (Math.abs(d) < bd) { bd = Math.abs(d); best = q; }
    }
    const start = phi0 + best * step;
    // same perimeter as the circle of radius R: circumradius of the polygon
    const Rc = (Math.PI * R) / (k * Math.sin(Math.PI / k));
    const cornerPos = cs.map((_, i) => { const t = start + dir * i * step; return [Math.cos(t) * Rc, Math.sin(t) * Rc]; });
    const m = r.length;
    for (let i = 0; i < k; i++) {
      const j0 = cs[i], j1 = cs[(i + 1) % k];
      const span = ((j1 - j0 + m) % m) || m;
      for (let s = 0; s < span; s++) {
        const j = (j0 + s) % m;
        const t = s / span;
        const tx = cornerPos[i][0] * (1 - t) + cornerPos[(i + 1) % k][0] * t;
        const ty = cornerPos[i][1] * (1 - t) + cornerPos[(i + 1) % k][1] * t;
        const id = r[j];
        const target = [c[0] + u[0] * tx + w[0] * ty, c[1] + u[1] * tx + w[1] * ty, c[2] + u[2] * tx + w[2] * ty];
        const cur = [c[0] + vs[j][0], c[1] + vs[j][1], c[2] + vs[j][2]];
        for (let q = 0; q < 3; q++) p[id * 3 + q] += (target[q] - cur[q]) * 0.45;
      }
    }
  }

  /** +1 when the round runs counter-clockwise (by its corner angles), -1 clockwise. */
  private windingOf(cs: number[], ang: (j: number) => number): number {
    let s = 0;
    for (let i = 0; i < cs.length; i++) { let d = ang(cs[(i + 1) % cs.length]) - ang(cs[i]); while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; s += d; }
    return Math.sign(s);
  }

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
    const drop = this.comp ? new Float32Array(this.comp.length) : undefined;
    for (const pi of this.inst) {
      if (pi.stuffed > 0) {
        const f = pi.stuffed * pi.hAvg * 0.1;
        for (const id of pi.nodeIds) {
          if ((fixed && fixed[id]) || this.stalkMask?.[id]) continue;
          const i = id * 3;
          p[i] += this.nrm[i] * f; p[i + 1] += this.nrm[i + 1] * f; p[i + 2] += this.nrm[i + 2] * f;
        }
      }
      // loose fabric hanging from a join (a skirt) drapes down instead of standing out
      if (pi.drape) {
        const g = pi.drape * pi.hAvg;
        for (const id of pi.nodeIds) if (!(fixed && fixed[id])) { p[id * 3 + 1] -= g; if (drop) drop[this.comp![id]] += g; }
      }
      if (pi.rings) this.roundOut(pi.rings, pi.planeNormal, pi.ringR, pi.ringCorners);
      if (pi.brim) this.holdBrim(pi.brim);
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
    // the drape pulled some parts down: lift each joined toy back by the average, so the hanging
    // part moves against the rest instead of the whole toy sinking frame after frame
    if (drop && this.comp && this.compSize) for (let i = 0; i < drop.length; i++) {
      const c = this.comp[i];
      if (drop[c]) p[i * 3 + 1] += drop[c] / this.compSize[c];
    }
    const st = this.input.stick;
    if (st) {
      for (let k = 0; k < st.length; k += 3) {
        // a negative offset only keeps the stitch clear of the surface (a veil hanging over hair);
        // the surface stitch it keeps clear of follows it, to whichever neighbour is now nearest
        if (st[k + 2] < 0) this.nearestOnSurface(k);
        const a = st[k] * 3, b = this.stickB![k / 3] * 3, off = Math.abs(st[k + 2]);
        if (st[k + 2] >= 0) for (let c = 0; c < 3; c++) p[a + c] += (p[b + c] + this.nrm[b + c] * off - p[a + c]) * 0.5;
        // never inside the clearance: a cap that is tighter than the host would otherwise sink
        // into it and the host's colour shows through in patches
        const d = (p[a] - p[b]) * this.nrm[b] + (p[a + 1] - p[b + 1]) * this.nrm[b + 1] + (p[a + 2] - p[b + 2]) * this.nrm[b + 2];
        // (a clearance only holds over the surface: past the edge of the hair it lets go)
        const lat = st[k + 2] < 0 ? (p[a] - p[b]) ** 2 + (p[a + 1] - p[b + 1]) ** 2 + (p[a + 2] - p[b + 2]) ** 2 - d * d : 0;
        if (d < off && lat < 4 * off * off) for (let c = 0; c < 3; c++) p[a + c] += this.nrm[b + c] * (off - d);
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
