"""Browser smoke test (Playwright + Chromium). Skipped when Playwright is not installed."""
import threading
import time
import unittest

try:
    from playwright.sync_api import sync_playwright
except ImportError:                                  # pragma: no cover
    sync_playwright = None

from quizzone.server import App
from quizzone.sim import SimTransport
from .helpers import make_engine


@unittest.skipIf(sync_playwright is None, "playwright not installed")
class UiSmoke(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tr = SimTransport(teams=15, seed=5, think_s=(0.3, 2.0), loss=0.2)
        cls.e, *_ = make_engine(15, clock=time.monotonic, wall=time.time)
        cls.app = App(cls.e, cls.tr)
        cls.httpd = cls.app.serve("127.0.0.1", 0)
        cls.url = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.app.start_background()
        cls.pw = sync_playwright().start()
        cls.browser = cls.pw.chromium.launch()
        deadline = time.time() + 6
        while time.time() < deadline and len(cls.e.slot_owner) < 15:
            time.sleep(0.1)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.app.shutdown()

    def page(self, w, h, path):
        errs = []
        pg = self.browser.new_page(viewport={"width": w, "height": h})
        pg.on("pageerror", lambda e: errs.append(str(e)))
        pg.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        pg.goto(self.url + path)
        return pg, errs

    def overflow(self, pg):
        return pg.evaluate("[document.documentElement.scrollWidth - innerWidth, document.documentElement.scrollHeight - innerHeight]")

    def test_full_cycle_on_big_screen_and_control(self):
        scr, e1 = self.page(1920, 1080, "/")
        ctl, e2 = self.page(1280, 900, "/control")
        mob, e3 = self.page(390, 800, "/control")
        scr.wait_for_selector(".wordart")
        self.assertEqual(scr.get_attribute(".wordart", "aria-label"), self.e.quiz.series)         # the series name is the hero
        self.assertEqual(scr.locator(".wordart span").count(), len(self.e.quiz.series))
        self.assertIn("hidden", scr.get_attribute("#net", "class") or "")        # link banner off while healthy
        self.assertEqual(self.overflow(scr), [0, 0])

        ctl.wait_for_selector("button[data-act=next]")
        ctl.click("button[data-act=next]")               # first question: 4 answers
        scr.wait_for_selector(".qtext"); scr.wait_for_selector(".ans")
        self.assertEqual(scr.locator(".ans").count(), 4)
        t0 = int(scr.inner_text("#num")); time.sleep(2.2); t1 = int(scr.inner_text("#num"))
        self.assertLess(t1, t0)
        scr.wait_for_selector(".lamp.lit", timeout=8000)
        self.assertEqual(self.overflow(scr), [0, 0])
        self.assertEqual(scr.locator(".lamp").count(), 15)
        self.assertNotIn("right", scr.inner_html(".answers"))            # answer not leaked while open

        try:                                              # it may already have closed by itself (everybody answered)
            ctl.click("button[data-act=close]", timeout=1500)
        except Exception:
            pass
        ctl.wait_for_selector("button[data-act=reveal]:not([disabled])", timeout=8000)
        ctl.click("button[data-act=reveal]")
        scr.wait_for_selector(".ans.right")
        self.assertEqual(scr.locator(".ans.right").count(), 1)
        self.assertTrue(scr.locator(".lamp.up, .lamp.down").count() > 0)
        self.assertEqual(self.overflow(scr), [0, 0])

        # control: rename survives repaint, and shows on the big screen
        ctl.fill("input[data-name='0']", "Gli <b>Scienziati</b>"); ctl.press("input[data-name='0']", "Tab")
        scr.wait_for_function("document.body.innerText.includes('Gli <b>Scienziati</b>')")   # escaped, not interpreted
        self.assertEqual(scr.locator(".lamps b").count(), 0)

        # mobile control: no horizontal page scroll
        mob.wait_for_selector("button[data-act]")
        self.assertLessEqual(self.overflow(mob)[0], 0)

        # language switch
        ctl.select_option("#lang", "en")
        scr.wait_for_function("document.querySelector('.qtext') && /[a-z]/i.test(document.querySelector('.qtext').innerText)")
        ctl.select_option("#lang", "it")

        # finish the quiz quickly and check the final page
        for _ in range(len(self.e.quiz.questions) + 2):
            with self.e.lock:
                ph = self.e.phase
            if ph == "final":
                break
            if ph in ("lobby", "reveal"):
                self.e.cmd_next()
            elif ph == "open":
                self.e.cmd_close()
            elif ph == "closed":
                self.e.cmd_reveal(force=True)
            time.sleep(0.1)
            if self.e.phase == "open":
                self.e.cmd_close()
            if self.e.phase == "closed":
                self.e.cmd_reveal(force=True)
        self.assertEqual(self.e.phase, "final")
        scr.wait_for_selector(".podium")
        self.assertEqual(scr.locator(".lamp").count(), 0)
        self.assertEqual(self.overflow(scr), [0, 0])
        for errs in (e1, e2, e3):        # a refused command (409) is normal operator feedback, not a bug
            self.assertEqual([m for m in errs if "409" not in m], [])

    def test_add_device_form_and_forgotten_list(self):
        ctl, errs = self.page(1280, 900, "/control")
        ctl.wait_for_selector("#add-btn")
        ctl.fill("#add-serial", "ABCD")
        ctl.click("#add-btn")
        ctl.wait_for_function("document.querySelector('#devices').innerText.includes('0000ABCD')")
        # an offline device can be forgotten, shows up in the forgotten list and can be restored
        ctl.once("dialog", lambda d: d.accept())
        ctl.click("button[data-forget='0000ABCD']")
        ctl.wait_for_selector("button[data-restore='0000ABCD']")
        ctl.click("button[data-restore='0000ABCD']")
        ctl.wait_for_function("document.querySelector('#devices').innerText.includes('0000ABCD')")
        self.assertEqual([m for m in errs if "409" not in m], [])

    def test_team_lamps_use_two_balanced_rows_of_equal_boxes(self):
        self.e.cmd_reset_game(confirm=True)                   # earlier tests may have left the game on the final screen
        scr, errs = self.page(1920, 1080, "/")
        scr.wait_for_selector(".lamp")
        boxes = scr.evaluate("[...document.querySelectorAll('.lamp')].map(e => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width)]; })")
        self.assertEqual(len(boxes), 15)
        widths = {b[2] for b in boxes}
        self.assertLessEqual(max(widths) - min(widths), 1, f"all boxes the same width: {widths}")
        rows = {}
        for _, top, _ in boxes:
            rows[top] = rows.get(top, 0) + 1
        self.assertEqual(sorted(rows.values(), reverse=True), [8, 7], "balanced rows (8 + 7), not 12 + 3")
        self.assertGreater(min(widths), 150, "boxes use the width instead of staying small")
        self.assertEqual(self.overflow(scr), [0, 0])
        self.assertEqual(errs, [])

    def test_final_scoreboard_has_trophies_dense_ranks_and_fits_the_screen(self):
        from quizzone import engine as E
        e = self.e
        saved = (e.phase, dict(e.scores), e.q, e.cursor)
        scores = [226, 92, 10] + [0] * 9 + [-128, -146, -225]
        try:
            with e.lock:
                e.cfg.allow_negative = True
                e.scores = {i: v for i, v in enumerate(scores)}
                e.phase, e.q = E.FINAL, None
                e._bump()
            scr, errs = self.page(1920, 1080, "/")
            scr.wait_for_selector(".hero")
            self.assertEqual(scr.locator(".hero").count(), 3)
            self.assertEqual(scr.locator(".hero .trophy-svg").count(), 3)
            ranks = [int(x) for x in scr.eval_on_selector_all(".prow .rk", "els => els.map(e => e.textContent)")]
            self.assertEqual(ranks, [4] * 9 + [5, 6, 7], "equal scores share a rank and the next one follows: no jump from 4 to 12")
            self.assertEqual(self.overflow(scr), [0, 0])
            self.assertEqual(scr.evaluate("document.querySelector('.podium').getBoundingClientRect().bottom <= innerHeight"), True)
            self.assertEqual(errs, [])
        finally:
            with e.lock:
                e.cfg.allow_negative = False
                e.phase, e.scores, e.q, e.cursor = saved[0], saved[1], saved[2], saved[3]
                e._bump()

    def test_reset_settings_button_and_highlight_of_changed_values(self):
        ctl, errs = self.page(1280, 900, "/control")
        ctl.wait_for_selector("input[data-cfgnum=tolerance_ms]")
        self.assertEqual(ctl.locator("label.changed").count(), 0)
        self.assertTrue(ctl.is_disabled("#reset-cfg"))
        ctl.fill("input[data-cfgnum=tolerance_ms]", "900"); ctl.press("input[data-cfgnum=tolerance_ms]", "Tab")
        ctl.wait_for_selector("label.changed")
        self.assertEqual(ctl.locator("label.changed").count(), 1)
        ctl.click("h1")                                                   # leave the input: the panel repaints
        ctl.wait_for_function("document.querySelector('label.changed .def')")
        self.assertIn("300", ctl.inner_text("label.changed"))             # the default is shown next to it
        ctl.locator("input[data-cfg=allow_negative]").check()
        ctl.wait_for_function("document.querySelectorAll('label.changed').length === 2")
        self.assertFalse(ctl.is_disabled("#reset-cfg"))
        color = lambda sel: ctl.evaluate(f"getComputedStyle(document.querySelector('{sel}')).color")
        self.assertNotEqual(color("label.changed"), color("#cfg label:not(.changed)"))
        ctl.once("dialog", lambda d: d.accept())
        ctl.click("#reset-cfg")
        ctl.wait_for_function("document.querySelectorAll('label.changed').length === 0")
        self.assertEqual(ctl.input_value("input[data-cfgnum=tolerance_ms]"), "300")
        self.assertTrue(ctl.is_disabled("#reset-cfg"))
        self.assertEqual([m for m in errs if "409" not in m], [])

    def test_questions_page_is_hidden_until_shown_and_hides_again(self):
        first = self.e.quiz.localized(self.e.quiz.questions[0], "it")["text"]
        pg, errs = self.page(1280, 900, "/questions?autohide=4")
        pg.wait_for_selector("#toggle")
        calls = []
        pg.on("request", lambda r: calls.append(r.url) if "/api/questions" in r.url else None)
        self.assertNotIn(first, pg.content())                               # hidden: not in the DOM
        self.assertEqual(calls, [], "nothing is even fetched while hidden")
        pg.click("#toggle")
        pg.wait_for_selector(".qcard")
        self.assertEqual(pg.locator(".qcard").count(), len(self.e.quiz.questions))
        self.assertEqual(pg.locator(".qans li.right").count(), len(self.e.quiz.questions))
        self.assertIn("4", pg.inner_text("#p-opts"))                         # supported options shown
        self.assertEqual(self.overflow(pg)[0], 0)
        pg.click("#toggle")                                                  # manual hide
        self.assertEqual(pg.locator(".qcard").count(), 0)
        self.assertNotIn(first, pg.content())
        pg.click("#toggle"); pg.wait_for_selector(".qcard")
        pg.keyboard.press("Escape")                                          # Esc hides at once
        self.assertEqual(pg.locator(".qcard").count(), 0)
        pg.click("#toggle"); pg.wait_for_selector(".qcard")                  # auto-hide after inactivity
        pg.wait_for_function("document.querySelectorAll('.qcard').length === 0", timeout=9000)
        self.assertNotIn(first, pg.content())
        self.assertEqual(errs, [])

    def test_questions_page_activity_postpones_auto_hide(self):
        pg, errs = self.page(1280, 900, "/questions?autohide=4")
        pg.wait_for_selector("#toggle"); pg.click("#toggle"); pg.wait_for_selector(".qcard")
        for _ in range(8):                                                   # 6 s of activity > 4 s limit
            time.sleep(0.75); pg.mouse.move(100 + _ * 10, 200)
        self.assertGreater(pg.locator(".qcard").count(), 0)
        self.assertEqual(errs, [])


if __name__ == "__main__":
    unittest.main()
