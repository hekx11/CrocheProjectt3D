import { CreateWebWorkerMLCEngine, hasModelInCache, type WebWorkerMLCEngine } from '@mlc-ai/web-llm';
import type { Complete } from './assist';

/**
 * Free AI that runs on the user's own device with WebLLM (WebGPU). The model is downloaded once from
 * Hugging Face, cached by the browser, and after that works offline. No key, no server, no cost.
 */
// Model choices live in ui/ai.ts so this module (and WebLLM) loads only on first use.

export function webgpuAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

export const isCached = (model: string) => hasModelInCache(model).catch(() => false);

let engine: WebWorkerMLCEngine | null = null;
let loaded = '';
let loading: Promise<WebWorkerMLCEngine> | null = null;

export async function loadModel(model: string, onProgress: (text: string, fraction: number) => void): Promise<WebWorkerMLCEngine> {
  if (engine && loaded === model) return engine;
  if (loading && loaded === model) return loading;
  if (!webgpuAvailable()) throw new Error('This browser has no WebGPU, which the free local AI needs. Try a current Chrome or Edge on a computer.');
  loaded = model;
  loading = (async () => {
    if (engine) { await engine.reload(model); return engine; }
    const worker = new Worker(new URL('./llm.worker.ts', import.meta.url), { type: 'module' });
    engine = await CreateWebWorkerMLCEngine(worker, model, {
      initProgressCallback: (r) => onProgress(r.text, r.progress),
    });
    return engine;
  })();
  try { return await loading; } catch (e) { loaded = ''; engine = null; throw e; } finally { loading = null; }
}

/** A Complete function backed by the local model. */
export function localComplete(model: string, onProgress: (text: string, fraction: number) => void): Complete {
  return async (system, user, schema, signal) => {
    const eng = await loadModel(model, onProgress);
    if (signal?.aborted) throw new Error('Cancelled.');
    const res = await eng.chat.completions.create({
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.2,
      max_tokens: 200,
      response_format: { type: 'json_object', schema: JSON.stringify(schema) },
      extra_body: { enable_thinking: false },
    });
    return res.choices[0]?.message?.content ?? '';
  };
}
