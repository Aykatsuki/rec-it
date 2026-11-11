"""Minimal JSON-RPC 2.0 over newline-delimited stdio (ADR-014).

stdout carries protocol messages only; all logging goes to stderr.
"""

from __future__ import annotations

import json
import sys
import traceback
from collections.abc import Callable
from typing import IO, Any

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603

Handler = Callable[[dict[str, Any]], Any]


class RpcError(Exception):
    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data


def log(*parts: object) -> None:
    print("[media-ai]", *parts, file=sys.stderr, flush=True)


class Server:
    def __init__(self, handlers: dict[str, Handler], out: IO[str] | None = None) -> None:
        self.handlers = handlers
        self.out = out or sys.stdout

    def send(self, message: dict[str, Any]) -> None:
        self.out.write(json.dumps(message, separators=(",", ":")) + "\n")
        self.out.flush()

    def notify(self, method: str, params: dict[str, Any]) -> None:
        """Server → client notification, e.g. job progress."""
        self.send({"jsonrpc": "2.0", "method": method, "params": params})

    def handle_line(self, line: str) -> None:
        line = line.strip()
        if not line:
            return
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            self.send(_error(None, PARSE_ERROR, "Parse error"))
            return
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
            self.send(_error(_id(message), INVALID_REQUEST, "Invalid request"))
            return
        method = message.get("method")
        request_id = message.get("id")
        params = message.get("params", {})
        if not isinstance(method, str) or not isinstance(params, dict):
            self.send(_error(request_id, INVALID_REQUEST, "Invalid request"))
            return
        handler = self.handlers.get(method)
        if handler is None:
            if request_id is not None:
                self.send(_error(request_id, METHOD_NOT_FOUND, f"Unknown method {method!r}"))
            return
        try:
            result = handler(params)
        except RpcError as e:
            if request_id is not None:
                self.send(_error(request_id, e.code, e.message, e.data))
            return
        except Exception as e:  # noqa: BLE001 - report every failure to the caller
            log("handler error", method, traceback.format_exc())
            if request_id is not None:
                self.send(_error(request_id, INTERNAL_ERROR, str(e) or type(e).__name__))
            return
        if request_id is not None:
            self.send({"jsonrpc": "2.0", "id": request_id, "result": result})

    def serve(self, stream: IO[str] | None = None) -> None:
        for line in stream or sys.stdin:
            self.handle_line(line)


def _id(message: object) -> Any:
    return message.get("id") if isinstance(message, dict) else None


def _error(request_id: Any, code: int, message: str, data: Any = None) -> dict[str, Any]:
    error: dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        error["data"] = data
    return {"jsonrpc": "2.0", "id": request_id, "error": error}
