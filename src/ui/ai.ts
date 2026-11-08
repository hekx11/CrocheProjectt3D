import type { Pattern } from '../model/types';
import type { Suggestion } from '../ai/assist';

const MODEL_KEY = 'crochet3d.ai.model';
// Kept here (not imported from local.ts) so WebLLM is only loaded when someone uses the helper.
const MODELS = [
  { id: 'Qwen3.5-2B-q4f16_1-MLC', label: 'Qwen 3.5 2B · about 1.2 GB (recommended)' },
  { id: 'Qwen3.5-4B-q4f16_1-MLC', label: 'Qwen 3.5 4B · about 2.3 GB, smarter' },
  { id: 'Qwen3.5-0.8B-q4f16_1-MLC', label: 'Qwen 3.5 0.8B · about 0.5 GB, weaker devices' },
];

/** Diagnostic codes the helper is offered for. */
export const HELP_CODES = new Set(['unknown-token', 'count-mismatch', 'ambiguous']);

const ls = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const errText = (e: unknown) => friendly(e instanceof Error ? e.message : typeof e === 'object' && e && 'message' in e ? String((e as { message: unknown }).message) : String(e));
const friendly = (m: string) => (/failed to fetch|networkerror|load failed/i.test(m) ? 'Could not download the model. Check your internet connection and try again (it is only needed once).' : m);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export interface AiHost {
  text(): string;
  pattern(): Pattern | null;
  replaceLine(line: number, text: string): void;
}

/** Settings panel + suggestion card for the free on-device AI. */
export function setupAi(host: AiHost) {
  const modelSel = $<HTMLSelectElement>('ai-model');
  for (const m of MODELS) modelSel.add(new Option(m.label, m.id));
  modelSel.value = ls.get(MODEL_KEY) ?? MODELS[0].id;
  if (!modelSel.value) modelSel.value = MODELS[0].id;
  const status = $('ai-status');
  const bar = $('ai-bar');
  const barWrap = bar.parentElement!;
  const hasGpu = 'gpu' in navigator;

  const panel = $('ai');
  const toggle = (open?: boolean) => {
    const show = open ?? panel.hidden;
    panel.hidden = !show;
    $('btn-ai').setAttribute('aria-expanded', String(show));
    if (show) refreshStatus();
  };
  $('btn-ai').addEventListener('click', () => toggle());
  $('ai-close').addEventListener('click', () => toggle(false));

  async function refreshStatus() {
    if (!hasGpu) { status.textContent = 'This browser has no WebGPU, so the local AI can\'t run here. Try a current Chrome or Edge on a computer.'; return; }
    const { isCached } = await import('../ai/local');
    status.textContent = (await isCached(modelSel.value)) ? 'Downloaded. Works offline.' : 'Not downloaded yet. It downloads the first time you ask, or now.';
  }
  modelSel.addEventListener('change', () => { ls.set(MODEL_KEY, modelSel.value); refreshStatus(); });

  const progress = (text: string, f: number) => {
    barWrap.hidden = f >= 1;
    bar.style.width = `${Math.round(f * 100)}%`;
    status.textContent = text;
    if (!card.hidden) $('ai-progress').textContent = `Loading the model on your device: ${Math.round(f * 100)}%`;
  };

  $('ai-load').addEventListener('click', async () => {
    try {
      const { loadModel } = await import('../ai/local');
      await loadModel(modelSel.value, progress);
      status.textContent = 'Ready. Works offline.';
    } catch (e) { status.textContent = errText(e); barWrap.hidden = true; }
  });
  $('ai-remove').addEventListener('click', async () => {
    const { deleteModelAllInfoInCache } = await import('@mlc-ai/web-llm');
    await deleteModelAllInfoInCache(modelSel.value).catch(() => undefined);
    refreshStatus();
  });

  const card = $('ai-card');
  const body = $('ai-body');
  const apply = $<HTMLButtonElement>('ai-apply');
  let current: Suggestion | null = null;
  let currentLine = -1;
  let original = '';
  let abort: AbortController | null = null;

  const close = () => { abort?.abort(); card.hidden = true; current = null; currentLine = -1; };
  $('ai-dismiss').addEventListener('click', close);
  $('ai-retry').addEventListener('click', () => { if (currentLine >= 0) ask(currentLine); });
  apply.addEventListener('click', () => {
    if (!current) return;
    if (host.text().split('\n')[current.line] !== original) {
      body.insertAdjacentHTML('beforeend', '<p class="small" style="color:var(--warn)">The line changed since you asked. Try again.</p>');
      return;
    }
    host.replaceLine(current.line, current.newLine);
    close();
  });

  async function ask(line: number) {
    const p = host.pattern();
    if (!p) return;
    abort?.abort();
    abort = new AbortController();
    const signal = abort.signal;
    currentLine = line;
    current = null;
    original = host.text().split('\n')[line] ?? '';
    card.hidden = false;
    apply.disabled = true;
    $('ai-line').textContent = `line ${line + 1}`;
    body.innerHTML = `<code>${esc(original.trim())}</code><p id="ai-progress" class="muted small">Thinking on your device…</p>`;
    try {
      if (!hasGpu) throw new Error('This browser has no WebGPU, so the free local AI can\'t run here. Try a current Chrome or Edge on a computer.');
      const [{ suggest }, { localComplete }] = await Promise.all([import('../ai/assist'), import('../ai/local')]);
      const s = await suggest(host.text(), p, line, localComplete(modelSel.value, progress), signal);
      if (currentLine !== line || signal.aborted) return;
      current = s;
      apply.disabled = !s.syntax;
      body.innerHTML = [
        `<code>${esc(original.trim())}</code>`,
        s.syntax ? `<code>=> ${esc(s.syntax)}</code>` : '',
        s.explanation ? `<p class="small">${esc(s.explanation)}</p>` : '',
        `<p class="ai-verdict"><span class="dot ${s.check.ok ? 'ok' : 'ambiguous'}"></span><span>${s.check.ok ? 'The app checked it. ' : 'The app still has a problem with it: '}${esc(s.check.message)}</span></p>`,
      ].join('');
      apply.textContent = s.check.ok ? 'Use it' : 'Use it anyway';
    } catch (e) {
      if (currentLine !== line || signal.aborted) return;
      body.innerHTML = `<code>${esc(original.trim())}</code><p class="small" style="color:var(--err)">${esc(errText(e))}</p>`;
    }
  }

  return { ask, openSettings: () => toggle(true) };
}
