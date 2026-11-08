# Yarn, tension and texture (v1)

Resolution of "Decide how yarn, tension and texture shape the model" (GitHub #12). Based on the research in `research/gauge-and-tension.md`. choco asked for the best options and for Claude to proceed. This document **supersedes the placeholder numbers** in `spec/pattern-model.md` and `spec/written-instructions.md`, which were tension 1.2/0.85 and the height classes.

## 1. Stitch size: where it comes from (highest priority first)

| # | Source | How |
|---|---|---|
| 1 | **User's own gauge** (a settings panel: "my gauge with this yarn") | Used directly. Saved per yarn and hook in the browser, so it's reused across patterns |
| 2 | **Gauge stated in the pattern** | grid: `w = span / stitches`, `h = span / rows`. Diameter: `w = πD / stitches`, `h = D / (2·rounds)`. Converted to sc via the height ratios when the gauge isn't in sc. US/UK terms come from #8 |
| 3 | **Finished size + counts** (fit) | `w = π(D − t) / stitchesAround`, `h = length / Σ rowHeights`, where t is the fabric thickness (≈ sc height × 0.6). Shown as "calibrated from finished size" |
| 4 | **Hook + yarn weight** | `w_sc = 0.8·(hook + Δtension) + 1.4·d_yarn` with `d_yarn = loft·25.4/WPI`, `h_sc = 0.85·w_sc` (research fit) |
| 5 | **Yarn weight only** | Craft Yarn Council default table (below). For amigurumi, the hook defaults to the label hook − 1.5 mm |
| 6 | **Nothing** | Weight 4 with a 4 mm hook (amigurumi default) |

The UI always shows which source is in use ("size from: finished size 12.5″ × 2.5″") and lets the user override it.

**Default sc size by yarn weight** (width × height in mm):

| Weight | Default hook | sc (mm) |
|---|---|---|
| 0 lace/thread | 1.75 | 2.5 × 2.1 |
| 1 super fine | 2.75 | 3.8 × 3.2 |
| 2 fine | 4.0 | 5.6 × 4.8 |
| 3 light | 5.0 | 6.9 × 5.9 |
| 4 medium | 5.5 | 8.0 × 6.8 |
| 5 bulky | 7.5 | 10.5 × 8.9 |
| 6 super bulky | 10 | 12.5 × 10.6 |
| 7 jumbo | 15 | 18 × 15 |

**Height relative to sc:** ch length 0.75 (as width), sl st 0.35, sc 1, hdc 1.4, dc 1.9, tr 2.6, dtr 3.3.

**Lil Big Cig check:** 18 sts around, D = 63.5 mm, L = 317.5 mm, 47 rounds (2 of them sl st rounds) gives sc ≈ 10–11 mm wide × ≈ 7.0 mm tall, a height/width ratio of ≈ 0.65. Chenille is squat compared with the 0.85 default, which is why source 3 beats source 4/5 when a finished size is given. **Acceptance:** the rendered Lil Big Cig is within ±10% of 12.5″ × 2.5″.

## 2. Tension

- **Crocheter tension (per user or per project):** tight, normal or loose, modeled as an **effective hook change**: tight −0.75 mm, loose +0.5 mm (PlanetJune's test: tight tension ≈ a hook 0.75 mm smaller). This only affects sources 4–6. Sources 1–3 already include the maker's tension.
- **Per-stitch tension from the text** ("loose sl st", "work loosely", "tightly"): this is a factor on the stitch's own size, not the hook. A loose sl st round is **width 1.0 × sc, height 0.5 × sc** (vs 0.35 normally). Other "loose" stitches get × 1.15, and "tight" stitches × 0.9.
- **Loop choice:** FLO makes rows ≈ 12% taller. BLO keeps the height, adds a ridge on the outside, and makes the fabric fold toward the ridge. That's why a BLO round on a tube makes a crisp edge, which is how the Lil Big Cig's color joins should look.
- **Stiffness** (for the solver, #9): bending stiffness ∝ (d_yarn / w_sc)², so thick yarn on a small hook gives stiff fabric that holds its shape and resists puckering. Fiber factors: cotton 1.2, acrylic 1.0, wool 0.9, chenille 0.7, mohair 0.6. These are first guesses, to tune by eye on the corpus.

## 3. Texture (look)

- **v1 base:** the solved surface is rendered as a smooth mesh with a **material per yarn**: color, roughness, plus three.js `MeshPhysicalMaterial` *sheen* for chenille, velvet and mohair-type fuzz. Fiber presets: cotton (matte, crisp), acrylic (slight sheen), wool (soft, fuzzy rim), chenille (high sheen, very soft and plush), mohair (halo).
- **Stitch texture:** each stitch type has a tileable **normal map** (sc "V", hdc, dc posts, sl st) mapped with UVs from (stitch index, row index) of the stitch graph, so the texture follows the real stitch layout, increases and decreases included. BLO/FLO ridges are real geometry: the free loop is rendered as a thin raised strip along the row.
- **Color changes** follow the stitch graph exactly, including the small "jog" that spiral rounds produce. For a jogless join, the user can switch to joined rounds.
- **Fuzzy yarns** (chenille, mohair) visually soften the stitch definition. The normal-map strength scales down with a fiber "fuzz" value, so chenille looks plush rather than sharply stitched.
- **v1.1:** at close zoom, swap to instanced stitch geometry, i.e. little yarn loops per stitch (like the stitch-mesh approach in #4).

### 3.1 How a stitch is formed, and what that means for the model

These rules come from how the stitch is physically made (the beginner's guide choco shared: insert the hook, yarn over, pull up a loop, yarn over, pull through). They are illustrated by choco's amigurumi photos. The renderer builds stitches from these rules, not by tuning values by eye.

1. **Each stitch is a loop pulled up through the stitch below.** For sc, the hook goes under both top loops of the stitch below, a loop is pulled up, then closed with a yarn-over pulled through both loops on the hook.
2. **On the right side, an sc shows as a small "v" of two legs.** The legs are the two strands of the pulled-up loop. The point of the v is where the hook went into the row below, and the arms reach up to this stitch's own top. One stitch is one v, about one stitch wide and one row tall.
3. **Spiral rounds skew the v.** Each stitch sits on the one below it, shifted a little in the working direction. The stitches stack in slightly slanted columns, not as bricks, and each v is skewed: one leg leans hard and the other stands almost upright. Up close, this gives amigurumi its "rows of grains" look.
4. **Top loops form a chain along the top edge.** The front and back loops run along the top of each row. On the right side only the front loop peeks out, as a thin bar mostly hidden under the next row's legs. Working BLO leaves the front loops free, so they show as a raised ring of loops in the lower round's colour (Lil Big Cig colour joins, bear snout edge).
5. **Amigurumi is worked tight.** The yarn is fat compared with the stitch, because the hook is smaller than the yarn label suggests. Legs press against the neighbouring legs and against the next row. **No filler fabric sits between stitches:** the only gaps are small real holes where four stitches meet. The stuffing behind is polyester fibre, so those holes read as small dark spots, and the stuffing doesn't escape because the fabric is so tight.
6. **The strand itself carries the yarn's look:** ply twist (cotton, acrylic, milk cotton, wool), velvet pile (chenille, velvet), or a fibre halo (mohair). For thick unplied yarns (chenille, velvet), the two legs merge into one rounded "pebble" with a soft dent where the v splits.
7. **Taller stitches (later):** hdc and dc have a longer post with yarn-over wraps that show as diagonal bars across it. These aren't modelled yet; for now they reuse the sc v, stretched to the stitch height.

**Yarn presets** (`src/render/textures.ts`, `YARN_LOOKS`): cotton (crisp, matte, visible 4-ply), milk cotton (plump, soft, faint sheen, light fuzz; very common for amigurumi), acrylic (smooth, slight sheen, a touch of fuzz), wool (soft, fuzzy), chenille/velvet (plush pebbles, sheen), mohair (halo).

**Rendering:** each stitch-graph triangle is split 5×5 with Phong tessellation, then displaced by the stitch height map, so the outline is really bumpy. The height field also gives a normal map and a cavity map, where only the real holes go dark. Fuzz shells are layered on top for fuzzy yarns.

## 4. Inputs

- **From the pattern** (#8 classifies the material and gauge lines): hook mm, yarn weight number or name ("weight 6", "super bulky", "DK", "worsted"), fiber words ("chenille", "cotton"), colors per section, gauge, finished size.
- **From the user** (a Materials panel, pre-filled from the pattern): any of the above, plus their tension and saved gauges.
- **Calibration memory:** when source 3 produced a fit, offer "save as my gauge for this yarn".

## 5. What the parser must recognize (adds to #8)

Gauge formats from the research:
- "12 sc and 15 rows = 4″ [10 cm]"
- "24 tr x 13 rows = 10 x 10 cm" (UK terms)
- "11 sts = 4 in in sc"
- "Rounds 1–3 = 1 3/8″ diameter"
- "Gauge is not critical / not essential for this project"
- gauge given in a stitch pattern (then use the stitch pattern's mix to convert)
- fractional rows, and "held double" (strands × 2 → treat as a heavier weight)

"10 ch = x cm" style gauges were not found in real patterns. They're supported as a stitches-only gauge (chain length = 0.75 × sc width), but not prioritized.
