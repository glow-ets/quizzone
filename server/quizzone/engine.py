"""Game engine: teams, devices, question flow, answer acceptance, scoring.

Pure logic: no sockets, no threads of its own, injectable clocks. The caller
(server.py) feeds it lines from the base station and calls tick() ~10-20 times
a second. Everything public takes the engine lock, so HTTP threads, the serial
reader thread and the ticker can call in concurrently.

Rules (see protocol/PROTOCOL.md for the reasoning):
  * An answer is accepted if the device-measured elapsed time is within
    [0, limit + tolerance]; delivery delay is irrelevant.
  * Per team the answer with the smallest elapsed time wins (order independent,
    duplicates harmless). Devices lock on their first press anyway.
  * After the time is up the question stays CLOSED until every online team's
    device has reported its final state (or settle_max_ms passes), so a late
    packet cannot be mistaken for "no answer".
"""
from __future__ import annotations

import csv
import io
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Set

from . import protocol as P
from .content import Question, Quiz
from .store import Store

LOBBY, READY, OPEN, CLOSED, REVEAL, FINAL = "lobby", "ready", "open", "closed", "reveal", "final"
BEACON_PHASE = {LOBBY: P.PH_IDLE, READY: P.PH_IDLE, OPEN: P.PH_OPEN, CLOSED: P.PH_CLOSED,
                REVEAL: P.PH_REVEAL, FINAL: P.PH_IDLE}

STATE_EVERY_S = 0.25          # re-send the full state line to the base this often
ASSIGN_MIN_GAP_S = 0.5        # per device
SAVE_MIN_GAP_S = 0.5
MAX_NAME = 40
EARLY_CLOSE_HORIZON_S = 15.0   # silent for longer than this = not waited for when closing early


class CommandError(Exception):
    """Operator command refused. `key` is an i18n key for the UI."""
    def __init__(self, key: str, **params):
        super().__init__(key)
        self.key = key
        self.params = params


@dataclass
class Config:
    teams: int = 15
    tolerance_ms: int = 300
    settle_max_ms: int = 3000
    online_s: float = 4.0
    close_when_all_answered: bool = True
    read_first: bool = False          # two-step: show question, then "go"
    allow_negative: bool = True
    no_answer_penalty: int = 0
    auto_assign: bool = False
    expected_group: int = 77
    expected_band: int = 25

    BOUNDS = {"teams": (1, P.MAX_TEAMS), "tolerance_ms": (0, 2000), "settle_max_ms": (500, 10000),
              "no_answer_penalty": (0, 100000)}

    def to_dict(self) -> dict:
        return {k: getattr(self, k) for k in ("teams", "tolerance_ms", "settle_max_ms", "online_s",
                "close_when_all_answered", "read_first", "allow_negative", "no_answer_penalty",
                "auto_assign", "expected_group", "expected_band")}


@dataclass
class Device:
    serial: int
    slot: Optional[int] = None
    first_seen: float = 0.0
    last_seen: float = -1e9
    rssi: int = 0
    fw: int = 0
    presses: int = 0
    bmiss: int = 0
    seq_last: int = -1
    rx: int = 0
    lost: int = 0
    reported_slot: int = P.UNASSIGNED
    last_q: int = 0
    last_ans: int = 0
    last_flags: int = 0
    last_assign_sent: float = -1e9

    @property
    def loss_pct(self) -> float:
        tot = self.rx + self.lost
        return 100.0 * self.lost / tot if tot else 0.0


@dataclass
class Answer:
    ans: int            # 1-based
    elapsed: int        # ms, device measured
    serial: int
    rx_at: float        # monotonic time first accepted (diagnostics only)


def _clean_name(s) -> Optional[str]:
    if s is None:
        return None
    s = "".join(ch for ch in str(s) if ch.isprintable()).strip()
    return s[:MAX_NAME] or None


class Engine:
    def __init__(self, quiz: Quiz, store: Optional[Store] = None,
                 send: Optional[Callable[[str], None]] = None,
                 clock: Callable[[], float] = time.monotonic,
                 wall: Callable[[], float] = time.time,
                 config: Optional[Config] = None):
        self.quiz = quiz
        self.store = store or Store(None)
        self.send = send or (lambda line: None)
        self.clock = clock
        self.wall = wall
        self.cfg = config or Config()
        self.lock = threading.RLock()
        self.version = 0

        self.lang = "it"
        self.names: List[Optional[str]] = [None] * P.MAX_TEAMS
        self.enabled: List[bool] = [False] * P.MAX_TEAMS
        self.scores: Dict[int, int] = {}
        self.devices: Dict[int, Device] = {}
        self.slot_owner: Dict[int, int] = {}
        self.history: List[dict] = []
        self.adjustments: List[dict] = []

        self.cursor = -1
        self.phase = LOBBY
        self.qseq = 0
        self.q: Optional[Question] = None
        self.test = False
        self.open_at = 0.0
        self.opened_wall = 0.0
        self.limit_ms = 0
        self.closed_at = 0.0
        self.closed_elapsed_ms = 0
        self.answers: Dict[int, Answer] = {}
        self.final_reports: Set[int] = set()
        self.settled = True
        self.unconfirmed: List[int] = []
        self.reveal: Optional[dict] = None
        self.test_report: Optional[dict] = None
        self.late_rejected = 0

        self.base_info: Optional[P.BaseHello] = None
        self.base_seen = -1e9
        self.link_up = False
        self.link_detail = ""
        self.bad_lines = 0
        self.log: deque = deque(maxlen=300)

        self._state_dirty = True
        self._last_state_sent = -1e9
        self._last_save = -1e9
        self._save_pending = False
        self._ident_pending: List[int] = []

        self._restore()

    # ------------------------------------------------------------------ helpers
    def _bump(self):
        self.version += 1

    def _log(self, key: str, level: str = "info", **params):
        self.log.append({"t": self.wall(), "k": key, "l": level, "a": params})
        self._bump()

    def _team_count(self) -> int:
        return self.cfg.teams

    def _nans(self) -> int:
        return self.q.n_answers if self.q else 4

    def _online(self, dev: Device, now: float) -> bool:
        return now - dev.last_seen <= self.cfg.online_s

    def _bound_online_slots(self, now: float, horizon: Optional[float] = None) -> Set[int]:
        h = self.cfg.online_s if horizon is None else horizon
        return {d.slot for d in self.devices.values()
                if d.slot is not None and d.slot < self.cfg.teams and now - d.last_seen <= h}

    def _active_slots(self) -> List[int]:
        return [s for s in range(self.cfg.teams) if self.enabled[s] or s in self.slot_owner
                or self.scores.get(s, 0) != 0]

    def _ack_mask(self) -> int:
        m = 0
        for s in self.answers:
            m |= 1 << s
        return m

    def _elapsed_ms(self, now: float) -> int:
        if self.phase == OPEN:
            return max(0, int((now - self.open_at) * 1000))
        if self.phase in (CLOSED, REVEAL):
            return self.closed_elapsed_ms
        return 0

    # ------------------------------------------------------------------ outgoing
    def _send_state(self, now: float):
        correct = wrong = 0
        if self.phase == REVEAL and self.reveal:
            correct, wrong = self.reveal["correct_mask"], self.reveal["wrong_mask"]
        line = P.format_state(BEACON_PHASE[self.phase], self.qseq, self._elapsed_ms(now), self.limit_ms,
                              self._ack_mask(), correct, wrong,
                              P.beacon_flags(self._nans(), self.test and self.phase == OPEN))
        self.send(line)
        self._last_state_sent = now
        self._state_dirty = False

    def _send_assign(self, dev: Device, slot: int, now: float):
        if now - dev.last_assign_sent < ASSIGN_MIN_GAP_S:
            return
        dev.last_assign_sent = now
        self.send(P.format_assign(dev.serial, slot))

    # ------------------------------------------------------------------ incoming from base
    def handle_line(self, line: str, now: Optional[float] = None):
        now = self.clock() if now is None else now
        msg = P.parse_base_line(line)
        with self.lock:
            if msg is None:
                if line.strip():
                    self.bad_lines += 1
                return
            if isinstance(msg, P.BaseHello):
                self._on_hello(msg, now)
            else:
                self._on_team_state(msg, now)

    def _on_hello(self, h: P.BaseHello, now: float):
        first = self.base_info is None
        self.base_info = h
        self.base_seen = now
        if first or (h.group, h.band) != (self.cfg.expected_group, self.cfg.expected_band):
            if (h.group, h.band) != (self.cfg.expected_group, self.cfg.expected_band):
                self._log("log.base_mismatch", "warn", group=h.group, band=h.band,
                          exp_group=self.cfg.expected_group, exp_band=self.cfg.expected_band)
            elif first:
                self._log("log.base_ok", group=h.group, band=h.band)
        self._bump()

    def _on_team_state(self, st: P.TeamState, now: float):
        self.base_seen = max(self.base_seen, now)   # any valid traffic proves the base is alive
        dev = self.devices.get(st.serial)
        if dev is None:
            dev = Device(serial=st.serial, first_seen=now)
            self.devices[st.serial] = dev
            self._log("log.device_new", serial=f"{st.serial:08X}")
        # --- link statistics from the sequence number
        if dev.seq_last >= 0:
            gap = (st.seq - dev.seq_last - 1) & 255
            if gap < 128:
                dev.lost += gap
        dev.seq_last = st.seq
        dev.rx += 1
        dev.last_seen, dev.rssi, dev.fw = now, st.rssi, st.fw
        dev.presses, dev.bmiss = st.presses, st.bmiss
        dev.reported_slot, dev.last_q, dev.last_ans, dev.last_flags = st.slot, st.q, st.ans, st.flags

        # --- slot bookkeeping
        if dev.slot is None:
            if (st.slot != P.UNASSIGNED and st.slot < self.cfg.teams and st.slot not in self.slot_owner):
                self._bind(dev, st.slot, "log.slot_recovered")
            elif self.cfg.auto_assign:
                free = [s for s in range(self.cfg.teams) if s not in self.slot_owner]
                if free:
                    self._bind(dev, free[0], "log.auto_assigned")
                    self._send_assign(dev, dev.slot, now)
            elif st.slot != P.UNASSIGNED:
                self._send_assign(dev, P.UNASSIGNED, now)       # clear a slot the server does not recognise
        if dev.slot is not None and st.slot != dev.slot:
            self._send_assign(dev, dev.slot, now)
            return                                              # not trustworthy until it agrees on its slot

        slot = dev.slot
        if slot is None:
            return
        # --- answers and final reports
        if self.phase in (OPEN, CLOSED) and st.q == self.qseq:
            if 1 <= st.ans <= self._nans():
                self._accept(slot, dev, st, now)
            if self.phase == CLOSED and st.phase_seen in (P.PH_CLOSED, P.PH_REVEAL):
                self.final_reports.add(slot)
                self._check_settled(now)

    def _accept(self, slot: int, dev: Device, st: P.TeamState, now: float):
        if st.elapsed > self.limit_ms + self.cfg.tolerance_ms:
            self.late_rejected += 1
            self._log("log.late", "warn", team=slot + 1, elapsed=st.elapsed)
            return
        prev = self.answers.get(slot)
        if prev is not None and st.elapsed >= prev.elapsed:
            return
        self.answers[slot] = Answer(st.ans, st.elapsed, dev.serial, now)
        self.enabled[slot] = True
        self._state_dirty = True
        self._save_pending = True
        self._log("log.answer", team=slot + 1, ans="ABCDE"[st.ans - 1], elapsed=st.elapsed)
        if self.phase == OPEN and self.cfg.close_when_all_answered:
            # Generous horizon: a team whose link merely hiccuped must not be cut off by an early close.
            online = self._bound_online_slots(now, EARLY_CLOSE_HORIZON_S)
            if online and online <= set(self.answers):
                self._close(now, "all_answered")

    # ------------------------------------------------------------------ time
    def tick(self, now: Optional[float] = None):
        now = self.clock() if now is None else now
        with self.lock:
            if self.phase == OPEN and (now - self.open_at) * 1000 >= self.limit_ms:
                self._close(now, "time")
            elif self.phase == OPEN and self.cfg.close_when_all_answered and self.answers:
                waiting = self._bound_online_slots(now, EARLY_CLOSE_HORIZON_S)
                if waiting and waiting <= set(self.answers):
                    self._close(now, "all_answered")
            elif self.phase == CLOSED:
                self._check_settled(now)
                if self.test and self.settled:
                    self._finish_test(now)
            if self._state_dirty or now - self._last_state_sent >= STATE_EVERY_S:
                self._send_state(now)
            while self._ident_pending:
                self.send(P.format_ident(self._ident_pending.pop(0), 1))
            if self._save_pending and now - self._last_save >= SAVE_MIN_GAP_S:
                self._persist(now)

    def _close(self, now: float, reason: str):
        if self.phase != OPEN:
            return
        self.phase = CLOSED
        self.closed_at = now
        self.closed_elapsed_ms = min(self.limit_ms, max(0, int((now - self.open_at) * 1000)))
        self.final_reports = set()
        self.settled = False
        self.unconfirmed = []
        self._state_dirty = True
        self._log("log.closed", reason=reason)
        self._check_settled(now)
        self._persist(now)

    def _check_settled(self, now: float):
        if self.settled or self.phase != CLOSED:
            return
        required = self._bound_online_slots(now)
        missing = required - self.final_reports
        if not missing:
            self.settled, self.unconfirmed = True, []
        elif (now - self.closed_at) * 1000 >= self.cfg.settle_max_ms:
            self.settled, self.unconfirmed = True, sorted(missing)
            self._log("log.unconfirmed", "warn", teams=[s + 1 for s in sorted(missing)])
        else:
            return
        self._bump()

    # ------------------------------------------------------------------ question flow
    def _open(self, now: float):
        self.qseq = self.qseq % 255 + 1
        self.phase = OPEN
        self.open_at = now
        self.opened_wall = self.wall()
        self.limit_ms = self.q.time_s * 1000
        self.answers = {}
        self.final_reports = set()
        self.settled = True
        self.reveal = None
        self._state_dirty = True
        self._log("log.opened", q=self.q.id, qseq=self.qseq)
        self._persist(now)

    def _begin(self, now: float):
        self.answers = {}
        self.reveal = None
        self.test = False
        if self.cfg.read_first:
            self.phase = READY
            self.qseq = self.qseq % 255 + 1
            self.limit_ms = self.q.time_s * 1000
            self._state_dirty = True
            self._persist(now)
        else:
            self._open(now)

    def _enter_final(self, now: float):
        self.phase = FINAL
        self.q = None
        self._state_dirty = True
        self._log("log.final")
        self._persist(now)

    def cmd_next(self, **_):
        with self.lock:
            now = self.clock()
            if self.phase in (READY, OPEN, CLOSED):
                raise CommandError("err.question_running")
            if self.phase == FINAL:
                raise CommandError("err.already_final")
            if self.cursor + 1 >= len(self.quiz.questions):
                self._enter_final(now)
                return
            self.cursor += 1
            self.q = self.quiz.questions[self.cursor]
            self._begin(now)

    def cmd_open(self, **_):
        with self.lock:
            if self.phase != READY:
                raise CommandError("err.not_ready")
            self._open(self.clock())

    def cmd_close(self, **_):
        with self.lock:
            if self.phase != OPEN:
                raise CommandError("err.not_open")
            self._close(self.clock(), "operator")

    def cmd_reveal(self, force: bool = False, **_):
        with self.lock:
            now = self.clock()
            if self.test:
                raise CommandError("err.test_running")
            if self.phase == OPEN:
                self._close(now, "operator")
            if self.phase != CLOSED:
                raise CommandError("err.not_closed")
            self._check_settled(now)
            if not self.settled and not force:
                raise CommandError("err.not_settled")
            self._do_reveal(now)

    def _do_reveal(self, now: float):
        q = self.q
        correct_ans = q.correct + 1
        active = set(self._active_slots()) | set(self.answers)
        results = []
        cmask = wmask = 0
        for slot in range(self.cfg.teams):
            a = self.answers.get(slot)
            delta, ok = 0, None
            if a is not None:
                ok = a.ans == correct_ans
                if ok:
                    delta = q.points
                    if q.speed_bonus and self.limit_ms:
                        delta += round(q.speed_bonus * max(0.0, 1.0 - a.elapsed / self.limit_ms))
                    cmask |= 1 << slot
                else:
                    delta = -q.penalty
                    wmask |= 1 << slot
            elif slot in self.slot_owner and self.cfg.no_answer_penalty:
                delta = -self.cfg.no_answer_penalty
            if slot not in active and a is None:
                continue
            before = self.scores.get(slot, 0)
            after = before + delta
            if not self.cfg.allow_negative and after < 0:
                after = 0
            applied = after - before
            self.scores[slot] = after
            results.append({"slot": slot, "ans": a.ans if a else 0, "elapsed": a.elapsed if a else None,
                            "correct": ok, "delta": applied, "total": after})
        counts = [0] * q.n_answers
        for a in self.answers.values():
            counts[a.ans - 1] += 1
        self.reveal = {"correct": q.correct, "results": results, "counts": counts,
                       "correct_mask": cmask, "wrong_mask": wmask}
        self.history.append({"qid": q.id, "qseq": self.qseq, "correct": q.correct, "results": results,
                             "unconfirmed": list(self.unconfirmed)})
        self.phase = REVEAL
        self._state_dirty = True
        self._log("log.revealed", q=q.id)
        self._persist(now)

    def cmd_skip(self, **_):
        """Abandon the current question without scoring and move on."""
        with self.lock:
            if self.phase in (LOBBY, FINAL):
                raise CommandError("err.nothing_to_skip")
            now = self.clock()
            if self.phase == REVEAL:
                raise CommandError("err.already_revealed")
            self.phase = LOBBY
            self.answers = {}
            if self.test:
                self.q = None
            self.test = False
            self._state_dirty = True
            self._log("log.skipped", q=self.q.id if self.q else "")
            self._persist(now)

    def cmd_redo(self, **_):
        """Run the current question again (reverting its score if already revealed)."""
        with self.lock:
            if self.q is None or self.phase in (LOBBY, FINAL) or self.test:
                raise CommandError("err.nothing_to_redo")
            now = self.clock()
            if self.phase == REVEAL and self.history:
                last = self.history.pop()
                for r in last["results"]:
                    self.scores[r["slot"]] = self.scores.get(r["slot"], 0) - r["delta"]
            self._log("log.redo", q=self.q.id)
            self._begin(now)

    def cmd_goto(self, index: int = 0, **_):
        with self.lock:
            if self.phase in (READY, OPEN, CLOSED):
                raise CommandError("err.question_running")
            if not isinstance(index, int) or not (0 <= index <= len(self.quiz.questions)):
                raise CommandError("err.bad_argument")
            self.cursor = index - 1
            self.phase = LOBBY
            self.q = None
            self.test = False
            self.answers = {}
            self.reveal = None
            self._state_dirty = True
            self._persist(self.clock())

    def cmd_test(self, seconds: int = 6, answers: int = 4, **_):
        """Radio stress test: every device answers by itself the instant the question opens."""
        with self.lock:
            if self.phase in (READY, OPEN, CLOSED, REVEAL):
                raise CommandError("err.question_running")
            now = self.clock()
            seconds = max(3, min(30, int(seconds)))
            answers = max(3, min(5, int(answers)))
            self.q = Question("__test__", 0, answers, seconds, 0, 0, 0)
            self.test = True
            self.test_report = None
            self._test_started = now
            self._open(now)

    def _finish_test(self, now: float):
        """A stress-test question has settled: summarise delivery, return to the lobby."""
        expected = sorted(self._bound_online_slots(now) | set(self.answers))
        lat = sorted(max(0.0, (a.rx_at - self.open_at) * 1000 - a.elapsed) for a in self.answers.values())

        def pct(p):
            return round(lat[min(len(lat) - 1, int(p * len(lat)))]) if lat else None
        self.test_report = {
            "expected": [s + 1 for s in expected],
            "answered": [s + 1 for s in sorted(self.answers)],
            "missing": [s + 1 for s in expected if s not in self.answers],
            "unconfirmed": [s + 1 for s in self.unconfirmed],
            "latency_ms": {"min": pct(0), "p50": pct(0.5), "max": lat and round(lat[-1]) or None},
            "late_rejected": self.late_rejected,
            "ok": bool(expected) and all(s in self.answers for s in expected) and not self.unconfirmed,
        }
        self.phase, self.test, self.q = LOBBY, False, None
        self.answers = {}
        self._state_dirty = True
        self._log("log.test_done", "info" if self.test_report["ok"] else "warn",
                  answered=len(self.test_report["answered"]), expected=len(expected))
        self._persist(now)

    # ------------------------------------------------------------------ teams and devices
    def _bind(self, dev: Device, slot: int, why_key: str):
        old = self.slot_owner.get(slot)
        if old is not None and old != dev.serial and old in self.devices:
            self.devices[old].slot = None
            self._send_assign(self.devices[old], P.UNASSIGNED, self.clock())
        if dev.slot is not None and self.slot_owner.get(dev.slot) == dev.serial:
            del self.slot_owner[dev.slot]
        dev.slot = slot
        self.slot_owner[slot] = dev.serial
        self.enabled[slot] = True
        self._log(why_key, team=slot + 1, serial=f"{dev.serial:08X}")
        self._save_pending = True

    def cmd_assign(self, serial: str = "", slot: int = 0, **_):
        with self.lock:
            dev = self._dev_arg(serial)
            if not isinstance(slot, int) or isinstance(slot, bool) or not (0 <= slot < self.cfg.teams):
                raise CommandError("err.bad_argument")
            self._bind(dev, slot, "log.assigned")
            self._send_assign(dev, slot, self.clock())
            dev.last_assign_sent = -1e9
            self._persist(self.clock())

    def cmd_unassign(self, serial: str = "", **_):
        with self.lock:
            dev = self._dev_arg(serial)
            if dev.slot is not None and self.slot_owner.get(dev.slot) == dev.serial:
                del self.slot_owner[dev.slot]
            dev.slot = None
            dev.last_assign_sent = -1e9
            self._send_assign(dev, P.UNASSIGNED, self.clock())
            self._persist(self.clock())

    def cmd_auto_assign(self, **_):
        """Give every unassigned online device the first free slot, oldest first."""
        with self.lock:
            now = self.clock()
            todo = sorted((d for d in self.devices.values() if d.slot is None and self._online(d, now)),
                          key=lambda d: (d.first_seen, d.serial))
            free = [s for s in range(self.cfg.teams) if s not in self.slot_owner]
            for dev, slot in zip(todo, free):
                self._bind(dev, slot, "log.auto_assigned")
                dev.last_assign_sent = -1e9
                self._send_assign(dev, slot, now)
            self._persist(now)

    def cmd_forget_device(self, serial: str = "", **_):
        with self.lock:
            dev = self._dev_arg(serial)
            if self._online(dev, self.clock()):
                raise CommandError("err.device_online")
            if dev.slot is not None and self.slot_owner.get(dev.slot) == dev.serial:
                del self.slot_owner[dev.slot]
            del self.devices[dev.serial]
            self._persist(self.clock())

    def cmd_identify(self, serial: str = "", **_):
        with self.lock:
            dev = self._dev_arg(serial)
            self._ident_pending.append(dev.serial)

    def _dev_arg(self, serial) -> Device:
        try:
            s = int(str(serial), 16) & 0xFFFFFFFF
        except ValueError:
            raise CommandError("err.bad_argument")
        dev = self.devices.get(s)
        if dev is None:
            raise CommandError("err.unknown_device")
        return dev

    def cmd_rename(self, slot: int = 0, name=None, **_):
        with self.lock:
            if not isinstance(slot, int) or isinstance(slot, bool) or not (0 <= slot < P.MAX_TEAMS):
                raise CommandError("err.bad_argument")
            self.names[slot] = _clean_name(name)
            self.enabled[slot] = True
            self._persist(self.clock())

    def cmd_enable_team(self, slot: int = 0, enabled: bool = True, **_):
        with self.lock:
            if not isinstance(slot, int) or isinstance(slot, bool) or not (0 <= slot < P.MAX_TEAMS):
                raise CommandError("err.bad_argument")
            self.enabled[slot] = bool(enabled)
            self._persist(self.clock())

    def cmd_adjust(self, slot: int = 0, delta: int = 0, reason: str = "", **_):
        with self.lock:
            if (not isinstance(slot, int) or isinstance(slot, bool) or not (0 <= slot < self.cfg.teams)
                    or not isinstance(delta, int) or isinstance(delta, bool) or abs(delta) > 100000):
                raise CommandError("err.bad_argument")
            self.scores[slot] = self.scores.get(slot, 0) + delta
            self.enabled[slot] = True
            self.adjustments.append({"t": self.wall(), "slot": slot, "delta": delta,
                                     "reason": _clean_name(reason) or ""})
            self._log("log.adjust", team=slot + 1, delta=delta)
            self._persist(self.clock())

    def cmd_set_lang(self, lang: str = "it", **_):
        with self.lock:
            if lang not in self.quiz.languages and lang not in ("it", "en"):
                raise CommandError("err.bad_argument")
            self.lang = lang
            self._persist(self.clock())

    def cmd_config(self, **kw):
        with self.lock:
            for k, v in kw.items():
                if k not in self.cfg.to_dict():
                    raise CommandError("err.bad_argument")
                cur = getattr(self.cfg, k)
                if isinstance(cur, bool):
                    if not isinstance(v, bool):
                        raise CommandError("err.bad_argument")
                elif isinstance(cur, float):
                    if isinstance(v, bool) or not isinstance(v, (int, float)) or not (0.5 <= v <= 60):
                        raise CommandError("err.bad_argument")
                else:
                    if isinstance(v, bool) or not isinstance(v, int):
                        raise CommandError("err.bad_argument")
                    lo, hi = Config.BOUNDS.get(k, (0, 255))
                    if not (lo <= v <= hi):
                        raise CommandError("err.bad_argument")
                if k == "teams" and v < self.cfg.teams and any(s >= v for s in self.slot_owner):
                    raise CommandError("err.teams_in_use")
                setattr(self.cfg, k, v)
            self._persist(self.clock())

    def cmd_reset_game(self, confirm: bool = False, **_):
        with self.lock:
            if confirm is not True:
                raise CommandError("err.confirm_required")
            self.scores, self.history, self.adjustments = {}, [], []
            self.cursor, self.phase, self.q, self.test = -1, LOBBY, None, False
            self.answers, self.reveal = {}, None
            self.test_report = None
            self._state_dirty = True
            self._log("log.reset", "warn")
            self._persist(self.clock())

    def command(self, name: str, args: Optional[dict] = None) -> dict:
        fn = getattr(self, "cmd_" + name, None) if isinstance(name, str) and name.isidentifier() else None
        if fn is None:
            raise CommandError("err.unknown_command")
        try:
            fn(**(args or {}))
        except TypeError:
            raise CommandError("err.bad_argument")
        return {"ok": True}

    # ------------------------------------------------------------------ link status (set by server)
    def set_link(self, up: bool, detail: str = ""):
        with self.lock:
            if up != self.link_up or detail != self.link_detail:
                self.link_up, self.link_detail = up, detail
                self._log("log.link_up" if up else "log.link_down", "info" if up else "warn", detail=detail)

    # ------------------------------------------------------------------ persistence
    def _persist(self, now: float):
        self._save_pending = False
        self._last_save = now
        data = {
            "version": 1, "lang": self.lang, "config": self.cfg.to_dict(),
            "names": self.names, "enabled": self.enabled,
            "devices": {f"{s:08X}": {"slot": d.slot, "first_wall": self.wall() - (now - d.first_seen)}
                        for s, d in self.devices.items() if d.slot is not None},
            "scores": {str(k): v for k, v in self.scores.items()},
            "history": self.history, "adjustments": self.adjustments,
            "game": {"cursor": self.cursor, "phase": self.phase, "qseq": self.qseq,
                     "opened_wall": self.opened_wall, "limit_ms": self.limit_ms,
                     "closed_elapsed_ms": self.closed_elapsed_ms, "test": self.test,
                     "answers": {str(s): {"ans": a.ans, "elapsed": a.elapsed, "serial": a.serial}
                                 for s, a in self.answers.items()},
                     "reveal": self.reveal},
        }
        if not self.store.save(data):
            self._log("log.save_failed", "warn", detail=self.store.last_error or "")

    def _restore(self):
        d = self.store.load()
        if self.store.last_error:
            self._log("log.state_corrupt", "warn", detail=self.store.last_error)
        if not d:
            return
        try:
            now, wall = self.clock(), self.wall()
            self.lang = d.get("lang", "it")
            c = d.get("config", {})
            for k in self.cfg.to_dict():
                if k in c and type(c[k]) is type(getattr(self.cfg, k)):
                    setattr(self.cfg, k, c[k])
            self.names = (d.get("names", []) + [None] * P.MAX_TEAMS)[:P.MAX_TEAMS]
            self.enabled = (d.get("enabled", []) + [False] * P.MAX_TEAMS)[:P.MAX_TEAMS]
            self.scores = {int(k): int(v) for k, v in d.get("scores", {}).items()}
            self.history = d.get("history", [])
            self.adjustments = d.get("adjustments", [])
            for ser, info in d.get("devices", {}).items():
                # Assume restored devices are still there (they usually are: only the PC restarted), so an
                # early close cannot fire before they have been heard from again.
                dev = Device(serial=int(ser, 16), slot=info.get("slot"), first_seen=now, last_seen=now)
                if dev.slot is not None and 0 <= dev.slot < P.MAX_TEAMS:
                    self.devices[dev.serial] = dev
                    self.slot_owner[dev.slot] = dev.serial
            g = d.get("game", {})
            self.cursor = g.get("cursor", -1)
            self.qseq = g.get("qseq", 0)
            self.phase = g.get("phase", LOBBY)
            self.test = bool(g.get("test", False))
            self.limit_ms = g.get("limit_ms", 0)
            self.closed_elapsed_ms = g.get("closed_elapsed_ms", 0)
            self.opened_wall = g.get("opened_wall", 0.0)
            self.answers = {int(s): Answer(a["ans"], a["elapsed"], a["serial"], now)
                            for s, a in g.get("answers", {}).items()}
            self.reveal = g.get("reveal")
            if 0 <= self.cursor < len(self.quiz.questions):
                self.q = self.quiz.questions[self.cursor]
            if self.test:                       # never resume a stress test
                self.phase, self.test, self.q, self.answers = LOBBY, False, None, {}
            if self.phase in (READY, OPEN, CLOSED, REVEAL) and self.q is None:
                self.phase = LOBBY
            if self.phase == OPEN:
                self.open_at = now - max(0.0, wall - self.opened_wall)
                self._log("log.resumed", q=self.q.id)
            elif self.phase == CLOSED:
                self.closed_at = now
                self.settled = False
                self._log("log.resumed", q=self.q.id)
            self._state_dirty = True
        except (KeyError, ValueError, TypeError, AttributeError) as e:
            # A state file we cannot interpret must never stop the event: start clean, keep the file.
            self._log("log.state_corrupt", "warn", detail=str(e))
            self.__init__(self.quiz, Store(None), self.send, self.clock, self.wall, Config())

    # ------------------------------------------------------------------ views
    def team_name(self, slot: int) -> Optional[str]:
        return self.names[slot]

    def _ranks(self, slots: List[int]) -> Dict[int, int]:
        order = sorted(slots, key=lambda s: -self.scores.get(s, 0))
        ranks, last, rank = {}, None, 0
        for i, s in enumerate(order):
            sc = self.scores.get(s, 0)
            if sc != last:
                rank, last = i + 1, sc
            ranks[s] = rank
        return ranks

    def snapshot(self, role: str = "screen") -> dict:
        with self.lock:
            now = self.clock()
            control = role == "control"
            slots = list(range(self.cfg.teams)) if control else self._active_slots()
            ranks = self._ranks(self._active_slots())
            teams = []
            for s in slots:
                dev = self.devices.get(self.slot_owner.get(s)) if s in self.slot_owner else None
                t = {"slot": s, "name": self.names[s], "score": self.scores.get(s, 0),
                     "rank": ranks.get(s), "active": s in ranks,
                     "answered": s in self.answers,
                     "online": bool(dev and self._online(dev, now))}
                if control:
                    t["serial"] = f"{dev.serial:08X}" if dev else None
                teams.append(t)
            q = None
            if self.q is not None and self.phase in (READY, OPEN, CLOSED, REVEAL):
                loc = self.quiz.localized(self.q, self.lang) if not self.test else \
                    {"text": "", "answers": ["A", "B", "C", "D", "E"][:self.q.n_answers], "explanation": "", "category": ""}
                q = {"id": self.q.id, "index": self.cursor, "text": loc["text"], "answers": loc["answers"],
                     "category": loc["category"], "points": self.q.points, "penalty": self.q.penalty,
                     "speed_bonus": self.q.speed_bonus, "time_s": self.q.time_s, "test": self.test}
                if self.phase == REVEAL:
                    q["correct"] = self.q.correct
                    q["explanation"] = loc["explanation"]
            timer = None
            if self.phase == OPEN:
                el = max(0, int((now - self.open_at) * 1000))
                timer = {"limit_ms": self.limit_ms, "elapsed_ms": el, "remaining_ms": max(0, self.limit_ms - el)}
            elif self.phase in (CLOSED, REVEAL):
                timer = {"limit_ms": self.limit_ms, "elapsed_ms": self.closed_elapsed_ms, "remaining_ms": 0}
            snap = {
                "v": 1, "server_ms": int(self.wall() * 1000), "lang": self.lang, "languages": self.quiz.languages,
                "title": self.quiz.localized_title(self.lang), "series": self.quiz.series,
                "phase": self.phase, "cursor": self.cursor, "total": len(self.quiz.questions),
                "teams": teams, "question": q, "timer": timer,
                "answered_count": len(self.answers),
                "expected_count": len(self._bound_online_slots(now)),
                "settled": self.settled,
                "reveal": None, "link_ok": self.link_up and now - self.base_seen < 4.0,
            }
            if self.phase == REVEAL and self.reveal:
                snap["reveal"] = {"correct": self.reveal["correct"], "counts": self.reveal["counts"],
                                  "results": self.reveal["results"]}
            if self.phase == FINAL:
                snap["podium"] = [t for t in teams if t["active"]]
            if control:
                snap["devices"] = [self._device_view(d, now) for d in sorted(
                    self.devices.values(), key=lambda d: (d.slot is None, d.slot if d.slot is not None else 0, d.serial))]
                snap["config"] = self.cfg.to_dict()
                snap["unconfirmed"] = [s + 1 for s in self.unconfirmed]
                snap["unsynced"] = sorted(d.slot + 1 for d in self.devices.values()
                                          if d.slot is not None and self._online(d, now) and d.reported_slot != d.slot)
                snap["late_rejected"] = self.late_rejected
                snap["log"] = list(self.log)[-80:]
                snap["test_report"] = self.test_report
                snap["base"] = None if self.base_info is None else {
                    "fw": self.base_info.fw, "group": self.base_info.group, "band": self.base_info.band,
                    "uptime_s": self.base_info.uptime_s, "overflow": self.base_info.overflow,
                    "foreign": self.base_info.foreign, "bad_lines": self.base_info.bad_lines,
                    "rx_ok": self.base_info.rx_ok, "seen_ago": round(now - self.base_seen, 1)}
                snap["link"] = {"up": self.link_up, "detail": self.link_detail, "bad_lines": self.bad_lines}
                snap["history_len"] = len(self.history)
                snap["state_error"] = self.store.last_error
            return snap

    def _device_view(self, d: Device, now: float) -> dict:
        return {"serial": f"{d.serial:08X}", "slot": d.slot, "online": self._online(d, now),
                "seen_ago": round(now - d.last_seen, 1) if d.last_seen > -1e8 else None,
                "rssi": d.rssi, "fw": d.fw, "presses": d.presses, "bmiss": d.bmiss,
                "rx": d.rx, "lost": d.lost, "loss_pct": round(d.loss_pct, 1),
                "locked": bool(d.last_flags & P.SF_LOCKED) and d.last_q == self.qseq,
                "synced": d.slot is None or d.reported_slot == d.slot}

    def export_csv(self) -> str:
        with self.lock:
            out = io.StringIO()
            w = csv.writer(out)
            slots = self._active_slots()
            w.writerow(["question", "team", "answer", "elapsed_ms", "correct", "delta", "total"])
            for h in self.history:
                for r in h["results"]:
                    w.writerow([h["qid"], self.names[r["slot"]] or f"Team {r['slot'] + 1}",
                                "ABCDE"[r["ans"] - 1] if r["ans"] else "", r["elapsed"] if r["elapsed"] is not None else "",
                                {True: "yes", False: "no", None: ""}[r["correct"]], r["delta"], r["total"]])
            w.writerow([])
            w.writerow(["team", "final score"])
            for s in sorted(slots, key=lambda s: -self.scores.get(s, 0)):
                w.writerow([self.names[s] or f"Team {s + 1}", self.scores.get(s, 0)])
            return out.getvalue()
