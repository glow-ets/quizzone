# Quizzone scientifico (Contromossa) - Development

## Requirements

- Quiz system for ~15 teams
- Each group should have a device able to communicate fast with server computer in the room. 
- Questions along with 4-5 possible answers appear on a projector (possibly in a badly lit room) / big screen. 
- Each group decides the answer in a limited time. Wrong answers give penalties. Once chosen, an answer is definitive.
- To select the correct answer, each team will activate on his device some contraption, a button, sensor, or whatever. 
- We should expect partecipants to bash the device in the haste of answering, so the device should be hit resistant - still if it breaks once or twice and repair can be done one the spot it's acceptable
- Ideally,  participants would build their own device by connecting  some cables (nothing too difficult). 
- Participants will not code, so the code will be pre-loaded by organizers in the devices. 
- We **MUST** guarantee system works effectively, avoid concurrency issues, network overload, etc. 
    - MUST give the protocol proper testing, don't want surprises on game night
    - assume the worst
    - if there are microbit simulators use them, also write a testing protocol for trying an actual hardware
    - don't assume datasheets from memory, **always double check**
- will start with questions and UI in italian, later we will also provide at least bare demo translation for English, so system MUST be easily translatable

## Tech

- micro:bit on an [edu:bit](https://sites.google.com/cytron.io/edubit-resource-hub) with [M5Stack Unit Dual Button](https://docs.m5stack.com/en/unit/Unit_Dual_Button) buttons
- a base micro:bit connected via USB
- a Python server (standard library only, plus `pyserial` for the base)
- display and control in the browser
- First button press = answer locked in.

See also [HARDWARE.md](HARDWARE.md)

## Setting

Glow ETS (https://glow.earth) is a cultural association that offers, organizes, and manages educational activities and cultural events with the aim of generating innovative ideas and projects capable of making an impact on society and the Trentino region.
 
> Siamo un’associazione, un gruppo di amici, un gruppo di professioniste e professionisti, una rete di makers e un design thinking hub.
>  
> I nostri valori: qui i cinque principi guida che facilitano i nostri processi decisionali e l’azione dei > glowers come unità
 
> - Crediamo nel potere della collaborazione
> - Cerchiamo di sfruttare al massimo le nostre risorse
> - Agiamo a livello globale e pensiamo a livello locale. E viceversa.
> - Crediamo nell’elemento umano
> - Partiamo dal basso

**Website style**: We can get inspiration from glow.earth website, here are pdf screenshots:  [glow-website-branding.pdf](glow-website-branding.pdf). 

## Done and tested without hardware

- MakeCode firmware (team, base, pin probe): types checked against the real MakeCode declarations; 55 tests: protocol/team logic on a virtual-time radio simulator (collisions, 30% packet loss, blackout, 15 simultaneous presses), the pure display frame function, and the real MakeCode glue (`team_main.ts`, `base_main.ts`) run on fake MakeCode globals with a virtual clock.
- Server: game engine, HTTP/SSE, resume after restart; 110 Python tests, including an end-to-end test running the real firmware code in real time and a browser test.
- Italian/English interface, all colors in `server/web/static/theme.css`.

## To do with the hardware (see [docs/TEST_PROTOCOL.md](docs/TEST_PROTOCOL.md))

1. Compile the three `.ts` files in the MakeCode editor (not possible in the development sandbox).
2. Measure the edu:bit connector pins with the probe firmware and fill in `QZ_KEY_SOURCES` (currently a placeholder).
3. Measure Unit Key bounce, range and interference; do a full dress rehearsal.

