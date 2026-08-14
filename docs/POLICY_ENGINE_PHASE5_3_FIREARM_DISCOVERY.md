# Phase 5.3 — Firearm Detector Discovery Gate

## Outcome

`NO_VIABLE_FIREARM_DETECTOR`

This phase is a repository and benchmark gate only. No detector, dependency, threshold, sampling rule, or source-specific crop was added to the product path. Phase 5.1 remains **FAIL — MODEL_GAP** and Phase 5.2 remains **STOP — MODEL_GAP / PERFORMANCE_GAP**.

## Candidate review

| Candidate | Specialty / evidence | License finding | Gate action |
| --- | --- | --- | --- |
| [Dricz/gun-obj-detection](https://huggingface.co/Dricz/gun-obj-detection) | DETR ResNet-50; labels `rifle`, `pistol`, `grenade`, `knife`; 1 epoch; no published evaluation metrics | Apache-2.0 metadata; safetensors | Benchmarked |
| [Dricz/gun-obj-detection-3](https://huggingface.co/Dricz/gun-obj-detection-3) | Same DETR/dataset and labels; 5 epochs; no published evaluation metrics | Apache-2.0 metadata; safetensors | Benchmarked |
| [srikarym/CCTV-Gun](https://github.com/srikarym/CCTV-Gun) | Research benchmark for Person/Handgun with five MMDetection architectures and linked trained models | Repository code is Apache-2.0, but the externally hosted checkpoint files have no explicit weight-license statement | `LICENSE_UNKNOWN`; not downloaded |
| [Subh775/Firearm_Detection_Yolov8n](https://huggingface.co/Subh775/Firearm_Detection_Yolov8n) | YOLOv8n, one `Gun` class, small checkpoint | Hugging Face metadata is AGPL-3.0 | Rejected before inference |
| [Zcket/gun_dtct](https://huggingface.co/Zcket/gun_dtct) | YOLOv8n, pistol/grenade description | Page says MIT, but the checkpoint depends on the Ultralytics YOLOv8 stack; license provenance is inconsistent with the [Ultralytics AGPL terms](https://docs.ultralytics.com/help/contributing/) | `LICENSE_CONFLICT`; not downloaded |
| [Dricz/gun-obj-detection-5](https://huggingface.co/Dricz/gun-obj-detection-5) | Undocumented pickled `best.pt`; no usable model card or evaluation metrics | OpenRAIL metadata, not the preferred permissive license; checkpoint provenance is unclear | Rejected before inference |

The two Apache-2.0 DETR checkpoints are 166,497,908 bytes each and contain 41,608,649 float32 parameters. Exact revisions are recorded in the evidence JSON. The model cards do not publish precision, recall, mAP, dataset card details, or limitations, so repository metadata alone was not treated as proof of quality.

## Technical metadata

| Candidate | Architecture / framework | Verified classes | Documented training data | Input | Weight size |
| --- | --- | --- | --- | --- | ---: |
| DETR 1 epoch | DETR ResNet-50; Transformers 4.38.2 training / 5.15 evaluation | rifle, pistol, grenade, knife | `gun-object-detection`; dataset card details absent | shortest edge 800, longest 1333 | 166,497,908 B |
| DETR 5 epochs | DETR ResNet-50; Transformers 4.38.2 training / 5.15 evaluation | rifle, pistol, grenade, knife | `gun-object-detection`; dataset card details absent | shortest edge 800, longest 1333 | 166,497,908 B |
| CCTV-Gun | Faster R-CNN, Swin-T, Deformable DETR, DetectoRS, ConvNeXt-T; MMDetection 2.2/MMCV 1.7 | Person, Handgun | MGD, USRT, UCF | config-dependent, commonly 800/1333 | Not verified; gated before download |
| Subh775 YOLOv8n | YOLOv8n / Ultralytics | Gun | model card says custom ~7k images | 640 | Page reports ~6.2 MB; not downloaded |
| Zcket gun_dtct | YOLOv8n / Ultralytics | Pistols, Grenades | page says ~16k images; provenance details absent | Not documented | Not verified; gated before download |
| Dricz detection-5 | Undocumented YOLO-style pickle | Not verifiable from model card | Not documented | Not documented | Not verified; gated before download |

The earlier open-vocabulary OWLv2 and Grounding DINO experiments are excluded from the specialized candidate count. They remain historical Phase 5.2 baselines, not new Phase 5.3 discoveries. [YOLO-World](https://docs.ultralytics.com/models/yolo-world/) also remains excluded because its official distribution terms are AGPL-3.0 or Enterprise.

## Isolated evaluation harness

`scripts/evaluate-firearm-detector.py` runs only when an operator supplies a frame directory, model ID, and output path. It normalizes a legacy DETR config field in memory, loads safetensors through Transformers, and never enters application code. `scripts/evaluate-adaptive-zoom.js` performs the one permitted generic Gemma fallback.

Inputs were recreated in the OS temporary directory from the unchanged Phase 5.1 proxies. Neither frames nor weights are committed. The test set contains:

- Required full-frame positives: bodycam/news 660s and GLOCK 113s.
- Neighbor positives: bodycam 650/655/665s and GLOCK 112/114/122s.
- Reviewed negatives: press-conference microphone, phone, clean Seattle bodycam, swimming, clean GLOCK interview, NASA action camera, and crowd.
- Full-frame resolution variants: 360p, 480p, and 720p for both required positives.
- Generic, uniform 2×2 and 3×3 tiling; no timestamp, circle detector, source ID, or hand-authored crop is available to the detector.

All test images were manually reviewed. A valid hit requires a firearm-class prediction with IoU at least 0.10 against a reviewed object region and predicted area no more than four times that region. This rejects television/person-sized boxes that only contain the weapon incidentally.

## Acceptance rule

A detector is viable only if one threshold in 0.20/0.30/0.40/0.50/0.60 detects and correctly localizes both exact positives, creates no catastrophic firearm false positive on the reviewed negatives, has permissive and traceable licensing, and has reasonable runtime. Neither benchmarked checkpoint detected either required pair at the lowest reviewed threshold.

No OCR benchmark was run because the firearm gate did not pass. No Phase 5.4 work was started.
