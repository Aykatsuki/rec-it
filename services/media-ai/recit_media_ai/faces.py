"""Face detection for automatic reframing (Phase 5b, ADR-035).

FFmpeg decodes the clip's preview copy at a few frames per second and a small size; OpenCV's
YuNet detector finds faces in each frame. The result is a list of face boxes per sampled frame,
in fractions of the picture, which the editor turns into a smooth framing path.

opencv-python-headless is an optional extra ("reframe"); the YuNet model (MIT) ships with Rec-It.
RECIT_FAKE_FACES=1 replaces detection with one face moving steadily from left to right (tests).
"""

from __future__ import annotations

import json
import os
import subprocess
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

MODEL = Path(__file__).parent / "models" / "face_detection_yunet_2023mar.onnx"
#: Detections below this confidence are ignored.
SCORE = 0.6


class Cancelled(Exception):
    pass


def available() -> dict[str, Any]:
    if os.environ.get("RECIT_FAKE_FACES") == "1":
        return {"available": True, "engine": "fake"}
    try:
        import importlib

        importlib.invalidate_caches()
        import cv2

        return {"available": True, "engine": f"OpenCV {cv2.__version__} YuNet"}
    except Exception as e:  # noqa: BLE001 - any import problem means "not available"
        return {"available": False, "error": str(e) or type(e).__name__}


def _size(width: int, height: int, target: int) -> tuple[int, int]:
    """Analysis size: `target` pixels on the long edge, even numbers."""
    k = target / max(width, height)
    return max(2, round(width * k / 2) * 2), max(2, round(height * k / 2) * 2)


def run(
    params: dict[str, Any], progress: Callable[..., None], cancelled: threading.Event
) -> dict[str, Any]:
    out = str(params["out"])
    fps = float(params.get("fps", 5))
    duration = float(params.get("duration", 0))
    if os.environ.get("RECIT_FAKE_FACES") == "1":
        result = _fake(duration, fps)
    else:
        result = _detect(params, fps, duration, progress, cancelled)
    Path(out).write_text(json.dumps(result), encoding="utf-8")
    faces = sum(1 for f in result["frames"] if f)
    return {"out": out, "frames": len(result["frames"]), "withFaces": faces}


def _fake(duration: float, fps: float) -> dict[str, Any]:
    n = max(1, int(duration * fps))
    frames = []
    for i in range(n):
        x = 0.15 + 0.55 * (i / max(1, n - 1))
        frames.append([[round(x, 4), 0.3, 0.12, 0.2, 0.95]])
    return {"fps": fps, "engine": "fake", "frames": frames}


def _detect(
    params: dict[str, Any],
    fps: float,
    duration: float,
    progress: Callable[..., None],
    cancelled: threading.Event,
) -> dict[str, Any]:
    # Only errors on stderr (the sidecar's log); OpenCV 5 warns about its graph engine otherwise.
    os.environ.setdefault("OPENCV_LOG_LEVEL", "ERROR")
    import cv2
    import numpy as np

    w, h = _size(int(params["width"]), int(params["height"]), int(params.get("size", 480)))
    detector = cv2.FaceDetectorYN.create(str(MODEL), "", (w, h), SCORE, 0.3, 50)
    args = [
        str(params["ffmpeg"]),
        "-v",
        "error",
        "-nostdin",
        "-i",
        str(params["video"]),
        "-an",
        "-vf",
        f"fps={fps},scale={w}:{h}:flags=area",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "bgr24",
        "pipe:1",
    ]
    size = w * h * 3
    frames: list[list[list[float]]] = []
    expected = max(1, int(duration * fps))
    proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        assert proc.stdout is not None
        while True:
            if cancelled.is_set():
                raise Cancelled()
            buf = proc.stdout.read(size)
            if len(buf) < size:
                break
            img = np.frombuffer(buf, np.uint8).reshape(h, w, 3)
            _, found = detector.detect(img)
            boxes: list[list[float]] = []
            for f in found if found is not None else []:
                x, y, bw, bh, score = (
                    float(f[0]),
                    float(f[1]),
                    float(f[2]),
                    float(f[3]),
                    float(f[14]),
                )
                boxes.append(
                    [
                        round(x / w, 4),
                        round(y / h, 4),
                        round(bw / w, 4),
                        round(bh / h, 4),
                        round(score, 3),
                    ]
                )
            frames.append(boxes)
            if len(frames) % 10 == 0:
                progress(min(0.99, len(frames) / expected))
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.wait()
    if proc.returncode not in (0, -9, None) and not frames:
        err = proc.stderr.read().decode("utf-8", "replace")[-500:] if proc.stderr else ""
        raise RuntimeError(f"FFmpeg could not read the video: {err.strip()}")
    progress(1.0)
    import cv2 as _cv2

    return {"fps": fps, "engine": f"OpenCV {_cv2.__version__} YuNet", "frames": frames}
