import type { Pattern } from '../model/types';
import { buildGraph, type StitchGraph } from '../graph/build';
import { computeSizing, type Sizing, type UserMaterials } from './sizing';
import { isUpright, seed, type MarkerAnchor } from './seed';
import { triangulate } from './mesh';
import type { SolverInput } from './solver';

export interface Model {
  pattern: Pattern;
  sizing: Sizing;
  graph: StitchGraph;
  tris: Uint32Array;
  triPiece: Uint16Array;
  markers: MarkerAnchor[];
  solverInput: SolverInput;
}

const STIFF = { yarn: 1, into: 1, ring: 0.6, join: 0.7, seam: 0.5 } as const;
/** How hard stuffed yarn resists stretching (1 = rigid). Lower = looser yarn, rounder stuffed shapes. */
const STRETCH_GIVE = 0.3;

/**
 * A motif with the same number of corners (3 to 8) on every round that has any (a granny square, a
 * hexagon) is blocked to that polygon, not to a circle.
 */
function motifCorners(rows: { corners?: number[]; anchors: number[]; nodes: number[] }[]): (number[] | undefined)[] | undefined {
  const ks = new Set(rows.filter((r) => r.corners).map((r) => r.corners!.length));
  if (ks.size !== 1) return undefined;
  const k = [...ks][0];
  if (k < 3 || k > 8) return undefined;
  const out: (number[] | undefined)[] = rows.map((r) => r.corners);
  // rounds without corner groups of their own (the first round into the ring, a plain border) take
  // their corners from the round worked into them, or from the round they are worked into
  for (let pass = 0; pass < rows.length; pass++) {
    let changed = false;
    for (let i = 0; i < rows.length; i++) {
      if (out[i]) continue;
      const above = out[i + 1];
      if (above) {
        const cs = [...new Set(above.map((c) => rows[i + 1].anchors[c]).filter((a) => a >= 0))].sort((a, b) => a - b);
        if (cs.length === k) { out[i] = cs; changed = true; continue; }
      }
      const below = out[i - 1];
      if (below) {
        const A = rows[i].anchors;
        const cs = below.map((c) => { let best = 0, d = Infinity; A.forEach((a, j) => { if (a >= 0 && Math.abs(a - c) < d) { d = Math.abs(a - c); best = j; } }); return best; });
        if (new Set(cs).size === k) { out[i] = cs.sort((a, b) => a - b); changed = true; }
      }
    }
    if (!changed) break;
  }
  return out;
}

/** Parse result → sized stitch graph → seeded positions → solver input. */
export function buildModel(pattern: Pattern, user: UserMaterials, warm?: Map<string, [number, number, number]>): Model {
  const sizing = computeSizing(pattern, user);
  const graph = buildGraph(pattern, sizing);
  const s = seed(graph, pattern, sizing.w);
  const { tris, triPiece } = triangulate(graph);

  // warm start: reuse solved positions for stitches that did not change
  if (warm && warm.size) {
    let hits = 0;
    const offs: [number, number, number][] = [];
    graph.nodes.forEach((n) => {
      const q = warm.get(n.key);
      if (q) { hits++; offs.push([q[0] - s.pos[n.id * 3], q[1] - s.pos[n.id * 3 + 1], q[2] - s.pos[n.id * 3 + 2]]); }
    });
    if (hits > graph.nodes.length * 0.3) {
      graph.nodes.forEach((n) => {
        const q = warm.get(n.key);
        if (q) s.pos.set(q, n.id * 3);
      });
    }
  }

  const all = [...graph.edges, ...s.seamEdges.filter((e) => e.stick === undefined)];
  const sticks = s.seamEdges.filter((e) => e.stick !== undefined);
  const stick = new Float32Array(sticks.length * 3);
  sticks.forEach((e, i) => stick.set([e.a, e.b, e.stick!], i * 3));
  const stuffedNode = new Uint8Array(graph.nodes.length);
  for (const pi of graph.instances) if (pi.stuffed > 0) for (const id of pi.nodeIds) stuffedNode[id] = 1;
  // the open edge of a stuffed piece is sewn to something (a head, a lid): it keeps its length
  for (const pi of graph.instances) {
    if (pi.stuffed > 0 && pi.piece.finish !== 'closed') for (const id of pi.rows[pi.rows.length - 1]?.nodes ?? []) stuffedNode[id] = 0;
  }
  const edges = new Float32Array(all.length * 5);
  const give = new Float32Array(all.length);
  all.forEach((e, i) => {
    // stuffed fabric: the yarn gives a little under pressure instead of staying fully stretched
    give[i] = (e.kind === 'yarn' || e.kind === 'into') && stuffedNode[e.a] && stuffedNode[e.b] ? STRETCH_GIVE : 1;
    const slack = (e.kind === 'yarn' || e.kind === 'into') && stuffedNode[e.a] && stuffedNode[e.b] ? 0.7 : 1;
    edges.set([e.a, e.b, e.rest, STIFF[e.kind], slack], i * 5);
  });
  const fixed = new Uint8Array(graph.nodes.length);
  const wrapped = (pi: (typeof graph.instances)[number]) => pi.stuffed === 0 && pi.piece.construction === 'rows' && pattern.seams.some((q) => q.piece === pi.piece.id && q.hint === 'wrap');
  // a hat's brim: rounds after a front-loop round, the last much wider than the fold
  const brimOf = (pi: (typeof graph.instances)[number]) => {
    if (pi.stuffed > 0 || pi.piece.construction === 'rows') return undefined;
    const rs = pi.rows.filter((r) => r.row > 0 && r.nodes.length);
    for (let k = rs.length - 1; k >= Math.max(1, rs.length - 4); k--) {
      if (rs[k].loop === 'FLO' && rs[rs.length - 1].nodes.length >= rs[k].nodes.length * 1.4) {
        const rings = rs.slice(k + 1).map((r) => r.nodes);
        return { top: rs[0].nodes, fold: rs[k].nodes, rings, radius: rings.map((r) => r.reduce((a, id) => a + graph.nodes[id].w, 0) / (2 * Math.PI) * 0.92) };
      }
    }
    return undefined;
  };
  const instances = graph.instances.map((pi) => {
    let h = 0;
    for (const id of pi.nodeIds) h += graph.nodes[id].h;
    const crease: number[] = [];
    for (const r of pi.rows) if (r.loop !== 'both') crease.push(...r.nodes);
    const planeNormal = s.planeNormals.get(pi) ?? [0, 1, 0];
    // a flattened cup (ears) is a pouch: two layers of fabric, front and back, a yarn apart.
    // Remember which layer each stitch is on (from the squashed seed) so they don't merge.
    let side: number[] | undefined;
    if (pi.piece.flatten) {
      const c = [0, 0, 0];
      for (const id of pi.nodeIds) for (let k = 0; k < 3; k++) c[k] += s.pos[id * 3 + k] / pi.nodeIds.length;
      const d = pi.nodeIds.map((id) => (s.pos[id * 3] - c[0]) * planeNormal[0] + (s.pos[id * 3 + 1] - c[1]) * planeNormal[1] + (s.pos[id * 3 + 2] - c[2]) * planeNormal[2]);
      const dm = Math.max(1e-6, ...d.map(Math.abs));
      side = d.map((x) => (Math.abs(x) < dm * 0.2 ? 0 : Math.sign(x)));
    }
    return {
      nodeIds: pi.nodeIds,
      stuffed: pi.stuffed,
      // a flat circle worked in rounds (a coaster): every closed round, for rounding out
      brim: brimOf(pi),
      rings: pi.flat && !pi.piece.flatten && pi.piece.construction !== 'rows' && pi.stuffed === 0 && !pi.piece.base ? pi.rows.filter((r) => r.closed && r.row > 0).map((r) => r.nodes) : undefined,
      ringCorners: pi.flat && !pi.piece.flatten && pi.piece.construction !== 'rows' && pi.stuffed === 0 && !pi.piece.base ? motifCorners(pi.rows.filter((r) => r.closed && r.row > 0)) : undefined,
      ringR: pi.flat && !pi.piece.flatten && pi.piece.construction !== 'rows' && pi.stuffed === 0 && !pi.piece.base ? pi.rows.filter((r) => r.closed && r.row > 0).map((r) => r.nodes.reduce((a, id) => a + graph.nodes[id].w, 0) / (2 * Math.PI)) : undefined,
      // (and a strip wrapped round something, a veil or a collar, hangs from where it is tied)
      // (lightly: it hangs off a small part, a bun, that would topple under a skirt's weight)
      drape: pi.piece.base && !isUpright(pi) && pi.stuffed === 0 ? 0.04 : wrapped(pi) ? 0.012 : 0,
      closed: pi.piece.finish === 'closed',
      shape: pi.piece.shape,
      // a strip wrapped round something (a collar, a scarf, a veil) is bent round it, not flat
      flat: pi.flat && !wrapped(pi),
      side,
      planeNormal,
      hAvg: h / Math.max(1, pi.nodeIds.length),
      crease,
    };
  });
  const solverInput: SolverInput = {
    pos: s.pos, edges, tris, triPiece, instances,
    smoothing: Math.min(0.35, 0.08 * sizing.stiffness),
    fixed,
    give,
    stick,
  };
  return { pattern, sizing, graph, tris, triPiece, markers: s.markers, solverInput };
}
