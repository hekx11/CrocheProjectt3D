import type { Pattern } from '../model/types';
import { buildGraph, type StitchGraph } from '../graph/build';
import { computeSizing, type Sizing, type UserMaterials } from './sizing';
import { seed, type MarkerAnchor } from './seed';
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

  const all = [...graph.edges, ...s.seamEdges];
  const stuffedNode = new Uint8Array(graph.nodes.length);
  for (const pi of graph.instances) if (pi.stuffed > 0) for (const id of pi.nodeIds) stuffedNode[id] = 1;
  const edges = new Float32Array(all.length * 5);
  const give = new Float32Array(all.length);
  all.forEach((e, i) => {
    // stuffed fabric: the yarn gives a little under pressure instead of staying fully stretched
    give[i] = (e.kind === 'yarn' || e.kind === 'into') && stuffedNode[e.a] && stuffedNode[e.b] ? STRETCH_GIVE : 1;
    const slack = (e.kind === 'yarn' || e.kind === 'into') && stuffedNode[e.a] && stuffedNode[e.b] ? 0.7 : 1;
    edges.set([e.a, e.b, e.rest, STIFF[e.kind], slack], i * 5);
  });
  const fixed = new Uint8Array(graph.nodes.length);
  const instances = graph.instances.map((pi) => {
    let h = 0;
    for (const id of pi.nodeIds) h += graph.nodes[id].h;
    const crease: number[] = [];
    for (const r of pi.rows) if (r.loop !== 'both') crease.push(...r.nodes);
    return {
      nodeIds: pi.nodeIds,
      stuffed: pi.stuffed,
      flat: pi.flat,
      planeNormal: s.planeNormals.get(pi) ?? [0, 1, 0],
      hAvg: h / Math.max(1, pi.nodeIds.length),
      crease,
    };
  });
  const solverInput: SolverInput = {
    pos: s.pos, edges, tris, triPiece, instances,
    smoothing: Math.min(0.35, 0.08 * sizing.stiffness),
    fixed,
    give,
  };
  return { pattern, sizing, graph, tris, triPiece, markers: s.markers, solverInput };
}
