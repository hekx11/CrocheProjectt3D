import * as THREE from 'three';
import type { Model } from '../geometry/pipeline';
import type { YarnLook } from './textures';

/**
 * Stitches built from real 3D yarn (docs/yarn-tension-texture.md §3.1), drawn on top of the solved
 * surface. A piece is worked from one long strand of yarn, so it is drawn as one: a single tube that
 * starts at the tail, goes round the magic ring (or the chain ring), then runs through every stitch
 * in the order they are made and ends where the piece is fastened off.
 *
 * In each stitch the strand follows the path the yarn takes: down the front of the stitch, behind
 * the top of the stitch it is worked into (or behind the ring, in a first round) and back up, so the
 * two passes make the "v" of the stitch; taller stitches first wrap the post (the yarn-over bar), and
 * the strand loops over the top of the stitch before it goes on to the next one, which is the chain
 * of "v"s along the top of a row. A chain is a small oval lying along the strand.
 *
 * Each stitch's path is laid out in its own frame: across = along its row, up = from where it is
 * worked to its top, out = surface normal, so it follows the solved shape as it settles.
 *
 * The yarn type decides what the strand is made of: twisted plies (cotton, acrylic, wool), a halo
 * of loose fibres (wool, mohair), or a fat plush tube with pile (chenille, velvet / polyester plush).
 * Light then falls on an actual strand, which is what makes the materials read differently.
 */

type P3 = [number, number, number];
type Kind = 'sc' | 'tall' | 'tr' | 'ch';
const KIND_OF: Record<string, Kind> = { ch: 'ch', hdc: 'tall', dc: 'tall', tr: 'tr', dtr: 'tr' };

// Paths through one stitch, as (x, s, z): x across (in stitch widths, from the stitch before
// towards the next one), s up (0 where the stitch is worked, 1 its top), z out (in stitch widths).
// s = -1 is right under what the stitch is worked into (the top "v" below, or the ring strands).
//
// An sc, following the steps of the stitch. A loop sits on the hook from the stitch before.
//  1. insert the hook under the top "v" of the stitch below (in round 1: into the ring);
//  2. yarn over and pull up a loop: a bight of yarn, caught behind, comes through under that "v"
//     to the front and up to the hook. Its two strands are the "v" seen on the front of an sc;
//  3. yarn over again;
//  4. pull through both loops: the new loop goes through the tip of the loop just pulled up and
//     through the loop from the stitch before, and stays on the hook. Pulled snug it lies along the
//     top of the stitch, pointing on to the next one (which closes it): the top "v" of the stitch.
// So the yarn goes: from the previous loop down the back to where the stitch is worked, under it to
// the front, up the front, round the new loop, down the front, under it to the back, up the back,
// then along the top (back strand out, round the hook, front strand back) and through to the back,
// where the next stitch begins. The strands behind are the bars seen on the wrong side of sc.
const DOWN: P3[] = [[-0.55, 0.6, -0.3], [-0.22, 0.14, -0.3]];
const UNDER_UP: P3[] = [
  [-0.07, -1, -0.32], [-0.09, -1, 0.28], // under the "v" below, out to the front
  [-0.17, 0.3, 0.26], [-0.15, 0.72, 0.24], // up the front: left arm of the "v"
  [-0.07, 0.98, 0.15], [0.01, 1.05, -0.03], [0.09, 0.97, 0.13], // the tip, round the new loop
  [0.15, 0.72, 0.24], [0.16, 0.3, 0.26], // down the front: right arm of the "v"
  [0.09, -1, 0.28], [0.07, -1, -0.32], // under again, to the back
  [0.14, 0.42, -0.3], [0.08, 0.84, -0.24], // yarn over: up the back to the hook
  [0.02, 0.99, -0.14], [0.36, 1.0, -0.18], [0.7, 1.02, -0.06], [0.76, 1.0, 0.08], // the new loop along the top
  [0.4, 1.0, 0.18], [0.04, 0.98, 0.12], [-0.06, 0.9, -0.16], // and back through to the wrong side
];
/** A yarn-over wrapped round the post (hdc, dc, tr): a bar across the front, round the back. */
const WRAP = (s: number): P3[] => [[-0.32, s + 0.05, 0.22], [0.3, s - 0.03, 0.27], [0.38, s - 0.04, -0.06], [0.04, s - 0.01, -0.22], [-0.26, s - 0.02, 0.02]];
const TEMPLATE: Record<Kind, P3[]> = {
  sc: [...DOWN, ...UNDER_UP],
  tall: [...DOWN, ...WRAP(0.45), ...UNDER_UP],
  tr: [...DOWN, ...WRAP(0.62), ...WRAP(0.32), ...UNDER_UP],
  // a chain lies along the strand: an oval loop, pulled through the one before
  ch: [[-0.5, 0.5, 0], [-0.22, 0.84, 0.14], [0.24, 0.84, 0.08], [0.42, 0.52, -0.08], [0.2, 0.18, -0.14], [-0.14, 0.26, -0.02], [0.12, 0.48, 0.1]],
};
/** After the last stitch: pulled through and cut, the end tucked behind. */
const END: P3[] = [[0.5, 0.94, 0], [0.75, 1.0, -0.25], [0.9, 0.95, -0.45]];
/** Where a stitch goes in: the top "v" of the stitch below lies from that stitch on towards the
 *  next, so the hole under it is this far along. */
const HOLE = 0.38;
const MAGIC_TURNS = 2, MAGIC_PTS = 16;
/** Points per stitch width along the strand between control points, and around the strand. */
const DETAIL: [sub: number, rad: number, shells: number][] = [[4, 8, 2], [3, 8, 1], [3, 6, 0], [2, 6, 0], [2, 5, 0], [1, 6, 0]];
/** Vertices the strand (with its fuzz shells) may use: a big amigurumi has thousands of stitches,
 *  and drawing each as finely as a coaster's would stall a phone. */
const VERTEX_BUDGET = 1_200_000;

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/**
 * Normal map for the strand surface. s (along, in diameters) × t (around the strand).
 * Plied yarn: helical grooves between plies plus fine fibre lines along each ply.
 * Unplied plush: dense pile noise.
 */
export function strandNormalMap(look: YarnLook): THREE.DataTexture {
  const W = 64, H = 128; // W along one diameter, H around
  const hgt = new Float32Array(W * H);
  const rand = rng(7 + look.plies);
  const noise = new Float32Array(W * H).map(() => rand());
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const s = x / W, t = y / H;
    let h = 0;
    if (look.plies > 0) {
      // plies wind around the strand: phase is periodic in s (one ply passes per diameter)
      const ph = look.plies * t - s;
      const q = ph - Math.floor(ph);
      h = Math.sin(Math.PI * q) ** 0.6 * look.plyDepth * 2.2;
      // fibres within a ply run along it, at the twist angle
      const fib = Math.sin(2 * Math.PI * (look.plies * 9 * t - 9 * s));
      h += fib * 0.06;
    } else {
      h = noise[y * W + x] * (0.3 + look.pile * 2);
    }
    h += (noise[((y * 7) % H) * W + ((x * 3) % W)] - 0.5) * look.pile * 1.5;
    hgt[y * W + x] = h;
  }
  const at = (x: number, y: number) => hgt[((y + H) % H) * W + ((x + W) % W)];
  const data = new Uint8Array(W * H * 4);
  const k = 3 * look.normalStrength;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = (at(x + 1, y) - at(x - 1, y)) * k, dy = (at(x, y + 1) - at(x, y - 1)) * k;
    const l = Math.hypot(dx, dy, 1), i = (y * W + x) * 4;
    data[i] = ((-dx / l) * 0.5 + 0.5) * 255;
    data[i + 1] = ((-dy / l) * 0.5 + 0.5) * 255;
    data[i + 2] = ((1 / l) * 0.5 + 0.5) * 255;
    data[i + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/** Loose fibres standing off the strand: alpha mask for the fuzz shells (value = fibre reach). */
function fibreMask(look: YarnLook): THREE.DataTexture {
  const W = 64, H = 128;
  const val = new Float32Array(W * H);
  const rand = rng(31 + look.shells.count);
  const strands = Math.round(W * H * look.shells.density * (look.shells.kind === 'pile' ? 0.6 : 0.08));
  for (let k = 0; k < strands; k++) {
    let x = rand() * W, y = rand() * H;
    const a = rand() * Math.PI * 2, len = look.shells.kind === 'pile' ? 1 : look.shells.kind === 'halo' ? 10 + rand() * 20 : 3 + rand() * 6;
    const reach = 0.3 + 0.7 * rand();
    for (let t = 0; t < len; t++) {
      const ix = ((Math.round(x) % W) + W) % W, iy = ((Math.round(y) % H) + H) % H;
      val[iy * W + ix] = Math.max(val[iy * W + ix], reach * (1 - 0.5 * (t / len)));
      x += Math.cos(a); y += Math.sin(a);
    }
  }
  const data = new Uint8Array(W * H * 4);
  for (let i = 0; i < val.length; i++) { const b = Math.round(Math.min(1, val[i]) * 255); data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = b; data[i * 4 + 3] = 255; }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

interface Step { node: number; parent: number; prev: number; next: number; kind: Kind; pp: number; np: number; fan: boolean }
interface Ring { centre: number; magic: boolean; n: number; first: number[] }
/** close: a piece finished closed ("fasten off, weave through the front loops and pull tight"):
 *  its last round, which the tail is threaded through and drawn together. */
interface Strand { steps: Step[]; ring?: Ring; close?: number[]; ctrl: number; v0: number; s0: number }

const V = () => new THREE.Vector3();

/** Centripetal Catmull–Rom between p1 and p2 (Hermite form), u in [0, 1]. */
function catmull(c: Float32Array, i0: number, i1: number, i2: number, i3: number, u: number, out: Float32Array, o: number) {
  const d = (a: number, b: number) => Math.max(1e-4, Math.sqrt(Math.hypot(c[a * 3] - c[b * 3], c[a * 3 + 1] - c[b * 3 + 1], c[a * 3 + 2] - c[b * 3 + 2])));
  const t01 = d(i0, i1), t12 = d(i1, i2), t23 = d(i2, i3);
  const u2 = u * u, u3 = u2 * u;
  for (let k = 0; k < 3; k++) {
    const p0 = c[i0 * 3 + k], p1 = c[i1 * 3 + k], p2 = c[i2 * 3 + k], p3 = c[i3 * 3 + k];
    const m1 = p2 - p1 + t12 * ((p1 - p0) / t01 - (p2 - p0) / (t01 + t12));
    const m2 = p2 - p1 + t12 * ((p3 - p2) / t23 - (p3 - p1) / (t12 + t23));
    out[o + k] = (2 * p1 - 2 * p2 + m1 + m2) * u3 + (-3 * p1 + 3 * p2 - 2 * m1 - m2) * u2 + m1 * u + p1;
  }
}

export class Yarn3D {
  readonly group = new THREE.Group();
  private strands: Strand[] = [];
  private meshes: { mesh: THREE.Mesh; inflate: number }[] = [];
  private ctrl = new Float32Array(0);
  private samples = new Float32Array(0);
  private sampleNode = new Int32Array(0);
  private nSamples = 0;
  private radius = 1;
  private baseRadius = 1;
  private sizeW = 1;
  private sub = 4;
  private rad = 8;
  private after = new Int32Array(0);
  private pending: (() => void) | null = null;
  private lastRun = 0;
  /** How long the last rebuild took: a big piece is rebuilt less often while the solver runs. */
  private cost = 0;
  private timer = 0;
  /** Called after a deferred update has moved the strand. */
  onChange?: () => void;

  build(model: Model, look: YarnLook) {
    this.dispose();
    const g = model.graph;
    const nodes = g.nodes;
    const parent = new Int32Array(nodes.length).fill(-1);
    for (const e of g.edges) if (e.kind === 'into' && parent[e.b] < 0) parent[e.b] = e.a;
    // a first round's stitches are worked into the ring
    for (const e of g.edges) if (e.kind === 'ring' && parent[e.b] < 0) parent[e.b] = e.a;
    // stitches worked into one space or loop (a granny square's 3-dc clusters, a shell): three or
    // more on one parent
    const kids = new Map<number, number>();
    for (let id = 0; id < nodes.length; id++) if (parent[id] >= 0) kids.set(parent[id], (kids.get(parent[id]) ?? 0) + 1);

    this.after = new Int32Array(nodes.length).fill(-1);
    for (const pi of g.instances) for (const row of [...(pi.baseRow ? [pi.baseRow] : []), ...pi.rows]) {
      const ids = row.nodes;
      for (let j = 0; j < ids.length; j++) this.after[ids[j]] = j + 1 < ids.length ? ids[j + 1] : row.closed ? ids[0] : -1;
    }
    let nCtrl = 0, nSamples = 0;
    const ctrlNode: number[] = [];
    for (const pi of g.instances) {
      const steps: Step[] = [];
      const push = (ids: number[], closed: boolean) => ids.forEach((id, j) => {
        const n = nodes[id];
        if (n.virtual) return;
        const prev = j > 0 ? ids[j - 1] : closed ? ids[ids.length - 1] : id;
        const next = j < ids.length - 1 ? ids[j + 1] : closed ? ids[0] : id;
        const kind = KIND_OF[n.type] ?? 'sc';
        const p = kind === 'ch' ? -1 : parent[id];
        steps.push({ node: id, parent: p, prev, next, kind, pp: parent[prev], np: parent[next], fan: p >= 0 && (kids.get(p) ?? 0) >= 3 && nodes[p].type === 'ch' });
      });
      if (pi.baseChains) push(pi.baseChains, false);
      for (const row of pi.rows) push(row.nodes, row.closed);
      if (!steps.length) continue;
      let ring: Ring | undefined;
      const st = pi.piece.start;
      if (pi.centre !== undefined && !pi.piece.base) {
        const first = steps.filter((s) => s.parent === pi.centre).map((s) => s.node);
        if (first.length) ring = { centre: pi.centre, magic: st.kind !== 'chain', n: st.kind === 'chain' ? Math.max(3, st.n) : 0, first };
      }
      const ringPts = !ring ? 0 : ring.magic ? 2 + MAGIC_PTS * MAGIC_TURNS + 1 : 2 + 3 * ring.n + 1;
      const lastRow = pi.rows[pi.rows.length - 1];
      const closeIds = pi.piece.finish === 'closed' && lastRow?.closed ? lastRow.nodes.filter((id) => !nodes[id].virtual) : [];
      const close = closeIds.length >= 3 && closeIds.length <= 12 ? closeIds : undefined;
      const endPts = close ? close.length + 3 : END.length;
      const ctrl = ringPts + steps.reduce((a, s) => a + TEMPLATE[s.kind].length, 0) + endPts;
      for (let k = 0; k < ringPts; k++) ctrlNode.push(ring!.centre);
      for (const s of steps) for (let k = 0; k < TEMPLATE[s.kind].length; k++) ctrlNode.push(s.node);
      for (let k = 0; k < endPts; k++) ctrlNode.push(steps[steps.length - 1].node);
      this.strands.push({ steps, ring, close, ctrl, v0: 0, s0: 0 });
      nCtrl += ctrl;
    }
    // as fine as the budget allows: points along the strand, around it, and fuzz shells
    const segs = nCtrl - this.strands.length;
    const wantShells = look.shells.count > 0 ? Math.min(2, look.shells.count) : 0;
    const fits = ([sub, rad, sh]: [number, number, number]) => (segs * sub + this.strands.length) * (rad + 1) * (1 + Math.min(sh, wantShells)) <= VERTEX_BUDGET;
    const [SUB, RAD, maxShells] = DETAIL.find(fits) ?? DETAIL[DETAIL.length - 1];
    this.sub = SUB; this.rad = RAD;
    for (const s of this.strands) {
      s.s0 = nSamples;
      s.v0 = nSamples * (RAD + 1);
      nSamples += (s.ctrl - 1) * SUB + 1;
    }
    this.ctrl = new Float32Array(nCtrl * 3);
    this.samples = new Float32Array(nSamples * 3);
    this.nSamples = nSamples;
    this.sampleNode = new Int32Array(nSamples);
    let c0 = 0;
    for (const s of this.strands) {
      for (let i = 0; i < s.ctrl - 1; i++) for (let k = 0; k < SUB; k++) this.sampleNode[s.s0 + i * SUB + k] = ctrlNode[c0 + i];
      this.sampleNode[s.s0 + (s.ctrl - 1) * SUB] = ctrlNode[c0 + s.ctrl - 1];
      c0 += s.ctrl;
    }

    // one index buffer: rings of RAD + 1 vertices (the seam repeats for the texture) along each strand
    const nv = nSamples * (RAD + 1);
    const idx: number[] = [];
    for (const s of this.strands) {
      const n = (s.ctrl - 1) * SUB + 1;
      for (let i = 0; i < n - 1; i++) for (let j = 0; j < RAD; j++) {
        const a = s.v0 + i * (RAD + 1) + j, b = a + RAD + 1;
        idx.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
    const index = new THREE.BufferAttribute(nv > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), 1);
    const uv = new THREE.BufferAttribute(new Float32Array(nv * 2), 2);
    const color = new THREE.BufferAttribute(new Float32Array(nv * 3).fill(1), 3);
    const geometry = () => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nv * 3), 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nv * 3), 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('uv', uv);
      geo.setAttribute('color', color);
      geo.setIndex(index);
      return geo;
    };

    // yarn radius in sc widths: fat next to the stitch (tight amigurumi); plush yarn fatter
    this.sizeW = model.sizing.w;
    this.baseRadius = this.radius = model.sizing.w * (look.plies > 0 ? 0.19 + look.legRadius * 0.2 : 0.23 + look.legRadius * 0.2);
    const nmap = strandNormalMap(look);
    const fmask = look.shells.count > 0 ? fibreMask(look) : null;
    const mat = new THREE.MeshPhysicalMaterial({
      vertexColors: true,
      roughness: look.roughness,
      sheen: look.sheen,
      sheenRoughness: look.sheenRoughness,
      sheenColor: new THREE.Color().setScalar(look.sheenTint),
      normalMap: nmap,
      normalScale: new THREE.Vector2(1, 1),
    });
    const add = (m: THREE.Mesh, inflate: number) => {
      m.frustumCulled = false;
      m.raycast = () => {};
      this.group.add(m);
      this.meshes.push({ mesh: m, inflate });
    };
    add(new THREE.Mesh(geometry(), mat), 0);
    if (fmask) {
      const count = Math.min(maxShells, look.shells.count);
      for (let k = 0; k < count; k++) {
        const f = (k + 1) / (count + 1);
        const reach = (look.shells.kind === 'halo' ? 2.4 : look.shells.kind === 'pile' ? 0.5 : 1.0) * look.shells.length / 0.1;
        const sm = new THREE.MeshPhysicalMaterial({
          vertexColors: true,
          roughness: 1, sheen: look.sheen * 0.6, sheenRoughness: look.sheenRoughness,
          sheenColor: new THREE.Color().setScalar(look.sheenTint),
          alphaMap: fmask, alphaTest: Math.min(0.95, 0.15 + f * 0.8), side: THREE.DoubleSide,
        });
        sm.color.setScalar(1 + 0.12 * f);
        const m = new THREE.Mesh(geometry(), sm);
        m.renderOrder = 1 + k;
        add(m, Math.min(1.2, reach * f));
      }
    }
  }

  /** Per-node linear colours. */
  setColors(color: (node: number) => THREE.Color) {
    if (!this.meshes.length) return;
    const attr = this.meshes[0].mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    const a = attr.array as Float32Array;
    let last = -1, r = 1, gg = 1, b = 1;
    for (let i = 0; i < this.nSamples; i++) {
      const n = this.sampleNode[i];
      if (n !== last) { const c = color(n); r = c.r; gg = c.g; b = c.b; last = n; }
      for (let j = 0, o = i * (this.rad + 1) * 3; j <= this.rad; j++, o += 3) { a[o] = r; a[o + 1] = gg; a[o + 2] = b; }
    }
    attr.needsUpdate = true;
  }

  update(pos: Float32Array, nrm: Float32Array, nodeW: (id: number) => number) {
    if (!this.meshes.length) return;
    // the solver sends shapes faster than the strand is worth rebuilding: at most a few times a
    // second while it settles, and always the last shape
    const pos2 = pos.slice(), nrm2 = nrm.slice();
    this.pending = () => this.update0(pos2, nrm2, nodeW);
    const wait = this.lastRun + Math.max(250, this.cost * 4) - performance.now();
    if (wait <= 0) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => { this.timer = 0; this.flush(); this.onChange?.(); }, wait) as unknown as number;
  }
  private flush() {
    const run = this.pending;
    this.pending = null;
    if (!run) return;
    const t0 = performance.now();
    run();
    this.lastRun = performance.now();
    this.cost = this.lastRun - t0;
  }
  private update0(pos: Float32Array, nrm: Float32Array, nodeW: (id: number) => number) {
    const ctrl = this.ctrl;
    const P = (id: number, v: THREE.Vector3) => v.set(pos[id * 3], pos[id * 3 + 1], pos[id * 3 + 2]);
    const X = V(), Y = V(), Z = V(), C = V(), U = V(), O = V(), a = V(), b = V(), up = V();
    const Cn = V(), Nr = V(), e1 = V(), e2 = V(), q = V(), Ud = V(), t = V();
    let ci = 0;
    const put = (v: THREE.Vector3) => { ctrl[ci * 3] = v.x; ctrl[ci * 3 + 1] = v.y; ctrl[ci * 3 + 2] = v.z; ci++; };
    const widths: number[] = [];
    const Cc = V(), Nc = V();
    for (const s of this.strands) {
      // a closed end: the tail drawn through the last round's front loops pulls them together, so
      // its stitches lean in over the hole instead of leaving it open
      if (s.close) {
        Cc.set(0, 0, 0); Nc.set(0, 0, 0);
        for (const id of s.close) { Cc.add(P(id, q)); Nc.x += nrm[id * 3]; Nc.y += nrm[id * 3 + 1]; Nc.z += nrm[id * 3 + 2]; }
        Cc.multiplyScalar(1 / s.close.length);
        if (Nc.lengthSq() < 1e-12) Nc.set(0, 1, 0);
        Nc.normalize();
        for (const id of s.close) for (let k = 0; k < 3; k++) pos[id * 3 + k] += (Cc.getComponent(k) - pos[id * 3 + k]) * 0.6;
      }
      // the ring: centre, plane, radius; a stitch worked into it stands on the ring, not the centre
      let rr = 0, rw = 1;
      const ring = s.ring;
      if (ring) {
        P(ring.centre, Cn);
        Nr.set(0, 0, 0);
        for (const id of ring.first) Nr.x += nrm[id * 3], Nr.y += nrm[id * 3 + 1], Nr.z += nrm[id * 3 + 2];
        if (Nr.lengthSq() < 1e-12) Nr.set(0, 1, 0);
        Nr.normalize();
        P(ring.first[0], e1).sub(Cn);
        const reach = e1.length();
        e1.addScaledVector(Nr, -e1.dot(Nr));
        if (e1.lengthSq() < 1e-12) e1.set(1, 0, 0).addScaledVector(Nr, -Nr.x);
        e1.normalize();
        e2.crossVectors(Nr, e1);
        if (ring.first.length > 1 && P(ring.first[1], q).sub(Cn).dot(e2) < 0) e2.negate();
        rw = nodeW(ring.first[0]);
        rr = ring.magic ? Math.min(rw * 0.45, reach * 0.5) : Math.min((ring.n * rw) / (2 * Math.PI), reach * 0.6);
      }
      const onRing = (ang: number, r: number, z: number, v: THREE.Vector3) =>
        v.copy(Cn).addScaledVector(e1, Math.cos(ang) * r).addScaledVector(e2, Math.sin(ang) * r).addScaledVector(Nr, z);
      const where = (p: number, v: THREE.Vector3, top: THREE.Vector3) => {
        if (ring && p === ring.centre) {
          t.subVectors(top, Cn);
          t.addScaledVector(Nr, -t.dot(Nr));
          if (t.lengthSq() < 1e-12) t.copy(e1);
          return v.copy(Cn).addScaledVector(t.normalize(), rr);
        }
        // under the top "v" of the stitch below, which lies on towards the stitch after it
        P(p, v);
        const n = this.after[p];
        if (n >= 0) v.lerp(P(n, t), HOLE);
        return v;
      };
      if (ring) {
        // the tail, then the ring itself: a magic ring is the yarn wound round twice and pulled
        // closed; a chain ring is a ring of chains
        put(onRing(-2.3, rr + rw * 1.3, -rw * 0.35, q));
        put(onRing(-1.5, rr + rw * 0.45, -rw * 0.2, q));
        if (ring.magic) {
          const n = MAGIC_PTS * MAGIC_TURNS;
          for (let k = 0; k <= n; k++) {
            const t = k / n;
            put(onRing(-1.0 + t * MAGIC_TURNS * 2 * Math.PI, rr * (1.08 - 0.16 * t), -rw * (0.12 - 0.08 * t), q));
          }
        } else {
          const n = 3 * ring.n;
          for (let k = 0; k <= n; k++) {
            const w = [0, 1, -1][k % 3];
            put(onRing(-0.6 + (k / n) * 2 * Math.PI, rr * (1 + 0.16 * w), rw * 0.12 * w, q));
          }
        }
      }
      for (const st of s.steps) {
        const id = st.node;
        Z.set(nrm[id * 3], nrm[id * 3 + 1], nrm[id * 3 + 2]);
        if (Z.lengthSq() < 1e-12) Z.set(0, 0, 1);
        Z.normalize();
        P(st.next, a); P(st.prev, b);
        X.subVectors(a, b);
        let w = X.length() / (st.next !== id && st.prev !== id ? 2 : 1);
        if (!(w > 1e-6)) w = nodeW(id);
        w = Math.min(w, nodeW(id) * 2.5);
        X.addScaledVector(Z, -X.dot(Z));
        if (X.lengthSq() < 1e-12) X.set(1, 0, 0).addScaledVector(Z, -Z.x);
        X.normalize();
        P(id, C);
        if (st.parent >= 0) up.subVectors(C, where(st.parent, a, C)); else up.crossVectors(Z, X);
        let h = up.length();
        Y.crossVectors(Z, X);
        // keep the strand's direction of travel: a stitch the other way up is seen from its back
        // (a turned row)
        if (Y.dot(up) < 0) { Z.negate(); Y.negate(); }
        if (!(h > 1e-6) || st.parent < 0) h = st.parent < 0 ? w : h;
        if (!(h > 1e-6)) h = w;
        if (st.kind === 'ch') {
          h = w * 0.55;
          U.copy(Y).multiplyScalar(h);
          O.copy(C);
        } else {
          if (st.fan) { h = Math.max(up.dot(Y), h * 0.6); up.copy(Y).multiplyScalar(h); }
          // the stitch stands up from where it is worked; one the solver has dragged sideways (a
          // spiral's rounds slip round a little) leans only part of the way, so its legs stay
          // upright like real ones rather than lying along the row
          if (st.parent >= 0) {
            const along = up.dot(X);
            U.copy(Y).multiplyScalar(Math.max(up.dot(Y), h * 0.5)).addScaledVector(X, st.fan ? 0 : along * 0.3);
          } else U.copy(Y).multiplyScalar(h);
          O.copy(C).addScaledVector(U, -0.5);
        }
        // as wide at the bottom as the stitches it stands on are apart
        let taper = 1;
        if (st.kind !== 'ch' && !st.fan && st.parent >= 0 && st.pp >= 0 && st.np >= 0 && st.prev !== id && st.next !== id) {
          where(st.np, a, P(st.next, up)); where(st.pp, b, P(st.prev, up));
          taper = Math.min(1.5, Math.max(0.3, a.distanceTo(b) / 2 / w));
        }
        // below the stitch: straight on down, under what it is worked into
        Ud.copy(U).normalize();
        const dip = ring && st.parent === ring.centre ? rr * 0.85 : this.radius * 2;
        const map = (x: number, y: number, z: number, xs: number) => {
          q.copy(O).addScaledVector(X, xs * w).addScaledVector(Z, z * w);
          if (y >= 0) q.addScaledVector(U, y - 0.5); else q.addScaledVector(U, -0.5).addScaledVector(Ud, y * dip);
          put(q);
        };
        for (const [x, y, z] of TEMPLATE[st.kind]) map(x, y, z, x * (taper + (1 - taper) * Math.min(1, Math.max(0, y))));
        if (st === s.steps[s.steps.length - 1]) {
          if (s.close) {
            // fasten off: through the front loop of each stitch of the last round, pulled tight,
            // then down through the middle into the piece
            map(0.5, 0.94, 0, 0.5);
            for (const id of s.close) put(q.copy(P(id, a)).lerp(Cc, 0.45).addScaledVector(Nc, -this.radius * 0.5));
            put(q.copy(Cc).addScaledVector(Nc, -this.radius));
            put(q.copy(Cc).addScaledVector(Nc, -this.sizeW * 1.5));
          } else for (const [x, y, z] of END) map(x, y, z, x);
        }
        widths.push(w);
      }
    }
    // the yarn is as thick as the stitches it makes allow: a piece the solver has drawn smaller than
    // its gauge (tight stuffing) gets a strand to match, not fat loops crowding each other
    if (widths.length) {
      widths.sort((x, y) => x - y);
      const mid = widths[widths.length >> 1];
      this.radius = this.baseRadius * Math.min(1, Math.max(0.5, mid / this.sizeW));
    }
    this.sweep();
  }

  /** Sample the control points and sweep a round tube along them. */
  private sweep() {
    const S = this.samples, c = this.ctrl;
    let c0 = 0;
    for (const s of this.strands) {
      const n = s.ctrl;
      for (let i = 0; i < n - 1; i++) {
        const i0 = c0 + Math.max(0, i - 1), i1 = c0 + i, i2 = c0 + i + 1, i3 = c0 + Math.min(n - 1, i + 2);
        for (let k = 0; k < this.sub; k++) catmull(c, i0, i1, i2, i3, k / this.sub, S, (s.s0 + i * this.sub + k) * 3);
      }
      const last = (s.s0 + (n - 1) * this.sub) * 3;
      S[last] = c[(c0 + n - 1) * 3]; S[last + 1] = c[(c0 + n - 1) * 3 + 1]; S[last + 2] = c[(c0 + n - 1) * 3 + 2];
      c0 += n;
    }
    const outs = this.meshes.map(({ mesh, inflate }) => ({
      p: (mesh.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array,
      n: (mesh.geometry.getAttribute('normal') as THREE.BufferAttribute).array as Float32Array,
      r: this.radius * (1 + inflate),
    }));
    const uvAttr = this.meshes[0].mesh.geometry.getAttribute('uv') as THREE.BufferAttribute;
    const uv = uvAttr.array as Float32Array;
    const T = V(), N = V(), B = V(), D = V();
    for (const s of this.strands) {
      const n = (s.ctrl - 1) * this.sub + 1;
      let along = 0;
      for (let i = 0; i < n; i++) {
        const o = (s.s0 + i) * 3;
        const ia = (s.s0 + Math.max(0, i - 1)) * 3, ib = (s.s0 + Math.min(n - 1, i + 1)) * 3;
        T.set(S[ib] - S[ia], S[ib + 1] - S[ia + 1], S[ib + 2] - S[ia + 2]);
        if (T.lengthSq() < 1e-16) T.set(1, 0, 0);
        T.normalize();
        // parallel transport: the frame turns with the strand, without twisting
        if (i === 0) N.set(Math.abs(T.x) < 0.9 ? 1 : 0, Math.abs(T.x) < 0.9 ? 0 : 1, 0);
        N.addScaledVector(T, -N.dot(T));
        if (N.lengthSq() < 1e-12) N.set(T.y, -T.x, 0).addScaledVector(T, 0);
        N.normalize();
        B.crossVectors(T, N);
        if (i > 0) along += Math.hypot(S[o] - S[o - 3], S[o + 1] - S[o - 2], S[o + 2] - S[o - 1]);
        const u = along / (2 * this.radius);
        for (let j = 0; j <= this.rad; j++) {
          const ang = (j / this.rad) * Math.PI * 2;
          D.copy(N).multiplyScalar(Math.cos(ang)).addScaledVector(B, Math.sin(ang));
          const v = s.v0 + i * (this.rad + 1) + j;
          for (const out of outs) {
            out.p[v * 3] = S[o] + D.x * out.r; out.p[v * 3 + 1] = S[o + 1] + D.y * out.r; out.p[v * 3 + 2] = S[o + 2] + D.z * out.r;
            out.n[v * 3] = D.x; out.n[v * 3 + 1] = D.y; out.n[v * 3 + 2] = D.z;
          }
          uv[v * 2] = u; uv[v * 2 + 1] = j / this.rad;
        }
      }
    }
    uvAttr.needsUpdate = true;
    for (const { mesh } of this.meshes) {
      mesh.geometry.getAttribute('position').needsUpdate = true;
      mesh.geometry.getAttribute('normal').needsUpdate = true;
    }
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = 0;
    this.pending = null;
    for (const { mesh } of this.meshes) {
      mesh.geometry.dispose();
      const m = mesh.material as THREE.MeshPhysicalMaterial;
      m.normalMap?.dispose();
      m.alphaMap?.dispose();
      m.dispose();
    }
    this.group.clear();
    this.meshes = [];
    this.strands = [];
  }
}
