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

* `http://localhost:8080/questions` (o il pulsante *Domande* nel pannello): elenco di sola lettura di tutte le domande con la
  risposta corretta. All'apertura e' nascosto e il contenuto non viene nemmeno scaricato finche' non premi *Mostra*;
  *Nascondi*, `Esc`, il cambio di scheda o 60 s senza attivita' lo nascondono di nuovo e lo cancellano dalla pagina.
  Con `--token` serve anche qui. Mostra anche il numero di opzioni supportate.

Svolgimento: *Prossima domanda* -> le squadre rispondono (si chiude da solo quando tutte hanno risposto, o allo
scadere) -> *Mostra la risposta* -> *Prossima domanda*. Alla fine *Vai alla classifica*. *Scarica risultati* produce un CSV.
Risposte per domanda: i dispositivi hanno 4 tasti, quindi il server accetta al massimo 4 risposte per domanda
(`--options N`, da 3 a 5, default 4; non serve toccare il firmware). All'avvio (e con `validate`) il contenuto viene
controllato: se una domanda ha piu' risposte il server non parte e dice quale. Il valore e' mostrato nel pannello di controllo.
Nel pannello, le impostazioni diverse dal predefinito sono evidenziate (con il valore predefinito accanto);
*Ripristina impostazioni* (vicino ad *Azzera partita*) le riporta tutte al predefinito senza toccare punteggi e dispositivi.
Se il server si ferma, riavvialo: punteggi, squadre e domanda in corso vengono ripresi da `data/state.json`.

## Domande e traduzioni

* [`content/quiz.json`](content/quiz.json): id, risposta corretta (indice da 0), tempo, punti, penalita'.
* [`content/texts/it.json`](content/texts/it.json): testo, risposte e spiegazione (lingua di riferimento, obbligatoria).
* [`content/texts/en.json`](content/texts/en.json): traduzione, anche parziale: le domande mancanti escono in italiano.
* Interfaccia: [`server/web/i18n/it.json`](server/web/i18n/it.json), [`en.json`](server/web/i18n/en.json). 
Per una nuova lingua copia `en.json` e traduci i valori.* `python3 -m quizzone validate` segnala errori (numero di risposte diverso, id sconosciuti...).

## Aspetto

Stile ripreso dal sito glow.earth (`docs/glow-website-branding.pdf`): rosa `#e61f5a`, arancio, verde acqua e blu del
sito, font Poppins (inclusa in `server/web/static/fonts/`, licenza OFL), logo in `server/web/static/img/`.
Lo sfondo e' chiaro di proposito: con il proiettore in una sala illuminata un fondo scuro si "lava" e diventa grigio,
mentre testo scuro su bianco resta leggibile. Per questo: contrasto alto, bordi spessi, testo grande, e ogni stato
(risposta data, giusta, sbagliata, poco tempo) ha anche un simbolo o una parola, non solo un colore.
Tutti i colori sono variabili in `server/web/static/theme.css`.

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

