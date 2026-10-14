"""Python stand-in for base station + team devices, for demos and UI work without hardware.

It speaks exactly the serial protocol of the real base: it consumes S/A/N/P lines
and produces T/H lines. Virtual teams answer after a random "thinking" time.
"""
from __future__ import annotations

import random
import threading
import time

from . import protocol as P
from .links import Transport


class _Dev:
    def __init__(self, i: int, rng: random.Random):
        self.serial = 0xA0000000 + i
        self.slot = i
        self.seq = 0
        self.q = 0
        self.locked_ans = 0
        self.locked_elapsed = 0
        self.press_at = None        # elapsed ms at which this team will press
        self.press_ans = 0
        self.phase_seen = P.PH_IDLE
        self.presses = 0
        self.rssi = rng.randint(-85, -45)


class SimTransport(Transport):
    def __init__(self, teams: int = 12, seed: int = 1, speed: float = 1.0, think_s=(2.0, 20.0),
                 loss: float = 0.1, answers_hint: int = 4):
        super().__init__()
        self.rng = random.Random(seed)
        self.devs = [_Dev(i, self.rng) for i in range(teams)]
        self.think = think_s
        self.loss = loss
        self.state = dict(phase=0, q=0, elapsed=0, limit=0, ack=0, correct=0, wrong=0, flags=0)
        self.state_at = time.monotonic()
        self.lock = threading.Lock()
        self.t0 = time.monotonic()
        self.rx_ok = 0

    def _run(self):
        self.on_status(True, "simulatore")
        last_h = 0.0
        while not self._stop.is_set():
            now = time.monotonic()
            try:
                while True:
                    self._handle(self._out.get_nowait())
            except Exception:
                pass
            with self.lock:
                for d in self.devs:
                    self._step(d, now)
            if now - last_h >= 2.0:
                last_h = now
                self.on_line(P.add_checksum(f"H 1 77 25 {int(now - self.t0)} 0 0 0 {self.rx_ok}"))
            self._stop.wait(0.05)

    def _elapsed(self, now: float) -> int:
        s = self.state
        if s["phase"] == P.PH_OPEN:
            return s["elapsed"] + int((now - self.state_at) * 1000)
        return s["elapsed"]

    def _handle(self, line: str):
        payload = P.strip_line(line)
        if payload is None:
            return
        f = payload.split(" ")
        with self.lock:
            if f[0] == "S" and len(f) == 9:
                v = [int(x) for x in f[1:]]
                new_q = v[1] != self.state["q"]
                self.state = dict(zip(("phase", "q", "elapsed", "limit", "ack", "correct", "wrong", "flags"), v))
                self.state_at = time.monotonic()
                nans = (v[7] >> P.BF_NANS_SHIFT) & 7
                for d in self.devs:
                    if v[0] == P.PH_OPEN and d.q != v[1]:
                        d.q, d.locked_ans, d.locked_elapsed = v[1], 0, 0
                        lim = v[3]
                        t = self.rng.uniform(*self.think) * 1000
                        test = bool(v[7] & P.BF_TEST)
                        d.press_at = 5 if test else (t if t < lim - 200 else None)
                        d.press_ans = self.rng.randint(1, max(3, nans))
                    d.phase_seen = v[0]
            elif f[0] == "A" and len(f) == 3:
                ser, slot = int(f[1], 16), int(f[2])
                for d in self.devs:
                    if d.serial == ser:
                        d.slot = slot
            elif f[0] == "N":
                pass

    def _step(self, d: _Dev, now: float):
        el = self._elapsed(now)
        if (self.state["phase"] == P.PH_OPEN and d.q == self.state["q"] and d.press_at is not None
                and not d.locked_ans and el >= d.press_at):
            d.locked_ans, d.locked_elapsed = d.press_ans, int(d.press_at)
            d.presses += 1
        # one report ~ every 0.5 s per device, jittered by device index
        if int(now * 2 + d.serial * 0.37) != getattr(d, "_last_tick", None):
            d._last_tick = int(now * 2 + d.serial * 0.37)
            if self.rng.random() < self.loss:
                return
            d.seq = (d.seq + 1) & 255
            locked = 1 if d.locked_ans else 0
            flags = locked | (d.phase_seen << P.SF_PHASE_SHIFT)
            self.rx_ok += 1
            self.on_line(P.add_checksum(
                f"T {d.serial:08X} {d.rssi} {d.slot} {d.seq} {d.q} {d.locked_ans} {d.locked_elapsed} "
                f"{flags} 1 {d.presses} 0 {int(now * 1000) & 0x7FFFFFFF}"))
