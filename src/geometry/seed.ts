import type { Pattern, Seam } from '../model/types';
import type { GEdge, PieceInstance, StitchGraph } from '../graph/build';

export interface MarkerAnchor {
  kind: 'safety-eyes' | 'embroidery';
  a: number; // node ids; position = midpoint
  b: number;
  sizeMm: number;
  line: number;
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
      for (const side of [-1, 1]) {
        const th = FRONT + side * half;
        out.push({
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
      attach(g, p, seam, host, pi, k, insts.length, pos, angle, w, seamEdges, planes);
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
  return [];
}

function attach(
  g: StitchGraph, p: Pattern, seam: Seam, host: PieceInstance, pi: PieceInstance, k: number, count: number,
  pos: Float32Array, angle: Float32Array, w: number, seamEdges: GEdge[], planes: Map<PieceInstance, V>,
) {
  const hostRows = host.rows.filter((r) => r.row > 0);
  if (!hostRows.length) return;
  if (seam.hint === 'lid') { attachLid(g, host, pi, pos, seamEdges); return; }
  if (isHandle(pi) && seam.rowA === undefined) { attachHandle(g, host, pi, pos, seamEdges, seam.hint === 'back' ? FRONT + Math.PI : FRONT + Math.PI / 2); return; }
  if (seam.hint === 'wrap' && pi.piece.construction === 'rows') { attachWrap(g, host, pi, pos, w, seamEdges, seam.wrapAt ?? ''); return; }
  if ((seam.hint === 'top' || seam.hint === 'default') && seam.rowA === undefined && count === 1 && isCap(host, pi)) { attachCap(g, host, pi, pos, seamEdges); return; }
  const up = isUpright(host);
  const nR = hostRows.length;
  let ra = seam.rowA, rb = seam.rowB;
  if (ra === undefined) {
    const top = seam.hint === 'top', bottom = seam.hint === 'bottom';
    if ((top && !up) || (bottom && up)) { ra = 2; rb = Math.max(3, Math.round(nR * 0.3)); }
    else if (top || bottom) { ra = nR - Math.max(2, Math.round(nR * 0.3)) + 1; rb = nR - 1; }
    else if (/\blower\b/i.test(seam.text)) { ra = Math.round(hostRows.length * 0.72); rb = Math.round(hostRows.length * 0.85); }
    else if (/\bupper\b/i.test(seam.text)) { ra = Math.round(hostRows.length * 0.25); rb = Math.round(hostRows.length * 0.4); }
    else { const mid = Math.round(hostRows.length * 0.5); ra = mid - 1; rb = mid + 1; }
  }
  const region = host.rows.filter((r) => r.row >= ra! && r.row <= (rb ?? ra!));
  if (!region.length) return;
  const nAround = region[Math.floor(region.length / 2)].nodes.length;
  // angle from hint words; several instances spread symmetrically around the front
  const spread = seam.hint === 'side' || (seam.hint === 'default' && count > 1)
    ? Math.PI / 2
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
  const target = centroid(pos, near.length ? near : hostIds);
  const hostC = centroid(pos, host.nodeIds);
  let normal = topCentre ? [0, 1, 0] as V : norm([target[0] - hostC[0], 0, target[2] - hostC[2]]);
  // a flattened piece (e.g. ears) lies in the plane that contains its axis and faces the front
  const front: V = [0, 0, 1];
  const faceN = norm(sub(front, mul(normal, dot(front, normal))));
  planes.set(pi, Math.hypot(...sub(front, mul(normal, dot(front, normal)))) > 0.2 ? faceN : norm(cross(normal, [0, 1, 0])));
  if (seam.hint === 'top' && !topCentre) normal = norm(add(normal, [0, 1.1, 0]));
  if (seam.hint === 'bottom') normal = norm(add(normal, [0, -1.1, 0]));

  // a flat row-worked piece sewn onto the surface (a patch, a label, nori): lay it on, sew all round
  if (pi.piece.construction === 'rows' && !pi.piece.flatten && pi.stuffed === 0 && /\bonto\b|\bon to\b|\bappliqu/i.test(seam.text)) {
    attachPatch(g, pi, host.nodeIds.filter((id) => !g.nodes[id].virtual), target, normal, pos, seamEdges);
    planes.set(pi, normal);
    return;
  }
  // the attached piece's open edge = its last row
  const edge = pi.rows[pi.rows.length - 1]?.nodes ?? [];
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
  const radiusOut = w * 0.4;
  const dest = add(target, mul(normal, radiusOut));
  for (const id of pi.nodeIds) {
    const v = rot(sub(get(pos, id), eC));
    pos.set(add(dest, v), id * 3);
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
    seamEdges.push({ a: id, b: best, kind: 'seam', rest: Math.min(Math.max(Math.sqrt(bd), w * 0.25), w * 0.8) });
  }
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
  const rimRow = order.find((r) => r.nodes.length >= Math.min(edge.length, Math.max(...rows.map((q) => q.nodes.length))) * 0.9) ?? order[Math.floor(order.length / 2)];
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
  const n = Math.min(rim.length, edge.length);
  const wind = (ids: number[], c: V) => Math.sign(dot(axis, cross(sub(get(pos, ids[0]), c), sub(get(pos, ids[Math.floor(ids.length / 4)]), c))));
  const same = wind(edge, rimC) === wind(rim, rimC);
  for (let i = 0; i < n; i++) {
    const j = same ? i : (n - i) % n;
    const a = edge[Math.floor((i * edge.length) / n)], b = rim[Math.floor((j * rim.length) / n)];
    seamEdges.push({ a, b, kind: 'seam', rest: (g.nodes[b].w || 1) * 0.3 });
  }
  // the cap lies on the host: every stitch rides just outside the surface under it
  const hostIds = host.nodeIds.filter((id) => !g.nodes[id].virtual);
  const lift = (g.nodes[edge[0]].h || 1) * 0.6;
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
function attachWrap(g: StitchGraph, host: PieceInstance, pi: PieceInstance, pos: Float32Array, w: number, seamEdges: GEdge[], at: string) {
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
  let minx = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const id of ids) { minx = Math.min(minx, pos[id * 3]); maxx = Math.max(maxx, pos[id * 3]); maxy = Math.max(maxy, pos[id * 3 + 1]); }
  const L = Math.max(maxx - minx, w);
  const r = Math.max(L / TAU, hostR + w * 0.6);
  const droop = (r - hostR) * 0.6;
  for (const id of ids) {
    const th = FRONT + (TAU * (pos[id * 3] - minx)) / L;
    const out = (maxy - pos[id * 3 + 1]) * 0.6; // later rows lie further out and lower
    const rr = r + out;
    pos.set([C[0] + rr * Math.cos(th), C[1] - droop - out * 0.8, C[2] + rr * Math.sin(th)], id * 3);
  }
  const hostIds = rows.slice(Math.max(0, k - 2), k + 3).flatMap((q) => q.nodes);
  for (const id of strip[0].nodes) {
    const pv = get(pos, id);
    let b = hostIds[0], d2 = Infinity;
    for (const hid of hostIds) { const d = sub(get(pos, hid), pv); const q = dot(d, d); if (q < d2) { d2 = q; b = hid; } }
    seamEdges.push({ a: id, b, kind: 'seam', rest: Math.max(Math.sqrt(d2), w * 0.3) });
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
