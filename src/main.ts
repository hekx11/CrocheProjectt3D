import '@fontsource-variable/nunito';
import '@fontsource-variable/fraunces';
import './style.css';
import { EditorView, minimalSetup } from 'codemirror';
import { Decoration, MatchDecorator, ViewPlugin, highlightActiveLine, placeholder, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { lintGutter, setDiagnostics, type Diagnostic as CmDiagnostic } from '@codemirror/lint';
import { parsePattern } from './parser/parse';
import { buildModel, type Model } from './geometry/pipeline';
import { fabricThickness, type UserMaterials } from './geometry/sizing';
import { CrochetView } from './render/scene';
import type { Pattern } from './model/types';
import { renderOutline } from './ui/outline';
import { applyColorOverrides, patternKey, renderYarnColors, swatchList, yarnsInUse, type ColorOverrides } from './ui/yarnColors';
import { importPdf, renderPage } from './pdf/extract';
import { startTour } from './ui/tour';

import ball from '../fixtures/ball.txt?raw';
import bear from '../fixtures/bear-head.txt?raw';
import coaster from '../fixtures/coaster.txt?raw';
import flower from '../fixtures/flower.txt?raw';
import ukBall from '../fixtures/uk-ball.txt?raw';
import granny from '../fixtures/granny-square.txt?raw';
import basket from '../fixtures/basket.txt?raw';
import cat from '../fixtures/sleepy-cat.txt?raw';
import littleBear from '../fixtures/little-bear.txt?raw';

const EXAMPLES: Record<string, string> = {
  'Bear head (several pieces)': bear,
  'Little bear (arms and ears sewn on)': littleBear,
  'Ball': ball,
  'Coaster (flat rows)': coaster,
  'Flower (joined rounds)': flower,
  'Mini ball (UK terms)': ukBall,
  'Granny square (chain spaces)': granny,
  'Basket (walls from a flat base)': basket,
  'Sleepy cat (oval start)': cat,
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
$('m-reset').addEventListener('click', () => {
  user = { tension: 'normal' };
  if (pattern) { delete colors[patternKey(pattern)]; saveColors(); }
  syncMaterialsForm();
  readMaterialsForm();
});

// ---------------------------------------------------------------- yarn colours
let colors: ColorOverrides = {};
try { colors = JSON.parse(store.get('crochet3d.colors') ?? '{}') ?? {}; } catch { /* ignore */ }
const saveColors = () => store.set('crochet3d.colors', JSON.stringify(colors));
let patternColors = new Map<string, string>(); // what the pattern itself says, per yarn id
document.body.append(swatchList());
let recolorFrame = 0;
function pickColor(id: string, color: string | null) {
  if (!pattern) return;
  const key = patternKey(pattern);
  const mine = (colors[key] ??= {});
  const orig = patternColors.get(id);
  if (color === null || color.toLowerCase() === orig?.toLowerCase()) delete mine[id];
  else mine[id] = color;
  if (!Object.keys(mine).length) delete colors[key];
  saveColors();
  const y = pattern.materials.yarns.find((q) => q.id === id);
  if (y) y.color = mine[id] ?? orig ?? y.color;
  showYarnColors();
  // live: repaint the solved model in place, at most once a frame while a picker is dragged
  cancelAnimationFrame(recolorFrame);
  recolorFrame = requestAnimationFrame(() => {
    if (pattern) view.recolor(new Map(pattern.materials.yarns.map((q) => [q.id, q.color])));
  });
}
function showYarnColors() {
  if (pattern) renderYarnColors($('m-colors'), yarnsInUse(pattern), patternColors, pickColor);
}
const toggleMaterials = (open?: boolean) => {
  const p = $('materials');
  const show = open ?? p.hidden;
  p.hidden = !show;
  $('btn-materials').setAttribute('aria-expanded', String(show));
};
$('btn-materials').addEventListener('click', () => toggleMaterials());
$('m-close').addEventListener('click', () => toggleMaterials(false));
window.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Escape' && !$('materials').hidden) toggleMaterials(false); });

// ---------------------------------------------------------------- solver worker
const worker = new Worker(new URL('./geometry/solver.worker.ts', import.meta.url), { type: 'module' });
let job = 0;
const STILL = /[?&]still\b/.test(location.search);
let model: Model | null = null;
let lastPos: Float32Array | null = null;
let warm = new Map<string, [number, number, number]>();
worker.onmessage = (e: MessageEvent<{ type: 'frame'; job: number; pos: Float32Array; done: boolean }>) => {
  if (e.data.job !== job || !model) return;
  lastPos = e.data.pos;
  if (e.data.done) {
    cancelAnimationFrame(shown);
    shown = 0;
    view.update(e.data.pos);
    $('solving').hidden = true;
    view.settled();
    rememberPositions();
    return;
  }
  // ?still: draw only the solved shape (screenshots on slow software renderers)
  if (STILL) return;
  // the solver sends frames faster than a big piece can be redrawn: draw only the newest one per
  // screen frame, or the frames queue up here and the finished shape arrives seconds late
  const j = job;
  if (!shown) shown = requestAnimationFrame(() => {
    shown = 0;
    // a new model may have come in meanwhile, and this frame's positions don't fit it
    if (j === job && lastPos && model) view.update(lastPos);
  });
};
let shown = 0;
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
    // a pattern is prose, not code: no line numbers, folding or bracket helpers
    minimalSetup,
    highlightActiveLine(),
    placeholder('Type or paste your pattern here, for example:\nRnd 1: 6 sc in MR (6)'),
    EditorView.lineWrapping,
    lintGutter(),
    decoPlugin(annotationDeco),
    decoPlugin(labelDeco),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) schedule();
      if (u.selectionSet || u.docChanged) onCursor();
    }),
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
  patternColors = applyColorOverrides(pattern, colors);
  showYarnColors();
  // diagnostics → editor
  const diags: CmDiagnostic[] = pattern.diagnostics.map((d) => ({
    from: Math.min(d.src.from, text.length), to: Math.min(Math.max(d.src.to, d.src.from), text.length),
    severity: d.severity, message: d.message,
    actions: d.readings?.map((r) => ({ name: d.readings!.length > 1 ? `Use ${r}` : 'Keep this reading', apply: () => pickReading(d.line, r) })),
  }));
  editor.dispatch(setDiagnostics(editor.state, diags));
  renderOutline($('outline'), $('outline-summary'), pattern, (line) => gotoLine(line), pickReading);

  const topology = JSON.stringify([pattern.pieces.map((p) => [p.name, p.quantity, p.rows.map((r) => [r.computedCount, r.yarnId, r.line])]), pattern.seams.length, user]);
  if (!force && topology === lastTopology) return;
  lastTopology = topology;
  if (lastPos && model) rememberPositions();
  if (!pattern.pieces.length) { $('size').textContent = 'Waiting for your pattern…'; $('size-source').textContent = ''; return; }
  model = buildModel(pattern, user, warm);
  view.setModel(model);
  $('size-source').textContent = `Worked out from ${model.sizing.source}, ${model.sizing.fiber} yarn · one sc ≈ ${model.sizing.w.toFixed(1)} × ${model.sizing.h.toFixed(1)} mm`;
  $('solving').hidden = false;
  job++;
  worker.postMessage({ type: 'start', job, input: model.solverInput, frames: 400 });
  onCursor();
}

view.onSize = (ext) => {
  // the solved mesh is the fabric's mid-surface: add the fabric's own thickness so a flat piece isn't "0.0 cm" thick
  const t = model ? fabricThickness(model.sizing) : 0;
  const [x, y, z] = ext.map((v) => v + t);
  const cm = (v: number) => (v / 10).toFixed(1);
  const inch = (v: number) => (v / 25.4).toFixed(1);
  $('size').innerHTML = `${cm(x)} × ${cm(y)} × ${cm(z)} cm <span class="inch">${inch(x)}″ × ${inch(y)}″ × ${inch(z)}″</span>`;
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

// ---------------------------------------------------------------- picking a reading
/** Write the chosen reading on the line as "=> short syntax", so the text stays the single source of truth. */
function pickReading(line: number, reading: string) {
  const l = editor.state.doc.line(line + 1);
  const ann = l.text.indexOf('=>');
  const body = (ann >= 0 ? l.text.slice(0, ann) : l.text).trimEnd();
  editor.dispatch({ changes: { from: l.from, to: l.to, insert: `${body}  => ${reading}` } });
}

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
// one "Open a pattern" button for both text files and PDFs
$('btn-open').addEventListener('click', () => $('file-any').click());
$('file-any').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  (e.target as HTMLInputElement).value = '';
  if (!f) return;
  if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) await openPdf(f);
  else setText(await f.text());
});

// PDF import with review step
async function openPdf(f: File) {
  const dlg = $('pdf-dialog') as HTMLDialogElement;
  const ta = $('pdf-textarea') as HTMLTextAreaElement;
  const warn = $('pdf-warnings');
  ta.value = 'Reading your PDF…';
  warn.innerHTML = '';
  dlg.showModal();
  try {
    const res = await importPdf(f);
    ta.value = res.text;
    for (const w of res.warnings) warn.append(Object.assign(document.createElement('li'), { textContent: w }));
    const check = parsePattern(res.text);
    const issues = check.diagnostics.filter((d) => d.severity !== 'info');
    if (issues.length) warn.append(Object.assign(document.createElement('li'), { textContent: `${issues.length} line(s) need a look. They are underlined in your pattern after you use it.` }));
    await renderPage(res.doc, res.bestPage, $('pdf-canvas') as HTMLCanvasElement, Math.min(420, window.innerWidth - 80));
  } catch (err) {
    ta.value = '';
    warn.append(Object.assign(document.createElement('li'), { textContent: `Could not read this PDF (${(err as Error).message}). You can paste the pattern text instead.` }));
  }
  dlg.onclose = () => { if (dlg.returnValue === 'use' && ta.value.trim()) setText(ta.value); };
}

// mobile tabs
function setTab(tab: 'editor' | 'view') {
  document.querySelector('.layout')!.setAttribute('data-active', tab);
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.getAttribute('data-tab') === tab)));
  if (tab === 'view') window.dispatchEvent(new Event('resize'));
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.getAttribute('data-tab') as any)));

// ---------------------------------------------------------------- writing guide
const guide = $('guide') as HTMLDialogElement;
$('btn-guide').addEventListener('click', () => { guide.returnValue = ''; guide.showModal(); guide.scrollTop = 0; });
guide.addEventListener('click', (e) => { if (e.target === guide) guide.close(); }); // click outside the sheet
guide.addEventListener('close', () => {
  if (guide.returnValue !== 'example') return;
  const mine = editor.state.doc.toString().trim();
  const untouched = !mine || Object.values(EXAMPLES).some((t) => t.trim() === mine);
  if (untouched || confirm('Load the Little bear example? It replaces the pattern you have open.')) setText(littleBear);
});

// ---------------------------------------------------------------- guided tour
const DOT = (k: string, t: string) => `<span><i class="dot ${k}"></i>${t}</span>`;
function tour() {
  toggleMaterials(false);
  startTour([
    { title: 'See your crochet before you make it', body: '<p>Write or open a crochet pattern and watch it take shape in 3D, with the stitch counts checked and the finished size worked out for you.</p><p class="muted small">The tour takes about a minute.</p>' },
    { target: '.pane-editor', before: () => setTab('editor'), title: 'Your pattern goes here', body: '<p>Type it or paste it just as it is written in the pattern, one round or row per line:</p><span class="eg"><b>Rnd 2:</b> inc in each st around (12)</span><p class="muted small">The usual abbreviations work (sc, inc, dec, hdc, dc, ch, sl st, MR…), in US or UK terms. Notes like “stuff the head” or “sew the ears to the head” are understood too.</p>' },
    { target: '#btn-guide', before: () => setTab('editor'), title: 'Writing your own?', body: '<p><b>Writing tips</b> shows how to set a pattern out, and what to write so parts are sewn on in the right place:</p><span class="eg">Sew the arms to the sides of the body <b>between Rnds 9 and 11</b>.</span>' },
    { target: '.actions', title: 'Already have a pattern?', body: '<p><b>Open a pattern</b> reads a PDF or a text file. It stays on your device, nothing is uploaded.</p><p>Not sure where to start? <b>Try an example</b> and change a number to see what happens.</p>' },
    { target: '.pane-view', before: () => setTab('view'), title: 'Watch it take shape', body: '<p>The model follows along as you type. Drag to turn it and scroll or pinch to zoom.</p><p>Click any stitch on the model to jump to the line it comes from.</p>' },
    { target: '.outline', before: () => { setTab('editor'); ($('outline').parentElement as HTMLDetailsElement).open = true; }, title: 'Your stitch counts, checked', body: `<p>Every round is counted for you and compared with the number at the end of its line.</p><div class="dots-row">${DOT('ok', 'the count adds up')}${DOT('ambiguous', 'worth a second look')}${DOT('unreadable', 'we could not read this line')}</div><p class="muted small">Click a round to find it in your pattern.</p>` },
    { target: '#btn-materials', title: 'Make it true to size', body: '<p>Under <b>Yarn &amp; hook</b>, say which yarn and hook you are using and how tightly you crochet. The finished size updates, and you can try out your own colours.</p><p class="muted small">You can replay this tour any time with “How it works”.</p>' },
  ], () => store.set('crochet3d.tour', 'seen'));
}
$('btn-help').addEventListener('click', tour);

rebuild(true);
// first visit: show people around (not for ?still screenshots)
if (!STILL && !store.get('crochet3d.tour')) tour();
