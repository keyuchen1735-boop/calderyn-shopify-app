"""Vercel Python Serverless Function: POST /api/engine/run.

Body: {"shop_id": "<uuid>"}; requires `Authorization: Bearer $CRON_SECRET`.
Delegates all logic to _core.handle so it stays unit-testable.

Reserved URL: this function owns /api/engine/run. No Remix route may share it —
a route at the same URL collides at the build-output function dir and 501s every
route (2026-06-16 outage). New TS detectors go to /api/detectors/run instead.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from http.server import BaseHTTPRequestHandler

# The engine package + _core live at the repo-root `engine/` (NOT under api/,
# so Vercel doesn't treat them as functions). They're bundled into this
# function via `includeFiles: "engine/**"` in vercel.json.
_engine_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "engine"))
if _engine_dir not in sys.path:
    sys.path.insert(0, _engine_dir)

from _core import handle  # noqa: E402


class handler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:  # noqa: N802 - Vercel/BaseHTTPRequestHandler API
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            self._send(400, {"error": "invalid json"})
            return
        authorization = self.headers.get("authorization")
        status, payload = asyncio.run(handle(body, authorization))
        self._send(status, payload)

    def _send(self, status: int, payload: dict) -> None:
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
