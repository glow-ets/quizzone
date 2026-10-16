// =============================================================================
//  DISPLAY FRAMES - pure functions (no hardware, no blocking, no shared state).
//  qzFrame() maps (display mode, a, b, ms since that state began) to the 5x5 picture that
//  must be on the LEDs at that moment. The hardware glue (team_main.ts) only draws the
//  result, so what the team sees is always a function of the CURRENT state: a late or
//  repeated state change can never leave a stale picture behind.
// =============================================================================

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

const QZ_BLINK_PERIOD_MS = 350;      // locked but not yet confirmed by the base: letter blinks
const QZ_BLINK_ON_MS = 250;
const QZ_IDENT_STEP_MS = 120;        // identify: 3 flashes of 2 steps (dark, full), then the team number
const QZ_IDENT_STEPS = 6;

// Local test mode: a blinking "!" in the right-hand column (same shape as on the base station).
const QZ_ICON_BANG = ["....#", "....#", "....#", ".....", "....#"];
const QZ_LOCAL_BLINK_MS = 700;       // full period of the "!" blink
const QZ_LOCAL_HOLD_MS = 400;        // a pressed letter stays visible this long after the key is released

const QZ_BLANK = [".....", ".....", ".....", ".....", "....."];
const QZ_FULL = ["#####", "#####", "#####", "#####", "#####"];

function qzNumberFrame(n: number): string[] {
    // 1..9: one 3x5 digit centred. 10..99: a bar for the tens "1" plus a 3x5 unit digit.
    const rows: string[] = [];
    const u = QZ_DIGITS[n % 10];
    for (let y = 0; y < 5; y++) {
        if (n < 10) rows.push("." + u[y] + ".");
        else rows.push("#." + u[y]);
    }
    return rows;
}

function qzBarFrame(lit: number): string[] {
    const rows: string[] = [];
    for (let y = 0; y < 5; y++) {
        let r = "";
        for (let x = 0; x < 5; x++) r += (y * 5 + x < lit) ? "#" : ".";
        rows.push(r);
    }
    return rows;
}

function qzFrame(mode: number, a: number, b: number, t: number): string[] {
    if (mode == QZ_D_UNASSIGNED) return QZ_ICON_QUESTION;
    if (mode == QZ_D_IDLE) return qzNumberFrame(a);
    if (mode == QZ_D_WAIT) return qzBarFrame(a);
    if (mode == QZ_D_LOCKED || mode == QZ_D_CLOSED) {
        if (a < 1 || a > 5) return QZ_ICON_DASH;
        if (mode == QZ_D_LOCKED && b == 0) return (t % QZ_BLINK_PERIOD_MS) < QZ_BLINK_ON_MS ? QZ_LETTERS[a - 1] : QZ_BLANK;
        return QZ_LETTERS[a - 1];
    }
    if (mode == QZ_D_RESULT) return a == 1 ? QZ_ICON_CHECK : (a == 2 ? QZ_ICON_CROSS : QZ_ICON_DASH);
    if (mode == QZ_D_NOLINK) return QZ_ICON_NOLINK;
    if (mode == QZ_D_LOCAL) {
        if (a >= 1 && a <= 5) return QZ_LETTERS[a - 1];
        return (t % QZ_LOCAL_BLINK_MS) < Math.idiv(QZ_LOCAL_BLINK_MS, 2) ? QZ_ICON_BANG : QZ_BLANK;
    }
    if (mode == QZ_D_IDENT) {
        const step = Math.idiv(t, QZ_IDENT_STEP_MS);
        if (step < QZ_IDENT_STEPS) return (step % 2) == 0 ? QZ_BLANK : QZ_FULL;
        return a > 0 ? qzNumberFrame(a) : QZ_BLANK;
    }
    return QZ_BLANK;
}


// ---- local test mode: which letter to show for the keys currently pressed ----------------------
// Pure state machine (the glue only feeds it the key states and draws the result). In this mode the
// device sends nothing on the radio and ignores everything it receives.
class QzLocalTest {
    show = 0;                 // letter 1..5 to display, 0 = none
    until = 0;                // the letter stays on screen until this time
    prev: boolean[] = [];

    // Returns true when a key has just been pressed (the glue plays a local beep).
    onKeys(down: boolean[], now: number): boolean {
        let fresh = false;
        let any = false;
        for (let i = 0; i < down.length; i++) {
            const was = i < this.prev.length ? this.prev[i] : false;
            if (down[i]) {
                any = true;
                if (!was) { this.show = i + 1; fresh = true; }
            }
        }
        this.prev = [];
        for (let i = 0; i < down.length; i++) this.prev.push(down[i]);
        if (any) this.until = now + QZ_LOCAL_HOLD_MS;
        else if (now >= this.until) this.show = 0;
        return fresh;
    }
}
