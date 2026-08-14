# Phase 5.2 Specialized Visual Providers

## Status

**MODEL_GAP / PERFORMANCE_GAP — STOPPED AT THE MANDATORY WEAPON GATE.**

Phase 5.2 required a specialized detector to produce trustworthy weapon evidence on both known Phase 5.1 frames before integration. Neither permissively licensed candidate met that requirement without unacceptable negative-control false positives. No detector, OCR provider, policy shortcut, model weight, or Python dependency is bundled into the Electron application.

## Responsibility boundary preserved

The intended boundary remains unchanged:

- Qwen3-14B: text-policy findings.
- Object detector: object evidence only.
- OCR: text extraction only.
- Gemma 4 12B: semantic visual evidence and context.
- DecisionEngine: KEEP/REVIEW/REMOVE.

No tested model was allowed to return or influence a policy verdict during the gate.

## Detector selection

Ultralytics YOLO-World was considered first because it is maintained, supports custom open-vocabulary prompts, and matches the preferred YOLO family. It was rejected before installation into the product: Ultralytics documents its code and models under AGPL-3.0, which would require relicensing the larger ISC application or purchasing an enterprise license. Phase 5.2 does neither.

Two Apache-2.0 open-vocabulary alternatives were evaluated:

| Candidate | Source/license | Weight | Reason evaluated |
| --- | --- | ---: | --- |
| Google OWLv2 base patch16 ensemble | [Model card](https://huggingface.co/google/owlv2-base-patch16-ensemble), Apache-2.0 | 620 MB safetensors | Maintained Transformers support; text-conditioned handgun/firearm/knife/person classes |
| Grounding DINO Tiny | [Model card](https://huggingface.co/IDEA-Research/grounding-dino-tiny), Apache-2.0 | 689,359,096 bytes | Higher-resolution small-object processing; open-set class prompts |

Both models support explicit handgun/firearm prompts, so this is not `MODEL_CLASS_GAP`.

## Isolated evaluation environment

Evaluation used Python 3.11 in `.venv-visual`, isolated from Electron and ignored by Git:

```powershell
python -m venv .venv-visual
.\.venv-visual\Scripts\python.exe -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu128
.\.venv-visual\Scripts\python.exe -m pip install transformers rapidocr onnxruntime pillow
```

Measured package versions were PyTorch 2.11.0+cu128, Transformers 5.15.0, RapidOCR 3.9.2, and ONNX Runtime 1.28.0. Candidate weights were downloaded explicitly for evaluation into the user Hugging Face cache. Application code contains no automatic weight download.

## Mandatory weapon gate

The exact reviewed frames were extracted from the unchanged Phase 5.1 proxies at 660 seconds and 113 seconds. Detection ran on the full frame; no benchmark-specific crop, timestamp, circle detection, or source ID enters product code.

OWLv2 result:

- GLOCK 113s: handgun at 0.4395 with a correct box.
- Bodycam/news 660s: no weapon/firearm detection even at the raw 0.01 reporting floor.

Grounding DINO result:

- GLOCK 113s: handgun score 0.5799 with correct localization.
- Bodycam/news 660s: highest single-prompt score 0.3998, but its box covers the television rather than a localized handgun.
- At the example minimum tier of 0.45, bodycam is missed.
- Lowering the tier to 0.30 does not create defensible evidence because multiple negative controls score in the same or higher band.

The mandatory two-case gate therefore fails.

## Negative controls

Grounding DINO's top `handgun` scores on reviewed negatives were:

| Negative control | Score | Review |
| --- | ---: | --- |
| Press-conference microphone | 0.6454 | Catastrophic false weapon at any threshold that admits bodycam |
| Phone | 0.4339 | Higher than bodycam positive |
| Clean Seattle bodycam | 0.3814 | Overlaps bodycam candidate band |
| Swimming | 0.3386 | Overlaps lowered candidate band |
| Clean GLOCK interview | 0.3330 | Overlaps lowered candidate band |
| NASA action camera | 0.3155 | Overlaps lowered candidate band |
| Crowd | 0.2721 | Borderline below 0.30 |

The bodycam positive's 0.3998 cannot be separated from these controls with a confidence threshold. Hardcoding a television inset/circle crop would be benchmark tuning and was rejected.

## Additional weapon frames

Grounding DINO produced strong, localized evidence on GLOCK 112s, 113s, 114s, and 122s (0.4584–0.6285). It did not produce reliable localized evidence on the reviewed bodycam sequence at 650s, 655s, 660s, or 665s (0.2289–0.3998, dominated by screen/person regions).

This confirms the model can recognize clear firearms but does not solve the actual small, overexposed, screen-within-screen failure.

## Performance gate

Grounding DINO processed the 15-frame single-prompt batch in 126,509 ms, or 8,434 ms/frame. PyTorch reported 19,978 MiB maximum allocated during that large batch. Running it on the 119 retained frames from the Phase 5.1 long video would already project beyond 16 minutes before OCR or Gemma, far above the three-minute target.

Smaller batches could reduce memory pressure but cannot plausibly recover the required order-of-magnitude throughput while also fixing false localization. No production batching implementation was added.

## OCR boundary

RapidOCR was selected as the OCR candidate because it is maintained, local, packages small PP-OCR models, and is Apache-2.0. It was installed only in the ignored evaluation environment, but was not benchmarked or integrated: the prompt requires Phase 5.2 to stop immediately when both known weapon cases are not detected.

The Phase 5.1 OCR baseline therefore remains 7/12; no before/after claim is made.

## Product impact

- Existing Phase 5.1 visual pipeline is unchanged.
- Hamming 4 calibration remains active.
- Safe-window results are unchanged.
- No detector evidence reaches DecisionEngine.
- No detector/OCR cache, health mode, metrics, worker, or UI field is claimed as implemented.
- Phase 5.1 remains historically FAIL — MODEL_GAP.

## Next valid move

The next attempt needs a permissively licensed detector trained specifically on firearms/small weapons, with documented class labels and weights. It must pass the same bodycam/GLOCK gate and negative controls before any pipeline integration. Do not lower a general open-vocabulary threshold to manufacture recall.
