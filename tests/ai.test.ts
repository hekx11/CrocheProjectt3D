import { describe, expect, it } from 'vitest';
import { parsePattern } from '../src/parser/parse';
import { checkCandidate, cleanAnswer, describeLine, suggest } from '../src/ai/assist';

const TEXT = [
  'Ball',
  'Rnd 1: 6 sc in MR (6)',
  'Rnd 2: inc around (12)',
  'Rnd 3: now do the same increase pattern but with one plain stitch between each pair (18)',
].join('\n');

describe('optional AI helper', () => {
  it('checks a candidate against the stated count', () => {
    const p = parsePattern(TEXT);
    expect(p.diagnostics.some((d) => d.line === 3 && d.severity !== 'info')).toBe(true);
    const good = checkCandidate(TEXT, 3, '(sc, inc) x6');
    expect(good.ok).toBe(true);
    expect(good.syntax).toBe('(sc, inc) x6 (18)');
    expect(checkCandidate(TEXT, 3, '(2 sc, inc) x6').ok).toBe(false);
  });

  it('gives the model the previous count and the bare instruction', () => {
    const d = describeLine(TEXT, parsePattern(TEXT), 3);
    expect(d).toBe('Previous round: 12 stitches.\nLine: now do the same increase pattern but with one plain stitch between each pair (18)');
  });

  it('cleans chatty answers', () => {
    expect(cleanAnswer('Short syntax: `(sc, inc) x6 (18)`\nThis means…')).toBe('(sc, inc) x6 (18)');
    expect(cleanAnswer('<think>hm</think>\n=> 18 sc')).toBe('18 sc');
  });

  it('retries with the parser verdict, then returns a checked suggestion', async () => {
    const answers = ['', '(2 sc, inc) x6', '(sc, inc) x6'];
    const prompts: string[] = [];
    const s = await suggest(TEXT, parsePattern(TEXT), 3, async (msgs) => { prompts.push(msgs.at(-1)!.content); return answers.shift()!; });
    expect(s.check.ok).toBe(true);
    expect(s.syntax).toBe('(sc, inc) x6 (18)');
    expect(s.attempts).toBe(3);
    expect(prompts[2]).toContain('A previous answer "(2 sc, inc) x6 (18)" was wrong');
  });
});
