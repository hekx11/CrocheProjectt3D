import type { Loop, Op, Span, StitchType, Target } from '../model/types';
import { COLORS } from '../model/dictionary';
import { normalize } from './normalize';

/** Result of reading one row/round instruction. */
export interface RowParse {
  ops: Op[];
  expectedCount?: { n: number; unit: string };
  colorChange?: string; // colour name
  join: boolean;
  turn: boolean;
  fastenOff: boolean;
  tail: boolean; // "leaving a long tail"
  close: boolean;
  stuffing?: 'light' | 'firm' | 'none';
  assumptions: string[];
  ignored: string[]; // words the grammar could not use
  unreadable: boolean;
  /** Repeat count came from "N times" after "rep from *" (could mean N or N+1). */
}

const STITCHES = new Set(['ch', 'slst', 'sc', 'hdc', 'dc', 'tr', 'dtr', 'inc', 'dec']);
const FILLER = new Set([
  'work', 'make', 'do', 'then', 'the', 'a', 'an', 'and', 'of', 'to', 'it', 'them', 'each', 'one', 'more', 'continue',
  'all', 'way', 'stitches', 'evenly', 'total', 'together', 'round', 'rnd', 'row', 'this', 'that', 'is', 'as', 'you', 'go',
]);

type Tok = { t: string; i: number };

function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  const re = /\d+|[a-z][a-z0-9\-']*|[()\[\],;*x]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push({ t: m[0], i: m.index });
  return out;
}

/** Extract the stated stitch count: [18], (18), (12 dc), (12 ch-3 loops), - 18 st */
export function extractCount(s: string): { rest: string; count?: { n: number; unit: string } } {
  const re = /[\[({]\s*(\d+)\s*([a-z][a-z0-9\- ]*)?\s*[\])}](?!\s*(x\b|\*|times|\d))/g;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const unit = (m[2] ?? '').trim();
    if (/counts|from|in |next/.test(unit)) continue;
    last = m;
  }
  if (last) {
    const unit = (last[2] ?? '').trim();
    const rest = s.slice(0, last.index) + ' ' + s.slice(last.index + last[0].length);
    return { rest, count: { n: +last[1], unit: /loop|space|sp\b|petal|ch-/.test(unit) ? 'loops' : 'st' } };
  }
  // "(40 sc and 40 ch 1's)": the stitches, not the chain spaces between them
  const both = /\((\d+)\s*(?:sc|st|sts|dc|hdc|slst|sl st)\s+and\s+\d+\s*ch[^)]*\)/.exec(s);
  if (both) return { rest: s.slice(0, both.index) + ' ' + s.slice(both.index + both[0].length), count: { n: +both[1], unit: 'st' } };
  const t = /(?:[-=:]\s*|,\s*)(\d+)\s*st\s*\.?\s*$/.exec(s);
  if (t) return { rest: s.slice(0, t.index), count: { n: +t[1], unit: 'st' } };
  return { rest: s };
}

/** Parse a normalised instruction into ops. */
export function parseRowText(raw: string, opts: { terms: 'US' | 'UK'; leadingChIsTurning: boolean; src: Span; groupsInOne?: boolean }): RowParse {
  const res: RowParse = {
    ops: [], join: false, turn: false, fastenOff: false, tail: false, close: false,
    assumptions: [], ignored: [], unreadable: false,
  };
  let s = normalize(raw, opts.terms);
  const c = extractCount(s);
  s = c.rest;
  res.expectedCount = c.count;

  // Side notes after the instruction ("When working in the yellow stitches, …", "For all stitches
  // in blue work as usual.") are not stitches; keep their words visible as skipped.
  s = s.replace(/(^|[.]\s+)((?:when|for all|for each|if|note|make sure|remember|tip|this will|you will|you should)\b[^.]*)(?=\.|$)/g, (_m, pre, note) => {
    res.ignored.push(...note.split(/\s+/).filter((w: string) => /[a-z]{3,}/.test(w) && !/^(the|and|for|each|all|with|work|working|when|will|you|this|that|should|usual|stitches|st)$/.test(w)));
    return pre + ' ';
  });
  // --- non-stitch clauses -------------------------------------------------
  const take = (re: RegExp, fn: (m: RegExpExecArray) => void) => {
    const m = re.exec(s);
    if (m) {
      fn(m);
      s = s.slice(0, m.index) + ' , ' + s.slice(m.index + m[0].length);
      return true;
    }
    return false;
  };
  const colorNames = Object.keys(COLORS).sort((a, b) => b.length - a.length).join('|');
  take(new RegExp(`(?:change (?:color |yarn )?to|switch to|join|with|using)\\s+(${colorNames})(\\s+colou?r)?(\\s+yarn)?`), (m) => (res.colorChange = m[1]));
  take(/fasten off.*$/, (m) => {
    res.fastenOff = true;
    if (/tail|sew/.test(m[0])) res.tail = true;
    if (/close|cinch|pull tight/.test(m[0])) res.close = true;
  });
  take(/(?:do not|don't) stuff\b[^,]*/, () => (res.stuffing = 'none'));
  take(/(?:add )?stuff(?:ing|ed)?\b[^,]*/, (m) => (res.stuffing = /light/.test(m[0]) ? 'light' : 'firm'));
  take(/(?:,\s*)?(?:ending with\s+)?(?:join(?:ing)?\s+(?:with\s+)?(?:a\s+)?)?slst\s+(?:in|to)\s+(?:the\s+)?(?:top|base|first|beg|beginning)\b[^,;]*/, () => (res.join = true));
  take(/\bjoin(?:ing)?\b(?:\s+with\s+(?:a\s+)?slst)?[^,;]*/, () => (res.join = true));
  // "7 sc, ch 1, turn": the chain at the end is the next row's turning chain, not a stitch
  take(/[,;]?\s*ch\s*\d?\s*,?\s*turn\b/, () => (res.turn = true));
  while (take(/\bturn\b/, () => (res.turn = true)));
  // "mr, 6sc": the magic ring is already the start; "36sc, slst": the slip stitch only closes the round
  take(/^\s*mr\s*[,:]\s*(?=\d)/, () => {});
  take(/[,;]\s*slst\s*$/, () => {});

  // --- "working in back loops only, …" sets the loop for the whole row -------
  let rowLoop: Loop = 'both';
  take(/^\s*(?:working\s+|work\s+)?(blo|flo)\b\s*(?:throughout|for this (?:round|row|rnd))?\s*(?:[,:]|(?=\d))/, (m) => (rowLoop = m[1] === 'blo' ? 'BLO' : 'FLO'));
  take(/[,;]?\s*(?:working\s+|work\s+)(blo|flo)\s*$/, (m) => (rowLoop = m[1] === 'blo' ? 'BLO' : 'FLO'));

  // --- "decrease 6 sts evenly", "6 inc evenly around", "dec evenly 6 times" --
  let evenly: { change: 'inc' | 'dec'; k: number } | null = null;
  take(/(?:(\d+)\s*)?\b(inc|dec)\s*(?:(\d+)\s*)?(?:st\s*)?(?:times\s*)?evenly(?:\s*spaced)?(?:\s*(?:around|across|over the (?:round|row)))?(?:\s*(\d+)\s*times)?/, (m) => {
    const k = +(m[1] ?? m[3] ?? m[4] ?? 0);
    if (k > 0) evenly = { change: m[2] as 'inc' | 'dec', k };
  });

  // "*inc, 1 sc in next 3 st* repeat around", "*…* rep 4 more times" (closed stars first, or the
  // open-star rule below would read "* rep around" as an empty repeat)
  s = s.replace(/\*([^*]+)\*\s*[,.]?\s*rep\s*(around|across|(\d+)\s*more times|(\d+)\s*times)?/g, (_m, body, _kind, more, times) =>
    more ? ` [ ${body} ] x ${+more + 1} ` : times ? ` [ ${body} ] x ${+times} ` : ` [ ${body} ] around `);
  // --- star repeats: *X; rep from * around / N more times / N times ------
  s = s.replace(/\*([^*]+?)[;,]?\s*rep\s*(?:from\s*)?\*?\s*(around|across|to end|(\d+)\s*more times|(\d+)\s*times)?/g, (_m, body, kind, more, times) => {
    if (more) return ` [ ${body} ] x ${+more + 1} `;
    if (times) {
      res.assumptions.push(`"repeat from * ${times} times" read as ${times} times in total`);
      return ` [ ${body} ] x ${+times} `;
    }
    return ` [ ${body} ] around `;
  });
  s = s.replace(/\*([^*]+)\*\s*(\d+)\s*times/g, ' [ $1 ] x $2 ');
  // "sc in next 2 st, inc; rep 5 more times" (no star): repeat everything before it
  if (!s.includes('*')) {
    s = s.replace(/^(.*?)[;,.]\s*rep\s*(?:from\s+(?:beg\w*|start)\s*)?(?:(\d+)\s*more times|(\d+)\s*times|(around|across))\s*[,.]?\s*$/, (_m, body, more, times, around) => {
      if (more) return ` [ ${body} ] x ${+more + 1} `;
      if (times) {
        res.assumptions.push(`"repeat ${times} times" read as ${times} times in total`);
        return ` [ ${body} ] x ${+times} `;
      }
      return ` [ ${body} ] around `;
    });
  }
  s = s.replace(/\brep\b.*$/, (m) => {
    res.ignored.push(m.trim());
    return '';
  });

  const toks = tokenize(s);
  let pos = 0;
  const peek = (k = 0) => toks[pos + k]?.t;
  const next = () => toks[pos++]?.t;
  const isNum = (t?: string) => t !== undefined && /^\d+$/.test(t);
  let lastType: StitchType | 'inc' | 'dec' | null = null;
  let nestedAround = false;
  let depth = 0;

  const mk = (type: StitchType, target: Target, loop: Loop, tension: number, consumes = 1): Op => ({
    kind: 'stitch', type, target, loop, tension, consumes, src: opts.src,
  });

  type Rep = number | 'around' | { leave: number };
  function readRep(): Rep | null {
    const t = peek();
    // "until 2 st remain", "to last 3 st", "to last st", "until 1 st left"
    if (t === 'until' || (t === 'to' && (peek(1) === 'last' || (peek(1) === 'the' && peek(2) === 'last')))) {
      let q = pos + 1;
      if (toks[q]?.t === 'the') q++;
      if (toks[q]?.t === 'last') q++;
      let leave = 1;
      if (/^\d+$/.test(toks[q]?.t ?? '')) leave = +toks[q++].t;
      if (toks[q]?.t === 'st' || toks[q]?.t === 'ch') q++;
      if (/^(remain|remaining|left|unworked)$/.test(toks[q]?.t ?? '')) q++;
      pos = q;
      return { leave };
    }
    if (t === 'x' || t === '*') {
      if (isNum(peek(1))) { pos += 2; return +toks[pos - 1].t; }
    }
    if (isNum(t) && peek(1) === 'times') { pos += 2; return +toks[pos - 2].t; }
    if (t === 'around' || t === 'across') { pos++; return 'around'; }
    return null;
  }

  function wrap(ops: Op[], rep: Rep | null): Op[] {
    if (rep === null) return ops;
    // "sc in each st around until 2 st remain": the "around" stops early
    if (typeof rep === 'object' && ops.length === 1 && ops[0].kind === 'repeat' && ops[0].times === 'around') {
      return [{ ...ops[0], times: rep }];
    }
    if (rep === 'around' && depth > 0) nestedAround = true;
    return [{ kind: 'repeat', ops, times: rep, src: opts.src }];
  }

  function parseSeq(close?: string): Op[] {
    const ops: Op[] = [];
    while (pos < toks.length) {
      const t = peek();
      if (close && t === close) { pos++; return ops; }
      if (t === ')' || t === ']') { pos++; if (!close) { res.ignored.push(t!); continue; } return ops; }
      if (t === ',' || t === ';' || t === 'and') { pos++; continue; }
      const item = parseItem();
      if (item) ops.push(...item);
      else {
        const w = next()!;
        if (!FILLER.has(w)) res.ignored.push(w);
      }
    }
    return ops;
  }

  function parseItem(): Op[] | null {
    const t = peek();
    if (t === '(' || t === '[') {
      pos++;
      depth++;
      let inner = parseSeq(t === '(' ? ')' : ']');
      depth--;
      // "(sc, ch 2, sc) in next st": the whole group goes into one stitch
      if (peek() === 'in' && /^(next|same|first|last|st|ch)$/.test(peek(1) ?? '') && !isNum(peek(2))) {
        pos++;
        const w = next()!;
        if (w !== 'st' && w !== 'ch' && (peek() === 'st' || peek() === 'ch')) pos++;
        inner = intoOne(inner, w === 'same');
      }
      const rep = readRep();
      // the pattern's key says "(…) all in one stitch": "(1 hdc, 1 dc)", "(2 hdc)"
      if (opts.groupsInOne && t === '(' && rep === null && inner.length && inner.every((o) => o.kind === 'stitch' && o.target.kind === 'next' && o.consumes === 1) || opts.groupsInOne && t === '(' && rep === null && inner.length === 1 && inner[0].kind === 'repeat' && typeof inner[0].times === 'number' && inner[0].ops.every((o) => o.kind === 'stitch')) {
        const flat = inner.flatMap((o) => (o.kind === 'repeat' ? Array.from({ length: o.times as number }, () => o.ops).flat() : [o]));
        return intoOne(flat, false);
      }
      if (rep === 'around' && containsAround(inner)) return inner;
      return wrap(inner, rep);
    }
    if (t === 'skip' || t === 'sk') {
      pos++;
      if (peek() === 'next') pos++;
      let n = 1;
      if (isNum(peek())) n = +next()!;
      if (peek() === 'st' || peek() === 'ch') pos++;
      return [{ kind: 'skip', n, src: opts.src }];
    }
    return parsePhrase();
  }

  function parsePhrase(): Op[] | null {
    const start = pos;
    let n = 1;
    let hasN = false;
    let tension = 1;
    let loop: Loop = rowLoop;
    if (isNum(peek())) { n = +next()!; hasN = true; }
    while (peek() === 'loose' || peek() === 'tight' || peek() === 'blo' || peek() === 'flo') {
      const w = next()!;
      if (w === 'loose') tension = 1.15;
      else if (w === 'tight') tension = 0.9;
      else loop = w === 'blo' ? 'BLO' : 'FLO';
    }
    let type: StitchType | 'inc' | 'dec' | null = null;
    if (peek() && STITCHES.has(peek()!)) type = next() as any;
    else if (peek() === 'in' && lastType) type = lastType; // "... and in each ch across"
    else { pos = start; return null; }
    // "ch 3" — number after chain
    if (type === 'ch' && !hasN && isNum(peek())) { n = +next()!; hasN = true; }
    if (type === 'ch' && peek() === '(' && toks[pos + 1]?.t === 'counts') {
      // "ch 3 (counts as first dc)"
      pos += 2;
      while (peek() && peek() !== ')' && !STITCHES.has(peek()!)) pos++;
      const as = STITCHES.has(peek() ?? '') ? (next() as StitchType) : 'dc';
      if (peek() === ')') pos++;
      lastType = as;
      return [mk(as, { kind: 'next' }, loop, tension)];
    }
    // trailing loop words / tension
    const readMods = () => {
      while (peek() === 'blo' || peek() === 'flo' || peek() === 'loose' || peek() === 'tight') {
        const w = next()!;
        if (w === 'loose') tension = 1.15;
        else if (w === 'tight') tension = 0.9;
        else loop = w === 'blo' ? 'BLO' : 'FLO';
      }
    };
    readMods();

    // target
    let target: 'next' | 'same' | 'ring' | 'each' | 'from-hook' | 'none' = type === 'ch' ? 'none' : 'next';
    let k = 1; // how many targets
    let hook = 0;
    let around = false;
    if (peek() === 'in' || peek() === 'on' || peek() === 'at') {
      pos++;
      while (peek() === 'the' || peek() === 'a' || peek() === 'an') pos++;
      readMods();
      const w = peek();
      if (w === 'next') {
        pos++;
        if (isNum(peek())) k = +next()!;
        if (peek() === 'st' || peek() === 'ch') pos++;
        target = 'next';
      } else if (w === 'each') {
        pos++;
        if (peek() === 'st' || peek() === 'ch') pos++;
        target = 'each';
      } else if (w === 'same') {
        pos++;
        if (peek() === 'st' || peek() === 'ch') pos++;
        target = 'same';
      } else if (w === 'mr' || w === 'ring') {
        pos++;
        target = 'ring';
      } else if (isNum(w) && toks[pos + 1]?.t === 'ch' && toks[pos + 2]?.t === 'from') {
        hook = +next()!;
        pos += 2;
        if (peek() === 'hook') pos++;
        target = 'from-hook';
      } else if (w === 'st' || w === 'ch' || w === 'first' || w === 'last') {
        pos++;
        if (peek() === 'st' || peek() === 'ch') pos++;
        target = 'next';
      }
      readMods();
    }
    if (peek() === 'around' || peek() === 'across') { pos++; around = true; }
    readMods();
    const rep = readRep();
    lastType = type;

    // Build one "unit" = stitches worked into a single target (or none for chains).
    const unit = (first: Target): Op[] => {
      if (type === 'inc') return [mk('sc', first, loop, tension), mk('sc', { kind: 'same' }, loop, tension)];
      if (type === 'dec') return [mk('sc', first, loop, tension, 2)];
      const st = type as StitchType;
      if (st === 'ch') return Array.from({ length: n }, () => mk('ch', { kind: 'none' }, loop, tension, 0));
      const ops: Op[] = [mk(st, first, loop, tension)];
      for (let i = 1; i < n; i++) ops.push(mk(st, { kind: 'same' }, loop, tension));
      return ops;
    };

    let ops: Op[];
    if (type === 'ch') ops = unit({ kind: 'none' });
    else if (target === 'ring') {
      // "6 sc in mr": n stitches into the ring
      if (type === 'inc' || type === 'dec') ops = repeatN(unit({ kind: 'ring' }), n);
      else ops = Array.from({ length: n }, () => mk(type as StitchType, { kind: 'ring' }, loop, tension));
    } else if (target === 'same') {
      if (type === 'inc' || type === 'dec') ops = repeatN(unit({ kind: 'same' }), n);
      else ops = Array.from({ length: n }, () => mk(type as StitchType, { kind: 'same' }, loop, tension));
    } else if (target === 'from-hook') {
      ops = unit({ kind: 'ch-from-hook', n: hook });
      if (around) ops = [...ops, { kind: 'repeat', ops: unit({ kind: 'next' }), times: 'around', src: opts.src }];
    } else if (target === 'each' || around) {
      // "2 dc in each st around", "sc around", "inc in each st"
      const u = type === 'inc' || type === 'dec' ? unit({ kind: 'next' }) : unit({ kind: 'next' });
      ops = [{ kind: 'repeat', ops: u, times: 'around', src: opts.src }];
      if (depth > 0) nestedAround = true;
      if (hasN && type !== 'inc' && type !== 'dec' && n > 1) {
        /* n per target already in unit */
      }
    } else {
      // next k: "sc in next 2 st" → 2 units; "6 sc" → 6 single stitches; "2 sc in next st" → one unit of 2
      if (k > 1) ops = repeatN(unit({ kind: 'next' }), k);
      else if (hasN && (type === 'inc' || type === 'dec')) ops = repeatN(unit({ kind: 'next' }), n);
      else if (hasN && peekWasTargetNext(start)) ops = unit({ kind: 'next' });
      else if (hasN) ops = repeatN([mk(type as StitchType, { kind: 'next' }, loop, tension)], n);
      else ops = unit({ kind: 'next' });
    }
    return wrap(ops, rep);
  }

  function peekWasTargetNext(start: number): boolean {
    // true when the phrase contained "in next st" (single target) — n stitches go into one stitch
    for (let i = start; i < pos; i++) if (toks[i].t === 'in' && (toks[i + 1]?.t === 'next' || toks[i + 1]?.t === 'st')) return true;
    return false;
  }

  function repeatN(ops: Op[], n: number): Op[] {
    return n === 1 ? ops : [{ kind: 'repeat', ops, times: n, src: opts.src }];
  }

  let ops = parseSeq();

  if (evenly) {
    // The base stitch comes from "sc around, …"; a plain pass around is replaced by the even spread.
    const e = evenly as { change: 'inc' | 'dec'; k: number };
    const base = findBase(ops);
    ops = ops.filter((o) => !(o.kind === 'repeat' && o.times === 'around'));
    ops.push({ kind: 'evenly', change: e.change, k: e.k, stitch: base?.type && base.type !== 'ch' ? base.type : 'sc', loop: base?.loop ?? rowLoop, tension: base?.tension ?? 1, src: opts.src });
  }

  // A leading "ch N" in rows / joined rounds is a turning or starting chain.
  if (opts.leadingChIsTurning && ops.length && ops[0].kind === 'stitch' && ops[0].type === 'ch') {
    let n = 0;
    while (ops.length && ops[0].kind === 'stitch' && ops[0].type === 'ch') { ops.shift(); n++; }
    ops.unshift({ kind: 'turning-ch', n, src: opts.src });
  }
  if (nestedAround) res.assumptions.push('"around"/"each stitch" inside a counted repeat: read as one pass around');

  res.ops = ops;
  const meaningful = ops.some((o) => o.kind !== 'turning-ch');
  if (!meaningful && !res.colorChange && !res.fastenOff && !res.join && !res.turn) res.unreadable = true;
  if (!meaningful && (res.colorChange || res.join)) res.unreadable = ops.length === 0 && !res.turn && !res.join;
  return res;
}

/** All stitches of a group worked into one stitch: the first takes a new stitch, the rest go into the same one. */
function intoOne(ops: Op[], same: boolean): Op[] {
  let first = !same;
  return ops.map((o) => {
    if (o.kind !== 'stitch' || o.type === 'ch') return o;
    const target: Target = first ? { kind: 'next' } : { kind: 'same' };
    first = false;
    return { ...o, target, consumes: 1 };
  });
}

function findBase(ops: Op[]): Extract<Op, { kind: 'stitch' }> | undefined {
  for (const o of ops) {
    if (o.kind === 'stitch') return o;
    if (o.kind === 'repeat') { const f = findBase(o.ops); if (f) return f; }
  }
  return undefined;
}

function containsAround(ops: Op[]): boolean {
  return ops.some((o) => o.kind === 'repeat' && (o.times === 'around' || containsAround(o.ops)));
}

// ---------------------------------------------------------------------------
// Executor: walk the previous row and produce stitches (shared by counting and graph building)

export interface ProducedStitch {
  type: StitchType;
  loop: Loop;
  tension: number;
  targets: number[]; // indices into the previous row's work order; empty for ring/none
  ring: boolean;
  isChain: boolean;
  carry?: boolean;
}

export interface ExecResult {
  stitches: ProducedStitch[];
  leftover: number;
  overflow: number;
  turningCh: number;
}

export function execute(ops: Op[], prevCount: number, ringMode: boolean): ExecResult {
  const out: ProducedStitch[] = [];
  let p = 0;
  let last = -1;
  let overflow = 0;
  let turningCh = 0;
  const N = ringMode ? 0 : prevCount;

  const run = (list: Op[], guard: { n: number }) => {
    for (const op of list) {
      if (guard.n++ > 20000) return;
      if (op.kind === 'turning-ch') { turningCh += op.n; continue; }
      if (op.kind === 'skip') { p += op.n; continue; }
      if (op.kind === 'evenly') {
        // Spread k inc/dec over the stitches that are left, as evenly as whole stitches allow.
        const rem = ringMode ? 0 : Math.max(0, N - p);
        const per = op.change === 'inc' ? 1 : 2;
        const plain = Math.max(0, rem - op.k * per);
        const unit = (n: number): Op[] => [
          ...Array.from({ length: n }, (): Op => ({ kind: 'stitch', type: op.stitch, target: { kind: 'next' }, loop: op.loop, tension: op.tension, consumes: 1, src: op.src })),
          ...(op.change === 'inc'
            ? [{ kind: 'stitch', type: op.stitch, target: { kind: 'next' }, loop: op.loop, tension: op.tension, consumes: 1, src: op.src }, { kind: 'stitch', type: op.stitch, target: { kind: 'same' }, loop: op.loop, tension: op.tension, consumes: 1, src: op.src }] as Op[]
            : [{ kind: 'stitch', type: op.stitch, target: { kind: 'next' }, loop: op.loop, tension: op.tension, consumes: 2, src: op.src }] as Op[]),
        ];
        for (let i = 0; i < op.k; i++) run(unit(Math.floor(((i + 1) * plain) / op.k) - Math.floor((i * plain) / op.k)), guard);
        continue;
      }
      if (op.kind === 'repeat') {
        if (typeof op.times === 'object') {
          // "sc in each st until 2 sts remain" / "to last 3 sts"
          const stop = N - op.times.leave;
          let safety = 0;
          while (!ringMode && p < stop && safety++ < 5000) {
            const before = p;
            run(op.ops, guard);
            if (p === before) break;
          }
          continue;
        }
        if (op.times === 'around') {
          if (ringMode) { run(op.ops, guard); continue; }
          let safety = 0;
          while (p < N && safety++ < 5000) {
            const before = p;
            run(op.ops, guard);
            if (p === before) break;
          }
        } else for (let i = 0; i < op.times; i++) run(op.ops, guard);
        continue;
      }
      const st: ProducedStitch = { type: op.type, loop: op.loop, tension: op.tension, targets: [], ring: false, isChain: op.type === 'ch', carry: op.carry };
      const t = op.target;
      if (t.kind === 'none') { /* chain */ }
      else if (t.kind === 'ring' || (ringMode && t.kind !== 'same')) st.ring = true;
      else if (t.kind === 'same') {
        if (ringMode || last < 0) st.ring = ringMode;
        else st.targets = [last];
        if (ringMode) st.ring = true;
      } else {
        if (t.kind === 'ch-from-hook') p = Math.max(0, t.n - 1);
        for (let c = 0; c < op.consumes; c++) {
          if (p < N) { st.targets.push(p); last = p; p++; }
          else { overflow++; if (N > 0) { st.targets.push(N - 1); last = N - 1; } }
        }
      }
      out.push(st);
    }
  };
  run(ops, { n: 0 });
  return { stitches: out, leftover: Math.max(0, N - p), overflow, turningCh };
}

export function countOf(r: ExecResult, unit: string): number {
  if (unit === 'loops') {
    let loops = 0;
    let inChain = false;
    for (const s of r.stitches) {
      if (s.isChain && !inChain) loops++;
      inChain = s.isChain;
    }
    return loops;
  }
  return r.stitches.filter((s) => !s.isChain).length;
}
