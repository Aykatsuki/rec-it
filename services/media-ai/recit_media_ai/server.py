from __future__ import annotations

import platform
import time
from typing import Any

from . import __version__, card, faces, images, lipsync, talking, transcribe, tts, voicehq
from .rpc import INVALID_PARAMS, RpcError, Server, log
from .system import cuda_status, query_gpus


def ping(params: dict[str, Any]) -> dict[str, Any]:
    return {"pong": True, "time": time.time(), "echo": params.get("echo")}


def version(_: dict[str, Any]) -> dict[str, Any]:
    return {"version": __version__, "python": platform.python_version()}


def system_info(_: dict[str, Any]) -> dict[str, Any]:
    gpus = query_gpus()
    return {
        "gpus": gpus,
        "cuda": cuda_status(gpus),
        "transcription": transcribe.available(),
        "faces": faces.available(),
        "voice": tts.available(),
    }


def transcribe_job(params: dict[str, Any], progress: Any, cancelled: Any) -> dict[str, Any]:
    for key in ("audio", "out"):
        if not isinstance(params.get(key), str):
            raise RpcError(INVALID_PARAMS, f"{key} must be a file path")
    status = transcribe.available()
    if not status["available"]:
        raise RpcError(-32001, "Transcription is not installed", status)
    return transcribe.run(params, progress, cancelled)


def faces_job(params: dict[str, Any], progress: Any, cancelled: Any) -> dict[str, Any]:
    for key in ("video", "out", "ffmpeg"):
        if not isinstance(params.get(key), str):
            raise RpcError(INVALID_PARAMS, f"{key} must be a file path")
    for key in ("width", "height"):
        if not isinstance(params.get(key), int) or params[key] <= 0:
            raise RpcError(INVALID_PARAMS, f"{key} must be a positive whole number")
    status = faces.available()
    if not status["available"]:
        raise RpcError(-32001, "Face detection is not installed", status)
    try:
        return faces.run(params, progress, cancelled)
    except faces.Cancelled as e:
        raise RpcError(-32800, "Cancelled") from e


def tts_job(params: dict[str, Any], progress: Any, cancelled: Any) -> dict[str, Any]:
    segments = params.get("segments")
    if (
        not isinstance(segments, list)
        or not segments
        or not all(isinstance(s, dict) and isinstance(s.get("text"), str) for s in segments)
    ):
        raise RpcError(INVALID_PARAMS, "segments must be a list of {id, text}")
    if not isinstance(params.get("out"), str):
        raise RpcError(INVALID_PARAMS, "out must be a file path")
    status = tts.available()
    if not status["available"]:
        raise RpcError(-32001, "AI voice is not installed", status)
    try:
        return tts.run(params, progress, cancelled)
    except tts.Cancelled as e:
        raise RpcError(-32800, "Cancelled") from e


def card_render(params: dict[str, Any]) -> dict[str, Any]:
    for key in ("out", "fontsDir", "title"):
        if not isinstance(params.get(key), str):
            raise RpcError(INVALID_PARAMS, f"{key} must be text")
    return card.render(params)


def images_status(params: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(params.get("modelsDir"), str):
        raise RpcError(INVALID_PARAMS, "modelsDir must be a folder")
    return images.status(params["modelsDir"])


def images_install_job(params: dict[str, Any], progress: Any, cancelled: Any) -> dict[str, Any]:
    if not isinstance(params.get("modelsDir"), str):
        raise RpcError(INVALID_PARAMS, "modelsDir must be a folder")
    try:
        return images.install(params, progress, cancelled)
    except images.Cancelled as e:
        raise RpcError(-32800, "Cancelled") from e


def images_job(params: dict[str, Any], progress: Any, cancelled: Any) -> dict[str, Any]:
    prompts = params.get("prompts")
    if not isinstance(prompts, list) or not prompts or not all(isinstance(p, str) for p in prompts):
        raise RpcError(INVALID_PARAMS, "prompts must be a list of text")
    for key in ("outDir", "modelsDir"):
        if not isinstance(params.get(key), str):
            raise RpcError(INVALID_PARAMS, f"{key} must be a folder")
    if not images.status(params["modelsDir"])["available"]:
        raise RpcError(-32001, "The picture engine is not installed")
    try:
        return images.generate(params, progress, cancelled)
    except images.Cancelled as e:
        raise RpcError(-32800, "Cancelled") from e


def talking_status(params: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(params.get("modelsDir"), str):
        raise RpcError(INVALID_PARAMS, "modelsDir must be a folder")
    return talking.status(params["modelsDir"])


def talking_install_job(params: dict[str, Any], progress: Any, cancelled: Any) -> dict[str, Any]:
    if not isinstance(params.get("modelsDir"), str):
        raise RpcError(INVALID_PARAMS, "modelsDir must be a folder")
    try:
        return talking.install(params, progress, cancelled)
    except talking.Cancelled as e:
        raise RpcError(-32800, "Cancelled") from e


def talk_job(params: dict[str, Any], progress: Any, cancelled: Any) -> dict[str, Any]:
    for key in ("modelsDir", "image", "audio", "out", "ffmpeg"):
        if not isinstance(params.get(key), str):
            raise RpcError(INVALID_PARAMS, f"{key} must be a path")
    if not isinstance(params.get("seconds"), (int, float)) or params["seconds"] <= 0:
        raise RpcError(INVALID_PARAMS, "seconds must be positive")
    if not talking.status(params["modelsDir"])["available"]:
        raise RpcError(-32001, "The animation engine is not installed")
    try:
        return talking.talk(params, progress, cancelled)
    except talking.Cancelled as e:
        raise RpcError(-32800, "Cancelled") from e


def lipsync_status(params: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(params.get("modelsDir"), str):
        raise RpcError(INVALID_PARAMS, "modelsDir must be a folder")
    return lipsync.status(params["modelsDir"])


def lipsync_install_job(params: dict[str, Any], progress: Any, cancelled: Any) -> dict[str, Any]:
    if not isinstance(params.get("modelsDir"), str):
        raise RpcError(INVALID_PARAMS, "modelsDir must be a folder")
    try:
        return lipsync.install(params, progress, cancelled)
    except lipsync.Cancelled as e:
        raise RpcError(-32800, "Cancelled") from e


def lipsync_shapes_job(params: dict[str, Any], progress: Any, cancelled: Any) -> dict[str, Any]:
    for key in ("modelsDir", "base", "outDir"):
        if not isinstance(params.get(key), str):
            raise RpcError(INVALID_PARAMS, f"{key} must be a path")
    if not lipsync.status(params["modelsDir"])["available"]:
        raise RpcError(-32001, "The mouth-shape engine is not installed")
    try:
        return lipsync.make_shapes(params, progress, cancelled)
    except lipsync.Cancelled as e:
        raise RpcError(-32800, "Cancelled") from e


def lipsync_render_job(params: dict[str, Any], progress: Any, cancelled: Any) -> dict[str, Any]:
    if not isinstance(params.get("shapes"), dict) or "rest" not in params["shapes"]:
        raise RpcError(INVALID_PARAMS, "shapes must include rest")
    if not isinstance(params.get("sounds"), list):
        raise RpcError(INVALID_PARAMS, "sounds must be a list")
    for key in ("out", "ffmpeg"):
        if not isinstance(params.get(key), str):
            raise RpcError(INVALID_PARAMS, f"{key} must be a path")
    if not isinstance(params.get("duration"), (int, float)) or params["duration"] <= 0:
        raise RpcError(INVALID_PARAMS, "duration must be positive")
    try:
        return lipsync.render(params, progress, cancelled)
    except lipsync.Cancelled as e:
        raise RpcError(-32800, "Cancelled") from e


def voicehq_status(params: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(params.get("modelsDir"), str):
        raise RpcError(INVALID_PARAMS, "modelsDir must be a folder")
    return voicehq.status(params["modelsDir"])


def voicehq_install_job(params: dict[str, Any], progress: Any, cancelled: Any) -> dict[str, Any]:
    if not isinstance(params.get("modelsDir"), str):
        raise RpcError(INVALID_PARAMS, "modelsDir must be a folder")
    try:
        return voicehq.install(params, progress, cancelled)
    except voicehq.Cancelled as e:
        raise RpcError(-32800, "Cancelled") from e


def voicehq_speak_job(params: dict[str, Any], progress: Any, cancelled: Any) -> dict[str, Any]:
    segments = params.get("segments")
    if not isinstance(segments, list) or not segments:
        raise RpcError(INVALID_PARAMS, "segments must be a list")
    for key in ("out", "modelsDir"):
        if not isinstance(params.get(key), str):
            raise RpcError(INVALID_PARAMS, f"{key} must be a path")
    try:
        return voicehq.run(params, progress, cancelled)
    except voicehq.Cancelled as e:
        raise RpcError(-32800, "Cancelled") from e


def voicehq_add_sample(params: dict[str, Any]) -> dict[str, Any]:
    for key in ("path", "out", "ffmpeg"):
        if not isinstance(params.get(key), str):
            raise RpcError(INVALID_PARAMS, f"{key} must be a path")
    return voicehq.add_sample(params)


def backgrounds_render(params: dict[str, Any]) -> dict[str, Any]:
    items = params.get("items")
    if not isinstance(items, list) or not items:
        raise RpcError(INVALID_PARAMS, "items must be a list of {out, palette, seed}")
    return {"images": [card.background(dict(item))["out"] for item in items]}


def debug_sleep(params: dict[str, Any]) -> dict[str, Any]:
    """Test helper for timeouts and cancellation."""
    seconds = params.get("seconds")
    if not isinstance(seconds, (int, float)) or not 0 <= seconds <= 30:
        raise RpcError(INVALID_PARAMS, "seconds must be a number between 0 and 30")
    time.sleep(seconds)
    return {"slept": seconds}


HANDLERS = {
    "ping": ping,
    "version": version,
    "system.info": system_info,
    "debug.sleep": debug_sleep,
    "card.render": card_render,
    "images.status": images_status,
    "talking.status": talking_status,
    "lipsync.status": lipsync_status,
    "voicehq.status": voicehq_status,
    "voicehq.addSample": voicehq_add_sample,
    "backgrounds.render": backgrounds_render,
}


def main() -> int:
    log(f"starting v{__version__} on Python {platform.python_version()}")
    Server(
        HANDLERS,
        jobs={
            "transcribe": transcribe_job,
            "faces": faces_job,
            "tts": tts_job,
            "images": images_job,
            "images.install": images_install_job,
            "talking.install": talking_install_job,
            "talk": talk_job,
            "lipsync.install": lipsync_install_job,
            "lipsync.shapes": lipsync_shapes_job,
            "lipsync.render": lipsync_render_job,
            "voicehq.install": voicehq_install_job,
            "voicehq.speak": voicehq_speak_job,
        },
    ).serve()
    log("stdin closed, exiting")
    return 0
