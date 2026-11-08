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
  relief: number; // real surface relief (displacement), as a fraction of sc width
  /** Fuzz shells above the surface; count 0 = none. */
  shells: { count: number; length: number; kind: 'none' | 'halo' | 'fuzz' | 'pile'; density: number; opacity: number };
}

export const YARN_LOOKS: Record<string, YarnLook> = {
  // crisp, matte, tightly plied, clearly defined stitches
  cotton: {
    plies: 4, twist: 2.0, plyDepth: 0.25, legRadius: 0.21, blur: 2, pile: 0.02,
    normalStrength: 1.25, cavity: 0.55, roughness: 0.92, sheen: 0.05, sheenRoughness: 0.8, sheenTint: 0.5, relief: 0.2,
    shells: { count: 2, length: 0.04, kind: 'fuzz', density: 0.12, opacity: 1 },
  },
  // milk cotton: soft, plump, matte with a faint sheen and a light fuzz (very common for amigurumi)
  'milk cotton': {
    plies: 4, twist: 1.6, plyDepth: 0.2, legRadius: 0.22, blur: 3, pile: 0.05,
    normalStrength: 0.8, cavity: 0.4, roughness: 0.85, sheen: 0.35, sheenRoughness: 0.6, sheenTint: 0.45, relief: 0.22,
    shells: { count: 2, length: 0.06, kind: 'fuzz', density: 0.2, opacity: 1 },
  },
  // plied, slightly soft, small sheen
  acrylic: {
    plies: 3, twist: 1.8, plyDepth: 0.22, legRadius: 0.2, blur: 2, pile: 0.04,
    normalStrength: 1.15, cavity: 0.55, roughness: 0.78, sheen: 0.3, sheenRoughness: 0.5, sheenTint: 0.45, relief: 0.2,
    shells: { count: 3, length: 0.07, kind: 'fuzz', density: 0.3, opacity: 1 },
  },
  // soft, a little fuzzy, matte with a soft rim
  wool: {
    plies: 2, twist: 1.4, plyDepth: 0.25, legRadius: 0.19, blur: 3, pile: 0.08,
    normalStrength: 0.8, cavity: 0.4, roughness: 0.95, sheen: 0.4, sheenRoughness: 0.7, sheenTint: 0.4, relief: 0.2,
    shells: { count: 4, length: 0.12, kind: 'fuzz', density: 0.35, opacity: 1 },
  },
  // fat, plush, unplied, strong sheen; stitches read as soft puffs
  chenille: {
    plies: 0, twist: 0, plyDepth: 0, legRadius: 0.24, blur: 2, pile: 0.12,
    normalStrength: 1.0, cavity: 0.7, roughness: 0.85, sheen: 0.6, sheenRoughness: 0.4, sheenTint: 0.35, relief: 0.32,
    shells: { count: 6, length: 0.16, kind: 'pile', density: 0.9, opacity: 1 },
  },
  velvet: {
    plies: 0, twist: 0, plyDepth: 0, legRadius: 0.22, blur: 2, pile: 0.06,
    normalStrength: 1.0, cavity: 0.6, roughness: 0.7, sheen: 0.7, sheenRoughness: 0.3, sheenTint: 0.35, relief: 0.28,
    shells: { count: 5, length: 0.12, kind: 'pile', density: 0.95, opacity: 1 },
  },
  // thin core, big airy halo that blurs the stitches
  mohair: {
    plies: 2, twist: 2.0, plyDepth: 0.3, legRadius: 0.13, blur: 3, pile: 0.1,
    normalStrength: 0.6, cavity: 0.3, roughness: 0.95, sheen: 0.5, sheenRoughness: 0.6, sheenTint: 0.4, relief: 0.12,
    shells: { count: 9, length: 0.45, kind: 'halo', density: 1, opacity: 0.9 },
  },
};

export function yarnLook(fiber: string): YarnLook {
  return YARN_LOOKS[fiber] ?? YARN_LOOKS.acrylic;
}

/**
 * The texture tile covers TS stitches × TR rows so the stitches can vary a little (no wallpaper look)
 * and alternate rows sit half a stitch over, the way sc rounds stack in real fabric. TS = 6 because
 * most round counts are multiples of 6, so the tile wraps around a round without a seam.
 */
export const TS = 6;
export const TR = 2;
const P = 80; // pixels per stitch / per row
/**
 * Taller stitches look different, so the texture is an atlas of bands stacked in v, each TS × TR
 * stitches: band 0 = sc (also ch/slst), 1 = hdc, 2 = dc (also tr/dtr). The scene picks the band per
 * triangle from the stitch type of the row it belongs to.
 */
export const BANDS = 3;
export const STITCH_BAND: Record<string, number> = { sc: 0, ch: 0, slst: 0, ring: 0, hdc: 1, dc: 2, tr: 2, dtr: 2 };
/** Height of each band's stitch relative to sc (matches the solver's height factors roughly). */
const BAND_HEIGHT = [1, 1.4, 1.9];
const W = TS * P, BH = TR * P, H = BANDS * BH;

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
  const side = (ex * -dy + ey * dx) / len;
  const q = d / r;
  return [Math.pow(Math.cos((Math.PI / 2) * q), 0.7), t * len, side / r];
}

interface Cell { cu: number; cv: number; scale: number; tilt: number }

/**
 * One stitch, built from how it is formed (docs/yarn-tension-texture.md §3.1). Everything is round
 * plied strands. f = stitch height / sc height; the cell is drawn in real proportions (y runs
 * -f/2..f/2) and squeezed into the tile, so the strands stay round once the tall row stretches it.
 *
 * sc (f = 1):
 *  - the two legs of the "v" are the loop pulled up through the stitch below; the point sits where
 *    the hook went in, the arms reach up to this stitch's own top chain;
 *  - the back of that loop shows a little deeper between the legs;
 *  - the top chain (front loop) runs along the top edge, lower than the legs and mostly covered by
 *    the next round, which gives the groove between rounds;
 *  - the yarn is fat next to the stitch (tight amigurumi), so strands press together and only small
 *    real holes are left (stuffing shows dark through them); spiral rounds lean the v a little.
 * hdc (f = 1.4): the yarn-over wraps the post once, so a taller v has one slanted strand across its
 *   lower half; the third loop sits behind the top chain on the back.
 * dc (f = 1.9): a tall post of two near-parallel legs with the yarn-over wrap as a slanted bar
 *   across the middle, and the top chain v above it.
 */
function vStitch(look: YarnLook, lu: number, lv: number, f: number): number {
  const r = 0.24 + look.legRadius * 0.35; // strand radius in stitch widths (≈ 0.31): fat, soft yarn
  // spiral slant: the stitch sits a little further along than the one below
  const x = lu - 0.1 * lv, y = lv * f;
  const top = f / 2, bot = -f / 2;
  let best = 0;
  const strand = (ax: number, ay: number, bx: number, by: number, rr: number, depth: number) => {
    const hit = tube(x, y, ax, ay, bx, by, rr);
    if (!hit) return;
    let h = hit[0];
    if (look.plies > 0) {
      // plies wind around the strand: diagonal stripes along it (about one turn per two diameters)
      const ph = 0.5 - 0.5 * Math.cos(2 * Math.PI * (look.plies * 0.5 * (hit[2] + 1) + (hit[1] / (4 * rr)) * look.twist * 0.5));
      h *= 1 - look.plyDepth * ph;
    }
    best = Math.max(best, h * depth);
  };
  if (f < 1.2) {
    // sc: the two legs of the v, point where the hook went into the row below
    strand(-0.04, bot + 0.12, -0.3, top - 0.18, r, 1);
    strand(0.04, bot + 0.12, 0.3, top - 0.18, r, 1);
    strand(0, bot + 0.2, 0, top - 0.2, r * 0.8, 0.6); // back of the loop
  } else if (f < 1.7) {
    // hdc: a taller v (legs a little steeper) with the yarn-over wrapped across its lower half
    strand(-0.06, bot + 0.12, -0.3, top - 0.18, r, 0.92);
    strand(0.06, bot + 0.12, 0.3, top - 0.18, r, 0.92);
    strand(0, bot + 0.2, 0, top - 0.2, r * 0.8, 0.55);
    strand(-0.2, bot + 0.26, 0.2, bot + 0.58, r * 0.95, 1);
  } else {
    // dc: a narrower post of near-parallel legs (dc fabric is a little more open between posts);
    // lower legs = the loop pulled through the stitch below, upper legs reach up to the top chain
    const mid = 0, rp = r * 0.9;
    strand(-0.06, bot + 0.14, -0.13, mid, rp, 0.88);
    strand(0.06, bot + 0.14, 0.13, mid, rp, 0.88);
    strand(-0.13, mid, -0.24, top - 0.2, rp, 0.92);
    strand(0.13, mid, 0.24, top - 0.2, rp, 0.92);
    strand(0, bot + 0.2, 0, top - 0.2, r * 0.8, 0.5);
    // the yarn-over wrap: a slanted bar across the middle of the post, on top of the legs
    strand(-0.2, mid - 0.24, 0.2, mid + 0.18, r, 1.08);
  }
  // the top chain: this stitch's front loop runs along the top edge, slanting like a chain link
  // (the next row's legs cover most of it)
  strand(-0.46, top - 0.04, 0.44, top - 0.1, r * 0.6, 0.45);
  return best;
}

/**
 * One stitch in a thick unplied yarn (chenille, velvet): the legs merge into one plump rounded
 * "pebble", with only a soft dent where the V splits at the top. Taller stitches are taller
 * pebbles with a slanted crease where the yarn-over wraps the post.
 */
function puffStitch(look: YarnLook, lu: number, lv: number, f: number): number {
  const rx = 0.36 + look.legRadius, ry = 0.4 + look.legRadius;
  const q2 = (lu / rx) ** 2 + (lv / ry) ** 2;
  if (q2 >= 1) return 0;
  let h = Math.pow(1 - q2, 0.45);
  // the V: a soft groove from the top edge toward the middle
  const top = Math.max(0, Math.min(1, (lv + 0.05) / 0.45));
  h *= 1 - 0.32 * Math.exp(-((lu / 0.07) ** 2)) * top;
  if (f > 1.2) {
    // the yarn-over: a slanted crease across the post (lower on hdc, the middle on dc)
    const at = f < 1.7 ? -0.16 : -0.02;
    h *= 1 - 0.3 * Math.exp(-(((lv - at - 0.3 * lu) * f / 0.09) ** 2));
  }
  return h;
}

/**
 * Height field for the whole atlas (all bands, each TS stitches × TR rows) with the given yarn look.
 * Values ≈ 0..1.
 */
export function stitchHeight(look: YarnLook): Float32Array {
  const out = new Float32Array(W * H);
  for (let b = 0; b < BANDS; b++) out.set(bandHeight(look, BAND_HEIGHT[b], b), b * W * BH);
  return out;
}

function bandHeight(look: YarnLook, f: number, band: number): Float32Array {
  const rand = rng(99 + Math.round(look.legRadius * 1000) + band * 7);
  const cells: Cell[] = [];
  for (let j = 0; j < TR; j++) {
    for (let i = 0; i < TS; i++) {
      cells.push({
        cu: i + 0.5 + (look.plies > 0 ? 0 : (j % 2) * 0.5) + (rand() - 0.5) * 0.12,
        cv: j + 0.5 + (rand() - 0.5) * 0.06,
        scale: 1 + (rand() - 0.5) * 0.16,
        // spiral rounds make the stitches lean a little (tall stitches stretch, so lean less)
        tilt: (0.1 + (rand() - 0.5) * 0.25) / f,
      });
    }
  }
  const shape = look.plies > 0 ? vStitch : puffStitch;
  const hgt = new Float32Array(W * BH);
  for (let y = 0; y < BH; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / P, v = (y + 0.5) / P;
      let best = 0;
      for (const c of cells) {
        // nearest periodic copy of this cell
        let du = u - c.cu, dv = v - c.cv;
        du -= Math.round(du / TS) * TS;
        dv -= Math.round(dv / TR) * TR;
        if (Math.abs(du) > 1 || Math.abs(dv) > 1) continue;
        const ct = Math.cos(c.tilt), st = Math.sin(c.tilt);
        const lu = (du * ct - dv * st) / c.scale, lv = (du * st + dv * ct) / c.scale;
        const h = shape(look, lu, lv, f);
        if (h > best) best = h;
      }
      hgt[y * W + x] = Math.max(0, best);
    }
  }
  if (look.pile > 0) {
    for (let i = 0; i < hgt.length; i++) hgt[i] += (rand() - 0.5) * look.pile * hgt[i]; // fibre noise only on yarn, not in the holes
  }
  for (let pass = 0; pass < look.blur; pass++) blur(hgt);
  return hgt;
}

/** Box blur over one band (wraps within the band). */
function blur(h: Float32Array) {
  const tmp = new Float32Array(h.length);
  const at = (x: number, y: number) => h[((y + BH) % BH) * W + ((x + W) % W)];
  for (let y = 0; y < BH; y++) for (let x = 0; x < W; x++) {
    tmp[y * W + x] = (at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1) + 2 * at(x, y)) / 6;
  }
  h.set(tmp);
}

function dataTexture(data: Uint8Array, colorSpace: THREE.ColorSpace = THREE.NoColorSpace): THREE.DataTexture {
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.colorSpace = colorSpace;
  // UVs count stitches and rows; one tile spans TS stitches × (BANDS × TR) rows
  tex.repeat.set(1 / TS, 1 / (BANDS * TR));
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
  /** Smoothed stitch height for real displacement of the tessellated surface (0..1). */
  reliefMap: THREE.Texture;
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
  // neighbours wrap within the band of the pixel being shaded, so bands don't bleed into each other
  let band0 = 0;
  const at = (x: number, y: number) => hgt[(band0 + ((y - band0 + BH) % BH)) * W + ((x + W) % W)] / (max || 1);

  const nrm = new Uint8Array(W * H * 4);
  const cav = new Uint8Array(W * H * 4);
  const k = (P / 64) * 2.6 * look.normalStrength;
  for (let y = 0; y < H; y++) {
    band0 = Math.floor(y / BH) * BH;
    for (let x = 0; x < W; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * k;
      const dy = (at(x, y + 1) - at(x, y - 1)) * k;
      const l = Math.hypot(dx, dy, 1);
      const i = (y * W + x) * 4;
      nrm[i] = ((-dx / l) * 0.5 + 0.5) * 255;
      nrm[i + 1] = ((-dy / l) * 0.5 + 0.5) * 255;
      nrm[i + 2] = ((1 / l) * 0.5 + 0.5) * 255;
      nrm[i + 3] = 255;
      // only the real gaps go dark; the loops themselves stay lit right to their edges
      // plied stitches: only the real holes go dark, loops stay lit to their edges;
      // plush puffs: shade gradually toward the crevices so each bump reads
      const hv = Math.max(0, Math.min(1, at(x, y) / 0.35));
      const c = look.plies > 0
        ? 1 - look.cavity * (1 - hv * hv * (3 - 2 * hv))
        : 1 - look.cavity * (1 - Math.pow(Math.max(0, at(x, y)), 0.6));
      cav[i] = cav[i + 1] = cav[i + 2] = Math.round(Math.max(0, Math.min(1, c)) * 255);
      cav[i + 3] = 255;
    }
  }
  const out: YarnTextures = {
    look,
    normalMap: dataTexture(nrm),
    cavityMap: dataTexture(cav),
    hairMap: look.shells.count > 0 ? hairTexture(look, hgt, max) : null,
    reliefMap: reliefTexture(hgt, max),
  };
  cache.set(key, out);
  return out;
}

/**
 * Displacement map: the height field averaged down 4× (vertex shaders sample without mipmaps, so
 * fine pile noise would otherwise shimmer) on the same tile layout.
 */
function reliefTexture(hgt: Float32Array, max: number): THREE.Texture {
  const D = 4, w = W / D, h = H / D;
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let dy = 0; dy < D; dy++) for (let dx = 0; dx < D; dx++) sum += hgt[(y * D + dy) * W + x * D + dx];
    const v = Math.round(Math.max(0, Math.min(1, sum / (D * D) / (max || 1))) * 255);
    const i = (y * w + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = v;
    data[i + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.repeat.set(1 / TS, 1 / (BANDS * TR));
  tex.needsUpdate = true;
  return tex;
}

/**
 * Hair mask on the same tile as the stitches. pile = dense short tufts that follow the stitch bumps
 * (the shells then act like real relief: crevices stay empty and dark); fuzz = short sparse strands;
 * halo = long crossing strands that ignore the stitch shape.
 */
function hairTexture(look: YarnLook, hgt: Float32Array, max: number): THREE.Texture {
  const val = new Float32Array(W * H);
  const rand = rng(1234 + look.shells.count);
  const { kind, density } = look.shells;
  const hAt = (i: number) => Math.max(0, hgt[i] / (max || 1));
  if (kind === 'pile') {
    for (let i = 0; i < val.length; i++) {
      if (rand() < density) val[i] = Math.pow(hAt(i), 1.3) * (0.75 + 0.25 * rand());
    }
  } else {
    const strands = Math.round((kind === 'halo' ? 2600 : 1800) * density);
    for (let s = 0; s < strands; s++) {
      let x = rand() * W, y = rand() * H;
      const a = rand() * Math.PI * 2;
      const len = kind === 'halo' ? 14 + rand() * 40 : 3 + rand() * 9;
      const root = hAt(Math.floor(y) * W + Math.floor(x));
      const reach = (0.2 + 0.8 * rand()) * (kind === 'fuzz' ? 0.4 + 0.6 * root : 1);
      let dx = Math.cos(a), dy = Math.sin(a);
      for (let t = 0; t < len; t++) {
        const v = reach * (1 - 0.6 * (t / len));
        const ix = ((Math.round(x) % W) + W) % W, iy = ((Math.round(y) % H) + H) % H;
        val[iy * W + ix] = Math.max(val[iy * W + ix], v);
        const turn = (rand() - 0.5) * 0.25;
        [dx, dy] = [dx * Math.cos(turn) - dy * Math.sin(turn), dx * Math.sin(turn) + dy * Math.cos(turn)];
        x += dx; y += dy;
      }
    }
  }
  const data = new Uint8Array(W * H * 4);
  for (let i = 0; i < val.length; i++) {
    const b = Math.round(Math.min(1, val[i]) * 255);
    data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  const tex = dataTexture(data);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}
