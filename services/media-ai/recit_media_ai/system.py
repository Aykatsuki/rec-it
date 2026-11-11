"""Hardware detection used by the status panel and, later, model selection."""

from __future__ import annotations

import shutil
import subprocess
from typing import Any


def query_gpus() -> list[dict[str, Any]]:
    """Lists NVIDIA GPUs via nvidia-smi (installed with the NVIDIA driver). Empty if none."""
    smi = shutil.which("nvidia-smi")
    if smi is None:
        return []
    try:
        out = subprocess.run(
            [smi, "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        ).stdout
    except (subprocess.SubprocessError, OSError):
        return []
    return parse_nvidia_smi(out)


def parse_nvidia_smi(output: str) -> list[dict[str, Any]]:
    gpus = []
    for line in output.splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) != 3:
            continue
        name, memory, driver = parts
        try:
            memory_mb = int(float(memory))
        except ValueError:
            continue
        gpus.append({"name": name, "memoryMb": memory_mb, "driverVersion": driver})
    return gpus


def cuda_status(gpus: list[dict[str, Any]]) -> dict[str, Any]:
    """Prefers CTranslate2 (the faster-whisper runtime, installed in Phase 4) when present."""
    try:
        import ctranslate2  # type: ignore[import-not-found]

        count = int(ctranslate2.get_cuda_device_count())
        return {"available": count > 0, "deviceCount": count, "via": "ctranslate2"}
    except ImportError:
        pass
    if gpus:
        return {"available": True, "deviceCount": len(gpus), "via": "nvidia-smi"}
    return {"available": False, "deviceCount": 0, "via": "none"}
