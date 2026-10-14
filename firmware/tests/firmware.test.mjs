// Run:  node --test firmware/tests/        (Node >= 22.18; uses only built-in modules)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { World, SimPc, FW, percentile, withChecksum, parseLine, xorChecksum } from './sim.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const vectors = JSON.parse(fs.readFileSync(path.join(here, '../../protocol/vectors.json'), 'utf8'));
const hexToBytes = (h) => h.match(/../g)?.map((x) => parseInt(x, 16)) ?? [];
const bytesToHex = (b) => b.map((x) => x.toString(16).padStart(2, '0')).join('');

// ---------------------------------------------------------------------------
//  Protocol: golden vectors shared with the Python test suite
// ---------------------------------------------------------------------------
test('protocol: radio golden vectors encode and decode byte-exactly', () => {
  for (const v of vectors.radio) {
    const m = new FW.QzMsg();
    Object.assign(m, Object.fromEntries(Object.entries(v.msg).filter(([k]) => k !== 'type')));
    let enc;
    if (v.msg.type === 1) enc = FW.qzEncState(m);
    else if (v.msg.type === 2) enc = FW.qzEncBeacon(m);
    else enc = FW.qzEncTargeted(v.msg.type, v.msg.target, v.msg.arg);
    assert.equal(bytesToHex(enc), v.hex, `encode ${v.name}`);
    const d = FW.qzDecode(hexToBytes(v.hex));
    assert.ok(d, `decode ${v.name}`);
    for (const [k, val] of Object.entries(v.msg)) assert.equal(d[k], val, `${v.name}.${k}`);
  }
});

test('protocol: malformed radio packets are rejected', () => {
  for (const h of vectors.radio_invalid_hex) assert.equal(FW.qzDecode(hexToBytes(h)), null, `should reject '${h}'`);
});

test('protocol: serial vectors - firmware checksum and parser agree with the independent JS implementation', () => {
  for (const v of vectors.serial) {
    assert.equal(FW.qzAddChecksum(v.payload), v.line);
    assert.equal(FW.qzStripLine(v.line + '\r\n'), v.payload);
    assert.equal(parseLine(v.line), v.payload);
  }
  for (const l of vectors.serial_invalid) assert.equal(FW.qzStripLine(l), null, `should reject '${l}'`);
});

test('protocol: random corruption of a line is always detected (single-byte flips)', () => {
  const line = vectors.serial[2].line;
  let undetected = 0;
  for (let i = 0; i < line.length; i++) {
    for (const c of ['0', 'A', 'z', ' ', '9']) {
      if (line[i] === c) continue;
      const bad = line.slice(0, i) + c + line.slice(i + 1);
      if (FW.qzStripLine(bad) !== null) undetected++;
    }
  }
  assert.equal(undetected, 0);
});

// ---------------------------------------------------------------------------
//  Team logic in isolation (fake HAL, hand-driven clock)
// ---------------------------------------------------------------------------
function mkTeam(nKeys = 5, serial = 0x1234567, t0 = 100000) {
  const log = { sent: [], sounds: [], displays: [] };
  const hal = {
    radioSend: (b) => log.sent.push(FW.qzDecode(b.slice())),
    sound: (id) => log.sounds.push(id),
    display: (m, a, b) => log.displays.push([m, a, b]),
  };
  const team = new FW.QzTeam(hal, serial, nKeys, t0);
  return { team, log };
}
const beacon = (o) => {
  const m = new FW.QzMsg();
  Object.assign(m, { phase: 0, q: 0, elapsed: 0, limit: 300, ack: 0, correct: 0, wrong: 0, flags: 4 << FW.QZ_BF_NANS_SHIFT, bseq: 0 }, o);
  return FW.qzEncBeacon(m);
};
function assignTo(team, slot, now) {
  team.onPacket(FW.qzEncTargeted(3, team.serial, slot), now);
}
// Feed beacons every 100 ms and hold keys for the given duration; returns end time.
function drive(team, from, to, keysAt = {}, beaconFn = null) {
  let seq = 0;
  for (let t = from; t < to; t += 2) {
    if ((t - from) % 100 === 0 && beaconFn) { const b = beaconFn(t, seq++); if (b) team.onPacket(b, t); }
    const down = [false, false, false, false, false];
    for (const [k, [a, b]] of Object.entries(keysAt)) if (t >= a && t < b) down[+k] = true;
    team.onKeys(down, t);
    team.tick(t);
  }
  return to;
}

test('team: first press locks, later presses and other keys are ignored', () => {
  const { team, log } = mkTeam();
  assignTo(team, 3, 100000);
  const open = (t) => beacon({ phase: 1, q: 9, elapsed: t - 100000, limit: 300 });
  drive(team, 100000, 101000, { 1: [100500, 100600], 2: [100800, 100900] }, open);
  assert.equal(team.ans, 2, 'first press (key index 1 => answer B=2) wins');
  assert.equal(log.sent.filter((m) => m.ans === 2).length > 0, true);
  assert.equal(log.sent.filter((m) => m.ans === 3).length, 0, 'second key never reported');
});

test('team: elapsed is measured from the press edge, relative to the beacon time base', () => {
  const { team } = mkTeam();
  assignTo(team, 0, 100000);
  const open = (t) => beacon({ phase: 1, q: 1, elapsed: t - 100000 });
  drive(team, 100000, 100800, { 0: [100500, 100700] }, open);
  assert.ok(Math.abs(team.ansElapsed - 500) <= 3, `elapsed ${team.ansElapsed}`);
});

test('team: contact bounce (chatter < debounce time) produces exactly one lock', () => {
  const { team, log } = mkTeam();
  assignTo(team, 0, 100000);
  const open = (t) => beacon({ phase: 1, q: 1, elapsed: t - 100000 });
  let seq = 0;
  // key chatters: down 3ms / up 2ms / down 3ms / up 2ms ... then stays down
  for (let t = 100000; t < 100800; t += 2) {
    if ((t - 100000) % 100 === 0) team.onPacket(open(t), t);
    let down = false;
    if (t >= 100400 && t < 100420) down = (Math.floor((t - 100400) / 2) % 2) === 0 ? true : (Math.floor((t - 100400) / 2) % 5 < 2);
    if (t >= 100420 && t < 100700) down = true;
    team.onKeys([down, false, false, false, false], t);
    team.tick(t);
  }
  assert.equal(log.sounds.filter((s) => s === FW.QZ_S_LOCK).length, 1);
  assert.equal(team.ans, 1);
});

test('team: electrical glitches shorter than the debounce time never lock an answer', () => {
  const { team, log } = mkTeam();
  assignTo(team, 0, 100000);
  const open = (t) => beacon({ phase: 1, q: 1, elapsed: t - 100000 });
  // 20 isolated 4 ms spikes on key C (index 2), spread over the question
  const spikes = {};
  for (let i = 0; i < 20; i++) spikes[100100 + i * 37] = true;
  for (let t = 100000; t < 100900; t += 2) {
    if ((t - 100000) % 100 === 0) team.onPacket(open(t), t);
    let down = false;
    for (const s0 of Object.keys(spikes)) if (t >= +s0 && t < +s0 + 4) down = true;
    team.onKeys([false, false, down, false, false], t);
    team.tick(t);
  }
  assert.equal(team.isLocked(), false);
  assert.equal(team.presses, 0, 'glitches are not counted as presses');
  // a real press afterwards still works
  drive(team, 100900, 101300, { 2: [101000, 101200] }, (t) => open(t));
  assert.equal(team.ans, 3);
});

test('team: two keys in the same poll => lowest index wins (deterministic)', () => {
  const { team } = mkTeam();
  assignTo(team, 0, 100000);
  const open = (t) => beacon({ phase: 1, q: 1, elapsed: t - 100000 });
  drive(team, 100000, 100800, { 3: [100400, 100600], 1: [100400, 100600] }, open);
  assert.equal(team.ans, 2);
});

test('team: a key held down when the question opens does not count until released and pressed again', () => {
  const { team } = mkTeam();
  assignTo(team, 0, 100000);
  const open = (t) => beacon({ phase: t < 100300 ? 0 : 1, q: 1, elapsed: Math.max(0, t - 100300) });
  drive(team, 100000, 100900, { 0: [100000, 100900] }, open);
  assert.equal(team.isLocked(), false);
});

test('team: invalid key (E on a 4-answer question) beeps and does not lock', () => {
  const { team, log } = mkTeam();
  assignTo(team, 0, 100000);
  const open = (t) => beacon({ phase: 1, q: 1, elapsed: t - 100000, flags: 4 << FW.QZ_BF_NANS_SHIFT });
  drive(team, 100000, 100700, { 4: [100300, 100450] }, open);
  assert.equal(team.isLocked(), false);
  assert.ok(log.sounds.includes(FW.QZ_S_INVALID));
  // and a valid key afterwards still works
  drive(team, 100700, 101200, { 0: [100900, 101000] }, (t) => open(t));
  assert.equal(team.ans, 1);
});

test('team: presses are ignored when closed, idle, unassigned or when the beacon is stale', () => {
  const { team } = mkTeam();
  // unassigned
  drive(team, 100000, 100400, { 0: [100100, 100300] }, (t) => beacon({ phase: 1, q: 1, elapsed: t - 100000 }));
  assert.equal(team.isLocked(), false, 'unassigned device must not lock');
  assignTo(team, 0, 100400);
  // closed
  drive(team, 100400, 100900, { 0: [100500, 100700] }, (t) => beacon({ phase: 2, q: 1, elapsed: 30000 }));
  assert.equal(team.isLocked(), false, 'closed');
  // OPEN once, then the radio goes silent: after QZ_STALE_MS presses must be ignored
  drive(team, 100900, 101000, {}, (t) => beacon({ phase: 1, q: 2, elapsed: 0 }));
  drive(team, 101000, 103500, { 0: [102800, 103000] }, () => null);
  assert.equal(team.isLocked(), false, 'stale beacon');
});

test('team: a press after the local time limit is refused (beep), one just before it locks', () => {
  for (const [pressAt, expectLock] of [[100050, true], [100300, false]]) {
    const { team, log } = mkTeam();
    assignTo(team, 0, 100000);
    // limit 3 s; the beacon says 2.9 s have elapsed at t=100000, and keeps being refreshed
    drive(team, 100000, 100600, { 0: [pressAt, pressAt + 100] }, (t) => beacon({ phase: 1, q: 4, elapsed: 2900 + (t - 100000), limit: 30 }));
    assert.equal(team.isLocked(), expectLock, `press at +${pressAt - 100000} ms`);
    if (!expectLock) assert.ok(log.sounds.includes(FW.QZ_S_INVALID), 'refused press gives the "invalid" sound');
  }
});

test('team: a new question number clears the previous answer; counter wrap-around is safe', () => {
  const { team } = mkTeam();
  assignTo(team, 0, 100000);
  drive(team, 100000, 100600, { 0: [100200, 100300] }, (t) => beacon({ phase: 1, q: 255, elapsed: t - 100000 }));
  assert.equal(team.ans, 1);
  drive(team, 100600, 100800, {}, (t) => beacon({ phase: 1, q: 1, elapsed: 0 }));
  assert.equal(team.isLocked(), false, 'q 255 -> 1');
  drive(team, 100800, 101200, { 1: [100900, 101000] }, (t) => beacon({ phase: 1, q: 1, elapsed: t - 100800 }));
  assert.equal(team.ans, 2);
});

test('team: result sounds follow the reveal masks', () => {
  for (const [slot, correct, wrong, want] of [[2, 4, 0, FW.QZ_S_CORRECT], [2, 0, 4, FW.QZ_S_WRONG], [2, 1, 2, null]]) {
    const { team, log } = mkTeam();
    assignTo(team, slot, 100000);
    drive(team, 100000, 100500, {}, () => beacon({ phase: 3, q: 4, elapsed: 30000, correct, wrong }));
    if (want === null) assert.equal(log.sounds.filter((s) => s === FW.QZ_S_CORRECT || s === FW.QZ_S_WRONG).length, 0);
    else assert.equal(log.sounds.filter((s) => s === want).length, 1, 'played exactly once');
  }
});

test('team: reports its state after the phase changes to CLOSED (needed for server settling)', () => {
  const { team, log } = mkTeam();
  assignTo(team, 5, 100000);
  drive(team, 100000, 100600, {}, (t) => beacon({ phase: 1, q: 3, elapsed: t - 100000 }));
  log.sent.length = 0;
  drive(team, 100600, 101000, {}, () => beacon({ phase: 2, q: 3, elapsed: 30000 }));
  const rep = log.sent.find((m) => ((m.flags >> 2) & 7) === FW.QZ_PH_CLOSED);
  assert.ok(rep, 'a STATE with phase-seen=CLOSED must be sent within 300 ms of the CLOSED beacon');
});

test('team: rng is different for different serials (retry jitter is not synchronised)', () => {
  const seqs = new Set();
  for (let s = 1; s <= 15; s++) {
    const { team } = mkTeam(5, s * 7919 + 13);
    seqs.add([0, 1, 2, 3].map(() => team.rnd(0, 400)).join(','));
  }
  assert.ok(seqs.size >= 14, `distinct jitter sequences: ${seqs.size}`);
  const { team } = mkTeam();
  for (let i = 0; i < 10000; i++) { const v = team.rnd(50, 150); assert.ok(v >= 50 && v <= 150); }
});

// ---------------------------------------------------------------------------
//  Whole system in the virtual radio world (real firmware logic, real timing model)
// ---------------------------------------------------------------------------
function boot({ n = 15, seed = 1, world = {}, pcOpts = {}, settleMs = 5000 } = {}) {
  const w = new World({ seed, ...world });
  const pc = new SimPc(w, { limitMs: 30000, nAns: 4, ...pcOpts });
  const base = w.addBase(pc);
  const teams = [];
  for (let i = 0; i < n; i++) teams.push(w.addTeam(5));
  w.runFor(settleMs);
  return { w, pc, base, teams };
}
const ackTime = (d) => d.sounds.find((s) => s.id === FW.QZ_S_ACK)?.t;

test('system: 15 fresh devices get distinct slots from the PC within 5 s', () => {
  for (let seed = 1; seed <= 10; seed++) {
    const { teams } = boot({ seed });
    const slots = teams.map((t) => t.logic.slot);
    assert.equal(new Set(slots).size, 15, `seed ${seed}: ${slots}`);
    assert.ok(slots.every((s) => s >= 0 && s < 15));
  }
});

test('system: answers pressed at random times are delivered exactly once with accurate elapsed time', () => {
  const { w, pc, teams } = boot({ seed: 3 });
  pc.open(1);
  const openT = w.t;
  const truth = new Map();
  teams.forEach((t, i) => {
    const at = openT + (1000 + Math.floor(w.rand() * 20000)) * 1000;
    t.press(i % 4, at);
    truth.set(t.logic.slot, (at - openT) / 1000);
  });
  w.runFor(25000);
  assert.equal(pc.answers.size, 15);
  const errs = [...pc.answers.entries()].map(([slot, a]) => a.elapsed - truth.get(slot));
  // measured: always a few ms early (beacon handler latency + serial delay), never late
  assert.ok(Math.max(...errs.map(Math.abs)) <= 15, `elapsed errors ms: ${errs.map((e) => e.toFixed(1))}`);
  assert.ok(teams.every((t) => t.logic.acked), 'every device saw its acknowledgement');
});

test('system: WORST CASE - all 15 teams press at the same microsecond (clean channel, 40 seeds)', () => {
  const lat = [];
  let collisions = 0, qdrops = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const { w, pc, teams } = boot({ seed });
    pc.open(seed);
    w.runFor(300);
    const T = w.t + 500000;
    teams.forEach((t, i) => t.press(i % 4, T));
    w.runFor(4000);
    assert.equal(pc.answers.size, 15, `seed ${seed}: only ${pc.answers.size}/15 answers arrived`);
    for (const a of pc.answers.values()) lat.push((a.atUs - T) / 1000);
    collisions += w.stats.collided;
    qdrops += w.stats.queueDrop;
    assert.ok(teams.every((t) => t.logic.acked), `seed ${seed}: unacked devices`);
  }
  const p99 = percentile(lat, 0.99), max = Math.max(...lat);
  console.log(`      simultaneous presses: server receive latency p50=${percentile(lat, .5).toFixed(0)} ms p99=${p99.toFixed(0)} ms max=${max.toFixed(0)} ms; collided transmissions over 40 runs: ${collisions}; hw-queue drops: ${qdrops}`);
  assert.ok(max < 1500, `max latency ${max}`);
});

test('system: 30% random packet loss in both directions - everything still delivered (40 seeds)', () => {
  const lat = [];
  for (let seed = 1; seed <= 40; seed++) {
    const { w, pc, teams } = boot({ seed, world: { lossProb: 0.3 }, settleMs: 12000 });
    pc.open(seed);
    w.runFor(500);
    const T = w.t + 300000;
    teams.forEach((t, i) => t.press(i % 4, T + i * 1000));
    w.runFor(8000);
    assert.equal(pc.answers.size, 15, `seed ${seed}: ${pc.answers.size}/15`);
    for (const a of pc.answers.values()) lat.push((a.atUs - T) / 1000);
  }
  console.log(`      30% loss: latency p50=${percentile(lat, .5).toFixed(0)} ms p99=${percentile(lat, .99).toFixed(0)} ms max=${Math.max(...lat).toFixed(0)} ms`);
  assert.ok(Math.max(...lat) < 6000);
});

test('system: 1.5 s radio blackout right after the presses - answers arrive after it ends', () => {
  const { w, pc, teams } = boot({ seed: 11 });
  pc.open(1);
  w.runFor(300);
  const T = w.t + 200000;
  teams.forEach((t, i) => t.press(i % 4, T));
  w.addJam(w.nowMs + 150, w.nowMs + 1650, 1);
  w.runFor(6000);
  assert.equal(pc.answers.size, 15);
  const maxLat = Math.max(...[...pc.answers.values()].map((a) => (a.atUs - T) / 1000));
  assert.ok(maxLat > 1400, 'answers cannot have arrived during the blackout');
  assert.ok(maxLat < 3500, `recovered in ${maxLat} ms`);
  // and elapsed times are still those of the real presses, not of the delivery
  for (const a of pc.answers.values()) assert.ok(a.elapsed < 1000, `elapsed ${a.elapsed}`);
});

test('system: stress-test mode - all devices answer on the very first OPEN beacon (40 seeds)', () => {
  const lat = [];
  for (let seed = 1; seed <= 40; seed++) {
    const { w, pc } = boot({ seed });
    const T = w.t;
    pc.open(5, true);
    w.runFor(5000);
    assert.equal(pc.answers.size, 15, `seed ${seed}: ${pc.answers.size}/15`);
    for (const a of pc.answers.values()) lat.push((a.atUs - T) / 1000);
  }
  console.log(`      test blast: latency p50=${percentile(lat, .5).toFixed(0)} ms p99=${percentile(lat, .99).toFixed(0)} ms max=${Math.max(...lat).toFixed(0)} ms`);
  assert.ok(Math.max(...lat) < 2500);
});

test('system: 50% of beacons lost - devices still sync, answer and get acknowledged', () => {
  const { w, pc, teams } = boot({ seed: 5, world: { lossProb: 0.5 }, settleMs: 15000 });
  pc.open(2);
  w.runFor(1500);
  const T = w.t + 100000;
  teams.forEach((t, i) => t.press(i % 4, T));
  w.runFor(15000);
  assert.equal(pc.answers.size, 15);
  assert.ok(teams.every((t) => t.logic.acked));
  assert.ok(teams.some((t) => t.logic.bmiss > 0), 'downlink loss is counted in bmiss');
});

test('system: PC goes silent mid-question - base declares OFFLINE, devices show NOLINK and ignore presses', () => {
  const { w, pc, teams, base } = boot({ seed: 2 });
  pc.open(1);
  w.runFor(1000);
  pc.sendState = () => {};                          // PC crashed
  w.runFor(FW.QZ_SERVER_TIMEOUT_MS + 500);
  assert.equal(base.logic.serverAlive(base.deviceMs()), false);
  w.runFor(3000);
  assert.ok(teams.every((t) => t.displays[t.displays.length - 1].mode === FW.QZ_D_NOLINK), 'all devices show no-link');
  teams[0].press(0, w.t + 1000);
  w.runFor(1000);
  assert.equal(teams[0].logic.isLocked(), false);
});

test('system: base keeps its beacon cadence under a serial-line flood and radio flood', () => {
  const { w, pc, base, teams } = boot({ seed: 4 });
  const n0 = base.beaconTimes.length;
  // 20 s of every team answering 40 times a second (a firmware bug / malicious device scenario)
  const flood = () => teams.forEach((t) => { t.logic.txAttempts = 0; t.logic.nextTx = 0; });
  for (let ms = 0; ms < 20000; ms += 25) w.after(ms * 1000, flood);
  w.runFor(20500);
  const times = base.beaconTimes.slice(n0);
  const gaps = times.slice(1).map((t, i) => (t - times[i]) / 1000);
  const p99 = percentile(gaps, 0.99), max = Math.max(...gaps);
  console.log(`      flood: beacon gap p99=${p99.toFixed(1)} ms max=${max.toFixed(1)} ms; queue drops(hw)=${base.hwDrops} sw overflow=${base.logic.cOverflow}`);
  assert.ok(max < 300, `beacon starved: max gap ${max} ms`);
  assert.ok(times.length > 150, `beacons sent: ${times.length}`);
});

test('system: garbage and foreign packets are ignored and counted, never crash', () => {
  const { w, base } = boot({ seed: 6, n: 2 });
  const rnd = w.rand;
  for (let i = 0; i < 500; i++) {
    const len = Math.floor(rnd() * 25);
    const bytes = Array.from({ length: len }, () => Math.floor(rnd() * 256));
    if (i % 3 === 0 && len > 2) { bytes[0] = FW.QZ_MAGIC; bytes[1] = 1 + Math.floor(rnd() * 5); }
    base.logic.onRadio(bytes, 0, -70, base.deviceMs());
  }
  for (const l of ['', 'S', 'S 1 2 3*00', 'S 9 9 9 9 9 9 9 9*00', '\x00\x01\x02', 'A zz 1*00', 'P*50\n']) base.logic.onSerialLine(l, base.deviceMs());
  w.runFor(1000);
  assert.ok(base.logic.cForeign + base.logic.cRxOk >= 400);
});

test('system: ack mask matches exactly the slots whose answers the PC accepted', () => {
  const { w, pc, teams } = boot({ seed: 8 });
  pc.open(3);
  w.runFor(300);
  [0, 2, 4, 6, 8, 10, 12, 14].forEach((i) => teams[i].press(1, w.t + 200000));
  w.runFor(4000);
  const pressed = new Set([0, 2, 4, 6, 8, 10, 12, 14].map((i) => teams[i].logic.slot));
  for (const t of teams) assert.equal(t.logic.acked, pressed.has(t.logic.slot));
});

test('system: base hardware queue (4 packets) overflows when 15 non-colliding packets arrive within a scheduler tick - and the protocol recovers', () => {
  let totalDrops = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const { w, pc, base, teams } = boot({ seed });
    pc.open(seed);
    w.runFor(300);
    const T = w.t + 100000;
    // packets spaced 450 us apart: they do not overlap on air, so none is lost to collisions,
    // but 15 of them arrive inside the receive handler's 0..6 ms scheduling latency.
    teams.forEach((t, i) => w.at(T + i * 450, () => t.logic.lockAnswer(1 + (i % 4), t.deviceMs(), t.deviceMs())));
    w.runFor(4000);
    totalDrops += base.hwDrops;
    assert.equal(pc.answers.size, 15, `seed ${seed}: ${pc.answers.size}/15 after queue overflow`);
  }
  console.log(`      forced overflow: base hardware-queue drops over 20 runs = ${totalDrops} (recovered by retransmission each time)`);
  assert.ok(totalDrops > 0, 'the scenario must actually overflow the 4-deep queue, otherwise it tests nothing');
});
