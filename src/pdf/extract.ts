import { layoutPages, type PageRuns } from './layout';

type PdfJs = typeof import('pdfjs-dist');

let lib: Promise<PdfJs> | null = null;

/** Lazy-load pdf.js (≈0.5 MB) only when the user imports a PDF. Everything stays on the device. */
async function pdfjs(): Promise<PdfJs> {
  if (!lib) {
    lib = (async () => {
      const m = await import('pdfjs-dist');
      const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
      m.GlobalWorkerOptions.workerSrc = worker.default;
      return m;
    })();
  }
  return lib;
}

export async function readPdfRuns(data: ArrayBuffer, lib?: PdfJs): Promise<{ pages: PageRuns[]; doc: any }> {
  const m = lib ?? (await pdfjs());
  const doc = await m.getDocument({ data: new Uint8Array(data) }).promise;
  const pages: PageRuns[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const runs = (tc.items as any[])
      .filter((it) => typeof it.str === 'string')
      .map((it) => ({ str: it.str as string, x: it.transform[4], y: vp.height - it.transform[5], w: it.width as number, size: Math.hypot(it.transform[0], it.transform[1]) }));
    pages.push({ runs, width: vp.width, height: vp.height });
  }
  return { pages, doc };
}

export async function importPdf(file: File) {
  const buf = await file.arrayBuffer();
  const { pages, doc } = await readPdfRuns(buf);
  const result = layoutPages(pages);
  return { ...result, doc };
}

/** Render a page thumbnail for the review step. */
export async function renderPage(doc: any, pageIndex: number, canvas: HTMLCanvasElement, width = 420) {
  const page = await doc.getPage(pageIndex + 1);
  const vp0 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: (width / vp0.width) * Math.min(2, window.devicePixelRatio || 1) });
  canvas.width = vp.width;
  canvas.height = vp.height;
  canvas.style.width = `${width}px`;
  await page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp, canvas }).promise;
}
