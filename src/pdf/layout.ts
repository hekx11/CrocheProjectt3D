/**
 * Rebuild pattern text from positioned PDF text runs (research/pdf-ingestion.md §4, §6).
 * Pure function so it can be tested in Node and reused for OCR words later.
 */
export interface Run { str: string; x: number; y: number; w: number; size: number }
export interface PageRuns { runs: Run[]; width: number; height: number }

interface Seg { text: string; x: number; right: number; y: number; size: number; page: number; used?: boolean }

const LABEL = /^(?:(?:r(?:ou)?nds?|rows?|r)\.?\s*)?(\d+)(?:\s*[-–—]\s*(\d+))?\s*[:.)]?$/i;
const BOILER = /all rights reserved|copyright|©|\betsy\b|instagram|contact me|reproduced|distribut|resold|resell|credit me|questions about this pattern|all done|hope you (like|enjoy)|feel free|personal use|designer|^\s*&\s*:/i;
const MATERIAL = /\bhook\b|\byarn\b|\bweight\b|safety eyes?|\beyes\b|stuffing|\bgauge\b|\btension\b|\blength\b|\bdiameter\b|\bheight\b|\bwidth\b|finished size|\bmm\b|\buk terms\b|\bus terms\b/i;
const INLINE_ROW = /^(?:r(?:ou)?nds?|rows?|r)\.?\s*\d+(?:\s*(?:[-–—]|to)\s*\d+)?\s*[:.)]?\s+\S/i;
const STITCH_ABBR = /^(mr|mc|sc|hdc|dc|tr|sl ?st|ss|ch|inc|dec|blo|flo|st|sts|rnd|fo|sk|rep|tog|invdec)\b/i;

export function layoutPages(pages: PageRuns[]): { text: string; rows: number; warnings: string[]; bestPage: number } {
  const warnings: string[] = [];
  // 1. segments per page (gap-aware line grouping)
  const segs: Seg[] = [];
  const emptyPages: number[] = [];
  pages.forEach((pg, pi) => {
    // bucket runs into text lines first, then read each line left to right (runs of one line can
    // differ in y by a fraction of a point, which must not reorder them)
    const lines: Run[][] = [];
    for (const r of pg.runs.filter((r) => r.str.trim()).sort((a, b) => a.y - b.y)) {
      const l = lines.find((q) => Math.abs(q[0].y - r.y) < 0.4 * Math.max(q[0].size, r.size));
      if (l) l.push(r); else lines.push([r]);
    }
    const runs = lines.flatMap((l) => l.sort((a, b) => a.x - b.x));
    const pageSegs: Seg[] = [];
    for (const r of runs) {
      const s = pageSegs.find((q) => Math.abs(q.y - r.y) < 0.4 * Math.max(q.size, r.size) && r.x - q.right < Math.max(14, r.size * 1.6) && r.x >= q.x - 1);
      if (s) {
        s.text += (r.x - s.right > r.size * 0.15 && !s.text.endsWith(' ') && !r.str.startsWith(' ') ? ' ' : '') + r.str;
        s.right = Math.max(s.right, r.x + r.w);
        s.size = Math.max(s.size, r.size);
      } else pageSegs.push({ text: r.str, x: r.x, right: r.x + r.w, y: r.y, size: r.size, page: pi });
    }
    pageSegs.forEach((s) => (s.text = repairGlyphs(s.text.replace(/\s+/g, ' ').trim())));
    // ruled lines ("-------") separate blocks; they are not text
    for (const s of pageSegs) if (/^[-–—_=*.·•\s]{5,}$/.test(s.text)) s.used = true;
    segs.push(...pageSegs);
    if (pageSegs.length < 3) emptyPages.push(pi + 1);
  });
  // A photo page between text pages is normal; only warn when most of the document has no text.
  if (emptyPages.length > pages.length / 2) for (const n of emptyPages) warnings.push(`Page ${n} has almost no text (scanned image?). Type those parts in by hand, or use text recognition when it is available.`);

  // 2. strip running headers/footers (same text at ~same y on ≥ half the pages)
  if (pages.length >= 2) {
    const freq = new Map<string, number>();
    for (const s of segs) {
      const k = `${s.text}@${Math.round(s.y / 12)}`;
      freq.set(k, (freq.get(k) ?? 0) + 1);
    }
    for (const s of segs) if ((freq.get(`${s.text}@${Math.round(s.y / 12)}`) ?? 0) >= Math.max(2, pages.length / 2)) s.used = true;
  }

  // 3. find label column per page and pair labels with instruction lines
  type Item = { page: number; y: number; text: string; kind: 'row' | 'other'; size: number; x: number; ord?: number };
  const items: Item[] = [];
  const bodySize = median(segs.filter((s) => !s.used).map((s) => s.size));
  let rows = 0;
  let bestPage = 0, bestRows = -1;
  pages.forEach((_, pi) => {
    const ps = segs.filter((s) => s.page === pi && !s.used);
    const labels = ps.filter((s) => LABEL.test(s.text) && s.text.length <= 12);
    // cluster label centres
    const sorted = [...labels].sort((a, b) => (a.x + a.right) - (b.x + b.right));
    const groups: Seg[][] = [];
    for (const l of sorted) {
      const g = groups[groups.length - 1];
      const c = (l.x + l.right) / 2;
      if (g && c - (g[g.length - 1].x + g[g.length - 1].right) / 2 < 16) g.push(l);
      else groups.push([l]);
    }
    let col: Seg[] = [];
    for (const v of groups) if (v.length > col.length) col = v;
    if (col.length >= 3) {
      col.sort((a, b) => a.y - b.y);
      const labelRight = Math.max(...col.map((l) => l.right));
      for (let i = 0; i < col.length; i++) {
        const l = col[i];
        const up = i > 0 ? (col[i - 1].y + l.y) / 2 : l.y - 1.5 * l.size;
        const down = i < col.length - 1 ? (col[i + 1].y + l.y) / 2 : l.y + 2.5 * l.size;
        const parts = ps
          .filter((s) => !s.used && s !== l && s.x > labelRight + 8 && s.y >= up - 0.5 && s.y < down && Math.abs(s.y - l.y) < 2.6 * l.size && s.size <= Math.max(l.size, bodySize) * 1.04)
          .sort((a, b) => a.y - b.y || a.x - b.x);
        // stop at headings / centred text that is clearly not part of the cell
        const instr = parts.map((p) => p.text).join(' ');
        if (!instr) continue;
        parts.forEach((p) => (p.used = true));
        l.used = true;
        const m = LABEL.exec(l.text)!;
        const label = m[2] ? `Rnds ${m[1]}-${m[2]}` : `Rnd ${m[1]}`;
        items.push({ page: pi, y: l.y, text: `${label}: ${instr}`, kind: 'row', size: l.size, x: l.x });
        rows++;
      }
      if (col.length > bestRows) { bestRows = col.length; bestPage = pi; }
    }
    if (col.length >= 3) {
      for (const s of ps) if (!s.used) items.push({ page: pi, y: s.y, text: s.text, kind: 'other', size: s.size, x: s.x });
      return;
    }
    // Prose layout: rows are written inline ("Rnd 3: sc around"). Read column by column and
    // re-join lines that wrapped at the column edge.
    for (const s of proseLines(ps, pages[pi].width)) {
      const row = INLINE_ROW.test(s.text);
      if (row) rows++;
      items.push({ page: pi, y: s.y, text: s.text, kind: row ? 'row' : 'other', size: s.size, x: s.x, ord: items.length });
    }
  });
  items.sort((a, b) => a.page - b.page || (a.ord != null && b.ord != null ? a.ord - b.ord : a.y - b.y));

  // 4. classify the rest; keep title, materials, headings and notes inside the pattern zone
  const firstRow = items.findIndex((i) => i.kind === 'row');
  const lastRow = items.length - 1 - [...items].reverse().findIndex((i) => i.kind === 'row');
  const out: string[] = [];
  const titleSize = Math.max(...items.filter((i) => i.page === 0).map((i) => i.size), 0);
  const title = items.filter((i) => i.page === 0 && i.size >= titleSize * 0.95).map((i) => i.text).join(' ');
  if (title) out.push(title, '');
  let inAbbrev = false;
  let abbrevPage = -1;
  items.forEach((it, idx) => {
    if (it.kind === 'row') { inAbbrev = false; out.push(it.text); return; }
    if (inAbbrev && (it.page !== abbrevPage || /pattern|instructions/i.test(it.text))) inAbbrev = false;
    const t = it.text;
    if (it.page === 0 && it.size >= titleSize * 0.95) return;
    if (BOILER.test(t)) return;
    if (/^abbreviations?|^stitch(es)? (guide|key)|^terms$|^glossary/i.test(t)) { inAbbrev = true; abbrevPage = it.page; return; }
    // a key line that changes how brackets read: "(-) All in one stitch"
    if (/^\(.{0,3}\)\s*(?:[=:-]\s*)?all in (?:one|the same|1) (?:st|stitch)/i.test(t)) { out.push(t); return; }
    if (inAbbrev) {
      if (STITCH_ABBR.test(t) || t.split(' ').length <= 3) return;
      inAbbrev = false;
    }
    if (firstRow < 0 || idx < firstRow) {
      const nearFirst = firstRow >= 0 && it.page === items[firstRow].page && items[firstRow].y - it.y < it.size * 8;
      if (nearFirst && !/^written pattern$|^pattern$|^instructions$/i.test(t)) { out.push('', t); return; }
      if (MATERIAL.test(t) || /^stuff\b/i.test(t)) out.push(t);
      else if (/^(materials|tools|you will need|supplies)/i.test(t)) out.push('');
      return;
    }
    if (idx > lastRow && !/sew|attach|assembl|stuff|eye|fasten/i.test(t)) return;
    if (/^written pattern$|^pattern$|^instructions$/i.test(t)) return;
    const heading = it.size > bodySize * 1.03 || (t.split(' ').length <= 5 && !/[.:]$/.test(t) && /[A-Z]/.test(t[0]) && !/\d/.test(t) && /\(|^[A-Z][a-z]+( [A-Z][a-z]+)*$/.test(t));
    if (heading) out.push('', t);
    else out.push(t);
  });
  if (!rows) warnings.push('No numbered rows/rounds were found. The text is imported as-is — add labels like "Rnd 1:" where needed.');
  const text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  return { text, rows, warnings, bestPage };
}

/** Order a page's lines column by column (full-width lines split the page into bands), and join
 *  a line to the next one when it ran up to the column's right edge (a soft wrap). */
function proseLines(ps: Seg[], width: number): Seg[] {
  const mid = width / 2;
  const full = (s: Seg) => s.x < mid - 20 && s.right > mid + 20;
  // a stitch-count column far to the right ("(18)") belongs to the row on its line
  const lines = ps.filter((s) => !/^[(\[]\s*\d+\s*(?:st|sts|stitches)?\s*[)\]]$/i.test(s.text) || !ps.some((r) => r !== s && INLINE_ROW.test(r.text) && r.x < s.x && Math.abs(r.y - s.y) < 0.5 * s.size));
  for (const c of ps) {
    if (lines.includes(c)) continue;
    const row = ps.find((r) => r !== c && INLINE_ROW.test(r.text) && r.x < c.x && Math.abs(r.y - c.y) < 0.5 * c.size)!;
    row.text += ' ' + c.text;
  }
  const sorted = [...lines].sort((a, b) => a.y - b.y || a.x - b.x);
  const out: Seg[] = [];
  let band: Seg[] = [];
  const flush = () => {
    for (const side of [0, 1]) {
      const col = band.filter((s) => (s.x >= mid - 20 ? 1 : 0) === side);
      const right = Math.max(...col.map((s) => s.right), 0);
      let cur: Seg | null = null;
      for (const s of col) {
        // a soft wrap: the line ran to the column edge and the sentence goes on (a new sentence
        // after "… [24]" or "… stitch." starts a new line of its own)
        const wrap = cur && s.size === cur.size && s.y - cur.y < 1.9 * s.size && (Math.abs(s.x - cur.x) < 1.2 * s.size || (/^[-•✓➝→*]\s/.test(cur.text) && s.x > cur.x && s.x - cur.x < 4 * s.size)) &&
          (cur.right > right - 5 * s.size || /^[a-z]/.test(s.text)) && !/[:]$/.test(cur.text) && !INLINE_ROW.test(s.text) && !/^[-•✓➝→*]\s/.test(s.text) &&
          !(/[.!?\])]$/.test(cur.text) && /^[A-Z]/.test(s.text));
        if (cur && wrap) {
          cur.text += (cur.text.endsWith('-') && /^[a-z]/.test(s.text) ? '' : ' ') + s.text;
          cur.right = s.right; cur.y = s.y;
        } else {
          if (cur) out.push(cur);
          cur = { ...s };
        }
      }
      if (cur) out.push(cur);
    }
    band = [];
  };
  for (const s of sorted) {
    if (full(s) && band.some((b) => b.x >= mid - 20)) flush();
    band.push(s);
  }
  flush();
  // keep the reading order but report the first line's y for sorting with other items
  return out;
}

/** Common part names, used to fill in heading letters a PDF font lost (pdf.js gives U+0000). */
const PART_WORDS = 'legs leg arms arm body head hair bun ears ear tail nose snout muzzle eyes eye skirt dress collar veil hat cap brim umbrella button flowers flower bouquet tiara crown bow tie shirt pants shorts shoes shoe boots feet foot hands hand wings wing beak horn horns mane cheeks belly base top bottom lid cup handle leaves leaf stem petals petal scarf bag strap straps suspenders vest jacket coat sleeves sleeve hood bridal assembly finishing pocket bowtie and the of with for'.split(' ');
function repairGlyphs(t: string): string {
  if (!t.includes('\u0000')) return t;
  const fixed = t.split(/(\s+|&)/).map((w) => {
    if (!w.includes('\u0000')) return w;
    const n = w.length;
    const fits = (cand: string) => cand.length === n && [...w].every((c, i) => c === '\u0000' || c.toLowerCase() === cand[i]);
    // a lost space can hide inside a run: try one word, then two words
    const known = w.replace(/\u0000/g, '').length;
    const one = known >= 1 ? PART_WORDS.find(fits) : undefined;
    if (one) return match(w, one);
    if (known >= 3) for (const a of PART_WORDS) for (const b of PART_WORDS) if (fits(a + b)) return match(w, a) + ' ' + match(w.slice(a.length), b);
    return w.replace(/\u0000+/g, '…');
  });
  return fixed.join('');
}
function match(w: string, cand: string): string {
  const upper = w.replace(/\u0000/g, '') === w.replace(/\u0000/g, '').toUpperCase();
  const c = cand.slice(0, w.length);
  return upper ? c.toUpperCase() : c[0].toUpperCase() + c.slice(1);
}

function median(v: number[]): number {
  if (!v.length) return 12;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
