import type { Pattern, PieceDef, StitchType } from '../model/types';
import { FIBERS, STITCH_HEIGHT, WEIGHT_DEFAULTS } from '../model/dictionary';

/** User-adjustable settings (Materials panel). */
export interface UserMaterials {
  tension: 'tight' | 'normal' | 'loose';
  hookMm?: number;
  weight?: number;
  fiber?: string;
  scWidthMm?: number; // "my gauge"
  scHeightMm?: number;
}

export interface Sizing {
  w: number; // sc width (mm)
  h: number; // sc height (mm)
  source: string;
  fiber: string;
  stiffness: number;
  fuzz: number;
  sheen: number;
  roughness: number;
}

/** Thickness of the fabric (mm). The mesh is the fabric's mid-surface, so this is what a flat piece adds edge-on. */
export function fabricThickness(sz: Pick<Sizing, 'h'>): number {
  return 0.6 * sz.h;
}

const TENSION_DELTA = { tight: -0.75, normal: 0, loose: 0.5 };

function mm(m: { value: number; unit: string }): number {
  return m.unit === 'cm' ? m.value * 10 : m.unit === 'mm' ? m.value : m.value * 25.4;
}

/** Yarn diameter implied by the Craft Yarn Council table (so the hook formula reproduces it). */
function yarnDiameter(weight: number): number {
  const d = WEIGHT_DEFAULTS[weight] ?? WEIGHT_DEFAULTS[4];
  return (d.w - 0.8 * d.hook) / 1.4;
}

export function heightFactor(type: StitchType, tension: number, loop: string): number {
  let f = STITCH_HEIGHT[type];
  if (type === 'slst' && tension > 1) f = 0.5; // a loose sl st round is about half an sc tall
  else f *= tension;
  if (loop === 'FLO') f *= 1.12;
  return f;
}

export function widthFactor(type: StitchType, tension: number): number {
  if (type === 'ch') return 0.75;
  if (type === 'slst') return tension > 1 ? 1.0 : 0.9;
  return tension > 1 ? 1.08 : tension < 1 ? 0.92 : 1;
}

/** Pick stitch size from the best available source (spec/yarn-tension-texture.md §1). */
export function computeSizing(p: Pattern, user: UserMaterials): Sizing {
  const mat = p.materials;
  const fiberName = user.fiber ?? mat.fiber ?? mat.yarns[0]?.fiber ?? 'acrylic';
  const fiber = FIBERS[fiberName] ?? FIBERS.acrylic;
  const ratio = fiberName === 'chenille' || fiberName === 'velvet' ? 0.68 : 0.85;
  const base = { fiber: fiberName, stiffness: fiber.stiffness, fuzz: fiber.fuzz, sheen: fiber.sheen, roughness: fiber.roughness };

  if (user.scWidthMm) {
    return { ...base, w: user.scWidthMm, h: user.scHeightMm ?? user.scWidthMm * ratio, source: 'your gauge' };
  }
  const g = mat.gauge;
  if (g && g.kind === 'grid' && g.stitches > 0) {
    const span = mm(g.over);
    const w = span / g.stitches;
    const h = g.rows > 0 ? mm(g.overRows ?? g.over) / g.rows / STITCH_HEIGHT[g.stitch === 'sc' ? 'sc' : g.stitch] : w * ratio;
    return { ...base, w, h, source: `pattern gauge (${g.stitches} sts${g.rows ? ` × ${g.rows} rows` : ''} = ${g.over.value} ${g.over.unit})` };
  }
  if (g && g.kind === 'rounds') {
    const D = mm(g.diameter);
    const h = D / (2 * g.rounds);
    const w = (Math.PI * D) / (6 * g.rounds);
    return { ...base, w, h, source: `pattern gauge (rounds 1–${g.rounds} = ${g.diameter.value} ${g.diameter.unit})` };
  }
  const fit = fitFinishedSize(p, ratio);
  if (fit) return { ...base, ...fit };

  const weight = user.weight ?? mat.weight ?? 4;
  const def = WEIGHT_DEFAULTS[weight] ?? WEIGHT_DEFAULTS[4];
  const amigurumi = p.pieces.some((pc) => pc.construction !== 'rows' && pc.stuffing !== 'none');
  const hook = user.hookMm ?? mat.hookMm;
  if (hook) {
    const w = 0.8 * (hook + TENSION_DELTA[user.tension]) + 1.4 * yarnDiameter(weight);
    return { ...base, w, h: w * ratio, source: `hook ${hook} mm + yarn weight ${weight}` };
  }
  const h0 = def.hook - (amigurumi ? 1.5 : 0) + TENSION_DELTA[user.tension];
  const w = 0.8 * h0 + 1.4 * yarnDiameter(weight);
  return { ...base, w, h: w * ratio, source: mat.weight !== undefined ? `yarn weight ${weight} defaults` : 'defaults (weight 4 yarn)' };
}

/** Fit stitch size so the main piece matches a stated finished length + diameter. */
function fitFinishedSize(p: Pattern, ratio: number): Omit<Sizing, 'fiber' | 'stiffness' | 'fuzz' | 'sheen' | 'roughness'> | null {
  const mat = p.materials;
  if (!mat.finishedDiameter && !mat.finishedLength && !mat.finishedWidth) return null;
  const main = [...p.pieces].sort((a, b) => totalSts(b) - totalSts(a))[0];
  if (!main || main.construction === 'rows') return null;
  const counts = main.rows.map((r) => r.computedCount);
  const n = Math.max(...counts);
  const factors = main.rows.map((r) => avgHeightFactor(r));
  const D = mat.finishedDiameter ? mm(mat.finishedDiameter) : mat.finishedWidth ? mm(mat.finishedWidth) : undefined;
  const L = mat.finishedLength ? mm(mat.finishedLength) : undefined;
  let w = D ? (Math.PI * D) / n : 0;
  let h = w * ratio;
  if (D && L) {
    // bisection on h, with w depending on fabric thickness (≈ 0.6 h)
    let lo = 0.5, hi = 60;
    for (let it = 0; it < 60; it++) {
      h = (lo + hi) / 2;
      w = (Math.PI * (D - fabricThickness({ h }))) / n;
      let len = 0;
      for (let i = 0; i < counts.length; i++) {
        const dR = i === 0 ? (counts[0] * w) / (2 * Math.PI) : ((counts[i] - counts[i - 1]) * w) / (2 * Math.PI);
        const hi_ = h * factors[i];
        len += Math.sqrt(Math.max(0, hi_ * hi_ - dR * dR));
      }
      // end caps add roughly their radius-to-thickness bulge; ignore
      if (len > L) hi = h; else lo = h;
    }
  } else if (L && !D) {
    const sum = factors.reduce((a, b) => a + b, 0);
    h = L / sum;
    w = h / ratio;
  } else if (D) {
    w = (Math.PI * D) / n;
    h = w * ratio;
  }
  const parts = [L ? `${mat.finishedLength!.value}${mat.finishedLength!.unit === 'in' ? '″' : ' ' + mat.finishedLength!.unit} long` : '', D ? `${(mat.finishedDiameter ?? mat.finishedWidth)!.value}${(mat.finishedDiameter ?? mat.finishedWidth)!.unit === 'in' ? '″' : ' ' + (mat.finishedDiameter ?? mat.finishedWidth)!.unit} across` : ''].filter(Boolean);
  return { w, h, source: `fitted to finished size (${parts.join(', ')})` };
}

function totalSts(p: PieceDef): number {
  return p.rows.reduce((a, r) => a + r.computedCount, 0);
}

function avgHeightFactor(r: PieceDef['rows'][number]): number {
  // first stitch op decides the row height (good enough for fitting)
  const first = findStitch(r.ops);
  return first ? heightFactor(first.type, first.tension, first.loop) : 1;
}

function findStitch(ops: any[]): any {
  for (const o of ops) {
    if (o.kind === 'stitch' && o.type !== 'ch') return o;
    if (o.kind === 'evenly') return { type: o.stitch, tension: o.tension, loop: o.loop };
    if (o.kind === 'repeat') { const f = findStitch(o.ops); if (f) return f; }
  }
  return null;
}
