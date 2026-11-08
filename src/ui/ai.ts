import type { Pattern } from '../model/types';
import type { AiModel, AiSettings, Suggestion } from '../ai/assist';

const KEY = 'crochet3d.ai.key';
const MODEL = 'crochet3d.ai.model';
const MODELS: { id: AiModel; label: string }[] = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (best)' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (cheapest)' },
];

/** Diagnostic codes the helper is offered for. */
export const HELP_CODES = new Set(['unknown-token', 'count-mismatch', 'ambiguous']);

const ls = {
  get(k: string) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  del(k: string) { try { localStorage.removeItem(k); } catch { /* private mode */ } },
};
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export interface AiHost {
  text(): string;
  pattern(): Pattern | null;
  replaceLine(line: number, text: string): void;
}

/** Settings panel + suggestion card. The SDK is only loaded the first time someone asks. */
export function setupAi(host: AiHost) {
  let key = ls.get(KEY) ?? '';
  const keyInput = $<HTMLInputElement>('ai-key');
  const remember = $<HTMLInputElement>('ai-remember');
  const modelSel = $<HTMLSelectElement>('ai-model');
  for (const m of MODELS) modelSel.add(new Option(m.label, m.id));
  modelSel.value = ls.get(MODEL) ?? MODELS[0].id;
  keyInput.value = key;
  remember.checked = !!ls.get(KEY);

  const save = () => {
    key = keyInput.value.trim();
    if (remember.checked && key) ls.set(KEY, key); else ls.del(KEY);
    ls.set(MODEL, modelSel.value);
  };
  keyInput.addEventListener('change', save);
  remember.addEventListener('change', save);
  modelSel.addEventListener('change', save);

  const panel = $('ai');
  const toggle = (open?: boolean) => {
    const show = open ?? panel.hidden;
    panel.hidden = !show;
    $('btn-ai').setAttribute('aria-expanded', String(show));
    if (show) keyInput.focus();
  };
  $('btn-ai').addEventListener('click', () => toggle());
  $('ai-close').addEventListener('click', () => { save(); toggle(false); });
  $('ai-forget').addEventListener('click', () => { keyInput.value = ''; remember.checked = false; save(); });

  const card = $('ai-card');
  const body = $('ai-body');
  const apply = $<HTMLButtonElement>('ai-apply');
  let current: Suggestion | null = null;
  let currentLine = -1;
  let original = '';
  let abort: AbortController | null = null;

  const close = () => { abort?.abort(); card.hidden = true; current = null; };
  $('ai-dismiss').addEventListener('click', close);
  $('ai-retry').addEventListener('click', () => { if (currentLine >= 0) ask(currentLine); });
  apply.addEventListener('click', () => {
    if (!current) return;
    // only apply if the line wasn't edited meanwhile
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
    save();
    if (!key) { toggle(true); return; }
    abort?.abort();
    abort = new AbortController();
    currentLine = line;
    current = null;
    original = host.text().split('\n')[line] ?? '';
    card.hidden = false;
    apply.disabled = true;
    $('ai-line').textContent = `line ${line + 1}`;
    body.innerHTML = `<code>${esc(original.trim())}</code><p class="muted small">Asking ${esc(modelSel.selectedOptions[0]?.text ?? '')}…</p>`;
    try {
      const { suggest } = await import('../ai/assist');
      const settings: AiSettings = { key, model: modelSel.value as AiModel };
      const s = await suggest(host.text(), p, line, settings, abort.signal);
      if (currentLine !== line) return;
      current = s;
      apply.disabled = !s.syntax;
      body.innerHTML = [
        `<code>${esc(original.trim())}</code>`,
        s.syntax ? `<code>=> ${esc(s.syntax)}</code>` : '',
        `<p class="small">${esc(s.explanation)}</p>`,
        `<p class="ai-verdict"><span class="dot ${s.check.ok ? 'ok' : 'ambiguous'}"></span><span>${s.check.ok ? 'The app checked it. ' : 'The app still has a problem with it: '}${esc(s.check.message)}</span></p>`,
      ].join('');
      apply.textContent = s.check.ok ? 'Use it' : 'Use it anyway';
    } catch (e) {
      if (currentLine !== line) return;
      body.innerHTML = `<code>${esc(original.trim())}</code><p class="small" style="color:var(--err)">${esc((e as Error).message)}</p>`;
    }
  }

  return { ask, openSettings: () => toggle(true) };
}
