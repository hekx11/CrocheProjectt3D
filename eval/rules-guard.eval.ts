import { it } from 'vitest';
import { CASES } from './cases';
import { patternFor } from './score';
import { parsePattern } from '../src/parser/parse';
import { inconsistent } from '../src/ai/assist';
it('would the second referee catch the rules reader\'s own silent mistakes?', () => {
  for (const c of CASES) {
    const { text, line } = patternFor(c);
    const p = parsePattern(text);
    const row = p.pieces[0].rows.find((r) => r.line === line);
    if (!row || p.diagnostics.some((d) => d.line === line && d.severity !== 'info')) continue;
    const prev = p.pieces[0].rows[row.index - 2];
    const why = inconsistent(c.line, row.ops, prev?.computedCount ?? 0, !prev);
    if (why) console.log('GUARD', c.id, why);
  }
});
