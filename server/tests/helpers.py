import json
import os
import random

from contromossa import protocol as P
from contromossa.content import load_quiz
from contromossa.engine import Config, Engine
from contromossa.store import Store

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CONTENT = os.path.join(ROOT, "content")


class Clock:
    def __init__(self, t=1000.0):
        self.t = t

    def __call__(self):
        return self.t

    def adv(self, s):
        self.t += s


def make_engine(teams=4, store_path=None, clock=None, wall=None, **cfg):
    clock = clock or Clock()
    wall = wall or Clock(1_700_000_000.0)
    sent = []
    c = Config(teams=teams, **cfg)
    e = Engine(load_quiz(CONTENT), Store(store_path), send=sent.append, clock=clock, wall=wall, config=c)
    return e, clock, wall, sent


def t_line(serial, slot, q, ans=0, elapsed=0, locked=None, phase_seen=0, seq=0, rssi=-60, presses=0):
    locked = bool(ans) if locked is None else locked
    flags = (1 if locked else 0) | (phase_seen << P.SF_PHASE_SHIFT)
    return P.add_checksum(f"T {serial:08X} {rssi} {slot} {seq & 255} {q} {ans} {elapsed} {flags} 1 {presses} 0 1000")


def hello(group=77, band=25):
    return P.add_checksum(f"H 1 {group} {band} 10 0 0 0 5")


def bring_online(e, clock, n):
    """n devices, serial 0x100+i, already on slot i."""
    for i in range(n):
        e.handle_line(t_line(0x100 + i, i, 0, seq=1))


def advance(e, clock, secs, n, state=None, q=None, phase_seen=1):
    """Advance time in 0.5 s steps; every device heartbeats each second with its locked state."""
    state = state or {}
    steps = int(round(secs / 0.5))
    for k in range(steps):
        clock.adv(0.5)
        if k % 2 == 1:
            for s in range(n):
                a, el = state.get(s, (0, 0))
                e.handle_line(t_line(0x100 + s, s, e.qseq if q is None else q, a, el, phase_seen=phase_seen))
        e.tick()


def run_question(e, clock, answers, *, n=None, final_reports=True):
    """Open next question, deliver answers, wait for time-up, deliver final reports, settle."""
    n = e.cfg.teams if n is None else n
    e.cmd_next()
    qs = e.qseq
    for slot, (a, el) in answers.items():
        e.handle_line(t_line(0x100 + slot, slot, qs, a, el, phase_seen=1))
    advance(e, clock, e.limit_ms / 1000 + 0.5, n, answers, qs, phase_seen=1)
    if final_reports:
        advance(e, clock, 1.0, n, answers, qs, phase_seen=2)
