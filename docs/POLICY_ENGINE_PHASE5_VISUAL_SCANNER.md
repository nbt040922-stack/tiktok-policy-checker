# Phase 5 - Local Visual Risk Scanner

## Status

PASS. Visual analysis stays local, uses no paid API, and never gives a model authority to choose KEEP, REVIEW, or REMOVE.

## Pipeline

```text
YouTube subtitles and text policy pass
  -> temporary 360p video-only proxy
  -> FFmpeg scene cuts and 2/3/4 frame sampling
  -> RGB cheap signals and perceptual deduplication
  -> escalation-only Gemma 4 findings/OCR
  -> deterministic multimodal policy mapping
  -> temporary proxy and frames deleted
```

The proxy is downloaded only after the transcript/text pass. It uses the existing authenticated yt-dlp runtime and is deleted on success, error, cancellation, a newer analysis, and app shutdown. Startup removes stale `analysis-*` directories left by a crash.

## Models and licenses

- Gemma 4 12B through local Ollama: multimodal image-to-text findings and selective OCR. The installed model reports Apache-2.0, matching the [official Gemma 4 model card](https://ai.google.dev/gemma/docs/core/model_card_4).
- FFmpeg 8.1.2: proxy decoding, scene-score detection, and frame extraction. The bundled build's exact component licenses remain governed by its own binary distribution.
- No YOLO or dedicated nudity package was added. The installed Gemma model plus deterministic RGB signals covers the Phase 5 baseline without another dependency or resident GPU model.

The application never installs a visual model. Missing setup is reported as `VISUAL_MODEL_NOT_INSTALLED` with the manual command:

```powershell
ollama pull gemma4:12b
```

## GPU scheduling

Qwen3-14B is unloaded before the first Gemma escalation. Gemma is unloaded after the visual pass. The two large models are not intentionally kept resident together. Measured visual peak on the RTX 5060 Ti 16GB was 10,922 MiB with no OOM.

## Sampling and deduplication

- Segment up to 15 seconds: 2 frames.
- Segment 15-30 seconds: 3 frames.
- Segment 30-45 seconds: 4 frames.
- Planned early/middle/late positions prefer a scene cut within 2.5 seconds.
- Frame analysis uses the full 360p proxy size, 640x360 RGB.
- A 64-bit difference hash deduplicates frames within Hamming distance 7 across the video.
- The middle representative of each new segment is the baseline VLM sample. Cheap signals, text-policy visual uncertainty, and relevant text categories can escalate additional frames.

## Cheap signals and thresholds

| Signal | Threshold | Effect |
| --- | ---: | --- |
| FFmpeg scene score | 0.32 | Prefer changed scenes |
| Red-region ratio | 0.10 | Escalation only |
| Skin-like ratio | 0.58 | Escalation only |
| Edge density | 0.24 | Escalation only |
| Text-edge density | 0.015 | Selective OCR/VLM escalation |
| Detector uncertainty confidence | 0.58 | REVIEW when VLM is unavailable |
| Visual policy confidence | 0.85 | Required for deterministic prohibited mapping |

Red, skin, and edge signals never directly declare a violation. Tomato, clothing, tools, or skin-like color can trigger inspection but cannot directly cause REMOVE.

## Findings and deterministic merge

The controlled visual taxonomy is `weapon`, `blood`, `graphic_injury`, `nudity`, `sexual_content`, `violent_act`, `self_harm_visual`, `drug_or_regulated_goods`, `personal_information`, `shocking_content`, and `on_screen_text_risk`.

Gemma returns category, applicability, confidence, severity, detail, and `requiresHumanReview`, plus deduplicated on-screen risk text. Its schema has no verdict field. Findings are mapped to reviewed TikTok policy IDs by the deterministic engine. Uncertain visuals become REVIEW; high-confidence severe prohibited evidence can become REMOVE; news, documentary, educational, medical, prevention, and recovery context prevents an automatic visual REMOVE and remains REVIEW where visual restrictions still apply.

Verdicts include `decisionSource: MULTIMODAL_POLICY_ENGINE` and separate text/visual evidence. The existing UI labels `REVIEW - Visual Risk` separately from text/policy context without a redesign.

## Cache, privacy, and failure

Visual cache keys include video ID, timestamp, perceptual frame hash, detector version, model version, and threshold version. Cache content is findings only. Frames, OCR, and transcript content are not telemetry and are never uploaded.

If proxy extraction or visual inference fails, the text pipeline still returns with `visualStatus: UNAVAILABLE`. A segment that still requires visual verification remains REVIEW. New requests abort proxy download, FFmpeg extraction, and Ollama inference; renderer request guards reject stale results.

## Known limits

The RGB prefilter is a trigger, not an object detector. Small or brief objects can be missed between samples. Difference hashing can treat a small local change as a duplicate. OCR is handled by the VLM rather than dedicated Tesseract in this baseline. No face/identity recognition, full-video understanding, thumbnails, automatic censorship, blur, cut, or export is implemented.
