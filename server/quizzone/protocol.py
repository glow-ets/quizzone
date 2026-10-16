"""Wire protocol between the base station (micro:bit on USB) and this server.

Authoritative description: protocol/PROTOCOL.md. The firmware implements the
same rules in firmware/src/qz_protocol.ts; protocol/vectors.json is checked by
both test suites.

Serial lines are ASCII, one per line, ``<payload>*<HH>`` where HH is the XOR of
all payload bytes in upper-case hex. A line with a bad or missing checksum is
discarded (the receiver counts it).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Union

MAGIC = 0xC5

T_STATE, T_BEACON, T_ASSIGN, T_IDENT = 1, 2, 3, 4
STATE_LEN, BEACON_LEN, TARGETED_LEN = 13, 16, 7

PH_IDLE, PH_OPEN, PH_CLOSED, PH_REVEAL, PH_OFFLINE = 0, 1, 2, 3, 4
UNASSIGNED = 255

# STATE.flags
SF_LOCKED = 1
SF_ACKED = 2
SF_PHASE_SHIFT = 2   # bits 2-4: phase of the last beacon the device processed
SF_TEST = 32

# BEACON.flags
BF_TEST = 1
BF_NANS_SHIFT = 2    # bits 2-4: number of valid answers

MAX_TEAMS = 16


# --------------------------------------------------------------------------- checksum / lines
def checksum(payload: str) -> int:
    c = 0
    for b in payload.encode("latin-1", errors="replace"):
        c ^= b
    return c


def add_checksum(payload: str) -> str:
    return f"{payload}*{checksum(payload):02X}"


def strip_line(line: str) -> Optional[str]:
    """Return the payload of a well-formed line, else None."""
    line = line.rstrip("\r\n ")
    if len(line) < 4 or line[-3] != "*":
        return None
    payload, hh = line[:-3], line[-2:]
    if any(c not in "0123456789abcdefABCDEF" for c in hh):
        return None
    if checksum(payload) != int(hh, 16):
        return None
    return payload


# --------------------------------------------------------------------------- base -> server
@dataclass
class TeamState:
    serial: int          # unsigned 32 bit
    rssi: int
    slot: int
    seq: int
    q: int
    ans: int
    elapsed: int
    flags: int
    fw: int
    presses: int
    bmiss: int
    t_base: int

    @property
    def locked(self) -> bool:
        return bool(self.flags & SF_LOCKED)

    @property
    def phase_seen(self) -> int:
        return (self.flags >> SF_PHASE_SHIFT) & 7


@dataclass
class BaseHello:
    fw: int
    group: int
    band: int
    uptime_s: int
    overflow: int
    foreign: int
    bad_lines: int
    rx_ok: int


def _ints(fields: List[str]) -> Optional[List[int]]:
    try:
        return [int(f, 10) for f in fields]
    except ValueError:
        return None


def parse_base_line(line: str) -> Optional[Union[TeamState, BaseHello]]:
    """Parse a line from the base. Returns None for anything invalid."""
    payload = strip_line(line)
    if payload is None:
        return None
    f = payload.split(" ")
    if f[0] == "T" and len(f) == 13:
        if len(f[1]) != 8:
            return None
        try:
            serial = int(f[1], 16)
        except ValueError:
            return None
        n = _ints(f[2:])
        if n is None:
            return None
        rssi, slot, seq, q, ans, elapsed, flags, fw, presses, bmiss, tb = n
        if not (0 <= slot <= 255 and 0 <= seq <= 255 and 0 <= q <= 255 and 0 <= ans <= 255
                and 0 <= elapsed <= 65535 and 0 <= flags <= 255 and 0 <= fw <= 255
                and 0 <= presses <= 65535 and 0 <= bmiss <= 255):
            return None
        return TeamState(serial, rssi, slot, seq, q, ans, elapsed, flags, fw, presses, bmiss, tb)
    if f[0] == "H" and len(f) == 9:
        n = _ints(f[1:])
        if n is None or any(x < 0 for x in n):
            return None
        return BaseHello(*n)
    return None


# --------------------------------------------------------------------------- server -> base
def format_state(phase: int, q: int, elapsed_ms: int, limit_ms: int, ack: int,
                 correct: int, wrong: int, flags: int) -> str:
    elapsed_ms = max(0, min(65535, int(elapsed_ms)))
    return add_checksum(f"S {phase} {q & 255} {elapsed_ms} {int(limit_ms)} "
                        f"{ack & 0xFFFF} {correct & 0xFFFF} {wrong & 0xFFFF} {flags & 255}")


def format_assign(serial: int, slot: int) -> str:
    return add_checksum(f"A {serial & 0xFFFFFFFF:08X} {slot}")


def format_ident(serial: int, pattern: int = 1) -> str:
    return add_checksum(f"N {serial & 0xFFFFFFFF:08X} {pattern}")


def format_ping() -> str:
    return add_checksum("P")


def beacon_flags(n_answers: int, test: bool) -> int:
    return ((max(3, min(5, n_answers)) & 7) << BF_NANS_SHIFT) | (BF_TEST if test else 0)


# --------------------------------------------------------------------------- radio packets (tests + simulator)
def _u16(b: bytes, i: int) -> int:
    return b[i] | (b[i + 1] << 8)


def decode_radio(b: bytes) -> Optional[dict]:
    """Decode a radio payload (what sendBuffer carries). None if malformed."""
    if len(b) < 2 or b[0] != MAGIC:
        return None
    t = b[1]
    if t == T_STATE and len(b) == STATE_LEN:
        return dict(type=t, slot=b[2], seq=b[3], q=b[4], ans=b[5], elapsed=_u16(b, 6), flags=b[8],
                    fw=b[9], presses=_u16(b, 10), bmiss=b[12])
    if t == T_BEACON and len(b) == BEACON_LEN:
        return dict(type=t, phase=b[2], q=b[3], elapsed=_u16(b, 4), limit=_u16(b, 6), ack=_u16(b, 8),
                    correct=_u16(b, 10), wrong=_u16(b, 12), flags=b[14], bseq=b[15])
    if t in (T_ASSIGN, T_IDENT) and len(b) == TARGETED_LEN:
        target = int.from_bytes(b[2:6], "little", signed=True)
        return dict(type=t, target=target, arg=b[6])
    return None


def encode_radio(m: dict) -> bytes:
    t = m["type"]
    if t == T_STATE:
        e = max(0, min(65535, m["elapsed"]))
        return bytes([MAGIC, t, m["slot"] & 255, m["seq"] & 255, m["q"] & 255, m["ans"] & 255,
                      e & 255, e >> 8, m["flags"] & 255, m["fw"] & 255,
                      m["presses"] & 255, (m["presses"] >> 8) & 255, m["bmiss"] & 255])
    if t == T_BEACON:
        e = max(0, min(65535, m["elapsed"]))
        l = max(0, min(65535, m["limit"]))
        return bytes([MAGIC, t, m["phase"] & 255, m["q"] & 255, e & 255, e >> 8, l & 255, l >> 8,
                      m["ack"] & 255, (m["ack"] >> 8) & 255, m["correct"] & 255, (m["correct"] >> 8) & 255,
                      m["wrong"] & 255, (m["wrong"] >> 8) & 255, m["flags"] & 255, m["bseq"] & 255])
    if t in (T_ASSIGN, T_IDENT):
        return bytes([MAGIC, t]) + (m["target"] & 0xFFFFFFFF).to_bytes(4, "little") + bytes([m["arg"] & 255])
    raise ValueError(t)
