import * as THREE from 'three';

let cached: THREE.Texture | null = null;

/**
 * Procedural normal map for one single-crochet stitch: a "V" of two plump legs.
 * One texture tile = one stitch (UVs follow the stitch grid).
 */
export function stitchNormalMap(): THREE.Texture {
  if (cached) return cached;
  const S = 64;
  const hgt = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S;
      // two legs leaning toward the centre at the bottom of the stitch
      const legL = 0.5 - 0.22 * (1 - v) - 0.04;
      const legR = 0.5 + 0.22 * (1 - v) + 0.04;
      const dL = (u - legL) / 0.13, dR = (u - legR) / 0.13;
      const bump = Math.exp(-dL * dL) + Math.exp(-dR * dR);
      const rowGroove = Math.pow(Math.sin(Math.PI * v), 0.6);
      hgt[y * S + x] = bump * rowGroove;
    }
  }
  const data = new Uint8Array(S * S * 4);
  const at = (x: number, y: number) => hgt[((y + S) % S) * S + ((x + S) % S)];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 2.2;
      const dy = (at(x, y + 1) - at(x, y - 1)) * 2.2;
      const l = Math.hypot(dx, dy, 1);
      const i = (y * S + x) * 4;
      data[i] = ((-dx / l) * 0.5 + 0.5) * 255;
      data[i + 1] = ((-dy / l) * 0.5 + 0.5) * 255;
      data[i + 2] = ((1 / l) * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  cached = tex;
  return tex;
}
