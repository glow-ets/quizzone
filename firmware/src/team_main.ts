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
let qzDMode = QZ_D_UNASSIGNED;
let qzDA = 0;
let qzDB = 0;
let qzDDirty = true;

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
        qzDMode = mode; qzDA = a; qzDB = b; qzDDirty = true;
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

// ---- LED bitmaps (5x5, '#' = lit) ------------------------------------------
const QZ_LETTERS: string[][] = [
    [".###.", "#...#", "#####", "#...#", "#...#"],   // A
    ["####.", "#...#", "####.", "#...#", "####."],   // B
    [".####", "#....", "#....", "#....", ".####"],   // C
    ["####.", "#...#", "#...#", "#...#", "####."],   // D
    ["#####", "#....", "####.", "#....", "#####"]    // E
];
const QZ_DIGITS: string[][] = [
    ["###", "#.#", "#.#", "#.#", "###"],
    [".#.", "##.", ".#.", ".#.", "###"],
    ["###", "..#", "###", "#..", "###"],
    ["###", "..#", "###", "..#", "###"],
    ["#.#", "#.#", "###", "..#", "..#"],
    ["###", "#..", "###", "..#", "###"],
    ["###", "#..", "###", "#.#", "###"],
    ["###", "..#", "..#", "..#", "..#"],
    ["###", "#.#", "###", "#.#", "###"],
    ["###", "#.#", "###", "..#", "###"]
];
const QZ_ICON_CHECK = [".....", "....#", "...#.", "#.#..", ".#..."];
const QZ_ICON_CROSS = ["#...#", ".#.#.", "..#..", ".#.#.", "#...#"];
const QZ_ICON_DASH = [".....", ".....", ".###.", ".....", "....."];
const QZ_ICON_QUESTION = [".###.", "#...#", "..##.", ".....", "..#.."];
const QZ_ICON_NOLINK = ["#...#", ".....", "..#..", ".....", "#...#"];

function qzDraw(rows: string[]) {
    for (let y = 0; y < 5; y++) {
        for (let x = 0; x < 5; x++) {
            if (rows.length > y && rows[y].charAt(x) == "#") led.plot(x, y); else led.unplot(x, y);
        }
    }
}

function qzDrawNumber(n: number) {
    // 1..9: one 3x5 digit centred. 10..99: a bar for the tens "1" plus a 3x5 unit digit.
    const rows: string[] = [];
    const u = QZ_DIGITS[n % 10];
    for (let y = 0; y < 5; y++) {
        if (n < 10) rows.push("." + u[y] + ".");
        else rows.push("#." + u[y]);
    }
    qzDraw(rows);
}

function qzDrawBar(lit: number) {
    for (let i = 0; i < 25; i++) {
        if (i < lit) led.plot(i % 5, Math.idiv(i, 5)); else led.unplot(i % 5, Math.idiv(i, 5));
    }
}

function qzRender() {
    const mode = qzDMode;
    const a = qzDA;
    const b = qzDB;
    qzDDirty = false;
    if (mode == QZ_D_UNASSIGNED) qzDraw(QZ_ICON_QUESTION);
    else if (mode == QZ_D_IDLE) qzDrawNumber(a);
    else if (mode == QZ_D_WAIT) qzDrawBar(a);
    else if (mode == QZ_D_LOCKED || mode == QZ_D_CLOSED) {
        if (a >= 1 && a <= 5) {
            if (mode == QZ_D_LOCKED && b == 0) {
                // not yet acknowledged by the base: blink so the team knows
                for (let i = 0; i < 4 && !qzDDirty; i++) {
                    qzDraw(QZ_LETTERS[a - 1]); basic.pause(250);
                    qzDraw([]); basic.pause(100);
                }
                if (!qzDDirty) qzDDirty = true;   // keep blinking until state changes
                qzDMode = mode; qzDA = a; qzDB = b;
            } else {
                qzDraw(QZ_LETTERS[a - 1]);
            }
        } else qzDraw(QZ_ICON_DASH);
    } else if (mode == QZ_D_RESULT) {
        if (a == 1) qzDraw(QZ_ICON_CHECK);
        else if (a == 2) qzDraw(QZ_ICON_CROSS);
        else qzDraw(QZ_ICON_DASH);
    } else if (mode == QZ_D_NOLINK) qzDraw(QZ_ICON_NOLINK);
    else if (mode == QZ_D_IDENT) {
        for (let i = 0; i < 3 && !qzDDirty; i++) {
            basic.clearScreen(); basic.pause(120);
            for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) led.plot(x, y);
            basic.pause(120);
        }
        if (a > 0 && !qzDDirty) qzDrawNumber(a);
    }
}

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
        if (qzDDirty) qzRender();
        basic.pause(20);
    }
});
control.inBackground(function () {
    while (true) {
        if (qzSoundQueue.length > 0) qzPlay(qzSoundQueue.shift());
        else basic.pause(10);
    }
});
