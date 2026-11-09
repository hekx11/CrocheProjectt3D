import { it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { CASES } from './cases';
import { goldRead, patternFor, readLine, same } from './score';
import { parsePattern } from '../src/parser/parse';
import { suggest, type Complete } from '../src/ai/assist';

/**
 * Rules-only reader vs rules + local AI on the held-out lines.
 *   MODELS="onnx-community/LFM2.5-350M-ONNX:q4,..." npx vitest run -c eval/vitest.config.ts eval/compare.eval.ts
 * With no MODELS only the rules-only baseline runs.
 */
type Outcome = 'right' | 'wrong-accepted' | 'flagged';

function rulesOutcome(c: (typeof CASES)[number]) {
  const { text, line } = patternFor(c);
  const r = readLine(text, line);
  const g = goldRead(c);
  const outcome: Outcome = r.flagged ? 'flagged' : c.gold === null ? 'wrong-accepted' : same(r, g) ? 'right' : 'wrong-accepted';
  return { text, line, r, g, outcome };
}

async function loadModel(spec: string): Promise<{ complete: Complete; dispose: () => Promise<void> }> {
  const [id, dtype = 'q4'] = spec.split(':');
  const { pipeline } = await import('@huggingface/transformers');
  const gen: any = await pipeline('text-generation', id, { dtype: dtype as any, device: 'cpu' });
  return {
    complete: async (messages) => {
      const out = await gen(messages, { max_new_tokens: 48, do_sample: false, return_full_text: false, tokenizer_encode_kwargs: { enable_thinking: false } });
      const g = out[0].generated_text;
      return typeof g === 'string' ? g : g.at(-1).content;
    },
    dispose: () => gen.dispose(),
  };
}

it('rules-only vs rules + local AI', async () => {
  const rules = CASES.map((c) => ({ c, ...rulesOutcome(c) }));
  const tally = (xs: Outcome[]) => ({ right: xs.filter((x) => x === 'right').length, wrongAccepted: xs.filter((x) => x === 'wrong-accepted').length, flagged: xs.filter((x) => x === 'flagged').length });
  const report: any = { cases: CASES.length, modellable: CASES.filter((c) => c.gold).length, rules: tally(rules.map((x) => x.outcome)), perCase: {} as Record<string, any>, models: {} as Record<string, any> };
  for (const x of rules) report.perCase[x.c.id] = { line: x.c.line, rules: x.outcome, rulesMsg: x.r.messages.join(' ') };
  console.log('RULES', JSON.stringify(report.rules));

  for (const spec of (process.env.MODELS ?? '').split(',').filter(Boolean)) {
    const t0 = Date.now();
    const m = await loadModel(spec);
    const loadMs = Date.now() - t0;
    const fallback: Outcome[] = [];
    const alone: Outcome[] = [];
    let calls = 0, genMs = 0;
    const timed: Complete = async (msgs, s) => { const t = Date.now(); calls++; try { return await m.complete(msgs, s); } finally { genMs += Date.now() - t; } };
    for (const x of rules) {
      const pc = report.perCase[x.c.id];
      // AI alone: the model answers every line, the count check referees (as if there were no rules)
      const p = parsePattern(x.text);
      const fallbackCase = x.outcome === 'flagged' && x.r.needsHelp;
      if (process.env.ALONE === '0' && !fallbackCase) { pc[spec] = { fallback: x.outcome }; fallback.push(x.outcome); continue; }
      const sAlone = await suggest(x.text, p, x.line, timed, undefined);
      const aloneOut = judge(sAlone, x);
      alone.push(aloneOut);
      // the app's way: AI only on lines the rules flag, and only applied when it passes the check
      let fb: Outcome = x.outcome;
      let fbSyntax = '';
      if (fallbackCase) {
        const s = sAlone; // same prompt and greedy decoding, so the answer would be identical
        fbSyntax = s.syntax;
        fb = judge(s, x);
      }
      fallback.push(fb);
      pc[spec] = { alone: aloneOut, aloneSyntax: sAlone.syntax, fallback: fb, fallbackSyntax: fbSyntax };
      console.log(spec, x.c.id, x.outcome, '->', fb, '| alone', aloneOut, JSON.stringify(sAlone.syntax));
    }
    report.models[spec] = { loadMs, calls, msPerCall: Math.round(genMs / Math.max(1, calls)), fallback: tally(fallback), alone: tally(alone) };
    console.log('MODEL', spec, JSON.stringify(report.models[spec]));
    await m.dispose();
  }
  mkdirSync('eval/results', { recursive: true });
  writeFileSync(`eval/results/${process.env.OUT ?? 'latest'}.json`, JSON.stringify(report, null, 2));
});

function judge(s: { syntax: string; check: { ok: boolean } }, x: { c: (typeof CASES)[number]; g: ReturnType<typeof goldRead> }): Outcome {
  if (!s.check.ok) return 'flagged';
  if (x.c.gold === null) return 'wrong-accepted';
  const { text, line } = patternFor(x.c, s.syntax);
  return same(readLine(text, line), x.g) ? 'right' : 'wrong-accepted';
}
