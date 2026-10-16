# Hardware

## Per team

* 1 micro:bit v2 on an edu:bit board with USB power bank.
* 2 M5Stack Dual Unit Button (mapped to A B, and C D), plugged into edu:bit Grove connectors, plus the Lego console built by the team.
* Feedback: 5x5 LED display (letter of the locked answer, countdown bar, result) and the edu:bit speaker (sound feedback from microbit alone might be too low).

## Base station (one)

* 1 micro:bit plugged in the PC by USB. Nothing else. It does not need an edu:bit.

## Edubit pins mapping

micro:bit's own A/B buttons (`QZ_BTN_A` / `QZ_BTN_B`): 

- the edu:bit's two big buttons are reported to be wired in parallel with them
- M5stack Dual Unit:  blu: A,  red: B

P8 and P12 correspond to the infrared sensor on the edubit - note that:

- both P8 and P12 need to be set as pull up during init
- if the infrared is kept attached, from my experiments it seems not to interphere provided that the knob 
  is cranked max clockwise (you should see its red led turns on). As undesired effect,  in simpler separate setups I noticed the system will think the 'button' is pressed until you actually plug in the M5stack dual button - this might provoke annoying sounds if the system is programmed to blip on answer.
-  M5stack Dual Unit: blu: C   red: D

P14, P15 and P16 correspond the to semaphore on the edubit, note that: 

- For now, we DON'T use them  
- P14 and P15 need to be set as pull up  during init
- P16 needs to be set to logic state 1 since there is no automatic Vcc in that third channel pos (Claude told me it gives more power than just pulling up)
- AND as far as my testing go the semaphore needs to be physically removed as it interferes.
- `[DigitalPin.P14, DigitalPin.P15, DigitalPin.P16]`


### How to check pins

The pin list in `firmware/src/team_main.ts` (`QZ_KEY_SOURCES`) is a **placeholder**. To fill it in:

1. Flash `firmware/dist/probe.ts` (paste into a new MakeCode project, JavaScript view) on a micro:bit on the edu:bit.
2. Open a serial monitor (MakeCode "Show console device", 115200 baud). At boot it prints the idle level of each
   candidate pin. Any pin that is `0` with nothing connected cannot be used as a key.
3. Plug a Unit Key in one connector, press it: `LOW P<n>` appears and the number scrolls on the LEDs. Repeat for each
   connector. Write the numbers into `QZ_KEY_SOURCES` in answer order A..E.
4. Press button A on the micro:bit to switch to mode 2 (bounce): each press shows how many times the line toggled in
   30 ms. More than a few toggles or bounces longer than 10 ms mean `QZ_DEBOUNCE_MS` must be raised.
5. Button B plays a tone: confirms the edu:bit speaker works (default pin P0).

Alternatively use the micro:bit's own A/B buttons (`QZ_BTN_A`, `QZ_BTN_B`) for a first test.

## Dual Unit Button

Will use this. TODO some info.

## Unit Key wiring 

Not used now, maybe we will for other purposes.

| wire   | use                                   |
|--------|---------------------------------------|
| white  | key signal, active low, pull-up on the micro:bit (firmware enables it) |
| yellow | LED line, unused                      |
| red/black | 3.3 V / GND                       |

(Colours per M5Stack's documentation for the Unit Key; verify with a multimeter before powering many units.)

## Build and flash

```
node firmware/tools/build.mjs      # writes firmware/dist/{team,base,probe}.ts and MakeCode project folders
```

* In https://makecode.microbit.org create a new project, switch to **JavaScript**, paste `dist/team.ts` (or `base.ts`),
  and download the .hex to the micro:bit. The "Radio" extension is built in for micro:bit.
* Or push `dist/<name>/` to a GitHub repo and use *Import > Import URL*; MakeCode then shows blocks/JS.
* Group/band/power are in `qz_config.ts` (QZ_GROUP=77, QZ_BAND=25). If another event nearby uses the same group, change
  both team and base builds.
* The firmware is plain MakeCode static TypeScript. It type-checks against the real MakeCode declarations
  (`node firmware/tools/typecheck.mjs`), but **the MakeCode editor itself could not be run in the development sandbox**: compile it once in the editor before the event and report any message.

## Assigning teams

1. Start the server, power on all team devices.
2. Control panel -> *Assegna le squadre ai nuovi dispositivi*, or switch on *auto assign* in the settings.
3. Use *Fai lampeggiare* to see which physical device is which team; reassign from the drop-down if needed.
4. *Dimentica* (forget) removes a device from its team. The control panel keeps a list of forgotten devices with a *Ripristina* (restore) button that gives the device its old team back. A forgotten device that transmits again is listed as new automatically. A device can also be added by hand with its serial (8 hex digits, shown on the device list and in the log) in *Aggiungi un dispositivo*, optionally with a team number.
5. The warning sign next to a device means it has not yet confirmed its team number: wait a few seconds.

What the team sees and hears:

| situation | LEDs | sound |
|-----------|------|-------|
| no team assigned yet | question mark | - |
| assigned, waiting | team number | rising two-note chirp when assigned |
| question open | countdown bar (25 LEDs shrinking) | - |
| answer locked, not yet confirmed by the PC | the letter, **blinking** | short beep at the press |
| answer confirmed (acknowledged) | the letter, steady | two-note chirp |
| press refused (letter not valid for this question, or time already up on the device) | unchanged | low buzz |
| time up | the locked letter, or a dash if no answer | - |
| result | tick (correct), cross (wrong), dash (no answer) | happy / sad jingle |
| no link to the base for 2.5 s | "no link" icon, presses ignored | - |
| identify (from the control panel) | full-screen flashes, then the team number | three beeps |

## P0 current indicator blinking on the edu:bit

Once the micro:bit audio engine has started, it drives the audio pin (P0 by default) continuously, so the
edu:bit's P0 current indicator blinks even when nothing is playing. The team firmware therefore keeps the
audio pin released (`pins.setAudioPinEnabled(false)`) and connects it only while a sound is playing. If the
indicator still blinks on your hardware, report it: the next options are moving the speaker to another pin
(`pins.setAudioPin`) or `music.setSilenceLevel`.
