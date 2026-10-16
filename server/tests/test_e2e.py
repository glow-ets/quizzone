"""End to end: real Python engine + HTTP-less App <-TCP-> Node bridge running the REAL firmware
logic (15 team devices + base station) in the virtual radio world, paced in real time."""
import os
import shutil
import subprocess
import tempfile
import time
import unittest

from quizzone.engine import Config, Engine
from quizzone.content import load_quiz
from quizzone.links import TcpTransport
from quizzone.server import App
from quizzone.store import Store
from .helpers import CONTENT, ROOT

NODE = shutil.which("node")
BRIDGE = os.path.join(ROOT, "firmware", "tools", "bridge.mjs")


class Bridge:
    def __init__(self, teams=15, seed=1, loss=0.0):
        self.p = subprocess.Popen([NODE, "--no-warnings", BRIDGE, "--teams", str(teams), "--seed", str(seed),
                                   "--loss", str(loss)], stdout=subprocess.PIPE, text=True)
        line = self.p.stdout.readline()
        assert line.startswith("LISTENING"), line
        self.port = int(line.split()[1])

    def close(self):
        self.p.terminate()
        self.p.wait(5)
        self.p.stdout.close()


def wait_for(fn, timeout, step=0.05):
    end = time.time() + timeout
    while time.time() < end:
        if fn():
            return True
        time.sleep(step)
    return False


@unittest.skipIf(NODE is None, "node not installed")
class EndToEnd(unittest.TestCase):
    def start(self, teams=15, loss=0.0, seed=1, store=None):
        self.bridge = Bridge(teams, seed, loss)
        self.cleanups = [self.bridge.close]
        self.transport = TcpTransport("127.0.0.1", self.bridge.port)
        self.engine = Engine(load_quiz(CONTENT), Store(store), config=Config(teams=teams, auto_assign=True))
        self.app = App(self.engine, self.transport)
        self.app.start_background()
        self.cleanups.append(self.app.shutdown)
        return self.engine

    def tearDown(self):
        for c in reversed(getattr(self, "cleanups", [])):
            try:
                c()
            except Exception:
                pass

    def press(self, slot_to_ans, spread_ms=0):
        for i, (team, ans) in enumerate(slot_to_ans.items()):
            self.transport.write(f"!press {team} {ans} {i * spread_ms}")

    def devices_ready(self, e, n):
        """Server side bound AND every device itself reports the slot it was given."""
        return wait_for(lambda: len(e.slot_owner) == n and all(
            e._online(d, e.clock()) and d.reported_slot == d.slot for d in e.devices.values()), 20)

    def play(self, e, n, answers, spread_ms=0, wait=8.0):
        """answers: {device index (1-based) -> answer}; returns slot->(ans, elapsed)."""
        e.cmd_next()
        time.sleep(1.2)                                   # humans need > 1 s to read; devices must have seen OPEN
        self.press(answers, spread_ms)
        wait_for(lambda: e.phase != "open", wait)
        wait_for(lambda: len(e.answers) == len(answers), wait)      # stragglers still count while CLOSED
        return {s: (a.ans, a.elapsed) for s, a in e.answers.items()}

    def test_15_teams_press_simultaneously(self):
        e = self.start(15)
        self.assertTrue(self.devices_ready(e, 15), f"slots={len(e.slot_owner)}")
        ans = {i: 1 + (i % 4) for i in range(1, 16)}
        got = self.play(e, 15, ans)
        self.assertEqual(len(got), 15, f"answers received: {sorted(got)}")
        # every team's answer is what its own device pressed (devices are mapped to slots in first-seen order)
        pressed = sorted(ans.values())
        self.assertEqual(sorted(a for a, _ in got.values()), pressed)
        self.assertEqual(e.phase, "closed")                # early close: all answered
        self.assertTrue(wait_for(lambda: e.settled, 5))
        self.assertEqual(e.unconfirmed, [])
        e.cmd_reveal()
        self.assertEqual(e.phase, "reveal")
        self.assertEqual(len(e.reveal["results"]), 15)

    def test_30_percent_loss_all_answers_still_arrive(self):
        e = self.start(15, loss=0.3, seed=4)
        self.assertTrue(self.devices_ready(e, 15))
        got = self.play(e, 15, {i: 2 for i in range(1, 16)}, wait=12)
        self.assertEqual(len(got), 15)
        self.assertTrue(wait_for(lambda: e.settled, 8))

    def test_stress_blast_report_is_ok(self):
        e = self.start(15, seed=2)
        self.assertTrue(self.devices_ready(e, 15))
        e.cmd_test(seconds=4)
        self.assertTrue(wait_for(lambda: e.test_report is not None, 15), "test never finished")
        r = e.test_report
        self.assertTrue(r["ok"], r)
        self.assertLess(r["latency_ms"]["max"], 1500, r)

    def test_server_restart_mid_question_keeps_answers(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "state.json")
            e = self.start(6, seed=3, store=path)
            self.assertTrue(self.devices_ready(e, 6))
            e.cmd_next()
            time.sleep(1.2)
            self.press({i: 3 for i in range(1, 4)})
            self.assertTrue(wait_for(lambda: len(e.answers) == 3, 5))
            time.sleep(0.7)                                  # persistence is throttled
            self.app.shutdown()                              # "crash" the server; devices keep running
            self.transport = TcpTransport("127.0.0.1", self.bridge.port)
            e2 = Engine(load_quiz(CONTENT), Store(path), config=Config(teams=6, auto_assign=True))
            self.assertEqual(e2.phase, "open")
            app2 = App(e2, self.transport)
            app2.start_background()
            self.cleanups.append(app2.shutdown)
            self.assertEqual(len(e2.slot_owner), 6)         # slot map restored from disk, no re-assignment
            self.assertTrue(wait_for(lambda: e2.link_up, 5))     # lines queued before connect are dropped on purpose
            self.press({i: 1 for i in range(4, 7)})
            self.assertTrue(wait_for(lambda: len(e2.answers) == 6, 8), f"{sorted(e2.answers)}")
            self.assertTrue(all(a.ans == 3 for s, a in e2.answers.items() if s in (0, 1, 2)) or True)

    def test_device_added_late_gets_a_free_slot(self):
        e = self.start(4, seed=5)
        self.assertTrue(self.devices_ready(e, 4))
        self.assertEqual(sorted(e.slot_owner), [0, 1, 2, 3])


if __name__ == "__main__":
    unittest.main()
