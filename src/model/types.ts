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
  | { kind: 'ch-from-hook'; n: number }
  /** into the next chain space (ch-2 space, ch-3 loop) of the row below: the whole run of chains. */
  | { kind: 'space' }
  /** back into the first stitch of the row below, where this round started ("in the base of the ch 4") */
  | { kind: 'start' };

export type Op =
  /** carry: a stitch a part round left unworked, passed on to the next round (no new height). */
  | { kind: 'stitch'; type: StitchType; target: Target; loop: Loop; tension: number; consumes: number; src: Span; carry?: boolean }
  | { kind: 'skip'; n: number; src: Span }
  /** times: a count, 'around' (until the previous row runs out), { leave: n } (until n stitches remain)
   *  or { leave: 0, ofType } ("dc in each dc": across the run of that stitch, up to a corner). */
  | { kind: 'repeat'; ops: Op[]; times: number | 'around' | { leave: number; ofType?: StitchType }; src: Span }
  /** "increase/decrease k stitches evenly": spread k inc/dec over what is left of the previous row. */
  | { kind: 'evenly'; change: 'inc' | 'dec'; k: number; stitch: StitchType; loop: Loop; tension: number; src: Span }
  | { kind: 'turning-ch'; n: number; src: Span }
  /** "working on the other side of the chain": the stitches after it go back along the foundation
   *  chain's other side, so a round goes all the way round the chain (an oval). */
  | { kind: 'other-side'; src: Span };

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
  /** The type of each stitch this row makes, in work order (chains are its chain spaces). */
  stitchTypes?: StitchType[];
  /** The yarn is joined for this row at the nth stitch of the row below ("pull up a loop in the 11th stitch"), 1-based. */
  startAt?: number;
  /** Decoration the 3D view leaves out (long chain strands for hair curls). */
  skipGeometry?: boolean;
  /** Long strands worked off this row (hair strands, curls): one entry per strand, in order,
   *  each anchored to the next stitch of the row below. Drawn as cords, not meshed. */
  strands?: { len: number }[];
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
  /** lid = the piece's last round is joined stitch for stitch to the host's open last round (a coffee top). */
  hint: 'top' | 'side' | 'front' | 'below-eyes' | 'back' | 'bottom' | 'lid' | 'wrap' | 'default';
  /** wrap: where a strip is wrapped round the host ("around the shoulders" → 'shoulders'). */
  wrapAt?: string;
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
  /** Shaping after stuffing: "shape into a triangle", "flatten the bottom", "shape into an oval". */
  shape?: { triangle?: boolean; flatBottom?: boolean; oval?: boolean };
  /**
   * The first row is worked into other pieces instead of a ring or chain: two legs joined into a
   * body ("sc in next 9 st on the first leg, ch 2, …"), or a skirt worked into the front loops left
   * on a round of the body. Parts are read in order; a 'ch' with back: true is the other side of
   * the chain before it.
   */
  base?: BasePart[];
  /** A chain-only strand (a strap, a suspender, a string): no rows, just the chain. It starts on a
   *  round of the host ("pull up a loop … in round 13 at the back") and is sewn down elsewhere. */
  strap?: { host: string; row?: number; back: boolean };
  /** "ch 3 (counts as first dc)": later rounds' starting chain of that length is a stitch too. */
  countsAs?: { n: number; as: StitchType };
  /** "Flatten the upper part of the arm and close it": the opening is pressed flat and sewn shut. */
  flatEdge?: boolean;
  /** Worked in rounds round both sides of a foundation chain (an oval start). */
  oval?: boolean;
  line: number;
}

export type BasePart =
  | { kind: 'row'; piece: string; inst: number; row: number; loop: Loop }
  | { kind: 'ch'; n: number; back?: boolean };

export interface Diagnostic {
  severity: 'error' | 'warning' | 'info';
  code: 'count-mismatch' | 'words-mismatch' | 'unknown-token' | 'ambiguous' | 'row-sequence' | 'unresolved-reference' | 'assumption';
  message: string;
  line: number;
  src: Span;
  /** Readings in short syntax the user can pick from; picking one writes "=> reading" on the line. */
  readings?: string[];
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
