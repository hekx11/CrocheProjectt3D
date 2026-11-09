# AI Navigation

Start with [README.md](README.md) for user-facing behavior, setup, and the high-level pipeline. Use [docs/architecture.md](docs/architecture.md) to find implementation entry points and trace data flow.

## Working in this repository

- Keep changes focused and follow the existing TypeScript patterns. The project uses strict TypeScript and browser-side code; check `tsconfig.json` before changing types or runtime assumptions.
- The pattern text is the source of truth. Parsing, normalization, count checking, and geometry are deterministic code; do not introduce an AI service or network dependency into pattern processing.
- When changing parsing or geometry behavior, add or update tests using small synthetic cases or the existing fixtures. Protect user-provided pattern text and preserve source-line information for diagnostics and editor navigation.
- Run the narrow relevant test(s), then `npm run typecheck` and `npm test` as appropriate. Run `npm run build` for changes that affect bundling, workers, or app entry points.
- Keep imported patterns local to the browser. Do not commit copyrighted third-party patterns; use original synthetic cases in tests. See [README.md](README.md) for the private fixture convention.
- Update the architecture map or README when a change makes their descriptions or navigation links inaccurate.

## Commands

- `npm run dev` — start the Vite development server.
- `npm test` — run the Vitest suite.
- `npm run typecheck` — run TypeScript without emitting files.
- `npm run build` — build both Vite entry points for static hosting.
