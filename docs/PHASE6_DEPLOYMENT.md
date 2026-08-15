# Phase 6 — Windows deployment

## OCR packaging decision

Two routes were evaluated:

- packaged Python runtime plus packages: simpler during development but exposes Python layout and dependency management to the installed app;
- frozen standalone worker directory: self-contained, faster startup than one-file extraction, no system Python, and a narrow executable boundary.

Phase 6 selects the frozen PyInstaller `onedir` worker. It contains only RapidOCR, ONNX Runtime CPU, OpenCV/Numpy dependencies, and three OCR models. Torch, TorchVision, TensorFlow, Transformers, Paddle, and TensorRT are explicitly excluded. The first unfiltered prototype was 4.69 GB; the accepted bundle is 256,247,957 bytes (244.4 MiB).

Approximate major components:

```text
OpenCV core                         86.3 MB
OpenCV video I/O                    30.9 MB
RapidOCR recognition model          21.2 MB
NumPy/OpenBLAS                      20.4 MB
ONNX Runtime Python binding         18.4 MB
ONNX Runtime                        17.8 MB
RapidOCR detection model             9.9 MB
RapidOCR classification model        0.6 MB
```

Frozen worker health/startup was 2.44 seconds on the evaluation machine; a real frame returned `FAST / CUT / EDITING` successfully. The prior Python environment cold start was 1.51 seconds. OCR remains CPU-only and showed 0 MiB GPU delta in Phase 5.4.

RapidOCR 3.9.2 is Apache-2.0 and ONNX Runtime 1.28.0 is MIT. `resources/ocr-licenses.txt` is copied into the bundle as `THIRD_PARTY_LICENSES.txt`. The app performs no runtime download.

## Building the worker

The frozen output is intentionally ignored by Git, matching the existing ignored yt-dlp/FFmpeg/Deno binaries. Build it on the Windows packaging machine:

```powershell
python -m venv .venv-visual
.\.venv-visual\Scripts\python.exe -m pip install -r requirements-visual.txt
npm run package:ocr
```

If the build-only PyInstaller tool is absent, explicitly run `scripts/package-ocr.ps1 -InstallBuilder`. Normal application execution never needs Python or PyInstaller.

`electron-builder` copies `resources/ocr/` to `resources/ocr/` beside `app.asar`. `RapidOcrProvider` prefers the packaged executable and falls back to the development venv only when the executable is absent. Build preflight launches `rapidocr-worker.exe --health`; packaging fails if it or its license file is missing.

## Doctor and fresh install

Run:

```powershell
npm run doctor
npm run build
npm run test:fresh-install -ArgumentList '-SkipNetwork'
```

Doctor reports Windows/RAM, GPU/VRAM, yt-dlp, FFmpeg, Deno, frozen OCR, Ollama, Qwen, Gemma, policy version, cache/report paths, and job-database status. Qwen/Gemma absence is a warning with the exact missing model; models are never installed automatically.

The fresh-install test starts the unpacked app with an isolated empty user-data directory and restricted `PATH`, then verifies writable runtime bootstrap, yt-dlp, FFmpeg, Deno, frozen OCR health, `app.asar` policy/config resources, persistent job database, and clear Qwen/Gemma status. Optional network mode also performs public metadata/download/media verification.

Final Phase 6 verification on Windows x64:

- application tests: 165 passed, 0 failed;
- doctor: every system, runtime, model, policy, database, cache, and report check passed;
- forced-crash recovery: database readable, interrupted job requeued, completed report preserved, temporary data cleaned;
- portable build: `dist/TikTok Policy Checker 1.0.0.exe`, 255,822,978 bytes;
- isolated fresh-install smoke test with restricted `PATH`: passed, including packaged OCR and fallback runtime bootstrap.

## Deployment boundary

The portable artifact contains every non-model dependency needed for normal execution. Qwen 3 14B and Gemma 4 12B remain externally managed by local Ollama. Reports default to indefinite retention; users must explicitly clear them or enable retention.
