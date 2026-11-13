import json
import shutil
import subprocess
import threading

import pytest

from recit_media_ai import faces

FFMPEG = shutil.which("ffmpeg")


def test_fake_engine_moves_one_face_left_to_right(tmp_path, monkeypatch):
    monkeypatch.setenv("RECIT_FAKE_FACES", "1")
    out = tmp_path / "f.json"
    result = faces.run(
        {"out": str(out), "duration": 2, "fps": 5}, lambda *a: None, threading.Event()
    )
    data = json.loads(out.read_text())
    assert result["frames"] == 10 and result["withFaces"] == 10
    xs = [f[0][0] for f in data["frames"]]
    assert xs == sorted(xs) and xs[0] < 0.2 < 0.6 < xs[-1]


@pytest.mark.skipif(not FFMPEG, reason="needs ffmpeg on PATH")
def test_real_detector_reads_video_and_finds_no_face_in_test_pattern(tmp_path):
    pytest.importorskip("cv2")
    video = tmp_path / "bars.mp4"
    subprocess.run(
        [
            FFMPEG,
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=s=640x360:r=30:d=2",
            str(video),
        ],
        check=True,
    )
    out = tmp_path / "f.json"
    progress: list[float] = []
    result = faces.run(
        {
            "video": str(video),
            "out": str(out),
            "ffmpeg": FFMPEG,
            "width": 640,
            "height": 360,
            "duration": 2,
            "fps": 5,
        },
        lambda p, *_: progress.append(p),
        threading.Event(),
    )
    data = json.loads(out.read_text())
    assert 9 <= result["frames"] <= 11
    assert all(f == [] for f in data["frames"])
    assert data["engine"].startswith("OpenCV")
    assert progress[-1] == 1.0


@pytest.mark.skipif(not FFMPEG, reason="needs ffmpeg on PATH")
def test_detection_can_be_cancelled(tmp_path):
    pytest.importorskip("cv2")
    video = tmp_path / "long.mp4"
    subprocess.run(
        [
            FFMPEG,
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc2=s=640x360:r=30:d=20",
            str(video),
        ],
        check=True,
    )
    stop = threading.Event()
    stop.set()
    with pytest.raises(faces.Cancelled):
        faces.run(
            {
                "video": str(video),
                "out": str(tmp_path / "x.json"),
                "ffmpeg": FFMPEG,
                "width": 640,
                "height": 360,
                "duration": 20,
            },
            lambda *a: None,
            stop,
        )
