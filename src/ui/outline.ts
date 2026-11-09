import type { Pattern } from '../model/types';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const LEGEND = '<div class="legend"><span><i class="dot ok"></i>count adds up</span><span><i class="dot assumption"></i>our best guess</span><span><i class="dot ambiguous"></i>worth a second look</span><span><i class="dot unreadable"></i>could not read</span></div>';

/** Pieces → sections → row runs with counts, plus the list of lines that need a look. */
export function renderOutline(el: HTMLElement, summary: HTMLElement, p: Pattern, goto: (line: number) => void, pick?: (line: number, reading: string) => void) {
  const parts: string[] = [];
  let rowsTotal = 0, sts = 0;
  for (const pc of p.pieces) {
    const kind = pc.construction === 'rows' ? 'worked flat in rows' : pc.construction === 'joined-rounds' ? 'worked in joined rounds' : 'worked in rounds';
    const meta = [kind, pc.quantity > 1 ? `make ${pc.quantity}` : '', pc.stuffing !== 'none' ? `stuffed (${pc.stuffing})` : '', pc.flatten ? 'flattened' : '', pc.finish === 'closed' ? 'closed at the end' : pc.finish === 'open-with-tail' ? 'left open and sewn on' : 'open edge']
      .filter(Boolean).join(' · ');
    parts.push(`<div class="piece"><h3>${esc(pc.name)}${pc.quantity > 1 ? ` ×${pc.quantity}` : ''}</h3><div class="meta">${esc(meta)}</div><ul>`);
    const unit = pc.construction === 'rows' ? 'rows' : 'rounds';
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
      if (sec) parts.push(`<li class="muted small wide" data-line="${r.line}">${esc(sec.name)}${sec.yarnId ? ` · ${esc(sec.yarnId)}` : ''}</li>`);
      const count = r.expectedCount && r.expectedCount.unit === 'loops' ? `${r.expectedCount.n} loops` : `${r.computedCount} ${r.computedCount === 1 ? 'stitch' : 'stitches'}`;
      parts.push(`<li data-line="${r.line}"><span class="dot ${r.status}"></span><span>${pc.construction === 'rows' ? (same.length > 1 ? 'Rows' : 'Row') : same.length > 1 ? 'Rounds' : 'Round'} ${label}</span><span class="n">${count}</span></li>`);
    }
    for (const m of pc.markers) parts.push(`<li data-line="${m.line}" class="small wide"><span class="dot assumption"></span>${esc(cap(m.kind.replace('-', ' ')))} ${m.rowB && m.rowB !== m.rowA ? `between ${unit} ${m.rowA} and ${m.rowB}` : `on ${unit.slice(0, -1)} ${m.rowA}`}</li>`);
    parts.push('</ul></div>');
  }
  if (p.seams.length) {
    parts.push('<div class="piece"><h3>Putting it together</h3><ul>');
    for (const s of p.seams) {
      const a = p.pieces.find((x) => x.id === s.piece)?.name ?? s.piece;
      const b = p.pieces.find((x) => x.id === s.host)?.name ?? s.host;
      parts.push(`<li data-line="${s.line}" class="small wide"><span class="dot ok"></span>${esc(a)} sewn to ${esc(b)}${s.rowA ? `, rounds ${s.rowA}–${s.rowB}` : ''}${s.hint !== 'default' ? ` (${s.hint.replace('-', ' ')})` : ''}</li>`);
    }
    parts.push('</ul></div>');
  }
  const issues = p.diagnostics.filter((d) => d.severity !== 'info');
  if (p.diagnostics.length) {
    parts.push(`<div class="piece"><h3>${issues.length ? 'Worth a second look' : 'Good to know'}</h3><ul class="diag-list">`);
    for (const d of p.diagnostics) parts.push(`<li data-line="${d.line}"><span class="dot ${d.severity === 'error' ? 'unreadable' : d.severity === 'warning' ? 'ambiguous' : 'assumption'}"></span><span>${esc(d.message)}</span>${pick && d.readings && d.readings.length > 1 ? d.readings.map((r, i) => `<button class="pick" data-line-pick="${d.line}" data-reading="${i}" title="Use this reading">${esc(r)}</button>`).join('') : ''}</li>`);
    parts.push('</ul></div>');
  }
  el.innerHTML = parts.length
    ? LEGEND + parts.join('')
    : '<p class="muted empty">Nothing here yet. Type a round like <code>Rnd 1: 6 sc in MR (6)</code> above, or try an example.</p>';
  el.querySelectorAll<HTMLElement>('[data-line]').forEach((li) => li.addEventListener('click', () => goto(+li.dataset.line!)));
  el.querySelectorAll<HTMLElement>('[data-line-pick]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    const d = p.diagnostics.find((x) => x.line === +b.dataset.linePick! && x.readings);
    if (d) pick?.(d.line, d.readings![+b.dataset.reading!]);
  }));
  const n = p.pieces.reduce((a, x) => a + x.quantity, 0);
  summary.innerHTML = p.pieces.length
    ? `${n} ${n === 1 ? 'piece' : 'pieces'} · ${rowsTotal} ${p.pieces.every((x) => x.construction === 'rows') ? 'rows' : p.pieces.some((x) => x.construction === 'rows') ? 'rows and rounds' : 'rounds'} · ${sts} stitches <span class="badge ${issues.length ? 'check' : 'ok'}">${issues.length ? `${issues.length} to check` : 'all counts add up'}</span>`
    : '';
}
