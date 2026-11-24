"""AI pictures for generated Shorts (Phase 8, ADR-047).

Z-Image Turbo (Apache-2.0, 6B parameters, 8 steps) run by stable-diffusion.cpp (MIT) as a
separate program, so no PyTorch is needed and it fits an 8 GB graphics card: the diffusion model
is a 4-bit GGUF, the Qwen3-4B text encoder too, and weights are offloaded to system memory
between stages.

The engine (Windows CUDA build) and the models download once into the models folder; each file
is checked against a pinned SHA-256 (engine) or the SHA-256 Hugging Face reports for it (models).
RECIT_SD_CLI points at another sd-cli build (Linux, macOS, or a newer one). RECIT_FAKE_IMAGES=1
draws a gradient per prompt instead (tests).
"""

from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import sys
import threading
import urllib.error
import urllib.request
import zipfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .rpc import log

ENGINE_TAG = "master-1122-3b12781"
ENGINE_URL = f"https://github.com/leejet/stable-diffusion.cpp/releases/download/{ENGINE_TAG}/"
#: Windows x64 CUDA 12 build and the CUDA runtime it needs: (file, SHA-256, size).
ENGINE_FILES = [
    (
        "sd-master-3b12781-bin-win-cuda12-x64.zip",
        "34169b12181ae75e520d662bdccefd89095ba02d79c3ccb9568531afea1c3dd1",
        413_082_709,
    ),
    (
        "cudart-sd-bin-win-cu12-x64.zip",
        "fe20366827d357c00797eebb58244dddab7fd9a348d70090c3871004c320f38d",
        563_452_046,
    ),
]
HF = "https://huggingface.co/"
#: Model files: (local name, URL, approximate size for progress).
MODEL_FILES = [
    (
        "z_image_turbo-Q4_0.gguf",
        HF + "leejet/Z-Image-Turbo-GGUF/resolve/main/z_image_turbo-Q4_0.gguf",
        3_680_000_000,
    ),
    (
        "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
        HF + "unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/main/Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
        2_500_000_000,
    ),
    (
        "ae.safetensors",
        HF + "Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors",
        335_000_000,
    ),
]
FOLDER = "z-image-turbo"
#: Picture size: 9:16, multiples of 64.
WIDTH, HEIGHT = 576, 1024


class Cancelled(Exception):
    pass


def _fake() -> bool:
    return os.environ.get("RECIT_FAKE_IMAGES") == "1"


def engine_dir(models_dir: str) -> Path:
    return Path(models_dir) / f"sd-cpp-{ENGINE_TAG}"


def model_dir(models_dir: str) -> Path:
    return Path(models_dir) / FOLDER


def sd_cli(models_dir: str) -> Path | None:
    override = os.environ.get("RECIT_SD_CLI")
    if override:
        return Path(override) if Path(override).is_file() else None
    exe = engine_dir(models_dir) / ("sd-cli.exe" if sys.platform == "win32" else "sd-cli")
    return exe if exe.is_file() else None


def status(models_dir: str) -> dict[str, Any]:
    """Whether pictures can be made, and if not, whether this computer can install the engine."""
    if _fake():
        return {"available": True, "engine": "fake", "installable": True}
    exe = sd_cli(models_dir)
    models = all((model_dir(models_dir) / name).is_file() for name, _, _ in MODEL_FILES)
    installable = sys.platform == "win32" or bool(os.environ.get("RECIT_SD_CLI"))
    return {
        "available": bool(exe) and models,
        "engine": "Z-Image Turbo (stable-diffusion.cpp)",
        "installable": installable,
        **(
            {} if installable else {"reason": "Set RECIT_SD_CLI to an sd-cli build on this system."}
        ),
    }


# ---- Install ---------------------------------------------------------------------------------


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:  # noqa: D102
        return None


def published_sha256(url: str) -> str | None:
    """The SHA-256 Hugging Face publishes for a large file (X-Linked-Etag on its redirect)."""
    opener = urllib.request.build_opener(_NoRedirect)
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "Rec-It"})
    try:
        r = opener.open(req, timeout=30)
        headers = r.headers
    except urllib.error.HTTPError as e:  # the 302 itself
        headers = e.headers
    value = (headers.get("X-Linked-Etag") or "").strip('"').lower()
    return value if re.fullmatch(r"[0-9a-f]{64}", value) else None


def _download(
    url: str,
    target: Path,
    expected: str | None,
    on_bytes: Callable[[int], None],
    cancelled: threading.Event,
) -> None:
    part = target.with_suffix(target.suffix + ".part")
    req = urllib.request.Request(url, headers={"User-Agent": "Rec-It"})
    digest = expected or published_sha256(url)
    with urllib.request.urlopen(req, timeout=60) as r, part.open("wb") as f:
        h = hashlib.sha256()
        while True:
            if cancelled.is_set():
                raise Cancelled()
            block = r.read(1 << 20)
            if not block:
                break
            f.write(block)
            h.update(block)
            on_bytes(len(block))
    if digest and h.hexdigest() != digest:
        part.unlink(missing_ok=True)
        raise RuntimeError(f"The download of {target.name} was damaged; try again.")
    part.replace(target)


def install(
    params: dict[str, Any], progress: Callable[..., None], cancelled: threading.Event
) -> dict[str, Any]:
    models_dir = str(params["modelsDir"])
    if _fake():
        progress(1.0, "Installed")
        return {"installed": True}
    plan: list[tuple[str, Path, str | None, int, bool]] = []
    if not os.environ.get("RECIT_SD_CLI"):
        if sys.platform != "win32":
            raise RuntimeError("The picture engine download is for Windows; set RECIT_SD_CLI.")
        if not sd_cli(models_dir):
            for name, digest, size in ENGINE_FILES:
                plan.append((ENGINE_URL + name, engine_dir(models_dir) / name, digest, size, True))
    for name, url, size in MODEL_FILES:
        target = model_dir(models_dir) / name
        if not target.is_file():
            plan.append((url, target, None, size, False))
    total = sum(p[3] for p in plan) or 1
    done = 0

    def tick(n: int) -> None:
        nonlocal done
        done += n
        progress(
            min(0.99, done / total),
            f"Downloading the picture engine ({done / 1e9:.1f} of {total / 1e9:.1f} GB)…",
        )

    for url, target, digest, _size, is_zip in plan:
        target.parent.mkdir(parents=True, exist_ok=True)
        log("downloading", url)
        _download(url, target, digest, tick, cancelled)
        if is_zip:
            with zipfile.ZipFile(target) as z:
                z.extractall(target.parent)
            target.unlink()
    progress(1.0, "Installed")
    return {"installed": True}


# ---- Generate --------------------------------------------------------------------------------


def _gradient_png(path: str, seed: str, width: int, height: int) -> None:
    """A vertical two-colour gradient (fake engine and motion-graphics fallback without Pillow)."""
    import struct
    import zlib

    h = hashlib.sha256(seed.encode()).digest()
    a, b = h[:3], h[3:6]
    rows = []
    for y in range(height):
        t = y / max(1, height - 1)
        px = bytes(int(a[i] + (b[i] - a[i]) * t) for i in range(3))
        rows.append(b"\x00" + px * width)
    raw = zlib.compress(b"".join(rows))

    def chunk(kind: bytes, data: bytes) -> bytes:
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", raw) + chunk(b"IEND", b"")
    Path(path).write_bytes(png)


def generate(
    params: dict[str, Any], progress: Callable[..., None], cancelled: threading.Event
) -> dict[str, Any]:
    """One picture per prompt, written as <outDir>/scene-<n>.png."""
    prompts: list[str] = [str(p) for p in params["prompts"]]
    out_dir = Path(str(params["outDir"]))
    out_dir.mkdir(parents=True, exist_ok=True)
    seed = int(params.get("seed", 42))
    width = int(params.get("width", WIDTH))
    height = int(params.get("height", HEIGHT))
    models_dir = str(params["modelsDir"])
    outputs: list[str] = []
    for i, prompt in enumerate(prompts):
        if cancelled.is_set():
            raise Cancelled()
        out = out_dir / f"scene-{i + 1}.png"
        progress(i / len(prompts), f"Drawing picture {i + 1} of {len(prompts)}…")
        if _fake():
            _gradient_png(str(out), prompt, 64, 112)
        else:
            _run_sd(models_dir, prompt, out, seed + i, width, height, cancelled)
        outputs.append(str(out))
    progress(1.0, "Pictures ready")
    return {"images": outputs}


def _run_sd(
    models_dir: str,
    prompt: str,
    out: Path,
    seed: int,
    width: int,
    height: int,
    cancelled: threading.Event,
) -> None:
    exe = sd_cli(models_dir)
    if not exe:
        raise RuntimeError("The picture engine is not installed.")
    m = model_dir(models_dir)
    args = [
        str(exe),
        "--diffusion-model",
        str(m / MODEL_FILES[0][0]),
        "--llm",
        str(m / MODEL_FILES[1][0]),
        "--vae",
        str(m / MODEL_FILES[2][0]),
        "-p",
        prompt,
        "--cfg-scale",
        "1.0",
        "--steps",
        "8",
        "-W",
        str(width),
        "-H",
        str(height),
        "-s",
        str(seed),
        # 8 GB cards: keep weights in system memory between stages; flash attention saves memory.
        "--offload-to-cpu",
        "--diffusion-fa",
        "-o",
        str(out),
    ]
    flags = 0x08000000 if sys.platform == "win32" else 0  # CREATE_NO_WINDOW
    proc = subprocess.Popen(
        args,
        cwd=str(exe.parent),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        creationflags=flags,
    )
    tail: list[str] = []
    errors: list[str] = []

    def read() -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            text = line.decode("utf-8", "replace").rstrip()
            tail.append(text)
            del tail[:-200]
            if _is_error(text) and len(errors) < 50:
                errors.append(text)

    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    while proc.poll() is None:
        if cancelled.wait(0.2):
            proc.kill()
            raise Cancelled()
    reader.join(timeout=2)
    if proc.returncode != 0 or not out.is_file():
        log_path = engine_dir(models_dir) / "last-error.log"
        try:
            log_path.write_text("\n".join([" ".join(args[:1] + ["…"]), *tail]), encoding="utf-8")
        except OSError:
            pass
        raise RuntimeError(failure_message(errors, tail, proc.returncode, log_path))


_ERROR = re.compile(r"\[(E|ERROR)\]|error|failed|out of memory", re.IGNORECASE)
_OOM = re.compile(
    r"out of memory|cudaMalloc|failed to allocate|alloc.*buffer|CUDA error", re.IGNORECASE
)


def _is_error(line: str) -> bool:
    return bool(_ERROR.search(line))


def failure_message(errors: list[str], tail: list[str], code: int | None, log_path: Path) -> str:
    """A readable reason from sd-cli's output: memory problems in plain words, otherwise the
    first error it logged (the last one is only "generate failed", which says nothing)."""
    if any(_OOM.search(e) for e in errors):
        return (
            "The graphics card ran out of memory while drawing. Close games, browsers with video "
            "and other AI apps (Ollama is closed for you), then try again. "
            f"Details: {log_path}"
        )
    useful = [e for e in errors if "generate failed" not in e] or errors
    detail = useful[0] if useful else next((t for t in reversed(tail) if t.strip()), "")
    detail = re.sub(r"^\[[A-Z]+\]\s*", "", detail.strip()) or f"exit code {code}"
    return f"The picture engine failed: {detail[:300]} (full log: {log_path})"


def remove(models_dir: str) -> None:
    """Deletes the engine and models (frees about 7 GB)."""
    shutil.rmtree(engine_dir(models_dir), ignore_errors=True)
    shutil.rmtree(model_dir(models_dir), ignore_errors=True)
