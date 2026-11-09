# Rules-only reader vs rules + small local AI

`cases.ts` holds 50 written-out lines (40 rounds, 10 flat rows) that the phrase rules were never
tuned on, each with the short syntax a crocheter would write (`gold`). Two lines use special
stitches the app can't draw, so the right answer for them is to flag the line.

A line's outcome:
- **right**: read with no warning, and it makes the same stitches as the gold answer
  (same stitch kinds and loops, same number of increases and decreases, every stitch worked).
- **wrong-accepted**: read with no warning, but the stitches are wrong. This is the bad case:
  the user isn't told.
- **flagged**: the app asks the user to look at the line.

The AI is only asked about lines the rules flag (as in the app), its answer is put on the line
as `=> …`, and it is used only when it passes the checks. Up to 3 tries, greedy decoding.

```
npx vitest run -c eval/vitest.config.ts eval/gold.eval.ts eval/guard.eval.ts   # sanity checks
NODE_USE_ENV_PROXY=1 ALONE=0 MODELS="onnx-community/Qwen3-0.6B-ONNX:quantized" OUT=name \
  npx vitest run -c eval/vitest.config.ts eval/compare.eval.ts                  # one model
python3 eval/show.py eval/results/name.json
```

## Results on the parser from PR #18 (`results/pr18-*.json`)

| Reader | Download | Right | Wrong, not flagged | Flagged | Time per try (CPU) |
|---|---|---|---|---|---|
| Rules only | 0 | 29 | 2 | 19 | – |
| Rules + second check (no AI) | 0 | 29 | **0** | 21 | – |
| + Qwen 3 0.6B int8 | 618 MB | **34** | 0 | 16 | 3.9 s |
| + Qwen 3 0.6B q4 (q4f16 on WebGPU: 570 MB) | 919 MB | 33 | 0 | 17 | 3.5 s |
| + Qwen 3 1.7B q4 (q4f16: 1.4 GB) | 2.1 GB | 32 | 0 | 18 | 7.0 s |
| + Qwen 2.5 0.5B q4 (q4f16: 483 MB) | 786 MB | 30 | 0 | 20 | 2.6 s |
| + LFM 2.5 350M q4 | 294 MB | 30 | 0 | 20 | 1.0 s |
| + Gemma 3 270M q4 | 323 MB | 29 | 0 | 21 | 1.8 s |
| + SmolLM2 360M q4 | 388 MB | 29 | 1 | 20 | 2.2 s |

(The AI rows include the second check; the two "wrong" lines of the rules reader are flagged by it.)

Without the second check (results on main before PR #18, `results/*.json` without `guard-`),
every model made things worse: each fixed 1–3 lines but slipped 4–14 wrong answers past the
stitch count check, mostly "18 sc (18)" for any line that keeps the count (puff stitches,
mixed sc/dc rows, BLO added from nowhere).

The model on its own, with the checks but without the rules, reads 10 of 50 lines
(`guard-alone-Qwen3-0.6B.json`). The rules read 29.
