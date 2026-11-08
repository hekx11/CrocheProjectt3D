import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { layoutPages } from '../src/pdf/layout';
import { parsePattern } from '../src/parser/parse';

const pdf = new URL('../fixtures/private/lil-big-cig.pdf', import.meta.url);

describe('PDF layout', () => {
  it('pairs a row-number column with its instructions', () => {
    const run = (str: string, x: number, y: number, size = 12) => ({ str, x, y, w: str.length * 6, size });
    const page = {
      width: 612, height: 792,
      runs: [
        run('My Pattern', 72, 60, 30),
        run('Body', 250, 120, 14),
        run('1', 120, 150), run('6 sc in MR', 200, 150),
        run('2', 120, 180), run('inc x6 [12]', 200, 180),
        run('3 - 5', 114, 210), run('sc around [12]', 200, 210),
      ],
    };
    const r = layoutPages([page]);
    expect(r.text).toContain('Rnd 1: 6 sc in MR');
    expect(r.text).toContain('Rnds 3-5: sc around [12]');
    expect(r.rows).toBe(3);
  });

  it.skipIf(!existsSync(pdf))('imports Lil Big Cig end to end (private fixture)', async () => {
    const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const { readPdfRuns } = await import('../src/pdf/extract');
    const buf = readFileSync(pdf);
    const { pages } = await readPdfRuns(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), lib as any);
    const r = layoutPages(pages);
    const p = parsePattern(r.text);
    expect(p.pieces).toHaveLength(1);
    expect(p.pieces[0].rows).toHaveLength(47);
    expect(p.pieces[0].markers.map((m) => [m.kind, m.rowA])).toEqual([['safety-eyes', 23], ['embroidery', 22]]);
    expect(p.diagnostics.filter((d) => d.severity !== 'info')).toEqual([]);
  });
});
