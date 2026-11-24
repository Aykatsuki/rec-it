"""Title cards for story templates (Phase 8, ADR-046): a forum-post style card drawn with Pillow
and Rec-It's bundled fonts, saved as a transparent PNG that becomes an ordinary image clip.

The card is generic (avatar, community, user, title, vote and comment counts). It carries no
platform logos or wordmarks; the community name is whatever the user types.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

WIDTH = 960
PAD = 44
RADIUS = 36

THEMES = {
    "light": {"bg": (255, 255, 255, 255), "text": (26, 26, 27), "muted": (120, 124, 126)},
    "dark": {"bg": (26, 26, 27, 255), "text": (215, 218, 220), "muted": (129, 131, 132)},
}
AVATAR_COLOURS = [(255, 69, 0), (0, 121, 211), (70, 209, 96), (255, 176, 0), (148, 87, 235)]


def _wrap(draw: Any, text: str, font: Any, width: int, max_lines: int) -> list[str]:
    words = text.split()
    lines: list[str] = []
    cur = ""
    for w in words:
        trial = f"{cur} {w}".strip()
        if draw.textlength(trial, font=font) <= width or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    if len(lines) > max_lines:
        lines = lines[:max_lines]
        last = lines[-1]
        while last and draw.textlength(last + "…", font=font) > width:
            last = last[:-1]
        lines[-1] = last.rstrip() + "…"
    return lines


def _count(n: int) -> str:
    return f"{n / 1000:.1f}k".replace(".0k", "k") if n >= 1000 else str(n)


def _plain_png(path: str, width: int, height: int) -> None:
    """A white card without Pillow (the fake voice engine in tests runs without the extra)."""
    import struct
    import zlib

    row = b"\x00" + b"\xff\xff\xff\xff" * width
    raw = zlib.compress(row * height)

    def chunk(kind: bytes, data: bytes) -> bytes:
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", raw) + chunk(b"IEND", b"")
    Path(path).write_bytes(png)


def render(params: dict[str, Any]) -> dict[str, Any]:
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        import os

        if os.environ.get("RECIT_FAKE_TTS") != "1":
            raise
        _plain_png(str(params["out"]), WIDTH, 400)
        return {"out": str(params["out"]), "width": WIDTH, "height": 400}

    fonts = Path(str(params["fontsDir"]))
    theme = THEMES.get(str(params.get("theme", "light")), THEMES["light"])
    title_font = ImageFont.truetype(str(fonts / "Poppins-Bold.ttf"), 50)
    name_font = ImageFont.truetype(str(fonts / "Poppins-Bold.ttf"), 30)
    small_font = ImageFont.truetype(str(fonts / "Poppins-SemiBold.ttf"), 26)
    community = str(params.get("community", "")).strip()[:40]
    user = str(params.get("username", "")).strip()[:40]
    title = str(params["title"]).strip()

    probe = ImageDraw.Draw(Image.new("RGBA", (1, 1)))
    lines = _wrap(probe, title, title_font, WIDTH - 2 * PAD, 6)
    line_h = 64
    header_h = 84
    footer_h = 64
    height = PAD + header_h + 24 + line_h * len(lines) + 28 + footer_h + PAD

    img = Image.new("RGBA", (WIDTH, height), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, WIDTH - 1, height - 1), RADIUS, fill=theme["bg"])

    # Header: avatar with the community's first letter, community and user.
    seed = sum(map(ord, community or user or "x"))
    colour = AVATAR_COLOURS[seed % len(AVATAR_COLOURS)]
    d.ellipse((PAD, PAD, PAD + header_h, PAD + header_h), fill=colour)
    letter = (community.removeprefix("r/").removeprefix("/") or user or "?")[:1].upper()
    d.text(
        (PAD + header_h / 2, PAD + header_h / 2), letter, font=name_font, fill="white", anchor="mm"
    )
    x = PAD + header_h + 20
    d.text((x, PAD + 6), community or user, font=name_font, fill=theme["text"])
    if community and user:
        d.text((x, PAD + 46), f"u/{user.removeprefix('u/')}", font=small_font, fill=theme["muted"])

    y = PAD + header_h + 24
    for line in lines:
        d.text((PAD, y), line, font=title_font, fill=theme["text"])
        y += line_h
    y += 28

    # Footer: upvote arrow and count, comment bubble and count.
    up = int(params.get("upvotes", 0) or 0)
    comments = int(params.get("comments", 0) or 0)
    fy = y + footer_h / 2
    ax = PAD + 4
    d.polygon([(ax, fy + 8), (ax + 16, fy - 14), (ax + 32, fy + 8)], fill=theme["muted"])
    d.rectangle((ax + 10, fy + 8, ax + 22, fy + 18), fill=theme["muted"])
    d.text((ax + 46, fy), _count(up), font=small_font, fill=theme["text"], anchor="lm")
    bx = ax + 46 + d.textlength(_count(up), font=small_font) + 48
    d.rounded_rectangle((bx, fy - 15, bx + 36, fy + 11), 9, outline=theme["muted"], width=4)
    d.polygon([(bx + 8, fy + 9), (bx + 8, fy + 20), (bx + 18, fy + 9)], fill=theme["muted"])
    d.text((bx + 50, fy), _count(comments), font=small_font, fill=theme["text"], anchor="lm")

    out = str(params["out"])
    img.save(out, "PNG")
    return {"out": out, "width": WIDTH, "height": height}


# ---- Motion-graphics backgrounds (ADR-047) ---------------------------------------------------


def _hex(c: str) -> tuple[int, int, int]:
    c = c.lstrip("#")
    return int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)


def background(params: dict[str, Any]) -> dict[str, Any]:
    """
    A designed backdrop for one scene: a diagonal gradient between the palette's first two
    colours, large soft glows of the others, and fine grain so it does not band. Rec-It animates
    it (slow zoom, drift) under the captions.
    """
    import hashlib
    import random

    out = str(params["out"])
    width = int(params.get("width", 1080))
    height = int(params.get("height", 1920))
    palette = [_hex(c) for c in params.get("palette") or ["#1E1B4B", "#7C3AED", "#F472B6"]]
    while len(palette) < 3:
        palette.append(palette[-1])
    seed = int(hashlib.sha256(str(params.get("seed", "")).encode()).hexdigest()[:8], 16)
    rnd = random.Random(seed)
    try:
        from PIL import Image, ImageDraw, ImageFilter
    except ImportError:
        from .images import _gradient_png

        _gradient_png(out, str(seed), 64, 112)
        return {"out": out}

    # Gradient at a small scale, then enlarged (smooth and fast).
    small = Image.new("RGB", (54, 96))
    a, b = palette[0], palette[1]
    angle = rnd.random()
    for y in range(96):
        for x in range(54):
            t = min(1.0, max(0.0, (y / 95) * (1 - angle) + (x / 53) * angle))
            small.putpixel((x, y), tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3)))
    img = small.resize((width, height), Image.BICUBIC).convert("RGBA")
    glow = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    d = ImageDraw.Draw(glow)
    for k in range(5):
        colour = palette[2 + k % max(1, len(palette) - 2)]
        r = rnd.uniform(0.25, 0.55) * width
        cx, cy = rnd.uniform(0, width), rnd.uniform(0, height)
        d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(*colour, rnd.randint(70, 140)))
    glow = glow.filter(ImageFilter.GaussianBlur(width * 0.12))
    img = Image.alpha_composite(img, glow)
    # Light geometry: rings, a dot grid and a rounded frame, faint so captions stay readable.
    shapes = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    s = ImageDraw.Draw(shapes)
    line = max(2, width // 270)
    for _ in range(3):
        r = rnd.uniform(0.12, 0.4) * width
        cx, cy = rnd.uniform(0, width), rnd.uniform(0, height)
        s.ellipse((cx - r, cy - r, cx + r, cy + r), outline=(255, 255, 255, 46), width=line)
    gx, gy = rnd.choice([0.08, 0.62]) * width, rnd.choice([0.06, 0.72]) * height
    step = width * 0.035
    for i in range(7):
        for j in range(7):
            x, y = gx + i * step, gy + j * step
            s.ellipse((x - line, y - line, x + line, y + line), fill=(255, 255, 255, 60))
    m = width * 0.06
    s.rounded_rectangle(
        (m, m, width - m, height - m), width * 0.05, outline=(255, 255, 255, 28), width=line
    )
    img = Image.alpha_composite(img, shapes)
    grain = Image.effect_noise((width // 2, height // 2), 18).resize((width, height))
    img = Image.blend(img.convert("RGB"), Image.merge("RGB", [grain] * 3), 0.04)
    img.save(out, "PNG")
    return {"out": out}
