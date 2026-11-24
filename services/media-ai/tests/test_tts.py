import json
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
