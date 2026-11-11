import io
import json
import subprocess
import sys
from pathlib import Path

from recit_media_ai.rpc import Server
from recit_media_ai.server import HANDLERS
from recit_media_ai.system import parse_nvidia_smi

ROOT = Path(__file__).resolve().parents[1]


def run(lines: list[str]) -> list[dict]:
    out = io.StringIO()
    server = Server(HANDLERS, out=out)
    for line in lines:
        server.handle_line(line)
    return [json.loads(line) for line in out.getvalue().splitlines()]


def test_ping_and_version():
    replies = run(
        [
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": "ping", "params": {"echo": "hi"}}),
            json.dumps({"jsonrpc": "2.0", "id": 2, "method": "version"}),
        ]
    )
    assert replies[0]["result"]["pong"] is True
    assert replies[0]["result"]["echo"] == "hi"
    assert replies[1]["result"]["version"]


def test_errors_do_not_stop_the_server():
    replies = run(
        [
            "{not json",
            json.dumps([1, 2]),
            json.dumps({"jsonrpc": "2.0", "id": 3, "method": "nope"}),
            json.dumps(
                {"jsonrpc": "2.0", "id": 4, "method": "debug.sleep", "params": {"seconds": "x"}}
            ),
            json.dumps({"jsonrpc": "2.0", "id": 5, "method": "ping"}),
        ]
    )
    codes = [r.get("error", {}).get("code") for r in replies]
    assert codes == [-32700, -32600, -32601, -32602, None]
    assert replies[-1]["result"]["pong"] is True


def test_notifications_get_no_reply():
    assert run([json.dumps({"jsonrpc": "2.0", "method": "ping"})]) == []


def test_parse_nvidia_smi():
    out = "NVIDIA GeForce RTX 3070, 8192, 566.36\nbad line\n"
    assert parse_nvidia_smi(out) == [
        {"name": "NVIDIA GeForce RTX 3070", "memoryMb": 8192, "driverVersion": "566.36"}
    ]


def test_system_info_shape():
    result = HANDLERS["system.info"]({})
    assert isinstance(result["gpus"], list)
    assert result["cuda"]["via"] in {"ctranslate2", "nvidia-smi", "none"}


def test_stdio_process_end_to_end():
    """Runs the real module as the backend does: stdin requests, stdout replies, stderr logs."""
    proc = subprocess.run(
        [sys.executable, "-m", "recit_media_ai"],
        input=json.dumps({"jsonrpc": "2.0", "id": 9, "method": "ping"}) + "\n",
        capture_output=True,
        text=True,
        cwd=ROOT,
        timeout=30,
    )
    assert proc.returncode == 0
    lines = proc.stdout.splitlines()
    assert len(lines) == 1 and json.loads(lines[0])["id"] == 9
    assert "[media-ai]" in proc.stderr
