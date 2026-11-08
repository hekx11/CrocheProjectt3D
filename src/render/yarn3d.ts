import * as THREE from 'three';
import type { Model } from '../geometry/pipeline';
import type { YarnLook } from './textures';

/**
 * Stitches built from real 3D yarn (docs/yarn-tension-texture.md §3.1), drawn on top of the solved
 * surface. Every stitch is an instance of a small yarn template (two legs of the "v", the back of
 * the loop, the top chain; taller stitches add the yarn-over wrap), placed in the stitch's own frame:
 * across = along its row, up = from the stitch it was worked into, out = surface normal.
 *
 * The yarn type decides what the strands are made of: twisted plies (cotton, acrylic, wool), a halo
 * of loose fibres (wool, mohair), or a fat plush tube with pile (chenille, velvet / polyester plush).
 * Light then falls on actual strands, which is what makes the materials read differently.
 */

/** Template heights per band, as in the texture atlas: sc, hdc, dc. */
const BAND_F = [1, 1.4, 1.9];
const BAND_OF: Record<string, number> = { sc: 0, ch: 0, slst: 0, hdc: 1, dc: 2, tr: 2, dtr: 2 };

type P3 = [number, number, number];

/** Yarn centre lines of one stitch, in stitch widths (x across, y up from -f/2 to f/2, z out). */
function stitchCurves(f: number): { pts: P3[]; r: number }[] {
  const top = f / 2, bot = -f / 2;
  const R = 1; // radius scale, set by caller
  const out: { pts: P3[]; r: number }[] = [];
  const leg = (s: number, pts: P3[], r = R) => out.push({ pts: pts.map(([x, y, z]) => [x * s, y, z] as P3), r });
  if (f < 1.2) {
    for (const s of [-1, 1]) leg(s, [[0.04, bot + 0.06, 0.0], [0.13, bot + 0.3, 0.2], [0.24, top - 0.3, 0.24], [0.31, top - 0.1, 0.1]]);
  } else if (f < 1.7) {
    for (const s of [-1, 1]) leg(s, [[0.05, bot + 0.06, 0.0], [0.14, bot + 0.4, 0.2], [0.24, top - 0.35, 0.24], [0.3, top - 0.1, 0.1]]);
    // the yarn-over wrapped once across the lower half
    out.push({ pts: [[-0.36, bot + 0.3, 0.05], [-0.15, bot + 0.4, 0.28], [0.15, bot + 0.54, 0.28], [0.36, bot + 0.64, 0.05]], r: R * 0.95 });
  } else {
    for (const s of [-1, 1]) leg(s, [[0.06, bot + 0.06, 0.0], [0.12, bot + 0.45, 0.18], [0.16, 0, 0.2], [0.22, top - 0.4, 0.2], [0.27, top - 0.1, 0.1]]);
    // the wrap bar across the middle of the post
    out.push({ pts: [[-0.3, -0.24, 0.04], [-0.12, -0.12, 0.3], [0.12, 0.06, 0.3], [0.3, 0.18, 0.04]], r: R });
  }
  // the back of the pulled-up loop, deeper between the legs
  out.push({ pts: [[0, bot + 0.12, -0.05], [0, 0, 0.04], [0, top - 0.2, 0.0]], r: R * 0.8 });
  // the top chain: front loop running along the top edge into the neighbours
  out.push({ pts: [[-0.56, top - 0.06, 0.0], [-0.3, top - 0.02, 0.14], [0, top + 0.0, 0.17], [0.3, top - 0.04, 0.14], [0.56, top - 0.1, 0.0]], r: R * 0.9 });
  return out;
}

/** Merge tubes along the curves; uv.x counts yarn diameters along the strand so plies keep their pitch. */
function template(f: number, radius: number, inflate = 0): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (const c of stitchCurves(f)) {
    const curve = new THREE.CatmullRomCurve3(c.pts.map((p) => new THREE.Vector3(...p)), false, 'centripetal');
    const r = radius * c.r * (1 + inflate);
    const g = new THREE.TubeGeometry(curve, 12, r, 8, false);
    const len = curve.getLength();
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < uv.count; i++) uv.setX(i, (uv.getX(i) * len) / (2 * radius));
    parts.push(g);
  }
  return mergeGeometries(parts);
}

function mergeGeometries(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let nv = 0, ni = 0;
  for (const g of parts) { nv += g.getAttribute('position').count; ni += g.index!.count; }
  const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  const idx = new Uint32Array(ni);
  let ov = 0, oi = 0;
  for (const g of parts) {
    const n = g.getAttribute('position').count;
    pos.set(g.getAttribute('position').array as Float32Array, ov * 3);
    nrm.set(g.getAttribute('normal').array as Float32Array, ov * 3);
    uv.set(g.getAttribute('uv').array as Float32Array, ov * 2);
    const gi = g.index!.array;
    for (let k = 0; k < gi.length; k++) idx[oi + k] = gi[k] + ov;
    ov += n; oi += gi.length;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/**
 * Normal map for the strand surface. s (along, in diameters) × t (around the strand).
 * Plied yarn: helical grooves between plies plus fine fibre lines along each ply.
 * Unplied plush: dense pile noise.
 */
function strandNormalMap(look: YarnLook): THREE.DataTexture {
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

interface Inst { node: number; parent: number; prev: number; next: number }

export class Yarn3D {
  readonly group = new THREE.Group();
  private bands: { mesh: THREE.InstancedMesh; shells: THREE.InstancedMesh[]; insts: Inst[] }[] = [];
  private nodeSlot = new Map<number, [number, number]>(); // node → [band, index]

  build(model: Model, look: YarnLook) {
    this.dispose();
    const g = model.graph;
    const nodes = g.nodes;
    const parent = new Int32Array(nodes.length).fill(-1);
    for (const e of g.edges) if (e.kind === 'into' && parent[e.b] < 0) parent[e.b] = e.a;
    // a first round's stitches stand on the ring centre (16 dc in a ring reach right across)
    for (const e of g.edges) if (e.kind === 'ring' && parent[e.b] < 0) parent[e.b] = e.a;
    const insts: Inst[][] = [[], [], []];
    for (const pi of g.instances) {
      for (const row of pi.rows) {
        const ids = row.nodes;
        ids.forEach((id, j) => {
          const n = nodes[id];
          if (n.virtual || n.type === 'ch' && row.row === 0) return;
          const band = BAND_OF[n.type] ?? 0;
          const prev = j > 0 ? ids[j - 1] : row.closed ? ids[ids.length - 1] : id;
          const next = j < ids.length - 1 ? ids[j + 1] : row.closed ? ids[0] : id;
          insts[band].push({ node: id, parent: parent[id], prev, next });
        });
      }
    }
    // yarn radius in stitch widths: fat next to the stitch (tight amigurumi); plush yarn fatter
    const radius = look.plies > 0 ? 0.19 + look.legRadius * 0.2 : 0.24 + look.legRadius * 0.2;
    const nmap = strandNormalMap(look);
    const fmask = look.shells.count > 0 ? fibreMask(look) : null;
    insts.forEach((list, band) => {
      if (!list.length) return;
      const geo = template(BAND_F[band], radius);
      const mat = new THREE.MeshPhysicalMaterial({
        roughness: look.roughness,
        sheen: look.sheen,
        sheenRoughness: look.sheenRoughness,
        sheenColor: new THREE.Color().setScalar(look.sheenTint),
        normalMap: nmap,
        normalScale: new THREE.Vector2(1, 1),
      });
      const mesh = new THREE.InstancedMesh(geo, mat, list.length);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.raycast = () => {};
      this.group.add(mesh);
      const shells: THREE.InstancedMesh[] = [];
      if (fmask) {
        const count = Math.min(2, look.shells.count);
        for (let k = 0; k < count; k++) {
          const f = (k + 1) / (count + 1);
          const reach = (look.shells.kind === 'halo' ? 2.4 : look.shells.kind === 'pile' ? 0.5 : 1.0) * look.shells.length / 0.1;
          const sg = template(BAND_F[band], radius, Math.min(1.2, reach * f));
          const sm = new THREE.MeshPhysicalMaterial({
            roughness: 1, sheen: look.sheen * 0.6, sheenRoughness: look.sheenRoughness,
            sheenColor: new THREE.Color().setScalar(look.sheenTint),
            alphaMap: fmask, alphaTest: Math.min(0.95, 0.15 + f * 0.8), side: THREE.DoubleSide,
          });
          sm.color.setScalar(1 + 0.12 * f);
          const s = new THREE.InstancedMesh(sg, sm, list.length);
          s.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
          s.frustumCulled = false;
          s.raycast = () => {};
          s.renderOrder = 1 + k;
          this.group.add(s);
          shells.push(s);
        }
      }
      list.forEach((it, i) => this.nodeSlot.set(it.node, [this.bands.length, i]));
      this.bands.push({ mesh, shells, insts: list });
    });
  }

  /** Per-node linear colours (RGB triplets indexed by node id). */
  setColors(color: (node: number) => THREE.Color) {
    for (const b of this.bands) {
      b.insts.forEach((it, i) => {
        const c = color(it.node);
        b.mesh.setColorAt(i, c);
        for (const s of b.shells) s.setColorAt(i, c);
      });
      if (b.mesh.instanceColor) b.mesh.instanceColor.needsUpdate = true;
      for (const s of b.shells) if (s.instanceColor) s.instanceColor.needsUpdate = true;
    }
  }

  update(pos: Float32Array, nrm: Float32Array, nodeW: (id: number) => number) {
    const m = new THREE.Matrix4();
    const X = new THREE.Vector3(), Y = new THREE.Vector3(), Z = new THREE.Vector3(), C = new THREE.Vector3();
    const P = (id: number, v: THREE.Vector3) => v.set(pos[id * 3], pos[id * 3 + 1], pos[id * 3 + 2]);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), up = new THREE.Vector3();
    this.bands.forEach((band, bi) => {
      const f = BAND_F[bi];
      band.insts.forEach((it, i) => {
        const id = it.node;
        Z.set(nrm[id * 3], nrm[id * 3 + 1], nrm[id * 3 + 2]).normalize();
        P(it.next, a); P(it.prev, b);
        X.subVectors(a, b);
        let w = X.length() / (it.next !== id && it.prev !== id ? 2 : 1);
        if (!(w > 1e-6)) w = nodeW(id);
        X.addScaledVector(Z, -X.dot(Z)).normalize();
        P(id, C);
        if (it.parent >= 0) { P(it.parent, a); up.subVectors(C, a); } else up.copy(Y.crossVectors(Z, X));
        let h = up.length();
        Y.crossVectors(Z, X);
        if (Y.dot(up) < 0) { X.negate(); Y.negate(); }
        if (!(h > 1e-6)) h = w;
        // centre between this stitch's top and the stitch below it
        if (it.parent >= 0) C.addScaledVector(up, -0.5);
        m.makeBasis(X.multiplyScalar(w), Y.multiplyScalar(h / f), Z.multiplyScalar(w));
        m.setPosition(C);
        band.mesh.setMatrixAt(i, m);
        for (const s of band.shells) s.setMatrixAt(i, m);
      });
      band.mesh.instanceMatrix.needsUpdate = true;
      for (const s of band.shells) s.instanceMatrix.needsUpdate = true;
    });
  }

  dispose() {
    for (const b of this.bands) {
      for (const o of [b.mesh, ...b.shells]) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    }
    this.group.clear();
    this.bands = [];
    this.nodeSlot.clear();
  }
}
