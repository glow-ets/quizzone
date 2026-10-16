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
    if (mode == QZ_D_IDENT) {
        const step = Math.idiv(t, QZ_IDENT_STEP_MS);
        if (step < QZ_IDENT_STEPS) return (step % 2) == 0 ? QZ_BLANK : QZ_FULL;
        return a > 0 ? qzNumberFrame(a) : QZ_BLANK;
    }
    return QZ_BLANK;
}
