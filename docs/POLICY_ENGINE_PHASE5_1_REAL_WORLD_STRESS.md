# Phase 5.1 Real-World Visual Stress Test

## Phase 5.1 status

**FAIL — MODEL_GAP.** The evaluation work is complete, but the production acceptance target is not met. Gemma missed both reviewed weapon frames after they were sent directly to the model: a small circled handgun in bodycam/news footage at 660 seconds and a clear handgun demonstration at 113 seconds. Both source events last longer than two seconds. No new model or dependency was added.

There was no catastrophic false REMOVE, no OOM, and the calibrated 17.9-minute visual pass remained under three minutes.

## Corpus

The checked-in manifest is `test/real-world-visual/manifest.json`. It contains 14 public YouTube sources totaling 7,033 seconds (117.2 minutes). Full source media and contact sheets are not committed. Labels describe visible evidence for engineering evaluation; they are not official TikTok decisions.

| Source | Seconds | Main challenges |
| --- | ---: | --- |
| Google Developers | 1,344 | Talking head, software UI, dense text |
| BBC News | 273 | Political/news, rapid cuts, overlays |
| WHO | 47 | Prevention animation |
| KTNV/LVMPD briefing | 1,076 | News, bodycam, small weapon, low light |
| Seattle Police | 569 | Shaky bodycam arrest footage |
| GLOCK safety video | 145 | Clear and brief weapon presence |
| NASA action camera | 91 | Motion and high contrast |
| Crowd stock footage | 884 | Crowds, day/night, repetition |
| Smartphone tutorial | 565 | Handheld motion and overlays |
| Fast-cut tutorial | 196 | Sub-second cuts and titles |
| OBS tutorial | 1,152 | Dense/small/multilingual text |
| ISS night timelapse | 351 | Low light and compression |
| Raffles first aid | 54 | Small minor injury and medical context |
| Masters swimming | 286 | Swimwear, skin exposure, underwater text |

Human review used 12-frame contact sheets for every source and 0.5–1 fps fine sheets around the bodycam weapon, firearm demonstration, and minor injury. Timestamp windows cover known risk, clean material, transitions, likely dedupe collisions, and false-positive candidates.

## Visual challenges

The corpus covers frequent cuts, news and political footage, two bodycam sources, two weapon windows, a minor injury, swimwear/skin exposure, crowds, rapid motion, camera shake, low light, small objects, partial/poor visibility, compression, large and small text, and English plus Japanese font samples. It intentionally contains no unnecessary gore or explicit nudity.

The proxy acquisition trial exposed HTTP 403 failures in 6 of the first 12 candidates when the visual path requested video-only/remote-component formats. The smallest supported correction changed the selector to progressive format 18 first, disabled the unnecessary JS remote component for proxy downloads, and retained 360p fallbacks. All 14 final corpus proxies were acquired; one persistently unavailable Reuters candidate was replaced with the public GLOCK safety source.

## Scene-cut and sampling results

At `sceneThreshold = 0.32`, FFmpeg found 501 cuts across the corpus. The rate varied as expected: 63 cuts in the 196-second fast-cut tutorial, 98 in the 565-second handheld tutorial, but only 2 in 569 seconds of continuous Seattle bodycam and 11 in the 1,076-second briefing/bodycam source. The threshold is useful for edits, but is not a motion detector.

| Sampling profile | Planned/extracted frames | Reviewed target windows hit | Brief windows hit |
| --- | ---: | ---: | ---: |
| Current 2/3/4 + scene preference | 1,065 | 20/20 | 6/6 |
| Aggressive 3/5/7 + scene preference | 1,771 | 20/20 | 6/6 |

Aggressive sampling adds 706 frames (66.3%) without improving recall on this limited reviewed set. The scene preference rescued the 111–115 second GLOCK event that regular interval positions alone would miss. The default sampling density remains 2/3/4. Review windows are sparse, so these raw counts must not be presented as population recall.

The 1,065 baseline frame extractions and cheap scans took 186,968 ms across the 117.2-minute corpus. Per-video scene-cut, extraction, and scan measurements are retained in `docs/evidence/phase5-1-real-world-results.json`.

## Dedupe results and calibration

“Risk label transitions” count cases where the current timestamp enters a differently labeled human-review window but its dHash matches an earlier representative. This is a conservative collision indicator, not a claim that every collision becomes an end-to-end false negative.

| Hamming threshold | Retained | Removed | Risk-label transitions lost | Cheap VLM candidates |
| ---: | ---: | ---: | ---: | ---: |
| 4 | 907 | 158 | 5 | 200 |
| 7 (before) | 808 | 257 | 11 | 164 |
| 10 | 728 | 337 | 14 | 137 |

Threshold 4 reduces collision indicators by 6 versus threshold 7 for 36 additional cheap-signal VLM candidates across almost two hours. The default is therefore calibrated from 7 to 4 and `thresholdVersion` is advanced to `visual-thresholds-v2`, invalidating incompatible cache entries.

On the real 17.9-minute source, the before/after measurement was:

| Metric | Hamming 7 | Hamming 4 |
| --- | ---: | ---: |
| Runtime | 105,863 ms | 141,805 ms |
| Frames sampled | 162 | 162 |
| Frames deduplicated | 70 | 43 |
| Frames cheap-scanned | 92 | 119 |
| VLM calls | 45 | 57 |
| Under 180-second target | Yes | Yes |

## Escalation rate

Before production dedupe, cheap signals fired on 269/1,065 real frames (25.3%). This is a routing signal, not visual precision. At Hamming 4 on the long real source, 57/119 representatives were escalated (47.9%), including mandatory middle representatives; at Hamming 7 the corresponding result was 45/92 (48.9%).

Cheap signals did not fire on the small bodycam weapon at 660 seconds. The clear GLOCK frame fired only because skin coverage crossed `possibleNudity`, demonstrating that these signals cannot replace VLM evidence. No cheap threshold was changed.

## VLM latency

An isolated cold Gemma call after unload took 8,904 ms. In the 19 selected reviewed calls, the first already-warm call took 1,618 ms, warm mean was 2,454 ms, p50 was 1,714 ms, p95 was 5,336 ms, and total inference time was 45,796 ms. Per-video call counts and totals are stored in the evidence JSON.

## VRAM and scheduling

An isolated scheduling probe measured:

| State | GPU memory |
| --- | ---: |
| Unloaded baseline | 2,643 MiB |
| Qwen loaded | 11,837 MiB |
| After Qwen unload | 2,486 MiB |
| Gemma loaded | 10,693 MiB |
| After Gemma unload | 2,494 MiB |

The visual stress run peaked at 11,108 MiB. Snapshots after 5 and 10 sequential reviewed video calls were 10,877 and 10,885 MiB, an 8 MiB difference with no upward creep. Qwen and Gemma were not resident together, there was no OOM, and post-unload memory returned to baseline.

## 15–20 minute real runtime

The real KTNV/LVMPD source is 1,076 seconds (17.9 minutes). With the calibrated Hamming 4 setting, its visual pass took 141.8 seconds: 162 samples, 43 deduplications, 119 cheap scans, and 57 VLM calls. This passes the visual target of 180 seconds.

The measured compute throughput is 25.4 such 17.9-minute videos/hour at Hamming 4 (34.0/hour before calibration at Hamming 7). A defensible clean/average/high-cut category projection is not available from one full-length end-to-end source; the corpus-level frame timing and selected-call timing are insufficient substitutes for three full visual passes. No category-specific throughput percentage is fabricated.

Proxy download was attempted separately without the signed-in application session and correctly failed with HTTP 403, so its failed 4,977 ms is not included as download performance. Full text+visual analysis time was not measured for the long source; the reported value is the required visual-pass measurement only.

## Resolution comparison

Three difficult timestamps were compared at 640×360 and 854×480:

- Bodycam weapon at 660 seconds: missed at both resolutions.
- Small/multilingual OBS text at 550 seconds: missed at both resolutions.
- Minor forearm injury at 30 seconds: correctly found at both resolutions with medical context.

480p produced no material gain, so the default remains 360p.

## Bodycam results

The Seattle bodycam source produced no false weapon, blood, or nudity findings on the selected review call. Its continuous shake yielded only 2 scene cuts and 1/86 cheap-signal escalations, which confirms that scene detection and cheap signals do not model bodycam motion.

The briefing/bodycam source contained a manually reviewed small circled weapon around 650–670 seconds. Direct Gemma inspection at 660 seconds missed it at both 360p and 480p. News context therefore never reached deterministic policy mapping for this evidence. This is a VLM false negative and a model gap, not a reason to weaken deterministic news handling.

## News and documentary results

BBC and KTNV/LVMPD news footage, police evidence, maps, captions, interviews, and political imagery produced no weapon/blood/nudity false positive and no catastrophic REMOVE. Gemma kept findings evidence-only when it did respond. The real news-weapon case was missed, so the synthetic news-context success from Phase 5 must not be treated as real-world weapon recall.

## OCR

Gemma returned text on 7/12 selected text-bearing frames. It read large/fast English titles (`FALSE`, `FAST CUT EDITING`), captions, first-aid text, and swimming instructions. It missed software text, a firearm-safety title, a handheld tutorial overlay, small OBS text, and one news overlay.

The Japanese/small-font OBS sample was missed at both 360p and 480p: non-English OCR is **POOR** in this sample. The existing synthetic `WEAPON FOR SALE` case still passes, but no real sale/promotion or personal-information source was added merely to inflate coverage.

One benign NASA watermark was emitted by Gemma as `on_screen_text_risk`. Before calibration that unmapped finding could downgrade a clean segment. After calibration, provider-created text-risk findings are discarded unless deterministic `ocrRisk` matching confirms risky wording; OCR text remains available as evidence. The regression is tested.

## Safe-window impact

The Phase 4.1 regression trio was compared against reviewed Phase 5.1 outputs:

| Video | Phase 4.1 safe clips | After calibrated visual findings | Removed | Downgraded | Unchanged |
| --- | ---: | ---: | ---: | ---: | ---: |
| Google Developers | 8 | 8 | 0 | 0 | 8 |
| BBC News | 1 | 1 | 0 | 0 | 1 |
| WHO prevention | 0 | 0 | 0 | 0 | 0 |

No benign OCR finding is allowed to silently override a text decision. In the separate first-aid case, text-compatible medical instruction plus a real minor injury finding deterministically becomes REVIEW rather than REMOVE. A real “text REVIEW, visual clean” disagreement was not established in the sparse selected set; that branch remains covered by deterministic unit tests and is not claimed as a corpus observation.

## Cache

Three selected videos were immediately rerun through the versioned, frame-hash-aware cache. Result: 3/3 hits, 0 VLM calls, 8,185 ms of first-run VLM time versus 505 ms for extraction/hash/cache lookup. The Hamming calibration increments the threshold version, so old entries cannot leak across the new setting.

## Cancellation and temp cleanup

Real FFmpeg cancellation returned `cancelled`, real Gemma cancellation returned `ANALYSIS_CANCELLED`, and the temporary cancellation directory was removed. The first stress-run implementation exposed a Windows `EPERM` race because FFmpeg could release a file shortly after cancellation returned; bounded cleanup retry fixed it. A full 398-second rerun completed and left no `phase5-1-stress-*` directory.

Automated coverage also verifies cleanup after success, error, cancellation, and stale startup directories, plus request guards that prevent stale UI writes. No source proxy is stored in Git.

## Recommended calibration

- Keep 2/3/4 sampling and scene threshold 0.32; aggressive sampling showed no reviewed recall gain.
- Change dHash Hamming threshold from 7 to 4; the measured collision reduction is worth the bounded runtime increase.
- Keep 360p; 480p did not recover either difficult miss.
- Keep cheap thresholds as routing hints; do not convert them into findings.
- Filter benign model-generated `on_screen_text_risk` deterministically, while retaining actual OCR evidence.
- Keep the progressive format-18-first proxy selector and disable unused remote JS components on visual downloads.

## Model gaps

`MODEL_GAP` is established by two direct weapon false negatives across two different contexts, both lasting longer than two seconds. Sampling density, dedupe, and 480p cannot fix a model that returns no weapon finding on the frame it receives. OCR is also insufficient for small and non-English text (5 misses in 12 selected text cases). Phase 5.2 should evaluate the smallest targeted detector/OCR addition, but Phase 5.1 intentionally stops before adding one.
