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
/** stick: a patch stitch held this far out along the host's surface normal (appliqué), not a length. */
export interface GEdge { a: number; b: number; kind: EdgeKind; rest: number; stick?: number }

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
  /** For a piece worked into other pieces (legs joined into a body, a skirt from the body's front
   *  loops): the stitches its first row works into, in order, for meshing the join. */
  baseRow?: GRow;
  /** Chains made between joined parts (the "ch 2" between two legs); they belong to no row. */
  baseChains?: number[];
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
        stuffed: piece.stuffing === 'firm' ? 1 : piece.stuffing === 'light' ? 0.75 : 0,
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
      let shortRows = false; // a round piece has turned: unworked stitches are worked later
      if (piece.base) {
        // worked into other pieces: their rows (already built) and any chains between them
        let chain: number[] = [];
        for (const part of piece.base) {
          if (part.kind === 'ch') {
            if (part.back) { prevWork.push(...[...chain].reverse()); continue; }
            chain = [];
            for (let i = 0; i < part.n; i++) {
              const id = add({ key: `${piece.name}:${inst}:base:${i}`, piece: piece.id, inst, row: 0, idx: i, u: i, type: 'ch', loop: 'both', w: sz.w, h: sz.h * 0.5, color: firstColor, line: piece.rows[0]?.line ?? -1, virtual: false });
              if (lastYarnNode >= 0) edges.push({ a: lastYarnNode, b: id, kind: 'yarn', rest: sz.w });
              lastYarnNode = id;
              chain.push(id);
              (pi.baseChains ??= []).push(id);
            }
            prevWork.push(...chain);
            continue;
          }
          const src = instances.find((q) => q.piece.id === part.piece && q.inst === Math.min(part.inst, q.piece.quantity - 1) && (part.inst < q.piece.quantity || q.inst === inst));
          const r = src?.rows.find((q) => q.row === part.row);
          if (r) prevWork.push(...(src!.piece.construction === 'rows' ? [...r.nodes].reverse() : r.nodes));
        }
        prevRow = { piece: piece.id, inst, row: 0, nodes: prevWork, anchors: prevWork.map(() => -1), closed: true, loop: 'both', line: -1 };
        pi.baseRow = prevRow;
      } else if (piece.start.kind === 'chain' && !piece.start.ring) {
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
        if (r.skipGeometry) continue;
        const ex = execute(r.ops, ringMode ? 0 : prevWork.length, ringMode);
        const color = yarnColor.get(r.yarnId) ?? firstColor;
        const row: GRow = { piece: piece.id, inst, row: r.index, nodes: [], anchors: [], closed: piece.construction !== 'rows' && !r.turn && !shortRows, loop: 'both', line: r.line };
        if (ringMode) row.ring = pi.centre;
        let loops = 0;
        const prodIndexOf = new Map<number, number>();
        prevRow?.nodes.forEach((id, i) => prodIndexOf.set(id, i));
        ex.stitches.forEach((s, i) => {
          if (s.loop !== 'both') loops++;
          const wf = widthFactor(s.type, s.tension);
          // a carried stitch is the stitch below passed on: its colour, almost no height
          const below = s.carry && s.targets.length ? nodes[prevWork[s.targets[0]]] : undefined;
          const hf = below ? 0.15 : s.type === 'ch' ? 0.5 : heightFactor(s.type, s.tension, s.loop);
          const id = add({
            key: `${piece.name}:${inst}:${r.index}:${i}:${ex.stitches.length}`, piece: piece.id, inst, row: r.index, idx: i, u: piece.construction === 'rows' && r.index % 2 === 1 ? ex.stitches.length - 1 - i : i,
            type: s.type, loop: s.loop, w: below ? below.w : sz.w * wf, h: sz.h * hf, color: below ? below.color : color, line: r.line, virtual: false,
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
            // stuffing stretches the fabric: stitches open up a little in height
            edges.push({ a: tid, b: id, kind: 'into', rest: sz.h * hf * (1 + 0.1 * pi.stuffed) });
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
          if (piece.construction === 'rows') prevWork = [...row.nodes].reverse();
          else {
            // a round piece with short rows (hair worked in rows across the back, then round
            // again): stitches this row left unworked come next, after its own stitches. Turned,
            // the work comes back across this row and on past where it started.
            let used = 0;
            for (const st of ex.stitches) for (const t of st.targets) used = Math.max(used, t + 1);
            if (r.turn) shortRows = true;
            const rest = ringMode || !shortRows ? [] : prevWork.slice(Math.min(used, prevWork.length));
            // not turned, the next round carries on from this row's end: the unworked stitches first
            prevWork = r.turn ? [...row.nodes].reverse().concat(rest.reverse()) : [...rest, ...row.nodes];
          }
          ringMode = false;
        }
      }
    }
  }
  return { nodes, edges, instances };
}
