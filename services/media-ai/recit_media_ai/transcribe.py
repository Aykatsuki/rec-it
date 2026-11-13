"""Local transcription with faster-whisper (ADR-010, ADR-031).

Runs in a worker thread; progress goes back to the backend as JSON-RPC notifications. The words
(with times and confidence) are written to a JSON file, because an hour of speech is too large
for one RPC message.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
import wave
from collections.abc import Callable
from pathlib import Path
from typing import Any

#: Models by device (ADR-010): large-v3-turbo on a GPU with 6 GB or more, small on the CPU.
DEFAULT_MODEL = {"cuda": "large-v3-turbo", "cpu": "small"}


def available() -> dict[str, Any]:
    """Whether faster-whisper is installed (it is an optional extra of this package)."""
    if os.environ.get("RECIT_FAKE_WHISPER") == "1":
        return {"available": True, "engine": "fake"}
    try:
        import importlib

        importlib.invalidate_caches()  # it may have been installed while we were running
        import faster_whisper  # noqa: F401

        return {"available": True, "engine": "faster-whisper"}
    except Exception as e:  # noqa: BLE001 - any import problem means "not available"
        return {"available": False, "error": str(e) or type(e).__name__}


def _add_cuda_dll_dirs() -> None:
    """On Windows, CUDA libraries from the nvidia-* wheels must be added to the DLL search path."""
    if sys.platform != "win32":
        return
    for base in map(Path, sys.path):
        nvidia = base / "nvidia"
        if nvidia.is_dir():
            for bin_dir in nvidia.glob("*/bin"):
                os.add_dll_directory(str(bin_dir))


def _duration(path: str) -> float:
    with wave.open(path, "rb") as w:
        return w.getnframes() / float(w.getframerate())


def _fake(
    audio: str, progress: Callable[[float], None], cancelled: threading.Event
) -> dict[str, Any]:
    """Deterministic stand-in for tests: one word every 0.5 s ("word1", "word2", ...).

    RECIT_FAKE_WHISPER_DELAY (seconds per word) makes it slow enough to test progress and cancel.
    """
    duration = _duration(audio)
    delay = float(os.environ.get("RECIT_FAKE_WHISPER_DELAY", "0") or 0)
    words = []
    t = 0.1
    n = 1
    while t + 0.4 <= duration:
        if cancelled.is_set():
            raise Cancelled()
        words.append({"text": f"word{n}", "start": round(t, 3), "end": round(t + 0.4, 3), "p": 0.9})
        t += 0.5
        n += 1
        if delay > 0:
            time.sleep(delay)
            progress(min(0.99, t / max(duration, 0.001)))
    progress(1.0)
    return {"language": "en", "model": "fake", "device": "cpu", "words": words}


def run(
    params: dict[str, Any],
    progress: Callable[[float], None],
    cancelled: threading.Event,
) -> dict[str, Any]:
    audio = str(params["audio"])
    out = str(params["out"])
    if os.environ.get("RECIT_FAKE_WHISPER") == "1":
        result = _fake(audio, progress, cancelled)
    else:
        result = _whisper(audio, params, progress, cancelled)
    Path(out).write_text(json.dumps(result), encoding="utf-8")
    return {
        "out": out,
        "words": len(result["words"]),
        "language": result["language"],
        "model": result["model"],
        "device": result["device"],
    }


class Cancelled(Exception):
    pass


def _whisper(
    audio: str,
    params: dict[str, Any],
    progress: Callable[[float], None],
    cancelled: threading.Event,
) -> dict[str, Any]:
    _add_cuda_dll_dirs()
    from faster_whisper import WhisperModel

    requested = params.get("device", "auto")
    models_dir = params.get("modelsDir")
    language = params.get("language") or None

    def load(device: str) -> tuple[Any, str, str]:
        name = params.get("model") or DEFAULT_MODEL[device]
        compute = "float16" if device == "cuda" else "int8"
        return (
            WhisperModel(name, device=device, compute_type=compute, download_root=models_dir),
            name,
            device,
        )

    if requested == "cpu":
        model, name, device = load("cpu")
    else:
        try:
            model, name, device = load("cuda")
        except Exception:  # noqa: BLE001 - no CUDA, missing libraries, not enough memory
            if requested == "cuda":
                raise
            model, name, device = load("cpu")

    total = _duration(audio)
    segments, info = model.transcribe(
        audio,
        language=language,
        word_timestamps=True,
        vad_filter=True,
        beam_size=5,
    )
    words: list[dict[str, Any]] = []
    for segment in segments:  # a generator: transcription happens while iterating
        if cancelled.is_set():
            raise Cancelled()
        for w in segment.words or []:
            text = w.word.strip()
            if text:
                words.append(
                    {
                        "text": text,
                        "start": round(w.start, 3),
                        "end": round(w.end, 3),
                        "p": round(w.probability, 3),
                    }
                )
        if total > 0:
            progress(min(1.0, segment.end / total))
    progress(1.0)
    return {"language": info.language, "model": name, "device": device, "words": words}
