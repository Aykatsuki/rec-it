"""Runs inside the separate Chatterbox environment (ADR-051), not the sidecar's: it imports only
the standard library, torch, torchaudio and chatterbox. Started as `python -I <this file> <request
json>`; prints one JSON line per progress step and a final {"done": ...} or {"error": ...}.

Request: {"mode": "download"} or {"mode": "speak", "parts": [{"id", "text"}], "voice": "builtin" or
a WAV path, "outDir": folder}. Speak writes <outDir>/<id>.wav (24 kHz) and <id>-16k.wav (for the
word timer) per part. Long parts are said sentence by sentence and joined with short pauses,
which keeps Turbo steady on long scripts.
"""

from __future__ import annotations

import json
import re
import sys
import traceback
from pathlib import Path

REPO = "ResembleAI/chatterbox-turbo"
PAUSE = 0.18  # seconds between sentences of one part


def say(message: dict) -> None:
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def sentences(text: str) -> list[str]:
    parts = [p.strip() for p in re.split(r"(?<=[.!?…])\s+", text.strip()) if p.strip()]
    out: list[str] = []
    for p in parts:
        while len(p) > 280:  # very long sentence: break at a comma near the middle
            cut = p.rfind(",", 0, 280)
            cut = cut if cut > 60 else 280
            out.append(p[: cut + 1].strip())
            p = p[cut + 1 :].strip()
        if p:
            out.append(p)
    return out or [text.strip()]


def download() -> None:
    from huggingface_hub import snapshot_download

    say({"progress": 0.1, "message": "Downloading the voice model…"})
    snapshot_download(
        repo_id=REPO,
        allow_patterns=["*.safetensors", "*.json", "*.txt", "*.pt", "*.model"],
    )
    say({"done": {"downloaded": True}})


def speak(req: dict) -> None:
    import torch
    import torchaudio
    from chatterbox.tts_turbo import ChatterboxTurboTTS

    device = "cuda" if torch.cuda.is_available() else "cpu"
    where = "graphics card" if device == "cuda" else "processor"
    say({"progress": 0.02, "message": f"Loading the voice on the {where}…"})
    model = ChatterboxTurboTTS.from_pretrained(device=device)
    voice = req.get("voice") or "builtin"
    if voice != "builtin":
        model.prepare_conditionals(voice)
    out_dir = Path(req["outDir"])
    out_dir.mkdir(parents=True, exist_ok=True)
    parts = req["parts"]
    total = sum(len(p["text"]) for p in parts) or 1
    done = 0
    results = []
    for part in parts:
        pieces = []
        for s in sentences(part["text"]):
            with torch.inference_mode():
                wav = model.generate(s)
            pieces.append(wav.reshape(1, -1).cpu())
            pieces.append(torch.zeros(1, int(PAUSE * model.sr)))
            done += len(s)
            say({"progress": 0.05 + 0.9 * done / total, "message": "Speaking…"})
        audio = torch.cat(pieces[:-1], dim=1) if pieces else torch.zeros(1, 1)
        path = out_dir / f"{part['id']}.wav"
        torchaudio.save(str(path), audio, model.sr, encoding="PCM_S", bits_per_sample=16)
        low = torchaudio.functional.resample(audio, model.sr, 16000)
        torchaudio.save(
            str(out_dir / f"{part['id']}-16k.wav"), low, 16000, encoding="PCM_S", bits_per_sample=16
        )
        results.append({"id": part["id"], "wav": str(path), "seconds": audio.shape[1] / model.sr})
    say({"done": {"parts": results, "sampleRate": model.sr, "device": device}})


def main() -> int:
    try:
        req = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
        if req.get("mode") == "download":
            download()
        else:
            speak(req)
        return 0
    except Exception as e:  # noqa: BLE001 - reported to the sidecar
        sys.stderr.write(traceback.format_exc())
        say({"error": str(e) or type(e).__name__})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
