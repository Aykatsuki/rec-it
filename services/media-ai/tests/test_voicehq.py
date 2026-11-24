import json
import math
import shutil
import struct
import sys
import threading
import wave
from pathlib import Path

import pytest

from recit_media_ai import voicehq
from recit_media_ai.chatterbox_worker import sentences


def tone(seconds: float, lead: float = 0.3, tail: float = 0.4) -> list[float]:
    n = int(seconds * voicehq.SAMPLE_RATE)
    a, b = int(lead * voicehq.SAMPLE_RATE), n - int(tail * voicehq.SAMPLE_RATE)
    return [0.4 * math.sin(i / 7) if a <= i < b else 0.0 for i in range(n)]


def test_words_follow_what_whisper_heard() -> None:
    heard = [
        {"text": "In", "start": 0.3, "end": 0.42},
        {"text": "2013,", "start": 0.45, "end": 1.1},
        {"text": "Kalachy", "start": 1.2, "end": 1.7},  # misheard name
        {"text": "slept.", "start": 1.8, "end": 2.2},
    ]
    words = voicehq.time_words("In 2013, Kalachi slept.", heard, tone(2.6))
    assert [w["text"] for w in words] == ["In", "2013,", "Kalachi", "slept."]
    assert (words[1]["start"], words[1]["end"]) == (0.45, 1.1)
    # The misheard word fills the gap between its neighbours.
    assert words[2]["start"] == pytest.approx(1.1) and words[2]["end"] == pytest.approx(1.8)


def test_words_without_whisper_spread_over_the_speech() -> None:
    words = voicehq.time_words("a longer word here", None, tone(3.0, lead=0.5, tail=0.5))
    assert words[0]["start"] == pytest.approx(0.5, abs=0.03)
    assert words[-1]["end"] <= 2.5 + 0.03
    assert all(a["end"] <= b["start"] + 1e-9 for a, b in zip(words, words[1:], strict=False))
    # Longer words take longer.
    assert words[1]["end"] - words[1]["start"] > words[0]["end"] - words[0]["start"]


def test_sounds_cover_each_word() -> None:
    sounds = voicehq.sounds_for([{"text": "five", "start": 1.0, "end": 1.4}])
    spoken = [s for s in sounds if not s["p"].isspace()]
    assert spoken[0]["start"] == 1.0 and spoken[-1]["end"] == pytest.approx(1.4)
    assert spoken[0]["p"] == "f"  # Kokoro's phonemiser, or the letters without it


def test_sentences_split_long_scripts() -> None:
    assert sentences("One. Two! Three?") == ["One.", "Two!", "Three?"]
    long = "word, " * 80
    assert all(len(s) <= 281 for s in sentences(long))


def test_fake_voice_gives_words_and_sounds(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("RECIT_FAKE_VOICEHQ", "1")
    r = voicehq.run(
        {
            "segments": [{"id": "title", "text": "Hello there"}, {"id": "s0", "text": "Two words"}],
            "out": str(tmp_path / "v.wav"),
            "modelsDir": str(tmp_path),
        },
        lambda *a: None,
        threading.Event(),
    )
    assert Path(r["out"]).is_file() and r["duration"] > 1
    title, s0 = r["segments"]
    assert [w["text"] for w in title["words"]] == ["Hello", "there"]
    assert s0["start"] >= title["end"] and s0["words"][0]["start"] >= s0["start"]
    assert any(s["p"] == "h" or s["p"].startswith("h") for s in title["sounds"])


def _stand_ins(tmp_path: Path) -> tuple[Path, Path]:
    """A stand-in uv (records its calls; `venv` makes an environment whose python is a stand-in
    for the Chatterbox worker) and the calls log."""
    calls = tmp_path / "calls.txt"
    fake_python = tmp_path / "fake_python.py"
    fake_python.write_text(
        f"#!{sys.executable}\n"
        "import json, sys, wave, struct, pathlib\n"
        "req = json.loads(pathlib.Path(sys.argv[-1]).read_text())\n"
        "if req['mode'] == 'download':\n"
        "    print(json.dumps({'progress': 0.5, 'message': 'Downloading'}))\n"
        "    print(json.dumps({'done': {'downloaded': True}}))\n"
        "else:\n"
        "    out = pathlib.Path(req['outDir']); out.mkdir(parents=True, exist_ok=True)\n"
        "    parts = []\n"
        "    for p in req['parts']:\n"
        "        n = 24000 * len(p['text'].split()) // 3\n"
        "        with wave.open(str(out / (p['id'] + '.wav')), 'wb') as w:\n"
        "            w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000)\n"
        "            w.writeframes(b''.join(struct.pack('<h', 9000 if i % 20 < 10 else -9000)"
        " for i in range(n)))\n"
        "        parts.append({'id': p['id'], 'seconds': n / 24000})\n"
        "    print(json.dumps({'progress': 0.9, 'message': 'Speaking…'}))\n"
        "    print(json.dumps({'done': {'parts': parts, 'voice': req['voice']}}))\n"
    )
    fake_python.chmod(0o755)
    uv = tmp_path / "uv"
    uv.write_text(
        "#!/bin/sh\n"
        f'echo "$@" >> "{calls}"\n'
        'if [ "$1" = "venv" ]; then\n'
        "  for last; do :; done\n"
        '  mkdir -p "$last/bin"\n'
        f'  cp "{fake_python}" "$last/bin/python"\n'
        "fi\n"
    )
    uv.chmod(0o755)
    return uv, calls


@pytest.mark.skipif(sys.platform == "win32", reason="the stand-ins are shell scripts")
def test_install_and_speak_with_stand_ins(tmp_path, monkeypatch) -> None:
    monkeypatch.delenv("RECIT_FAKE_VOICEHQ", raising=False)
    models = str(tmp_path / "models")
    uv, calls = _stand_ins(tmp_path)
    assert voicehq.status(models)["available"] is False
    seen: list[str] = []
    voicehq.install(
        {"modelsDir": models, "uv": str(uv)},
        lambda p, m=None: seen.append(m or ""),
        threading.Event(),
    )
    lines = calls.read_text().splitlines()
    assert lines[0].startswith("venv --python 3.12")
    assert "torch==2.6.0" in lines[1] and voicehq.PACKAGE in lines[2]
    assert voicehq.status(models)["available"] is True
    assert "Downloading" in seen

    sample = tmp_path / "me.wav"
    with wave.open(str(sample), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(24000)
        w.writeframes(struct.pack("<h", 0) * 24000 * 6)
    r = voicehq.run(
        {
            "segments": [{"id": "line", "text": "I hope I work today"}],
            "out": str(tmp_path / "out" / "line.wav"),
            "modelsDir": models,
            "sample": str(sample),
        },
        lambda *a: None,
        threading.Event(),
    )
    seg = r["segments"][0]
    assert [w["text"] for w in seg["words"]] == ["I", "hope", "I", "work", "today"]
    assert seg["end"] == pytest.approx(5 / 3, abs=0.01) and seg["sounds"]


def _ffmpeg() -> str | None:
    here = Path(__file__).resolve().parents[3] / "resources" / "ffmpeg"
    found = sorted(here.glob("*/ffmpeg")) + sorted(here.glob("*/ffmpeg.exe"))
    return str(found[0]) if found else shutil.which("ffmpeg")


@pytest.mark.skipif(_ffmpeg() is None, reason="needs FFmpeg")
def test_voice_samples_need_five_seconds(tmp_path) -> None:
    def wav(seconds: float) -> Path:
        p = tmp_path / f"{seconds}.wav"
        with wave.open(str(p), "wb") as w:
            w.setnchannels(2)
            w.setsampwidth(2)
            w.setframerate(44100)
            w.writeframes(struct.pack("<hh", 1000, 1000) * int(44100 * seconds))
        return p

    with pytest.raises(RuntimeError, match="at least 5 seconds"):
        voicehq.add_sample(
            {"path": str(wav(3)), "out": str(tmp_path / "a.wav"), "ffmpeg": _ffmpeg()}
        )
    r = voicehq.add_sample(
        {"path": str(wav(20)), "out": str(tmp_path / "b.wav"), "ffmpeg": _ffmpeg()}
    )
    assert r["seconds"] == pytest.approx(15, abs=0.1)
    with wave.open(r["out"], "rb") as w:
        assert (w.getnchannels(), w.getframerate()) == (1, 24000)
    assert json.dumps(r)
