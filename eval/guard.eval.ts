import { expect, it } from 'vitest';
import { CASES } from './cases';
import { patternFor } from './score';
import { checkCandidate } from '../src/ai/assist';
it('the second referee accepts every gold answer', () => {
  const bad = CASES.filter((c) => c.gold).map((c) => { const { text, line } = patternFor(c); return [c.id, checkCandidate(text, line, c.gold!)] as const; }).filter(([, r]) => !r.ok).map(([id, r]) => `${id}: ${r.message}`);
  expect(bad).toEqual([]);
});
