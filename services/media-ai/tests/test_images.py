import sys
import threading
from pathlib import Path

import pytest

from recit_media_ai.images import failure_message

LOG = Path("last-error.log")


def test_reports_the_first_real_error_not_the_generic_last_line() -> None:
    errors = [
        "[E] LLM prompt encoding failed",
        "[E] generate failed: line 47, column 21: prompt encoding failed --- main.cpp:815",
    ]
    message = failure_message(errors, errors, 1, LOG)
    assert "LLM prompt encoding failed" in message
    assert "line 47" not in message
    assert "last-error.log" in message


def test_out_of_memory_is_said_plainly() -> None:
    errors = [
        "[E] ggml_backend_cuda_buffer_type_alloc_buffer: allocating 2100 MiB on device 0: "
        "cudaMalloc failed: out of memory",
        "[E] generate failed: prompt encoding failed",
    ]
    message = failure_message(errors, errors, 1, LOG)
    assert message.startswith("The graphics card ran out of memory")


def test_falls_back_to_the_last_line_or_exit_code() -> None:
    assert "something odd" in failure_message([], ["", "something odd", ""], 3, LOG)
    assert "exit code 3" in failure_message([], [], 3, LOG)


def test_running_out_of_system_ram_is_said_plainly() -> None:
    errors = [
        "[E] RAM weight capacity exceeded. Requested 0 bytes, 0 bytes available, "
        "3683325184 bytes resident --- model_manager.cpp:1359",
        "[E] generate failed: line 59, column 14: diffusion output shape [] --- main.cpp:815",
    ]
    assert failure_message(errors, errors, 1, LOG).startswith("Your PC ran out of memory (RAM)")


def test_frames_for_a_line() -> None:
    from recit_media_ai.talking import frames_for

    assert frames_for(2.5) == 41  # 40 frames rounded up to 4n+1
    assert frames_for(0.1) == 17
    assert frames_for(12) == 81  # one S2V chunk at most
    assert all((frames_for(s / 10) - 1) % 4 == 0 for s in range(1, 120))


@pytest.mark.skipif(sys.platform == "win32", reason="the stand-in engine is a shell script")
def test_talking_command_and_step_progress(tmp_path, monkeypatch) -> None:
    """A stand-in sd-cli: records its arguments, prints sampling progress, writes the clip."""
    from recit_media_ai import talking

    script = tmp_path / "sd-cli"
    script.write_text(
        "#!/bin/sh\n"
        'echo "$@" > "$(dirname "$0")/args.txt"\n'
        "printf '  |=====>   | 1/4 - 20.00s/it\\r  |==========>   | 2/4 - 20.00s/it\\n'\n"
        'while [ "$1" != "-o" ]; do shift; done\n'
        'printf "AVI" > "$2"\n'
    )
    script.chmod(0o755)
    monkeypatch.setenv("RECIT_SD_CLI", str(script))
    monkeypatch.delenv("RECIT_FAKE_TALK", raising=False)
    models = str(tmp_path)
    assert talking.status(models)["available"] is False
    for name, _, _ in talking.TALK_FILES:
        (talking.model_dir(models) / name).parent.mkdir(parents=True, exist_ok=True)
        (talking.model_dir(models) / name).write_bytes(b"x")
    talking.lora_dir(models).mkdir(parents=True)
    (talking.lora_dir(models) / talking.LORA[0]).write_bytes(b"x")
    assert talking.status(models)["available"] is True

    seen: list[str] = []
    r = talking.talk(
        {
            "modelsDir": models,
            "image": str(tmp_path / "fox.png"),
            "audio": str(tmp_path / "line.wav"),
            "out": str(tmp_path / "o" / "shot.mp4"),
            "seconds": 2.5,
            "prompt": "a fox is talking",
            "seed": 3,
        },
        lambda p, m=None: seen.append(m or ""),
        threading.Event(),
    )
    args = (tmp_path / "args.txt").read_text()
    assert "-M vid_gen" in args and "--video-frames 41" in args and "-W 480 -H 832" in args
    assert "<lora:wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise:1.0>" in args
    assert "--steps 4" in args and "--cfg-scale 1.0" in args and "--mmap" in args
    assert r["video"].endswith("shot.avi") and Path(r["video"]).read_bytes() == b"AVI"
    assert r["frames"] == 41 and r["seconds"] == pytest.approx(41 / 16)
    assert "Animating the character at 480×832 (step 2 of 4)…" in seen


@pytest.mark.skipif(sys.platform == "win32", reason="the stand-in engine is a shell script")
def test_talking_steps_down_when_graphics_memory_runs_short(tmp_path, monkeypatch) -> None:
    """Like the reference PC: 480x832 needs more than is free, so the engine refuses at block 0."""
    from recit_media_ai import talking

    script = tmp_path / "sd-cli"
    script.write_text(
        "#!/bin/sh\n"
        'echo "$@" >> "$(dirname "$0")/calls.txt"\n'
        'case "$*" in *"-W 480 "*)\n'
        '  echo "[W] execution engine cannot make enough memory available on CUDA0: need 6806.46 MB'
        ' device / 6300.43 MB budget, available 6517.65 MB device / 6600.00 MB budget"\n'
        '  echo "[E] Wan2.2-S2V-14B segment 2/42 (wan.blocks.0) failed during weight preparation"\n'
        "  exit 1;;\n"
        "esac\n"
        'while [ "$1" != "-o" ]; do shift; done\n'
        'printf "AVI" > "$2"\n'
    )
    script.chmod(0o755)
    monkeypatch.setenv("RECIT_SD_CLI", str(script))
    monkeypatch.delenv("RECIT_FAKE_TALK", raising=False)
    models = str(tmp_path)
    for name, _, _ in talking.TALK_FILES:
        (talking.model_dir(models) / name).parent.mkdir(parents=True, exist_ok=True)
        (talking.model_dir(models) / name).write_bytes(b"x")
    talking.lora_dir(models).mkdir(parents=True)
    (talking.lora_dir(models) / talking.LORA[0]).write_bytes(b"x")
    params = {
        "modelsDir": models,
        "image": str(tmp_path / "fox.png"),
        "audio": str(tmp_path / "line.wav"),
        "out": str(tmp_path / "shot.avi"),
        "seconds": 3.8,  # 61 frames, 16 latent frames: the reference PC's failing case
    }
    seen: list[str] = []
    r = talking.talk(params, lambda p, m=None: seen.append(m or ""), threading.Event())
    calls = (tmp_path / "calls.txt").read_text().splitlines()
    assert len(calls) == 2 and "-W 432 -H 768" in calls[1]
    assert (r["width"], r["height"]) == (432, 768)
    assert "Not enough graphics memory at that size; trying smaller…" in seen
    # The limit is remembered: the next shot starts at a size that fits.
    talking.talk(params, lambda *a: None, threading.Event())
    calls = (tmp_path / "calls.txt").read_text().splitlines()
    assert len(calls) == 3 and "-W 432 -H 768" in calls[2]


def test_memory_shortfall_and_sizes() -> None:
    from recit_media_ai.talking import SIZES, memory_shortfall, size_for, tokens

    line = (
        "need 1000.00 MB device / 900.00 MB budget, available 800.00 MB device / 990.00 MB budget"
    )
    assert memory_shortfall(["x", line]) == pytest.approx(0.8)
    assert memory_shortfall(["nothing"]) is None
    assert size_for(61, None) == (480, 832)
    assert size_for(61, 1) is None
    assert all(w % 16 == 0 and h % 16 == 0 for w, h in SIZES)
    assert tokens(480, 832, 61) == 30 * 52 * 16
