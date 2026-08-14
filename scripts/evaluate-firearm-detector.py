#!/usr/bin/env python
"""Isolated Phase 5.3 firearm-detector benchmark (never used by product code)."""

import argparse
import gc
import json
import statistics
import subprocess
import time
from pathlib import Path

import torch
from huggingface_hub import hf_hub_download
from PIL import Image
from transformers import AutoImageProcessor, AutoModelForObjectDetection, DetrConfig


THRESHOLDS = (0.2, 0.3, 0.4, 0.5, 0.6)
WEAPON_LABELS = {"firearm", "gun", "handgun", "pistol", "rifle"}
CASES = {
    "bodycam-650": {"kind": "positive", "boxes": [[590, 315, 900, 595]]},
    "bodycam-655": {"kind": "positive", "boxes": [[710, 330, 985, 610]]},
    "bodycam-660": {"kind": "positive", "boxes": [[710, 330, 965, 585]], "gate": True},
    "bodycam-665": {"kind": "positive", "boxes": [[710, 330, 965, 585]]},
    "glock-112": {"kind": "positive", "boxes": [[620, 115, 920, 325]]},
    "glock-113": {"kind": "positive", "boxes": [[700, 60, 920, 290]], "gate": True},
    "glock-114": {"kind": "positive", "boxes": [[745, 105, 1145, 270]]},
    "glock-122": {"kind": "positive", "boxes": [[35, 20, 215, 150], [430, 15, 710, 145], [810, 15, 1120, 150], [405, 160, 710, 315]]},
    "microphone": {"kind": "negative"},
    "phone": {"kind": "negative"},
    "seattle-clean": {"kind": "negative"},
    "swimming": {"kind": "negative"},
    "glock-clean": {"kind": "negative"},
    "nasa-action": {"kind": "negative"},
    "crowd": {"kind": "negative"},
}


def sync():
    if torch.cuda.is_available():
        torch.cuda.synchronize()


def gpu_used_mib():
    try:
        value = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
            text=True,
            timeout=10,
        ).splitlines()[0]
        return int(value.strip())
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        return None


def iou(a, b):
    ix1, iy1, ix2, iy2 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    intersection = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    union = max(0, a[2] - a[0]) * max(0, a[3] - a[1]) + max(0, b[2] - b[0]) * max(0, b[3] - b[1]) - intersection
    return intersection / union if union else 0


def scale_boxes(boxes, width, height):
    return [[x1 * width / 1280, y1 * height / 720, x2 * width / 1280, y2 * height / 720] for x1, y1, x2, y2 in boxes]


def infer(processor, model, device, images):
    inputs = processor(images=images, return_tensors="pt").to(device)
    sync()
    started = time.perf_counter()
    with torch.inference_mode():
        outputs = model(**inputs)
    sync()
    elapsed_ms = (time.perf_counter() - started) * 1000
    sizes = torch.tensor([[im.height, im.width] for im in images], device=device)
    results = processor.post_process_object_detection(outputs, threshold=0.01, target_sizes=sizes)
    parsed = []
    for result in results:
        detections = []
        for score, label, box in zip(result["scores"], result["labels"], result["boxes"]):
            name = model.config.id2label[int(label)].lower()
            if name in WEAPON_LABELS:
                detections.append({"label": name, "score": round(float(score), 6), "bbox": [round(float(v), 2) for v in box]})
        parsed.append(sorted(detections, key=lambda row: row["score"], reverse=True)[:10])
    return elapsed_ms, parsed


def localize(case, image, detections):
    gt = scale_boxes(CASES[case].get("boxes", []), image.width, image.height)
    for detection in detections:
        detection["maxIou"] = round(max((iou(detection["bbox"], box) for box in gt), default=0), 4)
        detection_area = max(0, detection["bbox"][2] - detection["bbox"][0]) * max(0, detection["bbox"][3] - detection["bbox"][1])
        closest_area = min((max(1, (box[2] - box[0]) * (box[3] - box[1])) for box in gt), default=1)
        detection["areaRatio"] = round(detection_area / closest_area, 4)
        # A screen/person-sized box that merely contains the weapon is not correct localization.
        detection["localized"] = detection["maxIou"] >= 0.1 and detection["areaRatio"] <= 4
    return detections


def tiled(processor, model, device, image, grid):
    width, height = image.size
    mapped, elapsed = [], 0
    for row in range(grid):
        for col in range(grid):
            left, top = round(col * width / grid), round(row * height / grid)
            right, bottom = round((col + 1) * width / grid), round((row + 1) * height / grid)
            duration, results = infer(processor, model, device, [image.crop((left, top, right, bottom))])
            elapsed += duration
            for detection in results[0]:
                x1, y1, x2, y2 = detection["bbox"]
                mapped.append({**detection, "bbox": [x1 + left, y1 + top, x2 + left, y2 + top], "tile": [row, col]})
    return elapsed, sorted(mapped, key=lambda row: row["score"], reverse=True)[:20]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--frames", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    device = "cuda" if torch.cuda.is_available() else "cpu"
    if device == "cuda":
        torch.cuda.empty_cache()
        torch.cuda.reset_peak_memory_stats()
    baseline_vram = gpu_used_mib()

    load_started = time.perf_counter()
    processor = AutoImageProcessor.from_pretrained(args.model)
    config_data = json.loads(Path(hf_hub_download(args.model, "config.json")).read_text(encoding="utf-8"))
    # Older DETR checkpoints serialized this as null; Transformers 5 expects a mapping.
    if config_data.get("model_type") == "detr" and config_data.get("backbone_kwargs") is None:
        config_data["backbone_kwargs"] = {}
    config = DetrConfig.from_dict(config_data) if config_data.get("model_type") == "detr" else None
    model = AutoModelForObjectDetection.from_pretrained(args.model, config=config).to(device).eval()
    sync()
    load_ms = (time.perf_counter() - load_started) * 1000
    loaded_vram = gpu_used_mib()

    images = {case: Image.open(args.frames / f"{case}-720.jpg").convert("RGB") for case in CASES}
    cold_ms, cold = infer(processor, model, device, [images["glock-113"]])
    warm_times = [infer(processor, model, device, [images["glock-113"]])[0] for _ in range(5)]
    batch_ms, results = infer(processor, model, device, list(images.values()))
    batch_vram = gpu_used_mib()
    predictions = {}
    for (case, image), detections in zip(images.items(), results):
        predictions[case] = localize(case, image, detections) if CASES[case]["kind"] == "positive" else detections

    resolution = {}
    for height in (360, 480, 720):
        resolution[str(height)] = {}
        for case in ("bodycam-660", "glock-113"):
            image = Image.open(args.frames / f"{case}-{height}.jpg").convert("RGB")
            elapsed, detection = infer(processor, model, device, [image])
            resolution[str(height)][case] = {"runtimeMs": round(elapsed, 2), "detections": localize(case, image, detection[0])}

    tiling = {}
    tiled_cases = [case for case, data in CASES.items() if data.get("gate") or data["kind"] == "negative"]
    for grid in (2, 3):
        tiling[f"{grid}x{grid}"] = {}
        for case in tiled_cases:
            elapsed, detection = tiled(processor, model, device, images[case], grid)
            if CASES[case]["kind"] == "positive":
                detection = localize(case, images[case], detection)
            tiling[f"{grid}x{grid}"][case] = {"runtimeMs": round(elapsed, 2), "detections": detection}

    sweeps = {}
    for threshold in THRESHOLDS:
        gate_hits = {case: any(d["score"] >= threshold and d.get("localized") for d in predictions[case]) for case in ("bodycam-660", "glock-113")}
        false_positives = [case for case, data in CASES.items() if data["kind"] == "negative" and any(d["score"] >= threshold for d in predictions[case])]
        sweeps[str(threshold)] = {"gateHits": gate_hits, "negativeFalsePositives": false_positives, "passes": all(gate_hits.values()) and not false_positives}

    mean_ms = batch_ms / len(images)
    labels = model.config.id2label
    max_allocated = round(torch.cuda.max_memory_allocated() / 1048576, 2) if device == "cuda" else None
    max_reserved = round(torch.cuda.max_memory_reserved() / 1048576, 2) if device == "cuda" else None
    del model, processor
    gc.collect()
    if device == "cuda":
        torch.cuda.empty_cache()
        sync()
    post_unload_vram = gpu_used_mib()
    output = {
        "model": args.model,
        "device": device,
        "labels": labels,
        "runtime": {
            "loadMs": round(load_ms, 2), "coldSingleMs": round(cold_ms, 2),
            "warmSingleMedianMs": round(statistics.median(warm_times), 2),
            "batchFrames": len(images), "batchMs": round(batch_ms, 2), "batchMeanMs": round(mean_ms, 2),
            "projected119Ms": round(mean_ms * 119, 2), "projected200Ms": round(mean_ms * 200, 2),
        },
        "vram": {
            "systemBaselineMiB": baseline_vram, "systemModelLoadedMiB": loaded_vram,
            "systemAfterBatchMiB": batch_vram, "systemPostUnloadMiB": post_unload_vram,
            "maxAllocatedMiB": max_allocated, "maxReservedMiB": max_reserved,
        },
        "predictions": predictions,
        "thresholdSweep": sweeps,
        "resolution": resolution,
        "tiling": tiling,
    }
    args.output.write_text(json.dumps(output, indent=2), encoding="utf-8")
    print(json.dumps({"model": args.model, "runtime": output["runtime"], "vram": output["vram"], "thresholdSweep": sweeps}, indent=2))


if __name__ == "__main__":
    main()
