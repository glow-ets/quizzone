"""Transports between the server and the base station.

A transport delivers complete text lines to ``on_line`` from its own reader
thread and accepts lines via ``write``. It reconnects by itself and reports
status through ``on_status(up, detail)``. The engine never blocks on I/O:
``write`` only enqueues (bounded; the oldest lines are dropped, because every
outgoing line is a full state refresh that will be repeated anyway).
"""
from __future__ import annotations

import queue
import socket
import threading
import time
from typing import Callable, Optional

MICROBIT_VID, MICROBIT_PID = 0x0D28, 0x0204
BAUD = 115200

LineHandler = Callable[[str], None]
StatusHandler = Callable[[bool, str], None]


class Transport:
    def __init__(self):
        self.on_line: LineHandler = lambda s: None
        self.on_status: StatusHandler = lambda up, d: None
        self._stop = threading.Event()
        self._out: "queue.Queue[str]" = queue.Queue(maxsize=64)
        self._threads = []

    def start(self, on_line: LineHandler, on_status: StatusHandler):
        self.on_line, self.on_status = on_line, on_status
        self._spawn(self._run)

    def write(self, line: str):
        while True:
            try:
                self._out.put_nowait(line)
                return
            except queue.Full:
                try:
                    self._out.get_nowait()
                except queue.Empty:
                    pass

    def close(self):
        self._stop.set()
        for t in self._threads:
            t.join(timeout=2)

    def _spawn(self, fn):
        t = threading.Thread(target=fn, daemon=True)
        t.start()
        self._threads.append(t)

    def _run(self):
        raise NotImplementedError

    def _drain_out(self):
        try:
            while True:
                self._out.get_nowait()
        except queue.Empty:
            pass


def find_serial_ports():
    """List candidate micro:bit ports: [(device, description, is_microbit)]."""
    try:
        from serial.tools import list_ports
    except ImportError:
        return None
    res = []
    for p in list_ports.comports():
        mb = p.vid == MICROBIT_VID and p.pid == MICROBIT_PID
        res.append((p.device, p.description or "", mb))
    return res


class SerialTransport(Transport):
    def __init__(self, port: Optional[str] = None):
        super().__init__()
        self.port = port

    def _pick_port(self) -> Optional[str]:
        if self.port:
            return self.port
        ports = find_serial_ports() or []
        mbs = [p for p in ports if p[2]]
        return mbs[0][0] if mbs else None

    def _run(self):
        try:
            import serial
        except ImportError:
            self.on_status(False, "pyserial not installed: pip install pyserial")
            return
        last_detail = None
        while not self._stop.is_set():
            port = self._pick_port()
            if not port:
                if last_detail != "none":
                    self.on_status(False, "no micro:bit found")
                    last_detail = "none"
                self._stop.wait(1.0)
                continue
            try:
                ser = serial.Serial(port, BAUD, timeout=0.05, write_timeout=0.5)
            except (serial.SerialException, OSError) as e:
                if last_detail != str(e):
                    self.on_status(False, f"{port}: {e}")
                    last_detail = str(e)
                self._stop.wait(1.0)
                continue
            last_detail = None
            self.on_status(True, port)
            self._drain_out()
            try:
                self._session(ser)
            except (serial.SerialException, OSError) as e:
                self.on_status(False, f"{port}: {e}")
            finally:
                try:
                    ser.close()
                except Exception:
                    pass
            self._stop.wait(0.5)

    def _session(self, ser):
        buf = b""
        while not self._stop.is_set():
            try:
                while True:
                    line = self._out.get_nowait()
                    ser.write(line.encode("ascii", "replace") + b"\n")
            except queue.Empty:
                pass
            data = ser.read(512)
            if data:
                buf += data
                if len(buf) > 8192:         # no newline for ages: garbage, resync
                    buf = buf[-256:]
                while b"\n" in buf:
                    raw, buf = buf.split(b"\n", 1)
                    try:
                        self.on_line(raw.decode("ascii", "ignore").strip("\r"))
                    except Exception:       # a bad handler must not kill the reader
                        pass


class TcpTransport(Transport):
    """Client to a TCP bridge (used with the Node radio simulator)."""

    def __init__(self, host: str, port: int):
        super().__init__()
        self.addr = (host, port)

    def _run(self):
        while not self._stop.is_set():
            try:
                s = socket.create_connection(self.addr, timeout=2)
            except OSError as e:
                self.on_status(False, f"{self.addr[0]}:{self.addr[1]}: {e}")
                self._stop.wait(1.0)
                continue
            s.settimeout(0.05)
            self.on_status(True, f"tcp {self.addr[0]}:{self.addr[1]}")
            self._drain_out()
            buf = b""
            try:
                while not self._stop.is_set():
                    try:
                        while True:
                            s.sendall(self._out.get_nowait().encode("ascii", "replace") + b"\n")
                    except queue.Empty:
                        pass
                    try:
                        data = s.recv(4096)
                    except socket.timeout:
                        continue
                    if not data:
                        break
                    buf += data
                    while b"\n" in buf:
                        raw, buf = buf.split(b"\n", 1)
                        try:
                            self.on_line(raw.decode("ascii", "ignore").strip("\r"))
                        except Exception:
                            pass
            except OSError as e:
                self.on_status(False, str(e))
            finally:
                s.close()
            self.on_status(False, "disconnected")
            self._stop.wait(0.5)


class LoopbackTransport(Transport):
    """In-process transport for tests: ``inject`` plays the base, ``sent`` records output."""

    def __init__(self):
        super().__init__()
        self.sent = []

    def start(self, on_line, on_status):
        self.on_line, self.on_status = on_line, on_status
        on_status(True, "loopback")

    def write(self, line: str):
        self.sent.append(line)

    def inject(self, line: str):
        self.on_line(line)

    def close(self):
        pass
