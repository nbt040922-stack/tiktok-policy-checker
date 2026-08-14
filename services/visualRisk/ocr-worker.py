"""Long-lived RapidOCR JSON-lines worker. Returns text evidence only."""

import json
import sys
import time

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


try:
    from rapidocr import RapidOCR

    engine = RapidOCR()
    emit({"type": "ready", "engine": "RapidOCR", "runtime": "onnxruntime", "device": "cpu"})
except Exception as error:  # pragma: no cover - exercised through provider health behavior
    emit({"type": "fatal", "error": str(error)})
    raise SystemExit(1)

for raw_line in sys.stdin:
    try:
        request = json.loads(raw_line)
        cpu_started = time.process_time()
        result = engine(request["path"])
        boxes = result.boxes.tolist() if result.boxes is not None else []
        lines = [
            {"text": text, "confidence": float(score), "box": box}
            for text, score, box in zip(result.txts or (), result.scores or (), boxes)
        ]
        emit({
            "id": request["id"], "timestamp": request.get("timestamp"), "lines": lines,
            "engineMs": round(float(result.elapse or 0) * 1000, 2),
            "cpuMs": round((time.process_time() - cpu_started) * 1000, 2),
        })
    except Exception as error:
        emit({"id": request.get("id") if "request" in locals() else None, "error": str(error)})
