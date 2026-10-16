// =============================================================================
//  Team device logic (runs on each team's micro:bit).
//  Hardware-free: everything goes through QzTeamHal, so it is unit-testable in
//  Node. The MakeCode glue (team_main.ts) implements the HAL.
//
//  Design (see protocol/PROTOCOL.md):
//   * The device measures the time of its own first key press relative to the
//     question start announced in beacons, so delivery delay never affects
//     fairness.
//   * The device keeps broadcasting its STATE (idempotent) until the base
//     acknowledges it in a beacon bitmask. No per-device connection exists.
//   * First press locks the answer; later presses are ignored.
// =============================================================================

// Display modes requested from the glue.
const QZ_D_UNASSIGNED = 0;
const QZ_D_IDLE = 1;      // a = slot
const QZ_D_WAIT = 2;      // a = LEDs lit for the countdown bar (0..25)
const QZ_D_LOCKED = 3;    // a = answer 1..5, b = 1 if acknowledged
const QZ_D_CLOSED = 4;    // a = answer 1..5 or 0
const QZ_D_RESULT = 5;    // a = 1 correct, 2 wrong, 3 no answer
const QZ_D_NOLINK = 6;
const QZ_D_IDENT = 7;
const QZ_D_LOCAL = 8;      // local test mode: a = letter 1..5 to show, 0 = none (blinking "!")

// Sounds requested from the glue (played by a background fiber).
const QZ_S_LOCK = 1;
const QZ_S_ACK = 2;
const QZ_S_INVALID = 3;
const QZ_S_CORRECT = 5;
const QZ_S_WRONG = 6;
const QZ_S_IDENT = 7;
const QZ_S_ASSIGNED = 8;

interface QzTeamHal {
    radioSend(bytes: number[]): void;
    sound(id: number): void;
    display(mode: number, a: number, b: number): void;
}

class QzTeam {
    hal: QzTeamHal;
    serial: number;
    slot = QZ_UNASSIGNED;

    // Last beacon seen
    bPhase = QZ_PH_IDLE;
    bQ = 0;
    bElapsed = 0;
    bLimit = 0;       // ms
    bAck = 0;
    bCorrect = 0;
    bWrong = 0;
    bFlags = 0;
    bAt = -1000000;   // local time the last beacon was handled
    lastBseq = -1;
    bmiss = 0;
    seenPhase = QZ_PH_IDLE;
    everBeacon = false;

    // Answer state (valid only while lockedQ == bQ)
    lockedQ = 0;
    ans = 0;
    ansElapsed = 0;
    acked = false;

    presses = 0;
    seq = 0;

    // TX scheduling
    nextTx = 0;
    txAttempts = 0;
    reportAt = -1;

    // Display / ident
    identUntil = -1;
    lastDMode = -1;
    lastDA = -1;
    lastDB = -1;
    resultKind = 3;

    // Key debounce
    lowSince: number[] = [];
    highSince: number[] = [];
    armed: boolean[] = [];
    nKeys: number;

    rngState = 0;

    constructor(hal: QzTeamHal, serial: number, nKeys: number, now: number) {
        this.hal = hal;
        this.serial = serial;
        this.nKeys = nKeys;
        for (let i = 0; i < nKeys; i++) {
            this.lowSince.push(-1);
            this.highSince.push(now);
            this.armed.push(false);   // a key already held at boot must be released first
        }
        // 16-bit LCG seeded from the device serial: different on every device.
        this.rngState = (serial ^ (serial >> 16)) & 0xFFFF;
        this.nextTx = now + this.rnd(0, 500);
    }

    // Inclusive pseudo-random integer in [lo, hi]. 16-bit LCG (full period);
    // the product stays below 2^31 so it is exact in int32 and in doubles.
    rnd(lo: number, hi: number): number {
        this.rngState = (this.rngState * 25173 + 13849) & 0xFFFF;
        const span = hi - lo + 1;
        return lo + (((this.rngState >> 3) * span) >> 13);
    }

    // ---- inputs -----------------------------------------------------------

    // Called for every received radio packet (already stripped of the MakeCode
    // header). Anything not ours is ignored.
    onPacket(bytes: number[], now: number) {
        const m = qzDecode(bytes);
        if (m == null) return;
        if (m.type == QZ_T_BEACON) this.onBeacon(m, now);
        else if (m.type == QZ_T_ASSIGN && m.target == this.serial) this.onAssign(m, now);
        else if (m.type == QZ_T_IDENT && m.target == this.serial) this.onIdent(m, now);
    }

    onAssign(m: QzMsg, now: number) {
        const changed = m.arg != this.slot;
        this.slot = m.arg;
        if (changed) {
            this.hal.sound(QZ_S_ASSIGNED);
            this.identUntil = now + 2500;
        }
        this.reportAt = now + this.rnd(0, 100);
    }

    onIdent(m: QzMsg, now: number) {
        this.identUntil = now + 3000;
        this.hal.sound(QZ_S_IDENT);
        this.reportAt = now + this.rnd(0, 100);
    }

    onBeacon(m: QzMsg, now: number) {
        // Count missed beacons (downlink loss) from the beacon sequence number.
        if (this.lastBseq >= 0) {
            const gap = (m.bseq - this.lastBseq - 1) & 255;
            if (gap > 0 && gap < 128 && this.bmiss < 255) this.bmiss = Math.min(255, this.bmiss + gap);
        }
        this.lastBseq = m.bseq;

        const prevPhase = this.bPhase;
        const prevQ = this.bQ;
        const first = !this.everBeacon;
        this.everBeacon = true;
        this.bPhase = m.phase;
        this.bQ = m.q;
        this.bElapsed = m.elapsed;
        this.bLimit = m.limit * 100;
        this.bAck = m.ack;
        this.bCorrect = m.correct;
        this.bWrong = m.wrong;
        this.bFlags = m.flags;
        this.bAt = now;

        // A new question number invalidates any answer held for an older one
        // (also protects against the 8-bit question counter wrapping around).
        if (m.q != prevQ && this.lockedQ != m.q) {
            this.lockedQ = 0;
            this.ans = 0;
            this.acked = false;
        }

        const phaseChanged = (m.phase != prevPhase) || (m.q != prevQ) || first;
        if (phaseChanged) {
            // Report the final state soon after any phase change (jittered so
            // 15 devices do not answer in the same millisecond).
            if (m.phase != QZ_PH_OPEN) this.reportAt = now + this.rnd(0, 250);
            if (m.phase == QZ_PH_REVEAL) this.onReveal();
        }
        this.seenPhase = m.phase;

        // Acknowledgement for our locked answer?
        if (this.slot != QZ_UNASSIGNED && this.lockedQ == this.bQ && this.lockedQ != 0 && !this.acked) {
            if (((this.bAck >> this.slot) & 1) == 1) {
                this.acked = true;
                this.hal.sound(QZ_S_ACK);
            }
        }

        // Stress-test mode: answer automatically on the first OPEN beacon.
        if (m.phase == QZ_PH_OPEN && (m.flags & QZ_BF_TEST) != 0 && this.slot != QZ_UNASSIGNED
            && !this.isLocked()) {
            const n = this.nAnswers();
            this.lockAnswer((this.slot % n) + 1, now, now);
        }
    }

    onReveal() {
        if (this.slot == QZ_UNASSIGNED) return;
        const bit = (1 << this.slot);
        if ((this.bCorrect & bit) != 0) {
            this.resultKind = 1; this.hal.sound(QZ_S_CORRECT);
        } else if ((this.bWrong & bit) != 0) {
            this.resultKind = 2; this.hal.sound(QZ_S_WRONG);
        } else {
            this.resultKind = 3;
        }
    }

    nAnswers(): number {
        const n = (this.bFlags >> QZ_BF_NANS_SHIFT) & 7;
        if (n < 3) return 3;
        if (n > 5) return 5;
        return n;
    }

    isLocked(): boolean {
        return this.lockedQ != 0 && this.lockedQ == this.bQ;
    }

    // Raw key states (true = pressed). Call every ~2 ms.
    onKeys(down: boolean[], now: number) {
        let winner = 0;
        let winnerT = 0;
        for (let k = 0; k < this.nKeys; k++) {
            if (down[k]) {
                this.highSince[k] = -1;
                if (this.lowSince[k] < 0) this.lowSince[k] = now;
                if (this.armed[k] && now - this.lowSince[k] >= QZ_DEBOUNCE_MS) {
                    this.armed[k] = false;
                    if (winner == 0) { winner = k + 1; winnerT = this.lowSince[k]; }   // same-tick tie: lowest index wins
                }
            } else {
                this.lowSince[k] = -1;
                if (this.highSince[k] < 0) this.highSince[k] = now;
                if (!this.armed[k] && now - this.highSince[k] >= QZ_DEBOUNCE_MS) this.armed[k] = true;
            }
        }
        if (winner > 0) this.onPress(winner, now, winnerT);
    }

    // tPress = local time the key went (and stayed) down, i.e. before the debounce delay.
    onPress(k: number, now: number, tPress: number) {
        this.presses = (this.presses + 1) & 0xFFFF;
        if (this.slot == QZ_UNASSIGNED) return;
        if (this.bPhase != QZ_PH_OPEN) return;
        if (now - this.bAt > QZ_STALE_MS) return;         // do not trust an old beacon
        if (this.isLocked()) return;                       // first press locks
        if (k > this.nAnswers()) { this.hal.sound(QZ_S_INVALID); return; }
        // Time is up on this device's own clock: do not pretend the answer counted.
        if (this.bLimit > 0 && this.bElapsed + (tPress - this.bAt) > this.bLimit) { this.hal.sound(QZ_S_INVALID); return; }
        this.lockAnswer(k, now, tPress);
    }

    lockAnswer(k: number, now: number, tPress: number) {
        let el = this.bElapsed + (tPress - this.bAt);
        if (el < 0) el = 0;
        if (el > 65535) el = 65535;
        this.ans = k;
        this.ansElapsed = el;
        this.lockedQ = this.bQ;
        this.acked = false;
        this.txAttempts = 0;
        this.hal.sound(QZ_S_LOCK);
        this.sendState(now);            // first transmission right away
    }

    // ---- periodic ---------------------------------------------------------

    tick(now: number) {
        if (this.reportAt >= 0 && now >= this.reportAt) {
            this.reportAt = -1;
            this.sendState(now);
        } else if (now >= this.nextTx) {
            this.sendState(now);
        }
        this.updateDisplay(now);
    }

    sendState(now: number) {
        const m = new QzMsg();
        m.slot = this.slot;
        m.seq = this.seq;
        this.seq = (this.seq + 1) & 255;
        m.q = this.bQ;
        const locked = this.isLocked();
        m.ans = locked ? this.ans : 0;
        m.elapsed = locked ? this.ansElapsed : 0;
        let f = 0;
        if (locked) f |= QZ_SF_LOCKED;
        if (locked && this.acked) f |= QZ_SF_ACKED;
        f |= (this.seenPhase & 7) << QZ_SF_PHASE_SHIFT;
        if ((this.bFlags & QZ_BF_TEST) != 0) f |= QZ_SF_TEST;
        m.flags = f;
        m.fw = QZ_FW;
        m.presses = this.presses;
        m.bmiss = this.bmiss;
        this.hal.radioSend(qzEncState(m));

        // Schedule the next transmission.
        let interval = 0;
        if (this.slot == QZ_UNASSIGNED) {
            interval = QZ_UNASSIGNED_HB_MS + this.rnd(0, 400);
        } else if (locked && !this.acked) {
            interval = this.txAttempts < 6 ? 50 + this.rnd(0, 100) : 150 + this.rnd(0, 200);
            this.txAttempts++;
        } else {
            interval = QZ_HB_MS + this.rnd(0, 300);
        }
        this.nextTx = now + interval;
    }

    updateDisplay(now: number) {
        let mode = 0;
        let a = 0;
        let b = 0;
        if (this.identUntil >= 0 && now < this.identUntil) {
            mode = QZ_D_IDENT; a = this.slot == QZ_UNASSIGNED ? 0 : this.slot + 1;
        } else if (this.slot == QZ_UNASSIGNED) {
            mode = QZ_D_UNASSIGNED;
        } else if (!this.everBeacon || now - this.bAt > QZ_NOLINK_MS || this.bPhase == QZ_PH_OFFLINE) {
            mode = QZ_D_NOLINK;
        } else if (this.bPhase == QZ_PH_OPEN) {
            if (this.isLocked()) {
                mode = QZ_D_LOCKED; a = this.ans; b = this.acked ? 1 : 0;
            } else {
                mode = QZ_D_WAIT;
                const limit = this.bLimit > 0 ? this.bLimit : 1;
                let remaining = limit - (this.bElapsed + (now - this.bAt));
                if (remaining < 0) remaining = 0;
                a = Math.min(25, Math.ceil((remaining * 25) / limit));
            }
        } else if (this.bPhase == QZ_PH_CLOSED) {
            mode = QZ_D_CLOSED; a = this.isLocked() ? this.ans : 0;
        } else if (this.bPhase == QZ_PH_REVEAL) {
            mode = QZ_D_RESULT; a = this.resultKind;
        } else {
            mode = QZ_D_IDLE; a = this.slot + 1;
        }
        if (mode != this.lastDMode || a != this.lastDA || b != this.lastDB) {
            this.lastDMode = mode; this.lastDA = a; this.lastDB = b;
            this.hal.display(mode, a, b);
        }
    }
}
