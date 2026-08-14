# Phase 5.4 — News visual evaluation

## Result

Phase 5.4 passes the engineering gate. Measurements were made locally on Windows with an NVIDIA GeForce RTX 5060 Ti, Gemma 4 12B, RapidOCR 3.9.2, and ONNX Runtime 1.28.0. Proxy download time is excluded. Source videos and extracted frames are not committed.

## Corpus and labels

The reviewed corpus contains 10 real news videos from BBC News, Reuters, CNBC Television, and SABC News. It covers studio presenters, interviews, mixed B-roll, product/financial reporting, quote cards, documents, lower thirds, headline graphics, and charts. The long case is a 998-second BBC remote panel.

Thirty-eight manually reviewed representative frames have a controlled scene label plus `ocrUseful` and `gemmaUseful`. The manifest records each source URL and review method.

## Raw scene result

```text
labels:     38
correct:    21
incorrect:  13
UNKNOWN:     4
```

These are raw corpus counts, not a population-level accuracy claim. The largest known confusion is presenter footage with dense lower thirds versus `TEXT_HEAVY`; the conservative fallback prevents an uncertain scene from being treated as a reusable anchor.

## OCR result

The previous Gemma OCR baseline was 7/12 useful. RapidOCR produced useful extraction on 10/12 challenge frames, so the result is `PASS`, not `OCR_GAP`.

```text
RapidOCR useful:             10/12
cold worker/engine start:    1,511 ms
warm mean wall time:           799 ms/frame
warm throughput:              1.25 frames/s
mean aggregate CPU time:     6,406 ms/frame
CPU-time / wall-time:         8.02 (multi-core ONNX execution)
observed OCR GPU delta:       0 MiB
multilingual spot check:      German Latin text useful
```

The two misses were a firearm title and a small handheld overlay. English lower thirds, a breaking-news headline, a prevention card, a news overlay, fast title, small UI, watermark, first-aid text, and a swimming label were useful. This is a small challenge set; it does not establish broad language coverage.

## Gemma call reduction and coverage

On the 38 manually reviewed corpus frames, generic inspection was 38 calls and the reviewed usefulness plan retained 11: a 71.1% reduction.

The stronger measured comparison ran the same 998-second video and 101 sampled frames through both routing strategies:

```text
Phase 5.1 generic route:       57 Gemma calls
Phase 5.4 optimized route:     19 Gemma calls
measured reduction:          66.7%
anchor-reuse skips:             74
OCR calls / useful:          39 / 39
deduplicated frames:             17
```

The optimized run still called Gemma for 14 scheduled presenter refreshes, five first presenter representatives after state changes, four possible graphic signals, and one B-roll transition. The label set marks all 11 meaningful B-roll frames as Gemma-useful in the reviewed plan; the optimization does not suppress those planned inspections.

## Runtime, safe windows, and memory

The real 998-second visual pass completed in 96,548 ms (1 minute 36.5 seconds), below the 2-minute target and above the preferred sub-60-second target. It sampled 101 frames, made 19 sequential Gemma calls and 39 CPU OCR calls, and completed without OOM.

VRAM rose from 2,765 MiB to a measured peak of 11,033 MiB. OCR itself showed 0 MiB GPU delta; Gemma owns the visual GPU budget and is unloaded at the end.

The neutral long-video control had 34 text-only safe windows. Both the generic visual route and optimized route preserved all 34; stable presenter footage did not destroy the safe run. This control contains no intentionally risky B-roll, so it demonstrates preservation, not risky-window recall. Risky OCR, missing material OCR, and visual findings have separate tests showing deterministic downgrade to `REVIEW`.

## Reliability gates

- Visual tests: 29/29 passed, including transitions, anchor reuse, OCR schema/deduplication, neutral and risky headlines, privacy patterns, document/screenshot/chart refinement, fallback, escalation, cancellation, and cleanup.
- Full repository tests: 152/152 passed.
- Electron portable build: passed; preflight verified bundled yt-dlp, Deno, and FFmpeg before packaging.
- OCR stayed CPU-only; Gemma ran sequentially and unloaded without OOM.
- Cancellation terminates the OCR worker and in-flight visual work; temporary media cleanup is tested on success and failure.

## Known gaps

- Raw scene classification is 21/38 with four `UNKNOWN`; rules need a broader labeled corpus before tighter calibration.
- RapidOCR missed 2/12 challenge frames and multilingual validation is only a basic German Latin-script spot check.
- The isolated Python environment is not embedded in the portable Electron artifact. Production packaging must provision it or set `VISUAL_OCR_PYTHON`.
- The 998-second measurement uses prepared neutral text judgments, so it is a visual-pass benchmark, not end-to-end download/transcription/Qwen wall time.
- Safe-window preservation was measured on a neutral long control; a larger corpus with reviewed risky B-roll windows remains production-hardening work.
