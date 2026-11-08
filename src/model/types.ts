// Shared pattern model (see spec/pattern-model.md).
// Text is the single source of truth; everything here is derived from it.

export type Span = { from: number; to: number };

export type StitchType = 'ch' | 'slst' | 'sc' | 'hdc' | 'dc' | 'tr' | 'dtr';
export type Loop = 'both' | 'BLO' | 'FLO';
export type LineStatus = 'ok' | 'assumption' | 'ambiguous' | 'unreadable';
export type Construction = 'spiral' | 'joined-rounds' | 'rows';

export interface Measurement { value: number; unit: 'mm' | 'cm' | 'in' }

export interface Yarn {
  id: string;
  label: string;
  color: string; // css hex
  weight?: number; // Craft Yarn Council 0..7
  fiber?: string;
}

export type Gauge =
  | { kind: 'grid'; stitches: number; rows: number; over: Measurement; overRows?: Measurement; stitch: StitchType }
  | { kind: 'rounds'; rounds: number; diameter: Measurement }
  | { kind: 'not-critical' };

export interface Materials {
  yarns: Yarn[];
  hookMm?: number;
  weight?: number;
  fiber?: string;
  gauge?: Gauge;
  eyeMm?: number;
  finishedLength?: Measurement;
  finishedDiameter?: Measurement;
  finishedWidth?: Measurement;
}

/** One stitch-producing instruction after the grammar has run. */
export type Target =
  | { kind: 'next' }
  | { kind: 'same' }
  | { kind: 'ring' }
  | { kind: 'none' } // chains: not worked into anything
  | { kind: 'ch-from-hook'; n: number };

export type Op =
  | { kind: 'stitch'; type: StitchType; target: Target; loop: Loop; tension: number; consumes: number; src: Span }
  | { kind: 'skip'; n: number; src: Span }
  | { kind: 'repeat'; ops: Op[]; times: number | 'around'; src: Span }
  | { kind: 'turning-ch'; n: number; src: Span };

export interface RowDef {
  index: number; // absolute, 1-based within the piece
  label: string; // as written
  labelNumber?: number;
  ops: Op[];
  expectedCount?: { n: number; unit: string };
  computedCount: number;
  yarnId: string;
  join: boolean;
  turn: boolean;
  line: number; // 0-based editor line
  src: Span;
  status: LineStatus;
}

export interface Section { name: string; firstRow: number; yarnId?: string; labelMap: Map<number, number> }

export type MarkerKind = 'safety-eyes' | 'embroidery' | 'stuffing' | 'note';
export interface Marker {
  kind: MarkerKind;
  rowA: number; // absolute row index
  rowB?: number;
  spacingSts?: number;
  sizeMm?: number;
  text: string;
  line: number;
  src: Span;
}

export interface Seam {
  piece: string; // attached piece id (all instances)
  host: string; // host piece id
  rowA?: number; // host absolute rows
  rowB?: number;
  hint: 'top' | 'side' | 'front' | 'below-eyes' | 'back' | 'bottom' | 'default';
  spacingSts?: number;
  text: string;
  line: number;
  src: Span;
}

export interface PieceDef {
  id: string;
  name: string;
  quantity: number;
  construction: Construction;
  start: { kind: 'magic-ring' } | { kind: 'chain'; n: number; ring: boolean };
  sections: Section[];
  rows: RowDef[];
  markers: Marker[];
  finish: 'closed' | 'open' | 'open-with-tail';
  stuffing: 'none' | 'light' | 'firm' | 'unspecified';
  flatten: boolean;
  line: number;
}

export interface Diagnostic {
  severity: 'error' | 'warning' | 'info';
  code: 'count-mismatch' | 'unknown-token' | 'ambiguous' | 'row-sequence' | 'unresolved-reference' | 'assumption';
  message: string;
  line: number;
  src: Span;
}

export interface LineInfo {
  line: number;
  kind: 'row' | 'heading' | 'material' | 'marker' | 'assembly' | 'finish' | 'start' | 'note' | 'blank' | 'title';
  status: LineStatus;
  piece?: string;
  row?: number;
}

export interface Pattern {
  title?: string;
  terms: 'US' | 'UK';
  materials: Materials;
  pieces: PieceDef[];
  seams: Seam[];
  diagnostics: Diagnostic[];
  lines: LineInfo[];
}
