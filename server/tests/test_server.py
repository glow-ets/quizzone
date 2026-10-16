import http.client
import json
import os
import tempfile
import threading
import time
import unittest

from quizzone import protocol as P
from quizzone.links import LoopbackTransport
from quizzone.server import App
from quizzone.sim import SimTransport
from .helpers import make_engine, t_line


class Base(unittest.TestCase):
    token = None
    teams = 4

    def setUp(self):
        self.web = tempfile.TemporaryDirectory()
        os.makedirs(os.path.join(self.web.name, "static")); os.makedirs(os.path.join(self.web.name, "i18n"))
        with open(os.path.join(self.web.name, "static", "screen.html"), "w") as f:
            f.write("<html>screen</html>")
        with open(os.path.join(self.web.name, "static", "questions.html"), "w") as f:
            f.write("<html>questions page</html>")
        with open(os.path.join(self.web.name, "i18n", "it.json"), "w") as f:
            f.write('{"a":"b"}')
        with open(os.path.join(self.web.name, "secret.txt"), "w") as f:
            f.write("secret")
        self.engine, *_ = make_engine(self.teams, clock=time.monotonic, wall=time.time)
        self.tr = LoopbackTransport()
        self.app = App(self.engine, self.tr, token=self.token, web_dir=self.web.name)
        self.httpd = self.app.serve("127.0.0.1", 0)
        self.port = self.httpd.server_address[1]
        self.th = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.th.start()
        self.app.start_background()

    def tearDown(self):
        self.app.shutdown()
        self.web.cleanup()

    def req(self, method, path, body=None, headers=None):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request(method, path, body=body, headers=headers or {})
        r = c.getresponse()
        data = r.read()
        c.close()
        return r.status, r.getheaders(), data

    def cmd(self, name, args=None, headers=None, path="/api/cmd"):
        st, _, d = self.req("POST", path, json.dumps({"name": name, "args": args or {}}), headers)
        return st, json.loads(d)


class Http(Base):
    def test_static_and_traversal(self):
        self.assertEqual(self.req("GET", "/")[0], 200)
        self.assertEqual(self.req("GET", "/i18n/it.json")[2], b'{"a":"b"}')
        for p in ["/static/../secret.txt", "/static/%2e%2e/secret.txt", "/i18n/..%2fsecret.json", "/i18n/../secret.txt",
                  "/static//etc/passwd", "/nope"]:
            self.assertEqual(self.req("GET", p)[0], 404 if not p.startswith("/i18n/..%2f") else 400, p)
        self.assertNotIn(b"secret", self.req("GET", "/static/../secret.txt")[2])

    def test_state_roles(self):
        st, _, d = self.req("GET", "/api/state")
        self.assertEqual(st, 200)
        s = json.loads(d)
        self.assertEqual(s["phase"], "lobby")
        self.assertNotIn("devices", s)
        self.assertIn("devices", json.loads(self.req("GET", "/api/state?role=control")[2]))

    def test_command_and_errors(self):
        self.assertEqual(self.cmd("next"), (200, {"ok": True}))
        st, r = self.cmd("next")
        self.assertEqual((st, r["key"]), (409, "err.question_running"))
        self.assertEqual(self.cmd("nope")[0], 409)
        self.assertEqual(self.req("POST", "/api/cmd", "{bad json")[0], 400)
        self.assertEqual(self.req("POST", "/api/cmd", json.dumps({"name": "next", "args": 5}))[0], 400)
        self.assertEqual(self.req("POST", "/api/cmd", "x" * (70 * 1024))[0], 413)
        self.assertEqual(self.req("POST", "/api/other", "{}")[0], 404)

    def test_engine_lines_reach_transport_and_base_lines_reach_engine(self):
        self.cmd("next")
        deadline = time.time() + 2
        while time.time() < deadline and not any(l.startswith("S 1 ") for l in self.tr.sent):
            time.sleep(0.05)
        self.assertTrue(any(l.startswith("S 1 ") for l in self.tr.sent))
        qs = self.engine.qseq
        self.tr.inject(t_line(0x100, 0, qs, 3, 500, phase_seen=1))
        self.assertEqual(self.engine.answers[0].ans, 3)

    def test_csv_export(self):
        st, h, d = self.req("GET", "/api/export.csv")
        self.assertEqual(st, 200)
        self.assertIn(b"final score", d)

    def test_sse_streams_snapshots_and_updates_quickly(self):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        c.request("GET", "/api/events")
        r = c.getresponse()
        self.assertEqual(r.getheader("Content-Type"), "text/event-stream")

        def next_snapshot():
            while True:
                line = r.fp.readline().decode()
                if line.startswith("data: "):
                    return json.loads(line[6:])
        self.assertEqual(next_snapshot()["phase"], "lobby")
        t0 = time.time()
        self.cmd("next")
        while True:
            s = next_snapshot()
            if s["phase"] == "open":
                break
        self.assertLess(time.time() - t0, 1.0)
        c.close()
        time.sleep(0.5)

    def test_many_sse_clients_and_dropped_clients_do_not_leak(self):
        conns = []
        for _ in range(40):
            c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
            c.request("GET", "/api/events?role=screen")
            r = c.getresponse()
            r.fp.readline()
            conns.append((c, r))
        self.assertEqual(self.app.sse_clients, 40)
        for _ in range(5):
            self.cmd("skip") if self.engine.phase != "lobby" else self.cmd("next")
        for c, r in conns:
            r.close(); c.close()
        deadline = time.time() + 5
        while time.time() < deadline and self.app.sse_clients:
            self.cmd("skip") if self.engine.phase != "lobby" else self.cmd("next")
            time.sleep(0.1)
        self.assertEqual(self.app.sse_clients, 0)

    def test_malformed_radio_flood_through_transport_is_harmless(self):
        import random
        rng = random.Random(1)
        for _ in range(2000):
            self.tr.inject("".join(chr(rng.randint(0, 255)) for _ in range(rng.randint(0, 50))))
        self.assertEqual(self.req("GET", "/api/state")[0], 200)


class Questions(Base):
    def test_questions_page_and_api(self):
        self.assertEqual(self.req("GET", "/questions")[0], 200)
        st, _, d = self.req("GET", "/api/questions?lang=it")
        self.assertEqual(st, 200)
        j = json.loads(d)
        self.assertEqual(j["max_options"], 4)
        self.assertEqual(len(j["questions"]), len(self.engine.quiz.questions))
        q0 = j["questions"][0]
        self.assertEqual(q0["answers"], self.engine.quiz.localized(self.engine.quiz.questions[0], "it")["answers"])
        self.assertEqual(q0["correct"], self.engine.quiz.questions[0].correct)
        en = json.loads(self.req("GET", "/api/questions?lang=en")[2])
        self.assertEqual(en["lang"], "en")
        self.assertNotEqual(en["questions"][0]["text"], q0["text"])
        self.assertEqual(json.loads(self.req("GET", "/api/questions?lang=../../etc")[2])["lang"], self.engine.lang)

    def test_answers_never_travel_in_snapshots(self):
        correct_text = {q["answers"][q["correct"]] for q in self.engine.questions_view("it")["questions"]}
        self.cmd("next"); 
        for role in ("screen", "control"):
            body = self.req("GET", f"/api/state?role={role}")[2].decode()
            self.assertNotIn('"correct"', body)       # open question: no hint
            self.assertNotIn("questions", json.loads(body))
        self.assertTrue(correct_text)

    def test_questions_page_is_read_only(self):
        self.assertEqual(self.req("POST", "/api/questions", b"{}")[0], 404)


class Auth(Base):
    token = "s3cret"

    def test_questions_api_requires_token(self):
        self.assertEqual(self.req("GET", "/api/questions")[0], 401)
        self.assertEqual(self.req("GET", "/api/questions", headers={"X-Token": "wrong"})[0], 401)
        self.assertEqual(self.req("GET", "/api/questions?token=s3cret")[0], 200)
        self.assertEqual(self.req("GET", "/api/questions", headers={"X-Token": "s3cret"})[0], 200)
        self.assertNotIn(b"answers", self.req("GET", "/questions")[2])      # the page itself carries no content

    def test_control_requires_token_screen_does_not(self):
        self.assertEqual(self.req("GET", "/api/state")[0], 200)
        self.assertEqual(self.req("GET", "/api/state?role=control")[0], 401)
        self.assertEqual(self.req("GET", "/api/state?role=control&token=s3cret")[0], 200)
        self.assertEqual(self.req("GET", "/api/events?role=control")[0], 401)
        self.assertEqual(self.req("GET", "/api/export.csv")[0], 401)
        self.assertEqual(self.cmd("next")[0], 401)
        self.assertEqual(self.cmd("next", headers={"X-Token": "wrong"})[0], 401)
        self.assertEqual(self.cmd("next", headers={"X-Token": "s3cret"})[0], 200)
        self.assertEqual(self.engine.phase, "open")


class SimEndToEnd(unittest.TestCase):
    def test_virtual_teams_play_a_question(self):
        """Python simulated base + 10 teams + real engine + HTTP: a question runs to reveal."""
        tr = SimTransport(teams=10, seed=3, think_s=(0.2, 1.5), loss=0.3)
        e, *_ = make_engine(10, clock=time.monotonic, wall=time.time)
        app = App(e, tr)
        app.start_background()
        try:
            deadline = time.time() + 6
            while time.time() < deadline and len([d for d in e.devices.values() if d.slot is not None]) < 10:
                time.sleep(0.1)
            self.assertEqual(len(e.slot_owner), 10)
            e.cmd_config(settle_max_ms=3000)
            e.cmd_test(seconds=3)
            deadline = time.time() + 12
            while time.time() < deadline and e.test_report is None:
                time.sleep(0.1)
            self.assertIsNotNone(e.test_report)
            self.assertTrue(e.test_report["ok"], e.test_report)
        finally:
            app.shutdown()


if __name__ == "__main__":
    unittest.main()
