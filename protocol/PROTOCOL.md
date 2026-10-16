# Quizzone - protocol specification

Two links, one rule: **the device measures time, the PC decides.**

```
 team device (micro:bit)  --radio-->  base (micro:bit on USB)  --serial-->  PC (Python server)
 team device              <--radio--  base                     <--serial--  PC
```

Everything below is implemented twice (`firmware/src/qz_protocol.ts`, `server/quizzone/protocol.py`) and
both are checked against `protocol/vectors.json`, a file of hand-computed byte strings.

## 1. Design rules

1. **State replication, not events.** The PC owns the game state and broadcasts it ~10x/s. A device that missed a
   packet is corrected by the next one; nothing depends on a single message arriving.
2. **Elapsed time is measured on the device** (from the press edge, relative to the time base carried by the last
   beacon). Radio/USB delay and retries therefore do not change who was first.
3. **First press locks.** The device locks its first valid press and ignores the rest until the next question.
4. **At-least-once with idempotence.** The device repeats its STATE (jittered) until the beacon's ack bit for its
   slot is set. The PC keeps, per team, the answer with the smallest elapsed time, so duplicates and reordering
   are harmless.
5. **The PC waits for confirmation before revealing.** After time-up, the question stays CLOSED until each online
   device has reported that it has seen the CLOSED phase (or `settle_max_ms` passes).
6. **Every unit can die.** No beacons for 2.5 s: device shows "no link" and refuses presses. No PC lines for 3 s:
   the base broadcasts phase OFFLINE. PC restart: state is restored from disk; devices keep their lock.

## 2. Radio (micro:bit `radio.sendBuffer`, group 77, band 25, power 7)

All packets start with `0xC5` (magic) and a type byte. Little-endian. Max payload used: 16 of 19 bytes.

| type | name   | dir          | length | layout (byte offsets) |
|------|--------|--------------|--------|-----------------------|
| 1    | STATE  | device->base | 13     | 0 magic, 1 type, 2 slot (255 = unassigned), 3 seq, 4 q, 5 ans (0 none, 1..5), 6-7 elapsed ms (u16), 8 flags, 9 fw, 10-11 presses (u16), 12 bmiss |
| 2    | BEACON | base->all    | 16     | 0 magic, 1 type, 2 phase, 3 q, 4-5 elapsed ms (u16), 6-7 limit in 100 ms units (u16), 8-9 ack mask, 10-11 correct mask, 12-13 wrong mask, 14 flags, 15 bseq |
| 3    | ASSIGN | base->device | 7      | 0 magic, 1 type, 2-5 target serial (i32 LE), 6 slot (255 = clear) |
| 4    | IDENT  | base->device | 7      | 0 magic, 1 type, 2-5 target serial, 6 pattern |

* phases: 0 idle, 1 open, 2 closed, 3 reveal, 4 offline.
* STATE.flags: bit0 locked, bit1 acked, bits2-4 phase of the last beacon the device processed, bit5 test mode.
* BEACON.flags: bit0 test mode (devices answer by themselves), bits2-4 number of valid answers (3..5).
* `q` is a question sequence number 1..255 (wraps), not the quiz index.
* The sender's serial number is delivered by the micro:bit radio stack (`receivedPacket(RadioPacketProperty.SerialNumber)`),
  so it is not carried in the payload.

## 3. Serial (base <-> PC), 115200 baud, ASCII lines

Each line is `<payload>*<HH>` where HH is the XOR of all payload bytes, upper-case hex. A line with a bad or missing
checksum is dropped and counted.

PC -> base:

| line | meaning |
|------|---------|
| `S <phase> <q> <elapsed_ms> <limit_ms> <ack> <correct> <wrong> <flags>` | current game state; the base turns it into BEACONs (every 100 ms, elapsed advanced locally) |
| `A <serial8hex> <slot>` | assign a slot (255 clears) - radio ASSIGN |
| `N <serial8hex> <pattern>` | make a device blink/beep - radio IDENT |
| `P` | ping |

Base -> PC:

| line | meaning |
|------|---------|
| `T <serial8hex> <rssi> <slot> <seq> <q> <ans> <elapsed> <flags> <fw> <presses> <bmiss> <t_base>` | a team STATE (13 fields) |
| `H <fw> <group> <band> <uptime_s> <overflow> <foreign> <bad_lines> <rx_ok>` | base heartbeat every 2 s |

The base buffers radio packets in a 64-entry software queue (the radio's own RX queue holds only 4) and forwards
one `T` line per scheduler tick so a simultaneous press cannot block beacons on the serial port.

## 4. Acceptance rules in the server (engine.py)

* An answer counts if `0 <= elapsed <= limit + tolerance_ms` (default 300 ms) and `q` equals the current question.
* A device must report the slot the server assigned; otherwise the server (rate limited) re-sends ASSIGN and ignores
  its answers.
* Early close ("everybody answered") waits for every device heard within the last 15 s.
* Scoring: correct `+points (+ speed bonus)`, wrong `-penalty`, no answer `0` (or the configured penalty).

## 5. Hardware facts this design relies on

Checked against source code, not memory; where a source was not reachable the item is marked UNVERIFIED and is
covered by a test in `docs/TEST_PROTOCOL.md`.

* micro:bit radio: 19-byte `sendBuffer` payload, RX queue of 4 packets, no carrier sensing (collisions are real),
  16-bit CRC, proprietary 2.4 GHz protocol (not Bluetooth) - from the `radio` package of pxt-microbit / pxt-common-packages.
* Base station USB serial 115200 baud; USB ids VID 0x0D28 / PID 0x0204 (micro:bit DAPLink) used for auto-detection.
* edu:bit extension (Cytron `pxt-edubit`, attached by the organiser): the on-board PIC on I2C 0x08 is only used by
  that extension for motors/servos; the team firmware does not load it. Default music pin is P0.
* **UNVERIFIED:** which micro:bit pin each edu:bit Grove/crocodile connector uses. `firmware/src/probe_main.ts` measures it.
* M5Stack Unit Key: white wire = key (active low, needs pull-up), yellow wire = LED line (unused). **UNVERIFIED on the
  actual units**: contact bounce time (probe mode 2).
* micro:bit V1 vs V2 not yet known (sound, pull-ups and RAM differ); the firmware avoids V2-only APIs.
