// =============================================================================
//  Contromossa quiz - shared settings. Must be IDENTICAL on every team device
//  and on the base station (the micro:bit plugged into the computer).
// =============================================================================

// --- Radio network ----------------------------------------------------------
// The micro:bit radio frequency is 2400 MHz + band (MHz). MakeCode's default
// band is 7 (2407 MHz), which sits on top of Wi-Fi channel 1: avoid it.
// Verified in the codal/pxt source: group 0..255, band 0..83, power 0..7.
// Pick a group/band that no other micro:bit activity in the venue uses.
const QZ_GROUP = 77;
const QZ_BAND = 25;
const QZ_TX_POWER = 7;

// Firmware / protocol version reported by team devices (uint8).
const QZ_FW = 1;

// Maximum number of teams (the ack/result masks are 16 bits wide).
const QZ_MAX_TEAMS = 16;

// --- Timing (milliseconds) --------------------------------------------------
const QZ_BEACON_MS = 100;        // base -> teams state beacon period
const QZ_SERVER_TIMEOUT_MS = 3000; // base: no valid state line from the PC -> OFFLINE
const QZ_BASE_HELLO_MS = 2000;   // base -> PC "H" heartbeat line period
const QZ_STALE_MS = 1500;        // team: ignore key presses if last beacon is older
const QZ_NOLINK_MS = 2500;       // team: show "no link" if no beacon for this long
const QZ_DEBOUNCE_MS = 10;       // key must be stable this long to count
const QZ_HB_MS = 1000;           // team: idle heartbeat (state) period, +0..300 jitter
const QZ_UNASSIGNED_HB_MS = 600; // team without a slot announces itself this often (+0..400)
const QZ_RXQ_MAX = 64;           // base: software queue between radio and serial
