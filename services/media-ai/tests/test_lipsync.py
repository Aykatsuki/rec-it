import shutil
import subprocess
import threading
from pathlib import Path

import pytest

from recit_media_ai import lipsync

# Real Kokoro timings for "Who stayed up this late? Five foxes, very happy!" (af_heart).
KOKORO = [
    ("h", 0.09, 0.12), ("ˌ", 0.12, 0.14), ("u", 0.14, 0.17), ("ː", 0.17, 0.19), (" ", 0.19, 0.24),
    ("s", 0.24, 0.29), ("t", 0.29, 0.32), ("ˈ", 0.32, 0.37), ("e", 0.37, 0.42), ("ɪ", 0.42, 0.44),
    ("d", 0.44, 0.47), (" ", 0.47, 0.49), ("ˌ", 0.49, 0.52), ("ʌ", 0.52, 0.57), ("p", 0.57, 0.59),
    (" ", 0.59, 0.62), ("ð", 0.62, 0.64), ("ɪ", 0.64, 0.69), ("s", 0.69, 0.74), (" ", 0.74, 0.79),
    ("l", 0.79, 0.82), ("ˈ", 0.82, 0.87), ("e", 0.87, 0.92), ("ɪ", 0.92, 0.99), ("t", 0.99, 1.22),
    ("?", 1.22, 1.32), (" ", 1.32, 1.39), ("f", 1.39, 1.44), ("ˈ", 1.44, 1.52), ("a", 1.52, 1.57),
    ("ɪ", 1.57, 1.62), ("v", 1.62, 1.67), (" ", 1.67, 1.72), ("f", 1.72, 1.77), ("ˈ", 1.77, 1.84),
    ("ɑ", 1.84, 1.87), ("ː", 1.87, 1.92), ("k", 1.92, 1.99), ("s", 1.99, 2.07), ("ᵻ", 2.07, 2.19),
    ("z", 2.19, 2.24), (",", 2.24, 2.27), (" ", 2.27, 2.32), ("v", 2.32, 2.34), ("ˈ", 2.34, 2.39),
    ("ɛ", 2.39, 2.44), ("ɹ", 2.44, 2.52), ("i", 2.52, 2.57), (" ", 2.57, 2.62), ("h", 2.62, 2.64),
    ("ˈ", 2.64, 2.72), ("æ", 2.72, 2.77), ("p", 2.77, 2.87), ("i", 2.87, 3.07), ("!", 3.07, 3.07),
]  # fmt: skip
SOUNDS = [{"p": p, "start": a, "end": b} for p, a, b in KOKORO]


def shape_at(segs, t):
    return next(s["shape"] for s in segs if s["start"] <= t < s["end"])


def test_shapes_follow_the_sounds() -> None:
    segs = lipsync.timeline(SOUNDS, 3.22)
    # Covers the whole line without gaps, and starts and ends with closed lips.
    assert segs[0]["start"] == 0 and segs[-1]["end"] == pytest.approx(3.22)
    assert all(a["end"] == b["start"] for a, b in zip(segs, segs[1:], strict=False))
    assert segs[0]["shape"] == "rest" and segs[-1]["shape"] == "rest"
    # No shape is shorter than two frames, and neighbours differ.
    assert all(s["end"] - s["start"] >= 2 / 30 - 1e-6 for s in segs)
    assert all(a["shape"] != b["shape"] for a, b in zip(segs, segs[1:], strict=False))
    # "Who" is round; the "f" of "five" puts teeth on the lip; "five" opens wide; "p" closes.
    assert shape_at(segs, 0.15) == "round"
    assert shape_at(segs, 1.40) == "fv"
    assert shape_at(segs, 1.53) == "open"
    assert shape_at(segs, 2.80) == "rest"
    # The pause after "late?" closes the mouth.
    assert shape_at(segs, 1.30) == "rest"


def test_shape_of_symbols() -> None:
    assert [lipsync.shape_of(p) for p in "aiofmtə"] == [
        "open",
        "wide",
        "round",
        "fv",
        "rest",
        "mid",
        "mid",
    ]
    assert lipsync.shape_of("?") is None and lipsync.shape_of(" ") is None


def _picture(path: Path, w: int = 192, h: int = 336) -> None:
    pytest.importorskip("PIL")
    import numpy as np
    from PIL import Image

    rng = np.random.default_rng(1)
    yy, xx = np.mgrid[0:h, 0:w]
    base = np.stack([xx * 255 / w, yy * 255 / h, np.full_like(xx, 140)], axis=2)
    base = base + rng.normal(0, 3, base.shape)  # texture, like fur or skin
    Image.fromarray(np.clip(base, 0, 255).astype("uint8")).save(path)


def test_cut_out_keeps_everything_but_the_mouth(tmp_path) -> None:
    pytest.importorskip("numpy")
    import numpy as np
    from PIL import Image

    base = tmp_path / "base.png"
    _picture(base)
    edit = tmp_path / "open-edit.png"
    lipsync._fake_edit(base, edit, "open")
    out = tmp_path / "open.png"
    assert lipsync.cut_out(base, edit, out)
    a = np.asarray(Image.open(base), dtype=np.int16)
    o = np.asarray(Image.open(out), dtype=np.int16)
    changed = np.abs(a - o).max(axis=2) > 0
    ys, xs = np.nonzero(changed)
    h, w = changed.shape
    # Only around the mouth (centre, 42% down) changed; the overall tint did not leak in.
    assert changed.sum() > 0
    assert abs(ys.mean() - h * 0.42) < h * 0.05 and abs(xs.mean() - w / 2) < w * 0.05
    assert not changed[: h // 4].any() and not changed[-h // 4 :].any()


def test_cut_out_refuses_a_redrawn_picture(tmp_path) -> None:
    pytest.importorskip("numpy")
    import numpy as np
    from PIL import Image

    base = tmp_path / "base.png"
    _picture(base)
    other = tmp_path / "other.png"
    img = np.asarray(Image.open(base))[::-1]  # everything moved
    Image.fromarray(np.ascontiguousarray(img)).save(other)
    assert not lipsync.cut_out(base, other, tmp_path / "x.png")


def _ffmpeg() -> str | None:
    here = Path(__file__).resolve().parents[3] / "resources" / "ffmpeg"
    found = sorted(here.glob("*/ffmpeg")) + sorted(here.glob("*/ffmpeg.exe"))
    return str(found[0]) if found else shutil.which("ffmpeg")


@pytest.mark.skipif(_ffmpeg() is None, reason="needs FFmpeg")
def test_shapes_and_render_end_to_end(tmp_path, monkeypatch) -> None:
    pytest.importorskip("numpy")
    import numpy as np
    from PIL import Image

    monkeypatch.setenv("RECIT_FAKE_LIPSYNC", "1")
    base = tmp_path / "base.png"
    _picture(base)
    r = lipsync.make_shapes(
        {"base": str(base), "outDir": str(tmp_path / "shapes"), "modelsDir": str(tmp_path)},
        lambda *a: None,
        threading.Event(),
    )
    shapes = r["shapes"]
    assert set(shapes) == {"rest", *lipsync.SHAPES}
    assert all(Path(p).is_file() for p in shapes.values())

    out = tmp_path / "talk.mp4"
    res = lipsync.render(
        {
            "shapes": shapes,
            "sounds": SOUNDS,
            "duration": 3.22,
            "out": str(out),
            "ffmpeg": _ffmpeg(),
            "seed": 3,
        },
        lambda *a: None,
        threading.Event(),
    )
    assert Path(res["video"]).is_file()
    raw = subprocess.run(
        [_ffmpeg(), "-v", "error", "-i", res["video"], "-f", "rawvideo", "-pix_fmt", "gray", "-"],
        capture_output=True,
        check=True,
    ).stdout
    w, h = Image.open(base).size
    frames = np.frombuffer(raw, np.uint8).reshape(-1, h, w).astype(float)
    assert len(frames) == round(3.22 * 30)
    # The mouth area is dark (open) while "five" is said, and plain when the lips close on "p".
    my, mx = int(h * 0.42), w // 2
    mouth = frames[:, my - 3 : my + 3, mx - 3 : mx + 3].mean(axis=(1, 2))
    assert mouth[round(1.53 * 30)] < mouth[round(2.80 * 30)] - 40
    # Blinks happen (the eyes' row darkens briefly) and are short.
    eyes = frames[:, int(h * 0.3) - 1 : int(h * 0.3) + 2, mx - w // 8 - 4 : mx - w // 8 + 4]
    dark = eyes.mean(axis=(1, 2)) < eyes.mean() - 30
    assert 0 < dark.sum() <= 5 * len(lipsync.blinks(3.22, 3))
