"""Human-like AI voice (ADR-051): Chatterbox Turbo (Resemble AI, MIT) in its own Python
environment, installed once into the models folder, with the built-in voice or a voice cloned
from a sample you have the rights to.

Chatterbox pins its own torch, transformers and gradio, so it never shares the sidecar's
environment: uv makes a separate one (Python 3.12, CUDA PyTorch on Windows) and
`chatterbox_worker.py` runs in it. Chatterbox gives no timings, so Whisper (when installed) times
the words it said; they are matched to the script's own words, and each word's sounds (Kokoro's
phonemiser) are spread over it for the mouth shapes. Without Whisper, words are timed by length.

RECIT_FAKE_VOICEHQ=1 stands in for the model with the fake voice's tones (tests).
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
import wave
from collections.abc import Callable
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any

from . import tts
from .rpc import log

FOLDER = "chatterbox"
PACKAGE = "chatterbox-tts==0.1.7"
TORCH = ["torch==2.6.0", "torchaudio==2.6.0"]
TORCH_INDEX = "https://download.pytorch.org/whl/cu124"
SAMPLE_RATE = 24000
GAP = 0.35


class Cancelled(Exception):
    pass


def _fake() -> bool:
    return os.environ.get("RECIT_FAKE_VOICEHQ") == "1"


def root(models_dir: str) -> Path:
    return Path(models_dir) / FOLDER


def python_exe(models_dir: str) -> Path:
    env = root(models_dir) / "env"
    return env / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")


def _marker(models_dir: str) -> Path:
    return root(models_dir) / "installed.json"


def status(models_dir: str) -> dict[str, Any]:
    if _fake():
        return {"available": True, "engine": "fake", "installable": True}
    ok = python_exe(models_dir).is_file() and _marker(models_dir).is_file()
    return {"available": ok, "engine": "Chatterbox Turbo (Resemble AI)", "installable": True}


def _env(models_dir: str, offline: bool = False) -> dict[str, str]:
    env = {**os.environ, "HF_HOME": str(root(models_dir) / "hf"), "PYTHONUTF8": "1"}
    env.pop("VIRTUAL_ENV", None)
    if offline:
        env["HF_HUB_OFFLINE"] = "1"
    return env


def _run(
    args: list[str],
    cancelled: threading.Event,
    env: dict[str, str] | None = None,
    on_line: Callable[[str], None] | None = None,
) -> list[str]:
    """Runs a program (never with the sidecar's stdin, the JSON-RPC channel); returns its output
    lines. Raises with the last lines on failure; kills it on cancel."""
    flags = 0x08000000 if sys.platform == "win32" else 0
    proc = subprocess.Popen(
        args,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env=env,
        creationflags=flags,
    )
    lines: list[str] = []

    def read() -> None:
        assert proc.stdout is not None
        for raw in proc.stdout:
            line = raw.decode("utf-8", "replace").rstrip()
            lines.append(line)
            del lines[:-400]
            if on_line:
                on_line(line)

    t = threading.Thread(target=read, daemon=True)
    t.start()
    while proc.poll() is None:
        if cancelled.wait(0.2):
            proc.kill()
            raise Cancelled()
    t.join(timeout=5)
    if proc.returncode != 0:
        detail = "\n".join(line for line in lines[-12:] if line.strip())
        raise RuntimeError(f"{Path(args[0]).name} failed: {detail[-600:]}")
    return lines


def install(
    params: dict[str, Any], progress: Callable[..., None], cancelled: threading.Event
) -> dict[str, Any]:
    """Python 3.12 environment, PyTorch (CUDA on Windows), Chatterbox and the model; ~5 GB."""
    models_dir = str(params["modelsDir"])
    if _fake():
        progress(1.0, "Installed")
        return {"installed": True}
    uv = str(params.get("uv") or "uv")
    env_dir = root(models_dir) / "env"
    root(models_dir).mkdir(parents=True, exist_ok=True)
    base_env = _env(models_dir)
    try:
        progress(0.02, "Setting up Python for the voice…")
        if not python_exe(models_dir).is_file():
            _run([uv, "venv", "--python", "3.12", "--seed", str(env_dir)], cancelled, base_env)
        py = str(python_exe(models_dir))
        progress(0.08, "Downloading PyTorch (about 2.5 GB, once)…")
        torch_args = [uv, "pip", "install", "--python", py, *TORCH]
        if sys.platform == "win32":
            torch_args += ["--index-url", TORCH_INDEX]
        _run(torch_args, cancelled, base_env)
        progress(0.6, "Installing Chatterbox…")
        _run([uv, "pip", "install", "--python", py, PACKAGE, *TORCH], cancelled, base_env)
        progress(0.75, "Downloading the voice model…")
        _worker(models_dir, {"mode": "download"}, cancelled, progress, offline=False)
        _marker(models_dir).write_text(json.dumps({"package": PACKAGE}), encoding="utf-8")
    except Cancelled:
        raise
    progress(1.0, "Installed")
    return {"installed": True}


def _worker(
    models_dir: str,
    request: dict[str, Any],
    cancelled: threading.Event,
    progress: Callable[..., None],
    offline: bool = True,
) -> dict[str, Any]:
    req_path = root(models_dir) / f"request-{os.getpid()}-{threading.get_ident()}.json"
    req_path.write_text(json.dumps(request), encoding="utf-8")
    script = Path(__file__).with_name("chatterbox_worker.py")
    result: dict[str, Any] = {}
    error: list[str] = []

    def on_line(line: str) -> None:
        if not line.startswith("{"):
            return
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            return
        if "progress" in msg:
            progress(float(msg["progress"]), msg.get("message"))
        if "done" in msg:
            result.update(msg["done"])
        if "error" in msg:
            error.append(str(msg["error"]))

    try:
        _run(
            [str(python_exe(models_dir)), "-I", str(script), str(req_path)],
            cancelled,
            _env(models_dir, offline=offline),
            on_line,
        )
    except RuntimeError as e:
        raise RuntimeError(f"The human-like voice failed: {error[0] if error else e}") from e
    finally:
        req_path.unlink(missing_ok=True)
    return result


# ---- Speaking ---------------------------------------------------------------------------------


def run(
    params: dict[str, Any], progress: Callable[..., None], cancelled: threading.Event
) -> dict[str, Any]:
    """Same result as the Kokoro voice (tts.run): one WAV with parts separated by short gaps, and
    per part its start, end, words and sounds."""
    segments = params["segments"]
    models_dir = str(params["modelsDir"])
    voice = str(params.get("sample") or "builtin")
    gap = float(params.get("gap", GAP))
    out = Path(str(params["out"]))
    work = out.parent / f".{out.stem}-voice"
    work.mkdir(parents=True, exist_ok=True)
    parts = [{"id": f"p{i}", "text": str(s["text"]).strip()} for i, s in enumerate(segments)]
    if _fake():
        audio_parts = []
        for p in parts:
            samples, _words = tts._fake_segment(p["text"], 1.0)
            audio_parts.append(samples)
            _write_pcm(work / f"{p['id']}.wav", samples, SAMPLE_RATE)
    else:
        if not status(models_dir)["available"]:
            raise RuntimeError("Install the human-like voice first.")
        done = _worker(
            models_dir,
            {"mode": "speak", "parts": parts, "voice": voice, "outDir": str(work)},
            cancelled,
            lambda p, m=None: progress(0.8 * p, m),
        )
        if len(done.get("parts", [])) != len(parts):
            raise RuntimeError("The human-like voice returned no audio.")
        audio_parts = [_read_pcm(work / f"{p['id']}.wav") for p in parts]

    progress(0.82, "Timing the words…")
    result = []
    pieces: list[Any] = []
    t = 0.0
    for seg, part, samples in zip(segments, parts, audio_parts, strict=True):
        if cancelled.is_set():
            raise Cancelled()
        dur = len(samples) / SAMPLE_RATE
        words = time_words(part["text"], _whisper_words(work, part["id"], models_dir), samples)
        sounds = sounds_for(words)
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
                    }  # noqa: E501
                    for w in words
                ],
                "sounds": [
                    {"p": s["p"], "start": round(t + s["start"], 3), "end": round(t + s["end"], 3)}
                    for s in sounds
                ],
            }
        )
        pieces.append(samples)
        pieces.append([0.0] * int(gap * SAMPLE_RATE))
        t += dur + gap
    duration = tts._write_wav(str(out), pieces)
    progress(1.0, "Voice ready")
    return {"out": str(out), "duration": round(duration, 3), "segments": result}


def _read_pcm(path: Path) -> list[float]:
    import numpy as np

    with wave.open(str(path), "rb") as w:
        data = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32)
        if w.getnchannels() > 1:
            data = data.reshape(-1, w.getnchannels()).mean(axis=1)
    return (data / 32768.0).tolist()


def _write_pcm(path: Path, samples: list[float], rate: int) -> None:
    import struct

    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"".join(struct.pack("<h", int(max(-1, min(1, v)) * 32767)) for v in samples))


def _whisper_words(work: Path, part_id: str, models_dir: str) -> list[dict[str, Any]] | None:
    """Whisper's word timings for one part, or None when Whisper is not installed or fails."""
    low = work / f"{part_id}-16k.wav"
    if _fake() or not low.is_file():
        return None
    try:
        from . import transcribe

        result = transcribe._whisper(
            str(low),
            {"device": "auto", "modelsDir": models_dir, "language": "en"},
            lambda *a, **k: None,
            threading.Event(),
        )
        return list(result["words"])
    except Exception as e:  # noqa: BLE001 - timing by length instead
        log("whisper timing unavailable:", e)
        return None


def _norm(word: str) -> str:
    return re.sub(r"[^\w]", "", word.lower())


def speech_span(samples: list[float]) -> tuple[float, float]:
    """Start and end of speech (first and last 20 ms window above a quiet level)."""
    import numpy as np

    a = np.abs(np.asarray(samples, dtype=np.float32))
    win = SAMPLE_RATE // 50
    if len(a) < win:
        return 0.0, len(a) / SAMPLE_RATE
    level = a[: len(a) // win * win].reshape(-1, win).max(axis=1)
    loud = np.nonzero(level > max(0.02, level.max() * 0.08))[0]
    if not len(loud):
        return 0.0, len(a) / SAMPLE_RATE
    return loud[0] * win / SAMPLE_RATE, (loud[-1] + 1) * win / SAMPLE_RATE


def time_words(
    text: str, heard: list[dict[str, Any]] | None, samples: list[float]
) -> list[dict[str, Any]]:
    """The script's own words with times: matched to what Whisper heard where the words agree,
    interpolated where they do not, or spread by length over the speech without Whisper."""
    words = tts.split_words(text)
    if not words:
        return []
    start, end = speech_span(samples)
    if not heard:
        weights = [max(1, len(_norm(w))) + 1 for w in words]
        total = sum(weights)
        out, t = [], start
        for w, k in zip(words, weights, strict=True):
            d = (end - start) * k / total
            out.append({"text": w, "start": t, "end": t + d * 0.9})
            t += d
        return out
    times: list[tuple[float, float] | None] = [None] * len(words)
    a = [_norm(w) for w in words]
    b = [_norm(str(h["text"])) for h in heard]
    for block in SequenceMatcher(a=a, b=b, autojunk=False).get_matching_blocks():
        for k in range(block.size):
            h = heard[block.b + k]
            times[block.a + k] = (float(h["start"]), float(h["end"]))
    # Fill unmatched runs evenly between their known neighbours.
    i = 0
    while i < len(words):
        if times[i] is not None:
            i += 1
            continue
        j = i
        while j < len(words) and times[j] is None:
            j += 1
        left = times[i - 1][1] if i > 0 and times[i - 1] else start  # type: ignore[index]
        right = times[j][0] if j < len(words) and times[j] else end  # type: ignore[index]
        right = max(right, left + 0.05 * (j - i))
        step = (right - left) / (j - i)
        for k in range(i, j):
            times[k] = (left + (k - i) * step, left + (k - i + 1) * step)
        i = j
    return [
        {"text": w, "start": t[0], "end": max(t[0], t[1])}
        for w, t in zip(words, times, strict=True)
        if t is not None
    ]


_tokenizer: Any = None


def phonemes(word: str) -> str:
    """IPA for one word (Kokoro's phonemiser); the word's letters when that is not installed."""
    global _tokenizer
    try:
        if _tokenizer is None:
            from kokoro_onnx.tokenizer import Tokenizer

            _tokenizer = Tokenizer()
        return str(_tokenizer.phonemize(word, "en-us"))
    except Exception:  # noqa: BLE001
        return re.sub(r"[^a-z]", "", word.lower()) or "a"


def sounds_for(words: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Per-sound timings for the mouth: each word's phonemes spread evenly over its time."""
    out: list[dict[str, Any]] = []
    for w in words:
        symbols = [c for c in phonemes(str(w["text"])) if not c.isspace()]
        if not symbols:
            continue
        step = (w["end"] - w["start"]) / len(symbols)
        for i, c in enumerate(symbols):
            out.append({"p": c, "start": w["start"] + i * step, "end": w["start"] + (i + 1) * step})
        out.append({"p": " ", "start": w["end"], "end": w["end"]})
    return out


# ---- Voice samples ----------------------------------------------------------------------------


def add_sample(params: dict[str, Any]) -> dict[str, Any]:
    """Turns a recording into a voice sample: mono 24 kHz WAV, the first 15 s, at least 5 s."""
    src = str(params["path"])
    out = Path(str(params["out"]))
    out.parent.mkdir(parents=True, exist_ok=True)
    flags = 0x08000000 if sys.platform == "win32" else 0
    proc = subprocess.run(
        [
            str(params["ffmpeg"]),
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            src,
            "-t",
            "15",
            "-vn",
            "-ac",
            "1",
            "-ar",
            str(SAMPLE_RATE),
            "-c:a",
            "pcm_s16le",
            str(out),
        ],
        stdin=subprocess.DEVNULL,
        capture_output=True,
        creationflags=flags,
        timeout=120,
    )
    if proc.returncode != 0 or not out.is_file():
        raise RuntimeError("Could not read that recording.")
    with wave.open(str(out), "rb") as w:
        seconds = w.getnframes() / w.getframerate()
    if seconds < 5.0:
        out.unlink(missing_ok=True)
        raise RuntimeError("The sample needs at least 5 seconds of speech.")
    return {"out": str(out), "seconds": round(seconds, 2)}
