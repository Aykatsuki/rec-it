"""AI voice (text-to-speech) for faceless templates (Phase 8, ADR-046).

Kokoro-82M (Apache-2.0) through kokoro-onnx (MIT) on ONNX Runtime: runs on any CPU at about real
time, no account and no network after the one-time model download. The model reports how long
each sound lasts, so every word gets an exact start and end for captions.

kokoro-onnx is part of the optional "voice" extra. RECIT_FAKE_TTS=1 replaces speech with a short
tone per word at predictable times (tests).
"""

from __future__ import annotations

import hashlib
import math
import os
import re
import threading
import urllib.request
import wave
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .rpc import log

SAMPLE_RATE = 24000
BASE_URL = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/"
#: Model files with their SHA-256 (checked after download).
FILES = {
    "kokoro-v1.0.fp16.onnx": (
        "f3a290d384fbb27966d462905c71a46cef9e5fd00516b40df32a0b4afe77ac96",
        163_527_961,
    ),
    "voices-v1.0.bin": (
        "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
        28_214_398,
    ),
}
FOLDER = "kokoro-v1.0"


class Cancelled(Exception):
    pass


def available() -> dict[str, Any]:
    if os.environ.get("RECIT_FAKE_TTS") == "1":
        return {"available": True, "engine": "fake"}
    try:
        import importlib

        importlib.invalidate_caches()
        import kokoro_onnx  # noqa: F401
        import PIL  # noqa: F401

        return {"available": True, "engine": "Kokoro-82M"}
    except Exception as e:  # noqa: BLE001 - any import problem means "not available"
        return {"available": False, "error": str(e) or type(e).__name__}


# ---- Words ---------------------------------------------------------------------------------


def split_words(text: str) -> list[str]:
    return [w for w in re.split(r"\s+", text.strip()) if w]


def align(words: list[str], spans: list[tuple[float, float]], counts: list[int]) -> list[dict]:
    """
    Gives each written word its time. `spans` are the spoken words the model produced (start,
    end); `counts` says how many spoken words each written word became ("29F" → "twenty nine
    F" is 3). When they do not add up, time is shared by letter count instead.
    """
    out: list[dict] = []
    if not words:
        return out
    if spans and sum(counts) == len(spans):
        i = 0
        for word, k in zip(words, counts, strict=True):
            if k == 0:
                # Spoken as nothing (a lone dash): a moment at the previous word's end.
                t = out[-1]["end"] if out else spans[0][0]
                out.append({"text": word, "start": t, "end": t})
                continue
            out.append({"text": word, "start": spans[i][0], "end": spans[i + k - 1][1]})
            i += k
        return out
    start = spans[0][0] if spans else 0.0
    end = spans[-1][1] if spans else 0.0
    weights = [max(1, len(re.sub(r"\W", "", w))) for w in words]
    total = sum(weights)
    t = start
    for word, wgt in zip(words, weights, strict=True):
        d = (end - start) * wgt / total
        out.append({"text": word, "start": t, "end": t + d})
        t += d
    return out


def spoken_count(phonemes: str) -> int:
    """Spoken words in a phoneme string (punctuation on its own, like a dash, is silent)."""
    return sum(1 for w in split_words(phonemes) if re.search(r"\w", w, re.UNICODE))


def spoken_spans(timings: list[Any]) -> list[tuple[float, float]]:
    """Spoken words from per-sound timings: runs of sounds between spaces."""
    spans: list[tuple[float, float]] = []
    cur: list[float] | None = None
    for t in timings:
        ph = t.phoneme
        if ph.isspace():
            if cur:
                spans.append((cur[0], cur[1]))
            cur = None
            continue
        if not re.search(r"\w", ph, re.UNICODE) and cur is None:
            continue  # punctuation before a word
        if cur is None:
            cur = [t.start, t.end]
        else:
            cur[1] = t.end
    if cur:
        spans.append((cur[0], cur[1]))
    return spans


# ---- Model ---------------------------------------------------------------------------------


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def _fetch(models_dir: str, progress: Callable[..., None], cancelled: threading.Event) -> Path:
    folder = Path(models_dir) / FOLDER
    folder.mkdir(parents=True, exist_ok=True)
    total = sum(size for _, size in FILES.values())
    done = 0
    for name, (digest, size) in FILES.items():
        target = folder / name
        if target.is_file() and target.stat().st_size == size:
            done += size
            continue
        log("downloading", name)
        part = target.with_suffix(target.suffix + ".part")
        with urllib.request.urlopen(BASE_URL + name, timeout=60) as r, part.open("wb") as f:
            got = 0
            while True:
                if cancelled.is_set():
                    raise Cancelled()
                block = r.read(1 << 20)
                if not block:
                    break
                f.write(block)
                got += len(block)
                mb = (done + got) / 1e6
                progress(
                    0.6 * (done + got) / total,
                    f"Downloading the voice model ({mb:,.0f} of {total / 1e6:,.0f} MB)…",
                )
        if _sha256(part) != digest:
            part.unlink(missing_ok=True)
            raise RuntimeError(f"The download of {name} was damaged; try again.")
        part.replace(target)
        done += size
    return folder


_engine: Any = None
_lock = threading.Lock()


def _kokoro(models_dir: str, progress: Callable[..., None], cancelled: threading.Event) -> Any:
    global _engine
    with _lock:
        if _engine is None:
            folder = _fetch(models_dir, progress, cancelled)
            from kokoro_onnx import Kokoro

            progress(0.62, "Loading the voice model…")
            _engine = Kokoro(str(folder / "kokoro-v1.0.fp16.onnx"), str(folder / "voices-v1.0.bin"))
        return _engine


# ---- Synthesis ------------------------------------------------------------------------------


def _write_wav(path: str, pieces: list[Any]) -> float:
    """Writes 16-bit mono PCM; returns the length in seconds."""
    try:
        import numpy as np

        data = np.clip(np.concatenate([np.asarray(p, dtype=np.float32) for p in pieces]), -1, 1)
        frames = (data * 32767).astype("<i2").tobytes()
        n = len(data)
    except ImportError:  # the fake engine runs without numpy
        import array

        flat = [x for p in pieces for x in p]
        frames = array.array("h", (max(-32767, min(32767, int(x * 32767))) for x in flat)).tobytes()
        n = len(flat)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(frames)
    return n / SAMPLE_RATE


def _fake_segment(text: str, speed: float) -> tuple[list[float], list[dict]]:
    """A 440 Hz tone per word (0.3 s / speed) with 0.1 s gaps: exact, model-free timings."""
    words = split_words(text)
    step = 0.4 / speed
    length = 0.3 / speed
    n = int(len(words) * step * SAMPLE_RATE)
    audio = [0.0] * n
    out = []
    for i, word in enumerate(words):
        a = int(i * step * SAMPLE_RATE)
        b = min(n, a + int(length * SAMPLE_RATE))
        for k in range(a, b):
            audio[k] = 0.3 * math.sin(2 * math.pi * 440 * k / SAMPLE_RATE)
        out.append({"text": word, "start": a / SAMPLE_RATE, "end": b / SAMPLE_RATE})
    return audio, out


def fake_sounds(words: list[dict]) -> list[dict]:
    """Per-sound timings for the fake voice: each word's letters spread evenly over it."""
    out: list[dict] = []
    for w in words:
        letters = [c for c in str(w["text"]).lower() if c.isalpha()] or ["a"]
        step = (w["end"] - w["start"]) / len(letters)
        for i, c in enumerate(letters):
            out.append({"p": c, "start": w["start"] + i * step, "end": w["start"] + (i + 1) * step})
        out.append({"p": " ", "start": w["end"], "end": w["end"]})
    return out


def lang_of(voice: str) -> str:
    """British voices (bf_, bm_) read with British pronunciation; the rest as American English."""
    return "en-gb" if voice.startswith("b") else "en-us"


def _segment(
    engine: Any, text: str, voice: str, speed: float
) -> tuple[Any, list[dict], list[dict]]:
    words = split_words(text)
    lang = lang_of(voice)
    audio, sr, timings = engine.create_timed(" ".join(words), voice=voice, speed=speed, lang=lang)
    assert sr == SAMPLE_RATE
    # How many spoken words each written word becomes, from phonemising it alone.
    counts = [spoken_count(engine.tokenizer.phonemize(w, lang)) for w in words]
    sounds = [{"p": t.phoneme, "start": t.start, "end": t.end} for t in timings]
    return audio, align(words, spoken_spans(timings), counts), sounds


def run(
    params: dict[str, Any], progress: Callable[..., None], cancelled: threading.Event
) -> dict[str, Any]:
    segments = params["segments"]
    voice = str(params.get("voice", "af_heart"))
    speed = float(params.get("speed", 1.0))
    gap = float(params.get("gap", 0.35))
    fake = os.environ.get("RECIT_FAKE_TTS") == "1"
    engine = None if fake else _kokoro(str(params["modelsDir"]), progress, cancelled)
    if engine is not None and voice not in engine.get_voices():
        raise ValueError(f"Unknown voice {voice}")
    pieces: list[Any] = []
    result = []
    t = 0.0
    total_chars = max(1, sum(len(s["text"]) for s in segments))
    done_chars = 0
    for seg in segments:
        if cancelled.is_set():
            raise Cancelled()
        text = str(seg["text"]).strip()
        if fake:
            audio, words = _fake_segment(text, speed)
            sounds = fake_sounds(words)
        else:
            audio, words, sounds = _segment(engine, text, voice, speed)
        dur = len(audio) / SAMPLE_RATE
        result.append(
            {
                "id": seg["id"],
                "start": round(t, 3),
                "end": round(t + dur, 3),
                "words": [
                    {
                        "text": w["text"],
                        "start": round(t + w["start"], 3),
                        "end": round(t + w["end"], 3),
                    }
                    for w in words
                ],
                # Per-sound timings (IPA symbols) for mouth shapes (ADR-049).
                "sounds": [
                    {
                        "p": snd["p"],
                        "start": round(t + snd["start"], 3),
                        "end": round(t + snd["end"], 3),
                    }
                    for snd in sounds
                ],
            }
        )
        pieces.append(audio)
        pad = int(gap * SAMPLE_RATE)
        pieces.append([0.0] * pad)
        t += dur + gap
        done_chars += len(text)
        progress(0.65 + 0.35 * done_chars / total_chars, "Speaking…")
    duration = _write_wav(str(params["out"]), pieces)
    return {"out": params["out"], "duration": round(duration, 3), "segments": result}
