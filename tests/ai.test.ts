import { describe, expect, it, vi, afterEach } from 'vitest';
import { parsePattern } from '../src/parser/parse';
import { checkCandidate, describeLine, suggest } from '../src/ai/assist';

const TEXT = [
  'Ball',
  'Rnd 1: 6 sc in MR (6)',
  'Rnd 2: inc around (12)',
  'Rnd 3: now do the same increase pattern but with one plain stitch between each pair (18)',
].join('\n');

describe('AI helper', () => {
  it('flags the sentence line and checks a candidate against the stated count', () => {
    const p = parsePattern(TEXT);
    expect(p.diagnostics.some((d) => d.line === 3 && d.severity !== 'info')).toBe(true);
    const good = checkCandidate(TEXT, 3, '(sc, inc) x6');
    expect(good.ok).toBe(true);
    expect(good.syntax).toBe('(sc, inc) x6 (18)'); // stated count carried over
    expect(good.newLine).toMatch(/pair \(18\)\s+=> \(sc, inc\) x6 \(18\)$/);
    const bad = checkCandidate(TEXT, 3, '(2 sc, inc) x6');
    expect(bad.ok).toBe(false);
  });

  it('gives the model the previous count and the parser complaint', () => {
    const d = describeLine(TEXT, parsePattern(TEXT), 3);
    expect(d).toContain('previous row (2) has 12 stitches');
    expect(d).toContain('>> Rnd 3');
  });

  afterEach(() => vi.unstubAllGlobals());

  it('retries once with the parser verdict, then returns a checked suggestion', async () => {
    const answers = ['(2 sc, inc) x6', '(sc, inc) x6'];
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      const syntax = answers.shift();
      return new Response(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: JSON.stringify({ syntax, explanation: 'One sc, then an increase, six times.' }) }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const s = await suggest(TEXT, parsePattern(TEXT), 3, { key: 'sk-test', model: 'claude-opus-5-5' });
    expect(s.check.ok).toBe(true);
    expect(s.syntax).toBe('(sc, inc) x6 (18)');
    expect(bodies).toHaveLength(2);
    expect(bodies[0].fallbacks).toBe('default');
    expect(bodies[0].output_config.format.type).toBe('json_schema');
    expect(bodies[1].messages.at(-1).content).toContain('Please correct');
  });
});
