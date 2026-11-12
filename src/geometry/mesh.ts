import type { PieceInstance, StitchGraph } from '../graph/build';

/** Triangulate each piece instance from its rows (quad per stitch, triangle at inc/dec, fan at the ring). */
export function triangulate(g: StitchGraph): { tris: Uint32Array; triPiece: Uint16Array; holes: Uint8Array } {
  const out: number[] = [];
  const owner: number[] = [];
  const hole: number[] = [];
  g.instances.forEach((pi, pidx) => {
    // a chain made inside a round or row (a ch-2 corner, a ch-1 space) bridges over the stitches
    // below it: nothing fills the gap under it, so lace and granny squares keep their holes
    const space = new Set<number>();
    for (const row of pi.rows) if (row.row > 0) row.nodes.forEach((id, j) => {
      if (g.nodes[id].type !== 'ch') return;
      // a chain at the very start of a row is its turning chain (it stands at the edge, not over a gap)
      if (row.nodes.slice(0, j).every((q) => g.nodes[q].type === 'ch')) return;
      space.add(id);
    });
    const rowOf = new Map<number, number>();
    for (const row of pi.rows) for (const id of row.nodes) rowOf.set(id, row.row);
    const add = (a: number, b: number, c: number) => {
      if (a === b || b === c || a === c) return;
      // a triangle from a bridging chain down to the row below (or the ring) would cover the hole:
      // it stays in the mesh (normals, the solver) but is not drawn
      const tri = [a, b, c];
      hole.push(tri.some((v) => space.has(v)) && tri.some((v) => !space.has(v) && (rowOf.get(v) ?? -1) < Math.max(...tri.filter((q) => space.has(q)).map((q) => rowOf.get(q) ?? 0))) ? 1 : 0);
      out.push(a, b, c);
      owner.push(pidx);
    };
    for (let r = 0; r < pi.rows.length; r++) {
      const cur = pi.rows[r];
      const m = cur.nodes.length;
      if (cur.ring !== undefined) {
        for (let j = 0; j < m; j++) add(cur.ring, cur.nodes[(j + 1) % m], cur.nodes[j]);
        continue;
      }
      if (r === 0 && !pi.baseRow) continue;
      // a piece worked into other pieces meshes its first row against the stitches it went into
      const prev = r === 0 ? pi.baseRow! : pi.rows[r - 1];
      const P = prev.nodes;
      const n = P.length;
      let C = cur.nodes;
      let A = cur.anchors;
      if (n === 0 || m === 0) continue;
      if (!cur.closed) {
        if (A[0] > A[m - 1]) { C = [...C].reverse(); A = [...A].reverse(); }
        // turned rows alternate direction: flip winding on every other row so normals agree
        const flip = (r - 1) % 2 === 1;
        const tri = (a: number, b: number, c: number) => (flip ? add(a, c, b) : add(a, b, c));
        for (let j = 0; j < m - 1; j++) {
          const aj = Math.max(0, A[j]);
          const aj1 = Math.max(aj, A[j + 1]);
          for (let k = aj; k < aj1 && k < n - 1; k++) tri(C[j], P[k], P[k + 1]);
          tri(C[j], P[Math.min(aj1, n - 1)], C[j + 1]);
        }
        continue;
      }
      // the first round of an oval goes round both sides of its foundation chain: fill between
      if (pi.piece.oval && prev.row === 0 && !prev.closed) {
        for (let j = 0; j < m; j++) {
          const j1 = (j + 1) % m;
          const a = Math.max(0, A[j]), b = Math.max(0, A[j1]);
          // (wound the same way as every other round: wound backwards, these triangles turned the
          // normals along the chain inward, so stuffing pushed the chain into the piece as a groove
          // and shook the stitches round it, whose normals nearly cancelled, from step to step)
          add(C[j], P[Math.min(b, n - 1)], C[j1]);
          if (a !== b) add(C[j], P[Math.min(a, n - 1)], P[Math.min(b, n - 1)]);
        }
        continue;
      }
      const prevClosed = prev.closed && prev.row > 0 || prev.ring !== undefined || prev === pi.baseRow;
      // anchors run once round: stitches at the end worked back into where the round began
      // ("2 dc in the base of the ch 4") are past the end, not back at the start
      const U = A.map((x) => Math.max(0, x));
      for (let j = 1; j < m; j++) while (U[j] < U[j - 1] - n / 2) U[j] += n;
      for (let j = 0; j < m; j++) {
        const last = j === m - 1;
        const aj = U[j];
        let aj1 = last ? U[0] + n : U[j + 1];
        if (aj1 < aj) aj1 += n;
        if (aj1 - aj > n) aj1 = aj + n;
        const cj1 = C[(j + 1) % m];
        for (let k = aj; k < aj1; k++) {
          if (!prevClosed && (k + 1) % n === 0) continue;
          add(C[j], P[k % n], P[(k + 1) % n]);
        }
        add(C[j], P[aj1 % n], cj1);
      }
    }
    // close the end of closed pieces with a fan
    const lastRow = pi.rows[pi.rows.length - 1];
    if (pi.piece.finish === 'closed' && lastRow && lastRow.closed && lastRow.nodes.length >= 3) {
      const L = lastRow.nodes;
      for (let j = 1; j < L.length - 1; j++) add(L[0], L[j], L[j + 1]);
    }
  });
  return { tris: new Uint32Array(out), triPiece: new Uint16Array(owner), holes: new Uint8Array(hole) };
}

/** Smooth per-node normals, oriented outward per piece instance. */
export function computeNormals(pos: Float32Array, tris: Uint32Array, triPiece: Uint16Array, instances: PieceInstance[], out?: Float32Array): Float32Array {
  const nrm = out ?? new Float32Array(pos.length);
  nrm.fill(0);
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const i of [a, b, c]) { nrm[i] += nx; nrm[i + 1] += ny; nrm[i + 2] += nz; }
  }
  // orient each instance outward (compare with direction from centroid)
  for (const pi of instances) {
    let cx = 0, cy = 0, cz = 0;
    for (const id of pi.nodeIds) { cx += pos[id * 3]; cy += pos[id * 3 + 1]; cz += pos[id * 3 + 2]; }
    const k = 1 / Math.max(1, pi.nodeIds.length);
    cx *= k; cy *= k; cz *= k;
    let dot = 0;
    for (const id of pi.nodeIds) {
      const i = id * 3;
      dot += nrm[i] * (pos[i] - cx) + nrm[i + 1] * (pos[i + 1] - cy) + nrm[i + 2] * (pos[i + 2] - cz);
    }
    let s = dot < 0 ? -1 : 1;
    // a flat piece (a coaster, a granny square) has no inside to point away from: its centroid
    // sits in its own plane and the sign above is noise, so it would flip between solves (and
    // light the piece from behind). Its right side faces up (or the viewer, if it stands up).
    const motif = (pi as { rings?: unknown }).rings !== undefined || (pi.piece && !pi.piece.flatten && pi.piece.construction !== 'rows');
    if (pi.flat && pi.stuffed === 0 && motif) {
      let sy = 0, sz = 0;
      for (const id of pi.nodeIds) { sy += nrm[id * 3 + 1]; sz += nrm[id * 3 + 2]; }
      const m = Math.abs(sy) >= Math.abs(sz) ? sy : sz;
      if (m) s = m < 0 ? -1 : 1;
    }
    for (const id of pi.nodeIds) {
      const i = id * 3;
      const l = Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]) || 1;
      nrm[i] = (s * nrm[i]) / l; nrm[i + 1] = (s * nrm[i + 1]) / l; nrm[i + 2] = (s * nrm[i + 2]) / l;
    }
  }
  return nrm;
}
