"""The theme must stay readable on a projector: WCAG contrast of the colour pairs actually used for text."""
import os
import re
import unittest

CSS = os.path.join(os.path.dirname(__file__), "..", "web", "static", "theme.css")


def variables():
    root = re.search(r":root\s*\{(.*?)\n\}", open(CSS, encoding="utf-8").read(), re.S).group(1)
    return dict(re.findall(r"--([\w-]+):\s*(#[0-9a-fA-F]{6})", root))


def lum(h):
    c = [int(h[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    c = [x / 12.92 if x <= 0.03928 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]


def ratio(a, b):
    la, lb = sorted((lum(a), lum(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


class Contrast(unittest.TestCase):
    def test_text_pairs_reach_wcag_aa(self):
        v = variables()
        pairs = [("ink", "bg", 7), ("ink", "bg-2", 7), ("muted", "bg", 7), ("muted", "bg-2", 4.5),
                 ("on-glow", "glow", 4.5), ("glow-deep", "bg", 4.5), ("glow-deep", "bg-2", 4.5),
                 ("ok-text", "ok-bg", 4.5), ("ok-text", "bg", 4.5), ("bad", "bad-bg", 4.5), ("bad", "bg", 4.5),
                 ("warn-text", "warn-bg", 4.5), ("ink", "ok-bg", 7)]
        pairs += [(f"on-{k}", k, 4.5) for k in "abcde"]
        for fg, bg, need in pairs:
            self.assertGreaterEqual(ratio(v[fg], v[bg]), need, f"--{fg} on --{bg}: {ratio(v[fg], v[bg]):.2f} < {need}")

    def test_answer_hues_are_distinct_and_visible_on_white(self):
        v = variables()
        hues = [v[k] for k in "abcde"]
        self.assertEqual(len(set(hues)), 5)
        for k in "abcde":
            self.assertGreaterEqual(ratio(v[k], v["bg"]), 2.3, f"--{k} outline too faint on white")  # the letter and the text carry the key as well


if __name__ == "__main__":
    unittest.main()
