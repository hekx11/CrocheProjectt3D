import type { Pattern } from '../model/types';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Pieces → sections → row runs with counts, plus the list of lines that need a look. */
export function renderOutline(el: HTMLElement, summary: HTMLElement, p: Pattern, goto: (line: number) => void) {
  const parts: string[] = [];
  let rowsTotal = 0, sts = 0;
  for (const pc of p.pieces) {
    const kind = pc.construction === 'rows' ? 'flat rows' : pc.construction === 'joined-rounds' ? 'joined rounds' : 'rounds';
    const meta = [kind, pc.quantity > 1 ? `make ${pc.quantity}` : '', pc.stuffing !== 'none' ? `stuffed (${pc.stuffing})` : '', pc.flatten ? 'flattened' : '', pc.finish === 'closed' ? 'closed' : pc.finish === 'open-with-tail' ? 'open, sewn on' : 'open edge']
      .filter(Boolean).join(' · ');
    parts.push(`<div class="piece"><h3>${esc(pc.name)}${pc.quantity > 1 ? ` ×${pc.quantity}` : ''}</h3><div class="meta">${esc(meta)}</div><ul>`);
    // compress runs of rows from the same line
    const seen = new Set<number>();
    for (const r of pc.rows) {
      rowsTotal++;
      sts += r.computedCount * pc.quantity;
      if (seen.has(r.line)) continue;
      seen.add(r.line);
      const same = pc.rows.filter((x) => x.line === r.line);
      const label = same.length > 1 ? `${same[0].index}–${same[same.length - 1].index}` : `${r.index}`;
      const sec = pc.sections.find((s) => s.firstRow === r.index && pc.sections.length > 1);
      if (sec) parts.push(`<li class="muted small" data-line="${r.line}">${esc(sec.name)}${sec.yarnId ? ` · ${esc(sec.yarnId)}` : ''}</li>`);
      const count = r.expectedCount && r.expectedCount.unit === 'loops' ? `${r.expectedCount.n} loops` : `${r.computedCount} st`;
      parts.push(`<li data-line="${r.line}"><span class="dot ${r.status}"></span><span>${pc.construction === 'rows' ? 'Row' : 'Rnd'} ${label}</span><span class="muted">${count}</span></li>`);
    }
    for (const m of pc.markers) parts.push(`<li data-line="${m.line}" class="small"><span class="dot assumption"></span>${esc(m.kind.replace('-', ' '))} @ rnd ${m.rowA}${m.rowB && m.rowB !== m.rowA ? `/${m.rowB}` : ''}</li>`);
    parts.push('</ul></div>');
  }
  if (p.seams.length) {
    parts.push('<div class="piece"><h3>Assembly</h3><ul>');
    for (const s of p.seams) {
      const a = p.pieces.find((x) => x.id === s.piece)?.name ?? s.piece;
      const b = p.pieces.find((x) => x.id === s.host)?.name ?? s.host;
      parts.push(`<li data-line="${s.line}" class="small"><span class="dot ok"></span>${esc(a)} → ${esc(b)}${s.rowA ? ` rnds ${s.rowA}–${s.rowB}` : ''} · ${s.hint}</li>`);
    }
    parts.push('</ul></div>');
  }
  const issues = p.diagnostics.filter((d) => d.severity !== 'info');
  if (p.diagnostics.length) {
    parts.push(`<div class="piece"><h3>Notes from the parser</h3><ul class="diag-list">`);
    for (const d of p.diagnostics) parts.push(`<li data-line="${d.line}"><span class="dot ${d.severity === 'error' ? 'unreadable' : d.severity === 'warning' ? 'ambiguous' : 'assumption'}"></span><span>line ${d.line + 1}: ${esc(d.message)}</span></li>`);
    parts.push('</ul></div>');
  }
  el.innerHTML = parts.join('') || '<p class="muted">Type a round like <code>Rnd 1: 6 sc in MR (6)</code> to start.</p>';
  el.querySelectorAll<HTMLElement>('[data-line]').forEach((li) => li.addEventListener('click', () => goto(+li.dataset.line!)));
  summary.textContent = `· ${p.pieces.reduce((a, x) => a + x.quantity, 0)} piece(s), ${rowsTotal} rows, ${sts} stitches${issues.length ? ` · ${issues.length} to check` : ''}`;
}
