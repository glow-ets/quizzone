# Quizzone scientifico

Quiz a squadre per circa 15 gruppi: la domanda e le risposte (3-5) compaiono sul grande schermo, ogni squadra ha un dispositivo (micro:bit su edu:bit con pulsanti M5Stack) e **il primo tasto premuto blocca la risposta**. Risposte sbagliate tolgono punti. Il server gira su Windows, macOS e Linux.

```
squadre (micro:bit, radio) ))) base (micro:bit via USB) --- PC (server Python) --- browser: schermo + controllo
```

## Installazione (una volta)

1. Python 3.9 o piu' recente.
2. `pip install pyserial` (serve solo per il collegamento USB con la base; per provare senza hardware non serve).
3. Firmware: vedi `docs/HARDWARE.md` (prima fase: sonda dei pin).

## Uso

```
PYTHONPATH=server python3 -m quizzone validate           # controlla le domande
PYTHONPATH=server python3 -m quizzone ports              # elenca le porte (cerca [micro:bit])
PYTHONPATH=server python3 -m quizzone run                # avvia con la base collegata
PYTHONPATH=server python3 -m quizzone run --sim 12       # DEMO senza hardware: 12 squadre virtuali
```

Poi apri nel browser del PC:

* `http://localhost:8080/` sul proiettore (schermo grande, a tutto schermo con F11);
* `http://localhost:8080/control` per chi conduce.

Per comandare da un telefono: `run --host 0.0.0.0 --token LAPAROLA`, poi apri `http://IP-DEL-PC:8080/control?token=LAPAROLA`.
Senza `--token` chiunque nella rete puo' comandare il quiz.

Svolgimento: *Prossima domanda* -> le squadre rispondono (si chiude da solo quando tutte hanno risposto, o allo
scadere) -> *Mostra la risposta* -> *Prossima domanda*. Alla fine *Vai alla classifica*. *Scarica risultati* produce un CSV.
Se il server si ferma, riavvialo: punteggi, squadre e domanda in corso vengono ripresi da `data/state.json`.

## Domande e traduzioni

* [`content/quiz.json`](content/quiz.json): id, risposta corretta (indice da 0), tempo, punti, penalita'.
* [`content/texts/it.json`](content/texts/it.json): testo, risposte e spiegazione (lingua di riferimento, obbligatoria).
* [`content/texts/en.json`](content/texts/en.json): traduzione, anche parziale: le domande mancanti escono in italiano.
* Interfaccia: [`server/web/i18n/it.json`](server/web/i18n/it.json), [`en.json`](server/web/i18n/en.json). 
Per una nuova lingua copia `en.json` e traduci i valori.* `python3 -m quizzone validate` segnala errori (numero di risposte diverso, id sconosciuti...).

## Aspetto

Tutti i colori sono variabili in `server/web/static/theme.css`. I colori attuali sono provvisori: il sito glow.earth
non era raggiungibile durante lo sviluppo, quindi lo stile non e' stato confrontato con il sito.

## Struttura

| cartella | contenuto |
|----------|-----------|
| [`firmware/src`](firmware/src/) | firmware MakeCode (TypeScript): squadra, base, sonda |
| [`firmware/tools`](firmware/tools/) | build, controllo tipi, ponte di simulazione in tempo reale |
| [`firmware/tests`](firmware/tests/) | simulatore radio e test del firmware |
| [`server/quizzone`](server/quizzone/) | motore di gioco, protocollo, server HTTP |
| [`server/web`](server/web/) | schermo, controllo, traduzioni |
| [`protocol`](protocol/) | specifica e vettori di test condivisi |
| [`docs`](docs/) | hardware e protocollo di collaudo |

## Sviluppo

Vedi [docs/DEV.md](DEV.md)

Test: vedi [docs/TEST_PROTOCOL.md](docs/TEST_PROTOCOL.md). Specifica: `protocol/PROTOCOL.md`.

