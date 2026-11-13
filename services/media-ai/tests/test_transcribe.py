import io
import json
import shutil
import subprocess
import threading
import time
import wave
from pathlib import Path

import pytest

from recit_media_ai import transcribe
from recit_media_ai.rpc import Server
from recit_media_ai.server import HANDLERS, transcribe_job


def make_wav(path: Path, seconds: float) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\0\0" * int(16000 * seconds))


def test_fake_engine_writes_words(tmp_path, monkeypatch):
    monkeypatch.setenv("RECIT_FAKE_WHISPER", "1")
    audio = tmp_path / "a.wav"
    make_wav(audio, 2.0)
    out = tmp_path / "t.json"
    seen = []
    result = transcribe.run({"audio": str(audio), "out": str(out)}, seen.append, threading.Event())
    data = json.loads(out.read_text())
    assert result["words"] == 4
    assert [w["text"] for w in data["words"]] == ["word1", "word2", "word3", "word4"]
    assert data["words"][1]["start"] == 0.6
    assert seen[-1] == 1.0


def test_jobs_run_in_a_thread_report_progress_and_can_be_cancelled(tmp_path):
    out = io.StringIO()

    def slow(params, progress, cancelled):
        for i in range(50):
            if cancelled.is_set():
                raise RuntimeError("stopped")
            progress(i / 50)
            time.sleep(0.01)
        return {"done": True}

    server = Server(HANDLERS, out=out, jobs={"slow": slow})
    server.handle_line(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "slow", "params": {}}))
    # The server still answers while the job runs.
    server.handle_line(json.dumps({"jsonrpc": "2.0", "id": 2, "method": "ping", "params": {}}))
    server.handle_line(
        json.dumps({"jsonrpc": "2.0", "id": 3, "method": "job.cancel", "params": {"id": 1}})
    )
    time.sleep(0.3)
    messages = [json.loads(line) for line in out.getvalue().splitlines()]
    assert any(m.get("id") == 2 and m["result"]["pong"] for m in messages)
    assert any(m.get("method") == "job.progress" for m in messages)
    final = next(m for m in messages if m.get("id") == 1)
    assert final["error"]["code"] == -32800


def test_transcribe_job_validates_params():
    with pytest.raises(Exception, match="file path"):
        transcribe_job({"audio": 3}, lambda p: None, threading.Event())


@pytest.mark.whisper
def test_real_whisper_transcribes_speech(tmp_path):
    """Needs the transcribe extra, network access for the tiny model, and espeak-ng."""
    if not shutil.which("espeak-ng") and not shutil.which("espeak"):
        pytest.skip("espeak-ng is not installed")
    espeak = shutil.which("espeak-ng") or shutil.which("espeak")
    raw = tmp_path / "speech.wav"
    subprocess.run(
        [espeak, "-s", "130", "-w", str(raw), "hello world, this is a short test"], check=True
    )
    audio = tmp_path / "speech16k.wav"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(raw), "-ac", "1", "-ar", "16000", str(audio)],
        check=True,
    )
    out = tmp_path / "t.json"
    messages: list[str | None] = []
    result = transcribe.run(
        {
            "audio": str(audio),
            "out": str(out),
            "model": "tiny.en",
            "device": "cpu",
            "language": "en",
            "modelsDir": str(tmp_path / "models"),
        },
        lambda p, m=None: messages.append(m),
        threading.Event(),
    )
    assert any(m and m.startswith("Downloading the speech model") for m in messages)
    words = [w["text"].lower().strip(",.") for w in json.loads(out.read_text())["words"]]
    assert result["device"] == "cpu"
    # tiny.en on robotic espeak speech is not perfect ("hello" can come out as "the low"), so
    # require most of the sentence rather than every word.
    expected = {"hello", "world", "this", "is", "short", "test"}
    assert len(expected & set(words)) >= 4, words
    starts = [w["start"] for w in json.loads(out.read_text())["words"]]
    assert starts == sorted(starts)


def test_gpu_failure_while_transcribing_falls_back_to_the_cpu(tmp_path, monkeypatch):
    """On Windows CTranslate2 loads cuBLAS only when it first runs, so CUDA errors surface while
    iterating the segments, after the model loaded fine."""
    fw = pytest.importorskip("faster_whisper")

    audio = tmp_path / "a.wav"
    with wave.open(str(audio), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\0\0" * 16000 * 2)

    class Word:
        def __init__(self, word, start, end):
            self.word, self.start, self.end, self.probability = word, start, end, 0.9

    class Segment:
        def __init__(self):
            self.end = 2.0
            self.words = [Word(" hi", 0.2, 0.5)]

    class Info:
        language = "en"

    class FakeModel:
        def __init__(self, path, device, compute_type):
            self.device = device

        def transcribe(self, samples, **kwargs):
            def gen():
                if self.device == "cuda":
                    raise RuntimeError("Library cublas64_12.dll is not found or cannot be loaded")
                yield Segment()

            return gen(), Info()

    monkeypatch.setattr(fw, "WhisperModel", FakeModel)
    monkeypatch.setattr(transcribe, "_fetch_model", lambda name, *a: name)
    messages = []
    out = tmp_path / "t.json"
    result = transcribe.run(
        {"audio": str(audio), "out": str(out), "device": "auto"},
        lambda p, m=None: messages.append(m),
        threading.Event(),
    )
    assert result["device"] == "cpu" and result["model"] == "small"
    assert any(m and "cublas64_12.dll" in m for m in messages)
    assert json.loads(out.read_text())["words"][0]["text"] == "hi"
