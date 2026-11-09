# Architecture and Code Navigation

Crochet 3D is a browser-only TypeScript application. It turns written crochet instructions into a structured pattern, a stitch graph, and a solved 3D preview:

```text
pattern text or PDF
  -> normalized text and parsed pattern
  -> sized stitch graph
  -> seeded mesh and solver input
  -> Web Worker relaxation
  -> three.js scene and editor outline
```

The app does not send patterns to a server. Parsing is rule-based; the source text remains the input of record, with line and text spans retained for diagnostics and navigation.

## Start here

| If the task is about... | Start with... |
|---|---|
| Application behavior, UI events, editing loop | [`src/main.ts`](../src/main.ts) |
| Pattern syntax, parsing, or count diagnostics | [`src/parser/`](../src/parser/) |
| Shared pattern data structures | [`src/model/types.ts`](../src/model/types.ts) |
| Stitch relationships and piece construction | [`src/graph/build.ts`](../src/graph/build.ts) |
| Sizing, mesh generation, placement, or solving | [`src/geometry/`](../src/geometry/) |
| WebGL rendering, yarn appearance, or picking | [`src/render/`](../src/render/) |
| Pattern outline, tour, or yarn-color UI | [`src/ui/`](../src/ui/) |
| PDF text extraction and reading order | [`src/pdf/`](../src/pdf/) |
| A single hand-built stitch strand demonstration | [`src/strand-demo.ts`](../src/strand-demo.ts) |
| Expected behavior and regression coverage | [`tests/`](../tests/) |

## Runtime flow

1. [`index.html`](../index.html) supplies the main editor and preview UI. [`src/main.ts`](../src/main.ts) wires the editor, file import, materials, outline, tour, and renderer together.
2. Text changes are parsed by [`src/parser/parse.ts`](../src/parser/parse.ts). The parser uses [`normalize.ts`](../src/parser/normalize.ts) for terminology and shorthand, [`row.ts`](../src/parser/row.ts) for row instructions and stitch counts, and [`consistency.ts`](../src/parser/consistency.ts) to compare plausible readings with stated counts.
3. The parser produces the shared `Pattern` model in [`src/model/types.ts`](../src/model/types.ts). Reference data such as stitch phrases, yarn fibers, and colors lives in [`src/model/dictionary.ts`](../src/model/dictionary.ts).
4. [`src/geometry/pipeline.ts`](../src/geometry/pipeline.ts) coordinates sizing, graph construction, initial placement, triangulation, and solver input. [`src/graph/build.ts`](../src/graph/build.ts) creates stitch nodes and yarn/into/ring/join/seam relationships.
5. Geometry responsibilities are split across [`sizing.ts`](../src/geometry/sizing.ts), [`seed.ts`](../src/geometry/seed.ts), [`mesh.ts`](../src/geometry/mesh.ts), and [`solver.ts`](../src/geometry/solver.ts). The solver runs in [`solver.worker.ts`](../src/geometry/solver.worker.ts), keeping iterative relaxation off the UI thread.
6. [`src/render/scene.ts`](../src/render/scene.ts) displays and updates the model with three.js. [`textures.ts`](../src/render/textures.ts) and [`yarn3d.ts`](../src/render/yarn3d.ts) implement yarn appearance and stitch detail.
7. UI helpers in [`src/ui/`](../src/ui/) render the pattern outline, guided tour, and yarn color controls. Stitch/source line mappings let the user navigate between the preview and the text.

### PDF import

[`src/pdf/extract.ts`](../src/pdf/extract.ts) lazily loads pdf.js, extracts positioned text runs in the browser, and renders review thumbnails. [`src/pdf/layout.ts`](../src/pdf/layout.ts) reconstructs rows and columns as editable pattern text. Imported text follows the same parser path as typed text.

## Repository map

- [`src/`](../src/) — application, parser, model, graph, geometry, PDF, rendering, and UI code.
- [`tests/`](../tests/) — Vitest coverage for parser behavior, phrasings, PDF layout, geometry, and yarn colors. [`held-out-cases.ts`](../tests/held-out-cases.ts) and [`held-out-score.ts`](../tests/held-out-score.ts) support held-out parser evaluation.
- [`fixtures/`](../fixtures/) — original example patterns used by the app and tests. Do not add copyrighted third-party patterns; see [README.md](../README.md) for the private-fixture convention.
- [`docs/yarn-tension-texture.md`](yarn-tension-texture.md) — design notes on how yarn and tension affect appearance.
- [`index.html`](../index.html) and [`strand.html`](../strand.html) — Vite entry pages. `strand.html` is a focused, hand-authored rendering demo and does not use the parser or solver.
- [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) — CI runs typecheck, tests, and build. [`.github/workflows/pages.yml`](../.github/workflows/pages.yml) — GitHub Pages deployment.

## Development and validation

Use the scripts in [`package.json`](../package.json):

```bash
npm run dev
npm test
npm run typecheck
npm run build
```

For parser changes, add focused tests to the relevant parser test file and run `npm test`. For rendering or geometry changes, add or update geometry tests and run `npm test`, `npm run typecheck`, and `npm run build` when bundling or worker behavior is affected.
