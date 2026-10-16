// =============================================================================
//  TEAM DEVICE - MakeCode glue (micro:bit on an edu:bit, answer keys on pins).
//  All game logic lives in qz_team.ts; this file only talks to the hardware.
// =============================================================================

// ---- EDIT ME: which input drives each answer (A, B, C, D, E) ---------------

const QZ_BTN_A = 1000;
const QZ_BTN_B = 1001;
const QZ_KEY_SOURCES: number[] = [QZ_BTN_A, QZ_BTN_B, DigitalPin.P8, DigitalPin.P12]; 
const QZ_VOLUME = 200;          // 0..255

// ---- hardware access --------------------------------------------------------
let qzSoundQueue: number[] = [];
// Current display state, written by the HAL and read by the display fiber (cooperative fibers: no tearing).
let qzDMode = QZ_D_UNASSIGNED;
let qzDA = 0;
let qzDB = 0;
let qzDSince = 0;               // control.millis() when the state last changed (drives blinking and flashes)

class TeamHal implements QzTeamHal {
    radioSend(bytes: number[]): void {
        const b = control.createBuffer(bytes.length);
        for (let i = 0; i < bytes.length; i++) b[i] = bytes[i];
        radio.sendBuffer(b);
    }
    sound(id: number): void {
        if (qzSoundQueue.length < 6) qzSoundQueue.push(id);
    }
    display(mode: number, a: number, b: number): void {
        if (mode != qzDMode || a != qzDA || b != qzDB) {
            qzDMode = mode; qzDA = a; qzDB = b; qzDSince = control.millis();
        }
    }
}

function qzBufToArray(b: Buffer): number[] {
    const out: number[] = [];
    for (let i = 0; i < b.length; i++) out.push(b[i]);
    return out;
}

function qzReadKey(src: number): boolean {
    if (src == QZ_BTN_A) return input.buttonIsPressed(Button.A);
    if (src == QZ_BTN_B) return input.buttonIsPressed(Button.B);
    return pins.digitalReadPin(src) == 0;      // active low, pull-up enabled
}

function qzDraw(rows: string[]) {
    for (let y = 0; y < 5; y++) {
        for (let x = 0; x < 5; x++) {
            if (rows.length > y && rows[y].charAt(x) == "#") led.plot(x, y); else led.unplot(x, y);
        }
    }
}

let qzLastFrame = "";

function qzPlay(id: number) {
    if (id == QZ_S_LOCK) { music.playTone(880, 60); }
    else if (id == QZ_S_ACK) { music.playTone(660, 40); music.playTone(990, 60); }
    else if (id == QZ_S_INVALID) { music.playTone(220, 80); }
    else if (id == QZ_S_CORRECT) { music.playTone(523, 120); music.playTone(659, 120); music.playTone(784, 240); }
    else if (id == QZ_S_WRONG) { music.playTone(330, 150); music.playTone(196, 350); }
    else if (id == QZ_S_IDENT) { for (let i = 0; i < 3; i++) { music.playTone(1000, 100); basic.pause(100); } }
    else if (id == QZ_S_ASSIGNED) { music.playTone(784, 80); music.playTone(1047, 120); }
}

// ---- start-up ---------------------------------------------------------------
radio.setGroup(QZ_GROUP);
radio.setFrequencyBand(QZ_BAND);
radio.setTransmitPower(QZ_TX_POWER);
radio.setTransmitSerialNumber(true);
music.setVolume(QZ_VOLUME);
for (let i = 0; i < QZ_KEY_SOURCES.length; i++) {
    if (QZ_KEY_SOURCES[i] < 1000) pins.setPull(QZ_KEY_SOURCES[i], PinPullMode.PullUp);
}

const qzTeam = new QzTeam(new TeamHal(), control.deviceSerialNumber(), QZ_KEY_SOURCES.length, control.millis());

radio.onReceivedBuffer(function (b: Buffer) {
    qzTeam.onPacket(qzBufToArray(b), control.millis());
});

// Main loop: poll keys every 2 ms (debounce, press timing and TX scheduling live in QzTeam).
control.inBackground(function () {
    const down: boolean[] = [];
    for (let i = 0; i < QZ_KEY_SOURCES.length; i++) down.push(false);
    while (true) {
        const now = control.millis();
        for (let i = 0; i < QZ_KEY_SOURCES.length; i++) down[i] = qzReadKey(QZ_KEY_SOURCES[i]);
        qzTeam.onKeys(down, now);
        qzTeam.tick(now);
        basic.pause(2);
    }
});

// Display and sound run in their own fibers so they can block without delaying key scanning.
control.inBackground(function () {
    while (true) {
        // Never blocks and never keeps a copy of the state: draw whatever the CURRENT state looks like now.
        const frame = qzFrame(qzDMode, qzDA, qzDB, control.millis() - qzDSince);
        const key = frame.join("");
        if (key != qzLastFrame) { qzLastFrame = key; qzDraw(frame); }
        basic.pause(20);
    }
});
control.inBackground(function () {
    while (true) {
        if (qzSoundQueue.length > 0) qzPlay(qzSoundQueue.shift());
        else basic.pause(10);
    }
});
