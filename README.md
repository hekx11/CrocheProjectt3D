# Crochet 3D

Type a crochet pattern, or import a pattern PDF, and watch it take shape in 3D as you write.
Everything runs in your browser: no server, no upload, no account.

## What it does

- **Live 3D preview.** The pattern is re-read about 150 ms after you stop typing. Only the stitches that changed move.
- **Reads real pattern wording**:
  - shorthand like `Rnd 3: (sc, inc) x6 (18)`
  - sentences like `Ch 3 (counts as first dc), work 11 dc into the ring, join with a sl st to the top of the beginning ch-3. (12 dc)`
  - repeats written as `*…; rep from * around`, ranges like `Rnds 5-10:`, BLO/FLO, colour changes, "loose"/"tight", UK terms.
- **Checks stitch counts.** A count in brackets is compared with what the instructions produce. Lines are marked:
  - *ok*
  - *assumption* (hover to see what was assumed)
  - *count mismatch*
  - *unreadable*
- **Pieces worked in rounds, flat rows and joined rounds**, plus patterns made of several pieces that are sewn together (`EARS (make 2)` … `sew them to the top of the head between Rnds 3 and 6`).
- **Markers.** Safety eyes, embroidery, stuffing and flattening are placed from the instructions.
- **Real size.** Stitch size comes from the best source available:
  1. your own gauge
  2. the gauge stated in the pattern
  3. the stated finished size
  4. hook + yarn weight
  5. yarn-weight defaults

  Your tension (tight, normal or loose) is taken into account, and the yarn (chenille, cotton, wool…) changes how it looks.
- **PDF import.** The text is read with pdf.js, the row-number and instruction columns are paired back up, and you review the result before it is used.
- **Clarify a line yourself.** Add `=> <short syntax>` after a line the parser can't read, e.g. `Make the round loosely as before => 18 slst blo loose`.
- **Or ask AI (optional).** On a flagged line, *Ask AI* has Claude propose the `=> …` short syntax. The app re-parses it and checks the stitch count before you choose to use it. It uses your own Anthropic API key, called straight from your browser (set it under *AI helper*). Only that line and a few lines around it are sent. The key stays in memory unless you tick "remember". Without a key the app works exactly as before.

## Develop

```bash
npm install
npm run dev        # http://localhost:5173/CrocheProjectt3D/
npm test           # parser tests on the corpus in fixtures/
npm run typecheck
npm run build      # static site in dist/
```

Real third-party patterns are copyrighted, so never commit them. Put them in `fixtures/private/`, which git ignores, and the tests pick them up locally.

## Deploy

`.github/workflows/pages.yml` builds and deploys to GitHub Pages on every push to `main`. In the repository settings, go to Pages → Source and select **GitHub Actions**.

## How it works

`text → pattern model → stitch graph → 3D`

| Stage | Code |
|---|---|
| Parser (normalise → phrase grammar → count check) | `src/parser/` |
| Pattern model types | `src/model/` |
| Stitch graph (one node per stitch; yarn/into/ring/join/seam edges) | `src/graph/` |
| Stitch size from yarn, hook, tension and gauge | `src/geometry/sizing.ts` |
| Analytic seed + placement of sewn pieces | `src/geometry/seed.ts` |
| Position-based relaxation in a Web Worker | `src/geometry/solver.ts` |
| three.js rendering, procedural stitch normal map | `src/render/` |
| PDF text layout → pattern text | `src/pdf/` |

The design decisions behind each part are tracked as GitHub issues under the map issue (#1).
