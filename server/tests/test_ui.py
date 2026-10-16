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
        scr.wait_for_selector(".halo")
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
        ctl.locator("input[data-cfg=allow_negative]").uncheck()
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
