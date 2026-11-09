import { expect, it } from 'vitest';
import { CASES } from './cases';
import { goldRead } from './score';

it('every gold answer reads cleanly in the app', () => {
  const bad = CASES.filter((c) => c.gold).map((c) => ({ c, g: goldRead(c)! })).filter(({ g }) => g.flagged).map(({ c, g }) => `${c.id}: ${g.messages.join(' ')}`);
  expect(bad).toEqual([]);
});
