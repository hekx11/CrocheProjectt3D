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
const STITCH_ABBR = /^(mr|mc|sc|hdc|dc|tr|sl ?st|ss|ch|inc|dec|blo|flo|st|sts|rnd|fo|sk|rep|tog|invdec)\b/i;

export function layoutPages(pages: PageRuns[]): { text: string; rows: number; warnings: string[]; bestPage: number } {
  const warnings: string[] = [];
  // 1. segments per page (gap-aware line grouping)
  const segs: Seg[] = [];
  pages.forEach((pg, pi) => {
    const runs = pg.runs.filter((r) => r.str.trim()).sort((a, b) => a.y - b.y || a.x - b.x);
    const pageSegs: Seg[] = [];
    for (const r of runs) {
      const s = pageSegs.find((q) => Math.abs(q.y - r.y) < 0.4 * Math.max(q.size, r.size) && r.x - q.right < Math.max(14, r.size * 1.6) && r.x >= q.x - 1);
      if (s) {
        s.text += (r.x - s.right > r.size * 0.15 && !s.text.endsWith(' ') && !r.str.startsWith(' ') ? ' ' : '') + r.str;
        s.right = Math.max(s.right, r.x + r.w);
        s.size = Math.max(s.size, r.size);
      } else pageSegs.push({ text: r.str, x: r.x, right: r.x + r.w, y: r.y, size: r.size, page: pi });
    }
    pageSegs.forEach((s) => (s.text = s.text.replace(/\s+/g, ' ').trim()));
    segs.push(...pageSegs);
    if (pageSegs.length < 3) warnings.push(`Page ${pi + 1} has almost no text (scanned image?). Type those parts in by hand, or use text recognition when it is available.`);
  });

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
  type Item = { page: number; y: number; text: string; kind: 'row' | 'other'; size: number; x: number };
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
    for (const s of ps) if (!s.used) items.push({ page: pi, y: s.y, text: s.text, kind: 'other', size: s.size, x: s.x });
  });
  items.sort((a, b) => a.page - b.page || a.y - b.y);

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
    if (inAbbrev) {
      if (STITCH_ABBR.test(t) || t.split(' ').length <= 3) return;
      inAbbrev = false;
    }
    if (firstRow < 0 || idx < firstRow) {
      const nearFirst = firstRow >= 0 && it.page === items[firstRow].page && items[firstRow].y - it.y < it.size * 5;
      if (nearFirst && !/^written pattern$|^pattern$|^instructions$/i.test(t)) { out.push('', t); return; }
      if (MATERIAL.test(t)) out.push(t);
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

function median(v: number[]): number {
  if (!v.length) return 12;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
