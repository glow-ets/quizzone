// Runs the REAL base_main.ts (MakeCode glue) on fake MakeCode globals with a virtual clock.
// Covers what the logic tests cannot see: that the main loop never blocks, keeps beaconing while
// serial/radio traffic arrives, forwards packets to the serial port, and drives the LEDs on change only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { srcDir, withChecksum, xorChecksum } from './sim.mjs';

function makeBase() {
  let now = 1000;
  const sleepers = [], fibers = [];
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  const radioOut = [], serialOut = [], ledWrites = [], blocking = [];
  const leds = Array.from({ length: 5 }, () => Array(5).fill(false));
  const handlers = {};
  const g = {
    console,
    Math: Object.assign(Object.create(Math), { idiv: (a, b) => Math.trunc(a / b) }),
    RadioPacketProperty: { SerialNumber: 'sn', SignalStrength: 'rssi' },
    Delimiters: { NewLine: 'nl' },
    control: { millis: () => now, createBuffer: (n) => new Uint8Array(n), inBackground: (fn) => fibers.push(fn) },
    basic: {
      pause: (ms) => new Promise((r) => sleepers.push({ t: now + ms, r })),
      // anything that blocks the loop is a bug on the base: record it
      showString: () => blocking.push('showString'), showLeds: () => blocking.push('showLeds'),
      showIcon: () => blocking.push('showIcon'), showNumber: () => blocking.push('showNumber'),
    },
    radio: {
      setGroup() {}, setFrequencyBand() {}, setTransmitPower() {}, setTransmitSerialNumber() {},
      sendBuffer: (b) => radioOut.push([...b]),
      onReceivedBuffer: (fn) => { handlers.radio = fn; },
      receivedPacket: (p) => (p === 'sn' ? g.__rxSerial : g.__rxRssi),
    },
    serial: {
      redirectToUSB() {}, setRxBufferSize() {}, delimiters: () => 'nl',
      onDataReceived: (d, fn) => { handlers.serial = fn; },
      readUntil: () => g.__line,
      writeString: (s) => serialOut.push(s),
    },
    led: {
      plot: (x, y) => { ledWrites.push(1); leds[y][x] = true; },
      unplot: (x, y) => { ledWrites.push(0); leds[y][x] = false; },
    },
    __rxSerial: 0, __rxRssi: -60, __line: '',
  };
  const ctx = vm.createContext(g);
  vm.runInContext('Math.idiv = function (a, b) { return Math.trunc(a / b); };', ctx);
  for (const f of ['qz_config.ts', 'qz_protocol.ts', 'qz_base.ts', 'base_main.ts']) {
    let code = fs.readFileSync(path.join(srcDir, f), 'utf8');
    if (f === 'base_main.ts') {
      code = code.replace(/basic\.pause\(/g, 'await basic.pause(')
        .replace(/control\.inBackground\(function \(\) \{/g, 'control.inBackground(async function () {');
    }
    vm.runInContext(stripTypeScriptTypes(code), ctx, { filename: f });
  }
  fibers.forEach((fn) => fn());
  return {
    ctx, g, radioOut, serialOut, ledWrites, blocking, leds,
    get now() { return now; },
    screen: () => leds.map((r) => r.map((v) => (v ? '#' : '.')).join('')).join('/'),
    async run(ms) {
      const end = now + ms;
      for (;;) {
        await flush();
        sleepers.sort((a, b) => a.t - b.t);
        if (!sleepers.length || sleepers[0].t > end) break;
        const s = sleepers.shift(); now = Math.max(now, s.t); s.r();
      }
      now = end; await flush();
    },
    serialLine(payload) { g.__line = withChecksum(payload); handlers.serial(); },
    rawLine(line) { g.__line = line; handlers.serial(); },
    radioRx(bytes, serial, rssi = -55) { g.__rxSerial = serial; g.__rxRssi = rssi; handlers.radio(new Uint8Array(bytes)); },
    ev: (code) => vm.runInContext(code, ctx),
  };
}

const stateLine = 'S 1 5 0 300 0 0 0 4';
const teamPacket = (b, o = {}) => b.ev(`qzEncState(Object.assign(new QzMsg(), ${JSON.stringify({ slot: 3, seq: 1, q: 5, ans: 2, elapsed: 1234, flags: 0, fw: 1, presses: 1, bmiss: 0, ...o })}))`);

test('the base never calls a blocking MakeCode display function', async () => {
  const b = makeBase();
  await b.run(3000);
  b.serialLine(stateLine);
  await b.run(3000);
  assert.deepEqual(b.blocking, []);
});

test('beacons keep going at the configured rate under heavy serial and radio traffic', async () => {
  const b = makeBase();
  const beaconMs = b.ev('QZ_BEACON_MS');
  const t0 = b.now;
  for (let i = 0; i < 100; i++) {
    b.serialLine(stateLine);
    b.radioRx(teamPacket(b, { seq: i & 255 }), 0x1000 + (i % 15));
    await b.run(50);
  }
  const elapsed = b.now - t0;
  assert.ok(b.radioOut.length >= Math.floor(elapsed / beaconMs) - 1, `only ${b.radioOut.length} beacons in ${elapsed} ms`);
});

test('a team packet becomes a checksummed T line on the serial port', async () => {
  const b = makeBase();
  await b.run(100);
  b.serialOut.length = 0;
  b.radioRx(teamPacket(b), 0xABCDEF, -48);
  await b.run(20);
  const line = b.serialOut.join('').split('\n').find((l) => l.startsWith('T '));
  assert.ok(line, 'no T line written: ' + JSON.stringify(b.serialOut));
  const [payload, ck] = line.split('*');
  assert.equal(xorChecksum(payload).toString(16).toUpperCase().padStart(2, '0'), ck);
  assert.match(payload, /^T 00ABCDEF -48 3 1 5 2 1234 /);
});

test('A line from the PC becomes an ASSIGN packet; a garbled line is counted, not acted on', async () => {
  const b = makeBase();
  await b.run(100);
  const before = b.radioOut.length;
  b.serialLine('A 01234567 4');
  assert.equal(b.radioOut.length, before + 1);
  const bad = b.ev('qzBase.cBadLine');
  b.rawLine('A 01234567 4*00');
  b.rawLine('garbage');
  assert.equal(b.ev('qzBase.cBadLine'), bad + 2);
  assert.equal(b.radioOut.length, before + 1);
});

test('a burst of team packets in one tick is queued, not lost beyond the documented queue', async () => {
  const b = makeBase();
  await b.run(100);
  b.serialOut.length = 0;
  const max = b.ev('QZ_RXQ_MAX');
  for (let i = 0; i < max; i++) b.radioRx(teamPacket(b, { slot: i + 1, seq: i }), 0x2000 + i);
  await b.run(100);
  const lines = b.serialOut.join('').split('\n').filter((l) => l.startsWith('T '));
  assert.equal(lines.length, max);
});

test('LED: steady Q while the server is alive, alternating with a no-server picture when it is not', async () => {
  const b = makeBase();
  const seen = new Set();
  for (let i = 0; i < 40; i++) { b.serialLine(stateLine); await b.run(100); seen.add(b.screen()); }
  assert.equal(seen.size, 1, 'screen must be steady while the server talks');
  const q = [...seen][0];
  const seen2 = new Set();
  for (let i = 0; i < 40; i++) { await b.run(100); seen2.add(b.screen()); }
  assert.equal(seen2.size, 2, 'no-server must alternate between two pictures');
  assert.ok(seen2.has(q));
});

test('LED driver touches the LEDs only when the picture changes', async () => {
  const b = makeBase();
  for (let i = 0; i < 30; i++) { b.serialLine(stateLine); await b.run(100); }
  const n = b.ledWrites.length;
  for (let i = 0; i < 30; i++) { b.serialLine(stateLine); await b.run(100); }
  assert.equal(b.ledWrites.length, n);
});
