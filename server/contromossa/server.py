"""HTTP + Server-Sent-Events front end around the Engine (standard library only).

  GET  /                     big screen
  GET  /control              operator panel
  GET  /api/state?role=      one snapshot (JSON)
  GET  /api/events?role=     SSE stream of snapshots (also re-sent every second as keep-alive)
  POST /api/cmd              {"name": ..., "args": {...}}   (control only)
  GET  /api/export.csv       results (control only)
  GET  /i18n/<lang>.json     UI strings
  GET  /static/...           css/js

If a token is configured, control endpoints require it (header X-Token or ?token=).
The screen role is read-only and never needs it.
"""
from __future__ import annotations

import hmac
import json
import os
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional
from urllib.parse import parse_qs, urlparse

from .engine import CommandError, Engine
from .links import Transport

WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web")
MAX_BODY = 64 * 1024
SSE_MIN_GAP_S = 0.1
SSE_KEEPALIVE_S = 1.0
TICK_S = 0.05

MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon",
        ".woff2": "font/woff2"}


class QuietServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        import sys
        if isinstance(sys.exc_info()[1], (ConnectionError, TimeoutError)):
            return          # browsers closing tabs / reloading is normal
        super().handle_error(request, client_address)


class App:
    def __init__(self, engine: Engine, transport: Optional[Transport] = None,
                 token: Optional[str] = None, web_dir: str = WEB_DIR):
        self.engine = engine
        self.transport = transport
        self.token = token or None
        self.web_dir = os.path.abspath(web_dir)
        self.cond = threading.Condition()
        self._stop = threading.Event()
        self._ticker: Optional[threading.Thread] = None
        self.httpd: Optional[ThreadingHTTPServer] = None
        self.sse_clients = 0
        self._sse_lock = threading.Lock()
        engine.send = self._send

    # ---- plumbing
    def _send(self, line: str):
        if self.transport is not None:
            self.transport.write(line)

    def _on_line(self, line: str):
        self.engine.handle_line(line)

    def _on_status(self, up: bool, detail: str):
        self.engine.set_link(up, detail)

    def start_background(self):
        if self.transport is not None:
            self.transport.start(self._on_line, self._on_status)
        self._ticker = threading.Thread(target=self._tick_loop, daemon=True)
        self._ticker.start()

    def _tick_loop(self):
        last = -1
        while not self._stop.is_set():
            t0 = time.monotonic()
            try:
                self.engine.tick()
            except Exception as e:      # the ticker must survive anything
                try:
                    self.engine._log("log.internal_error", "warn", detail=repr(e))
                except Exception:
                    pass
            v = self.engine.version
            if v != last:
                last = v
                with self.cond:
                    self.cond.notify_all()
            self._stop.wait(max(0.0, TICK_S - (time.monotonic() - t0)))

    def serve(self, host: str, port: int) -> ThreadingHTTPServer:
        app = self

        class H(Handler):
            pass
        H.app = app
        self.httpd = QuietServer((host, port), H)
        return self.httpd

    def shutdown(self):
        self._stop.set()
        with self.cond:
            self.cond.notify_all()
        if self.httpd:
            self.httpd.shutdown()
            self.httpd.server_close()
        if self.transport:
            self.transport.close()

    def authorized(self, handler: "Handler", query: dict) -> bool:
        if not self.token:
            return True
        given = handler.headers.get("X-Token") or (query.get("token") or [""])[0]
        return hmac.compare_digest(given.encode(), self.token.encode())


class Handler(BaseHTTPRequestHandler):
    app: App
    protocol_version = "HTTP/1.1"
    server_version = "Contromossa"

    def log_message(self, fmt, *args):          # quiet; the engine log is the record
        pass

    # ---- helpers
    def _json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", MIME[".json"])
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _bytes(self, data: bytes, ctype: str, status=200, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _static(self, rel: str):
        # Only the two public sub-folders are ever served, and nothing outside them.
        top = rel.split("/", 1)[0]
        base = os.path.join(self.app.web_dir, top)
        path = os.path.normpath(os.path.join(self.app.web_dir, rel))
        if top not in ("static", "i18n") or os.path.commonpath([base, path]) != base or not os.path.isfile(path):
            return self._json({"error": "not found"}, 404)
        with open(path, "rb") as f:
            data = f.read()
        self._bytes(data, MIME.get(os.path.splitext(path)[1].lower(), "application/octet-stream"))

    @staticmethod
    def _role(q: dict) -> str:
        return "control" if (q.get("role") or [""])[0] == "control" else "screen"

    # ---- routes
    def do_GET(self):
        try:
            u = urlparse(self.path)
            q = parse_qs(u.query)
            p = u.path
            if p in ("/", "/screen"):
                return self._static("static/screen.html")
            if p == "/control":
                return self._static("static/control.html")
            if p.startswith("/static/"):
                return self._static(p[1:])
            if p.startswith("/i18n/") and p.endswith(".json"):
                lang = p[len("/i18n/"):-5]
                if not lang.replace("-", "").isalnum():
                    return self._json({"error": "bad language"}, 400)
                return self._static(f"i18n/{lang}.json")
            if p in ("/api/state", "/api/events", "/api/export.csv"):
                role = self._role(q)
                if (role == "control" or p == "/api/export.csv") and not self.app.authorized(self, q):
                    return self._json({"error": "unauthorized"}, 401)
                if p == "/api/state":
                    return self._json(self.app.engine.snapshot(role))
                if p == "/api/export.csv":
                    return self._bytes(self.app.engine.export_csv().encode("utf-8-sig"),
                                       "text/csv; charset=utf-8",
                                       extra={"Content-Disposition": 'attachment; filename="risultati.csv"'})
                return self._sse(role)
            if p == "/api/ping":
                return self._json({"ok": True})
            self._json({"error": "not found"}, 404)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def do_POST(self):
        try:
            u = urlparse(self.path)
            q = parse_qs(u.query)
            self.close_connection = True        # until the body has been read, never reuse the socket
            if u.path != "/api/cmd":
                return self._json({"error": "not found"}, 404)
            if not self.app.authorized(self, q):
                return self._json({"error": "unauthorized"}, 401)
            try:
                n = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                n = -1
            if n < 0 or n > MAX_BODY:
                return self._json({"error": "bad length"}, 413)
            try:
                raw = self.rfile.read(n)
                self.close_connection = False
                body = json.loads(raw or b"{}")
                name, args = body.get("name"), body.get("args") or {}
                if not isinstance(args, dict):
                    raise ValueError
            except (ValueError, AttributeError):
                return self._json({"ok": False, "key": "err.bad_argument"}, 400)
            try:
                res = self.app.engine.command(name, args)
            except CommandError as e:
                return self._json({"ok": False, "key": e.key, "params": e.params}, 409)
            with self.app.cond:
                self.app.cond.notify_all()
            self._json(res)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def _sse(self, role: str):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.send_header("X-Accel-Buffering", "no")
        self.end_headers()
        self.close_connection = True
        app = self.app
        with app._sse_lock:
            app.sse_clients += 1
        last_v, last_sent, last_body = -1, 0.0, None
        try:
            self.wfile.write(b"retry: 1000\n\n")
            while not app._stop.is_set():
                now = time.monotonic()
                v = app.engine.version
                due = now - last_sent >= SSE_KEEPALIVE_S
                if (v != last_v and now - last_sent >= SSE_MIN_GAP_S) or due:
                    snap = app.engine.snapshot(role)
                    body = json.dumps(snap, ensure_ascii=False, separators=(",", ":"))
                    self.wfile.write(f"data: {body}\n\n".encode("utf-8"))
                    self.wfile.flush()
                    last_v, last_sent, last_body = v, now, body
                    continue
                with app.cond:
                    app.cond.wait(timeout=SSE_MIN_GAP_S)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass
        finally:
            with app._sse_lock:
                app.sse_clients -= 1
