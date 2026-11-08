import type { Pattern, Seam } from '../model/types';
import { COLORS } from '../model/dictionary';
import type { GEdge, GRow, PieceInstance, StitchGraph } from '../graph/build';

export interface MarkerAnchor {
  kind: 'safety-eyes' | 'embroidery';
  a: number; // node ids; position = midpoint
  b: number;
  sizeMm: number;
  line: number;
  /** embroidery: what it is (a nose is a small bump, cheeks soft blush, else a dark line) and the
   *  colour of the yarn it is stitched in, when the text names one */
  what?: 'nose' | 'cheek' | 'line';
  color?: string;
}

export interface Seeded {
  pos: Float32Array;
  angle: Float32Array; // seed angle per node (rounds) — used for placement and markers
  markers: MarkerAnchor[];
  seamEdges: GEdge[];
  planeNormals: Map<PieceInstance, V>;
}

const TAU = Math.PI * 2;
const FRONT = Math.PI / 2; // +z faces the camera

function circMean(vals: number[]): number {
  let s = 0, c = 0;
  for (const v of vals) { s += Math.sin(v); c += Math.cos(v); }
  return Math.atan2(s, c);
}

/** Analytic seed (option A, spec/geometry-ux-joining.md): rings stacked by stitch height, or a flat grid for rows. */
export function seed(g: StitchGraph, p: Pattern, w: number): Seeded {
  const N = g.nodes.length;
  const pos = new Float32Array(N * 3);
  const angle = new Float32Array(N);
  for (const pi of g.instances) {
    if (pi.piece.construction === 'rows') seedRows(g, pi, pos);
    else seedRounds(g, pi, pos, angle);
    centre(pi, pos);
    // a body worked up from joined legs grows upward: turn it over (about z, so the front stays front)
    if (isUpright(pi)) for (const id of pi.nodeIds) { pos[id * 3] = -pos[id * 3]; pos[id * 3 + 1] = -pos[id * 3 + 1]; angle[id] = Math.PI - angle[id]; }
  }
  const planeNormals = new Map<PieceInstance, V>();
  for (const pi of g.instances) planeNormals.set(pi, pi.piece.construction === 'rows' ? [0, 0, 1] : [0, 1, 0]);
  const seamEdges = placePieces(g, p, pos, angle, w, planeNormals);
  // after placement: a body turned to stand on its legs has turned its angles with it
  const markers = placeMarkers(g, p, angle);
  return { pos, angle, markers, seamEdges, planeNormals };
}

function seedRounds(g: StitchGraph, pi: PieceInstance, pos: Float32Array, angle: Float32Array) {
  let Rprev = 0;
  let y = 0;
  let prevAngles: number[] = [];
  if (pi.centre !== undefined) pos.set([0, 0, 0], pi.centre * 3);
  for (const row of pi.rows) {
    const n = row.nodes.length;
    if (!n) continue;
    let wsum = 0, hsum = 0;
    for (const id of row.nodes) { wsum += g.nodes[id].w; hsum += g.nodes[id].h; }
    const R = Math.max(wsum / TAU, 0.5);
    const h = hsum / n;
    const dR = R - Rprev;
    const dy = Math.sqrt(Math.max(h * h - dR * dR, (0.12 * h) ** 2));
    y -= row.ring !== undefined ? h * 0.3 : dy;
    let phase = 0;
    if (prevAngles.length && row.anchors.some((a) => a >= 0)) {
      const diffs: number[] = [];
      row.anchors.forEach((a, j) => { if (a >= 0 && prevAngles[a] !== undefined) diffs.push(prevAngles[a] - (TAU * j) / n); });
      phase = circMean(diffs);
    }
    const angles: number[] = [];
    row.nodes.forEach((id, j) => {
      const th = phase + (TAU * (j + 0.5)) / n;
      angles.push(th);
      angle[id] = th;
      pos.set([R * Math.cos(th), y, R * Math.sin(th)], id * 3);
    });
    prevAngles = angles;
    Rprev = R;
  }
}

function seedRows(g: StitchGraph, pi: PieceInstance, pos: Float32Array) {
  // Each row is laid out at its own natural width (sum of stitch widths), centred over the
  // stitches it is worked into and running in the direction those stitches run. Squeezing a
  // row into the width of the row below leaves stretched yarn edges that the solver then
  // relaxes into ripples.
  let y = 0;
  let prevX: number[] = [];
  for (const row of pi.rows) {
    const n = row.nodes.length;
    if (!n) continue;
    let hsum = 0;
    const widths = row.nodes.map((id) => g.nodes[id].w);
    for (const id of row.nodes) hsum += g.nodes[id].h;
    const h = hsum / n;
    const wsum = widths.reduce((a, b) => a + b, 0);
    let cx = 0, dir = 1;
    if (prevX.length) {
      const anchored = row.anchors.filter((a) => a >= 0 && prevX[a] !== undefined);
      if (anchored.length) {
        cx = anchored.reduce((s, a) => s + prevX[a], 0) / anchored.length;
        const first = prevX[anchored[0]], last = prevX[anchored[anchored.length - 1]];
        if (last !== first) dir = Math.sign(last - first);
        else dir = -Math.sign((prevX[prevX.length - 1] ?? 0) - (prevX[0] ?? 0)) || 1; // a turned row runs back
      }
      y -= h;
    }
    const xs: number[] = [];
    let acc = -wsum / 2;
    for (let j = 0; j < n; j++) {
      xs.push(cx + dir * (acc + widths[j] / 2));
      acc += widths[j];
    }
    row.nodes.forEach((id, j) => pos.set([xs[j], y, 0], id * 3));
    prevX = xs;
  }
}

/** A piece started from two or more joined parts (legs) is worked bottom-up. */
export function isUpright(pi: PieceInstance): boolean {
  return (pi.piece.base?.filter((b) => b.kind === 'row').length ?? 0) >= 2;
}

function centre(pi: PieceInstance, pos: Float32Array) {
  let cx = 0, cy = 0, cz = 0;
  for (const id of pi.nodeIds) { cx += pos[id * 3]; cy += pos[id * 3 + 1]; cz += pos[id * 3 + 2]; }
  const k = 1 / Math.max(1, pi.nodeIds.length);
  for (const id of pi.nodeIds) { pos[id * 3] -= cx * k; pos[id * 3 + 1] -= cy * k; pos[id * 3 + 2] -= cz * k; }
}

function rowNodes(pi: PieceInstance, row: number): number[] {
  return pi.rows.find((r) => r.row === row)?.nodes ?? [];
}

function nearestByAngle(g: StitchGraph, angle: Float32Array, ids: number[], target: number): number {
  let best = ids[0];
  let bd = Infinity;
  for (const id of ids) {
    const d = Math.abs(Math.atan2(Math.sin(angle[id] - target), Math.cos(angle[id] - target)));
    if (d < bd) { bd = d; best = id; }
  }
  return best;
}

/** The yarn colour an embroidery is stitched in: a yarn of the pattern named in the text, or a colour word. */
function markColor(p: Pattern, text: string): string | undefined {
  const t = text.toLowerCase();
  let best: { at: number; c: string } | undefined;
  const consider = (word: string, c: string) => {
    const at = t.indexOf(word.toLowerCase());
    if (word.length > 2 && at >= 0 && (!best || word.length > 0 && at < best.at)) best = { at, c };
  };
  for (const y of p.materials.yarns) consider(y.label.replace(/\s*yarn$/i, ''), y.color);
  if (!best) for (const [k, c] of Object.entries(COLORS)) consider(k, c);
  return best?.c;
}

function placeMarkers(g: StitchGraph, p: Pattern, angle: Float32Array): MarkerAnchor[] {
  const out: MarkerAnchor[] = [];
  for (const pi of g.instances) {
    for (const m of pi.piece.markers) {
      if (m.kind !== 'safety-eyes' && m.kind !== 'embroidery') continue;
      const ra = rowNodes(pi, m.rowA);
      const rb = rowNodes(pi, m.rowB ?? m.rowA);
      if (!ra.length || !rb.length) continue;
      const n = ra.length;
      const half = ((m.spacingSts ?? 6) / 2) * (TAU / n) + (m.kind === 'safety-eyes' ? 0 : 0);
      // a nose is one mark in the middle; eyes and cheeks come in pairs
      const sides = m.kind === 'embroidery' && /\bnose\b/i.test(m.text) && !/eye|cheek/i.test(m.text) ? [0] : [-1, 1];
      const what = m.kind !== 'embroidery' ? undefined : /\bcheek|blush/i.test(m.text) ? 'cheek' : sides.length === 1 ? 'nose' : 'line';
      const color = m.kind === 'embroidery' ? markColor(p, m.text) : undefined;
      for (const side of sides) {
        const th = FRONT + side * half;
        out.push({
          what, color,
          kind: m.kind,
          a: nearestByAngle(g, angle, ra, th),
          b: nearestByAngle(g, angle, rb, th),
          sizeMm: m.kind === 'safety-eyes' ? m.sizeMm ?? p.materials.eyeMm ?? 9 : 0,
          line: m.line,
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Multi-piece placement (spec/geometry-ux-joining.md, #11)

type V = [number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V, s: number): V => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V): V => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const get = (pos: Float32Array, id: number): V => [pos[id * 3], pos[id * 3 + 1], pos[id * 3 + 2]];

function centroid(pos: Float32Array, ids: number[]): V {
  let c: V = [0, 0, 0];
  for (const id of ids) c = add(c, get(pos, id));
  return mul(c, 1 / Math.max(1, ids.length));
}

/** Rotate vector v by the rotation taking unit a onto unit b (Rodrigues). */
function rotator(a: V, b: V): (v: V) => V {
  const axis = cross(a, b);
  const s = Math.hypot(...axis);
  const c = dot(a, b);
  if (s < 1e-6) {
    if (c > 0) return (v) => v;
    // 180°: rotate around any perpendicular axis
    const perp = norm(Math.abs(a[0]) < 0.9 ? cross(a, [1, 0, 0]) : cross(a, [0, 1, 0]));
    return (v) => sub(mul(perp, 2 * dot(perp, v)), v);
  }
  const k = mul(axis, 1 / s);
  return (v) => add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1 - c)));
}

function placePieces(g: StitchGraph, p: Pattern, pos: Float32Array, angle: Float32Array, w: number, planes: Map<PieceInstance, V>): GEdge[] {
  const seamEdges: GEdge[] = [];
  const placed = new Set<PieceInstance>();
  const byPiece = (id: string) => g.instances.filter((i) => i.piece.id === id);

  // a piece with a lid on is a container (a cup): stand it on its base, opening up
  for (const seam of p.seams) {
    if (seam.hint !== 'lid') continue;
    for (const host of byPiece(seam.host)) {
      if (isUpright(host)) continue; // worked up from the legs: its opening already faces up
      const c = centroid(pos, host.nodeIds);
      for (const id of host.nodeIds) { pos[id * 3 + 1] = 2 * c[1] - pos[id * 3 + 1]; pos[id * 3 + 2] = 2 * c[2] - pos[id * 3 + 2]; }
    }
  }
  const groups = new Map<PieceInstance, PieceInstance>();
  const find = (a: PieceInstance): PieceInstance => { let r = a; while (groups.get(r) && groups.get(r) !== r) r = groups.get(r)!; return r; };
  const union = (a: PieceInstance, b: PieceInstance) => { const ra = find(a), rb = find(b); if (ra !== rb) groups.set(rb, ra); };
  const attachedInst = new Set<PieceInstance>();
  for (const pi of g.instances) {
    if (!pi.baseRow || !pi.piece.base) continue;
    for (const moved of placeBase(g, pi, pos, angle, w)) { attachedInst.add(moved); placed.add(moved); }
    for (const part of pi.piece.base) if (part.kind === 'row') for (const q of byPiece(part.piece)) if (q.inst === part.inst || q.piece.quantity === 1) union(pi, q);
  }
  for (const seam of p.seams) {
    const host = byPiece(seam.host)[0];
    if (!host) continue;
    for (const pi of byPiece(seam.piece)) union(host, pi);
    placed.add(host);
    const insts = byPiece(seam.piece);
    insts.forEach((pi, k) => {
      if (placed.has(pi)) return;
      // what is already on the host's side: a hanging piece must stay outside all of it
      const near = () => g.instances.filter((q) => q !== pi && placed.has(q) && find(q) === find(host)).flatMap((q) => q.nodeIds);
      attach(g, p, seam, host, pi, k, insts.length, pos, angle, w, seamEdges, planes, near);
      placed.add(pi);
    });
  }
  // chain strands (suspenders, straps): from their start on the host, over the shoulder, down
  // the front
  for (const pc of p.pieces) {
    if (!pc.strap || pc.rows.length) continue;
    const host = byPiece(pc.strap.host)[0];
    if (!host) continue;
    const insts = byPiece(pc.id);
    insts.forEach((pi, k) => {
      union(host, pi);
      attachStrap(g, host, pi, k, insts.length, pc.strap!.row, pc.strap!.back, pos, angle, w, seamEdges);
      placed.add(pi);
    });
  }
  // lay out each group of joined pieces side by side along x
  let x = 0;
  const comps = new Map<PieceInstance, number[]>();
  for (const pi of g.instances) {
    const r = find(pi);
    if (!comps.has(r)) comps.set(r, []);
    comps.get(r)!.push(...pi.nodeIds);
  }
  for (const ids of comps.values()) {
    let minx = Infinity, maxx = -Infinity;
    for (const id of ids) { minx = Math.min(minx, pos[id * 3]); maxx = Math.max(maxx, pos[id * 3]); }
    if (!isFinite(minx)) continue;
    const shift = x - minx;
    for (const id of ids) pos[id * 3] += shift;
    x += maxx - minx + w * 4;
  }
  // centre the whole scene on x
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < g.nodes.length; i++) { mn = Math.min(mn, pos[i * 3]); mx = Math.max(mx, pos[i * 3]); }
  if (isFinite(mn)) for (let i = 0; i < g.nodes.length; i++) pos[i * 3] -= (mn + mx) / 2;
  return seamEdges;
}

/**
 * A piece worked into other pieces. Legs joined into a body hang under it, each under the stitches
 * of the body's first round that went into it; a skirt worked into a round of the body is moved
 * onto that round, growing toward the body's start. Returns the instances it moved.
 */
function placeBase(g: StitchGraph, pi: PieceInstance, pos: Float32Array, angle: Float32Array, w: number): PieceInstance[] {
  const base = pi.baseRow!;
  const first = pi.rows[0];
  if (!first || !base.nodes.length) return [];
  const owner = new Map<number, PieceInstance>();
  for (const q of g.instances) if (q !== pi) for (const id of q.nodeIds) owner.set(id, q);
  const parts = [...new Set(base.nodes.map((id) => owner.get(id)).filter((q): q is PieceInstance => !!q))];
  const moved: PieceInstance[] = [];
  const legs = parts.filter((q) => {
    const last = q.rows[q.rows.length - 1]?.nodes ?? [];
    return last.length && base.nodes.includes(last[0]);
  });
  if (legs.length >= 2 || (legs.length === 1 && parts.length === 1 && isUpright(pi))) {
    const A = centroid(pos, first.nodes);
    const down = norm(sub(A, centroid(pos, pi.rows[1]?.nodes ?? first.nodes))); // away from the body
    const R = first.nodes.reduce((a, id) => a + g.nodes[id].w, 0) / TAU;
    for (const leg of legs) {
      const rim = leg.rows[leg.rows.length - 1].nodes;
      const onIt = first.nodes.filter((_, j) => { const a = first.anchors[j]; return a >= 0 && rim.includes(base.nodes[a]); });
      const Ck = centroid(pos, onIt.length ? onIt : first.nodes);
      const side = sub(Ck, A);
      const sideH = sub(side, mul(down, dot(side, down)));
      const r = rim.reduce((a, id) => a + g.nodes[id].w, 0) / TAU;
      const at = add(add(A, mul(norm(sideH), Math.max(0, R - r * 0.9))), mul(down, (g.nodes[rim[0]].h || w) * 0.8));
      const eC = centroid(pos, rim), lC = centroid(pos, leg.nodeIds);
      const rot = rotator(norm(sub(eC, lC)), mul(down, -1));
      for (const id of leg.nodeIds) pos.set(add(at, rot(sub(get(pos, id), eC))), id * 3);
      // turn the leg about its own axis (mirrored if need be) so each rim stitch sits under the
      // body stitch worked into it: the body walks round one leg from front to back and round
      // the other from back to front, so the two legs need different turns or one gets twisted
      const pairs: [number, number][] = [];
      first.anchors.forEach((a, j) => { if (a >= 0 && rim.includes(base.nodes[a])) pairs.push([base.nodes[a], first.nodes[j]]); });
      if (pairs.length >= 3) {
        const ax = mul(down, -1);
        const e1 = norm(Math.abs(ax[0]) < 0.9 ? cross(ax, [1, 0, 0]) : cross(ax, [0, 0, 1]));
        const e2 = cross(ax, e1);
        const turn = (v: V, th: number, m: boolean): V => {
          const d = sub(v, at);
          const a = dot(d, ax), x = dot(d, e1), y0 = dot(d, e2), y = m ? -y0 : y0;
          const c = Math.cos(th), s = Math.sin(th);
          return add(at, add(mul(ax, a), add(mul(e1, x * c - y * s), mul(e2, x * s + y * c))));
        };
        let best = { th: 0, m: false, cost: Infinity };
        for (const m of [false, true]) for (let k = 0; k < 36; k++) {
          const th = (k * TAU) / 36;
          let cost = 0;
          for (const [r, b] of pairs) { const d = sub(turn(get(pos, r), th, m), get(pos, b)); cost += dot(d, d); }
          if (cost < best.cost - 1e-6) best = { th, m, cost };
        }
        if (best.th !== 0 || best.m) for (const id of leg.nodeIds) pos.set(turn(get(pos, id), best.th, best.m), id * 3);
      }
      moved.push(leg);
    }
    // the chains between the legs sit under the stitches worked into them
    for (const id of pi.baseChains ?? []) {
      const k = base.nodes.indexOf(id);
      const over = first.nodes.filter((_, j) => first.anchors[j] === k);
      pos.set(add(over.length ? centroid(pos, over) : A, mul(down, w * 0.6)), id * 3);
    }
    // stand on the legs side by side (left and right), not one behind the other
    if (legs.length === 2) {
      const d = sub(centroid(pos, legs[1].nodeIds), centroid(pos, legs[0].nodeIds));
      const phi = -Math.atan2(d[2], d[0]);
      const c = Math.cos(phi), sn = Math.sin(phi);
      const C = centroid(pos, pi.nodeIds);
      for (const q of [pi, ...legs]) for (const id of q.nodeIds) {
        const x = pos[id * 3] - C[0], z = pos[id * 3 + 2] - C[2];
        pos[id * 3] = C[0] + x * c - z * sn;
        pos[id * 3 + 2] = C[2] + x * sn + z * c;
        angle[id] += phi;
      }
    }
    return moved;
  }
  // grown from a round of a host: move this piece onto that round
  const host = parts[0];
  if (!host) return [];
  const ring = base.nodes.filter((id) => owner.get(id) === host);
  const hostStart = host.rows.find((r) => r.nodes.length)?.nodes ?? ring;
  const Hc = centroid(pos, ring);
  let grow = norm(sub(centroid(pos, hostStart), Hc));
  if (!isFinite(grow[0]) || Math.hypot(...grow) < 0.5) grow = [0, -1, 0];
  const own = pi.rows.filter((r) => r.nodes.length);
  const f0 = centroid(pos, own[0].nodes);
  const dirNow = norm(sub(centroid(pos, own[own.length - 1].nodes), f0));
  const rot = rotator(Math.hypot(...dirNow) > 0.5 ? dirNow : [0, -1, 0], grow);
  // spin so the first stitch sits by the stitch it was worked into
  const a0 = first.anchors[0] >= 0 ? base.nodes[first.anchors[0]] : ring[0];
  const proj = (v: V) => norm(sub(v, mul(grow, dot(v, grow))));
  const spin = rotator(proj(rot(sub(get(pos, first.nodes[0]), f0))), proj(sub(get(pos, a0), Hc)));
  for (const id of pi.nodeIds) pos.set(add(add(Hc, mul(grow, (g.nodes[first.nodes[0]].h || w) * 0.6)), spin(rot(sub(get(pos, id), f0)))), id * 3);
  // the first round must run round the same way as the stitches it is worked into, or every
  // stitch reaches across and the whole piece twists: mirror it if it runs the other way
  const wind = (ids: number[]) => {
    const c = centroid(pos, ids);
    return Math.sign(dot(grow, cross(sub(get(pos, ids[0]), c), sub(get(pos, ids[Math.max(1, Math.floor(ids.length / 4))]), c))));
  };
  const hostOrder = first.anchors.filter((a) => a >= 0).map((a) => base.nodes[a]);
  if (hostOrder.length >= 4 && wind(first.nodes) !== wind(hostOrder)) {
    const ax = norm(sub(get(pos, first.nodes[0]), add(Hc, mul(grow, dot(sub(get(pos, first.nodes[0]), Hc), grow)))));
    const m = norm(cross(grow, ax)); // mirror across the plane through the axis and the first stitch
    const c0 = Hc;
    for (const id of pi.nodeIds) {
      const v = sub(get(pos, id), c0);
      pos.set(add(c0, sub(v, mul(m, 2 * dot(v, m)))), id * 3);
    }
  }
  return [];
}

function attach(
  g: StitchGraph, p: Pattern, seam: Seam, host: PieceInstance, pi: PieceInstance, k: number, count: number,
  pos: Float32Array, angle: Float32Array, w: number, seamEdges: GEdge[], planes: Map<PieceInstance, V>, nearOf: () => number[] = () => [],
) {
  const hostRows = host.rows.filter((r) => r.row > 0);
  if (!hostRows.length) return;
  if (seam.hint === 'lid') { attachLid(g, host, pi, pos, seamEdges); return; }
  if (isHandle(pi) && seam.rowA === undefined) { attachHandle(g, host, pi, pos, seamEdges, seam.hint === 'back' ? FRONT + Math.PI : FRONT + Math.PI / 2); return; }
  if (seam.hint === 'wrap' && pi.piece.construction === 'rows') { attachWrap(g, host, pi, pos, w, seamEdges, seam.wrapAt ?? '', nearOf()); return; }
  if ((seam.hint === 'top' || seam.hint === 'default') && seam.rowA === undefined && count === 1 && isCap(host, pi)) { attachCap(g, host, pi, pos, seamEdges); return; }
  const up = isUpright(host);
  const nR = hostRows.length;
  let ra = seam.rowA, rb = seam.rowB;
  if (ra === undefined) {
    const top = seam.hint === 'top', bottom = seam.hint === 'bottom';
    if ((top && !up) || (bottom && up)) { ra = 2; rb = Math.max(3, Math.round(nR * 0.3)); }
    else if (top || bottom) { ra = nR - Math.max(2, Math.round(nR * 0.3)) + 1; rb = nR - 1; }
    else if (/\bneck\b|\bbelow (?:of )?the head\b|\bunder (?:the )?head\b/i.test(seam.text) && nR >= 8) {
      // the neck: the narrowest round between the body and the head
      const from = Math.round(nR * 0.2), to = Math.round(nR * 0.8);
      let best = from;
      for (let i = from; i <= to; i++) if (hostRows[i] && hostRows[i].nodes.length < hostRows[best].nodes.length) best = i;
      const neck = hostRows[best].row;
      // just under it, on the chest, clear of the head
      ra = up ? neck - 3 : neck + 2; rb = up ? neck - 2 : neck + 3;
    }
    else if (/\blower\b/i.test(seam.text)) { ra = Math.round(hostRows.length * 0.72); rb = Math.round(hostRows.length * 0.85); }
    else if (/\bupper\b/i.test(seam.text)) { ra = Math.round(hostRows.length * 0.25); rb = Math.round(hostRows.length * 0.4); }
    else { const mid = Math.round(hostRows.length * 0.5); ra = mid - 1; rb = mid + 1; }
  }
  const region = host.rows.filter((r) => r.row >= ra! && r.row <= (rb ?? ra!));
  if (!region.length) return;
  const nAround = region[Math.floor(region.length / 2)].nodes.length;
  // angle from hint words; several instances spread symmetrically around the front
  // arms hanging at the sides sit a little forward of the side seam, as they do on a doll
  const hangs = pi.piece.flatten && pi.stuffed === 0 && seam.hint === 'side' && pi.rows.length >= 6;
  const spread = seam.hint === 'side' || (seam.hint === 'default' && count > 1)
    ? Math.PI / 2 - (hangs ? 0.3 : 0)
    : seam.spacingSts ? ((seam.spacingSts / 2 + 2) * TAU) / nAround : Math.PI / 3;
  let th = seam.hint === 'back' ? FRONT + Math.PI : FRONT;
  if (count === 2) th += k === 0 ? -spread : spread;
  else if (count > 2) th += (k - (count - 1) / 2) * ((2 * spread) / (count - 1));
  else if (seam.hint === 'side') th += Math.PI / 2;

  const hostIds = region.flatMap((r) => r.nodes);
  // one piece on top (a hat, a bun): the very top, centred
  const topCentre = seam.hint === 'top' && count === 1 && seam.rowA === undefined;
  const topRows = up ? host.rows.slice(-2) : host.rows.filter((r) => r.row > 0).slice(0, 2);
  const near = topCentre ? topRows.flatMap((r) => r.nodes) : hostIds.filter((id) => Math.abs(Math.atan2(Math.sin(angle[id] - th), Math.cos(angle[id] - th))) < TAU / 10);
  let target = centroid(pos, near.length ? near : hostIds);
  const hostC = centroid(pos, host.nodeIds);
  let normal = topCentre ? [0, 1, 0] as V : norm([target[0] - hostC[0], 0, target[2] - hostC[2]]);
  // "sew the hat to the top side of the head": on top, tipped over to one side (the doll's left)
  if (topCentre && /\btop side\b|\bto (?:one|the) side\b|\btilt|\bat an angle\b/i.test(seam.text)) {
    const ordered = up ? [...hostRows].reverse() : hostRows;
    const headIds = ordered.slice(0, Math.max(3, Math.round(ordered.length * 0.3))).flatMap((r) => r.nodes).filter((id) => !g.nodes[id].virtual);
    const hc = centroid(pos, headIds);
    const tilt = norm([0.36, 0.93, 0]);
    let best = headIds[0], bd = -Infinity;
    for (const id of headIds) { const d = dot(sub(get(pos, id), hc), tilt); if (d > bd) { bd = d; best = id; } }
    target = get(pos, best);
    normal = tilt;
  }
  // something sewn on over a cap (a hat over the hair) sits on the cap, not under it
  const capped = p.seams.some((q) => q.host === host.piece.id && q.piece !== pi.piece.id && (q.hint === 'top' || q.hint === 'default') && q.rowA === undefined
    && g.instances.some((c) => c.piece.id === q.piece && isCap(host, c)));
  const overCap = capped && topCentre ? (g.nodes[host.nodeIds[host.nodeIds.length - 1]].h || w) * 1.2 : 0;
  // a flattened piece (e.g. ears) lies in the plane that contains its axis and faces the front
  const front: V = [0, 0, 1];
  const faceN = norm(sub(front, mul(normal, dot(front, normal))));
  planes.set(pi, Math.hypot(...sub(front, mul(normal, dot(front, normal)))) > 0.2 ? faceN : norm(cross(normal, [0, 1, 0])));
  if (seam.hint === 'top' && !topCentre) normal = norm(add(normal, [0, 1.1, 0]));
  if (seam.hint === 'bottom') normal = norm(add(normal, [0, -1.1, 0]));

  // a flat row-worked piece sewn onto the surface (a patch, a label, nori): lay it on, sew all round
  if (pi.piece.construction === 'rows' && !pi.piece.flatten && pi.stuffed === 0 && (/\bonto\b|\bon to\b|\bappliqu/i.test(seam.text) || (seam.hint === 'front' && pi.rows.filter((r) => r.row > 0).length <= 3))) {
    attachPatch(g, pi, host.nodeIds.filter((id) => !g.nodes[id].virtual), target, normal, pos, seamEdges);
    planes.set(pi, normal);
    return;
  }
  // the attached piece's open edge = its last row
  // a hat with a brim (a front-loop round, then the brim) is sewn on at the brim's fold, not its
  // outer edge
  let edgeRow = pi.rows.length - 1;
  for (let k = pi.rows.length - 1; k >= Math.max(1, pi.rows.length - 4); k--) {
    if (pi.rows[k].loop === 'FLO' && pi.rows[pi.rows.length - 1].nodes.length >= pi.rows[k].nodes.length * 1.4) { edgeRow = k; break; }
  }
  const edge = pi.rows[edgeRow]?.nodes ?? [];
  if (!edge.length) return;
  const eC = centroid(pos, edge);
  const pC = centroid(pos, pi.nodeIds);
  const opening = norm(sub(eC, pC)); // direction the opening faces
  // flattened pieces (e.g. ears): squash the cup in its local frame first
  // Fold each ring flat along x, keeping its length: a ring of radius R becomes two layers πR wide
  // (squashing z alone would shorten every ring and the extra yarn then crumples).
  if (pi.piece.flatten) {
    for (const id of pi.nodeIds) {
      const x = pos[id * 3], z = pos[id * 3 + 2];
      const R = Math.hypot(x, z), th = Math.atan2(z, x);
      pos[id * 3] = R * (Math.PI / 2 - Math.abs(th));
      pos[id * 3 + 2] = Math.sign(th) * Math.min(R, w * 0.3);
    }
  }
  // long flat flaps sewn to the sides (floppy dog ears) hang down along the head, flat side out
  const hang = pi.piece.flatten && pi.stuffed === 0 && seam.hint === 'side' && pi.rows.length >= 6;
  const dir = hang ? norm(add(mul(normal, 0.35), [0, -1, 0])) : normal;
  if (hang) planes.set(pi, normal);
  const rot0 = rotator(opening, mul(dir, -1));
  // roll around the attach direction so the flat side faces the front (or out, for a hanging flap)
  const face: V = hang ? normal : [0, 0, 1];
  const want = sub(face, mul(dir, dot(face, dir)));
  let rot = rot0;
  if (pi.piece.flatten && Math.hypot(...want) > 0.2) {
    const wantN = norm(want);
    const zNow = rot0([0, 0, 1]);
    const zProj = norm(sub(zNow, mul(dir, dot(zNow, dir))));
    const roll = rotator(zProj, wantN);
    rot = (v: V) => roll(rot0(v));
  }
  const radiusOut = w * 0.4 + overCap;
  const dest = add(target, mul(normal, radiusOut));
  for (const id of pi.nodeIds) {
    const v = rot(sub(get(pos, id), eC));
    pos.set(add(dest, v), id * 3);
  }
  // a hanging flap (an arm sewn on at the neck) rests against the host below it instead of
  // passing through it: push it out over the host's surface and keep it lying there
  if (hang) {
    const hostAll = host.nodeIds.filter((id) => !g.nodes[id].virtual);
    const lift = (g.nodes[edge[0]].h || w) * 0.7;
    for (const id of pi.nodeIds) {
      if (g.nodes[id].virtual) continue;
      const pv = get(pos, id);
      let b = hostAll[0], d2 = Infinity;
      for (const hid of hostAll) { const d = sub(get(pos, hid), pv); const q = dot(d, d); if (q < d2) { d2 = q; b = hid; } }
      const hb = get(pos, b);
      const out = norm([hb[0] - hostC[0], 0, hb[2] - hostC[2]]);
      const along = dot(sub(pv, hb), out);
      if (along < lift) pos.set(add(pv, mul(out, lift - along)), id * 3);
      if (!edge.includes(id)) seamEdges.push({ a: id, b, kind: 'seam', rest: 0, stick: Math.max(lift, along) });
    }
  }
  // seam edges: pair each edge stitch with its nearest host stitch in the region
  for (const id of edge) {
    const pv = get(pos, id);
    let best = hostIds[0], bd = Infinity;
    for (const hid of hostIds) {
      const d = sub(get(pos, hid), pv);
      const dd = dot(d, d);
      if (dd < bd) { bd = dd; best = hid; }
    }
    seamEdges.push({ a: id, b: best, kind: 'seam', rest: Math.min(Math.max(Math.sqrt(bd), w * 0.25), w * 0.8 + overCap) });
  }
}

/**
 * A chain strand laid over the host: it starts on its round (at the back, a little off centre),
 * runs up to the shoulder at the side (just under the neck: the narrowest round), and comes down
 * the front to the same round, where it is sewn. Every chain lies just on the surface.
 */
function attachStrap(
  g: StitchGraph, host: PieceInstance, pi: PieceInstance, k: number, count: number, row: number | undefined, back: boolean,
  pos: Float32Array, angle: Float32Array, w: number, seamEdges: GEdge[],
) {
  const chain = pi.rows[0]?.nodes ?? [];
  const rows = host.rows.filter((r) => r.row > 0 && r.nodes.length);
  if (chain.length < 2 || rows.length < 4) return;
  const up = isUpright(host);
  // the round it starts on, and the neck (narrowest round in the middle of the piece)
  let si = rows.findIndex((r) => r.row === row);
  const from = Math.round(rows.length * 0.2), to = Math.round(rows.length * 0.8);
  let ni = from;
  for (let i = from; i <= to; i++) if (rows[i].nodes.length < rows[ni].nodes.length) ni = i;
  if (si < 0) si = up ? Math.max(0, ni - 8) : Math.min(rows.length - 1, ni + 8);
  // the shoulder: a round or two on the body side of the neck
  const shi = Math.max(0, Math.min(rows.length - 1, si < ni ? ni - 1 : ni + 1));
  const side = count === 1 ? 1 : k === 0 ? -1 : 1;
  // round the body from the back (−z) past the side (±x) to the front (+z), as an angle from the
  // back: a little off centre where it starts, wider apart where it is sewn at the front
  const b0 = back ? 0.35 : Math.PI - 0.45, b2 = back ? Math.PI - 0.45 : 0.35;
  const lift = (g.nodes[chain[0]].h || w) * 0.9;
  const n = chain.length;
  chain.forEach((id, i) => {
    const t = i / (n - 1);
    const u = t < 0.5 ? t * 2 : (t - 0.5) * 2;
    const phi = t < 0.5 ? b0 + (Math.PI / 2 - b0) * u : Math.PI / 2 + (b2 - Math.PI / 2) * u;
    const dir: V = [side * Math.sin(phi), 0, -Math.cos(phi)];
    const ri = Math.round(t < 0.5 ? si + (shi - si) * u : shi + (si - shi) * u);
    const r = rows[Math.max(0, Math.min(rows.length - 1, ri))];
    const rc = centroid(pos, r.nodes);
    let b = r.nodes[0], bd = -Infinity;
    for (const q of r.nodes) { const d = dot(norm(sub(get(pos, q), rc)), dir); if (d > bd) { bd = d; b = q; } }
    const out = norm(sub(get(pos, b), rc));
    pos.set(add(get(pos, b), mul(out, lift)), id * 3);
    seamEdges.push({ a: id, b, kind: 'seam', rest: 0, stick: lift });
  });
}

/** An open round piece as wide as the host (hair, a cap): it goes over the host's top like a hat. */
function isCap(host: PieceInstance, pi: PieceInstance): boolean {
  const edge = pi.rows[pi.rows.length - 1]?.nodes.length ?? 0;
  const hostMax = Math.max(0, ...host.rows.map((r) => r.nodes.length));
  return pi.piece.construction !== 'rows' && pi.piece.finish !== 'closed' && pi.rows.length >= 6 && edge >= hostMax * 0.95 && pi.stuffed === 0;
}

/** A cap: rim on the host's top-most round that is about as wide as the cap's edge, crown up. */
function attachCap(g: StitchGraph, host: PieceInstance, pi: PieceInstance, pos: Float32Array, seamEdges: GEdge[]) {
  const rows = host.rows.filter((r) => r.row > 0 && r.nodes.length);
  const edge = pi.rows[pi.rows.length - 1]?.nodes.filter((id) => !g.nodes[id].virtual) ?? [];
  if (!rows.length || !edge.length) return;
  const order = isUpright(host) ? [...rows].reverse() : rows;
  const wide = Math.min(edge.length, Math.max(...rows.map((q) => q.nodes.length))) * 0.9;
  // the cap reaches as far down the host as it is deep: count its rounds down to its last full
  // round (short rows and a fringe after it hang lower still)
  const own = pi.rows.filter((r) => r.row > 0 && r.nodes.length);
  // the first round that falls short of the widest so far ends the full rounds
  const sts = (r: GRow) => r.nodes.filter((id) => g.nodes[id].type !== 'ch').length;
  let depth = own.length, widest = 0;
  for (let i = 0; i < own.length; i++) {
    if (sts(own[i]) < widest * 0.95) { depth = i; break; }
    widest = Math.max(widest, sts(own[i]));
  }
  const deep = order[Math.min(order.length - 1, Math.max(0, depth - 1))];
  let rimRow = (deep && deep.nodes.length >= wide ? deep : undefined) ?? order.find((r) => r.nodes.length >= wide) ?? order[Math.floor(order.length / 2)];
  // hair sits back on the head and leaves the face clear: keep the rim two rounds above the eyes
  const eyes = (host.piece.markers ?? []).filter((m) => m.kind === 'safety-eyes').map((m) => m.rowA);
  if (eyes.length) {
    const ri = order.indexOf(rimRow);
    const eyeI = order.findIndex((r) => eyes.includes(r.row));
    if (ri >= 0 && eyeI >= 0 && ri > eyeI - 3) {
      const k = Math.max(0, eyeI - 3);
      if (order[k].nodes.length >= wide) rimRow = order[k];
    }
  }
  const rim = rimRow.nodes;
  const rimC = centroid(pos, rim);
  const topC = centroid(pos, order[0].nodes);
  const axis = norm(sub(topC, rimC));
  const pC = centroid(pos, pi.nodeIds), eC = centroid(pos, edge);
  const rot = rotator(norm(sub(pC, eC)), axis);
  const e0 = rot(sub(get(pos, edge[0]), eC));
  const r0 = sub(get(pos, rim[0]), rimC);
  const proj = (v: V) => norm(sub(v, mul(axis, dot(v, axis))));
  const spin = rotator(proj(e0), proj(r0));
  for (const id of pi.nodeIds) pos.set(add(rimC, spin(rot(sub(get(pos, id), eC)))), id * 3);
  // lay each round of the cap over the matching round of the host, top down, so the crown sits on
  // the crown (not sunk inside it) and every stitch is stuck to the patch of host right under it
  {
    const liftL = (g.nodes[edge[0]].h || 1) * 1.2;
    // only for hair on a head with a face (eyes): tipped back by a few rounds
    const tiltRows = eyes.length ? 3 : 0;
    // where the strands hang from, as a fraction round the cap's rounds
    let strandAt: number | undefined;
    if (pi.strands?.length) {
      const row = own.find((q) => q.nodes.includes(pi.strands![0].base));
      if (row) {
        const idx = pi.strands.map((st) => row.nodes.indexOf(st.base)).filter((x) => x >= 0);
        if (idx.length) strandAt = (idx.reduce((a, b) => a + b, 0) / idx.length) / row.nodes.length;
      }
    }
    // the stitch each stitch is worked into (short rows can work into older rounds too)
    const mine = new Set(pi.nodeIds), into = new Map<number, number>();
    for (const e of g.edges) if (e.kind === 'into' && mine.has(e.b) && !into.has(e.b)) into.set(e.b, e.a);
    const last = Math.max(0, order.indexOf(rimRow));
    own.forEach((r, i) => {
      // past the full rounds (short rows at the back, a fringe): under the stitches worked into
      if (i >= depth && i > 0) {
        let at = get(pos, own[i - 1].nodes[own[i - 1].nodes.length - 1]); // chains start where the yarn is
        r.nodes.forEach((id) => {
          const t = into.get(id);
          if (t !== undefined) at = get(pos, t);
          pos.set(add(at, mul(axis, -(g.nodes[id].h || liftL) * 0.8)), id * 3);
        });
        return;
      }
      const base = Math.min(i, last);
      const hr = order[base].nodes;
      const hc0 = centroid(pos, hr);
      // strands hang at the front ("start making the hair strands at the front"): turn the cap so
      // the stitches they hang from face forward
      let off = 0;
      if (strandAt !== undefined) {
        let fi = 0, fd = -Infinity;
        hr.forEach((q, qi) => { const d = dot(norm(sub(get(pos, q), hc0)), [0, 0, 1]); if (d > fd) { fd = d; fi = qi; } });
        off = fi / hr.length - strandAt;
      }
      r.nodes.forEach((id, j) => {
        const f = (((j / r.nodes.length + off) % 1) + 1) % 1;
        let hp = get(pos, hr[Math.floor(f * hr.length) % hr.length]);
        let hc = hc0;
        // hair sits back on the head: higher over the forehead, lower at the back, more so
        // towards the rim (none at the crown)
        if (tiltRows > 0 && last > 0) {
          const az = norm(sub(sub(hp, hc0), mul(axis, dot(sub(hp, hc0), axis))));
          const k = Math.max(0, Math.min(order.length - 1, Math.round(base - tiltRows * az[2] * (base / last))));
          if (k !== base) {
            const kr = order[k].nodes;
            hc = centroid(pos, kr);
            let best = kr[0], bd = -Infinity;
            for (const q of kr) { const d = dot(norm(sub(get(pos, q), hc)), az); if (d > bd) { bd = d; best = q; } }
            hp = get(pos, best);
          }
        }
        const out = sub(hp, hc);
        const o = norm(Math.hypot(...out) > 1e-6 ? add(out, mul(axis, Math.hypot(...out) * 0.3)) : axis);
        pos.set(add(hp, mul(o, liftL * (1 + Math.max(0, i - last) * 0.5))), id * 3);
      });
    });
    if (pi.centre !== undefined) pos.set(add(topC, mul(axis, liftL)), pi.centre * 3);
  }
  // no seam to the rim: the cap is held stitch by stitch on the host below (a seam would let a
  // cap that sits a little differently haul the host's rim up or down, stretching a neck)
  // the cap lies on the host: every stitch rides just outside the surface under it
  const hostIds = host.nodeIds.filter((id) => !g.nodes[id].virtual);
  const lift = (g.nodes[edge[0]].h || 1) * 1.2;
  for (const id of pi.nodeIds) {
    if (g.nodes[id].virtual) continue;
    const pv = get(pos, id);
    let b = hostIds[0], d2 = Infinity;
    for (const hid of hostIds) { const d = sub(get(pos, hid), pv); const q = dot(d, d); if (q < d2) { d2 = q; b = hid; } }
    seamEdges.push({ a: id, b, kind: 'seam', rest: 0, stick: lift });
  }
}

/**
 * A strip wrapped round the host (a collar round the shoulders, a tiara round a bun): a ring at the
 * host's round named by the text, drooping a little where it is wider than the host.
 */
function attachWrap(g: StitchGraph, host: PieceInstance, pi: PieceInstance, pos: Float32Array, w: number, seamEdges: GEdge[], at: string, near: number[]) {
  const rows = host.rows.filter((r) => r.row > 0 && r.nodes.length);
  const strip = pi.rows.filter((r) => r.nodes.length);
  if (!rows.length || !strip.length) return;
  const counts = rows.map((r) => r.nodes.length);
  let k: number;
  if (/neck|shoulder|collar/.test(at)) {
    // the neck: the narrowest round between the body and the head
    const lo = Math.floor(rows.length * 0.2), hi = Math.ceil(rows.length * 0.85);
    let neck = lo;
    for (let i = lo; i < hi; i++) if (counts[i] < counts[neck]) neck = i;
    k = /shoulder/.test(at) ? Math.max(0, Math.min(rows.length - 1, neck + (isUpright(host) ? -2 : 2))) : neck;
  } else {
    k = counts.indexOf(Math.max(...counts));
  }
  const ring = rows[k].nodes;
  const C = centroid(pos, ring);
  const hostR = ring.reduce((a, id) => a + Math.hypot(pos[id * 3] - C[0], pos[id * 3 + 2] - C[2]), 0) / ring.length;
  const ids = strip.flatMap((r) => r.nodes);
  let maxy = -Infinity;
  for (const id of ids) maxy = Math.max(maxy, pos[id * 3 + 1]);
  // the first row (a foundation chain) goes snugly round the host, keeping its length; the rows
  // worked from it hang from it, further out and lower
  const chain = strip[0].nodes;
  const r0 = hostR + w * 0.5;
  const x0 = pos[chain[0] * 3];
  const sgn = Math.sign(pos[chain[chain.length - 1] * 3] - x0) || 1;
  const into = new Map<number, number>();
  const mine = new Set(ids);
  for (const e of g.edges) if (e.kind === 'into' && mine.has(e.b) && mine.has(e.a) && !into.has(e.b)) into.set(e.b, e.a);
  // only part of the chain worked (a veil from the end of its chain): that part hangs at the back
  const chainSet = new Set(chain);
  const worked = (strip[1]?.nodes ?? []).map((id) => into.get(id)).filter((id): id is number => id !== undefined && chainSet.has(id));
  let a0 = FRONT;
  if (worked.length && new Set(worked).size < chain.length * 0.6) {
    const mid = worked.reduce((t, id) => t + sgn * (pos[id * 3] - x0), 0) / worked.length;
    a0 = FRONT + Math.PI - mid / r0;
  }
  const th = new Map<number, number>();
  const flat = new Map(ids.map((id) => [id, get(pos, id)] as const));
  for (const id of chain) th.set(id, a0 + (sgn * (flat.get(id)![0] - x0)) / r0);
  // each later row is centred on the stitches it was worked into, keeping its own width
  for (const r of strip.slice(1)) {
    const out = r.nodes.map((id) => (maxy - flat.get(id)![1]) * 0.6);
    const rr = r0 + out.reduce((a, b) => a + b, 0) / Math.max(1, out.length);
    const tg = r.nodes.map((id) => th.get(into.get(id) ?? -1)).filter((t): t is number => t !== undefined);
    const xm = r.nodes.reduce((a, id) => a + flat.get(id)![0], 0) / r.nodes.length;
    const tm = tg.length ? tg.reduce((a, b) => a + b, 0) / tg.length : a0;
    for (const id of r.nodes) th.set(id, tm + (sgn * (flat.get(id)![0] - xm)) / rr);
  }
  for (const id of ids) {
    const out = (maxy - flat.get(id)![1]) * 0.6;
    const rr = r0 + out, t = th.get(id)!;
    pos.set([C[0] + rr * Math.cos(t), C[1] - out * 0.8, C[2] + rr * Math.sin(t)], id * 3);
  }
  const hostIds = rows.slice(Math.max(0, k - 2), k + 3).flatMap((q) => q.nodes);
  for (const id of chain) {
    const pv = get(pos, id);
    let b = hostIds[0], d2 = Infinity;
    for (const hid of hostIds) { const d = sub(get(pos, hid), pv); const q = dot(d, d); if (q < d2) { d2 = q; b = hid; } }
    seamEdges.push({ a: id, b, kind: 'seam', rest: w * 0.5 });
  }
  // the rest hangs free but can't pass through the host or what it sits on (the bun, head and
  // hair under a veil): a one-sided clearance from the nearest stitch (a negative stick)
  const others = near.length ? near : host.nodeIds;
  // start it outside them too, or the clearance would hold it on the wrong side
  const otherSet = new Set(others);
  const cOf = new Map<number, V>();
  for (const q of g.instances) if (q.nodeIds.some((id) => otherSet.has(id))) { const c = centroid(pos, q.nodeIds); for (const id of q.nodeIds) cOf.set(id, c); }
  for (const r of strip.slice(1)) for (const id of r.nodes) {
    const pv = get(pos, id);
    let b = others[0], d2 = Infinity;
    for (const hid of others) { const d = sub(get(pos, hid), pv); const q = dot(d, d); if (q < d2) { d2 = q; b = hid; } }
    const off = (g.nodes[b].h || w) * 0.8;
    const nb = norm(sub(get(pos, b), cOf.get(b)!));
    const d = dot(sub(pv, get(pos, b)), nb);
    if (d < off) pos.set(add(pv, mul(nb, off - d)), id * 3);
    seamEdges.push({ a: id, b, kind: 'seam', rest: 0, stick: -off });
  }
}

/**
 * A lid: the piece's last round is joined stitch for stitch to the host's open last round. Lay the
 * piece flat across the opening (its right side facing out) and pair the two rounds in order.
 */
function attachLid(g: StitchGraph, host: PieceInstance, pi: PieceInstance, pos: Float32Array, seamEdges: GEdge[]) {
  const rim = host.rows[host.rows.length - 1]?.nodes.filter((id) => !g.nodes[id].virtual) ?? [];
  const edge = pi.rows[pi.rows.length - 1]?.nodes.filter((id) => !g.nodes[id].virtual) ?? [];
  if (!rim.length || !edge.length) return;
  const rimC = centroid(pos, rim);
  const axis = norm(sub(rimC, centroid(pos, host.nodeIds))); // out of the opening
  const pC = centroid(pos, pi.nodeIds), eC = centroid(pos, edge);
  // the lid's centre should sit a little out of the opening; its edge on the rim
  const rot = rotator(norm(sub(pC, eC)), axis);
  const proj = (v: V) => norm(sub(v, mul(axis, dot(v, axis))));
  // a lid that is a head (it carries a face, a nose …) keeps its front facing the front;
  // otherwise turn it so its first stitch lands next to the rim's first stitch
  const front = rot([0, 0, 1]);
  const keepFront = Math.abs(dot(norm(front), axis)) < 0.9 && (pi.piece.markers.length > 0 || pi.rows.length > 12);
  const spin = keepFront ? rotator(proj(front), proj([0, 0, 1])) : rotator(proj(rot(sub(get(pos, edge[0]), eC))), proj(sub(get(pos, rim[0]), rimC)));
  for (const id of pi.nodeIds) pos.set(add(rimC, spin(rot(sub(get(pos, id), eC)))), id * 3);
  const n = Math.min(rim.length, edge.length);
  // both rounds must run the same way around the opening, or the join twists
  const wind = (ids: number[], c: V) => Math.sign(dot(axis, cross(sub(get(pos, ids[0]), c), sub(get(pos, ids[Math.floor(ids.length / 4)]), c))));
  const same = wind(edge, rimC) === wind(rim, rimC);
  // start the pairing at the rim stitch nearest the lid's first stitch
  let o = 0, od = Infinity;
  rim.forEach((id, k) => { const d = sub(get(pos, id), get(pos, edge[0])); const q = dot(d, d); if (q < od) { od = q; o = k; } });
  const oi = Math.round((o * n) / rim.length);
  for (let i = 0; i < n; i++) {
    const j = ((same ? oi + i : oi - i) % n + n) % n;
    const a = edge[Math.floor((i * edge.length) / n)], b = rim[Math.floor((j * rim.length) / n)];
    const d = sub(get(pos, a), get(pos, b));
    seamEdges.push({ a, b, kind: 'seam', rest: Math.min(Math.sqrt(dot(d, d)), (g.nodes[b].w || 1) * 0.3) });
  }
}

/** A thin unstuffed tube named like a handle or strap: both of its ends get sewn on. */
function isHandle(pi: PieceInstance): boolean {
  const counts = pi.rows.map((r) => r.nodes.length);
  return /handle|strap/i.test(pi.piece.name) && pi.rows.length >= 4 && Math.max(...counts) <= 8 && pi.stuffed === 0;
}

/**
 * A handle: bend the tube into a half circle standing out from the host's side (at angle th),
 * centred on the host's middle row, and sew both ends on.
 */
function attachHandle(g: StitchGraph, host: PieceInstance, pi: PieceInstance, pos: Float32Array, seamEdges: GEdge[], th: number) {
  const rows = host.rows.filter((r) => r.row > 0 && r.nodes.length);
  const tube = pi.rows.filter((r) => r.nodes.length);
  if (rows.length < 2 || tube.length < 2) return;
  const up = norm(sub(centroid(pos, rows[rows.length - 1].nodes), centroid(pos, rows[0].nodes)));
  const hostC = centroid(pos, host.nodeIds);
  const mid = rows[Math.floor(rows.length * 0.55)].nodes;
  // the stitch of the middle row closest to the wanted side
  let best = mid[0], bd = Infinity;
  const want: V = [Math.cos(th), 0, Math.sin(th)];
  for (const id of mid) {
    const v = sub(get(pos, id), hostC);
    const dd = -dot(norm(sub(v, mul(up, dot(v, up)))), want);
    if (dd < bd) { bd = dd; best = id; }
  }
  const M = get(pos, best);
  const out = norm(sub(sub(M, hostC), mul(up, dot(sub(M, hostC), up))));
  const side = norm(cross(up, out));
  let L = 0;
  const hs = tube.map((r) => r.nodes.reduce((a, id) => a + g.nodes[id].h, 0) / r.nodes.length);
  for (const h of hs) L += h;
  const R = L / Math.PI;
  let acc = 0;
  tube.forEach((r, k) => {
    acc += hs[k] * (k === 0 ? 0.5 : 1);
    const a = Math.PI * Math.min(1, acc / L);
    const c = add(M, add(mul(up, R * Math.cos(a)), mul(out, R * Math.sin(a) * 0.8)));
    const t = norm(add(mul(up, -Math.sin(a)), mul(out, Math.cos(a) * 0.8)));
    const nrm = norm(cross(t, side));
    const rr = Math.max(0.5, r.nodes.reduce((s, id) => s + g.nodes[id].w, 0) / (2 * Math.PI));
    r.nodes.forEach((id, j) => {
      const ph = (2 * Math.PI * j) / r.nodes.length;
      pos.set(add(c, add(mul(nrm, rr * Math.cos(ph)), mul(side, rr * Math.sin(ph)))), id * 3);
    });
  });
  if (pi.centre !== undefined) pos.set(centroid(pos, tube[0].nodes), pi.centre * 3);
  // sew each end ring to the nearest host stitches
  const hostIds = host.nodeIds.filter((id) => !g.nodes[id].virtual);
  for (const end of [tube[0].nodes, tube[tube.length - 1].nodes]) {
    for (const id of end) {
      const pv = get(pos, id);
      let b = hostIds[0], d2 = Infinity;
      for (const hid of hostIds) { const d = sub(get(pos, hid), pv); const q = dot(d, d); if (q < d2) { d2 = q; b = hid; } }
      seamEdges.push({ a: id, b, kind: 'seam', rest: Math.min(Math.max(Math.sqrt(d2), g.nodes[id].w * 0.25), g.nodes[id].w * 0.8) });
    }
  }
}

/** Lay a flat piece on the host's surface at target (facing out along normal) and sew its border down. */
function attachPatch(g: StitchGraph, pi: PieceInstance, hostIds: number[], target: V, normal: V, pos: Float32Array, seamEdges: GEdge[]) {
  const ids = pi.nodeIds.filter((id) => !g.nodes[id].virtual);
  if (!ids.length) return;
  const c = centroid(pos, ids);
  const upT = sub([0, 1, 0], mul(normal, normal[1]));
  const tU = Math.hypot(...upT) > 0.2 ? norm(upT) : norm(cross(normal, [1, 0, 0]));
  const tS = norm(cross(tU, normal));
  const lift = (g.nodes[ids[0]].h || 1) * 0.9; // clear of the host's stitch relief
  for (const id of ids) {
    const l = sub(get(pos, id), c); // rows are seeded flat in x (across) / y (rows)
    pos.set(add(add(target, mul(normal, lift)), add(mul(tS, l[0]), mul(tU, l[1]))), id * 3);
  }
  const rows = pi.rows.filter((r) => r.nodes.length);
  const border = new Set<number>();
  for (const r of rows) { border.add(r.nodes[0]); border.add(r.nodes[r.nodes.length - 1]); }
  for (const id of [...rows[0].nodes, ...rows[rows.length - 1].nodes]) border.add(id);
  // the host surface may bulge under the patch: sew every border stitch to the host stitch below it
  for (const id of border) {
    const pv = sub(get(pos, id), mul(normal, lift));
    let b = hostIds[0], d2 = Infinity;
    for (const hid of hostIds) { const d = sub(get(pos, hid), pv); const q = dot(d, d); if (q < d2) { d2 = q; b = hid; } }
    seamEdges.push({ a: id, b, kind: 'seam', rest: (g.nodes[id].h || 1) * 0.5 });
  }
  // every stitch of the patch rides on the surface under it (stuffing can't push through it)
  for (const id of ids) {
    const pv = sub(get(pos, id), mul(normal, lift));
    let b = hostIds[0], d2 = Infinity;
    for (const hid of hostIds) { const d = sub(get(pos, hid), pv); const q = dot(d, d); if (q < d2) { d2 = q; b = hid; } }
    seamEdges.push({ a: id, b, kind: 'seam', rest: 0, stick: lift });
  }
}
