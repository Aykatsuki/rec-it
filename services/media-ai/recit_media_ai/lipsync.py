"""Talking characters by mouth shapes (ADR-049).

The character is drawn once with the mouth closed. FLUX.2 Klein 4B (an image-editing model run by
the same stable-diffusion.cpp engine as the AI pictures) redraws that picture with each mouth shape
and with the eyes closed. Only the changed area of each edit (found by comparing it with the
original) is blended onto the original, so everything else stays pixel-identical and nothing
flickers. The voice engine's per-sound timings then choose the shape for every moment, and FFmpeg
assembles the frames: lip sync is exact by construction, pictures stay sharp, and a line takes
seconds to render once the shapes exist.

RECIT_FAKE_LIPSYNC=1 draws the shapes as dark ellipses on the picture (tests); the cut-out and the
render still run for real.
"""

from __future__ import annotations

import os
import random
import subprocess
import sys
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

from . import images

HF = images.HF
#: FLUX.2 Klein 4B (distilled, 4 steps) with its Qwen3 4B text encoder and the FLUX.2 VAE, all
#: Apache-2.0 and ungated. Hashes come from Hugging Face's published SHA-256 at download time.
KLEIN_FILES = [
    (
        "flux-2-klein-4b-Q4_K_M.gguf",
        HF + "unsloth/FLUX.2-klein-4B-GGUF/resolve/main/flux-2-klein-4b-Q4_K_M.gguf",
        2_600_000_000,
    ),
    (
        "Qwen3-4B-Q4_K_M.gguf",
        HF + "unsloth/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf",
        2_500_000_000,
    ),
    (
        "flux2-vae.safetensors",
        HF + "Comfy-Org/flux2-dev/resolve/main/split_files/vae/flux2-vae.safetensors",
        336_000_000,
    ),
]
FOLDER = "flux2-klein-4b"

KEEP = (
    " Small and natural, not exaggerated. Keep everything else exactly the same: the same "
    "character, facial expression and mood, eyes, eyebrows, pose, framing, drawing style, "
    "lighting, colours and background."
)
#: Mouth shapes (a classic limited-animation set) and the edit that draws each one. Kept subtle:
#: speech moves the lips a little; it does not grin or stick out the tongue.
SHAPES: dict[str, str] = {
    # Pictures often come back with the mouth open whatever the prompt says, so closed lips
    # (m, b, p and silence) are drawn too, and stand in for the original when they come out.
    "rest": "Close the character's mouth: lips together, relaxed." + KEEP,
    "open": "Open the character's mouth a little, as when saying 'ah'." + KEEP,
    "mid": "Part the character's lips slightly, as when saying 'uh'." + KEEP,
    "wide": "Stretch the character's lips a little sideways with the mouth slightly open, as when "
    "saying 'ee'; not a smile." + KEEP,
    "round": "Purse the character's lips into a small round shape, as when saying 'oo'." + KEEP,
    "fv": "Tuck the character's lower lip lightly under the upper teeth, as when saying 'f'."
    + KEEP,
    "blink": "Close both of the character's eyes, relaxed eyelids." + KEEP,
}
#: When a shape could not be drawn, the nearest one that was.
FALLBACK = {"open": "mid", "wide": "mid", "round": "mid", "fv": "mid", "mid": "rest"}
FPS = 30
#: Shapes viewers watch for; kept even when the sound is very short.
DISTINCT = {"rest", "fv", "round"}


class Cancelled(Exception):
    pass


def _fake() -> bool:
    return os.environ.get("RECIT_FAKE_LIPSYNC") == "1"


def model_dir(models_dir: str) -> Path:
    return Path(models_dir) / FOLDER


def _missing(models_dir: str) -> list[tuple[str, Path, str | None, int, bool]]:
    return [
        (url, model_dir(models_dir) / name, None, size, False)
        for name, url, size in KLEIN_FILES
        if not (model_dir(models_dir) / name).is_file()
    ]


def status(models_dir: str) -> dict[str, Any]:
    """Whether mouth shapes can be drawn, and if not, whether the engine can be installed."""
    if _fake():
        return {"available": True, "engine": "fake", "installable": True}
    installable = sys.platform == "win32" or bool(os.environ.get("RECIT_SD_CLI"))
    return {
        "available": bool(images.sd_cli(models_dir)) and not _missing(models_dir),
        "engine": "FLUX.2 Klein 4B (stable-diffusion.cpp)",
        "installable": installable,
        **(
            {} if installable else {"reason": "Set RECIT_SD_CLI to an sd-cli build on this system."}
        ),
    }


def install(
    params: dict[str, Any], progress: Callable[..., None], cancelled: threading.Event
) -> dict[str, Any]:
    models_dir = str(params["modelsDir"])
    if _fake():
        progress(1.0, "Installed")
        return {"installed": True}
    try:
        plan = images.engine_plan(models_dir) + _missing(models_dir)
        images.run_downloads(plan, "the mouth-shape engine", progress, cancelled)
    except images.Cancelled as e:
        raise Cancelled() from e
    return {"installed": True}


# ---- Sounds → mouth shapes --------------------------------------------------------------------

_OPEN = set("aɑæʌɐɒ")
_WIDE = set("iɪeɛᵻszɨ")
_ROUND = set("oɔuʊwɵ")
_FV = set("fv")
_CLOSED = set("mbp")
_MARKS = set("ˈˌ")


def shape_of(sound: str) -> str | None:
    """The mouth shape for one sound symbol; None for silence and punctuation (lips close)."""
    s = sound.strip()
    if not s:
        return None
    c = s[0]
    if c in _OPEN:
        return "open"
    if c in _WIDE:
        return "wide"
    if c in _ROUND:
        return "round"
    if c in _FV:
        return "fv"
    if c in _CLOSED:
        return "rest"
    if c.isalpha() or c in "ɹɾʃʒθðŋɡʔɚɝɜəɫ":
        return "mid"
    return None


def timeline(
    sounds: list[dict[str, Any]],
    duration: float,
    lead: float = 0.03,
    min_hold: float = 2 / FPS,
    gap_close: float = 0.12,
) -> list[dict[str, Any]]:
    """Mouth shapes over time from the voice's per-sound timings: [{shape, start, end}] covering
    0..duration. Stress marks belong to the next sound, a length mark to the previous one; short
    gaps between words keep the mouth where it is, longer ones close it. The mouth leads the sound
    slightly (as animators do) and no shape lasts less than two frames."""
    raw: list[list[Any]] = []  # [shape, start, end]
    pending_start: float | None = None
    for snd in sounds:
        p = str(snd["p"])
        start, end = float(snd["start"]), float(snd["end"])
        if p and p[0] in _MARKS:
            pending_start = start if pending_start is None else pending_start
            continue
        if p == "ː":
            if raw:
                raw[-1][2] = end
            continue
        if p.isspace():
            if raw and end - start < gap_close:
                raw[-1][2] = end
            continue
        shape = shape_of(p) or "rest"
        if pending_start is not None:
            start, pending_start = pending_start, None
        raw.append([shape, start, end])
    out: list[list[Any]] = []
    t = 0.0
    for shape, start, end in raw:
        start, end = max(0.0, start - lead), max(0.0, end - lead)
        if start > t + 1e-6:
            out.append(["rest", t, start])
        if out and out[-1][0] == shape:
            out[-1][2] = end
        else:
            out.append([shape, max(start, t), end])
        t = max(t, end)
    if t < duration:
        out.append(["rest", t, duration])
    # Shapes shorter than min_hold: the distinctive ones (closed lips, f/v, rounded lips, which
    # viewers watch for) borrow time from their longer neighbour; the rest fold into it.
    changed = True
    while changed and len(out) > 1:
        changed = False
        # Subtle shapes first, so a distinctive one is not lost to a neighbour that goes anyway.
        order = sorted(range(len(out)), key=lambda k: out[k][0] in DISTINCT)
        for i in order:
            seg = out[i]
            short = min_hold - (seg[2] - seg[1])
            if short <= 1e-9:
                continue
            prev = out[i - 1] if i > 0 else None
            nxt = out[i + 1] if i + 1 < len(out) else None
            longer = prev if nxt is None or (prev and prev[2] - prev[1] >= nxt[2] - nxt[1]) else nxt
            if (
                seg[0] in DISTINCT
                and longer is not None
                and longer[2] - longer[1] - short >= min_hold
            ):
                if longer is prev:
                    prev[2] -= short
                    seg[1] -= short
                else:
                    nxt[1] += short
                    seg[2] += short
                changed = True
                break
            if longer is prev and prev is not None:
                prev[2] = seg[2]
            elif nxt is not None:
                nxt[1] = seg[1]
            out.pop(i)
            changed = True
            break
    merged: list[list[Any]] = []
    for seg in out:
        if merged and merged[-1][0] == seg[0]:
            merged[-1][2] = seg[2]
        elif seg[2] > seg[1]:
            merged.append(list(seg))
    return [{"shape": s, "start": round(a, 4), "end": round(b, 4)} for s, a, b in merged]


# ---- Mouth from the sound itself ---------------------------------------------------------------


def intensity(wav_path: Path) -> list[float]:
    """The voice's loudness in dB, 100 times a second (30 ms windows, lightly smoothed)."""
    import wave

    import numpy as np

    with wave.open(str(wav_path), "rb") as w:
        rate, channels = w.getframerate(), w.getnchannels()
        data = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32)
    if channels > 1:
        data = data.reshape(-1, channels).mean(axis=1)
    data /= 32768.0
    hop, win = rate // 100, int(rate * 0.03)
    n = max(0, (len(data) - win) // hop + 1)
    if n == 0:
        return []
    frames = np.lib.stride_tricks.sliding_window_view(data, win)[::hop][:n]
    db = 10 * np.log10((frames**2).mean(axis=1) + 1e-10)
    return np.convolve(db, np.ones(5) / 5, mode="same").tolist()


def syllables(db: list[float], liveliness: float = 0.6) -> tuple[list[float], list[bool]]:
    """Syllable centres (seconds) and a per-10 ms voiced flag. A syllable is a loudness peak
    with a dip of at least a few dB before the previous one (the vowel between consonants).
    Glided stretches with no clear dips still get syllables at a natural pace."""
    if not db:
        return [], []
    top = max(db)
    voiced = [x > top - 30 for x in db]
    min_dip = 3.0 - 1.5 * liveliness
    peaks: list[int] = []
    low_since = 0.0  # the lowest level since the last kept peak
    for i in range(1, len(db) - 1):
        low_since = min(low_since, db[i]) if peaks else db[i]
        if not voiced[i] or not (db[i] >= db[i - 1] and db[i] > db[i + 1]):
            continue
        if not peaks or i - peaks[-1] >= 10:  # at least 0.1 s apart
            if not peaks or db[i] - low_since >= min_dip:
                peaks.append(i)
                low_since = db[i]
                continue
        if peaks and db[i] > db[peaks[-1]] and i - peaks[-1] < 10:
            peaks[-1] = i  # a louder top of the same syllable
    # Fill long voiced stretches without peaks (gliding speech) at a natural syllable pace.
    step = round(28 - 8 * liveliness)  # every 0.28 s (calm) to 0.20 s (lively)
    filled: list[int] = []
    run_start = None
    for i, v in enumerate([*voiced, False]):
        if v and run_start is None:
            run_start = i
        if not v and run_start is not None:
            inside = [p for p in peaks if run_start <= p < i]
            marks = [run_start, *inside, i]
            for a, b in zip(marks, marks[1:], strict=False):
                filled.extend(range(a + step, b - step // 2, step))
            run_start = None
    centres = sorted(peaks + filled)
    return [c / 100 for c in centres], voiced


def timeline_from_audio(
    db: list[float],
    sounds: list[dict[str, Any]],
    duration: float,
    fps: int = FPS,
    liveliness: float = 0.6,
) -> list[dict[str, Any]]:
    """Mouth shapes from the voice itself: shut in silence, open around each syllable (the vowel)
    and relaxed or briefly closed between them (consonants), so it moves at the voice's own pace.
    The sound timings only choose the vowel shape (round "oo", wide "ee", f/v). `liveliness`
    (0 calm … 1 lively) sets how readily syllables are found and how wide the mouth opens.
    The mouth leads the sound by one frame."""
    live = max(0.0, min(1.0, liveliness))
    centres, voiced = syllables(db, live)
    top = max(db) if db else 0.0
    vowel = timeline(sounds, duration, lead=0.0, min_hold=0.0) if sounds else []
    half = 0.085 - 0.025 * live  # how long the mouth stays open around a syllable centre
    frames = max(1, round(duration * fps))

    def hinted(t: float) -> str | None:
        for seg in vowel:
            if seg["start"] <= t < seg["end"]:
                return str(seg["shape"])
        return None

    def at(t: float) -> tuple[bool, float]:
        k = min(len(db) - 1, max(0, round(t * 100)))
        return (voiced[k], db[k]) if db else (False, -100.0)

    shapes: list[str] = []
    for i in range(frames):
        t = (i + 1.5) / fps  # one frame of lead, centre of the frame
        is_voiced, level = at(t)
        near = min((abs(c - t) for c in centres), default=9.0)
        hint = hinted(t)
        if not is_voiced:
            shapes.append("rest")
        elif near <= half:
            strong = level > top - 14
            shape = hint if hint in ("open", "wide", "round") else "open"
            shapes.append(shape if strong else "round" if hint == "round" else "mid")
        elif level < top - (16 - 6 * live):
            shapes.append("rest")  # a deep dip: lips meet on the consonant
        else:
            shapes.append("fv" if hint == "fv" else "mid")
    # Runs shorter than the minimum hold (three frames calm, two lively) join the previous run.
    min_hold = 3 if live < 0.3 else 2
    runs: list[list[Any]] = []
    for sh in shapes:
        if runs and runs[-1][0] == sh:
            runs[-1][1] += 1
        else:
            runs.append([sh, 1])
    changed = True
    while changed:
        changed = False
        for k, run in enumerate(runs):
            if run[1] >= min_hold or len(runs) == 1:
                continue
            target = runs[k - 1] if k > 0 else runs[k + 1]
            target[1] += run[1]
            runs.pop(k)
            merged: list[list[Any]] = []
            for r in runs:
                if merged and merged[-1][0] == r[0]:
                    merged[-1][1] += r[1]
                else:
                    merged.append(r)
            runs = merged
            changed = True
            break
    out, f = [], 0
    for sh, n in runs:
        out.append(
            {"shape": sh, "start": round(f / fps, 4), "end": round(min(duration, (f + n) / fps), 4)}
        )
        f += n
    if out:
        out[-1]["end"] = round(duration, 4)
    return out


# ---- Drawing the shapes -----------------------------------------------------------------------


def make_shapes(
    params: dict[str, Any], progress: Callable[..., None], cancelled: threading.Event
) -> dict[str, Any]:
    """Draws every mouth shape and the blink from `base` into `outDir`, as full pictures where
    only the mouth (or eyes) differs from the base. Returns {shape: path} plus "base" (the
    original picture)."""
    base = Path(str(params["base"]))
    out_dir = Path(str(params["outDir"]))
    out_dir.mkdir(parents=True, exist_ok=True)
    models_dir = str(params["modelsDir"])
    seed = int(params.get("seed", 42))
    # "base" is the untouched picture: blinks are measured against it. "rest" (closed lips)
    # starts as the base and is replaced by its edit when that comes out.
    result: dict[str, str] = {"base": str(base), "rest": str(base)}
    raw_dir = out_dir / "edits"
    raw_dir.mkdir(exist_ok=True)
    names = list(SHAPES)
    for i, name in enumerate(names):
        if cancelled.is_set():
            raise Cancelled()
        progress(i / len(names), f"Drawing mouth shape {i + 1} of {len(names)}…")
        edit = raw_dir / f"{name}.png"
        if _fake():
            _fake_edit(base, edit, name)
        else:
            _klein_edit(models_dir, base, edit, SHAPES[name], seed, cancelled)
        target = out_dir / f"{name}.png"
        if cut_out(base, edit, target, eyes=name == "blink"):
            result[name] = str(target)
    for name, fallback in FALLBACK.items():
        if name not in result:
            result[name] = result.get(fallback) or result["rest"]
    progress(1.0, "Mouth shapes ready")
    return {"shapes": result}


def _klein_edit(
    models_dir: str,
    base: Path,
    out: Path,
    prompt: str,
    seed: int,
    cancelled: threading.Event,
    refs: list[Path] | None = None,
    size: tuple[int, int] | None = None,
) -> None:
    from PIL import Image

    if size:
        width, height = size
    else:
        with Image.open(base) as im:
            width, height = im.size
    m = model_dir(models_dir)
    ref_args: list[str] = []
    for r in refs or [base]:
        ref_args += ["-r", str(r)]
    args = [
        "--diffusion-model",
        str(m / KLEIN_FILES[0][0]),
        "--llm",
        str(m / KLEIN_FILES[1][0]),
        "--vae",
        str(m / KLEIN_FILES[2][0]),
        *ref_args,
        "-p",
        prompt,
        "--cfg-scale",
        "1.0",
        "--steps",
        "4",
        "--sampling-method",
        "euler",
        "-W",
        str(width),
        "-H",
        str(height),
        "-s",
        str(seed),
        *images.MEMORY_ARGS,
        "-o",
        str(out),
    ]
    try:
        images.run_engine(models_dir, args, out, cancelled, None, "The mouth-shape engine")
    except images.Cancelled as e:
        raise Cancelled() from e


def draw_with_references(
    params: dict[str, Any], progress: Callable[..., None], cancelled: threading.Event
) -> dict[str, Any]:
    """Draws a new picture of characters from their reference pictures (ADR-052): FLUX.2 Klein
    keeps their faces, hair and clothing while the prompt sets the scene."""
    refs = [Path(str(r)) for r in params["refs"]]
    out = Path(str(params["out"]))
    out.parent.mkdir(parents=True, exist_ok=True)
    width, height = int(params.get("width", 768)), int(params.get("height", 1344))
    progress(0.05, "Drawing the shot…")
    if _fake():
        from PIL import Image

        with Image.open(refs[0]) as im:
            pic = im.convert("RGB").resize((width // 4, height // 4))
        Image.eval(pic, lambda v: max(0, v - 20)).save(out)
    else:
        _klein_edit(
            str(params["modelsDir"]),
            refs[0],
            out,
            str(params["prompt"]),
            int(params.get("seed", 42)),
            cancelled,
            refs=refs,
            size=(width, height),
        )
    progress(1.0, "Shot drawn")
    return {"out": str(out)}


def _fake_edit(base: Path, out: Path, name: str) -> None:
    """Stand-in for the editing model: the base picture with a mouth (or closed eyes) drawn on,
    plus a slight overall tint like a real edit's drift, so the cut-out is really exercised."""
    from PIL import Image, ImageDraw

    with Image.open(base) as im:
        pic = im.convert("RGB")
    w, h = pic.size
    pic = Image.eval(pic, lambda v: min(255, v + 2))
    d = ImageDraw.Draw(pic)
    cx, cy = w // 2, int(h * 0.42)
    size = {"open": (0.10, 0.06), "mid": (0.08, 0.025), "wide": (0.12, 0.02)}
    size.update({"round": (0.04, 0.04), "fv": (0.09, 0.015)})
    if name == "blink":
        for ex in (cx - w // 8, cx + w // 8):
            d.line([(ex - w // 20, int(h * 0.3)), (ex + w // 20, int(h * 0.3))], (20, 20, 20), 6)
    else:
        if name == "rest":  # closed lips: a thin lip-coloured line
            box = [cx - 0.05 * w, cy - 0.006 * h, cx + 0.05 * w, cy + 0.006 * h]
            d.ellipse(box, fill=(200, 110, 110))
        else:
            rx, ry = size[name]
            box = [cx - rx * w / 2, cy - ry * h / 2, cx + rx * w / 2, cy + ry * h / 2]
            d.ellipse(box, fill=(60, 15, 20))
    pic.save(out)


def cut_out(base: Path, edit: Path, out: Path, eyes: bool = False) -> bool:
    """Blends only the changed area of `edit` onto `base` and writes it to `out`. The change is
    found by comparing the two (after blurring away noise and the model's slight overall drift),
    keeping the largest changed region and feathering its edge. False when no clear, compact
    change is found (the shape is then skipped and a neighbouring one used)."""
    import numpy as np
    from PIL import Image, ImageFilter

    with Image.open(base) as a, Image.open(edit) as b:
        a = a.convert("RGB")
        b = b.convert("RGB")
        if b.size != a.size:
            b = b.resize(a.size, Image.Resampling.LANCZOS)
        w, h = a.size
        # Compare at a quarter size: faster, and small misalignments do not count as change.
        small = (max(1, w // 4), max(1, h // 4))
        sa = np.asarray(a.resize(small, Image.Resampling.BILINEAR), dtype=np.float32)
        sb = np.asarray(b.resize(small, Image.Resampling.BILINEAR), dtype=np.float32)
        diff = np.abs(sa - sb).mean(axis=2)
        diff -= np.median(diff)  # the model's overall drift
        diff_img = Image.fromarray(np.clip(diff * 4, 0, 255).astype(np.uint8))
        # Blurring fades thin outlines (the model redrawing edges a pixel off) while solid areas
        # of change, like an opened mouth, stay strong.
        blur = max(0.75, small[1] / 120)  # about 3 at 768x1344; scaled for other sizes
        smooth = np.asarray(diff_img.filter(ImageFilter.GaussianBlur(blur)), dtype=np.float32) / 4
        peak = float(smooth.max())
        if peak < 10:
            return False
        mask = smooth > max(6.0, peak * 0.45)
        # The changed region with the strongest change is the mouth; thin outlines the model
        # redrew can cover more pixels but change less. Eyes are two regions: every region with
        # at least a third of that one's strength joins it.
        region = _main_regions(mask, smooth, 0.33 if eyes else 1.0)
        if region is None:
            return False
        y0, y1, x0, x1 = region
        rh, rw = y1 - y0, x1 - x0
        # A mouth or a pair of eyes is a small part of the picture; a big change means the model
        # redrew the character, which would flicker.
        if rw * rh > 0.12 * small[0] * small[1]:
            return False
        if not eyes and rh > 0.25 * small[1]:
            return False
        # Feathered ellipse around the region (with margin), at full size.
        # Generous sideways: the old mouth (a smile, say) can be wider than the new one.
        pad_x, pad_y = max(3, int(rw * 0.9)), max(3, rh // 2)
        cx, cy = (x0 + x1) / 2 * 4, (y0 + y1) / 2 * 4
        ax, ay = (rw / 2 + pad_x) * 4, (rh / 2 + pad_y) * 4
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        r = ((xx - cx) / ax) ** 2 + ((yy - cy) / ay) ** 2
        alpha = np.clip((1.0 - r) / 0.45, 0.0, 1.0)  # solid core, soft rim
        alpha = alpha * alpha * (3 - 2 * alpha)
        fa = np.asarray(a, dtype=np.float32)
        fb = np.asarray(b, dtype=np.float32)
        mixed = fa * (1 - alpha[..., None]) + fb * alpha[..., None]
        Image.fromarray(np.clip(mixed + 0.5, 0, 255).astype(np.uint8)).save(out)
    return True


def _main_regions(mask: Any, strength: Any, share: float = 1.0) -> tuple[int, int, int, int] | None:
    """Bounding box (y0, y1, x0, x1) around the 4-connected True region holding the strongest
    change, joined with any region whose total strength is at least `share` of that one's."""
    import numpy as np

    h, w = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    regions: list[tuple[float, float, tuple[int, int, int, int]]] = []  # (total, peak, box)
    ys, xs = np.nonzero(mask)
    for sy, sx in zip(ys.tolist(), xs.tolist(), strict=True):
        if seen[sy, sx]:
            continue
        stack = [(sy, sx)]
        seen[sy, sx] = True
        total, top, y0, y1, x0, x1 = 0.0, 0.0, sy, sy, sx, sx
        while stack:
            y, x = stack.pop()
            v = float(strength[y, x])
            total += v
            top = max(top, v)
            y0, y1, x0, x1 = min(y0, y), max(y1, y), min(x0, x), max(x1, x)
            for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    stack.append((ny, nx))
        regions.append((total, top, (y0, y1 + 1, x0, x1 + 1)))
    if not regions:
        return None
    main = max(regions, key=lambda r: r[1])
    kept = [main[2]] + [
        box for total, _top, box in regions if box != main[2] and total >= share * main[0]
    ]
    return (
        min(b[0] for b in kept),
        max(b[1] for b in kept),
        min(b[2] for b in kept),
        max(b[3] for b in kept),
    )


# ---- Rendering a line -------------------------------------------------------------------------


def blinks(duration: float, seed: int) -> list[tuple[float, float]]:
    """Natural blinks: about every 2.5–5 s, 0.13 s each, none in the first half second."""
    rnd = random.Random(seed)
    out: list[tuple[float, float]] = []
    t = 0.5 + rnd.uniform(0.5, 2.0)
    while t + 0.13 < duration:
        out.append((t, t + 0.13))
        t += rnd.uniform(2.5, 5.0)
    return out


def render(
    params: dict[str, Any], progress: Callable[..., None], cancelled: threading.Event
) -> dict[str, Any]:
    """Renders a talking clip: the shape pictures switched by the timeline, with blinks, as an
    H.264 MP4 at 30 fps (no sound; the voice stays its own clip)."""
    from PIL import Image

    shapes: dict[str, str] = {k: str(v) for k, v in dict(params["shapes"]).items()}
    sounds: list[dict[str, Any]] = list(params["sounds"])
    duration = float(params["duration"])
    out = Path(str(params["out"])).with_suffix(".mp4")
    ffmpeg = str(params["ffmpeg"])
    work = out.parent / f".{out.stem}-frames"
    work.mkdir(parents=True, exist_ok=True)
    progress(0.05, "Timing the mouth to the voice…")
    audio = params.get("audio")
    segs = (
        timeline_from_audio(
            intensity(Path(str(audio))),
            sounds,
            duration,
            liveliness=float(params.get("liveliness", 0.6)),
        )
        if audio
        else timeline(sounds, duration)
    )
    blink_spans = blinks(duration, int(params.get("seed", 7))) if "blink" in shapes else []

    # Split the shape timeline at blinks; a blink frame is the shape with the eyes closed.
    events: list[tuple[str, bool, float, float]] = []
    for seg in segs:
        cuts = sorted(
            {seg["start"], seg["end"]}
            | {t for b in blink_spans for t in b if seg["start"] < t < seg["end"]}
        )
        for a, b in zip(cuts, cuts[1:], strict=False):
            mid = (a + b) / 2
            closed = any(s <= mid < e for s, e in blink_spans)
            events.append((seg["shape"], closed, a, b))

    cache: dict[tuple[str, bool], Path] = {}

    def picture(shape: str, closed: bool) -> Path:
        key = (shape, closed)
        if key not in cache:
            path = Path(shapes.get(shape) or shapes["rest"])
            if closed:
                eyes = _eyes_mask(Path(shapes.get("base", shapes["rest"])), Path(shapes["blink"]))
                with Image.open(path) as p, Image.open(shapes["blink"]) as bl:
                    mixed = Image.composite(bl.convert("RGB"), p.convert("RGB"), eyes)
                    path = work / f"{shape}-blink.png"
                    mixed.save(path)
            cache[key] = path
        return cache[key]

    # FFmpeg's concat list: each picture with its duration, frame-quantised so the total is exact.
    lines = ["ffconcat version 1.0"]
    frame = 1 / FPS
    t_done = 0.0
    last: Path | None = None
    for shape, closed, _a, b in events:
        if cancelled.is_set():
            raise Cancelled()
        end_frame = round(b / frame) * frame
        dur = end_frame - t_done
        if dur <= 1e-6:
            continue
        last = picture(shape, closed)
        lines += [f"file '{_concat_path(last)}'", f"duration {dur:.6f}"]
        t_done = end_frame
    if last is None:
        last = Path(shapes["rest"])
        lines += [f"file '{_concat_path(last)}'", f"duration {max(frame, duration):.6f}"]
    lines.append(f"file '{_concat_path(last)}'")  # the concat demuxer's last-entry rule
    listing = work / "list.ffconcat"
    listing.write_text("\n".join(lines) + "\n", encoding="utf-8")
    progress(0.4, "Animating the mouth…")
    flags = 0x08000000 if sys.platform == "win32" else 0
    proc = subprocess.run(
        [
            ffmpeg,
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(listing),
            "-t",
            f"{duration:.3f}",
            "-vf",
            f"fps={FPS},scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "16",
            "-movflags",
            "+faststart",
            str(out),
        ],
        # Never the sidecar's stdin (the JSON-RPC channel): FFmpeg would read it for key presses
        # and swallow the backend's messages, so the job never reports back.
        stdin=subprocess.DEVNULL,
        capture_output=True,
        creationflags=flags,
        # A clip takes seconds; never wait forever on a stuck FFmpeg.
        timeout=max(120.0, duration * 10),
    )
    if proc.returncode != 0:
        raise RuntimeError(f"FFmpeg could not assemble the clip: {proc.stderr.decode()[-300:]}")
    progress(1.0, "Clip ready")
    return {"video": str(out), "seconds": duration, "segments": segs}


def _concat_path(p: Path) -> str:
    return str(p.resolve()).replace("\\", "/").replace("'", "'\\''")


_eyes_cache: dict[tuple[str, str], Any] = {}


def _eyes_mask(base: Path, blink: Path) -> Any:
    """The blink picture's changed area as a mask (it was cut out against the base already)."""
    import numpy as np
    from PIL import Image

    key = (str(base), str(blink))
    if key not in _eyes_cache:
        with Image.open(base) as a, Image.open(blink) as b:
            d = np.abs(
                np.asarray(a.convert("RGB"), dtype=np.int16)
                - np.asarray(b.convert("RGB"), dtype=np.int16)
            ).max(axis=2)
        _eyes_cache[key] = Image.fromarray(np.where(d > 0, 255, 0).astype(np.uint8))
    return _eyes_cache[key]
