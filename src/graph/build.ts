import type { Loop, Pattern, PieceDef, StitchType } from '../model/types';
import { execute } from '../parser/row';
import { heightFactor, widthFactor, type Sizing } from '../geometry/sizing';

export interface GNode {
  id: number;
  key: string; // stable id for warm starts
  piece: string;
  inst: number;
  row: number; // 0 = foundation / ring centre
  idx: number;
  u: number; // stitch index aligned across turned rows (for texture)
  type: StitchType | 'ring';
  loop: Loop;
  w: number; // mm
  h: number; // mm
  color: string;
  line: number; // editor line, -1 for virtual nodes
  virtual: boolean;
}

export type EdgeKind = 'yarn' | 'into' | 'ring' | 'join' | 'seam';
export interface GEdge { a: number; b: number; kind: EdgeKind; rest: number }

export interface GRow {
  piece: string;
  inst: number;
  row: number;
  nodes: number[]; // production order
  anchors: number[]; // per node: index into previous row's production order (-1: none)
  closed: boolean; // round (wraps) vs flat row
  ring?: number; // centre node id for first rounds
  loop: Loop;
  line: number;
}

export interface PieceInstance {
  piece: PieceDef;
  inst: number;
  rows: GRow[];
  nodeIds: number[];
  centre?: number;
  stuffed: number; // pressure 0..1
  flat: boolean;
}

export interface StitchGraph {
  nodes: GNode[];
  edges: GEdge[];
  instances: PieceInstance[];
}

export function buildGraph(p: Pattern, sz: Sizing): StitchGraph {
  const nodes: GNode[] = [];
  const edges: GEdge[] = [];
  const instances: PieceInstance[] = [];
  const yarnColor = new Map(p.materials.yarns.map((y) => [y.id, y.color]));

  for (const piece of p.pieces) {
    for (let inst = 0; inst < piece.quantity; inst++) {
      const pi: PieceInstance = {
        piece, inst, rows: [], nodeIds: [],
        stuffed: piece.stuffing === 'firm' ? 1 : piece.stuffing === 'light' ? 0.45 : 0,
        flat: piece.flatten || (piece.construction === 'rows') || (piece.stuffing === 'none' && piece.construction === 'joined-rounds'),
      };
      instances.push(pi);
      const add = (n: Omit<GNode, 'id'>) => {
        const id = nodes.length;
        nodes.push({ ...n, id });
        pi.nodeIds.push(id);
        return id;
      };
      const firstColor = yarnColor.get(piece.rows[0]?.yarnId ?? '') ?? '#e8a87c';

      // Foundation
      let prevRow: GRow | null = null;
      let prevWork: number[] = []; // node ids in the order the next row works into them
      let ringMode = false;
      let lastYarnNode = -1;
      if (piece.start.kind === 'chain' && !piece.start.ring) {
        const row: GRow = { piece: piece.id, inst, row: 0, nodes: [], anchors: [], closed: false, loop: 'both', line: piece.rows[0]?.line ?? -1 };
        // A foundation chain is as wide as the stitches worked into it; a narrower chain
        // gathers the first rows and the solver resolves the conflict by rippling the fabric.
        for (let i = 0; i < piece.start.n; i++) {
          const id = add({ key: `${piece.name}:${inst}:0:${i}`, piece: piece.id, inst, row: 0, idx: i, u: i, type: 'ch', loop: 'both', w: sz.w, h: sz.h * 0.5, color: firstColor, line: row.line, virtual: false });
          if (lastYarnNode >= 0) edges.push({ a: lastYarnNode, b: id, kind: 'yarn', rest: sz.w });
          lastYarnNode = id;
          row.nodes.push(id);
          row.anchors.push(-1);
        }
        pi.rows.push(row);
        prevRow = row;
        prevWork = [...row.nodes].reverse(); // worked back from the hook
      } else {
        ringMode = true;
        pi.centre = add({ key: `${piece.name}:${inst}:ring`, piece: piece.id, inst, row: 0, idx: 0, u: 0, type: 'ring', loop: 'both', w: 0, h: 0, color: firstColor, line: piece.rows[0]?.line ?? -1, virtual: true });
      }

      for (const r of piece.rows) {
        const ex = execute(r.ops, ringMode ? 0 : prevWork.length, ringMode);
        const color = yarnColor.get(r.yarnId) ?? firstColor;
        const row: GRow = { piece: piece.id, inst, row: r.index, nodes: [], anchors: [], closed: piece.construction !== 'rows', loop: 'both', line: r.line };
        if (ringMode) row.ring = pi.centre;
        let loops = 0;
        const prodIndexOf = new Map<number, number>();
        prevRow?.nodes.forEach((id, i) => prodIndexOf.set(id, i));
        ex.stitches.forEach((s, i) => {
          if (s.loop !== 'both') loops++;
          const wf = widthFactor(s.type, s.tension);
          const hf = s.type === 'ch' ? 0.5 : heightFactor(s.type, s.tension, s.loop);
          const id = add({
            key: `${piece.name}:${inst}:${r.index}:${i}:${ex.stitches.length}`, piece: piece.id, inst, row: r.index, idx: i, u: piece.construction === 'rows' && r.index % 2 === 1 ? ex.stitches.length - 1 - i : i,
            type: s.type, loop: s.loop, w: sz.w * wf, h: sz.h * hf, color, line: r.line, virtual: false,
          });
          if (lastYarnNode >= 0) edges.push({ a: lastYarnNode, b: id, kind: 'yarn', rest: sz.w * wf });
          lastYarnNode = id;
          let anchor = -1;
          if (s.ring && pi.centre !== undefined) {
            edges.push({ a: pi.centre, b: id, kind: 'ring', rest: Math.max(sz.h * 0.35, (ex.stitches.length * sz.w) / (2 * Math.PI) * 0.75) });
          }
          for (const t of s.targets) {
            const tid = prevWork[t];
            if (tid === undefined) continue;
            // stuffing stretches the fabric: stitches open up in height (a firmly stuffed sc ball comes out round)
            edges.push({ a: tid, b: id, kind: 'into', rest: sz.h * hf * (1 + 0.16 * pi.stuffed) });
            const pidx = prodIndexOf.get(tid) ?? -1;
            if (anchor < 0) anchor = pidx;
          }
          row.nodes.push(id);
          row.anchors.push(anchor);
        });
        if (loops > ex.stitches.length / 2) row.loop = ex.stitches.find((s) => s.loop !== 'both')!.loop;
        // fill anchors for chains (no target): carry previous
        for (let i = 0; i < row.anchors.length; i++) if (row.anchors[i] < 0 && i > 0) row.anchors[i] = row.anchors[i - 1];
        const firstReal = row.anchors.findIndex((a) => a >= 0);
        for (let i = 0; i < firstReal; i++) row.anchors[i] = row.anchors[firstReal];
        if (r.join && row.nodes.length > 2) edges.push({ a: row.nodes[row.nodes.length - 1], b: row.nodes[0], kind: 'join', rest: sz.w });
        // closed rounds: also connect last and first so the ring closes (spiral continues anyway)
        if (row.closed && !r.join && row.nodes.length > 2 && !ringMode) {
          /* spiral: yarn edge to the next round already links them */
        }
        if (row.nodes.length) {
          pi.rows.push(row);
          prevRow = row;
          prevWork = piece.construction === 'rows' ? [...row.nodes].reverse() : [...row.nodes];
          ringMode = false;
        }
      }
    }
  }
  return { nodes, edges, instances };
}
