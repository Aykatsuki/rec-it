import json
import sys
import threading
import wave
from collections import namedtuple
from pathlib import Path

import pytest

from recit_media_ai import card, tts

FONTS = Path(__file__).resolve().parents[3] / "resources" / "fonts"
Timing = namedtuple("Timing", "phoneme start end")


def test_fake_voice_writes_audio_with_exact_word_times(tmp_path, monkeypatch):
    monkeypatch.setenv("RECIT_FAKE_TTS", "1")
    out = tmp_path / "v.wav"
    r = tts.run(
        {
            "segments": [
                {"id": "title", "text": "Hello there"},
                {"id": "body", "text": "one two three"},
            ],
            "out": str(out),
            "speed": 1.0,
            "gap": 0.5,
        },
        lambda *a: None,
        threading.Event(),
    )
    assert [s["id"] for s in r["segments"]] == ["title", "body"]
    title, body = r["segments"]
    assert [w["text"] for w in body["words"]] == ["one", "two", "three"]
    # 0.4 s per word, then the gap: the body starts at 0.8 + 0.5 s.
    assert body["start"] == pytest.approx(1.3)
    assert body["words"][1]["start"] == pytest.approx(1.7)
    with wave.open(str(out)) as w:
        assert w.getframerate() == tts.SAMPLE_RATE
        assert w.getnframes() / tts.SAMPLE_RATE == pytest.approx(r["duration"], abs=0.01)
    assert title["end"] == pytest.approx(0.8)  # audio length: last word plus its gap


def test_spoken_spans_group_sounds_between_spaces():
    t = [
        Timing("h", 0.0, 0.1),
        Timing("a", 0.1, 0.2),
        Timing(" ", 0.2, 0.3),
        Timing(",", 0.3, 0.32),
        Timing("b", 0.35, 0.5),
    ]
    assert tts.spoken_spans(t) == [(0.0, 0.2), (0.35, 0.5)]


def test_align_maps_expanded_words_and_silent_punctuation():
    spans = [(0, 1), (1, 2), (2, 3), (3, 4), (5, 6)]
    # "(29F)" is spoken as three words; the dash as none.
    words = tts.align(["my", "(29F)", "—", "yes"], spans[:1] + spans[1:4] + spans[4:], [1, 3, 0, 1])
    assert [(w["text"], w["start"], w["end"]) for w in words] == [
        ("my", 0, 1),
        ("(29F)", 1, 4),
        ("—", 4, 4),
        ("yes", 5, 6),
    ]


def test_align_falls_back_to_letter_counts():
    words = tts.align(["aa", "b"], [(0.0, 1.0), (1.0, 3.0)], [1, 2])
    assert words[0]["start"] == 0 and words[-1]["end"] == pytest.approx(3.0)
    assert words[0]["end"] == pytest.approx(2.0)


def test_spoken_count_ignores_lone_punctuation():
    assert tts.spoken_count("—") == 0
    assert tts.spoken_count("dˈɑːlɚ fˈaɪv θˈaʊzənd.") == 3


def test_card_renders_a_png(tmp_path):
    pytest.importorskip("PIL")
    out = tmp_path / "c.png"
    r = card.render(
        {
            "out": str(out),
            "fontsDir": str(FONTS),
            "title": "A long title " * 6,
            "community": "r/stories",
            "username": "someone",
            "upvotes": 1520,
            "comments": 87,
        }
    )
    assert out.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"
    assert r["width"] == card.WIDTH and r["height"] > 300


def test_card_without_pillow_in_fake_mode(tmp_path, monkeypatch):
    monkeypatch.setenv("RECIT_FAKE_TTS", "1")
    out = tmp_path / "c.png"
    card._plain_png(str(out), 20, 10)
    assert out.read_bytes()[:4] == b"\x89PNG"
    assert json.dumps(card.THEMES["light"]["text"])


def test_fake_images_draw_one_png_per_prompt(tmp_path, monkeypatch):
    from recit_media_ai import images

    monkeypatch.setenv("RECIT_FAKE_IMAGES", "1")
    assert images.status(str(tmp_path))["available"] is True
    r = images.generate(
        {
            "prompts": ["a castle", "a dragon"],
            "outDir": str(tmp_path / "o"),
            "modelsDir": str(tmp_path),
        },
        lambda *a: None,
        threading.Event(),
    )
    assert [Path(p).name for p in r["images"]] == ["scene-1.png", "scene-2.png"]
    assert all(Path(p).read_bytes()[:4] == b"\x89PNG" for p in r["images"])


def test_real_engine_status_without_files(tmp_path, monkeypatch):
    from recit_media_ai import images

    monkeypatch.delenv("RECIT_FAKE_IMAGES", raising=False)
    monkeypatch.delenv("RECIT_SD_CLI", raising=False)
    s = images.status(str(tmp_path))
    assert s["available"] is False


@pytest.mark.skipif(sys.platform == "win32", reason="the stand-in engine is a shell script")
def test_engine_command_and_failure(tmp_path, monkeypatch):
    """A stand-in sd-cli that records its arguments and writes the output picture."""
    from recit_media_ai import images

    script = tmp_path / "sd-cli"
    script.write_text(
        "#!/bin/sh\n"
        'echo "$@" > "$(dirname "$0")/args.txt"\n'
        'while [ "$1" != "-o" ]; do shift; done\n'
        'printf "PNG" > "$2"\n'
    )
    script.chmod(0o755)
    monkeypatch.setenv("RECIT_SD_CLI", str(script))
    monkeypatch.delenv("RECIT_FAKE_IMAGES", raising=False)
    for name, _, _ in images.MODEL_FILES:
        (images.model_dir(str(tmp_path)) / name).parent.mkdir(parents=True, exist_ok=True)
        (images.model_dir(str(tmp_path)) / name).write_bytes(b"x")
    assert images.status(str(tmp_path))["available"] is True
    r = images.generate(
        {
            "prompts": ["a red fox"],
            "outDir": str(tmp_path / "o"),
            "modelsDir": str(tmp_path),
            "seed": 7,
        },
        lambda *a: None,
        threading.Event(),
    )
    args = (tmp_path / "args.txt").read_text()
    assert "-p a red fox" in args and "--steps 8" in args and "-W 576 -H 1024" in args
    assert "-s 7" in args and "--mmap" in args and "--offload-to-cpu" not in args
    assert Path(r["images"][0]).read_bytes() == b"PNG"


def test_motion_background(tmp_path):
    pytest.importorskip("PIL")
    from PIL import Image

    out = tmp_path / "bg.png"
    card.background(
        {
            "out": str(out),
            "palette": ["#101030", "#E0407A", "#FFD166"],
            "seed": "s1",
            "width": 270,
            "height": 480,
        }
    )
    im = Image.open(out)
    assert im.size == (270, 480)
    top, bottom = im.getpixel((5, 5)), im.getpixel((265, 475))
    assert top != bottom


def test_snap_to_pauses_moves_sentence_ends_onto_the_real_pauses():
    import numpy as np

    from recit_media_ai.tts import SAMPLE_RATE, snap_to_pauses

    sr = SAMPLE_RATE
    tone = lambda s: (0.3 * np.sin(np.arange(int(s * sr)) * 2 * np.pi * 220 / sr)).astype(np.float32)
    quiet = lambda s: np.zeros(int(s * sr), dtype=np.float32)
    # Speech 0-1.5 s, pause 1.5-1.9 s, speech 1.9-3.0 s, pause 3.0-3.5 s, speech 3.5-4.2 s.
    audio = np.concatenate([tone(1.5), quiet(0.4), tone(1.1), quiet(0.5), tone(0.7)])
    # Predicted timings that run early by up to half a second.
    words = [
        {"text": "In", "start": 0.0, "end": 0.3},
        {"text": "1944,", "start": 0.3, "end": 1.0},
        {"text": "a", "start": 1.2, "end": 1.4},
        {"text": "soldier.", "start": 1.4, "end": 2.6},
        {"text": "Nobody", "start": 2.8, "end": 3.4},
        {"text": "came.", "start": 3.4, "end": 3.9},
    ]
    sounds = [{"p": "n", "start": 2.8, "end": 2.9}]
    new, snd = snap_to_pauses(words, sounds, audio)
    ends = {w["text"]: w["end"] for w in new}
    starts = {w["text"]: w["start"] for w in new}
    assert abs(ends["1944,"] - 1.5) < 0.03
    assert abs(starts["a"] - 1.9) < 0.03
    assert abs(ends["soldier."] - 3.0) < 0.03
    assert abs(starts["Nobody"] - 3.5) < 0.03
    # Everything stays in order, and sounds move with their words.
    times = [t for w in new for t in (w["start"], w["end"])]
    assert times == sorted(times)
    assert abs(snd[0]["start"] - 3.5) < 0.03


def test_match_pauses_does_not_take_a_short_breath_for_a_sentence_end():
    from recit_media_ai.tts import match_pauses

    # Expected ends 2.0 and 4.0 s. The audio has a brief breath at 3.5 s inside the second
    # sentence and its real end at 4.6 s; the nearest-pause guess took the breath, which pulled
    # every later sentence early.
    words = [
        {"text": "One", "start": 0.0, "end": 1.0},
        {"text": "two.", "start": 1.0, "end": 2.0},
        {"text": "Three", "start": 2.2, "end": 3.0},
        {"text": "four.", "start": 3.0, "end": 4.0},
        {"text": "Five", "start": 4.2, "end": 5.4},
        {"text": "six.", "start": 5.4, "end": 6.6},
    ]
    gaps = [(2.0, 2.4), (3.5, 3.65), (4.6, 5.0), (7.0, 7.4)]
    assert match_pauses(words, gaps, 7.4) == [(1, 0), (3, 2)]
