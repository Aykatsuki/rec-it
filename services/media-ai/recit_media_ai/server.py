from __future__ import annotations

import platform
import time
from typing import Any

from . import __version__, transcribe
from .rpc import INVALID_PARAMS, RpcError, Server, log
from .system import cuda_status, query_gpus


def ping(params: dict[str, Any]) -> dict[str, Any]:
    return {"pong": True, "time": time.time(), "echo": params.get("echo")}


def version(_: dict[str, Any]) -> dict[str, Any]:
    return {"version": __version__, "python": platform.python_version()}


def system_info(_: dict[str, Any]) -> dict[str, Any]:
    gpus = query_gpus()
    return {"gpus": gpus, "cuda": cuda_status(gpus), "transcription": transcribe.available()}


def transcribe_job(params: dict[str, Any], progress: Any, cancelled: Any) -> dict[str, Any]:
    for key in ("audio", "out"):
        if not isinstance(params.get(key), str):
            raise RpcError(INVALID_PARAMS, f"{key} must be a file path")
    status = transcribe.available()
    if not status["available"]:
        raise RpcError(-32001, "Transcription is not installed", status)
    return transcribe.run(params, progress, cancelled)


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
}


def main() -> int:
    log(f"starting v{__version__} on Python {platform.python_version()}")
    Server(HANDLERS, jobs={"transcribe": transcribe_job}).serve()
    log("stdin closed, exiting")
    return 0
