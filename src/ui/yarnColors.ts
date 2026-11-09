import type { Pattern, Yarn } from '../model/types';
import { COLORS, DEFAULT_YARN_COLOR } from '../model/dictionary';

/** Colours the user picked, per pattern (by title) and yarn id: { title: { yarnId: '#rrggbb' } }. */
export type ColorOverrides = Record<string, Record<string, string>>;

export const patternKey = (p: Pattern) => (p.title ?? '').trim().toLowerCase() || 'untitled';

/**
 * Put the user's picked colours on the parsed yarns. Returns the colours the pattern itself gave,
 * so a picker can show what "reset" goes back to.
 */
export function applyColorOverrides(p: Pattern, all: ColorOverrides): Map<string, string> {
  const original = new Map<string, string>();
  const mine = all[patternKey(p)] ?? {};
  for (const y of p.materials.yarns) {
    original.set(y.id, y.color);
    const c = mine[y.id];
    if (c && /^#[0-9a-f]{6}$/i.test(c)) y.color = c;
  }
  return original;
}

/** The yarns worth a picker: the ones some row, section or strand is actually worked in. */
export function yarnsInUse(p: Pattern): Yarn[] {
  const used = new Set<string>();
  for (const pc of p.pieces) {
    for (const r of pc.rows) used.add(r.yarnId);
    for (const s of pc.sections) if (s.yarnId) used.add(s.yarnId);
  }
  const ys = p.materials.yarns.filter((y) => used.has(y.id));
  return ys.length ? ys : p.materials.yarns.slice(0, 1);
}

const hex = (c: string | undefined) => (c && /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : DEFAULT_YARN_COLOR);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const title = (s: string) => (s === 'main' ? 'Main yarn' : s.charAt(0).toUpperCase() + s.slice(1));

/** Named yarn colours offered as swatches in the browser's colour picker. */
export function swatchList(): HTMLDataListElement {
  const dl = document.createElement('datalist');
  dl.id = 'yarn-swatches';
  for (const c of new Set(Object.values(COLORS))) dl.append(new Option('', c));
  return dl;
}

/**
 * One row per yarn: its name from the pattern, a colour input and a reset button when changed.
 * The rows are only rebuilt when the set of yarns changes, so typing in the pattern doesn't close
 * an open picker.
 */
export function renderYarnColors(
  el: HTMLElement, yarns: Yarn[], original: Map<string, string>,
  onPick: (id: string, color: string | null) => void,
) {
  const sig = yarns.map((y) => `${y.id}\u0000${y.label}`).join('\u0001');
  if (el.dataset.sig !== sig) {
    el.dataset.sig = sig;
    el.innerHTML = yarns.map((y) => `
      <div class="yarn-color" data-yarn="${esc(y.id)}">
        <label><span>${esc(title(y.label))}</span><input type="color" list="yarn-swatches" aria-label="Colour of ${esc(title(y.label))}" /></label>
        <button type="button" class="ghost reset" title="Back to the pattern's colour" aria-label="Reset ${esc(title(y.label))} colour">↺</button>
      </div>`).join('');
    el.querySelectorAll<HTMLElement>('.yarn-color').forEach((row) => {
      const id = row.dataset.yarn!;
      const input = row.querySelector('input')!;
      input.addEventListener('input', () => onPick(id, input.value));
      row.querySelector('button')!.addEventListener('click', () => onPick(id, null));
    });
  }
  el.querySelectorAll<HTMLElement>('.yarn-color').forEach((row) => {
    const y = yarns.find((q) => q.id === row.dataset.yarn);
    if (!y) return;
    const input = row.querySelector('input')!;
    if (document.activeElement !== input) input.value = hex(y.color);
    (row.querySelector('button') as HTMLButtonElement).hidden = hex(original.get(y.id) ?? y.color) === hex(y.color);
  });
}
