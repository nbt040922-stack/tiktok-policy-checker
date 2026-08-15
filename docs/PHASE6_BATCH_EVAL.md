# Phase 6 — Batch evaluation

## Corpus and method

The benchmark processed all 10 Phase 5.4 real-news sources: BBC News, Reuters, CNBC Television, and SABC News, spanning short news, presenters, interviews, B-roll, documents, headlines, financial charts, and one 998-second program. Source media is not committed.

Public metadata/transcripts, Qwen, FFmpeg sampling, frozen RapidOCR, Gemma, deterministic merge, queue persistence, and report generation were executed sequentially. Reviewed local 360p proxies were reused, so proxy media download time is explicitly excluded. Cold uses empty Qwen/visual caches. Warm creates new revisions with the same versions and populated caches.

## Throughput

```text
                         COLD / EMPTY CACHE      WARM CACHE
videos                   10                      10
completed / failed       10 / 0                  10 / 0
retries                  0                       0
wall time                1,201.731 s             349.866 s
videos/hour              29.96                   102.90
mean/video               120.170 s               34.986 s
median/video              91.502 s               17.657 s
p95/video                396.780 s              100.694 s
Qwen calls/video           1.8                     0.0
Gemma calls/video         20.0                     0.8
OCR calls/video            9.6                     9.6
peak VRAM             12,526 MiB               3,247 MiB
```

Cold outcomes were two `SAFE`, eight `HAS_REVIEW`, zero `HAS_REMOVE`, and zero `INCOMPLETE`. These are automated policy results, not TikTok approval.

Warm cache preserved OCR/FFmpeg work intentionally: 18 Qwen cache hits and 193 visual cache hits reduced model calls, while OCR remained uncached so new overlays cannot be hidden.

## Scheduling choice

An actual four-request local-model probe compared two Qwen/Gemma cycles:

```text
per-video alternating:    36.303 s, 4 loads, 29.122 s reload, 12,580 MiB peak
grouped text then visual:  16.705 s, 2 loads, 16.029 s reload, 12,582 MiB peak
grouped improvement:       54.0%
```

The gap is material, so production selects grouped text then visual. Jobs keep one persistent identity and revision; transcript/text/visual checkpoints make phase recovery explicit. Gemma remains loaded only across the grouped visual run and unloads at the final job or when the queue pauses. The measured 29.96 cold videos/hour is the conservative full-batch per-video baseline; no unmeasured grouped end-to-end uplift is added to projections.

## Scale projection

Using measured per-video means:

```text
videos/day     cold machine-hours     warm machine-hours
50             1.67                   0.49
100            3.34                   0.97
200            6.68                   1.94
```

These figures exclude proxy download and operator review. At cold-cache baseline, 200/day fits within a 24-hour machine day on the evaluation workstation, but network conditions and an unusually interview/B-roll-heavy mix can move the p95 materially.

## Bottlenecks

Top cold aggregate stages:

1. Gemma: 701.610 seconds.
2. Qwen text policy: 124.309 seconds.
3. RapidOCR CPU engine time: 98.856 seconds.

Transcript/network metadata used 35.038 seconds. Prepared-proxy overhead was near zero and cannot be used as a download benchmark.

## Queue and recovery stress

The 200-record stress probe measured:

```text
enqueue 200             9 ms
query/render subset     <1 ms / 100 records
restart reload          2 ms / 200 records
database size           216,260 bytes
heap delta              1,271,616 bytes
```

Search returned the expected unique title and all 200 records survived reload. Renderer output is capped at 100 records.

The force-kill test terminated a child process while its job was `RUNNING`. Restart recovered it as `QUEUED` with `APP_INTERRUPTED`, parsed the database, preserved an existing completed report, and removed stale visual temp media. Corrupt database and corrupt Qwen/visual caches are separately quarantined in tests.

## Evidence and limits

Machine-readable results are in `docs/evidence/phase6-batch-results.json`. Cold application service construction was 6 ms and did not load models; model load remains lazy.

Known limits: the job store is single-writer atomic JSON rather than SQLite; proxy download throughput was not included; the grouped full 10-video path is selected from the measured model scheduling probe while published full-pipeline throughput remains the conservative per-video baseline; real human-review throughput is outside this benchmark.

