"""Vercel Python Serverless Function: POST /api/engine/run.

Body: {"shop_id": "<uuid>"}; requires `Authorization: Bearer $CRON_SECRET`.
Delegates all logic to _core.handle so it stays unit-testable.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from http.server import BaseHTTPRequestHandler

_engine_dir = os.path.dirname(__file__)
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
