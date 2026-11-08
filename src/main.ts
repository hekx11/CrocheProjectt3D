import './style.css';
import { EditorView, basicSetup } from 'codemirror';
import { Decoration, MatchDecorator, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { lintGutter, setDiagnostics, type Diagnostic as CmDiagnostic } from '@codemirror/lint';
import { parsePattern } from './parser/parse';
import { buildModel, type Model } from './geometry/pipeline';
import type { UserMaterials } from './geometry/sizing';
import { CrochetView } from './render/scene';
import type { Pattern } from './model/types';
import { renderOutline } from './ui/outline';
import { importPdf, renderPage } from './pdf/extract';

import ball from '../fixtures/ball.txt?raw';
import bear from '../fixtures/bear-head.txt?raw';
import coaster from '../fixtures/coaster.txt?raw';
import flower from '../fixtures/flower.txt?raw';
import ukBall from '../fixtures/uk-ball.txt?raw';

const EXAMPLES: Record<string, string> = {
  'Bear head (several pieces)': bear,
  'Ball': ball,
  'Coaster (flat rows)': coaster,
  'Flower (joined rounds)': flower,
  'Mini ball (UK terms)': ukBall,
};

const store = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------------------------------------------------------- 3D view
const view = new CrochetView($('viewport'));
const applyBg = () => view.setBackground(getComputedStyle(document.documentElement).getPropertyValue('--view-bg').trim() || '#efe8e0');
applyBg();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyBg);

// ---------------------------------------------------------------- materials
let user: UserMaterials = { tension: 'normal' };
try { user = { ...user, ...JSON.parse(store.get('crochet3d.materials') ?? '{}') }; } catch { /* ignore */ }

function syncMaterialsForm() {
  ($('m-tension') as HTMLSelectElement).value = user.tension;
  ($('m-hook') as HTMLInputElement).value = user.hookMm ? String(user.hookMm) : '';
  ($('m-weight') as HTMLSelectElement).value = user.weight !== undefined ? String(user.weight) : '';
  ($('m-fiber') as HTMLSelectElement).value = user.fiber ?? '';
  ($('m-w') as HTMLInputElement).value = user.scWidthMm ? String(user.scWidthMm) : '';
  ($('m-h') as HTMLInputElement).value = user.scHeightMm ? String(user.scHeightMm) : '';
}
function readMaterialsForm() {
  const num = (id: string) => { const v = parseFloat(($(id) as HTMLInputElement).value); return Number.isFinite(v) && v > 0 ? v : undefined; };
  const w = ($('m-weight') as HTMLSelectElement).value;
  user = {
    tension: ($('m-tension') as HTMLSelectElement).value as UserMaterials['tension'],
    hookMm: num('m-hook'),
    weight: w === '' ? undefined : +w,
    fiber: ($('m-fiber') as HTMLSelectElement).value || undefined,
    scWidthMm: num('m-w'),
    scHeightMm: num('m-h'),
  };
  store.set('crochet3d.materials', JSON.stringify(user));
  rebuild(true);
}
syncMaterialsForm();
for (const id of ['m-tension', 'm-hook', 'm-weight', 'm-fiber', 'm-w', 'm-h']) $(id).addEventListener('change', readMaterialsForm);
$('m-reset').addEventListener('click', () => { user = { tension: 'normal' }; syncMaterialsForm(); readMaterialsForm(); });
const toggleMaterials = (open?: boolean) => {
  const p = $('materials');
  const show = open ?? p.hidden;
  p.hidden = !show;
  $('btn-materials').setAttribute('aria-expanded', String(show));
};
$('btn-materials').addEventListener('click', () => toggleMaterials());
$('m-close').addEventListener('click', () => toggleMaterials(false));

// ---------------------------------------------------------------- solver worker
const worker = new Worker(new URL('./geometry/solver.worker.ts', import.meta.url), { type: 'module' });
let job = 0;
let model: Model | null = null;
let lastPos: Float32Array | null = null;
let warm = new Map<string, [number, number, number]>();
worker.onmessage = (e: MessageEvent<{ type: 'frame'; job: number; pos: Float32Array; done: boolean }>) => {
  if (e.data.job !== job || !model) return;
  lastPos = e.data.pos;
  view.update(e.data.pos);
  if (e.data.done) {
    $('solving').hidden = true;
    rememberPositions();
  }
};
function rememberPositions() {
  if (!model || !lastPos) return;
  warm = new Map();
  for (const n of model.graph.nodes) warm.set(n.key, [lastPos[n.id * 3], lastPos[n.id * 3 + 1], lastPos[n.id * 3 + 2]]);
}

// ---------------------------------------------------------------- editor
const annotationDeco = new MatchDecorator({ regexp: /=>.*$/g, decoration: Decoration.mark({ class: 'cm-annotation' }) });
const labelDeco = new MatchDecorator({
  regexp: /^\s*(?:(?:rnds?|rounds?|rows?|r)\.?\s*\d+(?:\s*-\s*\d+)?\s*[:.]?|\d+(?:\s*-\s*\d+)?\s*[:.)])|[\[(]\d+[\])]/gim,
  decoration: (m) => Decoration.mark({ class: /^[\[(]/.test(m[0]) ? 'cm-count' : 'cm-rowlabel' }),
});
const decoPlugin = (md: MatchDecorator) => ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(v: EditorView) { this.decorations = md.createDeco(v); }
  update(u: ViewUpdate) { this.decorations = md.updateDeco(u, this.decorations); }
}, { decorations: (v) => v.decorations });

const activeLineDeco = Decoration.line({ class: 'cm-activeRow' });

const initial = store.get('crochet3d.pattern') ?? bear;
const editor = new EditorView({
  parent: $('editor'),
  doc: initial,
  extensions: [
    basicSetup,
    EditorView.lineWrapping,
    lintGutter(),
    decoPlugin(annotationDeco),
    decoPlugin(labelDeco),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) schedule();
      if (u.selectionSet || u.docChanged) onCursor();
    }),
    EditorView.theme({ '&': { backgroundColor: 'transparent' }, '.cm-gutters': { backgroundColor: 'transparent', borderRight: '1px solid var(--line)' } }),
  ],
});

let timer: number | undefined;
function schedule() {
  clearTimeout(timer);
  timer = window.setTimeout(() => rebuild(false), 150);
}

let pattern: Pattern | null = null;
let lastTopology = '';

function rebuild(force: boolean) {
  const text = editor.state.doc.toString();
  store.set('crochet3d.pattern', text);
  pattern = parsePattern(text);
  // diagnostics → editor
  const diags: CmDiagnostic[] = pattern.diagnostics.map((d) => ({
    from: Math.min(d.src.from, text.length), to: Math.min(Math.max(d.src.to, d.src.from), text.length),
    severity: d.severity, message: d.message,
  }));
  editor.dispatch(setDiagnostics(editor.state, diags));
  renderOutline($('outline'), $('outline-summary'), pattern, (line) => gotoLine(line));

  const topology = JSON.stringify([pattern.pieces.map((p) => [p.name, p.quantity, p.rows.map((r) => [r.computedCount, r.yarnId, r.line])]), pattern.seams.length, user]);
  if (!force && topology === lastTopology) return;
  lastTopology = topology;
  if (lastPos && model) rememberPositions();
  if (!pattern.pieces.length) { $('size').textContent = 'Start typing a pattern…'; return; }
  model = buildModel(pattern, user, warm);
  view.setModel(model);
  $('size-source').textContent = `Stitch size from ${model.sizing.source} · sc ≈ ${model.sizing.w.toFixed(1)} × ${model.sizing.h.toFixed(1)} mm`;
  $('solving').hidden = false;
  job++;
  worker.postMessage({ type: 'start', job, input: model.solverInput, frames: 400 });
  onCursor();
}

view.onSize = ([x, y, z]) => {
  const cm = (v: number) => (v / 10).toFixed(1);
  const inch = (v: number) => (v / 25.4).toFixed(1);
  $('size').textContent = `≈ ${cm(x)} × ${cm(y)} × ${cm(z)} cm  (${inch(x)}″ × ${inch(y)}″ × ${inch(z)}″)`;
};

function onCursor() {
  const line = editor.state.doc.lineAt(editor.state.selection.main.head).number - 1;
  view.highlight(line);
}

function gotoLine(line: number) {
  const l = editor.state.doc.line(Math.min(line + 1, editor.state.doc.lines));
  editor.dispatch({ selection: { anchor: l.from, head: l.to }, scrollIntoView: true, effects: [] });
  editor.focus();
  setTab('editor');
}
view.onPick = (line) => {
  const l = editor.state.doc.line(Math.min(line + 1, editor.state.doc.lines));
  editor.dispatch({ selection: { anchor: l.from, head: l.to }, scrollIntoView: true });
  view.highlight(line);
};
void activeLineDeco;

// ---------------------------------------------------------------- toolbar
const ex = $('examples') as HTMLSelectElement;
for (const name of Object.keys(EXAMPLES)) ex.add(new Option(name, name));
ex.addEventListener('change', () => {
  if (!ex.value) return;
  setText(EXAMPLES[ex.value]);
  ex.value = '';
});
function setText(text: string) {
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } });
  warm = new Map();
  lastPos = null;
  model = null;
  view.resetView();
  rebuild(true);
  view.resetView();
}
$('btn-reset').addEventListener('click', () => view.resetView());
$('btn-save').addEventListener('click', () => {
  const blob = new Blob([editor.state.doc.toString()], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${(pattern?.title ?? 'pattern').replace(/[^\w-]+/g, '-').toLowerCase()}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('btn-open').addEventListener('click', () => $('file-txt').click());
$('file-txt').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) setText(await f.text());
  (e.target as HTMLInputElement).value = '';
});

// PDF import with review step
$('btn-pdf').addEventListener('click', () => $('file-pdf').click());
$('file-pdf').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  (e.target as HTMLInputElement).value = '';
  if (!f) return;
  const dlg = $('pdf-dialog') as HTMLDialogElement;
  const ta = $('pdf-textarea') as HTMLTextAreaElement;
  const warn = $('pdf-warnings');
  ta.value = 'Reading PDF…';
  warn.innerHTML = '';
  dlg.showModal();
  try {
    const res = await importPdf(f);
    ta.value = res.text;
    for (const w of res.warnings) warn.append(Object.assign(document.createElement('li'), { textContent: w }));
    const check = parsePattern(res.text);
    const issues = check.diagnostics.filter((d) => d.severity !== 'info');
    if (issues.length) warn.append(Object.assign(document.createElement('li'), { textContent: `${issues.length} line(s) need a look. They are underlined in the editor after import.` }));
    await renderPage(res.doc, res.bestPage, $('pdf-canvas') as HTMLCanvasElement, Math.min(420, window.innerWidth - 80));
  } catch (err) {
    ta.value = '';
    warn.append(Object.assign(document.createElement('li'), { textContent: `Could not read this PDF (${(err as Error).message}). You can paste the pattern text instead.` }));
  }
  dlg.onclose = () => { if (dlg.returnValue === 'use' && ta.value.trim()) setText(ta.value); };
});

// mobile tabs
function setTab(tab: 'editor' | 'view') {
  document.querySelector('.layout')!.setAttribute('data-active', tab);
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.getAttribute('data-tab') === tab)));
  if (tab === 'view') window.dispatchEvent(new Event('resize'));
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.getAttribute('data-tab') as any)));

rebuild(true);
