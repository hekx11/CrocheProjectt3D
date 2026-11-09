import type { Pattern } from '../model/types';
import type { Suggestion } from '../ai/assist';
import type { LocalModel } from '../ai/local';

// Kept here (not imported from local.ts) so Transformers.js is only loaded when someone uses the helper.
export const MODELS: LocalModel[] = [
  { id: 'onnx-community/Qwen3-0.6B-ONNX', label: 'Qwen 3 0.6B', gpuDtype: 'q4f16', cpuDtype: 'quantized', mb: 600 },
];
/** Diagnostic codes the helper is offered for. */
export const HELP_CODES = new Set(['unknown-token', 'count-mismatch', 'ambiguous']);

const ON_KEY = 'crochet3d.ai.on';
const ls = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const errText = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  return /failed to fetch|networkerror|load failed/i.test(m) ? 'Could not download the model. Check your internet connection and try again (it is only needed once).' : m;
};
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export interface AiHost {
  text(): string;
  pattern(): Pattern | null;
  replaceLine(line: number, text: string): void;
  /** Called when the helper is switched on or off, so the editor can show or hide "Ask AI". */
  changed(): void;
}

/** Settings panel + suggestion card for the optional on-device AI. Off until the user switches it on. */
export function setupAi(host: AiHost) {
  const model = MODELS[0];
  const enabled = $<HTMLInputElement>('ai-on');
  enabled.checked = ls.get(ON_KEY) === '1';
  $('ai-size').textContent = `${model.label}, about ${model.mb} MB`;
  const status = $('ai-status');
  const bar = $('ai-bar');
  const barWrap = bar.parentElement!;

  const panel = $('ai');
  const toggle = (open?: boolean) => {
    const show = open ?? panel.hidden;
    panel.hidden = !show;
    $('btn-ai').setAttribute('aria-expanded', String(show));
  };
  $('btn-ai').addEventListener('click', () => toggle());
  $('ai-close').addEventListener('click', () => toggle(false));
  enabled.addEventListener('change', () => { ls.set(ON_KEY, enabled.checked ? '1' : '0'); host.changed(); });

  const progress = (text: string, f: number) => {
    barWrap.hidden = f >= 1;
    bar.style.width = `${Math.round(f * 100)}%`;
    status.textContent = text;
    const p = document.getElementById('ai-progress');
    if (p && !card.hidden) p.textContent = f >= 1 ? 'Thinking on your device…' : text;
  };

  $('ai-load').addEventListener('click', async () => {
    try {
      const { loadModel } = await import('../ai/local');
      await loadModel(model, progress);
      status.textContent = 'Ready. Works offline.';
    } catch (e) { status.textContent = errText(e); barWrap.hidden = true; }
  });
  $('ai-remove').addEventListener('click', async () => {
    const { removeDownload } = await import('../ai/local');
    await removeDownload();
    status.textContent = 'Removed from this browser.';
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
  apply.addEventListener('click', () => {
    if (!current) return;
    if (host.text().split('\n')[current.line] !== original) {
      body.insertAdjacentHTML('beforeend', '<p class="small" style="color:var(--warn)">The line changed since you asked. Ask again.</p>');
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
      const [{ suggest }, { localComplete }] = await Promise.all([import('../ai/assist'), import('../ai/local')]);
      const s = await suggest(host.text(), p, line, localComplete(model, progress), signal);
      if (currentLine !== line || signal.aborted) return;
      current = s.check.ok ? s : null;
      apply.disabled = !s.check.ok;
      body.innerHTML = [
        `<code>${esc(original.trim())}</code>`,
        s.syntax ? `<code>=> ${esc(s.syntax)}</code>` : '',
        `<p class="ai-verdict"><span class="dot ${s.check.ok ? 'ok' : 'ambiguous'}"></span><span>${s.check.ok ? 'The stitch count checks out. Small AI models make mistakes, so read it before you use it.' : `No usable suggestion: ${esc(s.check.message)}`}</span></p>`,
      ].join('');
    } catch (e) {
      if (currentLine !== line || signal.aborted) return;
      body.innerHTML = `<code>${esc(original.trim())}</code><p class="small" style="color:var(--err)">${esc(errText(e))}</p>`;
    }
  }

  return { ask, isOn: () => enabled.checked };
}
