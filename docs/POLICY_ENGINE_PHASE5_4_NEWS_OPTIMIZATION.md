# Phase 5.4 — News-specific visual optimization and OCR

## Scope

Phase 5.4 specializes the existing visual pass for news: presenter shots, interviews, B-roll, documents, screenshots, lower thirds, and charts. It does not add firearm-specific models, face identity, cloud OCR, fact checking, or a new UI.

## Pipeline

```text
transcript -> deterministic risk screen -> Qwen policy findings -> text decision
video proxy -> scene sampling -> news scene state -> RapidOCR CPU / Gemma when useful
spoken transcript + on-screen evidence -> deterministic multimodal merge
```

`NEWS_SCENE_TYPES` is limited to `ANCHOR`, `INTERVIEW`, `B_ROLL`, `DOCUMENT`, `SCREENSHOT`, `TEXT_HEAVY`, `CHART_GRAPHIC`, and `UNKNOWN`. Classification and OCR never issue a policy verdict.

The classifier combines scene cuts, perceptual-hash distance, lower-region overlay hashes, skin-region heuristics, edge/text density, and OCR structure. It uses no face identity. `UNKNOWN` keeps the conservative generic fallback.

## Scene state and routing

A scene state keeps its type, representative hash, overlay hash, OCR hash, state ID, and last semantic-review timestamp across adjacent transcript segments.

- Stable presenters receive an initial Gemma review and a refresh after 60 seconds.
- Perceptual duplicates and unchanged presenter states reuse the prior semantic confidence.
- New neutral captions/lower thirds are re-read by OCR but do not wake Gemma by themselves.
- B-roll, possible graphic/nudity signals, risky OCR, text findings requiring visual confirmation, and conservative `UNKNOWN` middle frames wake Gemma.
- Documents, screenshots, text-heavy cards, and charts are OCR-first. Ambiguous or unreadable material text becomes `REVIEW` instead of being assumed safe.
- State changes never replace transcript analysis; every transcript segment still follows the text policy path.

Each frame can record `whyGemmaCalled`, `whyGemmaSkipped`, and `whyOcrCalled`. Aggregate metrics include scene counts, segment counts, Gemma reuse/calls, OCR useful/duplicate counts, and visual runtime.

## OCR worker

Electron communicates with a long-lived Python JSON-lines worker in `services/visualRisk/ocr-worker.py`. The worker runs RapidOCR through ONNX Runtime on CPU and returns only timestamped lines, confidence, boxes, engine time, and CPU time. `PYTHONIOENCODING=utf-8` keeps multilingual output safe on Windows.

Install the isolated environment from the repository root:

```powershell
python -m venv .venv-visual
.\.venv-visual\Scripts\python.exe -m pip install -r requirements-visual.txt
```

The development default is `.venv-visual\Scripts\python.exe`. A packaged installation must provision Python separately and set `VISUAL_OCR_PYTHON`; the environment is intentionally excluded from Electron packaging. Missing OCR yields `ocrStatus = UNAVAILABLE`, while text and visual analysis continue.

RapidOCR 3.9.2 is Apache-2.0 licensed according to its [official repository](https://github.com/RapidAI/RapidOCR). ONNX Runtime 1.28.0 is the CPU runtime. No paid or cloud API is used.

## OCR evidence and policy retrieval

OCR lines are confidence-filtered, whitespace-normalized, line-deduplicated, capped, hashed, and suppressed when a normalized overlay repeats. `spokenTranscript` and `onScreenText` remain separate evidence sources.

The deterministic prefilter keeps ordinary names, locations, dates, watermarks, and sensitive-topic news headlines neutral. Direct threats, actionable harmful language, and conservative email/phone/address/account-ID patterns can enter policy retrieval. Retrieved policy IDs stay attached to on-screen evidence. OCR privacy evidence can require review but cannot automatically remove content.

## Lifecycle

Abort propagates through scene extraction, frame extraction, OCR, and Gemma. Aborting OCR terminates its worker and rejects pending requests. The existing visual-media lifecycle deletes raw frames, JPEGs, proxy media, and stale analysis directories on success, failure, cancel, and restart cleanup. Gemma is unloaded after the visual pass; OCR stays CPU-only and is closed.

## Reproduction

Real media is not committed. Put the reviewed proxies in the local directories described by the environment variables, then run:

```powershell
$env:NEWS_VISUAL_PROXY_DIR='C:\absolute\news-proxies'
$env:VISUAL_STRESS_PROXY_DIR='C:\absolute\phase5-1-proxies'
npm run benchmark:visual:news
```

The corpus labels are in `test/news-visual/manifest.json`; machine-readable results are in `docs/evidence/phase5-4-news-results.json`.
