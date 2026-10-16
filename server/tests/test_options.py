"""Supported number of answer keys (--options): checked against the content at start-up, shown to the operator."""
import contextlib
import io
import json
import os
import tempfile
import unittest

from quizzone.__main__ import main
from quizzone.content import DEFAULT_MAX_OPTIONS, load_quiz, options_problems

from .helpers import CONTENT, make_engine


def write_content(d, n_answers):
    os.makedirs(os.path.join(d, "texts"))
    with open(os.path.join(d, "quiz.json"), "w") as f:
        json.dump({"title": {"it": "t"}, "questions": [{"id": "ok", "correct": 0}, {"id": "big", "correct": 1}]}, f)
    with open(os.path.join(d, "texts", "it.json"), "w") as f:
        json.dump({"ok": {"text": "x", "answers": ["1", "2", "3", "4"]},
                   "big": {"text": "y", "answers": [str(i) for i in range(n_answers)]}}, f)


def run_cli(*argv):
    out = io.StringIO()
    with contextlib.redirect_stdout(out):
        code = main(list(argv))
    return code, out.getvalue()


class SupportedOptions(unittest.TestCase):
    def test_default_is_four(self):
        self.assertEqual(DEFAULT_MAX_OPTIONS, 4)

    def test_shipped_content_fits_the_default(self):
        self.assertEqual(options_problems(load_quiz(CONTENT), DEFAULT_MAX_OPTIONS), [])
        code, out = run_cli("validate")
        self.assertEqual(code, 0, out)
        self.assertIn("4", out)

    def test_content_with_too_many_answers_is_reported_by_question(self):
        with tempfile.TemporaryDirectory() as d:
            write_content(d, 5)
            quiz = load_quiz(d)
            self.assertEqual(options_problems(quiz, 5), [])
            probs = options_problems(quiz, 4)
            self.assertEqual(len(probs), 1)
            self.assertIn("big", probs[0])
            self.assertIn("5 answers", probs[0])

    def test_start_up_refuses_content_that_does_not_fit(self):
        with tempfile.TemporaryDirectory() as d:
            write_content(d, 5)
            code, out = run_cli("--content", d, "run", "--sim", "2", "--data", os.path.join(d, "s.json"))
            self.assertEqual(code, 1)
            self.assertIn("big", out)
            code, out = run_cli("--content", d, "validate")
            self.assertEqual(code, 1)
            code, out = run_cli("--content", d, "validate", "--options", "5")
            self.assertEqual(code, 0, out)

    def test_option_value_outside_3_to_5_is_rejected_by_the_parser(self):
        for bad in ("2", "6", "x"):
            with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                main(["validate", "--options", bad])

    def test_engine_reports_the_value_to_the_control_panel_only(self):
        e, *_ = make_engine(2)
        self.assertEqual(e.snapshot("control")["max_options"], 4)
        self.assertNotIn("max_options", e.snapshot("screen"))

    def test_stress_test_never_uses_more_answers_than_supported(self):
        e, *_ = make_engine(2)
        e.cmd_test(seconds=3, answers=5)
        self.assertEqual(e.q.n_answers, 4)
