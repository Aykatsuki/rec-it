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

from .rpc import log

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


def _add_cuda_dll_dirs() -> list[str]:
    """On Windows, make the CUDA DLLs from the nvidia-* wheels findable.

    CTranslate2 loads cuBLAS and cuDNN with a plain LoadLibrary when it first runs on the GPU,
    which searches PATH but not directories added with os.add_dll_directory, so both are set.
    """
    if sys.platform != "win32":
        return []
    found: list[str] = []
    for base in map(Path, sys.path):
        nvidia = base / "nvidia"
        if nvidia.is_dir():
            for bin_dir in nvidia.glob("*/bin"):
                found.append(str(bin_dir))
    for d in found:
        os.add_dll_directory(d)
    path = os.environ.get("PATH", "")
    missing = [d for d in found if d not in path.split(os.pathsep)]
    if missing:
        os.environ["PATH"] = os.pathsep.join([*missing, path])
    return found


def _duration(path: str) -> float:
    with wave.open(path, "rb") as w:
        return w.getnframes() / float(w.getframerate())


def _read_pcm(path: str) -> Any:
    """Reads the backend's 16 kHz mono 16-bit WAV as float32 samples.

    Passing samples (not a path) keeps faster-whisper from decoding with PyAV, whose API changes
    between releases.
    """
    import numpy as np

    with wave.open(path, "rb") as w:
        if w.getsampwidth() != 2 or w.getnchannels() != 1 or w.getframerate() != 16000:
            raise ValueError("expected 16 kHz mono 16-bit PCM audio")
        data = w.readframes(w.getnframes())
    return np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0


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


#: Approximate download sizes, for the progress message.
MODEL_MB = {"large-v3-turbo": 1620, "small": 490, "tiny.en": 75, "tiny": 75, "base": 145}


def _dir_bytes(path: Path) -> int:
    total = 0
    for f in path.rglob("*"):
        try:
            if f.is_file():
                total += f.stat().st_size
        except OSError:
            pass
    return total


def _fetch_model(
    name: str,
    models_dir: str | None,
    progress: Callable[..., None],
    cancelled: threading.Event,
) -> str:
    """Returns a local folder with the model, downloading it the first time."""
    from faster_whisper.utils import download_model

    if not models_dir:
        return download_model(name)
    target = Path(models_dir) / name.replace("/", "--")
    if (target / "model.bin").is_file() and (target / "config.json").is_file():
        try:
            return download_model(name, output_dir=str(target), local_files_only=True)
        except Exception:  # noqa: BLE001 - incomplete; download again
            pass
    expected = MODEL_MB.get(name)
    done = threading.Event()

    def report() -> None:
        while not done.wait(1.0):
            mb = _dir_bytes(target) / 1e6
            of = f" of about {expected:,} MB" if expected else ""
            progress(0.0, f"Downloading the speech model {name} ({mb:,.0f} MB{of})…")

    log("downloading model", name, "to", str(target))
    progress(0.0, f"Downloading the speech model {name}…")
    reporter = threading.Thread(target=report, daemon=True)
    reporter.start()
    try:
        path = download_model(name, output_dir=str(target))
    finally:
        done.set()
    if cancelled.is_set():
        raise Cancelled()
    return path


def _whisper(
    audio: str,
    params: dict[str, Any],
    progress: Callable[..., None],
    cancelled: threading.Event,
) -> dict[str, Any]:
    dll_dirs = _add_cuda_dll_dirs()
    if dll_dirs:
        log("CUDA DLL folders", *dll_dirs)
    from faster_whisper import WhisperModel

    requested = params.get("device", "auto")
    models_dir = params.get("modelsDir")
    language = params.get("language") or None
    samples = _read_pcm(audio)
    total = len(samples) / 16000

    def attempt(device: str) -> dict[str, Any]:
        name = params.get("model") or DEFAULT_MODEL[device]
        path = _fetch_model(name, models_dir, progress, cancelled)
        where = "graphics card" if device == "cuda" else "processor"
        progress(0.0, f"Loading {name} on the {where}…")
        compute = "float16" if device == "cuda" else "int8"
        model = WhisperModel(path, device=device, compute_type=compute)
        progress(0.0, f"Transcribing with {name} on the {where}…")
        segments, info = model.transcribe(
            samples,
            language=language,
            word_timestamps=True,
            vad_filter=True,
            beam_size=5,
        )
        words: list[dict[str, Any]] = []
        # A generator: the work (and CUDA's first use) happens while iterating.
        for segment in segments:
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

    if requested == "cpu":
        return attempt("cpu")
    try:
        return attempt("cuda")
    except Cancelled:
        raise
    except Exception as e:  # noqa: BLE001 - no CUDA, missing DLLs, out of GPU memory
        if requested == "cuda":
            raise
        log("GPU transcription failed, using the CPU:", repr(e))
        progress(0.0, f"The graphics card could not be used ({e}); using the processor…")
        return attempt("cpu")
