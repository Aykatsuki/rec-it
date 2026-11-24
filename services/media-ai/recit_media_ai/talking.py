"""Talking characters (ADR-048): Wan 2.2 S2V through the same stable-diffusion.cpp engine as the
AI pictures. One character picture plus one spoken line becomes a short clip of the character
saying it, with lip sync. Everything runs on this PC.

Sized for the reference PC (RTX 3070 8 GB, 16 GB RAM): the smallest usable S2V file, the 4-step
lightning LoRA (CFG 1), 480x832 (9:16) and at most one S2V chunk (81 frames, about 5 s at the
model's fixed 16 fps). The engine's auto-fit spreads the 14B weights over VRAM, RAM and disk.

RECIT_FAKE_TALK=1 makes a still clip from the picture and the line with FFmpeg (tests).
"""

from __future__ import annotations

import math
import os
import subprocess
import sys
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

from . import images

HF = images.HF
#: (local name, URL, approximate size for progress). Hashes come from Hugging Face's published
#: SHA-256 at download time (images.published_sha256).
TALK_FILES = [
    (
        "Wan2.2-S2V-14B-Q3_K_S.gguf",
        HF + "QuantStack/Wan2.2-S2V-14B-GGUF/resolve/main/Wan2.2-S2V-14B-Q3_K_S.gguf",
        10_700_000_000,
    ),
    (
        "umt5-xxl-encoder-Q5_K_M.gguf",
        HF + "city96/umt5-xxl-encoder-gguf/resolve/main/umt5-xxl-encoder-Q5_K_M.gguf",
        4_150_000_000,
    ),
    (
        "wav2vec2_large_english_fp16.safetensors",
        HF
        + "Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/audio_encoders/"
        + "wav2vec2_large_english_fp16.safetensors",
        630_000_000,
    ),
    (
        "wan_2.1_vae.safetensors",
        HF
        + "Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/"
        + "wan_2.1_vae.safetensors",
        254_000_000,
    ),
]
#: The 4-step lightning LoRA (low-noise variant; the high-noise one breaks S2V). Kept in its own
#: folder because sd-cli loads LoRAs by name from --lora-model-dir.
LORA = (
    "wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors",
    HF
    + "Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/loras/"
    + "wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors",
    1_230_000_000,
)
FOLDER = "wan2.2-s2v"
WIDTH, HEIGHT = 480, 832
FPS = 16
MAX_FRAMES = 81
STEPS = 4
#: Wan's standard negative prompt (it was trained with Chinese negatives): garish colours,
#: overexposure, static, blurry, subtitles, worst quality, extra fingers, deformed faces, still
#: frame, cluttered background, many people in the background, walking backwards.
NEGATIVE = (
    "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，"
    "低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，画得不好的手部，画得不好的脸部，畸形的，"
    "毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走"
)


class Cancelled(Exception):
    pass


def _fake() -> bool:
    return os.environ.get("RECIT_FAKE_TALK") == "1"


def model_dir(models_dir: str) -> Path:
    return Path(models_dir) / FOLDER


def lora_dir(models_dir: str) -> Path:
    return model_dir(models_dir) / "loras"


def _missing(models_dir: str) -> list[tuple[str, Path, str | None, int, bool]]:
    plan: list[tuple[str, Path, str | None, int, bool]] = []
    for name, url, size in TALK_FILES:
        target = model_dir(models_dir) / name
        if not target.is_file():
            plan.append((url, target, None, size, False))
    name, url, size = LORA
    if not (lora_dir(models_dir) / name).is_file():
        plan.append((url, lora_dir(models_dir) / name, None, size, False))
    return plan


def status(models_dir: str) -> dict[str, Any]:
    """Whether talking clips can be made, and if not, whether this computer can install them."""
    if _fake():
        return {"available": True, "engine": "fake", "installable": True}
    installable = sys.platform == "win32" or bool(os.environ.get("RECIT_SD_CLI"))
    available = bool(images.sd_cli(models_dir)) and not _missing(models_dir)
    return {
        "available": available,
        "engine": "Wan 2.2 S2V (stable-diffusion.cpp)",
        "installable": installable,
        **(
            {} if installable else {"reason": "Set RECIT_SD_CLI to an sd-cli build on this system."}
        ),
    }


def install(
    params: dict[str, Any], progress: Callable[..., None], cancelled: threading.Event
) -> dict[str, Any]:
    models_dir = str(params["modelsDir"])
    if _fake():
        progress(1.0, "Installed")
        return {"installed": True}
    try:
        plan = images.engine_plan(models_dir) + _missing(models_dir)
        images.run_downloads(plan, "the animation engine", progress, cancelled)
    except images.Cancelled as e:
        raise Cancelled() from e
    return {"installed": True}


def frames_for(seconds: float) -> int:
    """Frames for a line of `seconds` at 16 fps: 4n+1 (whole latent frames), 17 to 81."""
    n = math.ceil(max(0.5, seconds) * FPS / 4)
    return min(MAX_FRAMES, max(17, 4 * n + 1))


def talk(
    params: dict[str, Any], progress: Callable[..., None], cancelled: threading.Event
) -> dict[str, Any]:
    """Animates `image` speaking `audio` into `out` (.avi, 16 fps, no sound: the voice stays a
    separate clip). Returns the clip's path, frames and length in seconds."""
    models_dir = str(params["modelsDir"])
    image = Path(str(params["image"]))
    audio = Path(str(params["audio"]))
    out = Path(str(params["out"])).with_suffix(".avi")
    seconds = float(params["seconds"])
    prompt = str(params.get("prompt") or "a character is talking")
    seed = int(params.get("seed", 42))
    frames = frames_for(seconds)
    out.parent.mkdir(parents=True, exist_ok=True)
    progress(0.02, "Animating the character…")
    if _fake():
        _fake_clip(str(params["ffmpeg"]), image, out, frames / FPS)
    else:
        lora = Path(LORA[0]).stem
        m = model_dir(models_dir)
        args = [
            "-M",
            "vid_gen",
            "--diffusion-model",
            str(m / TALK_FILES[0][0]),
            "--t5xxl",
            str(m / TALK_FILES[1][0]),
            "--audio-encoder",
            str(m / TALK_FILES[2][0]),
            "--vae",
            str(m / TALK_FILES[3][0]),
            "--lora-model-dir",
            str(lora_dir(models_dir)),
            "-p",
            f"{prompt}<lora:{lora}:1.0>",
            "-n",
            NEGATIVE,
            "-i",
            str(image),
            "--audio",
            str(audio),
            "--cfg-scale",
            "1.0",
            "--steps",
            str(STEPS),
            "--sampling-method",
            "euler",
            "--flow-shift",
            "3.0",
            "-W",
            str(WIDTH),
            "-H",
            str(HEIGHT),
            "--video-frames",
            str(frames),
            "-s",
            str(seed),
            "--vae-tiling",
            *images.MEMORY_ARGS,
            "-o",
            str(out),
        ]

        def step(done: int, total: int) -> None:
            progress(
                0.05 + 0.9 * done / max(1, total),
                f"Animating the character (step {done} of {total})…",
            )

        try:
            images.run_engine(models_dir, args, out, cancelled, step, "The animation engine")
        except images.Cancelled as e:
            raise Cancelled() from e
    progress(1.0, "Clip ready")
    return {"video": str(out), "frames": frames, "seconds": frames / FPS}


def _fake_clip(ffmpeg: str, image: Path, out: Path, seconds: float) -> None:
    """A still 480x832 MJPEG clip of the picture (stands in for the model in tests)."""
    flags = 0x08000000 if sys.platform == "win32" else 0
    subprocess.run(
        [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-loop",
            "1",
            "-i",
            str(image),
            "-t",
            f"{seconds:.3f}",
            "-r",
            str(FPS),
            "-vf",
            f"scale={WIDTH}:{HEIGHT},format=yuvj420p",
            "-c:v",
            "mjpeg",
            str(out),
        ],
        check=True,
        creationflags=flags,
    )
