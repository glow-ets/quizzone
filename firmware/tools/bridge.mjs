#!/usr/bin/env node
// Real-time bridge: runs the REAL firmware logic (team + base) inside the virtual radio
// world, paced by the wall clock, and exposes the base station's USB serial over TCP.
// The Python server connects with `python -m quizzone run --tcp 127.0.0.1:PORT`.
//
// Extra control lines (start with '!', not part of the real protocol):
//   !press <team 1..N> <answer 1..5> [delayMs]   press that key on a virtual team device
//   !loss <0..1>                                  random packet loss on the radio medium
//   !dump                                         reply with a JSON line of every team's internal state (debug)
//   !stats                                        reply with a JSON line of radio statistics
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { World, SimPc } from '../tests/sim.mjs';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const nTeams = +arg('teams', 15), port = +arg('port', 0), seed = +arg('seed', 1), loss = +arg('loss', 0);

const w = new World({ seed, lossProb: loss });
const sockets = new Set();
const pc = {
  attach(base) { this.base = base; },
  onLineFromBase(text) {
    const line = text.endsWith('\n') ? text : text + '\n';
    for (const s of sockets) s.write(line);
  },
};
const base = w.addBase(pc);
const teams = Array.from({ length: nTeams }, () => w.addTeam(5));

if (process.env.QZ_DEBUG) teams.forEach((d, i) => {
  const l = d.logic, orig = l.onPress.bind(l);
  l.onPress = (k, now, tp) => {
    console.error('press', i + 1, 'k', k, 'now', now, 'tPress', tp, 'slot', l.slot, 'phase', l.bPhase, 'bAt', l.bAt, 'age', now - l.bAt, 'locked', l.isLocked(), 'bElapsed', l.bElapsed, 'bLimit', l.bLimit, 'n', l.nAnswers());
    orig(k, now, tp);
  };
});
const t0 = performance.now();
setInterval(() => { w.run(Math.floor((performance.now() - t0) * 1000)); }, 2);

function control(line, sock) {
  const f = line.slice(1).trim().split(/\s+/);
  if (f[0] === 'press') {
    const tm = teams[+f[1] - 1], k = +f[2] - 1, delay = +(f[3] || 0);
    if (tm && k >= 0 && k < 5) tm.press(k, w.t + delay * 1000);
  } else if (f[0] === 'loss') {
    w.o.lossProb = Math.max(0, Math.min(1, +f[1] || 0));
  } else if (f[0] === 'dump') {
    sock.write('!dump ' + JSON.stringify(teams.map((d, i) => { const l = d.logic; return { i: i + 1, now: d.deviceMs(), slot: l.slot, bPhase: l.bPhase, bQ: l.bQ, bAt: l.bAt, bElapsed: l.bElapsed, bLimit: l.bLimit, lockedQ: l.lockedQ, ans: l.ans, presses: l.presses }; })) + '\n');
  } else if (f[0] === 'stats') {
    sock.write('!stats ' + JSON.stringify({ ...w.stats, hwDrops: w.devices.reduce((a, d) => a + d.hwDrops, 0),
      baseDrops: base.logic.rxOverflow ?? null }) + '\n');
  }
}
const server = net.createServer((sock) => {
  sockets.add(sock);
  let buf = '';
  sock.on('data', (d) => {
    buf += d.toString('latin1');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
      if (line.startsWith('!')) control(line, sock);
      else if (line) base.sendFromPc(line + '\n');
    }
  });
  sock.on('close', () => sockets.delete(sock));
  sock.on('error', () => sockets.delete(sock));
});
server.listen(port, '127.0.0.1', () => console.log(`LISTENING ${server.address().port}`));
