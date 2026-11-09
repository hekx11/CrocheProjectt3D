import type { Complete } from './assist';

/**
 * Small AI that runs on the user's own device with Transformers.js (ONNX Runtime Web). It uses
 * WebGPU when the browser has it and falls back to WebAssembly on the CPU otherwise, so it works
 * in any current browser. The model is downloaded once from Hugging Face, cached by the browser,
 * and after that works offline. No key, no server, no cost.
 */

export interface LocalModel { id: string; label: string; gpuDtype: string; cpuDtype: string; mb: number }

export const webgpuAvailable = () => typeof navigator !== 'undefined' && 'gpu' in navigator;

type Gen = (messages: unknown, opts: object) => Promise<{ generated_text: string | { content: string }[] }[]>;
let gen: (Gen & { dispose(): Promise<void> }) | null = null;
let loaded = '';
let loading: Promise<Gen> | null = null;

export async function loadModel(m: LocalModel, onProgress: (text: string, fraction: number) => void): Promise<Gen> {
  if (gen && loaded === m.id) return gen;
  if (loading && loaded === m.id) return loading;
  loaded = m.id;
  loading = (async () => {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.allowLocalModels = false;
    if (gen) { await gen.dispose().catch(() => undefined); gen = null; }
    const files = new Map<string, { loaded: number; total: number }>();
    const gpu = webgpuAvailable();
    const p = await pipeline('text-generation', m.id, {
      device: gpu ? 'webgpu' : 'wasm',
      dtype: (gpu ? m.gpuDtype : m.cpuDtype) as never,
      progress_callback: (e: { status: string; file?: string; loaded?: number; total?: number }) => {
        if (e.status !== 'progress' || !e.file) return;
        files.set(e.file, { loaded: e.loaded ?? 0, total: e.total ?? 0 });
        let a = 0, t = 0;
        for (const f of files.values()) { a += f.loaded; t += f.total; }
        onProgress(`Downloading the model: ${Math.round(a / 1e6)} of ${Math.round(t / 1e6)} MB`, t ? a / t : 0);
      },
    });
    onProgress('Ready.', 1);
    gen = p as unknown as Gen & { dispose(): Promise<void> };
    return gen;
  })();
  try { return await loading; } catch (e) { loaded = ''; gen = null; throw e; } finally { loading = null; }
}

/** A Complete function backed by the local model (greedy, short answers). */
export function localComplete(m: LocalModel, onProgress: (text: string, fraction: number) => void): Complete {
  return async (messages, signal) => {
    const g = await loadModel(m, onProgress);
    if (signal?.aborted) throw new Error('Cancelled.');
    const out = await g(messages, { max_new_tokens: 48, do_sample: false, return_full_text: false, tokenizer_encode_kwargs: { enable_thinking: false } });
    const t = out[0]?.generated_text;
    return typeof t === 'string' ? t : t?.at(-1)?.content ?? '';
  };
}

/** Delete the cached model files from this browser. */
export async function removeDownload(): Promise<void> {
  if (typeof caches !== 'undefined') await caches.delete('transformers-cache').catch(() => false);
  if (gen) { await gen.dispose().catch(() => undefined); gen = null; loaded = ''; }
}
