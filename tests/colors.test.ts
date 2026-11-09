import { describe, expect, it } from 'vitest';
import { parsePattern } from '../src/parser/parse';
import { buildModel } from '../src/geometry/pipeline';
import { applyColorOverrides, patternKey, yarnsInUse } from '../src/ui/yarnColors';

const TWO_TONE = `Striped Ball
Rnd 1: 6 sc in MR (6)
Rnd 2: Inc around (12)
Change to white.
Rnd 3: Sc around (12)
Change color to pink.
Rnd 4: Sc around (12)
`;

describe('yarn colour picker', () => {
  it('lists the yarns the pattern is worked in', () => {
    const p = parsePattern(TWO_TONE);
    const ids = yarnsInUse(p).map((y) => y.id);
    expect(ids).toContain('white');
    expect(ids).toContain('pink');
  });

  it('applies picked colours for this pattern only, and remembers the originals', () => {
    const p = parsePattern(TWO_TONE);
    const orig = applyColorOverrides(p, { [patternKey(p)]: { pink: '#123456' }, other: { white: '#000000' } });
    expect(p.materials.yarns.find((y) => y.id === 'pink')!.color).toBe('#123456');
    expect(p.materials.yarns.find((y) => y.id === 'white')!.color).toBe(orig.get('white'));
    expect(orig.get('pink')).not.toBe('#123456');
  });

  it('ignores a stored colour that is not a hex colour', () => {
    const p = parsePattern(TWO_TONE);
    const orig = applyColorOverrides(p, { [patternKey(p)]: { pink: 'url(x)' } });
    expect(p.materials.yarns.find((y) => y.id === 'pink')!.color).toBe(orig.get('pink'));
  });

  it('tags every stitch with its yarn, so the 3D view can recolour it in place', () => {
    const p = parsePattern(TWO_TONE);
    applyColorOverrides(p, { [patternKey(p)]: { white: '#00ff00' } });
    const m = buildModel(p, { tension: 'normal' });
    const white = m.graph.nodes.filter((n) => n.yarn === 'white' && !n.virtual);
    expect(white.length).toBe(12);
    for (const n of white) expect(n.color).toBe('#00ff00');
    expect(m.graph.nodes.filter((n) => n.yarn === 'pink' && !n.virtual).length).toBe(12);
  });
});
