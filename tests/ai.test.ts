import { describe, expect, it } from 'vitest';
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

  it('retries with the parser verdict, then returns a checked suggestion', async () => {
    const answers = ['not json', JSON.stringify({ syntax: '(2 sc, inc) x6', explanation: 'x' }), JSON.stringify({ syntax: '(sc, inc) x6', explanation: 'One sc, then an increase, six times.' })];
    const prompts: string[] = [];
    const s = await suggest(TEXT, parsePattern(TEXT), 3, async (_sys, user) => { prompts.push(user); return answers.shift()!; });
    expect(s.check.ok).toBe(true);
    expect(s.syntax).toBe('(sc, inc) x6 (18)');
    expect(s.attempts).toBe(3);
    expect(prompts[2]).toContain('A previous answer was "(2 sc, inc) x6 (18)"');
  });
});
