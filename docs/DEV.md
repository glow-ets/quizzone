# Quizzone scientifico (Contromossa) - Development

## Description

Quiz system for ~15 teams: 

- micro:bit on an edu:bit with [M5Stack Unit Dual Button](https://docs.m5stack.com/en/unit/Unit_Dual_Button) buttons
- a base micro:bit connected via USB
- a Python server (standard library only, plus `pyserial` for the base)
- display and control in the browser
- First button press = answer locked in.


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


## Done and tested without hardware

- MakeCode firmware (team, base, pin probe): types checked against the real MakeCode declarations; 50 tests: protocol/team logic on a virtual-time radio simulator (collisions, 30% packet loss, blackout, 15 simultaneous presses), the pure display frame function, and the real MakeCode glue (`team_main.ts`, `base_main.ts`) run on fake MakeCode globals with a virtual clock.
- Server: game engine, HTTP/SSE, resume after restart; 89 Python tests, including an end-to-end test running the real firmware code in real time and a browser test.
- Italian/English interface, all colors in `server/web/static/theme.css`.

## To do with the hardware (see [docs/TEST_PROTOCOL.md](docs/TEST_PROTOCOL.md))

1. Compile the three `.ts` files in the MakeCode editor (not possible in the development sandbox).
2. Measure the edu:bit connector pins with the probe firmware and fill in `QZ_KEY_SOURCES` (currently a placeholder).
3. Measure Unit Key bounce, range and interference; do a full dress rehearsal.

