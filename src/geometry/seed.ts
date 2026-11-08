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
  }
  const markers = placeMarkers(g, p, angle);
  const planeNormals = new Map<PieceInstance, V>();
  for (const pi of g.instances) planeNormals.set(pi, pi.piece.construction === 'rows' ? [0, 0, 1] : [0, 1, 0]);
  const seamEdges = placePieces(g, p, pos, angle, w, planeNormals);
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
      const c = centroid(pos, host.nodeIds);
      for (const id of host.nodeIds) { pos[id * 3 + 1] = 2 * c[1] - pos[id * 3 + 1]; pos[id * 3 + 2] = 2 * c[2] - pos[id * 3 + 2]; }
    }
  }
  for (const seam of p.seams) {
    const host = byPiece(seam.host)[0];
    if (!host) continue;
    placed.add(host);
    const insts = byPiece(seam.piece);
    insts.forEach((pi, k) => {
      if (placed.has(pi)) return;
      attach(g, p, seam, host, pi, k, insts.length, pos, angle, w, seamEdges, planes);
      placed.add(pi);
    });
  }
  // lay out everything not attached side by side along x
  let x = 0;
  const roots = g.instances.filter((pi) => !p.seams.some((s) => s.piece === pi.piece.id));
  for (const pi of roots) {
    const ids = attachedClosure(g, p, pi);
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

function attachedClosure(g: StitchGraph, p: Pattern, root: PieceInstance): number[] {
  const ids = [...root.nodeIds];
  const attached = p.seams.filter((s) => s.host === root.piece.id).map((s) => s.piece);
  for (const pid of new Set(attached)) for (const pi of g.instances.filter((i) => i.piece.id === pid)) ids.push(...pi.nodeIds);
  return ids;
}

function attach(
  g: StitchGraph, p: Pattern, seam: Seam, host: PieceInstance, pi: PieceInstance, k: number, count: number,
  pos: Float32Array, angle: Float32Array, w: number, seamEdges: GEdge[], planes: Map<PieceInstance, V>,
) {
  const hostRows = host.rows.filter((r) => r.row > 0);
  if (!hostRows.length) return;
  if (seam.hint === 'lid') { attachLid(g, host, pi, pos, seamEdges); return; }
  if (isHandle(pi) && seam.rowA === undefined) { attachHandle(g, host, pi, pos, seamEdges, seam.hint === 'back' ? FRONT + Math.PI : FRONT + Math.PI / 2); return; }
  let ra = seam.rowA, rb = seam.rowB;
  if (ra === undefined) {
    if (seam.hint === 'top') { ra = 2; rb = Math.max(3, Math.round(hostRows.length * 0.3)); }
    else if (seam.hint === 'bottom') { ra = hostRows.length - 2; rb = hostRows.length; }
    else if (/\blower\b/i.test(seam.text)) { ra = Math.round(hostRows.length * 0.6); rb = Math.round(hostRows.length * 0.75); }
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
  const near = hostIds.filter((id) => Math.abs(Math.atan2(Math.sin(angle[id] - th), Math.cos(angle[id] - th))) < TAU / 10);
  const target = centroid(pos, near.length ? near : hostIds);
  const hostC = centroid(pos, host.nodeIds);
  let normal = norm([target[0] - hostC[0], 0, target[2] - hostC[2]]);
  // a flattened piece (e.g. ears) lies in the plane that contains its axis and faces the front
  const front: V = [0, 0, 1];
  const faceN = norm(sub(front, mul(normal, dot(front, normal))));
  planes.set(pi, Math.hypot(...sub(front, mul(normal, dot(front, normal)))) > 0.2 ? faceN : norm(cross(normal, [0, 1, 0])));
  if (seam.hint === 'top') normal = norm(add(normal, [0, 1.1, 0]));
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
  // turn the lid so its first stitch lands next to the rim's first stitch
  const e0 = rot(sub(get(pos, edge[0]), eC));
  const r0 = sub(get(pos, rim[0]), rimC);
  const proj = (v: V) => norm(sub(v, mul(axis, dot(v, axis))));
  const spin = rotator(proj(e0), proj(r0));
  for (const id of pi.nodeIds) pos.set(add(rimC, spin(rot(sub(get(pos, id), eC)))), id * 3);
  const n = Math.min(rim.length, edge.length);
  // both rounds must run the same way around the opening, or the join twists
  const wind = (ids: number[], c: V) => Math.sign(dot(axis, cross(sub(get(pos, ids[0]), c), sub(get(pos, ids[Math.floor(ids.length / 4)]), c))));
  const same = wind(edge, rimC) === wind(rim, rimC);
  for (let i = 0; i < n; i++) {
    const j = same ? i : (n - i) % n;
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
