import * as THREE from 'three';

/**
 * Procedural, per-yarn stitch textures (spec/yarn-tension-texture.md §3).
 *
 * One texture tile = one stitch: u runs across the stitch, v up one row (UVs follow the stitch graph).
 * Each fiber gets its own look:
 *  - a height field of a single-crochet "V" built from two round yarn legs plus the top loops of the
 *    row below, with ply twist for plied yarns (cotton, acrylic, wool) and none for chenille/velvet;
 *  - a normal map and a cavity (shading) map derived from that height field;
 *  - for fuzzy yarns, a "hair" mask used by a few shell layers above the surface (mohair halo,
 *    wool fuzz, chenille pile).
 */

export interface YarnLook {
  /** Ply count and twist; 0 plies = unplied (chenille, velvet). */
  plies: number;
  twist: number; // twists per stitch length along a leg
  plyDepth: number; // groove depth between plies, 0..1
  legRadius: number; // yarn thickness in tile units (0.5 = touching)
  blur: number; // box-blur passes on the height field (softens stitch definition)
  pile: number; // micro-noise amplitude (velvet pile, fibre texture)
  normalStrength: number;
  cavity: number; // how dark the gaps between stitches get, 0..1
  roughness: number;
  sheen: number;
  sheenRoughness: number;
  sheenTint: number; // brightness of the sheen colour (white would wash out the yarn colour)
  /** Fuzz shells above the surface; count 0 = none. */
  shells: { count: number; length: number; kind: 'none' | 'halo' | 'fuzz' | 'pile'; density: number; opacity: number };
}

export const YARN_LOOKS: Record<string, YarnLook> = {
  // crisp, matte, tightly plied, clearly defined stitches
  cotton: {
    plies: 4, twist: 3.2, plyDepth: 0.5, legRadius: 0.17, blur: 1, pile: 0.02,
    normalStrength: 1.1, cavity: 0.5, roughness: 0.92, sheen: 0.05, sheenRoughness: 0.8, sheenTint: 0.5,
    shells: { count: 0, length: 0, kind: 'none', density: 0, opacity: 1 },
  },
  // plied, slightly soft, small sheen
  acrylic: {
    plies: 3, twist: 2.4, plyDepth: 0.35, legRadius: 0.18, blur: 1, pile: 0.04,
    normalStrength: 1.0, cavity: 0.45, roughness: 0.78, sheen: 0.3, sheenRoughness: 0.5, sheenTint: 0.45,
    shells: { count: 2, length: 0.05, kind: 'fuzz', density: 0.12, opacity: 1 },
  },
  // soft, a little fuzzy, matte with a soft rim
  wool: {
    plies: 2, twist: 1.8, plyDepth: 0.3, legRadius: 0.19, blur: 2, pile: 0.08,
    normalStrength: 0.9, cavity: 0.4, roughness: 0.95, sheen: 0.4, sheenRoughness: 0.7, sheenTint: 0.4,
    shells: { count: 4, length: 0.12, kind: 'fuzz', density: 0.35, opacity: 1 },
  },
  // fat, plush, unplied, strong sheen; stitches read as soft puffs
  chenille: {
    plies: 0, twist: 0, plyDepth: 0, legRadius: 0.23, blur: 3, pile: 0.1,
    normalStrength: 1.2, cavity: 0.65, roughness: 0.7, sheen: 0.7, sheenRoughness: 0.35, sheenTint: 0.3,
    shells: { count: 3, length: 0.06, kind: 'pile', density: 0.35, opacity: 1 },
  },
  velvet: {
    plies: 0, twist: 0, plyDepth: 0, legRadius: 0.22, blur: 2, pile: 0.06,
    normalStrength: 1.2, cavity: 0.6, roughness: 0.6, sheen: 0.7, sheenRoughness: 0.3, sheenTint: 0.3,
    shells: { count: 2, length: 0.035, kind: 'pile', density: 0.4, opacity: 1 },
  },
  // thin core, big airy halo that blurs the stitches
  mohair: {
    plies: 2, twist: 2.0, plyDepth: 0.3, legRadius: 0.13, blur: 3, pile: 0.1,
    normalStrength: 0.6, cavity: 0.3, roughness: 0.95, sheen: 0.5, sheenRoughness: 0.6, sheenTint: 0.4,
    shells: { count: 9, length: 0.45, kind: 'halo', density: 1, opacity: 0.9 },
  },
};

export function yarnLook(fiber: string): YarnLook {
  return YARN_LOOKS[fiber] ?? YARN_LOOKS.acrylic;
}

const S = 128; // stitch tile resolution

/** Small deterministic PRNG so textures look the same on every load. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** Height of one round yarn segment at (u, v); returns [height, along-param, across-param] or null. */
function tube(u: number, v: number, ax: number, ay: number, bx: number, by: number, r: number): [number, number, number] | null {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = ((u - ax) * dx + (v - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const px = ax + dx * t, py = ay + dy * t;
  const ex = u - px, ey = v - py;
  const d = Math.hypot(ex, ey);
  if (d >= r) return null;
  const len = Math.sqrt(len2);
  // signed distance across the tube (which side of the centre line)
  const side = (ex * -dy + ey * dx) / len;
  const q = d / r;
  return [Math.pow(Math.cos((Math.PI / 2) * q), 0.7), t * len, side / r];
}

/** Height field for one sc tile with the given yarn look. Values ≈ 0..1. */
export function stitchHeight(look: YarnLook): Float32Array {
  const hgt = new Float32Array(S * S);
  const r = look.legRadius;
  // segments: [ax, ay, bx, by, radius, depth offset]. Two legs of the "V" plus the top loops of the
  // row below (a horizontal bar at the bottom of the tile, partly hidden behind the legs).
  const segs: [number, number, number, number, number, number][] = [
    [0.5 - 0.07, 0.16, 0.5 - 0.27, 0.86, r, 0],
    [0.5 + 0.07, 0.16, 0.5 + 0.27, 0.86, r, 0],
    [-0.1, 0.0, 1.1, 0.0, r * 0.8, -0.3],
  ];
  const plyPhase = (along: number, across: number) =>
    0.5 - 0.5 * Math.cos(2 * Math.PI * (look.plies * 0.5 * (across + 1) + look.twist * along));
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let best = 0;
      // sample periodic neighbours so the tile wraps cleanly
      for (const ox of [-1, 0, 1]) {
        for (const oy of [-1, 0, 1]) {
          const u = x / S - ox, v = y / S - oy;
          for (const [ax, ay, bx, by, rr, off] of segs) {
            const hit = tube(u, v, ax, ay, bx, by, rr);
            if (!hit) continue;
            let h = hit[0];
            if (look.plies > 0) h *= 1 - look.plyDepth * plyPhase(hit[1], hit[2]) * h;
            h += off;
            if (h > best) best = h;
          }
        }
      }
      hgt[y * S + x] = Math.max(0, best);
    }
  }
  // fibre noise / pile
  if (look.pile > 0) {
    const rand = rng(7 + Math.round(look.legRadius * 1000));
    for (let i = 0; i < hgt.length; i++) hgt[i] += (rand() - 0.5) * look.pile * (0.3 + hgt[i]);
  }
  // fuzzy yarns: soften the stitch shape (wrapping box blur)
  for (let pass = 0; pass < look.blur; pass++) blur(hgt);
  return hgt;
}

function blur(h: Float32Array) {
  const tmp = new Float32Array(h.length);
  const at = (x: number, y: number) => h[((y + S) % S) * S + ((x + S) % S)];
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    tmp[y * S + x] = (at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1) + 2 * at(x, y)) / 6;
  }
  h.set(tmp);
}

function dataTexture(data: Uint8Array, size: number, colorSpace: THREE.ColorSpace = THREE.NoColorSpace): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.colorSpace = colorSpace;
  tex.needsUpdate = true;
  return tex;
}

export interface YarnTextures {
  look: YarnLook;
  normalMap: THREE.Texture;
  /** Greyscale shading multiplied with the yarn colour: darker in the gaps between loops. */
  cavityMap: THREE.Texture;
  /** Hair mask for fuzz shells (value = how far out the hair reaches), or null. */
  hairMap: THREE.Texture | null;
}

const cache = new Map<string, YarnTextures>();

export function yarnTextures(fiber: string): YarnTextures {
  const key = YARN_LOOKS[fiber] ? fiber : 'acrylic';
  const hit = cache.get(key);
  if (hit) return hit;
  const look = yarnLook(key);
  const hgt = stitchHeight(look);
  let max = 0;
  for (const v of hgt) max = Math.max(max, v);
  const at = (x: number, y: number) => hgt[((y + S) % S) * S + ((x + S) % S)] / (max || 1);

  const nrm = new Uint8Array(S * S * 4);
  const cav = new Uint8Array(S * S * 4);
  const k = 2.6 * look.normalStrength;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * k;
      const dy = (at(x, y + 1) - at(x, y - 1)) * k;
      const l = Math.hypot(dx, dy, 1);
      const i = (y * S + x) * 4;
      nrm[i] = ((-dx / l) * 0.5 + 0.5) * 255;
      nrm[i + 1] = ((-dy / l) * 0.5 + 0.5) * 255;
      nrm[i + 2] = ((1 / l) * 0.5 + 0.5) * 255;
      nrm[i + 3] = 255;
      const c = 1 - look.cavity * (1 - Math.pow(Math.max(0, at(x, y)), 0.6));
      cav[i] = cav[i + 1] = cav[i + 2] = Math.round(Math.max(0, Math.min(1, c)) * 255);
      cav[i + 3] = 255;
    }
  }
  const out: YarnTextures = {
    look,
    normalMap: dataTexture(nrm, S),
    cavityMap: dataTexture(cav, S),
    hairMap: look.shells.count > 0 ? hairTexture(look) : null,
  };
  cache.set(key, out);
  return out;
}

/** Hair mask: halo = long crossing strands, fuzz = short sparse strands, pile = dense short tufts. */
function hairTexture(look: YarnLook): THREE.Texture {
  const H = 256;
  const val = new Float32Array(H * H);
  const rand = rng(1234 + look.shells.count);
  const { kind, density } = look.shells;
  if (kind === 'pile') {
    for (let i = 0; i < val.length; i++) {
      if (rand() < density) val[i] = 0.25 + 0.75 * Math.pow(rand(), 0.6);
    }
  } else {
    const strands = Math.round((kind === 'halo' ? 900 : 700) * density);
    for (let s = 0; s < strands; s++) {
      let x = rand() * H, y = rand() * H;
      const a = rand() * Math.PI * 2;
      const len = (kind === 'halo' ? 18 + rand() * 50 : 4 + rand() * 12);
      const reach = 0.2 + 0.8 * rand(); // how far above the surface this hair gets
      let dx = Math.cos(a), dy = Math.sin(a);
      for (let t = 0; t < len; t++) {
        // reach fades toward the hair's tip, so shells thin out with height
        const v = reach * (1 - 0.6 * (t / len));
        const ix = ((Math.round(x) % H) + H) % H, iy = ((Math.round(y) % H) + H) % H;
        val[iy * H + ix] = Math.max(val[iy * H + ix], v);
        // gentle curl
        const turn = (rand() - 0.5) * 0.25;
        [dx, dy] = [dx * Math.cos(turn) - dy * Math.sin(turn), dx * Math.sin(turn) + dy * Math.cos(turn)];
        x += dx; y += dy;
      }
    }
  }
  const data = new Uint8Array(H * H * 4);
  for (let i = 0; i < val.length; i++) {
    const b = Math.round(val[i] * 255);
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  const tex = dataTexture(data, H);
  // hairs are finer than a stitch: repeat the mask a few times per stitch
  tex.repeat.set(kind === 'halo' ? 1.5 : 2.5, kind === 'halo' ? 1.5 : 2.5);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}
