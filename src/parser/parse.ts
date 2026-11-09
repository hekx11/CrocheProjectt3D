import type {
  BasePart, Diagnostic, Loop, LineInfo, Marker, Materials, Op, Pattern, PieceDef, RowDef, Seam, Section, Span, StitchType, Yarn,
} from '../model/types';
import { COLORS, DEFAULT_YARN_COLOR, FIBERS, WEIGHT_NAMES } from '../model/dictionary';
import { detectTerms, normalize } from './normalize';
import { chainCountsAs, countOf, execute, parseRowText } from './row';

// "Rnd 5:", "5.", "Rnds 6-10:", "Round 10 - Round 14:", "R4-6 sc around"
const LABEL_RE = /^\s*(?:(rnds?|rounds?|rows?|r)\.?\s*)?(\d+)(?:\s*(?:-|–|—|to)\s*(?:(?:rnds?|rounds?|rows?|r)\.?\s*)?(\d+))?\s*[:.)](?!\d)\s*|^\s*(rnds?|rounds?|rows?|r)\.?\s*(\d+)(?:\s*(?:-|–|—|to)\s*(?:(?:rnds?|rounds?|rows?|r)\.?\s*)?(\d+))?\s+(?!(?:and|or|&)\b)/i;
/** A piece that is a single unlabelled round: "6hdc in the magic ring (6)" (tiny ears, noses). */
const FIRST_ROUND_RE = /^\s*\d+\s*(?:sc|hdc|dc|tr|single crochets?|half double crochets?|double crochets?)\b[^.]*\b(?:magic ring|magic circle|adjustable ring|mr)\b/i;
const COLOR_NAMES = Object.keys(COLORS).sort((a, b) => b.length - a.length);

/** The colour named first in the text ("Gold or Dark yellow" → gold). */
function colorFirst(s: string): string | undefined {
  const t = s.toLowerCase();
  let best: string | undefined, at = Infinity;
  for (const c of COLOR_NAMES) {
    const m = new RegExp(`\\b${c}\\b`).exec(t);
    if (m && m.index < at) { at = m.index; best = c; }
  }
  return best;
}

function colorIn(s: string): string | undefined {
  const t = s.toLowerCase();
  for (const c of COLOR_NAMES) if (new RegExp(`\\b${c}\\b`).test(t)) return c;
  return undefined;
}

function toMm(v: number, unit: string): number {
  if (/cm/.test(unit)) return v * 10;
  if (/mm/.test(unit)) return v;
  return v * 25.4; // inches / "
}

function parseFraction(s: string): number {
  // "1 3/8" → 1.375
  const m = /^(\d+)?\s*(?:(\d+)\/(\d+))?$/.exec(s.trim());
  if (!m) return parseFloat(s);
  return (m[1] ? +m[1] : 0) + (m[2] ? +m[2] / +m[3] : 0);
}

/** Pull materials, gauge and size facts out of a line. Returns true if the line looked like a material line. */
function readMaterials(line: string, mat: Materials, terms: 'US' | 'UK'): boolean {
  const t = line.toLowerCase();
  let hit = false;
  const hook = /(\d+(?:[.,]\d+)?)\s*mm\b(?:\s*\(?[a-z/0-9 -]*\)?)?\s*(?:crochet\s+)?hook|hook[^0-9]{0,12}(\d+(?:[.,]\d+)?)\s*mm/.exec(t);
  if (hook) { mat.hookMm = parseFloat((hook[1] ?? hook[2]).replace(',', '.')); hit = true; }
  const eyes = /(\d+(?:\.\d+)?)\s*mm\s*(?:safety\s+)?eyes?/.exec(t);
  if (eyes) { mat.eyeMm = +eyes[1]; hit = true; }
  const isYarnLine = /\byarn\b|\bweight\b|\bply\b|\bg\b|\bgrams?\b|\byards?\b|\bchenille|\bcotton|\bacrylic|\bwool/.test(t);
  if (isYarnLine) {
    const w = /weight\s*(\d)\b|\(\s*(\d)\s*\)|#\s*(\d)\b/.exec(t);
    let weight: number | undefined = w ? +(w[1] ?? w[2] ?? w[3]) : undefined;
    if (weight === undefined) for (const [re, n] of WEIGHT_NAMES) if (re.test(t)) { weight = n; break; }
    // "polyester stuffing" is filling, not the yarn
    const fiber = Object.keys(FIBERS).find((f) => (f === 'polyester' ? /polyester(?!\s*(stuffing|fiberfill|filling|fill))/.test(t) : t.includes(f)));
    const color = colorIn(t);
    if (weight !== undefined) mat.weight = mat.weight ?? weight;
    if (fiber) mat.fiber = mat.fiber ?? fiber;
    if (color && /yarn|weight|chenille|cotton|acrylic|wool|\bg\b/.test(t) && !/eye|brow/.test(t)) {
      if (!mat.yarns.some((y) => y.id === color)) mat.yarns.push({ id: color, label: color, color: COLORS[color], weight, fiber });
    }
    if (weight !== undefined || fiber || color) hit = true;
  }
  // Gauge: "16 sc and 18 rows = 4 in / 10 cm", "24 tr x 13 rows = 10 x 10 cm", "11 sts = 4 in in sc"
  if (/gauge|tension/.test(t) && /not (critical|essential|important)/.test(t)) { mat.gauge = { kind: 'not-critical' }; hit = true; }
  const g = /(\d+(?:\.\d+)?)\s*(sc|hdc|dc|tr|htr|sts?|stitches)\s*(?:and|x|by|&)\s*(\d+(?:\.\d+)?)\s*(rows?|rnds?|rounds?)\s*(?:=|to|over|measure)\s*([\d.]+)\s*(cm|mm|in(?:ches)?|")/.exec(t);
  if (g) {
    let st = g[2].startsWith('st') ? 'sc' : g[2];
    if (terms === 'UK') st = ({ dc: 'sc', htr: 'hdc', tr: 'dc' } as any)[st] ?? st;
    mat.gauge = { kind: 'grid', stitches: +g[1], rows: +g[3], over: { value: +g[5], unit: g[6].startsWith('c') ? 'cm' : g[6] === 'mm' ? 'mm' : 'in' }, stitch: st as any };
    hit = true;
  } else {
    const gs = /(\d+(?:\.\d+)?)\s*(?:sc|sts?|stitches)\s*=\s*([\d.]+)\s*(cm|in(?:ches)?|")/.exec(t);
    if (gs && /gauge|tension/.test(t)) {
      mat.gauge = { kind: 'grid', stitches: +gs[1], rows: 0, over: { value: +gs[2], unit: gs[3].startsWith('c') ? 'cm' : 'in' }, stitch: 'sc' };
      hit = true;
    }
    const gr = /(?:rnds?|rounds?)\s*1\s*-\s*(\d+)\s*(?:=|measures?|are)\s*([\d ./]+)\s*(cm|in(?:ches)?|")\s*(?:in\s+)?diameter/.exec(t);
    if (gr) { mat.gauge = { kind: 'rounds', rounds: +gr[1], diameter: { value: parseFraction(gr[2]), unit: gr[3].startsWith('c') ? 'cm' : 'in' } }; hit = true; }
  }
  const len = /(length|height|tall|long)\s*:?\s*(?:approx\.?|about|~)?\s*([\d.]+)\s*(cm|mm|in(?:ches)?|"|'')/.exec(t);
  if (len) { mat.finishedLength = { value: +len[2], unit: len[3].startsWith('c') ? 'cm' : len[3] === 'mm' ? 'mm' : 'in' }; hit = true; }
  const dia = /(diameter|wide|width)\s*:?\s*(?:approx\.?|about|~)?\s*([\d.]+)\s*(cm|mm|in(?:ches)?|"|'')/.exec(t);
  if (dia) {
    const m = { value: +dia[2], unit: (dia[3].startsWith('c') ? 'cm' : dia[3] === 'mm' ? 'mm' : 'in') as 'cm' | 'mm' | 'in' };
    if (dia[1] === 'diameter') mat.finishedDiameter = m;
    else mat.finishedWidth = m;
    hit = true;
  }
  if (/\b(scissors|needle|stuffing|fiberfill|polyfill|stitch marker|materials|tools|you will need|supplies)\b/.test(t) && !/^\s*(add|stuff)/.test(t)) hit = true;
  return hit;
}

function headingInfo(line: string): { name: string; quantity: number; color?: string } {
  let name = line.trim().replace(/[:.]+$/, '');
  let quantity = 1;
  name = name.replace(/\b(make|x)\s+(two|three|four|five|six)\b/i, (_m, w, n) => `${w} ${({ two: 2, three: 3, four: 4, five: 5, six: 6 } as Record<string, number>)[n.toLowerCase()]}`);
  const q = /\(?\s*(?:make|x)\s*(\d+)\s*\)?|\(?\s*(\d+)\s*x\s*\)?$/i.exec(name);
  if (q) { quantity = +(q[1] ?? q[2]); name = name.replace(q[0], '').trim(); }
  const color = colorIn(name);
  if (color) name = name.replace(new RegExp(`\\(?\\s*${color}\\s*\\)?`, 'i'), '').trim();
  name = name.replace(/\(\s*[,;]?\s*\)/g, '').replace(/^[\s,;()]+|[\s,;(]+$/g, '').trim();
  if ((name.match(/\(/g)?.length ?? 0) < (name.match(/\)/g)?.length ?? 0)) name = name.replace(/^([^)]*)\)/, '$1').trim();
  if (name === name.toUpperCase()) name = name.charAt(0) + name.slice(1).toLowerCase();
  return { name: name || 'Piece', quantity, color };
}

function looksLikeHeading(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 48) return false;
  if (/[.!?]$/.test(t) && !/\)\.?$/.test(t)) return false;
  const words = t.replace(/\([^)]*\)/g, "").trim().split(/\s+/).length;
  if (words > 7) return false;
  if (/^(add|insert|place|sew|stuff|fasten|attach|embroider|flatten|weave|cut|leave|do|work|repeat|turn|join|pull|close|using|use|with)\b/i.test(t)) return false;
  const n = normalize(t);
  if (/\b(sc|hdc|dc|tr|slst|inc|dec|mr)\b/.test(n) && /\d/.test(n)) return false;
  return true;
}

/** A round piece decreased down to a few stitches is closed even when the pattern doesn't say so;
 *  one that ends small without decreasing (an ear, a thin tube) stays open. */
const smallEnd = (p: PieceDef): boolean => {
  const last = p.rows[p.rows.length - 1]?.computedCount ?? 99;
  return p.construction !== 'rows' && last <= 8 && last < Math.max(...p.rows.map((r) => r.computedCount));
};

const hasOtherSide = (ops: Op[]): boolean => ops.some((o) => o.kind === 'other-side' || (o.kind === 'repeat' && hasOtherSide(o.ops)));

/** "sew the rectangle onto the body": the piece just made, named by its shape. */
const SHAPE_WORDS = 'rectangle|square|circle|triangle|strip|oval|panel|tube|disc|disk|cone|band|flap|hexagon|heart|star';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Previous row's stitch count as the next row sees it (shared with the row loop). */
function prevOf(piece: PieceDef, pieces: PieceDef[] = []): { prevCount: number; ringMode: boolean; prevTypes?: StitchType[] } {
  const prev = piece.rows[piece.rows.length - 1];
  if (!prev && piece.base) return { prevCount: baseCount(piece.base, pieces), ringMode: false };
  // which stitches of the row below are chains (its chain spaces), in the order they are met
  if (prev?.stitchTypes) return { prevCount: prev.computedCount, ringMode: false, prevTypes: piece.construction === 'rows' ? [...prev.stitchTypes].reverse() : prev.stitchTypes };
  const ringMode = !prev && (piece.start.kind === 'magic-ring' || (piece.start.kind === 'chain' && piece.start.ring));
  const prevCount = prev ? prev.computedCount : piece.start.kind === 'chain' && !piece.start.ring ? piece.start.n : 0;
  return { prevCount, ringMode };
}

/** Stitches a based piece's first row can work into. */
function baseCount(base: BasePart[], pieces: PieceDef[]): number {
  let n = 0;
  for (const b of base) {
    if (b.kind === 'ch') n += b.n;
    else n += pieces.find((p) => p.id === b.piece)?.rows[b.row - 1]?.computedCount ?? 0;
  }
  return n;
}

/** A piece named in a sentence: "sew the hair to the head" finds "Body & head". */
function namedPiece(s: string, pieces: PieceDef[], not?: PieceDef): PieceDef | undefined {
  const words = (q: PieceDef) => q.name.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3 && !/^(and|the|with|piece|part|for)$/.test(w));
  const has = (w: string) => new RegExp(`\\b${w.replace(/s$/, '')}s?\\b`).test(s);
  // best match: the whole name, then all its words, then any word; the most recent piece wins a tie
  // (a pattern with two dolls has two "Arms")
  let best: PieceDef | undefined, bs = 0;
  for (let i = pieces.length - 1; i >= 0; i--) {
    const q = pieces[i];
    if (q === not) continue;
    const ws = words(q);
    const score = s.includes(q.name.toLowerCase().replace(/s$/, '')) && q.name.length >= 3 ? 3 : ws.length && ws.every(has) ? 2 : ws.some(has) ? 1 : 0;
    if (score > bs) { bs = score; best = q; }
  }
  return best;
}

/** The biggest piece so far (the body things get sewn to when no piece is named). */
function mainPiece(pieces: PieceDef[], not?: PieceDef): PieceDef | undefined {
  let best: PieceDef | undefined, bn = -1;
  for (const q of pieces) {
    if (q === not) continue;
    const n = q.rows.reduce((a, r) => a + r.computedCount, 0) * q.quantity;
    if (n > bn) { bn = n; best = q; }
  }
  return best;
}

/** "repeat rnd 3", "rep row 3", "as rnd 11", "work as for round 3", "repeat the previous round". */
export function rowReference(n: string): number | 'previous' | null {
  const t = n.replace(/[.,;]\s*$/, '').trim();
  const m = /^(?:rep|work|same|as)\b(?:\s+(?:as|for|the same as|same as))*\s*(?:rnd|round|row|r)\.?\s*(\d+)$/.exec(t);
  if (m) return +m[1];
  if (/^(?:rep|work)\s+(?:the\s+)?(?:previous|last|prev)\s+(?:rnd|round|row)$/.test(t)) return 'previous';
  return null;
}

/**
 * Other readings of a line whose count doesn't match: the scope of a trailing "x6",
 * and "repeat N times" meaning N more times (or the reverse). Each is written in short syntax with the stated count.
 */
export function alternatives(instr: string, count: number): string[] {
  const body = instr.replace(/\s*[\[({]\s*\d+[^\])}]*[\])}]\s*\.?\s*$/, '').trim().replace(/[.]$/, '');
  const out = new Set<string>();
  const scope = /^(.+?)\s*(?:x|\*|×)\s*(\d+)\s*$/i.exec(body) ?? /^(.+?)\s+(\d+)\s+times$/i.exec(body);
  if (scope && !/[()\[\]*]/.test(scope[1]) && /,/.test(scope[1])) out.add(`(${scope[1].trim()}) x${scope[2]}`);
  const times = /\b(rep(?:eat)?(?:\s+from\s+\*)?)\s+(\d+)\s+times\b/i.exec(body);
  if (times && !/more\s+times/i.test(body)) out.add(body.replace(times[0], `${times[1]} ${times[2]} more times`));
  const more = /\b(\d+)\s+more\s+times\b/i.exec(body);
  if (more) out.add(body.replace(more[0], `${more[1]} times`));
  return [...out].map((a) => `${a} (${count})`);
}

const HARMLESS = new Set(['st', 'times', 'x', 'around', 'across', 'evenly', 'spaced', 'in', 'on', 'at', 'for', 'into', 'remain', 'remaining', 'left', 'last', 'first', 'next', 'same', 'space', 'sp', 'hook', 'from', 'up', 'over', 'beg', 'beginning', 'top', 'base', 'end', 'only', 'loop', 'loops', 'with', 'yarn', 'still', 'again', 'now', 'here', 'there', 'just', 'so', 'should', 'will', 'have', 'you', 'your', 'finish', 'start']);

function meaningfulIgnored(ignored: string[]): string[] {
  const words = ignored.join(' ').split(/\s+/).filter((w) => /[a-z0-9]/.test(w));
  return words.some((w) => !HARMLESS.has(w.replace(/[^a-z0-9-]/g, ''))) ? words : [];
}

function sentences(line: string): { text: string; from: number }[] {
  const out: { text: string; from: number }[] = [];
  const re = /[^.!?]+(?:[.!?]+|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) if (m[0].trim()) out.push({ text: m[0], from: m.index });
  return out;
}

export function parsePattern(text: string): Pattern {
  const termsInfo = detectTerms(text);
  const terms = termsInfo.terms;
  const materials: Materials = { yarns: [] };
  const pieces: PieceDef[] = [];
  const seams: Seam[] = [];
  const diagnostics: Diagnostic[] = [];
  const lines: LineInfo[] = [];
  let title: string | undefined;

  // "{5 rounds}" style notes repeat what the label says; blank them out (same length keeps offsets)
  const rawLines = text.replace(/\{[^}\n]*\}/g, (m) => ' '.repeat(m.length)).split('\n');
  const offsets: number[] = [];
  { let o = 0; for (const l of rawLines) { offsets.push(o); o += l.length + 1; } }

  // Pass 1: materials anywhere (so yarn colours/weights are known before rows).
  for (const l of rawLines) if (!LABEL_RE.test(l)) readMaterials(l, materials, terms);
  const defaultYarn: Yarn = materials.yarns[0] ?? { id: 'main', label: 'main', color: DEFAULT_YARN_COLOR };
  if (!materials.yarns.length) materials.yarns.push(defaultYarn);
  const ensureYarn = (color: string): string => {
    if (!materials.yarns.some((y) => y.id === color)) materials.yarns.push({ id: color, label: color, color: COLORS[color] ?? DEFAULT_YARN_COLOR, weight: materials.weight, fiber: materials.fiber });
    return color;
  };

  if (termsInfo.suspectedUK) {
    diagnostics.push({ severity: 'info', code: 'assumption', line: 0, src: { from: 0, to: Math.min(text.length, rawLines[0]?.length ?? 0) }, message: 'This looks like it may use UK terms (dc = US sc). Add "UK terms" to the pattern to switch.' });
  }

  let piece: PieceDef | null = null;
  let pending: { name: string; quantity: number; color?: string; line: number } | null = null;
  let pendingStart: PieceDef['start'] | null = null;
  /** "Pull up a loop … in round 13 at the back of the body": where a chain strand starts. */
  let pendingLoop: { host: PieceDef; label?: number; back: boolean } | null = null;
  const unnamedHost = new Map<Seam, string>();
  let yarnId = defaultYarn.id;
  let finished = false;
  let lastLabel: number | undefined;
  let sawRow = false;
  // "(-) All in one stitch" in the key: a bracketed group without a target goes into one stitch
  const groupsInOne = /\(\s*-?\s*\)\s*(?:[=:-]\s*)?all in (?:one|the same|1) (?:st|stitch)/i.test(text);
  /** "Pull up a loop … in the front loops of round 13 [of the body]": the next piece grows from there. */
  let pendingBase: { host: PieceDef; label: number; loop: Loop } | null = null;
  /** "Leg 2: Ch 6, insert hook into leg 1 … continue around both legs": the next round joins them. */
  let pendingLegs: { piece: PieceDef; n: number } | null = null;
  /** "Stuff firmly as your work progresses" before the first piece: every round piece is stuffed. */
  let globalStuff: 'light' | 'firm' | null = null;
  /** "Ch 3 counts as a dc throughout": a starting chain of that length is a stitch in every round. */
  const thr = /\bch(?:ain)?\s*-?\s*(\d)\s*(?:at the (?:beginning|start) of (?:each|every) (?:round|row|rnd)\s*)?counts as (?:a |the |one |1 )?(?:first )?(sc|hdc|dc|tr|dtr|single crochet|half double crochet|double crochet|treble)\b[^.\n]*\bthroughout\b/i.exec(text);
  const countsThroughout: { n: number; as: StitchType } | null = thr ? { n: +thr[1], as: (({ 'single crochet': 'sc', 'half double crochet': 'hdc', 'double crochet': 'dc', treble: 'tr' } as Record<string, StitchType>)[thr[2].toLowerCase()] ?? thr[2].toLowerCase()) as StitchType } : null;
  /** a pattern sheet with two figures: piece names repeat, sections tell them apart */

  const newPiece = (name: string, quantity: number, line: number): PieceDef => {
    const p: PieceDef = {
      id: `p${pieces.length + 1}`, name, quantity, construction: 'spiral', start: { kind: 'magic-ring' },
      sections: [], rows: [], markers: [], finish: 'open', stuffing: 'unspecified', flatten: false, line,
    };
    pieces.push(p);
    finished = false;
    lastLabel = undefined;
    return p;
  };
  const section = (): Section => {
    if (!piece!.sections.length) piece!.sections.push({ name: piece!.name, firstRow: 1, labelMap: new Map() });
    return piece!.sections[piece!.sections.length - 1];
  };
  /** Resolve a label number written in the pattern to an absolute row of a piece. */
  const resolveRow = (p: PieceDef, label: number, line: number, src: Span): number | undefined => {
    for (let i = p.sections.length - 1; i >= 0; i--) {
      const r = p.sections[i].labelMap.get(label);
      if (r !== undefined) return r;
    }
    diagnostics.push({ severity: 'warning', code: 'unresolved-reference', line, src, message: `Row/round ${label} not found in ${p.name}.` });
    return undefined;
  };

  for (let li = 0; li < rawLines.length; li++) {
    const rawLine = rawLines[li];
    const lineSrc: Span = { from: offsets[li], to: offsets[li] + rawLine.length };
    const info: LineInfo = { line: li, kind: 'note', status: 'ok' };
    lines.push(info);
    const trimmed = rawLine.trim();
    if (!trimmed) { info.kind = 'blank'; continue; }

    // Annotation: "original wording  => our syntax"
    const ann = rawLine.indexOf('=>');
    const body = ann >= 0 ? rawLine.slice(0, ann) : rawLine;
    const annotation = ann >= 0 ? rawLine.slice(ann + 2) : null;

    let lm = LABEL_RE.exec(body);
    if (!lm && FIRST_ROUND_RE.test(body) && (pending !== null || (piece !== undefined && piece !== null && piece.rows.length === 0))) {
      lm = Object.assign([''], { 2: '1', index: 0, input: body }) as unknown as RegExpExecArray;
      diagnostics.push({ severity: 'info', code: 'assumption', line: li, src: lineSrc, message: 'No round label here, read as round 1.' });
    }
    if (lm) {
      info.kind = 'row';
      sawRow = true;
      const a = +(lm[2] ?? lm[5]);
      const b = lm[3] ?? lm[6] ? +(lm[3] ?? lm[6])! : a;
      const word = (lm[1] ?? lm[4] ?? '').toLowerCase();
      const instr = annotation ?? body.slice(lm[0].length);
      const normalized = normalize(instr, terms);
      const chainOnly = /^ch (\d+)\s*[.,]?\s*$/.exec(normalized);
      if (chainOnly && a === 1 && b === 1 && (!piece || pending || finished || piece.rows.length === 0)) {
        info.kind = 'start';
        const start: PieceDef['start'] = { kind: 'chain', n: +chainOnly[1], ring: false };
        if (piece && !pending && !finished) { piece.start = start; piece.construction = 'rows'; }
        else pendingStart = start;
        continue;
      }
      const startsNew = /\bmr\b/.test(normalized) || (a === 1 && /^\s*ch \d+/.test(normalized) && /ring/.test(normalized));
      // "sc in next 9 st on the first leg, … sc in next 10 st on the second leg": the legs join into a body
      const joinWord = /\b(?:first|1st)\s+(leg|arm|foot|part|piece)\b/i.exec(instr);
      const legs = joinWord && /\b(?:second|2nd|other)\s+(?:leg|arm|foot|part|piece)\b/i.test(instr)
        ? [...pieces].reverse().find((q) => q.quantity >= 2 && q.rows.length > 0 && (q.name.toLowerCase().includes(joinWord[1].toLowerCase()) || q === piece))
        : pendingLegs?.piece;
      const legChain = /^\s*ch (\d+)/.exec(normalized)?.[1] ?? (pendingLegs ? String(pendingLegs.n) : undefined);
      pendingLegs = null;

      const needNew = !piece || (pending !== null && (finished || startsNew || pendingStart !== null)) || (finished && startsNew) || (startsNew && a === 1 && piece.rows.length > 0) || (legs !== undefined && piece === legs);
      if (needNew) {
        const name = pending?.name ?? (legs ? 'Body' : pieces.length ? `Piece ${pieces.length + 1}` : title ?? 'Piece');
        piece = newPiece(name, pending?.quantity ?? 1, pending?.line ?? li);
        if (pendingStart) { piece.start = pendingStart; pendingStart = null; }
        if (piece.start.kind === 'chain' && !piece.start.ring) piece.construction = 'rows';
        piece.sections.push({ name: piece.name, firstRow: 1, yarnId: pending?.color ? ensureYarn(pending.color) : undefined, labelMap: new Map() });
        if (pending?.color) yarnId = pending.color;
        else if (pieces.length > 1 && !legs) yarnId = defaultYarn.id;
        pending = null;
        if (legs) {
          const n = legChain ? +legChain : 0;
          const last = legs.rows.length;
          piece.base = [{ kind: 'row', piece: legs.id, inst: 0, row: last, loop: 'both' }];
          if (n) piece.base.push({ kind: 'ch', n });
          piece.base.push({ kind: 'row', piece: legs.id, inst: 1, row: last, loop: 'both' });
          if (n) piece.base.push({ kind: 'ch', n, back: true });
          if (legs.finish === 'open') legs.finish = 'open-with-tail';
          if (legs.stuffing === 'unspecified') legs.stuffing = 'firm';
          diagnostics.push({ severity: 'info', code: 'assumption', line: li, src: lineSrc, message: `The two ${legs.name.toLowerCase()} are joined here${n ? ` with ${n} chains between them` : ''}; this round goes all the way round both.` });
        } else if (pendingBase) {
          piece.base = [{ kind: 'row', piece: pendingBase.host.id, inst: 0, row: 0, loop: pendingBase.loop }];
        }
      } else if (pending && piece) {
        // Heading inside a piece that is not a new piece → a section (e.g. colour block)
        const restart = lastLabel !== undefined && a <= lastLabel;
        piece.sections.push({ name: pending.name, firstRow: piece.rows.length + 1, yarnId: pending.color ? ensureYarn(pending.color) : undefined, labelMap: new Map() });
        if (pending.color) yarnId = pending.color;
        if (restart) diagnostics.push({ severity: 'info', code: 'assumption', line: li, src: lineSrc, message: `"${pending.name}" restarts the numbering but continues the same piece (no new start or fasten off before it).` });
        pending = null;
      }
      if (!piece) continue;
      if (word.startsWith('row')) piece.construction = 'rows';
      if (lastLabel !== undefined && a !== lastLabel + 1 && a > lastLabel + 1) {
        diagnostics.push({ severity: 'warning', code: 'row-sequence', line: li, src: lineSrc, message: `Expected row ${lastLabel + 1} next, found ${a}.` });
      }
      lastLabel = b;

      // a round that ends with a join starts with its starting chain ("Ch 2, 10 hdc in 2nd ch from hook, join")
      const joinsHere = /\bjoin\b|\bslst (?:in|to) (?:the )?(?:top|first|beg)/.test(normalized);
      const leadingChIsTurning = piece.construction === 'rows' || piece.construction === 'joined-rounds' || joinsHere || /^\s*ch \d+\s*,/.test(normalized) && piece.rows.length > 0 && piece.start.kind === 'chain';
      const rowOpts = { terms, leadingChIsTurning, src: lineSrc };
      let parsed = parseRowText(instr, { ...rowOpts, groupsInOne });
      const notesHere: string[] = [];
      if (legs && piece.base && piece.rows.length === 0) {
        const st = (/\b(sc|hdc|dc)\b/.exec(normalize(instr, terms))?.[1] ?? 'sc') as StitchType;
        const op: Op = { kind: 'stitch', type: st, target: { kind: 'next' }, loop: 'both', tension: 1, consumes: 1, src: lineSrc };
        parsed = { ...parsed, ops: [{ kind: 'repeat', ops: [op], times: 'around', src: lineSrc }], ignored: [], unreadable: false, turn: false };
      }
      // a piece grown from a round of another piece: pick the round whose stitch count fits
      if (piece.base && piece.rows.length === 0 && pendingBase && piece.base[0].kind === 'row' && piece.base[0].row === 0) {
        const host = pendingBase.host;
        const want = parsed.expectedCount?.n;
        const at = (lab: number) => host.sections.map((sc) => sc.labelMap.get(lab)).find((r) => r !== undefined);
        let best: number | undefined, score = Infinity;
        for (let d = -3; d <= 3; d++) {
          const r = at(pendingBase.label + d);
          if (r === undefined) continue;
          const cnt = host.rows[r - 1].computedCount;
          const nextLoop = host.rows[r]?.ops.some((o) => JSON.stringify(o).includes(pendingBase!.loop === 'FLO' ? '"BLO"' : '"FLO"'));
          const sc = Math.abs(d) + (want !== undefined && cnt !== want ? 10 : 0) - (nextLoop ? 2.5 : 0);
          if (sc < score) { score = sc; best = r; }
        }
        piece.base[0] = { ...piece.base[0], row: best ?? host.rows.length };
        const lab = host.rows[(best ?? host.rows.length) - 1]?.label;
        if (best !== undefined && lab !== String(pendingBase.label)) notesHere.push(`worked into the leftover loops of ${host.name.toLowerCase()} rnd ${lab}, the round with that many stitches`);
        pendingBase = null;
      }
      let readings: string[] | undefined;
      let pickNeeded = false;
      // "ch 3 (counts as first dc)" said once (or "… throughout") holds for the later rounds of the piece
      const said = /\bch\s*(\d)\s*\(?\s*counts as (?:a |the |one |1 )?(?:first |1st |beg\w* )?(sc|hdc|dc|tr|dtr)\b/.exec(normalized);
      if (said) piece.countsAs = { n: +said[1], as: said[2] as StitchType };
      else if (piece.countsAs ?? countsThroughout) {
        const c = (piece.countsAs ?? countsThroughout)!;
        const conv = chainCountsAs(parsed.ops, c.n, c.as);
        if (conv) { parsed = { ...parsed, ops: conv }; notesHere.push(`the ch ${c.n} counts as a ${c.as}, as the pattern said earlier`); }
      }

      // "Repeat rnd 3." / "Rnds 12-15: as rnd 11" / "repeat the previous round": copy that row's stitches.
      const ref = rowReference(normalized);
      if (ref) {
        const target = ref === 'previous' ? piece.rows[piece.rows.length - 1] : piece.rows[(resolveRow(piece, ref, li, lineSrc) ?? 0) - 1];
        if (target) {
          parsed = { ...parsed, ops: target.ops, unreadable: false, ignored: [], assumptions: [] };
          notesHere.push(`same stitches as ${piece.construction === 'rows' ? 'row' : 'rnd'} ${target.label}`);
        }
      }

      // Count-guided search: when the stated count doesn't match, try the other ways the line can be read.
      if (parsed.expectedCount && !parsed.unreadable) {
        const { prevCount, ringMode, prevTypes } = prevOf(piece, pieces);
        const want = parsed.expectedCount;
        const countFor = (pr: typeof parsed) => countOf(execute(pr.ops, prevCount, ringMode, prevTypes), want.unit);
        if (countFor(parsed) !== want.n) {
          const hits = alternatives(instr, want.n)
            .map((a) => ({ a, pr: parseRowText(a, rowOpts) }))
            .filter((x) => !x.pr.unreadable && countFor(x.pr) === want.n);
          if (hits.length) {
            const keepCount = parsed.expectedCount;
            parsed = { ...hits[0].pr, expectedCount: keepCount, colorChange: parsed.colorChange ?? hits[0].pr.colorChange };
            readings = hits.map((h) => h.a);
            if (hits.length === 1) notesHere.push(`read as "${hits[0].a}", the only reading that gives ${want.n}`);
            else pickNeeded = true;
          } else if (want.unit === 'st' && execute(parsed.ops, prevCount, ringMode, prevTypes).stitches.length === want.n) {
            notesHere.push(`the stated count ${want.n} includes the chains`);
            parsed = { ...parsed, expectedCount: { n: countFor(parsed), unit: 'st' } };
          }
        }
      }
      // Long chain strands worked back from the hook mid-round (hair curls): readable, but not a
      // fabric the 3D view can lay out yet, so the round is listed and left out of the model.
      const strands = /\bch\s*\d{2,}\s*,\s*(?:start(?:ing)?\s+)?(?:in|into)\s+(?:the\s+)?(?:second|third|2nd|3rd|2|3)\s+ch\s+from/i.test(instr) && piece.rows.length > 0;
      let strandList: { len: number }[] | undefined;
      if (strands) {
        // "(ch 66, start in second ch from hook, …) repeat 2 times, (ch 67, …) repeat 2 times"
        strandList = [];
        const t = body.toLowerCase();
        const grp = /\(\s*ch\s*(\d{2,})\b[^()]*(?:\([^()]*\)[^()]*)*\)\s*(?:(?:x|repeat|rep)\s*(\d+)(?:\s*times)?)?/g;
        for (let m; (m = grp.exec(t)); ) for (let i = 0; i < +(m[2] ?? 1); i++) strandList.push({ len: +m[1] });
        if (!strandList.length) for (const m of t.matchAll(/\bch\s*(\d{2,})\b/g)) strandList.push({ len: +m[1] });
        const total = /\[?\s*(\d+)\s+(?:strands|curls)\b/.exec(t);
        if (total && strandList.length && +total[1] !== strandList.length) {
          const len = strandList[0].len;
          strandList = Array.from({ length: +total[1] }, (_, i) => strandList![i] ?? { len });
        }
        parsed = { ...parsed, ops: [], ignored: [], unreadable: false, expectedCount: undefined };
        notesHere.push('long chain strands (curls) are left out of the 3D view');
      }
      // A partial round ("… sl st to the next st, fasten off (20 sts)") counts the stitches it left
      // unworked: they carry on into the next round, which works across both.
      if (parsed.expectedCount?.unit === 'st' && piece.construction !== 'rows' && !parsed.turn) {
        const { prevCount, ringMode, prevTypes } = prevOf(piece, pieces);
        const ex = execute(parsed.ops, prevCount, ringMode, prevTypes);
        const got = countOf(ex, 'st');
        if (got !== parsed.expectedCount.n && ex.leftover > 0 && got + ex.leftover === parsed.expectedCount.n) {
          const carry: Op = { kind: 'stitch', type: 'slst', target: { kind: 'next' }, loop: 'both', tension: 1, consumes: 1, src: lineSrc, carry: true };
          parsed = { ...parsed, ops: [...parsed.ops, { kind: 'repeat', ops: [carry], times: 'around', src: lineSrc }] };
          notesHere.push(`a part round: the ${ex.leftover} stitches it leaves unworked carry on into the next round`);
        }
      }
      if (parsed.colorChange) yarnId = ensureYarn(parsed.colorChange);
      // a turned row inside a round piece (a hairline worked back and forth) stays a round piece
      if (parsed.turn && (piece.construction === 'rows' || piece.rows.length < 3)) piece.construction = 'rows';
      // "…, working on the other side of the chain, …": rounds all the way round the chain (an oval)
      if (piece.rows.length === 0 && piece.start.kind === 'chain' && !piece.start.ring && hasOtherSide(parsed.ops)) {
        piece.oval = true;
        piece.construction = parsed.join ? 'joined-rounds' : 'spiral';
      }
      if (piece.oval && piece.construction === 'rows' && !parsed.turn) piece.construction = 'spiral';
      if (parsed.join && piece.construction === 'spiral') piece.construction = 'joined-rounds';
      if (parsed.stuffing) piece.stuffing = parsed.stuffing === 'none' ? 'none' : parsed.stuffing;

      let status: RowDef['status'] = 'ok';
      const sec = section();
      for (let label = a; label <= b; label++) {
        const prev = piece.rows[piece.rows.length - 1];
        const { prevCount, ringMode, prevTypes } = prevOf(piece, pieces);
        const ex = execute(parsed.ops, prevCount, ringMode, prevTypes);
        const computed = countOf(ex, parsed.expectedCount?.unit ?? 'st');
        const stitchCount = countOf(ex, 'st') + (ex.stitches.some((s) => s.isChain) && countOf(ex, 'st') === 0 ? ex.stitches.length : 0);
        const row: RowDef = {
          index: piece.rows.length + 1, label: String(label), labelNumber: label, ops: parsed.ops,
          expectedCount: parsed.expectedCount, computedCount: ex.stitches.length ? ex.stitches.length : stitchCount,
          yarnId, join: parsed.join, turn: parsed.turn, line: li, src: lineSrc, status: 'ok',
        };
        row.stitchTypes = ex.stitches.map((q) => q.type);
        // "computedCount" in the graph sense = all produced stitches the next row can work into
        row.computedCount = ex.stitches.length;
        if (strands) { row.skipGeometry = true; row.computedCount = prev?.computedCount ?? 0; if (strandList?.length) row.strands = strandList; }
        piece.rows.push(row);
        sec.labelMap.set(label, row.index);
        if (label === a) {
          if (parsed.unreadable) {
            status = 'unreadable';
            diagnostics.push({ severity: 'error', code: 'unknown-token', line: li, src: lineSrc, message: `Couldn't read this instruction. Add "=> …" with short syntax, e.g. "=> 18 sc".` });
          } else if (pickNeeded && readings) {
            status = 'ambiguous';
            diagnostics.push({ severity: 'warning', code: 'ambiguous', line: li, src: lineSrc, readings, message: `This can be read ${readings.length} ways that all give ${parsed.expectedCount?.n}. Showing the first; pick the one you mean.` });
          } else if (parsed.expectedCount && parsed.expectedCount.n !== computed) {
            status = 'ambiguous';
            diagnostics.push({ severity: 'warning', code: 'count-mismatch', line: li, src: lineSrc, message: `I count ${computed} ${parsed.expectedCount.unit === 'loops' ? 'loops' : 'stitches'}, the pattern says ${parsed.expectedCount.n}.${ex.leftover ? ` ${ex.leftover} stitch(es) of the previous row left unworked.` : ''}${ex.overflow ? ` Ran out of stitches ${ex.overflow}×.` : ''}` });
          } else {
            const notes = [...notesHere, ...parsed.assumptions];
            const skipped = meaningfulIgnored(parsed.ignored);
            if (skipped.length) {
              // Never drop words silently: the count may only match because something was left out.
              status = 'ambiguous';
              diagnostics.push({ severity: 'warning', code: 'unknown-token', line: li, src: lineSrc, message: `Skipped words I couldn't read: "${skipped.join(' ')}". If they matter, add "=> …" with short syntax.` });
            } else if (parsed.ignored.length) notes.push(`ignored: "${parsed.ignored.join(' ')}"`);
            if (!parsed.expectedCount && ex.leftover > 0 && prev) notes.push(`${ex.leftover} stitch(es) of the previous row left unworked`);
            if (notes.length) {
              if (status === 'ok') status = 'assumption';
              diagnostics.push({ severity: 'info', code: 'assumption', line: li, src: lineSrc, readings, message: cap(notes.join('; ')) + '.' });
            }
          }
        }
      }
      piece.rows.filter((r) => r.line === li).forEach((r) => (r.status = status));
      info.status = status;
      info.piece = piece.id;
      info.row = piece.rows.find((r) => r.line === li)?.index;
      if (parsed.fastenOff) {
        finished = true;
        piece.finish = parsed.tail ? 'open-with-tail' : piece.construction === 'rows' ? 'open' : parsed.close || smallEnd(piece) ? 'closed' : 'open';
      }
      continue;
    }

    // --- non-row lines ----------------------------------------------------
    const isMat = readMaterials(body, { yarns: [] }, terms);
    const yarnLine = /^(?:(?:make|x)\s*\d+\s*,?\s*)?(?:start(?:ing)?\s+)?(?:in|with|use|using)\s+.{1,30}?\s+(?:colou?r\s+)?yarn\s*[:.]?\s*$/i.test(body.trim()) || /^(?:with|in|using)\s+[a-z ]{1,24}?\s*:?\s*$/i.test(body.trim()) && !!colorIn(body);
    if (isMat && !sawRow && !yarnLine) { info.kind = 'material'; continue; }
    // "Foundation Ring: Chain 5 and join …", "Foundation chain: ch 21"
    const n = normalize(body.replace(/^\s*(?:foundation(?:\s+(?:ring|chain|row))?|starting chain|set-?up(?:\s+(?:ring|chain))?)\s*:\s*/i, ''), terms);

    // Start lines: "Ch 16." / "Ch 4 and join with a sl st to form a ring" / "Make a magic ring"
    const ch = /^ch (\d+)\b(.*)$/.exec(n);
    if (ch && !/,\s*(sc|dc|hdc)/.test(ch[2])) {
      info.kind = 'start';
      const start: PieceDef['start'] = { kind: 'chain', n: +ch[1], ring: /\bring\b|\bjoin/.test(ch[2]) };
      // a chain on its own, started on another piece or left with a tail for sewing: a strap
      if (!start.ring && (pending || finished || !piece) && (pendingLoop || /\bleav(?:e|ing)\b[^.]*\b(?:tail|end)\b/.test(ch[2])) && pieces.length) {
        const host = pendingLoop?.host ?? mainPiece(pieces);
        piece = newPiece(pending?.name ?? `Strap ${pieces.length + 1}`, pending?.quantity ?? 1, pending?.line ?? li);
        piece.start = start;
        piece.construction = 'rows';
        piece.sections.push({ name: piece.name, firstRow: 1, yarnId: pending?.color ? ensureYarn(pending.color) : undefined, labelMap: new Map() });
        if (pending?.color) yarnId = pending.color;
        if (host) {
          const row = pendingLoop?.label !== undefined ? resolveRow(host, pendingLoop.label, li, lineSrc) : undefined;
          piece.strap = { host: host.id, row, back: pendingLoop?.back ?? true };
        }
        pending = null; pendingStart = null; pendingLoop = null;
        finished = true; // just a chain: whatever comes next is another piece
        continue;
      }
      if (pending || finished || !piece) pendingStart = start;
      else if (piece.rows.length === 0) piece.start = start;
      else pendingStart = start;
      if (!start.ring && piece && !pending && !finished && piece.rows.length === 0) piece.construction = 'rows';
      continue;
    }
    // "In white yarn:", "Make 2, start in white yarn:", "Using skin color yarn", "Start in dark gray yarn:"
    const useYarn = /^(?:(?:make|x)\s*(\d+)\s*,?\s*)?(?:start(?:ing)?\s+)?(?:in|with|use|using)\s+(.{1,30}?)\s+(?:colou?r\s+)?yarn\s*[:.]?\s*$/i.exec(body.trim())
      ?? /^(?:(?:make|x)\s*(\d+)\s*,?\s*)?(?:start(?:ing)?\s+)?(?:in|with|use|using)\s+([a-z ]{1,24}?)\s*[:.]?\s*$/i.exec(body.trim());
    if (useYarn && colorIn(useYarn[2])) {
      const c = colorFirst(useYarn[2])!;
      info.kind = 'material';
      if (pending) { pending.color = c; if (useYarn[1]) pending.quantity = +useYarn[1]; continue; }
      if (piece && !finished) { yarnId = ensureYarn(c); continue; }
      pending = { name: `Piece ${pieces.length + 1}`, quantity: useYarn[1] ? +useYarn[1] : 1, color: c, line: li };
      continue;
    }
    // "Leg 2: Ch 6, insert hook into leg 1", "Continue working around both legs and the chain"
    if (piece && piece.quantity >= 2 && /\b(?:leg|arm|foot)\s*1\b|\bboth (?:legs|feet)\b|\bfirst (?:leg|foot)\b/i.test(body) && /\b(insert|work|working|join|continue|crochet)\b/i.test(body)) {
      const ch = /\bch(?:ain)?\s*(\d+)/i.exec(body);
      const before = pendingLegs as { n: number } | null;
      pendingLegs = { piece, n: ch ? +ch[1] : before?.n ?? 0 };
      info.kind = 'start';
      continue;
    }
    // "Change to skin color yarn." between rounds
    const change = /^(?:change|switch)\s+(?:colou?r\s+|yarn\s+)?to\s+(.{1,30}?)(?:\s+colou?r)?(?:\s+yarn)?\s*[.:]?\s*$/i.exec(body.trim());
    if (change && colorIn(change[1]) && piece) { yarnId = ensureYarn(colorFirst(change[1])!); info.kind = 'material'; continue; }
    // "Attach Gold or Dark yellow where you fastened off": the same piece goes on in a new colour
    const reattach = /^(?:attach|join|pull up a loop (?:of|with|in))\s+(.{1,40}?)(?:\s+yarn)?\s+(?:where|at the (?:point|place|st|stitch)|in the (?:same|last) st)/i.exec(body.trim());
    if (reattach && colorIn(reattach[1]) && piece && !pending) {
      yarnId = ensureYarn(colorFirst(reattach[1])!);
      finished = false;
      info.kind = 'material';
      continue;
    }
    // "Pull up a loop of dark gray yarn in the first loop of round 13 at the back of the body"
    // (no front/back loops: a strand starts here, not a piece grown from a whole round)
    const loopAt = /\b(?:rnd|round|row)\s*(\d+)\b/i.exec(body);
    if (loopAt && /pull up a loop|join (?:the |your |new )?yarn|attach (?:the |your |new )?yarn/i.test(body) && !/\b(front|back)\s+loops?\b/i.test(body) && pieces.length) {
      const label = +loopAt[1];
      const host = namedPiece(body.toLowerCase().replace(/\bthe back of\b|\bthe front of\b/g, ''), pieces) ?? [...pieces].reverse().find((q) => q.sections.some((sc) => sc.labelMap.has(label)));
      if (host) {
        pendingLoop = { host, label, back: !/\bfront\b/i.test(body) };
        const c = colorFirst(body);
        if (c && pending && !pending.color) pending.color = c;
        info.kind = 'start';
        continue;
      }
    }
    // "Pull up a loop of white yarn in one of the leftover front loops of round 13 [of the body]"
    const grow = /\b(front|back)\s+loops?\b[^.]*?\b(?:of|from|on)\s+(?:the\s+)?(?:rnd|round|row|r)\.?\s*(\d+)/i.exec(body) ?? /\b(?:rnd|round|row)\s*(\d+)\b[^.]*\b(front|back)\s+loops?\b/i.exec(body);
    if (grow && /pull up a loop|join|attach|insert (?:the |your )?hook|work(?:ing)? (?:in|into)/i.test(body) && pieces.length) {
      const loopWord = /front/i.test(grow[0]) ? 'FLO' : 'BLO';
      const label = +(/\d+/.exec(grow[0])![0]);
      const host = namedPiece(body.toLowerCase().replace(/\b(front|back)\s+loops?\b|\bthe back of\b/g, ''), pieces) ?? [...pieces].reverse().find((q) => q.sections.some((sc) => sc.labelMap.has(label)));
      if (host) {
        pendingBase = { host, label, loop: loopWord };
        const c = colorFirst(body);
        if (c && pending && !pending.color) pending.color = c;
        info.kind = 'start';
        continue;
      }
    }
    if (/^(make|start with) (a )?mr\b/.test(n)) { info.kind = 'start'; pendingStart = { kind: 'magic-ring' }; continue; }
    // "Start by making a magic ring … with light blue"
    if (/^start\b/.test(n) && /\bmr\b/.test(n) && (!piece || finished || pending)) {
      info.kind = 'start';
      pendingStart = { kind: 'magic-ring' };
      const c = colorFirst(body);
      if (c) {
        if (pending) pending.color = pending.color ?? c;
        else pending = { name: pieces.length ? `Piece ${pieces.length + 1}` : title ?? 'Piece', quantity: 1, color: c, line: li };
      }
      continue;
    }

    if (/^\s*\(.{0,3}\)\s*(?:[=:-]\s*)?all in (?:one|the same|1) (?:st|stitch)/i.test(body)) continue;
    if (looksLikeHeading(body) && !/\b(sew|stuff|fasten|insert|attach|embroider|flatten)\b/i.test(body)) {
      if (!title && !sawRow && !pieces.length && !pending) {
        title = body.trim();
        info.kind = 'title';
        continue;
      }
      info.kind = 'heading';
      if (/^(written )?pattern|instructions|abbreviations|materials|notes?$/i.test(body.trim())) continue;
      pending = { ...headingInfo(body), line: li };
      continue;
    }
    if (isMat && !piece) { info.kind = 'material'; continue; }

    // Sentence-level handling for markers, finishing, assembly.
    let kind: LineInfo['kind'] = 'note';
    for (const snt of sentences(body)) {
      const s = snt.text.toLowerCase().replace(/\bf\/o\b/g, 'fasten off');
      const src: Span = { from: lineSrc.from + snt.from, to: lineSrc.from + snt.from + snt.text.length };
      const p = piece;
      if (/fasten( off)?\b|weave in|close the hole|close up/.test(s)) {
        kind = 'finish';
        if (p) {
          finished = true;
          p.finish = /tail|for sewing/.test(s) ? 'open-with-tail' : /close/.test(s) || smallEnd(p) ? 'closed' : 'open';
        }
      }
      if (/(do not|don't|doesn't|does not|don’t|doesn’t) (need to be )?stuff/.test(s)) { if (p) p.stuffing = 'none'; kind = 'marker'; }
      else if (/\bstuff/.test(s)) {
        const how = /light/.test(s) ? 'light' : 'firm';
        if (p) p.stuffing = how;
        else globalStuff = how;
        // "Stuff the legs and the body firmly": earlier pieces named right after "stuff" too
        const what = /\bstuff\s+(?!lightly|firmly|well)(?:the\s+)?(.+?)(?=\s+(?:firmly|lightly|well|with|as you go|and continue)\b|[.,;]|$)/.exec(s)?.[1] ?? '';
        for (const q of pieces) if (q !== p && q.stuffing === 'unspecified' && what && namedPiece(what, [q])) q.stuffing = how;
        kind = 'marker';
      }
      // shaping a stuffed piece by hand: triangle (onigiri), flat base so it stands, oval (egg)
      if (p && /\b(shape|mould|mold|press|form)\b[^.]*\btriang/.test(s)) { (p.shape ??= {}).triangle = true; kind = 'marker'; }
      else if (p && /\bflat(ten)?\b[^.]*\b(bottom|base)\b|\b(bottom|base)\b[^.]*\bflat/.test(s)) { (p.shape ??= {}).flatBottom = true; kind = 'marker'; }
      // "flatten the upper part of the arm and close it" flattens only the opening, not the piece
      else if (/\bflatten/.test(s) && p && !/\bflatten (?:only )?(?:the )?(?:upper|top|end|opening|last)\b/.test(s)) { p.flatten = true; kind = 'marker'; }
      else if (/\bflatten/.test(s)) { if (p) p.flatEdge = true; kind = 'marker'; }
      if (p && /\b(shape|mould|mold|form)\b[^.]*\b(oval|egg)/.test(s)) { (p.shape ??= {}).oval = true; kind = 'marker'; }
      if (!p) continue;
      const between = /(?:between|over|across)\s+(?:rnds?|rows?|rounds?|r)\.?\s*(\d+)\s*(?:and|&|-|to)\s*(?:(?:rnds?|rows?|rounds?|r)\.?\s*)?(\d+)/.exec(s);
      const atRow = /(?:at|on|in)\s+(?:rnd|row|round|r)\.?\s*(\d+)/.exec(s);
      const spacing = /(\d+)\s*(?:st|sts|stitch(?:es)?)\s*(?:apart|between|in between)|about\s+(\d+)\s*(?:st|sts|stitch(?:es)?)/.exec(s);
      const wrap = /\b(?:wrap|place|put)\b[^.]*?\baround\s+(?:the\s+)?([a-z]+)/.exec(s);
      if (/\bsew\b|\battach\b|\bglue\b|\bplace\b[^.]*\b(?:on|to)\b/.test(s) || wrap) {
        kind = 'assembly';
        // who is sewn to whom: "sew the bouquet to one of the arms" names its own piece
        const verb = /\b(sew|wrap|place|glue|attach|position|put)\b/.exec(s);
        const after = verb ? s.slice(verb.index + verb[0].length) : s;
        const prep = /\b(to|around|onto|on|over|between)\b/.exec(after);
        const subjText = prep ? after.slice(0, prep.index) : '';
        const subj = subjText ? namedPiece(subjText, pieces) : undefined;
        // "glue a stick to the umbrella", "sew the ch to …": not a piece being joined
        const subjNoun = subjText.replace(new RegExp(`\\b(?:${COLOR_NAMES.join('|')})\\b`, 'g'), ' ');
        if (!subj && new RegExp(String.raw`\b(?!(?:it|them|this|these|the|a|an|piece|pieces|part|parts|both|each|all|yarn|tail|tails|ends?|with|using|your|and|in|loosely|firmly|securely|together|on|up|${SHAPE_WORDS})\b)[a-z]{2,}\b`).test(subjNoun)) continue;
        if (/\b(?:do not|don't|don’t|never)\s+(?:sew|glue|attach)\b/.test(s)) continue;
        const p = subj ?? piece;
        if (!p) continue;
        const hostText = prep ? after.slice(prep.index) : s;
        // "sew the ends together", "sew it closed": the piece itself, not a join
        if (!wrap && (/\bsew\b[^.]*\b(?:closed|shut)\b|\bsew (?:the |its )?ends together\b|\bsew (?:both |the |its )?edges\b|\broll(?:ed)? (?:it )?up\b|\bsew\b[^.]*\btogether to (?:secure|create|make|form)\b/.test(s))) continue;
        // the piece right after the preposition is the host; a later clause only says where on it
        // ("to the front of the body, just below the head and in between the suspenders")
        const lead = prep ? prep[0].length : 0;
        const cut = /,|;|\b(?:just|right)\b|\b(?:in )?between\b|\bnext to\b|\bbelow\b|\babove\b|\bunder(?:neath)?\b|\bbeside\b/.exec(hostText.slice(lead));
        const primary = cut ? hostText.slice(0, lead + cut.index) : hostText;
        const named = namedPiece(primary, pieces, p) ?? namedPiece(hostText, pieces, p);
        const host = named ?? mainPiece(pieces, p);
        if (host) {
          const hint: Seam['hint'] = wrap ? 'wrap' : /\b(pom ?pom|antenna|bobble)/.test(p.name.toLowerCase()) && !/\b(side|front|back|bottom)\b/.test(s) ? 'top' : /below (the )?eyes/.test(s) ? 'below-eyes' : /\btop\b/.test(s) ? 'top' : /\bsides?\b/.test(s) ? 'side' : /\bfront\b/.test(s) ? 'front' : /\bback\b(?!\s+loops?)/.test(s) ? 'back' : /\b(?:bottom|underside|underneath)\b/.test(s) ? 'bottom' : 'default';
          const seam: Seam = { piece: p.id, host: host.id, hint, text: snt.text.trim(), line: li, src, spacingSts: spacing ? +(spacing[1] ?? spacing[2]) : undefined };
          if (wrap) seam.wrapAt = wrap[1];
          if (between) { seam.rowA = resolveRow(host, +between[1], li, src); seam.rowB = resolveRow(host, +between[2], li, src); }
          else if (atRow) { seam.rowA = seam.rowB = resolveRow(host, +atRow[1], li, src); }
          if (hint === 'default' && seam.rowA === undefined) diagnostics.push({ severity: 'info', code: 'assumption', line: li, src, message: `Placement is vague, using defaults (sides, mid-height of ${host.name}). Add "=> sew to ${host.name.toLowerCase()} rnds a-b at front/top/side" to fix.` });
          // one seam per pair: later sentences about the same join only add rows they name
          const dup = seams.find((q) => q.piece === seam.piece && q.host === seam.host);
          if (dup) { if (dup.rowA === undefined && seam.rowA !== undefined) Object.assign(dup, { rowA: seam.rowA, rowB: seam.rowB }); if (dup.hint === 'default' || seam.hint === 'wrap') { dup.hint = seam.hint; dup.wrapAt = seam.wrapAt; } continue; }
          seams.push(seam);
          // no piece by that name yet ("sew the flowers on the bouquet" before the bouquet's
          // instructions): look again once every piece is known
          if (!named) unnamedHost.set(seam, primary);
          if (p.finish === 'open' ) p.finish = 'open-with-tail';
        } else diagnostics.push({ severity: 'warning', code: 'unresolved-reference', line: li, src, message: 'No other piece to sew this to.' });
        continue;
      }
      if (/\beyes?\b|\bbutton\b|\bnose\b/.test(s) && /\b(add|insert|place|attach|put)\b/.test(s) && !/eyebrow/.test(s)) {
        kind = 'marker';
        let ra: number | undefined; let rb: number | undefined;
        if (between) { ra = resolveRow(p, +between[1], li, src); rb = resolveRow(p, +between[2], li, src); }
        else if (atRow) ra = rb = resolveRow(p, +atRow[1], li, src);
        if (ra !== undefined) p.markers.push({ kind: 'safety-eyes', rowA: ra, rowB: rb, spacingSts: spacing ? +(spacing[1] ?? spacing[2]) : 6, sizeMm: materials.eyeMm, text: snt.text.trim(), line: li, src });
        continue;
      }
      if (/eyebrow|embroider|mouth|cheek|blush/.test(s)) {
        kind = 'marker';
        const rel = /(\d+)\s*(?:rows?|rnds?|rounds?)\s*(above|below)\s*(?:the\s+)?eyes/.exec(s);
        const eyes = p.markers.find((m) => m.kind === 'safety-eyes');
        let row: number | undefined;
        if (rel && eyes) {
          const base = Math.min(eyes.rowA, eyes.rowB ?? eyes.rowA);
          row = rel[2] === 'above' ? base - +rel[1] : Math.max(eyes.rowA, eyes.rowB ?? eyes.rowA) + +rel[1];
          diagnostics.push({ severity: 'info', code: 'assumption', line: li, src, message: `"${rel[2]}" read as toward the ${rel[2] === 'above' ? 'start (magic ring)' : 'end'} of the piece.` });
        } else if (between) row = resolveRow(p, +between[1], li, src);
        else if (atRow) row = resolveRow(p, +atRow[1], li, src);
        // cheeks with no row given: level with the eyes, a little further out
        const cheeks = /cheek|blush/.test(s);
        if (row === undefined && cheeks && eyes) row = Math.min(eyes.rowA, eyes.rowB ?? eyes.rowA);
        if (row !== undefined) p.markers.push({ kind: 'embroidery', rowA: row, spacingSts: cheeks && eyes ? (eyes.spacingSts ?? 6) + 6 : eyes?.spacingSts, text: snt.text.trim(), line: li, src });
        continue;
      }
    }
    info.kind = kind;
    if (kind === 'note' && piece && /\b(sc|dc|hdc|slst|inc|dec)\b/.test(n) && /\d/.test(n)) {
      info.status = 'assumption';
      diagnostics.push({ severity: 'info', code: 'assumption', line: li, src: lineSrc, message: 'This looks like an instruction but has no row/round label (e.g. "Rnd 5:"), so it is treated as a note.' });
    }
  }

  // Post-process pieces.
  for (const p of pieces) {
    if (p.start.kind === 'chain' && !p.start.ring && p.construction === 'spiral' && !p.oval) p.construction = 'rows';
    if (p.finish === 'open' && p.construction !== 'rows' && smallEnd(p)) p.finish = 'closed';
    if (p.stuffing === 'unspecified' && globalStuff && p.construction !== 'rows' && !p.flatten && p.rows.length >= 2) p.stuffing = globalStuff;
    if (p.stuffing === 'unspecified') {
      if (p.construction !== 'rows' && p.finish === 'closed') {
        p.stuffing = 'firm';
      } else p.stuffing = 'none';
    }
    if (!p.rows.length) diagnostics.push({ severity: 'warning', code: 'row-sequence', line: p.line, src: { from: offsets[p.line], to: offsets[p.line] + rawLines[p.line].length }, message: `${p.name} has no rows.` });
  }
  for (const d of diagnostics) {
    const li = lines[d.line];
    if (!li) continue;
    const rank = { ok: 0, assumption: 1, ambiguous: 2, unreadable: 3 } as const;
    const st = d.severity === 'error' ? 'unreadable' : d.severity === 'warning' ? 'ambiguous' : 'assumption';
    if (rank[st] > rank[li.status]) li.status = st;
  }
  // A piece whose last round matches the host's open last round, attached with no place named, is a
  // lid joined stitch for stitch (coffee in a cup). Stuffing put in "before finishing the round" fills
  // the host under the lid.
  for (const seam of seams) {
    if (seam.hint !== 'default' || seam.rowA !== undefined) continue;
    const p = pieces.find((q) => q.id === seam.piece), h = pieces.find((q) => q.id === seam.host);
    if (!p || !h || h.finish === 'closed' || !p.rows.length || !h.rows.length) continue;
    if (p.rows[p.rows.length - 1].computedCount !== h.rows[h.rows.length - 1].computedCount || p.quantity !== 1) continue;
    seam.hint = 'lid';
    const vague = diagnostics.findIndex((d) => d.line === seam.line && d.message.startsWith('Placement is vague'));
    if (vague >= 0) diagnostics.splice(vague, 1);
    if (p.stuffing !== 'none' && p.stuffing !== 'unspecified') h.stuffing = p.stuffing;
    diagnostics.push({ severity: 'info', code: 'assumption', line: seam.line, src: seam.src, message: `${p.name} has as many stitches as the open edge of ${h.name}, so it is joined on as a lid.` });
  }
  for (const [seam, text] of unnamedHost) {
    const subj = pieces.find((q) => q.id === seam.piece);
    const h = subj && seam.rowA === undefined ? namedPiece(text, pieces, subj) : undefined;
    if (h && h.id !== seam.piece) seam.host = h.id;
  }
  return { title, terms, materials, pieces: pieces.filter((p) => p.rows.length || p.strap), seams, diagnostics, lines };
}
