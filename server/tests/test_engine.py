import json
import os
import random
import tempfile
import threading
import unittest
from dataclasses import replace

from quizzone import engine as E
from quizzone import protocol as P
from quizzone.engine import CommandError, Config
from .helpers import Clock, advance, bring_online, hello, make_engine, run_question, t_line

# question 1 "atmo": correct answer 2 (index 1), 20 s, +100, -50, speed bonus 50


class Flow(unittest.TestCase):
    def setUp(self):
        self.e, self.clock, self.wall, self.sent = make_engine(4)
        bring_online(self.e, self.clock, 4)

    def test_scoring_and_speed_bonus(self):
        e = self.e
        run_question(e, self.clock, {0: (2, 0), 1: (2, 10000), 2: (1, 500)})
        self.assertEqual(e.phase, E.CLOSED)
        self.assertTrue(e.settled)
        e.cmd_reveal()
        self.assertEqual(e.phase, E.REVEAL)
        self.assertEqual(e.scores[0], 150)             # 100 + 50 * (1 - 0/20000)
        self.assertEqual(e.scores[1], 125)             # 100 + 50 * 0.5
        self.assertEqual(e.scores[2], -50)
        self.assertEqual(e.scores.get(3, 0), 0)        # no answer: no penalty by default
        r = {x["slot"]: x for x in e.reveal["results"]}
        self.assertTrue(r[0]["correct"]); self.assertFalse(r[2]["correct"]); self.assertIsNone(r[3]["correct"])
        self.assertEqual(e.reveal["counts"], [1, 2, 0, 0])

    def test_no_answer_penalty_and_floor(self):
        e = self.e
        e.cmd_config(no_answer_penalty=30, allow_negative=False)
        run_question(e, self.clock, {2: (1, 500)})
        e.cmd_reveal()
        self.assertEqual(e.scores[2], 0)               # floored
        self.assertEqual(e.scores[3], 0)

    def test_state_lines_to_base_follow_phase(self):
        e = self.e
        e.cmd_next(); e.tick()
        last = P.strip_line(self.sent[-1]).split(" ")
        self.assertEqual(last[0:2], ["S", str(P.PH_OPEN)])
        self.assertEqual(int(last[2]), e.qseq)
        self.assertEqual(int(last[4]), 20000)
        self.assertEqual((int(last[8]) >> P.BF_NANS_SHIFT) & 7, 4)

    def test_state_resent_periodically(self):
        e = self.e
        e.tick(); n = len(self.sent)
        self.clock.adv(E.STATE_EVERY_S + 0.01); e.tick()
        self.assertGreater(len(self.sent), n)

    def test_first_press_wins_smallest_elapsed_any_order(self):
        e = self.e
        e.cmd_next(); qs = e.qseq
        for a, el in [(3, 4000), (2, 1200), (4, 900), (2, 1200)]:      # reordered duplicates
            e.handle_line(t_line(0x100, 0, qs, a, el, phase_seen=1))
        self.assertEqual((e.answers[0].ans, e.answers[0].elapsed), (4, 900))

    def test_late_answer_rejected_but_tolerance_applies(self):
        e = self.e
        e.cmd_next(); qs = e.qseq
        e.handle_line(t_line(0x100, 0, qs, 2, 20000 + 301, phase_seen=1))
        self.assertNotIn(0, e.answers); self.assertEqual(e.late_rejected, 1)
        e.handle_line(t_line(0x101, 1, qs, 2, 20000 + 299, phase_seen=1))
        self.assertIn(1, e.answers)

    def test_answer_for_other_question_ignored(self):
        e = self.e
        e.cmd_next(); qs = e.qseq
        e.handle_line(t_line(0x100, 0, qs - 1 or 255, 2, 100))
        e.handle_line(t_line(0x100, 0, qs, 9, 100))            # invalid answer number
        e.handle_line(t_line(0x100, 0, qs, 5, 100))            # 4-answer question: 5 invalid
        self.assertEqual(e.answers, {})

    def test_late_delivery_after_close_is_counted(self):
        """Packet delayed past time-up but pressed in time: must count (device-measured time)."""
        e = self.e
        e.cmd_next(); qs = e.qseq
        advance(e, self.clock, 20.6, 4, {}, qs)
        self.assertEqual(e.phase, E.CLOSED)
        e.handle_line(t_line(0x102, 2, qs, 2, 19000, phase_seen=1))
        self.assertIn(2, e.answers)

    def test_reveal_waits_for_final_reports_then_force(self):
        e = self.e
        run_question(e, self.clock, {0: (2, 100)}, final_reports=False)
        self.assertFalse(e.settled)
        with self.assertRaises(CommandError) as c:
            e.cmd_reveal()
        self.assertEqual(c.exception.key, "err.not_settled")
        advance(e, self.clock, 3.5, 4, {0: (2, 100)}, e.qseq, phase_seen=1)      # devices never confirm
        self.assertTrue(e.settled)
        self.assertEqual(e.unconfirmed, [0, 1, 2, 3])
        e.cmd_reveal()
        self.assertEqual(e.phase, E.REVEAL)

    def test_early_close_when_all_online_answered(self):
        e = self.e
        e.cmd_next(); qs = e.qseq
        for s in range(3):
            e.handle_line(t_line(0x100 + s, s, qs, 1, 100 + s, phase_seen=1))
        self.assertEqual(e.phase, E.OPEN)
        e.handle_line(t_line(0x103, 3, qs, 1, 120, phase_seen=1))
        self.assertEqual(e.phase, E.CLOSED)

    def test_offline_team_does_not_block_early_close(self):
        e = self.e
        e.cmd_next(); qs = e.qseq
        advance(e, self.clock, 8.0, 3, {}, qs)          # device 3 silent for 8 s: a hiccup, still waited for
        for s in range(3):
            e.handle_line(t_line(0x100 + s, s, qs, 1, 100, phase_seen=1))
        self.assertEqual(e.phase, E.OPEN)
        advance(e, self.clock, 9.0, 3, {0: (1, 100), 1: (1, 100), 2: (1, 100)}, qs)   # silent > 15 s: dead
        e.handle_line(t_line(0x102, 2, qs, 1, 100, phase_seen=1))
        self.assertEqual(e.phase, E.CLOSED)

    def test_early_close_can_be_disabled(self):
        e = self.e
        e.cmd_config(close_when_all_answered=False)
        e.cmd_next(); qs = e.qseq
        for s in range(4):
            e.handle_line(t_line(0x100 + s, s, qs, 1, 100, phase_seen=1))
        self.assertEqual(e.phase, E.OPEN)

    def test_command_state_machine_errors(self):
        e = self.e
        for name, key in [("open", "err.not_ready"), ("close", "err.not_open"), ("reveal", "err.not_closed"),
                          ("skip", "err.nothing_to_skip"), ("redo", "err.nothing_to_redo")]:
            with self.assertRaises(CommandError) as c:
                e.command(name)
            self.assertEqual(c.exception.key, key, name)
        e.cmd_next()
        with self.assertRaises(CommandError):
            e.cmd_next()
        with self.assertRaises(CommandError):
            e.command("nope")
        with self.assertRaises(CommandError):
            e.command("adjust", {"slot": "x"})
        with self.assertRaises(CommandError):
            e.command("__init__")

    def test_read_first_mode(self):
        e = self.e
        e.cmd_config(read_first=True)
        e.cmd_next()
        self.assertEqual(e.phase, E.READY)
        self.assertEqual(P.strip_line(self.sent[-1] if e.tick() is None else self.sent[-1]).split(" ")[1], str(P.PH_IDLE))
        e.cmd_open()
        self.assertEqual(e.phase, E.OPEN)

    def test_redo_reverts_score(self):
        e = self.e
        run_question(e, self.clock, {0: (2, 0)})
        e.cmd_reveal()
        self.assertEqual(e.scores[0], 150)
        e.cmd_redo()
        self.assertEqual(e.scores[0], 0)
        self.assertEqual(e.phase, E.OPEN)
        self.assertEqual(e.history, [])

    def test_skip_then_next_moves_on(self):
        e = self.e
        e.cmd_next(); e.cmd_skip()
        self.assertEqual(e.phase, E.LOBBY)
        e.cmd_next()
        self.assertEqual(e.q.id, e.quiz.questions[1].id)

    def test_full_game_to_final_and_csv(self):
        e = self.e
        e.cmd_config(settle_max_ms=500)
        for _ in e.quiz.questions:
            run_question(e, self.clock, {0: (e.quiz.questions[e.cursor + 1].correct + 1, 1000)})
            e.cmd_reveal()
        e.cmd_next()
        self.assertEqual(e.phase, E.FINAL)
        csv = e.export_csv()
        self.assertIn("final score", csv)
        self.assertEqual(len(e.history), len(e.quiz.questions))
        snap = e.snapshot("screen")
        self.assertEqual(snap["phase"], "final")
        self.assertTrue(snap["podium"])

    def test_five_answer_question_accepts_five(self):
        e = self.e
        # the shipped content has 4 answers per question; the protocol itself supports 5
        e.quiz.questions[3] = replace(e.quiz.questions[3], n_answers=5)
        e.cmd_goto(3)
        e.cmd_next()
        self.assertEqual(e.q.n_answers, 5)
        e.handle_line(t_line(0x100, 0, e.qseq, 5, 100, phase_seen=1))
        self.assertEqual(e.answers[0].ans, 5)

    def test_adjust_rename_and_clean_name(self):
        e = self.e
        e.cmd_adjust(slot=1, delta=-20, reason="x")
        e.cmd_rename(slot=1, name="  Gli \x00Scienziati  ")
        self.assertEqual(e.scores[1], -20)
        self.assertEqual(e.names[1], "Gli Scienziati")

    def test_snapshot_hides_answers_and_serials_from_screen(self):
        e = self.e
        e.cmd_next(); qs = e.qseq
        e.handle_line(t_line(0x100, 0, qs, 2, 100, phase_seen=1))
        s = json.dumps(e.snapshot("screen"))
        self.assertNotIn("correct", json.dumps(e.snapshot("screen")["question"]))
        self.assertNotIn("serial", s)
        self.assertNotIn('"devices"', s)
        c = e.snapshot("control")
        self.assertIn("devices", c)
        t0 = [t for t in e.snapshot("screen")["teams"] if t["slot"] == 0][0]
        self.assertTrue(t0["answered"])
        self.assertNotIn("ans", t0)


class Devices(unittest.TestCase):
    def test_unknown_device_and_manual_assign(self):
        e, clock, _, sent = make_engine(4)
        e.handle_line(t_line(0xAAAA0001, 255, 0))
        self.assertIn(0xAAAA0001, e.devices)
        self.assertIsNone(e.devices[0xAAAA0001].slot)
        e.cmd_assign(serial="AAAA0001", slot=2)
        self.assertEqual(P.strip_line(sent[-1]), "A AAAA0001 2")
        e.handle_line(t_line(0xAAAA0001, 2, 0))
        self.assertEqual(e.slot_owner[2], 0xAAAA0001)

    def test_assign_steals_slot(self):
        e, clock, _, sent = make_engine(4)
        e.handle_line(t_line(1, 255, 0)); e.handle_line(t_line(2, 255, 0))
        e.cmd_assign(serial="1", slot=0); e.cmd_assign(serial="2", slot=0)
        self.assertEqual(e.slot_owner[0], 2)
        self.assertIsNone(e.devices[1].slot)

    def test_auto_assign_in_order(self):
        e, clock, _, sent = make_engine(4)
        for s in (30, 10, 20):
            e.handle_line(t_line(s, 255, 0)); clock.adv(0.1)
        e.cmd_auto_assign()
        self.assertEqual([e.devices[s].slot for s in (30, 10, 20)], [0, 1, 2])

    def test_auto_assign_option(self):
        e, clock, _, sent = make_engine(2, auto_assign=True)
        for s in (1, 2, 3):
            e.handle_line(t_line(s, 255, 0))
        self.assertEqual(sorted(d.slot for d in e.devices.values() if d.slot is not None), [0, 1])

    def test_device_with_wrong_slot_is_corrected_and_not_trusted(self):
        e, clock, _, sent = make_engine(4)
        e.cmd_assign(serial="1", slot=0) if False else None
        e.handle_line(t_line(1, 255, 0)); e.cmd_assign(serial="1", slot=1)
        e.cmd_next(); qs = e.qseq
        clock.adv(1)
        e.handle_line(t_line(1, 3, qs, 2, 100, phase_seen=1))     # still thinks slot 3
        self.assertEqual(e.answers, {})
        self.assertEqual(P.strip_line(sent[-1]), "A 00000001 1")

    def test_assign_lines_are_rate_limited_per_device(self):
        e, clock, _, sent = make_engine(4)
        e.handle_line(t_line(1, 255, 0)); e.cmd_assign(serial="1", slot=1)
        n = len(sent)
        for i in range(20):
            clock.adv(0.01)
            e.handle_line(t_line(1, 3, 0, seq=i))          # keeps claiming slot 3
        self.assertEqual(len(sent) - n, 1)
        clock.adv(0.6)
        e.handle_line(t_line(1, 3, 0, seq=99))
        self.assertEqual(len(sent) - n, 2)

    def test_slot_out_of_range_not_recovered(self):
        e, *_ = make_engine(4)
        e.handle_line(t_line(1, 9, 0))
        self.assertIsNone(e.devices[1].slot)

    def test_loss_statistics_from_seq(self):
        e, *_ = make_engine(4)
        for seq in (250, 251, 254, 255, 2):     # lost 252,253 and 0,1
            e.handle_line(t_line(1, 255, 0, seq=seq))
        d = e.devices[1]
        self.assertEqual((d.rx, d.lost), (5, 4))

    def test_duplicate_seq_does_not_count_as_loss(self):
        e, *_ = make_engine(4)
        for seq in (5, 5, 6):
            e.handle_line(t_line(1, 255, 0, seq=seq))
        self.assertEqual(e.devices[1].lost, 0)

    def test_garbage_lines_counted_not_fatal(self):
        e, *_ = make_engine(4)
        for l in ["", "garbage", "T*00", "\x00\xff", "T 1 2*FF"]:
            e.handle_line(l)
        self.assertEqual(e.bad_lines, 4)

    def test_hello_mismatch_logged(self):
        e, *_ = make_engine(4)
        e.handle_line(hello(group=5))
        self.assertTrue(any(l["k"] == "log.base_mismatch" for l in e.log))

    def test_forget_device_only_if_offline(self):
        e, clock, *_ = make_engine(4)
        e.handle_line(t_line(1, 255, 0))
        with self.assertRaises(CommandError):
            e.cmd_forget_device(serial="1")
        clock.adv(10)
        e.cmd_forget_device(serial="1")
        self.assertEqual(e.devices, {})

    def test_shrinking_teams_blocked_when_in_use(self):
        e, *_ = make_engine(4)
        e.handle_line(t_line(1, 3, 0))
        with self.assertRaises(CommandError):
            e.cmd_config(teams=2)


class StressTest(unittest.TestCase):
    def test_blast_report_ok_and_back_to_lobby(self):
        e, clock, _, sent = make_engine(6)
        bring_online(e, clock, 6)
        e.cmd_test(seconds=3)
        qs = e.qseq
        self.assertTrue(e.test)
        beacon_flags = int(P.strip_line(sent[-1] if e.tick() is None else sent[-1]).split(" ")[8])
        self.assertTrue(beacon_flags & P.BF_TEST)
        clock.adv(0.2)
        st = {s: (1 + s % 4, 5) for s in range(6)}
        for s, (a, el) in st.items():
            e.handle_line(t_line(0x100 + s, s, qs, a, el, phase_seen=1))
        self.assertEqual(e.phase, E.CLOSED)             # everybody answered -> early close
        advance(e, clock, 1.0, 6, st, qs, phase_seen=2)
        self.assertEqual(e.phase, E.LOBBY)
        self.assertTrue(e.test_report["ok"])
        self.assertEqual(e.test_report["missing"], [])
        self.assertEqual(e.scores, {})                 # no scoring in test
        self.assertEqual(e.history, [])

    def test_blast_reports_missing_team(self):
        e, clock, _, sent = make_engine(3)
        bring_online(e, clock, 3)
        e.cmd_test(seconds=3); qs = e.qseq
        st = {0: (1, 5), 1: (2, 5)}
        for s, (a, el) in st.items():
            e.handle_line(t_line(0x100 + s, s, qs, a, el, phase_seen=1))
        advance(e, clock, 3.5, 3, st, qs)
        advance(e, clock, 1.0, 3, st, qs, phase_seen=2)
        self.assertEqual(e.phase, E.LOBBY)
        self.assertFalse(e.test_report["ok"])
        self.assertEqual(e.test_report["missing"], [3])

    def test_test_cannot_run_during_question_nor_reveal(self):
        e, clock, *_ = make_engine(2)
        e.cmd_next()
        with self.assertRaises(CommandError):
            e.cmd_test()


class Persistence(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.path = os.path.join(self.dir.name, "state.json")

    def tearDown(self):
        self.dir.cleanup()

    def test_scores_names_assignments_survive_restart(self):
        e, clock, wall, _ = make_engine(4, self.path)
        bring_online(e, clock, 4)
        e.cmd_rename(slot=0, name="Alfa")
        run_question(e, clock, {0: (2, 0)}); e.cmd_reveal()
        e2, *_ = make_engine(4, self.path)
        self.assertEqual(e2.scores, e.scores)
        self.assertEqual(e2.names[0], "Alfa")
        self.assertEqual(e2.slot_owner, e.slot_owner)
        self.assertEqual(e2.phase, E.REVEAL)
        self.assertEqual(e2.cursor, 0)
        e2.cmd_next()
        self.assertEqual(e2.q.id, e2.quiz.questions[1].id)

    def test_crash_during_open_resumes_with_correct_remaining_time(self):
        e, clock, wall, _ = make_engine(4, self.path)
        bring_online(e, clock, 4)
        e.cmd_next(); qs = e.qseq
        e.handle_line(t_line(0x100, 0, qs, 2, 1000, phase_seen=1))
        clock.adv(0.6); wall.adv(0.6); e.tick()       # save is throttled to one per 0.5 s
        clock.adv(4.4); wall.adv(4.4)
        # "crash": new process, new monotonic clock origin, wall clock moved on 8 s
        wall2 = Clock(wall.t + 3)
        e2, *_ = make_engine(4, self.path, clock=Clock(50.0), wall=wall2)
        self.assertEqual(e2.phase, E.OPEN)
        self.assertEqual(e2.qseq, qs)
        self.assertAlmostEqual((e2.clock() - e2.open_at), 8.0, delta=0.01)
        self.assertEqual(e2.answers[0].ans, 2)

    def test_corrupt_state_file_is_set_aside_and_game_starts_clean(self):
        with open(self.path, "w") as f:
            f.write("{not json")
        e, *_ = make_engine(4, self.path)
        self.assertEqual(e.phase, E.LOBBY)
        self.assertTrue(os.path.exists(self.path + ".corrupt"))

    def test_structurally_wrong_state_file_does_not_crash(self):
        with open(self.path, "w") as f:
            json.dump({"version": 1, "scores": {"x": "y"}, "game": {"cursor": "a"}}, f)
        e, *_ = make_engine(4, self.path)
        self.assertEqual(e.phase, E.LOBBY)
        self.assertEqual(e.scores, {})

    def test_stress_test_is_never_resumed(self):
        e, clock, wall, _ = make_engine(4, self.path)
        bring_online(e, clock, 4)
        e.cmd_test(seconds=10)
        e2, *_ = make_engine(4, self.path)
        self.assertEqual(e2.phase, E.LOBBY)
        self.assertFalse(e2.test)

    def test_unwritable_store_never_stops_the_game(self):
        e, clock, *_ = make_engine(4, os.path.join(self.dir.name, "state.json"))
        os.makedirs(os.path.join(self.dir.name, "state.json.blocker"), exist_ok=True)
        e.store.save = lambda d: False
        e.store.last_error = "disk full"
        e.cmd_next()
        self.assertEqual(e.phase, E.OPEN)
        self.assertTrue(any(l["k"] == "log.save_failed" for l in e.log))


class Properties(unittest.TestCase):
    def test_delivery_order_loss_and_duplication_do_not_change_result(self):
        rng = random.Random(11)
        for trial in range(60):
            e, clock, *_ = make_engine(8)
            bring_online(e, clock, 8)
            e.cmd_next(); qs = e.qseq
            truth = {s: (rng.randint(1, 4), rng.randint(100, 19000)) for s in range(8)}
            msgs = []
            for s, (a, el) in truth.items():
                msgs += [(s, a, el)] * rng.randint(1, 5)
                if rng.random() < 0.4:
                    msgs.append((s, 0, 0))                 # heartbeat before the press
            rng.shuffle(msgs)
            for s, a, el in msgs:
                e.handle_line(t_line(0x100 + s, s, qs, a, el, phase_seen=1))
            got = {s: (x.ans, x.elapsed) for s, x in e.answers.items()}
            expect = {s: truth[s] for s in {m[0] for m in msgs if m[1]}}
            self.assertEqual(got, expect)

    def test_fuzz_engine_never_raises_and_phase_always_valid(self):
        rng = random.Random(5)
        e, clock, *_ = make_engine(6)
        cmds = ["next", "open", "close", "reveal", "skip", "redo", "test", "auto_assign"]
        for step in range(4000):
            r = rng.random()
            if r < 0.5:
                s = rng.randint(0, 7)
                e.handle_line(t_line(0x100 + s, rng.choice([s, 255, 3]), rng.randint(0, 5), rng.randint(0, 6),
                                     rng.randint(0, 40000), phase_seen=rng.randint(0, 4), seq=rng.randint(0, 255)))
            elif r < 0.7:
                try:
                    e.command(rng.choice(cmds), {"force": True} if rng.random() < .3 else {})
                except CommandError:
                    pass
            else:
                clock.adv(rng.random() * 3)
                e.tick()
            self.assertIn(e.phase, (E.LOBBY, E.READY, E.OPEN, E.CLOSED, E.REVEAL, E.FINAL))
            if step % 200 == 0:
                json.dumps(e.snapshot("control"))


class Concurrency(unittest.TestCase):
    def test_threads_feeding_lines_commands_ticks_and_snapshots(self):
        e, clock, *_ = make_engine(15, clock=__import__("time").monotonic)
        errors = []
        stop = threading.Event()

        def guard(fn):
            def run():
                try:
                    fn()
                except Exception as ex:                    # noqa
                    errors.append(repr(ex))
            return run

        def feeder(k):
            def f():
                rng = random.Random(k)
                while not stop.is_set():
                    s = rng.randrange(15)
                    e.handle_line(t_line(0x100 + s, s, e.qseq, rng.randint(0, 4), rng.randint(0, 5000), phase_seen=1))
            return f

        def commander():
            rng = random.Random(99)
            while not stop.is_set():
                try:
                    e.command(rng.choice(["next", "close", "reveal", "redo", "skip", "adjust"]),
                              {"force": True, "slot": 1, "delta": 5})
                except CommandError:
                    pass

        def ticker():
            while not stop.is_set():
                e.tick()

        def viewer():
            while not stop.is_set():
                json.dumps(e.snapshot("control"))

        ths = [threading.Thread(target=guard(f)) for f in
               [feeder(1), feeder(2), feeder(3), commander, ticker, viewer, viewer]]
        for t in ths:
            t.start()
        stop.wait(2.0); stop.set()
        for t in ths:
            t.join(5)
        self.assertEqual(errors, [])
        self.assertFalse(any(t.is_alive() for t in ths))        # no deadlock


class Content(unittest.TestCase):
    def test_language_fallback_and_validation(self):
        e, *_ = make_engine(2)
        q = e.quiz.questions[2]                    # "giove": not translated into English
        self.assertEqual(e.quiz.localized(q, "en")["text"], e.quiz.localized(q, "it")["text"])
        q = e.quiz.questions[0]
        self.assertIn("atmosphere", e.quiz.localized(q, "en")["text"])

    def test_invalid_content_reports_all_problems(self):
        from quizzone.content import ContentError, load_quiz
        with tempfile.TemporaryDirectory() as d:
            os.makedirs(os.path.join(d, "texts"))
            with open(os.path.join(d, "quiz.json"), "w") as f:
                json.dump({"questions": [{"id": "a", "correct": 7}, {"id": "b", "correct": 0, "time_s": 999},
                                         {"id": "zz"}]}, f)
            with open(os.path.join(d, "texts", "it.json"), "w") as f:
                json.dump({"a": {"text": "x", "answers": ["1", "2"]}, "b": {"text": "y", "answers": ["1", "2", "3"]},
                           "unknown": {"text": "?", "answers": []}}, f)
            with self.assertRaises(ContentError) as c:
                load_quiz(d)
            msg = "; ".join(c.exception.problems)
            for needle in ("question #1", "time_s", "no text in it.json", "unknown question id"):
                self.assertIn(needle, msg)


class ResetConfig(unittest.TestCase):
    def test_reset_restores_defaults_and_keeps_game_state(self):
        e, clock, wall, sent = make_engine(4)
        bring_online(e, clock, 4)
        e.cmd_config(tolerance_ms=900, allow_negative=False, no_answer_penalty=20, auto_assign=True)
        e.cmd_adjust(slot=1, delta=70)
        e.cmd_rename(slot=0, name="Alfa")
        self.assertNotEqual(e.cfg.to_dict(), Config().to_dict())
        e.cmd_reset_config()
        d = Config().to_dict()
        self.assertEqual({k: v for k, v in e.cfg.to_dict().items() if k != "teams"}, {k: v for k, v in d.items() if k != "teams"})
        self.assertEqual(e.cfg.teams, d["teams"])
        self.assertEqual(e.scores[1], 70)
        self.assertEqual(e.names[0], "Alfa")
        self.assertEqual(len(e.devices), 4)

    def test_control_snapshot_carries_the_defaults(self):
        e, *_ = make_engine(4)
        snap = e.snapshot("control")
        self.assertEqual(snap["config_defaults"], Config().to_dict())
        self.assertNotIn("config_defaults", e.snapshot("screen"))

    def test_reset_never_orphans_a_device_above_the_default_team_count(self):
        e, clock, wall, sent = make_engine(16)
        e.handle_line(t_line(1, 255, 0)); e.cmd_assign(serial="1", slot=15)
        e.cmd_reset_config()
        self.assertEqual(e.cfg.teams, 16)
        self.assertEqual(e.log[-1]["k"], "log.config_reset_teams_kept")

    def test_reset_survives_a_restart(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "s.json")
            e, *_ = make_engine(4, store_path=path)
            e.cmd_config(tolerance_ms=900)
            e.cmd_reset_config()
            e._persist(e.clock())
            e2, *_ = make_engine(4, store_path=path)
            self.assertEqual(e2.cfg.tolerance_ms, Config().tolerance_ms)

    def test_reset_via_command_dispatch(self):
        e, *_ = make_engine(4)
        e.cmd_config(settle_max_ms=5000)
        e.command("reset_config", {})
        self.assertEqual(e.cfg.settle_max_ms, Config().settle_max_ms)


if __name__ == "__main__":
    unittest.main()


class Sync(unittest.TestCase):
    def test_unsynced_device_is_reported_until_it_confirms_its_slot(self):
        e, clock, _, sent = make_engine(4)
        e.handle_line(t_line(1, 255, 0)); e.cmd_assign(serial="1", slot=2)
        self.assertEqual(e.snapshot("control")["unsynced"], [3])
        self.assertFalse(e._device_view(e.devices[1], clock())["synced"])
        e.handle_line(t_line(1, 2, 0))
        self.assertEqual(e.snapshot("control")["unsynced"], [])
        self.assertTrue(e._device_view(e.devices[1], clock())["synced"])


class RestartSafety(unittest.TestCase):
    def test_restart_does_not_early_close_before_devices_are_heard_again(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "s.json")
            e, clock, wall, _ = make_engine(4, path)
            bring_online(e, clock, 4)
            e.cmd_next(); qs = e.qseq
            e.handle_line(t_line(0x100, 0, qs, 2, 100, phase_seen=1))
            clock.adv(0.6); e.tick()
            e2, c2, *_ = make_engine(4, path, clock=Clock(5.0))
            self.assertEqual(e2.phase, E.OPEN)
            e2.handle_line(t_line(0x100, 0, qs, 2, 100, phase_seen=1))     # only team 1 heard so far
            c2.adv(0.1); e2.tick()
            self.assertEqual(e2.phase, E.OPEN, "must keep waiting for the other three devices")


class ReAddDevices(unittest.TestCase):
    def forgotten(self, path=None):
        e, clock, wall, sent = make_engine(4, path)
        e.handle_line(t_line(0xAB, 255, 0)); e.cmd_assign(serial="AB", slot=1)
        e.handle_line(t_line(0xAB, 1, 0))
        clock.adv(10)
        e.cmd_forget_device(serial="AB")
        return e, clock, wall, sent

    def test_forgotten_device_is_listed_and_can_be_restored_with_its_team(self):
        e, clock, *_ = self.forgotten()
        self.assertEqual(e.devices, {})
        self.assertEqual(e.snapshot("control")["dismissed"], [{"serial": "000000AB", "slot": 1}])
        e.cmd_restore_device(serial="000000AB")
        self.assertEqual(e.slot_owner, {1: 0xAB})
        self.assertEqual(e.snapshot("control")["dismissed"], [])
        view = e.snapshot("control")["devices"][0]
        self.assertEqual((view["serial"], view["slot"], view["online"]), ("000000AB", 1, False))
        e.handle_line(t_line(0xAB, 1, 0))                       # device talks again: simply online
        self.assertTrue(e.snapshot("control")["devices"][0]["online"])

    def test_restore_when_team_was_taken_meanwhile_gives_an_unassigned_device(self):
        e, clock, *_ = self.forgotten()
        e.handle_line(t_line(0xCD, 255, 0)); e.cmd_assign(serial="CD", slot=1)
        e.cmd_restore_device(serial="AB")
        self.assertIsNone(e.devices[0xAB].slot)
        self.assertEqual(e.slot_owner, {1: 0xCD})

    def test_forgotten_device_that_talks_again_reappears_and_is_no_longer_listed_as_forgotten(self):
        e, clock, *_ = self.forgotten()
        e.handle_line(t_line(0xAB, 255, 0))
        self.assertIn(0xAB, e.devices)
        self.assertEqual(e.snapshot("control")["dismissed"], [])

    def test_restore_errors(self):
        e, *_ = self.forgotten()
        with self.assertRaises(CommandError) as c:
            e.cmd_restore_device(serial="FF")
        self.assertEqual(c.exception.key, "err.unknown_device")
        with self.assertRaises(CommandError):
            e.cmd_restore_device(serial="zz")
        e.cmd_restore_device(serial="AB")
        with self.assertRaises(CommandError) as c:
            e.cmd_restore_device(serial="AB")
        self.assertEqual(c.exception.key, "err.device_exists")

    def test_add_device_by_serial(self):
        e, clock, _, sent = make_engine(4)
        e.cmd_add_device(serial="1a2b3c4d", slot=2)
        self.assertEqual(e.slot_owner, {2: 0x1A2B3C4D})
        view = e.snapshot("control")["devices"][0]
        self.assertFalse(view["online"])
        # when it shows up it is recognised and told its team if it does not know it yet
        e.handle_line(t_line(0x1A2B3C4D, 255, 0))
        self.assertEqual(P.strip_line(sent[-1]), "A 1A2B3C4D 2")
        self.assertFalse(e.snapshot("control")["devices"][0]["synced"])
        e.handle_line(t_line(0x1A2B3C4D, 2, 0))
        self.assertTrue(e.snapshot("control")["devices"][0]["synced"])

    def test_add_device_without_team_and_validation(self):
        e, *_ = make_engine(4)
        e.cmd_add_device(serial="  ab  ")
        self.assertIsNone(e.devices[0xAB].slot)
        for bad in ({"serial": ""}, {"serial": "xyz"}, {"serial": "123456789"}, {"serial": "CD", "slot": 9},
                    {"serial": "CD", "slot": -1}, {"serial": "CD", "slot": "1"}, {"serial": "CD", "slot": True}):
            with self.assertRaises(CommandError, msg=str(bad)):
                e.cmd_add_device(**bad)
        e.cmd_add_device(serial="CD", slot=0)
        with self.assertRaises(CommandError) as c:
            e.cmd_add_device(serial="AB")
        self.assertEqual(c.exception.key, "err.device_exists")
        with self.assertRaises(CommandError) as c:
            e.cmd_add_device(serial="EF", slot=0)
        self.assertEqual(c.exception.key, "err.slot_taken")

    def test_forgotten_list_and_added_devices_survive_a_restart(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "s.json")
            e, *_ = self.forgotten(path)
            e.cmd_add_device(serial="77", slot=3)
            e2, *_ = make_engine(4, path)
            self.assertEqual(e2.snapshot("control")["dismissed"], [{"serial": "000000AB", "slot": 1}])
            self.assertEqual(e2.slot_owner, {3: 0x77})
            e2.cmd_restore_device(serial="AB")
            self.assertEqual(e2.slot_owner[1], 0xAB)

    def test_restored_offline_device_does_not_block_early_close_or_settling(self):
        e, clock, *_ = make_engine(3)
        bring_online(e, clock, 2)
        e.cmd_add_device(serial="999", slot=2)                  # registered, never heard
        run_question(e, clock, {0: (2, 100), 1: (2, 100)}, n=2)
        self.assertEqual(e.phase, E.CLOSED)
        self.assertTrue(e.settled)
