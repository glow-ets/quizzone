import json
import os
import re
import sys
import threading
import time
import types
import unittest

from quizzone import links
from .helpers import ROOT

WEB = os.path.join(ROOT, "server", "web")


class FakeSerialModule(types.ModuleType):
    """Stands in for pyserial: lets us test framing, writes and reconnection without a device."""
    class SerialException(Exception):
        pass

    def __init__(self):
        super().__init__("serial")
        self.inbox = []           # bytes chunks the "device" sends
        self.written = []
        self.fail_open = 0
        self.break_after_reads = None
        mod = self

        class Serial:
            def __init__(self, port, baud, timeout=None, write_timeout=None):
                if mod.fail_open > 0:
                    mod.fail_open -= 1
                    raise mod.SerialException("busy")
                self.port, self.baud = port, baud
                self.reads = 0

            def read(self, n):
                self.reads += 1
                if mod.break_after_reads is not None and self.reads > mod.break_after_reads:
                    mod.break_after_reads = None
                    raise mod.SerialException("unplugged")
                if mod.inbox:
                    return mod.inbox.pop(0)
                time.sleep(0.01)
                return b""

            def write(self, b):
                mod.written.append(b)

            def close(self):
                pass
        self.Serial = Serial


class SerialTransportTests(unittest.TestCase):
    def setUp(self):
        self.fake = FakeSerialModule()
        self._saved = sys.modules.get("serial")
        sys.modules["serial"] = self.fake

    def tearDown(self):
        if self._saved is None:
            sys.modules.pop("serial", None)
        else:
            sys.modules["serial"] = self._saved

    def run_transport(self, port="COM9"):
        got, status = [], []
        tr = links.SerialTransport(port)
        tr.start(got.append, lambda up, d: status.append((up, d)))
        self.addCleanup(tr.close)
        return tr, got, status

    def wait(self, fn, t=3):
        end = time.time() + t
        while time.time() < end:
            if fn():
                return True
            time.sleep(0.02)
        return False

    def test_framing_split_chunks_crlf_and_garbage(self):
        self.fake.inbox += [b"T 1*", b"AA\r\nH 2*BB\nnoise-without-newline", b" more\n"]
        tr, got, status = self.run_transport()
        self.assertTrue(self.wait(lambda: len(got) == 3))
        self.assertEqual(got[:2], ["T 1*AA", "H 2*BB"])
        self.assertEqual(status[0], (True, "COM9"))

    def test_write_adds_newline(self):
        tr, got, status = self.run_transport()
        self.assertTrue(self.wait(lambda: status))
        tr.write("P*50")
        self.assertTrue(self.wait(lambda: self.fake.written))
        self.assertEqual(self.fake.written[0], b"P*50\n")

    def test_retries_when_port_busy_then_reconnects_after_unplug(self):
        self.fake.fail_open = 2
        tr, got, status = self.run_transport()
        self.assertTrue(self.wait(lambda: (True, "COM9") in status, 6))
        self.fake.break_after_reads = 2
        self.assertTrue(self.wait(lambda: any(not up and "unplugged" in d for up, d in status), 4))
        self.assertTrue(self.wait(lambda: status.count((True, "COM9")) >= 2, 6))

    def test_overlong_line_without_newline_does_not_grow_forever(self):
        self.fake.inbox += [b"x" * 3000 for _ in range(10)] + [b"\nT 1*AA\n"]
        tr, got, status = self.run_transport()
        self.assertTrue(self.wait(lambda: "T 1*AA" in got))

    def test_output_queue_is_bounded_and_keeps_newest(self):
        tr = links.Transport()
        for i in range(500):
            tr.write(f"L{i}")
        self.assertLessEqual(tr._out.qsize(), 64)
        last = None
        while not tr._out.empty():
            last = tr._out.get_nowait()
        self.assertEqual(last, "L499")


class I18n(unittest.TestCase):
    def load(self, lang):
        with open(os.path.join(WEB, "i18n", f"{lang}.json"), encoding="utf-8") as f:
            return json.load(f)

    def test_every_key_used_exists_in_italian_and_english_has_the_same_keys(self):
        it, en = self.load("it"), self.load("en")
        used = set()
        for fn in ("static/control.js", "static/screen.js", "static/common.js", "static/control.html", "static/screen.html"):
            with open(os.path.join(WEB, fn), encoding="utf-8") as f:
                src = f.read()
            used |= set(re.findall(r"""["'`]((?:ctl|act|phase|cfg|rep|confirm|screen|team|err)\.[a-z_]+)["'`]""", src))
            used |= set(re.findall(r'data-i="([^"]+)"', src))
        with open(os.path.join(ROOT, "server", "quizzone", "engine.py"), encoding="utf-8") as f:
            eng = f.read()
        used |= set(re.findall(r"""["']((?:log|err)\.[a-z_]+)["']""", eng))
        used |= {"cfg." + k for k in ("close_when_all_answered", "read_first", "allow_negative", "auto_assign", "teams",
                                       "no_answer_penalty", "tolerance_ms", "settle_max_ms")}
        used |= {"phase." + p for p in ("lobby", "ready", "open", "closed", "reveal", "final")}
        self.assertEqual(sorted(k for k in used if k not in it), [])
        self.assertEqual(sorted(set(it) ^ set(en)), [])

    def test_placeholders_match_between_languages(self):
        it, en = self.load("it"), self.load("en")
        for k in it:
            self.assertEqual(sorted(re.findall(r"\{(\w+)\}", it[k])), sorted(re.findall(r"\{(\w+)\}", en[k])), k)


if __name__ == "__main__":
    unittest.main()
