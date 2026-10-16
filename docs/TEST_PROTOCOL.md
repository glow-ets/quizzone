# Test protocol

Two layers. **Layer 1 runs on any computer** (done in development, repeat after every change). **Layer 2 needs the
real hardware** and has to be done by a person before the event. Nothing in layer 1 proves layer 2.

## Layer 1 - automated (no hardware)

```
node --no-warnings --test firmware/tests/firmware.test.mjs      # firmware logic in a virtual radio world
node firmware/tools/typecheck.mjs                               # firmware vs the real MakeCode declarations
PYTHONPATH=server python3 -m unittest discover -s server/tests -t .     # from the project root (Windows: set PYTHONPATH=server first)
```

What they cover:

| area | how |
|------|-----|
| protocol bytes | golden vectors (`protocol/vectors.json`) used by both languages; fuzzing of parsers |
| device logic | first-press lock, contact bounce, glitches, held keys, stale beacons, time-up refusal |
| radio world | virtual-time simulation with collisions, half duplex, RX queue of 4, handler latency, clock drift, USB serial speed |
| worst cases | 15 simultaneous presses (40 seeds), 30 % loss, 1.5 s blackout, PC silent, flooded serial line |
| engine | scoring, ordering/duplication/loss property tests, restart recovery, corrupt state file, concurrency (threads) |
| server | HTTP/SSE, token, path traversal, oversize bodies, 40 SSE clients |
| everything together | Python engine <-TCP-> the real firmware logic running in real time (15 devices), including a server restart mid-question |
| UI | Chromium smoke test (screen, control, mobile width, final ranking, HTML escaping, language switch) |

The simulation is a **model**. Numbers it produced (all 15 teams pressing at the same instant: server received
every answer, median about 0.1 s, worst about 0.5 s; with 30 % packet loss worst about 0.6 s) are predictions to
compare against Layer 2, not measurements.

## Layer 2 - on the real hardware

Record every result in a copy of this table. A failed step blocks the event until understood.

| # | Test | Procedure | Pass criterion |
|---|------|-----------|----------------|
| 1 | Compile | Paste `dist/team.ts`, `dist/base.ts`, `dist/probe.ts` in MakeCode, download .hex | no errors; if any, send me the message |
| 2 | Pins | Probe firmware, mode 1, each Unit Key in each connector (docs/HARDWARE.md) | every connector gives one stable `P<n>`, idle pins read 1 |
| 3 | Bounce | Probe mode 2, 20 presses per key, hard and soft | at most 2 toggles, all within 10 ms; otherwise raise `QZ_DEBOUNCE_MS` |
| 4 | Speaker/LED | Probe button B; flash team firmware, assign, press | tone audible across the room; letters readable |
| 5 | Base | Plug the base, `python3 -m quizzone ports`, then `run` | micro:bit listed; control panel shows "Base collegata" and group 77/band 25 |
| 6 | Assignment | Power on all 15 devices, auto-assign, use "Fai lampeggiare" on each | 15 distinct teams, no warning signs within 10 s |
| 7 | Blast x10 | Control panel "Avvia prova", ten times in a row | every run "Tutto arrivato"; note the max delay; investigate any run above 1.5 s |
| 8 | Human simultaneous press | All teams press the same letter on a countdown, 5 questions | every team locked and acknowledged (steady letter) within 1 s |
| 9 | Bash test | Each team presses 30 times in 3 s with the Lego console | exactly one answer per question, no stuck key, no unplugged wire |
| 10 | Range | Devices at the far corners and behind the thickest wall/people, with the base at its real position | signal shown in the device list; loss under 10 %; if worse move the base up/centre |
| 11 | Interference | Run test 7 with phones, laptops and the venue Wi-Fi active; if loss > 10 % change `QZ_BAND`/`QZ_GROUP` in both builds | loss under 10 % |
| 12 | Server restart | During an open question with 5 answers in, stop the server (Ctrl+C) and start it again | question resumes, the 5 answers are still there, remaining time is right |
| 13 | Base unplugged | Unplug the base during a question, plug it back | red "Collegamento perso" on the big screen; devices show "no link"; everything resumes, nobody can answer while it is down |
| 14 | Device reset | Power-cycle one device mid-question | it rejoins with the same team number (the PC re-assigns it) |
| 15 | Big screen | Projector at the real distance and brightness | text readable from the back row; colours distinguishable |
| 16 | Dress rehearsal | Full sample quiz with real teams, both languages | no operator surprises; export the CSV and check the scores by hand |

Things the development sandbox could **not** check (so tests 1-4, 6, 10, 11 matter most): the MakeCode editor compile,
real pins and Unit Key behaviour, real radio timing and range, real USB serial throughput, Windows serial drivers
(DAPLink serial normally needs no driver on Windows 10/11).
