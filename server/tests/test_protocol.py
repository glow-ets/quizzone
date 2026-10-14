import json
import os
import random
import unittest

from contromossa import protocol as P
from .helpers import ROOT

V = json.load(open(os.path.join(ROOT, "protocol", "vectors.json")))


class Vectors(unittest.TestCase):
    def test_radio_roundtrip(self):
        for v in V["radio"]:
            raw = bytes.fromhex(v["hex"])
            dec = P.decode_radio(raw)
            self.assertEqual(dec, v["msg"], v["name"])
            self.assertEqual(P.encode_radio(v["msg"]), raw, v["name"])

    def test_radio_invalid(self):
        for h in V["radio_invalid_hex"]:
            self.assertIsNone(P.decode_radio(bytes.fromhex(h)), h)

    def test_serial_lines(self):
        for v in V["serial"]:
            self.assertEqual(P.add_checksum(v["payload"]), v["line"])
            self.assertEqual(P.strip_line(v["line"]), v["payload"])
            self.assertEqual(P.strip_line(v["line"] + "\r\n"), v["payload"])

    def test_serial_invalid(self):
        for l in V["serial_invalid"]:
            self.assertIsNone(P.strip_line(l), l)
            self.assertIsNone(P.parse_base_line(l), l)

    def test_parse_team_and_hello(self):
        st = P.parse_base_line(P.add_checksum("T 1A2B3C4D -62 6 42 7 3 4660 5 1 300 2 123456"))
        self.assertEqual((st.serial, st.rssi, st.slot, st.seq, st.q, st.ans, st.elapsed, st.presses),
                         (0x1A2B3C4D, -62, 6, 42, 7, 3, 4660, 300))
        self.assertTrue(st.locked)
        self.assertEqual(st.phase_seen, 1)
        h = P.parse_base_line(P.add_checksum("H 1 77 25 65 0 0 0 71"))
        self.assertEqual((h.group, h.band, h.rx_ok), (77, 25, 71))

    def test_out_of_range_fields_rejected(self):
        for payload in ["T 1A2B3C4D -62 256 42 7 3 4660 5 1 300 2 1",      # slot
                        "T 1A2B3C4D -62 6 42 7 3 70000 5 1 300 2 1",        # elapsed
                        "T 1A2B3C4 -62 6 42 7 3 4660 5 1 300 2 1",          # short serial
                        "T 1A2B3C4D -62 6 42 7 3 4660 5 1 300 2",           # missing field
                        "T 1A2B3C4D x 6 42 7 3 4660 5 1 300 2 1",
                        "H 1 77 25 -1 0 0 0 71", "Z 1 2 3"]:
            self.assertIsNone(P.parse_base_line(P.add_checksum(payload)), payload)

    def test_fuzz_never_raises(self):
        rng = random.Random(7)
        good = P.add_checksum("T 1A2B3C4D -62 6 42 7 3 4660 5 1 300 2 123456")
        for _ in range(3000):
            b = list(good)
            for _ in range(rng.randint(1, 4)):
                b[rng.randrange(len(b))] = chr(rng.randint(0, 255))
            P.parse_base_line("".join(b))
            P.parse_base_line("".join(chr(rng.randint(0, 255)) for _ in range(rng.randint(0, 60))))
            P.decode_radio(bytes(rng.randint(0, 255) for _ in range(rng.randint(0, 20))))

    def test_format_lines_parse_back(self):
        self.assertEqual(P.strip_line(P.format_state(1, 7, 1500, 30000, 5, 0, 0, 16)), "S 1 7 1500 30000 5 0 0 16")
        self.assertEqual(P.format_assign(0x1A2B3C4D, 5), "A 1A2B3C4D 5*74")
        self.assertEqual(P.format_ident(0xFFFFFFFF, 2), "N FFFFFFFF 2*7C")
        self.assertEqual(P.format_ping(), "P*50")
        # clamping
        self.assertEqual(P.strip_line(P.format_state(1, 300, 99999, 1, 0x1FFFF, 0, 0, 0)), "S 1 44 65535 1 65535 0 0 0")


if __name__ == "__main__":
    unittest.main()
