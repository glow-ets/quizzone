// =============================================================================
//  Base station logic (the micro:bit plugged into the PC by USB).
//
//  Radio  -> PC : every valid team STATE packet becomes one "T ..." line.
//  PC -> radio  : the PC sends its full game state ("S ..." line) several times
//                 per second; the base re-broadcasts it as a BEACON every
//                 QZ_BEACON_MS, interpolating the elapsed time locally.
//                 "A"/"N" lines become ASSIGN/IDENT packets.
//
//  The radio receive path only enqueues (the hardware queue holds just 4
//  packets, so the handler must return immediately); lines are written to the
//  serial port from tick().
// =============================================================================

interface QzBaseHal {
    radioSend(bytes: number[]): void;
    serialWrite(text: string): void;   // may block while the UART drains
}

class QzRxItem {
    serial = 0;
    rssi = 0;
    at = 0;
    msg: QzMsg = null;
    constructor() { }
}

class QzBase {
    hal: QzBaseHal;

    // Latest state received from the PC
    sPhase = QZ_PH_IDLE;
    sQ = 0;
    sElapsed = 0;
    sLimit = 0;       // ms
    sAck = 0;
    sCorrect = 0;
    sWrong = 0;
    sFlags = 0;
    sAt = -1000000;
    sValid = false;

    bseq = 0;
    nextBeacon = 0;
    nextHello = 0;
    rxq: QzRxItem[] = [];

    // Counters reported in the "H" line
    cOverflow = 0;    // software queue overflow (dropped oldest)
    cForeign = 0;     // radio packets that are not valid Quizzone packets
    cBadLine = 0;     // serial lines with bad checksum / unparsable
    cRxOk = 0;        // valid team packets received

    constructor(hal: QzBaseHal, now: number) {
        this.hal = hal;
        this.nextBeacon = now;
        this.nextHello = now;
    }

    // ---- radio in ---------------------------------------------------------
    onRadio(bytes: number[], serial: number, rssi: number, now: number) {
        const m = qzDecode(bytes);
        if (m == null) { this.cForeign++; return; }
        if (m.type != QZ_T_STATE) return;   // our own beacons etc. are not interesting
        if (this.rxq.length >= QZ_RXQ_MAX) {
            this.rxq.shift();
            this.cOverflow++;
        }
        const it = new QzRxItem();
        it.serial = serial;
        it.rssi = rssi;
        it.at = now;
        it.msg = m;
        this.rxq.push(it);
        this.cRxOk++;
    }

    // ---- serial in --------------------------------------------------------
    onSerialLine(line: string, now: number) {
        const p = qzStripLine(line);
        if (p == null) { if (line.length > 0) this.cBadLine++; return; }
        const f = p.split(" ");
        const cmd = f[0];
        const ok = [true];
        if (cmd == "S" && f.length == 9) {
            const phase = qzParseInt(f[1], ok);
            const q = qzParseInt(f[2], ok);
            const elapsed = qzParseInt(f[3], ok);
            const limit = qzParseInt(f[4], ok);
            const ack = qzParseInt(f[5], ok);
            const correct = qzParseInt(f[6], ok);
            const wrong = qzParseInt(f[7], ok);
            const flags = qzParseInt(f[8], ok);
            if (!ok[0] || phase < 0 || phase > 3) { this.cBadLine++; return; }
            this.sPhase = phase; this.sQ = q & 255; this.sElapsed = qzClamp16(elapsed);
            this.sLimit = limit < 0 ? 0 : limit;
            this.sAck = ack & 0xFFFF; this.sCorrect = correct & 0xFFFF; this.sWrong = wrong & 0xFFFF;
            this.sFlags = flags & 255;
            this.sAt = now;
            this.sValid = true;
        } else if ((cmd == "A" || cmd == "N") && f.length == 3) {
            const serial = qzParseHex32(f[1], ok);
            const arg = qzParseInt(f[2], ok);
            if (!ok[0] || arg < 0 || arg > 255) { this.cBadLine++; return; }
            this.hal.radioSend(qzEncTargeted(cmd == "A" ? QZ_T_ASSIGN : QZ_T_IDENT, serial, arg));
        } else if (cmd == "P" && f.length == 1) {
            this.nextHello = now;   // answer with an H line on the next tick
        } else {
            this.cBadLine++;
        }
    }

    serverAlive(now: number): boolean {
        return this.sValid && (now - this.sAt) < QZ_SERVER_TIMEOUT_MS;
    }

    // ---- periodic ---------------------------------------------------------
    tick(now: number) {
        if (now >= this.nextBeacon) {
            this.nextBeacon = now + QZ_BEACON_MS;
            this.sendBeacon(now);
        }
        if (this.rxq.length > 0) {
            this.writeTeamLine(this.rxq.shift());
        } else if (now >= this.nextHello) {
            this.nextHello = now + QZ_BASE_HELLO_MS;
            this.hal.serialWrite(qzAddChecksum("H " + QZ_FW + " " + QZ_GROUP + " " + QZ_BAND + " " +
                Math.idiv(now, 1000) + " " + this.cOverflow + " " + this.cForeign + " " +
                this.cBadLine + " " + this.cRxOk) + "\n");
        }
    }

    sendBeacon(now: number) {
        const m = new QzMsg();
        if (this.serverAlive(now)) {
            m.phase = this.sPhase;
            m.q = this.sQ;
            m.elapsed = this.sPhase == QZ_PH_OPEN ? qzClamp16(this.sElapsed + (now - this.sAt)) : this.sElapsed;
            m.limit = Math.idiv(this.sLimit + 99, 100);
            m.ack = this.sAck;
            m.correct = this.sCorrect;
            m.wrong = this.sWrong;
            m.flags = this.sFlags;
        } else {
            m.phase = QZ_PH_OFFLINE;
        }
        m.bseq = this.bseq;
        this.bseq = (this.bseq + 1) & 255;
        this.hal.radioSend(qzEncBeacon(m));
    }

    writeTeamLine(it: QzRxItem) {
        const m = it.msg;
        this.hal.serialWrite(qzAddChecksum("T " + qzHex8(it.serial) + " " + it.rssi + " " + m.slot + " " +
            m.seq + " " + m.q + " " + m.ans + " " + m.elapsed + " " + m.flags + " " + m.fw + " " +
            m.presses + " " + m.bmiss + " " + (it.at & 0x7FFFFFFF)) + "\n");
    }
}
