// =============================================================================
//  Virtual-time micro:bit radio world used to test the REAL firmware logic
//  (firmware/src/qz_*.ts, loaded unmodified) under adverse conditions.
//
//  What is modelled (each item is grounded in the codal/pxt source, see
//  protocol/PROTOCOL.md "Hardware facts"):
//    * no carrier sense: transmissions that overlap in time destroy each other
//    * half duplex: a device that is transmitting hears nothing
//    * receive hardware queue of 4 packets; extra packets are silently dropped
//    * the receive handler runs up to a scheduler tick (6 ms) after reception
//    * blocking serial write (115200 baud, 10 bits/byte) stalls the base loop
//    * independent clocks with offset and +-50 ppm drift on every device
//  What is NOT modelled (cannot be known without hardware): real RF behaviour
//  (capture effect, fading, interference). Loss is injected as a parameter.
// =============================================================================
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const srcDir = path.resolve(here, '../src');

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Load firmware files into one shared global scope, like a MakeCode project does.
export function loadFirmware(files, extraExports) {
  const ctx = vm.createContext({ console });
  vm.runInContext('Math.idiv = function (a, b) { return Math.trunc(a / b); };', ctx);
  for (const f of files) {
    const code = stripTypeScriptTypes(fs.readFileSync(path.join(srcDir, f), 'utf8'));
    vm.runInContext(code, ctx, { filename: f });
  }
  return vm.runInContext(`({${extraExports}})`, ctx);
}

export const TEAM_FILES = ['qz_config.ts', 'qz_protocol.ts', 'qz_team.ts', 'qz_display.ts'];
export const BASE_FILES = ['qz_config.ts', 'qz_protocol.ts', 'qz_base.ts'];
const EXPORTS = 'QzTeam, QzBase, QzMsg, qzEncState, qzEncBeacon, qzEncTargeted, qzDecode, qzChecksum, qzAddChecksum, ' +
  'qzStripLine, qzHex8, qzParseHex32, QZ_MAGIC, QZ_T_STATE, QZ_T_BEACON, QZ_PH_IDLE, QZ_PH_OPEN, QZ_PH_CLOSED, ' +
  'QZ_PH_REVEAL, QZ_PH_OFFLINE, QZ_UNASSIGNED, QZ_BF_TEST, QZ_BF_NANS_SHIFT, QZ_SF_LOCKED, QZ_SF_ACKED, ' +
  'QZ_D_UNASSIGNED, QZ_D_IDLE, QZ_D_WAIT, QZ_D_LOCKED, QZ_D_CLOSED, QZ_D_RESULT, QZ_D_NOLINK, QZ_D_IDENT, QZ_D_LOCAL, QzLocalTest, QZ_ICON_BANG, QZ_LOCAL_BLINK_MS, QZ_LOCAL_HOLD_MS, ' +
  'qzFrame, QZ_LETTERS, QZ_BLANK, QZ_FULL, QZ_ICON_CHECK, QZ_ICON_CROSS, QZ_ICON_DASH, QZ_ICON_QUESTION, QZ_ICON_NOLINK, ' +
  'QZ_BLINK_PERIOD_MS, QZ_IDENT_STEP_MS, QZ_IDENT_STEPS, QZ_S_LOCK, QZ_S_ACK, QZ_S_INVALID, QZ_S_CORRECT, QZ_S_WRONG, QZ_BEACON_MS, QZ_DEBOUNCE_MS, QZ_SERVER_TIMEOUT_MS';
export const FW = loadFirmware([...new Set([...TEAM_FILES, ...BASE_FILES])], EXPORTS);

class Heap {
  constructor() { this.a = []; this.n = 0; }
  push(t, fn) {
    const it = { t, n: this.n++, fn };
    const a = this.a; a.push(it);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (this.less(a[i], a[p])) { [a[i], a[p]] = [a[p], a[i]]; i = p; } else break; }
  }
  less(x, y) { return x.t < y.t || (x.t === y.t && x.n < y.n); }
  pop() {
    const a = this.a; if (!a.length) return null;
    const top = a[0]; const last = a.pop();
    if (a.length) { a[0] = last; let i = 0; for (;;) { let l = 2 * i + 1, r = l + 1, m = i;
      if (l < a.length && this.less(a[l], a[m])) m = l; if (r < a.length && this.less(a[r], a[m])) m = r;
      if (m === i) break; [a[i], a[m]] = [a[m], a[i]]; i = m; } }
    return top;
  }
  get size() { return this.a.length; }
}

export class World {
  constructor(opts = {}) {
    this.o = Object.assign({
      seed: 1, airtimeUs: 350, lossProb: 0, rxLatencyMaxUs: 6000, hwQueue: 4,
      usbLatencyUs: [1000, 3000], baud: 115200,
    }, opts);
    this.rand = mulberry32(this.o.seed);
    this.t = 0;
    this.q = new Heap();
    this.devices = [];
    this.recentTx = [];
    this.jam = [];                 // [{from, to, loss}] windows of heavy loss (microseconds)
    this.stats = { tx: 0, collided: 0, halfDuplex: 0, queueDrop: 0, randomLoss: 0, delivered: 0 };
  }
  at(tUs, fn) { this.q.push(Math.max(tUs, this.t), fn); }
  after(dUs, fn) { this.at(this.t + dUs, fn); }
  run(untilUs) {
    for (;;) {
      const top = this.q.a[0];
      if (!top || top.t > untilUs) break;
      this.q.pop(); this.t = top.t; top.fn();
    }
    this.t = untilUs;
  }
  runFor(ms) { this.run(this.t + ms * 1000); }
  get nowMs() { return this.t / 1000; }
  between(lo, hi) { return lo + this.rand() * (hi - lo); }

  addJam(fromMs, toMs, loss = 1) { this.jam.push({ from: fromMs * 1000, to: toMs * 1000, loss }); }

  // ---- radio medium -------------------------------------------------------
  transmit(sender, bytes) {
    const start = this.t, end = start + this.o.airtimeUs;
    const tx = { start, end, sender, bytes: bytes.slice(), collided: false };
    sender.txBusyUntil = end;
    sender.txIntervals.push([start, end]);
    this.stats.tx++;
    for (const o of this.recentTx) if (o.end > start && o.start < end) { o.collided = true; tx.collided = true; }
    this.recentTx.push(tx);
    this.at(end, () => this.deliver(tx));
  }
  deliver(tx) {
    this.recentTx = this.recentTx.filter((o) => o.end > this.t - 5000);
    if (tx.collided) this.stats.collided++;
    for (const r of this.devices) {
      if (r === tx.sender || !r.rxEnabled) continue;
      if (tx.collided) continue;
      if (r.txIntervals.some(([s, e]) => e > tx.start && s < tx.end)) { this.stats.halfDuplex++; continue; }
      let loss = this.o.lossProb;
      for (const j of this.jam) if (tx.start >= j.from && tx.start < j.to) loss = Math.max(loss, j.loss);
      if (this.rand() < loss) { this.stats.randomLoss++; continue; }
      if (r.hwq.length >= this.o.hwQueue) { this.stats.queueDrop++; r.hwDrops++; continue; }
      r.hwq.push({ bytes: tx.bytes.slice(), serial: tx.sender.txSerial ? tx.sender.serial : 0, rssi: -50 - Math.floor(this.rand() * 30) });
      this.stats.delivered++;
      if (!r.handlerScheduled) {
        r.handlerScheduled = true;
        this.after(this.between(0, this.o.rxLatencyMaxUs), () => {
          r.handlerScheduled = false;
          while (r.hwq.length) { const p = r.hwq.shift(); r.onRadio(p); }
        });
      }
    }
    // keep per-device tx interval lists short
    tx.sender.txIntervals = tx.sender.txIntervals.filter(([, e]) => e > this.t - 5000);
  }

  newDevice(kind) {
    const d = {
      kind, serial: (this.rand() * 4294967296) | 0, rxEnabled: true, txSerial: kind === 'team',
      hwq: [], hwDrops: 0, handlerScheduled: false, txIntervals: [], txBusyUntil: 0,
      clockOffsetUs: Math.floor(this.rand() * 1e9), driftPpm: (this.rand() - 0.5) * 100,
      deviceMs: () => Math.floor((this.t * (1 + d.driftPpm * 1e-6) + d.clockOffsetUs) / 1000) | 0,
    };
    this.devices.push(d);
    return d;
  }

  // ---- team device ---------------------------------------------------------
  addTeam(nKeys = 5) {
    const w = this;
    const d = this.newDevice('team');
    d.sounds = []; d.displays = []; d.sent = []; d.keys = new Array(nKeys).fill(false);
    const hal = {
      radioSend(bytes) { d.sent.push({ t: w.t, bytes: bytes.slice() }); w.transmit(d, bytes); },
      sound(id) { d.sounds.push({ t: w.t, id }); },
      display(mode, a, b) { d.displays.push({ t: w.t, mode, a, b }); },
    };
    d.logic = new FW.QzTeam(hal, d.serial, nKeys, d.deviceMs());
    d.onRadio = (p) => d.logic.onPacket(p.bytes, d.deviceMs());
    // 2 ms main loop with a random phase, like the basic.pause(2) loop in team_main.ts
    const loop = () => {
      const now = d.deviceMs();
      d.logic.onKeys(d.keys.slice(), now);
      d.logic.tick(now);
      w.after(2000, loop);
    };
    this.after(this.between(0, 2000), loop);
    d.setKey = (k, v) => { d.keys[k] = v; };
    // press key k (0-based) at absolute time tUs, with optional contact bounce
    d.press = (k, tUs, holdMs = 120, bounce = true) => {
      let t = tUs;
      w.at(t, () => d.setKey(k, true));
      if (bounce) {
        const n = 1 + Math.floor(w.rand() * 4);
        for (let i = 0; i < n; i++) {
          t += w.between(100, 900); w.at(t, () => d.setKey(k, false));
          t += w.between(100, 900); w.at(t, () => d.setKey(k, true));
        }
      }
      w.at(tUs + holdMs * 1000, () => d.setKey(k, false));
    };
    return d;
  }

  // ---- base station + PC link ----------------------------------------------
  addBase(pc) {
    const w = this;
    const d = this.newDevice('base');
    d.beaconTimes = []; d.serialBytes = 0;
    d.blockedUntil = 0;
    const hal = {
      radioSend(bytes) {
        if (bytes[1] === FW.QZ_T_BEACON) d.beaconTimes.push(w.t);
        w.transmit(d, bytes);
        d.blockedUntil = Math.max(d.blockedUntil, w.t) + w.o.airtimeUs;   // send() busy-waits
      },
      serialWrite(text) {
        const dur = text.length * 10 / w.o.baud * 1e6;
        d.serialBytes += text.length;
        const arrive = Math.max(d.blockedUntil, w.t) + dur + w.between(...w.o.usbLatencyUs);
        d.blockedUntil = Math.max(d.blockedUntil, w.t) + dur;             // blocking write
        const line = text;
        w.at(arrive, () => pc.onLineFromBase(line));
      },
    };
    d.logic = new FW.QzBase(hal, d.deviceMs());
    d.onRadio = (p) => d.logic.onRadio(p.bytes, p.serial, p.rssi, d.deviceMs());
    d.sendFromPc = (line) => {          // PC -> base serial
      const dur = line.length * 10 / w.o.baud * 1e6;
      w.after(dur + w.between(...w.o.usbLatencyUs), () => d.logic.onSerialLine(line, d.deviceMs()));
    };
    const loop = () => {
      const now = d.deviceMs();
      d.logic.tick(now);
      w.at(Math.max(w.t + 1000, d.blockedUntil), loop);                   // basic.pause(1)
    };
    this.after(0, loop);
    pc.attach(d);
    return d;
  }
}

// Independent (JS) implementation of the line checksum, so the firmware's own
// qzChecksum is cross-checked rather than trusted.
export function xorChecksum(s) { let c = 0; for (let i = 0; i < s.length; i++) c ^= s.charCodeAt(i); return c; }
export function withChecksum(payload) { return payload + '*' + xorChecksum(payload).toString(16).toUpperCase().padStart(2, '0'); }
export function parseLine(line) {
  const l = line.replace(/[\r\n ]+$/, '');
  const m = /^(.*)\*([0-9A-F]{2})$/.exec(l);
  if (!m || xorChecksum(m[1]) !== parseInt(m[2], 16)) return null;
  return m[1];
}

// Minimal PC-side model: enough of the real server's behaviour (accept first
// valid answer per slot, ack mask, state line every 250 ms) to exercise the firmware.
// The real engine lives in server/quizzone/engine.py and has its own tests.
export class SimPc {
  constructor(world, opts = {}) {
    this.w = world;
    this.o = Object.assign({ limitMs: 30000, nAns: 4, stateEveryMs: 250 }, opts);
    this.phase = 0; this.q = 0; this.openedAt = 0; this.flags = 0;
    this.ack = 0; this.correct = 0; this.wrong = 0;
    this.answers = new Map();     // slot -> {ans, elapsed, atUs, serial}
    this.seen = new Map();        // serial -> {slot, lastSeq, count, gaps, lastAt, lastLine}
    this.badLines = 0; this.hello = null; this.base = null;
    this.rxLog = [];
    this.assign = new Map();      // serial -> slot (auto-assignment in order of first sight)
    this.lastAssignSent = new Map();
    this.nextSlot = 0;
    this.autoAssign = true;
  }
  attach(base) {
    this.base = base;
    const loop = () => { this.sendState(); this.w.after(this.o.stateEveryMs * 1000, loop); };
    this.w.after(1000, loop);
  }
  flagsByte() { return ((this.o.nAns & 7) << 2) | (this.testMode ? 1 : 0); }
  sendState() {
    const el = this.phase === 1 ? Math.floor((this.w.t - this.openedAt) / 1000) : this.frozenElapsed || 0;
    this.base.sendFromPc(withChecksum(`S ${this.phase} ${this.q} ${el} ${this.o.limitMs} ${this.ack} ${this.correct} ${this.wrong} ${this.flagsByte()}`) + '\n');
  }
  open(q, testMode = false) {
    this.q = q; this.phase = 1; this.openedAt = this.w.t; this.ack = 0; this.answers.clear();
    this.testMode = testMode; this.correct = 0; this.wrong = 0; this.frozenElapsed = 0;
    this.sendState();
  }
  close() { this.frozenElapsed = Math.floor((this.w.t - this.openedAt) / 1000); this.phase = 2; this.sendState(); }
  reveal(correctMask, wrongMask) { this.phase = 3; this.correct = correctMask; this.wrong = wrongMask; this.sendState(); }
  idle() { this.phase = 0; this.sendState(); }
  onLineFromBase(text) {
    const p = parseLine(text);
    if (p === null) { this.badLines++; return; }
    const f = p.split(' ');
    if (f[0] === 'H') { this.hello = f.slice(1).map(Number); return; }
    if (f[0] !== 'T') return;
    const [, ser, rssi, slot, seq, q, ans, elapsed, flags, fw, presses, bmiss, tb] = f;
    const serial = parseInt(ser, 16) | 0;
    const rec = { serial, rssi: +rssi, slot: +slot, seq: +seq, q: +q, ans: +ans, elapsed: +elapsed, flags: +flags,
      fw: +fw, presses: +presses, bmiss: +bmiss, atUs: this.w.t };
    this.rxLog.push(rec);
    let s = this.seen.get(serial);
    if (!s) { s = { slot: rec.slot, lastSeq: -1, count: 0, gaps: 0 }; this.seen.set(serial, s); }
    if (s.lastSeq >= 0) s.gaps += ((rec.seq - s.lastSeq - 1) & 255) < 128 ? ((rec.seq - s.lastSeq - 1) & 255) : 0;
    s.lastSeq = rec.seq; s.count++; s.lastAt = this.w.t; s.slot = rec.slot;
    if (this.autoAssign) {
      if (!this.assign.has(serial)) this.assign.set(serial, this.nextSlot++);
      const want = this.assign.get(serial);
      if (rec.slot !== want && this.w.t - (this.lastAssignSent.get(serial) || -1e12) > 300000) {
        this.lastAssignSent.set(serial, this.w.t);
        this.base.sendFromPc(withChecksum(`A ${FW.qzHex8(serial)} ${want}`) + '\n');
      }
    }
    if (rec.slot === FW.QZ_UNASSIGNED) return;
    if (this.phase >= 1 && this.phase <= 2 && rec.q === this.q && rec.ans >= 1 && rec.ans <= this.o.nAns
        && rec.elapsed <= this.o.limitMs + 300) {
      const prev = this.answers.get(rec.slot);
      if (!prev || rec.elapsed < prev.elapsed) {
        this.answers.set(rec.slot, { ans: rec.ans, elapsed: rec.elapsed, atUs: this.w.t, serial });
      }
      if (!(this.ack & (1 << rec.slot))) { this.ack |= (1 << rec.slot); this.sendState(); }
    }
  }
}

export function percentile(arr, p) {
  if (!arr.length) return NaN;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}
