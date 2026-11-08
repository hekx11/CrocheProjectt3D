import type {
  Diagnostic, LineInfo, Marker, Materials, Pattern, PieceDef, RowDef, Seam, Section, Span, Yarn,
} from '../model/types';
import { COLORS, DEFAULT_YARN_COLOR, FIBERS, WEIGHT_NAMES } from '../model/dictionary';
import { detectTerms, normalize } from './normalize';
import { countOf, execute, parseRowText } from './row';

// "Rnd 5:", "5.", "Rnds 6-10:", "Round 10 - Round 14:", "R4-6 sc around"
const LABEL_RE = /^\s*(?:(rnds?|rounds?|rows?|r)\.?\s*)?(\d+)(?:\s*(?:-|–|—|to)\s*(?:(?:rnds?|rounds?|rows?|r)\.?\s*)?(\d+))?\s*[:.)](?!\d)\s*|^\s*(rnds?|rounds?|rows?|r)\.?\s*(\d+)(?:\s*(?:-|–|—|to)\s*(?:(?:rnds?|rounds?|rows?|r)\.?\s*)?(\d+))?\s+/i;
/** A piece that is a single unlabelled round: "6hdc in the magic ring (6)" (tiny ears, noses). */
const FIRST_ROUND_RE = /^\s*\d+\s*(?:sc|hdc|dc|tr|single crochets?|half double crochets?|double crochets?)\b[^.]*\b(?:magic ring|magic circle|adjustable ring|mr)\b/i;
const COLOR_NAMES = Object.keys(COLORS).sort((a, b) => b.length - a.length);

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
    const fiber = Object.keys(FIBERS).find((f) => t.includes(f));
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

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Previous row's stitch count as the next row sees it (shared with the row loop). */
function prevOf(piece: PieceDef): { prevCount: number; ringMode: boolean } {
  const prev = piece.rows[piece.rows.length - 1];
  const ringMode = !prev && (piece.start.kind === 'magic-ring' || (piece.start.kind === 'chain' && piece.start.ring));
  const prevCount = prev ? prev.computedCount : piece.start.kind === 'chain' && !piece.start.ring ? piece.start.n : 0;
  return { prevCount, ringMode };
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
  let yarnId = defaultYarn.id;
  let finished = false;
  let lastLabel: number | undefined;
  let sawRow = false;

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

      const needNew = !piece || (pending !== null && (finished || startsNew)) || (finished && startsNew) || (startsNew && a === 1 && piece.rows.length > 0);
      if (needNew) {
        const name = pending?.name ?? (pieces.length ? `Piece ${pieces.length + 1}` : title ?? 'Piece');
        piece = newPiece(name, pending?.quantity ?? 1, pending?.line ?? li);
        if (pendingStart) { piece.start = pendingStart; pendingStart = null; }
        if (piece.start.kind === 'chain' && !piece.start.ring) piece.construction = 'rows';
        piece.sections.push({ name: piece.name, firstRow: 1, yarnId: pending?.color ? ensureYarn(pending.color) : undefined, labelMap: new Map() });
        if (pending?.color) yarnId = pending.color;
        else if (pieces.length > 1) yarnId = defaultYarn.id;
        pending = null;
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

      const leadingChIsTurning = piece.construction === 'rows' || piece.construction === 'joined-rounds' || /^\s*ch \d+\s*,/.test(normalized) && piece.rows.length > 0 && piece.start.kind === 'chain';
      const rowOpts = { terms, leadingChIsTurning, src: lineSrc };
      let parsed = parseRowText(instr, rowOpts);
      const notesHere: string[] = [];
      let readings: string[] | undefined;
      let pickNeeded = false;

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
        const { prevCount, ringMode } = prevOf(piece);
        const want = parsed.expectedCount;
        const countFor = (pr: typeof parsed) => countOf(execute(pr.ops, prevCount, ringMode), want.unit);
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
          } else if (want.unit === 'st' && execute(parsed.ops, prevCount, ringMode).stitches.length === want.n) {
            notesHere.push(`the stated count ${want.n} includes the chains`);
            parsed = { ...parsed, expectedCount: { n: countFor(parsed), unit: 'st' } };
          }
        }
      }
      if (parsed.colorChange) yarnId = ensureYarn(parsed.colorChange);
      if (parsed.turn) piece.construction = 'rows';
      if (parsed.join && piece.construction === 'spiral') piece.construction = 'joined-rounds';
      if (parsed.stuffing) piece.stuffing = parsed.stuffing === 'none' ? 'none' : parsed.stuffing;

      let status: RowDef['status'] = 'ok';
      const sec = section();
      for (let label = a; label <= b; label++) {
        const prev = piece.rows[piece.rows.length - 1];
        const ringMode = !prev && (piece.start.kind === 'magic-ring' || (piece.start.kind === 'chain' && piece.start.ring));
        const prevCount = prev ? prev.computedCount + (piece.construction !== 'rows' ? 0 : 0) : piece.start.kind === 'chain' && !piece.start.ring ? piece.start.n : 0;
        const ex = execute(parsed.ops, prevCount, ringMode);
        const computed = countOf(ex, parsed.expectedCount?.unit ?? 'st');
        const stitchCount = countOf(ex, 'st') + (ex.stitches.some((s) => s.isChain) && countOf(ex, 'st') === 0 ? ex.stitches.length : 0);
        const row: RowDef = {
          index: piece.rows.length + 1, label: String(label), labelNumber: label, ops: parsed.ops,
          expectedCount: parsed.expectedCount, computedCount: ex.stitches.length ? ex.stitches.length : stitchCount,
          yarnId, join: parsed.join, turn: parsed.turn, line: li, src: lineSrc, status: 'ok',
        };
        // "computedCount" in the graph sense = all produced stitches the next row can work into
        row.computedCount = ex.stitches.length;
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
        piece.finish = parsed.tail ? 'open-with-tail' : parsed.close || (piece.rows[piece.rows.length - 1]?.computedCount ?? 99) <= 8 ? 'closed' : 'open';
      }
      continue;
    }

    // --- non-row lines ----------------------------------------------------
    const isMat = readMaterials(body, { yarns: [] }, terms);
    if (isMat && !sawRow) { info.kind = 'material'; continue; }
    const n = normalize(body, terms);

    // Start lines: "Ch 16." / "Ch 4 and join with a sl st to form a ring" / "Make a magic ring"
    const ch = /^ch (\d+)\b(.*)$/.exec(n);
    if (ch && !/,\s*(sc|dc|hdc)/.test(ch[2])) {
      info.kind = 'start';
      const start: PieceDef['start'] = { kind: 'chain', n: +ch[1], ring: /ring|join/.test(ch[2]) };
      if (pending || finished || !piece) pendingStart = start;
      else if (piece.rows.length === 0) piece.start = start;
      else pendingStart = start;
      if (!start.ring && piece && !pending && !finished && piece.rows.length === 0) piece.construction = 'rows';
      continue;
    }
    const useYarn = /^(?:use|using|with)\s+(.{1,30}?)\s+(?:colou?r\s+)?yarn\b/i.exec(body.trim());
    if (useYarn && colorIn(useYarn[1]) && pending) { pending.color = colorIn(useYarn[1]); info.kind = 'material'; continue; }
    if (/^(make|start with) (a )?mr\b/.test(n)) { info.kind = 'start'; pendingStart = { kind: 'magic-ring' }; continue; }

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
      const s = snt.text.toLowerCase();
      const src: Span = { from: lineSrc.from + snt.from, to: lineSrc.from + snt.from + snt.text.length };
      const p = piece;
      if (/fasten( off)?\b|weave in|close the hole|close up/.test(s)) {
        kind = 'finish';
        if (p) {
          finished = true;
          p.finish = /tail|for sewing/.test(s) ? 'open-with-tail' : /close/.test(s) || (p.rows[p.rows.length - 1]?.computedCount ?? 99) <= 8 ? 'closed' : 'open';
        }
      }
      if (/(do not|don't) stuff/.test(s)) { if (p) p.stuffing = 'none'; kind = 'marker'; }
      else if (/\bstuff/.test(s)) { if (p) p.stuffing = /light/.test(s) ? 'light' : 'firm'; kind = 'marker'; }
      if (/\bflatten/.test(s) && p) { p.flatten = true; kind = 'marker'; }
      if (!p) continue;
      const between = /between\s+(?:rnds?|rows?|rounds?|r)\.?\s*(\d+)\s*(?:and|&|-|to)\s*(?:(?:rnds?|rows?|rounds?|r)\.?\s*)?(\d+)/.exec(s);
      const atRow = /(?:at|on|in)\s+(?:rnd|row|round|r)\.?\s*(\d+)/.exec(s);
      const spacing = /(\d+)\s*(?:st|sts|stitch(?:es)?)\s*(?:apart|between|in between)|about\s+(\d+)\s*(?:st|sts|stitch(?:es)?)/.exec(s);
      if (/\bsew\b|\battach\b/.test(s)) {
        kind = 'assembly';
        const host = pieces.find((q) => q !== p && s.includes(q.name.toLowerCase().replace(/s$/, ''))) ?? pieces.find((q) => q !== p);
        if (host) {
          const hint: Seam['hint'] = /below (the )?eyes/.test(s) ? 'below-eyes' : /\btop\b/.test(s) ? 'top' : /\bsides?\b/.test(s) ? 'side' : /\bfront\b/.test(s) ? 'front' : /\bback\b(?!\s+loops?)/.test(s) ? 'back' : /\bbottom\b/.test(s) ? 'bottom' : 'default';
          const seam: Seam = { piece: p.id, host: host.id, hint, text: snt.text.trim(), line: li, src, spacingSts: spacing ? +(spacing[1] ?? spacing[2]) : undefined };
          if (between) { seam.rowA = resolveRow(host, +between[1], li, src); seam.rowB = resolveRow(host, +between[2], li, src); }
          else if (atRow) { seam.rowA = seam.rowB = resolveRow(host, +atRow[1], li, src); }
          if (hint === 'default' && seam.rowA === undefined) diagnostics.push({ severity: 'info', code: 'assumption', line: li, src, message: `Placement is vague, using defaults (sides, mid-height of ${host.name}). Add "=> sew to ${host.name.toLowerCase()} rnds a-b at front/top/side" to fix.` });
          // one seam per pair: later sentences about the same join only add rows they name
          const dup = seams.find((q) => q.piece === seam.piece && q.host === seam.host);
          if (dup) { if (dup.rowA === undefined && seam.rowA !== undefined) Object.assign(dup, { rowA: seam.rowA, rowB: seam.rowB }); if (dup.hint === 'default') dup.hint = seam.hint; continue; }
          seams.push(seam);
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
        if (row !== undefined) p.markers.push({ kind: 'embroidery', rowA: row, spacingSts: eyes?.spacingSts, text: snt.text.trim(), line: li, src });
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
    if (p.start.kind === 'chain' && !p.start.ring && p.construction === 'spiral') p.construction = 'rows';
    if (p.finish === 'open' && p.construction !== 'rows' && (p.rows[p.rows.length - 1]?.computedCount ?? 99) <= 8) p.finish = 'closed';
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
  return { title, terms, materials, pieces: pieces.filter((p) => p.rows.length), seams, diagnostics, lines };
}
