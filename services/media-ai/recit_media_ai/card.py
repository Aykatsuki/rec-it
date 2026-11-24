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
