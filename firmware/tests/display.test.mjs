// What the team actually SEES. The pure frame function plus the full-system outcome of the display state.
// Regression for the "letter blinks forever after the base confirmed it" bug.
import test from 'node:test';
import assert from 'node:assert/strict';
import { World, SimPc, FW } from './sim.mjs';

const MODES = [FW.QZ_D_UNASSIGNED, FW.QZ_D_IDLE, FW.QZ_D_WAIT, FW.QZ_D_LOCKED, FW.QZ_D_CLOSED, FW.QZ_D_RESULT, FW.QZ_D_NOLINK, FW.QZ_D_IDENT];
const validFrame = (f) => Array.isArray(f) && f.length === 5 && f.every((r) => typeof r === 'string' && /^[#.]{5}$/.test(r));
const same = (a, b) => a.join('|') === b.join('|');

test('display: every state at every time yields a well-formed 5x5 picture', () => {
  for (const mode of MODES) for (let a = 0; a <= 25; a++) for (const b of [0, 1]) for (let t = 0; t < 2000; t += 37) {
    assert.ok(validFrame(FW.qzFrame(mode, a, b, t)), `mode ${mode} a ${a} b ${b} t ${t}`);
  }
});

test('display: locked + not confirmed blinks; locked + confirmed is steady (all letters)', () => {
  for (let ans = 1; ans <= 5; ans++) {
    const letter = FW.QZ_LETTERS[ans - 1];
    const seen = new Set();
    for (let t = 0; t < 2000; t++) seen.add(FW.qzFrame(FW.QZ_D_LOCKED, ans, 0, t).join('|'));
    assert.equal(seen.size, 2, 'unconfirmed: exactly letter and blank');
    assert.ok(seen.has(letter.join('|')) && seen.has(FW.QZ_BLANK.join('|')));
    for (let t = 0; t < 5000; t += 7) assert.ok(same(FW.qzFrame(FW.QZ_D_LOCKED, ans, 1, t), letter), `confirmed, t=${t}`);
  }
});

test('display: the letter is visible most of the time while blinking (readable, not a strobe)', () => {
  let on = 0;
  for (let t = 0; t < FW.QZ_BLINK_PERIOD_MS; t++) if (same(FW.qzFrame(FW.QZ_D_LOCKED, 2, 0, t), FW.QZ_LETTERS[1])) on++;
  assert.ok(on / FW.QZ_BLINK_PERIOD_MS > 0.6, `on ${on}/${FW.QZ_BLINK_PERIOD_MS}`);
});

test('display: closed shows the locked letter steady, or a dash when nothing was chosen', () => {
  for (let t = 0; t < 3000; t += 11) {
    assert.ok(same(FW.qzFrame(FW.QZ_D_CLOSED, 3, 0, t), FW.QZ_LETTERS[2]));
    assert.ok(same(FW.qzFrame(FW.QZ_D_CLOSED, 0, 0, t), FW.QZ_ICON_DASH));
  }
});

test('display: results and icons', () => {
  assert.ok(same(FW.qzFrame(FW.QZ_D_RESULT, 1, 0, 0), FW.QZ_ICON_CHECK));
  assert.ok(same(FW.qzFrame(FW.QZ_D_RESULT, 2, 0, 0), FW.QZ_ICON_CROSS));
  assert.ok(same(FW.qzFrame(FW.QZ_D_RESULT, 3, 0, 0), FW.QZ_ICON_DASH));
  assert.ok(same(FW.qzFrame(FW.QZ_D_NOLINK, 0, 0, 0), FW.QZ_ICON_NOLINK));
  assert.ok(same(FW.qzFrame(FW.QZ_D_UNASSIGNED, 0, 0, 0), FW.QZ_ICON_QUESTION));
});

test('display: countdown bar lights exactly the requested number of LEDs', () => {
  for (let n = 0; n <= 25; n++) {
    const lit = FW.qzFrame(FW.QZ_D_WAIT, n, 0, 0).join('').split('#').length - 1;
    assert.equal(lit, n);
  }
});

test('display: identify flashes 3 times then settles on the team number (or blank if unassigned)', () => {
  const steps = FW.QZ_IDENT_STEPS, dt = FW.QZ_IDENT_STEP_MS;
  let changes = 0, prev = null;
  for (let t = 0; t < steps * dt; t += 5) { const k = FW.qzFrame(FW.QZ_D_IDENT, 7, 0, t).join('|'); if (k !== prev) changes++; prev = k; }
  assert.equal(changes, steps, 'dark/full x3');
  const after = FW.qzFrame(FW.QZ_D_IDENT, 7, 0, steps * dt + 1000);
  assert.ok(same(after, FW.qzFrame(FW.QZ_D_IDLE, 7, 0, 0)), 'team number');
  assert.ok(same(FW.qzFrame(FW.QZ_D_IDENT, 0, 0, 99999), FW.QZ_BLANK));
});

test('display: team numbers 1..16 are distinct pictures', () => {
  const s = new Set();
  for (let n = 1; n <= 16; n++) s.add(FW.qzFrame(FW.QZ_D_IDLE, n, 0, 0).join('|'));
  assert.equal(s.size, 16);
});

// ---------------------------------------------------------------------------
//  Whole system: what the display is told, end to end
// ---------------------------------------------------------------------------
function boot({ n = 5, seed = 1, loss = 0 } = {}) {
  const w = new World({ seed, lossProb: loss });
  const pc = new SimPc(w, { limitMs: 30000, nAns: 4 });
  const base = w.addBase(pc);
  const teams = [];
  for (let i = 0; i < n; i++) teams.push(w.addTeam(5));
  w.runFor(5000);
  for (let i = 0; i < 60 && teams.some((t) => t.logic.slot === FW.QZ_UNASSIGNED); i++) w.runFor(500);   // lossy links assign late
  w.runFor(1500);                                                                                    // let the 'assigned' flash finish
  return { w, pc, base, teams };
}
const lastDisplay = (d) => d.displays[d.displays.length - 1];

test('system: once the base confirms an answer the display ends up steady, whatever happens afterwards', () => {
  for (const loss of [0, 0.3]) for (let seed = 1; seed <= 15; seed++) {
    const { w, pc, teams } = boot({ seed, loss });
    pc.open(1);
    w.runFor(500);
    const at = w.t + 100 * 1000;
    teams.forEach((t, i) => t.press(i % 4, at + i * 3000));
    w.runFor(3000);
    teams.forEach((t, i) => {
      const d = lastDisplay(t);
      assert.equal(d.mode, FW.QZ_D_LOCKED, `loss ${loss} seed ${seed} team ${i}: mode`);
      assert.equal(d.a, (i % 4) + 1);
      assert.equal(d.b, 1, `loss ${loss} seed ${seed} team ${i}: never confirmed on the display`);
    });
    // keep hammering all five keys: nothing may change the confirmed picture
    const n0 = teams.map((t) => t.displays.length);
    teams.forEach((t) => { for (let k = 0; k < 5; k++) t.press(k, w.t + (200 + k * 400) * 1000); });
    w.runFor(4000);
    teams.forEach((t, i) => {
      assert.equal(t.displays.length, n0[i], 'extra presses must not change the display');
      assert.equal(lastDisplay(t).b, 1);
    });
  }
});

test('system: display follows the whole question cycle for every team', () => {
  const { w, pc, teams } = boot({ seed: 4 });
  const modes = (t) => t.displays.map((d) => d.mode);
  pc.open(1);
  w.runFor(600);
  assert.ok(teams.every((t) => lastDisplay(t).mode === FW.QZ_D_WAIT), 'countdown bar while open');
  teams.forEach((t, i) => t.press(i % 4, w.t + 50 * 1000));
  w.runFor(1500);
  assert.ok(teams.every((t) => lastDisplay(t).mode === FW.QZ_D_LOCKED && lastDisplay(t).b === 1));
  pc.close();
  w.runFor(800);
  assert.ok(teams.every((t, i) => lastDisplay(t).mode === FW.QZ_D_CLOSED && lastDisplay(t).a === (i % 4) + 1), 'steady letter once closed');
  pc.reveal(0b00001, 0b11110);
  w.runFor(800);
  teams.forEach((t, i) => assert.equal(lastDisplay(t).mode, FW.QZ_D_RESULT, `team ${i}`));
  pc.idle();
  w.runFor(800);
  teams.forEach((t) => assert.equal(lastDisplay(t).mode, FW.QZ_D_IDLE));
  pc.open(2);
  w.runFor(600);
  assert.ok(teams.every((t) => lastDisplay(t).mode === FW.QZ_D_WAIT), 'new question: previous answer is gone');
  assert.ok(teams.every((t) => modes(t).includes(FW.QZ_D_LOCKED)));
});

test('system: a refused press never makes the display claim an answer', () => {
  const { w, pc, teams } = boot({ n: 2, seed: 2 });
  pc.open(1);
  w.runFor(600);
  teams[0].press(4, w.t + 50 * 1000);          // key E on a 4-answer question
  w.runFor(1000);
  assert.equal(lastDisplay(teams[0]).mode, FW.QZ_D_WAIT);
  assert.ok(teams[0].sounds.some((s) => s.id === FW.QZ_S_INVALID));
});

test('display: local test mode shows "T" with a blinking right-hand "!", or the pressed letter', () => {
  const { qzFrame, QZ_D_LOCAL, QZ_ICON_BANG, QZ_ICON_BANG_BLANK, QZ_LETTERS, QZ_LOCAL_BLINK_MS } = FW;
  const on = [], off = [];
  for (let t = 0; t < 3 * QZ_LOCAL_BLINK_MS; t += 10) {
    const f = qzFrame(QZ_D_LOCAL, 0, 0, t).join('|');
    if (f === QZ_ICON_BANG.join('|')) on.push(t); else if (f === QZ_ICON_BANG_BLANK.join('|')) off.push(t); else assert.fail('unexpected frame at ' + t);
  }
  assert.ok(on.length > 0 && off.length > 0, 'it blinks');
  // the two blink frames differ only in the right-hand column: the "T" stays put, the "!" blinks
  for (let y = 0; y < 5; y++) assert.equal(QZ_ICON_BANG[y].slice(0, 4), QZ_ICON_BANG_BLANK[y].slice(0, 4));
  assert.notEqual(QZ_ICON_BANG.join(''), QZ_ICON_BANG_BLANK.join(''));
  for (let i = 1; i <= 5; i++) assert.equal(qzFrame(QZ_D_LOCAL, i, 0, 123).join('|'), QZ_LETTERS[i - 1].join('|'));
});

test('display: QzLocalTest shows the last pressed letter, holds it briefly after release, beeps once per press', () => {
  const { QzLocalTest, QZ_LOCAL_HOLD_MS } = FW;
  const lt = new QzLocalTest();
  assert.equal(lt.onKeys([false, false, false, false], 0), false);
  assert.equal(lt.show, 0);
  assert.equal(lt.onKeys([false, true, false, false], 10), true);
  assert.equal(lt.show, 2);
  assert.equal(lt.onKeys([false, true, false, false], 20), false, 'holding is not a new press');
  assert.equal(lt.onKeys([false, true, true, false], 30), true);
  assert.equal(lt.show, 3, 'the newest press wins');
  lt.onKeys([false, false, false, false], 40);
  assert.equal(lt.show, 3, 'still visible right after release');
  lt.onKeys([false, false, false, false], 30 + QZ_LOCAL_HOLD_MS - 1);
  assert.equal(lt.show, 3);
  lt.onKeys([false, false, false, false], 30 + QZ_LOCAL_HOLD_MS + 1);
  assert.equal(lt.show, 0);
});
