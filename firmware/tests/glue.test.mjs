// Runs the REAL team_main.ts (the MakeCode glue: HAL, display fiber, key polling) on fake MakeCode
// globals with a virtual clock and cooperative fibers, together with the real QzTeam logic.
// The glue is the one part the logic tests cannot see; the "blinking forever" bug lived here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { srcDir } from './sim.mjs';

function makeDevice() {
  // ---- virtual time + fibers ------------------------------------------------
  let now = 1000;
  const sleepers = [];
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  const audioPin = [], sent = [], leds = Array.from({ length: 5 }, () => Array(5).fill(false)), tones = [];
  const input = { A: false, B: false };
  const g = {
    console,
    Math: Object.assign(Object.create(Math), { idiv: (a, b) => Math.trunc(a / b) }),
    DigitalPin: { P0: 0, P1: 1, P2: 2, P8: 8, P12: 12, P13: 13, P14: 14, P15: 15, P16: 16 },
    Button: { A: 'A', B: 'B' }, PinPullMode: { PullUp: 1 },
    control: {
      millis: () => now, deviceSerialNumber: () => 0x1234567, createBuffer: (n) => new Uint8Array(n),
      inBackground: (fn) => { g.__fibers.push(fn); },
    },
    __fibers: [],
    basic: { pause: (ms) => new Promise((r) => sleepers.push({ t: now + ms, r })), clearScreen: () => leds.forEach((r) => r.fill(false)) },
    radio: { setGroup() {}, setFrequencyBand() {}, setTransmitPower() {}, setTransmitSerialNumber() {},
      sendBuffer: (b) => sent.push([...b]), onReceivedBuffer: (fn) => { g.__rx = fn; } },
    music: { setVolume() {}, playTone: (f, d) => { tones.push(f); return g.basic.pause(d); } },
    pins: { setPull() {}, digitalReadPin: () => 1, setAudioPinEnabled: (e) => { audioPin.push([now, e]); } },
    input: { buttonIsPressed: (b) => input[b], onLogoEvent: (e, fn) => { g.__logo = fn; } },
    TouchButtonEvent: { Pressed: 'pressed' },
    led: { plot: (x, y) => { leds[y][x] = true; }, unplot: (x, y) => { leds[y][x] = false; } },
    serial: {},
  };
  const ctx = vm.createContext(g);
  vm.runInContext('Math.idiv = function (a, b) { return Math.trunc(a / b); };', ctx);
  for (const f of ['qz_config.ts', 'qz_protocol.ts', 'qz_team.ts', 'qz_display.ts', 'team_main.ts']) {
    let code = fs.readFileSync(path.join(srcDir, f), 'utf8');
    if (f === 'team_main.ts') {
      code = code.replace(/basic\.pause\(/g, 'await basic.pause(')
        .replace(/control\.inBackground\(function \(\) \{/g, 'control.inBackground(async function () {')
        .replace(/music\.playTone\(/g, 'await music.playTone(')
        .replace('function qzPlay(', 'async function qzPlay(')
        .replace(/qzPlay\(qzSoundQueue\.shift\(\)\)/, 'await qzPlay(qzSoundQueue.shift())');
    }
    vm.runInContext(stripTypeScriptTypes(code), ctx, { filename: f });
  }
  g.__fibers.forEach((fn) => fn());           // start the fibers (they run until their first pause)
  const dev = {
    ctx, sent, tones, input, audioPin,
    get now() { return now; },
    screen: () => leds.map((r) => r.map((v) => (v ? '#' : '.')).join('')),
    async run(ms, sample) {
      const end = now + ms;
      for (;;) {
        await flush();
        sleepers.sort((a, b) => a.t - b.t);
        if (!sleepers.length || sleepers[0].t > end) break;
        const s = sleepers.shift();
        now = Math.max(now, s.t);
        s.r();
        if (sample) sample();
      }
      now = end; await flush();
    },
    ev: (code) => vm.runInContext(code, ctx),
    logo() { g.__logo(); },
    radioRx(bytes) { g.__rx(new Uint8Array(bytes)); },
    packet(bytes) { vm.runInContext(`qzTeam.onPacket(${JSON.stringify(bytes)}, control.millis())`, ctx); },
  };
  return dev;
}

const beacon = (dev, o) => dev.ev(`qzEncBeacon(Object.assign(new QzMsg(), ${JSON.stringify({ phase: 1, q: 5, elapsed: 0, limit: 300, ack: 0, correct: 0, wrong: 0, flags: 4 << 2, bseq: 0, ...o })}))`);
const assign = (dev, slot) => dev.ev(`qzEncTargeted(3, control.deviceSerialNumber(), ${slot})`);
const LETTER = (dev, i) => dev.ev(`QZ_LETTERS[${i}]`).join('|');
// Assignment makes the device flash its number for 2.5 s (identify); questions start after that.
async function join(dev, slot) {
  await dev.run(200);
  dev.packet(assign(dev, slot));
  await beacons(dev, 2700, () => ({ phase: 0 }));
}
const BLANK = '.....|.....|.....|.....|.....';

// Feed the device beacons the way the base would: every 100 ms, with a given ack/phase.
async function beacons(dev, ms, o = () => ({})) {
  for (let t = 0; t < ms; t += 100) {
    dev.packet(beacon(dev, { elapsed: dev.now - 1000, ...o(t) }));
    await dev.run(100);
  }
}

test('glue: locked letter blinks until the base acknowledges, then stays steady forever', async () => {
  const dev = makeDevice();
  await join(dev, 2);
  await beacons(dev, 600);                       // OPEN, countdown bar
  dev.input.A = true;                            // press key A (QZ_KEY_SOURCES[0] = micro:bit button A)
  await dev.run(150);
  dev.input.A = false;
  const letterA = LETTER(dev, 0);

  // not acknowledged yet: the letter must blink (both the letter and a blank frame appear)
  const seen = new Set();
  const sample = () => seen.add(dev.screen().join('|'));
  await beacons(dev, 1500, () => ({ ack: 0 }));
  for (let i = 0; i < 40; i++) { await dev.run(25, sample); }
  assert.ok(seen.has(letterA) && seen.has(BLANK), `blink frames: ${[...seen].length}`);

  // the base acknowledges slot 2 (bit 2): from now on the picture must be the steady letter
  await beacons(dev, 300, () => ({ ack: 1 << 2 }));
  const after = new Set();
  const sample2 = () => after.add(dev.screen().join('|'));
  for (let i = 0; i < 400; i++) {                // 10 s of beacons + button mashing
    if (i % 20 === 0) { dev.input.B = true; }
    if (i % 20 === 5) { dev.input.B = false; dev.input.A = true; }
    if (i % 20 === 10) { dev.input.A = false; }
    if (i % 4 === 0) dev.packet(beacon(dev, { ack: 1 << 2, elapsed: dev.now - 1000 }));
    await dev.run(25, sample2);
  }
  assert.deepEqual([...after], [letterA], 'after the ACK the screen is a single steady frame');
});

test('glue: the acknowledgement arriving in the middle of a blink is not lost', async () => {
  // This is the original bug: ACK landed while the old render loop was inside its blocking blink.
  for (let offsetMs = 0; offsetMs < 400; offsetMs += 17) {
    const dev = makeDevice();
    await join(dev, 0);
    await beacons(dev, 400);
    dev.input.B = true; await dev.run(120); dev.input.B = false;     // answer B
    await dev.run(offsetMs);
    await beacons(dev, 2000, () => ({ ack: 1 }));
    const frames = new Set();
    for (let i = 0; i < 60; i++) await dev.run(25, () => frames.add(dev.screen().join('|')));
    await beacons(dev, 300, () => ({ ack: 1 }));
    for (let i = 0; i < 60; i++) await dev.run(25, () => frames.add(dev.screen().join('|')));
    assert.equal(dev.screen().join('|'), LETTER(dev, 1), `offset ${offsetMs}: steady letter B at the end`);
  }
});

test('glue: closed -> result -> idle -> next question: the screen follows each phase', async () => {
  const dev = makeDevice();
  await join(dev, 1);
  await beacons(dev, 500);
  dev.input.A = true; await dev.run(120); dev.input.A = false;
  await beacons(dev, 800, () => ({ ack: 2 }));
  await beacons(dev, 500, () => ({ phase: 2, ack: 2, elapsed: 30000 }));
  assert.equal(dev.screen().join('|'), LETTER(dev, 0), 'closed shows the locked letter');
  await beacons(dev, 600, () => ({ phase: 3, ack: 2, correct: 2, elapsed: 30000 }));
  assert.equal(dev.screen().join('|'), dev.ev('QZ_ICON_CHECK').join('|'), 'correct answer: tick');
  await beacons(dev, 600, () => ({ phase: 0 }));
  assert.equal(dev.screen().join('|'), dev.ev('qzFrame(QZ_D_IDLE, 2, 0, 0)').join('|'), 'idle: team number');
  await beacons(dev, 600, () => ({ phase: 1, q: 6 }));
  const lit = dev.screen().join('').split('#').length - 1;
  assert.ok(lit > 15, `new question: countdown bar, ${lit} LEDs lit`);
});

test('glue: the edge-connector audio pin (P0) is released except while a sound plays', async () => {
  const dev = makeDevice();
  assert.deepEqual(dev.audioPin.map((e) => e[1]), [false], 'released at start-up, before any sound');
  await join(dev, 0);                                   // assignment plays a chirp
  await dev.run(1000);
  const states = dev.audioPin.map((e) => e[1]);
  assert.ok(dev.tones.length > 0, 'a sound did play');
  assert.deepEqual(states, [false, true, false], 'connected only around the sound');
  assert.equal(states[states.length - 1], false, 'released again once the queue is empty');
  await dev.run(5000);                                  // idle: nothing may re-enable it
  assert.equal(dev.audioPin.length, 3);
});

const BANG = (dev) => dev.ev('QZ_ICON_BANG').join('|');

test('glue: local test mode - blinking "!", letters on key press, nothing on the radio, incoming ignored, exit restores', async () => {
  const dev = makeDevice();
  await join(dev, 1);
  await beacons(dev, 600, () => ({ phase: 0 }));
  const modeBefore = dev.ev('qzDMode');
  dev.logo();                                           // enter test mode
  await dev.run(100);
  const sentAtEntry = dev.sent.length;

  // 1. blinking "!" on the right side, nothing else
  const seen = new Set();
  for (let i = 0; i < 60; i++) await dev.run(25, () => seen.add(dev.screen().join('|')));
  assert.deepEqual([...seen].sort(), [BANG(dev), BLANK].sort(), '"!" blinks between lit and dark');

  // 2. pressing a key shows its letter (A..D), holding it keeps it, and it falls back to "!" after release
  const keys = [['A', 0], ['B', 1]];
  for (const [k, idx] of keys) {
    dev.input[k] = true; await dev.run(150);
    assert.equal(dev.screen().join('|'), LETTER(dev, idx), `key ${k} shows its letter`);
    await dev.run(1000);
    assert.equal(dev.screen().join('|'), LETTER(dev, idx), `held key ${k} keeps its letter`);
    dev.input[k] = false; await dev.run(100);
    assert.equal(dev.screen().join('|'), LETTER(dev, idx), 'letter lingers briefly after release');
    await dev.run(700);
    assert.ok([BANG(dev), BLANK].includes(dev.screen().join('|')), 'back to the blinking "!"');
  }

  // incoming radio is ignored: beacons with an open question and a new assignment change nothing
  for (let i = 0; i < 20; i++) { dev.radioRx(beacon(dev, { phase: 1, elapsed: 100 * i })); await dev.run(100); }
  dev.radioRx(assign(dev, 5)); await dev.run(300);
  assert.equal(dev.ev('qzDMode'), modeBefore, 'game state untouched by radio received in test mode');
  const seen2 = new Set();
  for (let i = 0; i < 60; i++) await dev.run(25, () => seen2.add(dev.screen().join('|')));
  assert.deepEqual([...seen2].sort(), [BANG(dev), BLANK].sort());

  // nothing was transmitted during the whole test mode, key presses included
  assert.equal(dev.sent.length, sentAtEntry, 'no radio packets in test mode');
  assert.ok(dev.tones.length > 0);

  // 3. leave: back to the game; a key still held at that moment is not counted as an answer
  dev.input.A = true;
  dev.logo(); await dev.run(500);
  dev.input.A = false; await dev.run(100);
  await beacons(dev, 800, () => ({ phase: 0 }));
  assert.equal(dev.screen().join('|'), dev.ev('qzFrame(QZ_D_IDLE, 2, 0, 0)').join('|'), 'idle again, old team number');
  await beacons(dev, 600, () => ({ phase: 1, q: 9 }));
  dev.input.B = true; await dev.run(150); dev.input.B = false;
  await beacons(dev, 300, () => ({ phase: 1, q: 9 }));
  assert.equal(dev.ev('qzDMode'), dev.ev('QZ_D_LOCKED'), 'normal play works after leaving test mode');
  assert.equal(dev.ev('qzDA'), 2, 'the answer is B: the key held while leaving was not an answer');
});

test('glue: touching the logo twice quickly counts once (touch bounce)', async () => {
  const dev = makeDevice();
  await join(dev, 0);
  dev.logo(); dev.logo(); await dev.run(200);
  const seen = new Set();
  for (let i = 0; i < 40; i++) await dev.run(25, () => seen.add(dev.screen().join('|')));
  assert.ok(seen.has(BANG(dev)), 'still in test mode');
});
