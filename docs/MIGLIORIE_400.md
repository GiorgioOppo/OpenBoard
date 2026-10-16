# Quarto gruppo di 100 migliorie di OpenBoard

OpenBoard 0.5 aggiunge revisioni formali sulle schede e un portfolio fra bacheche. La numerazione continua da 301 a 400. Le voci API e le corrispondenti interazioni dell'interfaccia sono interventi separati, come nei gruppi precedenti. Le spunte attestano l'implementazione nel perimetro di verifica descritto in fondo.

## Revisioni e approvazioni: API

- [x] 301 Creazione di una richiesta di revisione con titolo e descrizione.
- [x] 302 Assegnazione di uno o più revisori fra i membri attivi.
- [x] 303 Approvazione richiesta a tutti i revisori oppure ad almeno uno.
- [x] 304 Elenco delle revisioni della scheda.
- [x] 305 Dettagli della richiesta con decisioni dei revisori.
- [x] 306 Modifica di titolo, descrizione e scadenza della richiesta.
- [x] 307 Sostituzione dei revisori con invalidazione dei voti precedenti.
- [x] 308 Approvazione personale della richiesta.
- [x] 309 Richiesta di modifiche con una motivazione obbligatoria.
- [x] 310 Ritiro della propria decisione.
- [x] 311 Annullamento di una richiesta di revisione.
- [x] 312 Riapertura con nuovo ciclo e azzeramento dei voti.
- [x] 313 Rimozione recuperabile di una revisione.
- [x] 314 Ripristino di una revisione rimossa.
- [x] 315 Cronologia paginata delle decisioni e dei cambiamenti.
- [x] 316 Inbox delle revisioni della bacheca.
- [x] 317 Inbox personale delle richieste da revisionare.
- [x] 318 Filtro delle revisioni scadute.
- [x] 319 Filtro delle revisioni per revisore.
- [x] 320 Filtro delle revisioni per richiedente.
- [x] 321 Stato aggregato autorevole, con controllo delle abilitazioni correnti.
- [x] 322 Statistiche delle revisioni della bacheca.
- [x] 323 Esportazione CSV delle revisioni filtrate.
- [x] 324 Riepilogo dello stato delle revisioni della singola scheda.
- [x] 325 Duplicazione di una richiesta su una scheda della stessa bacheca.

## Portfolio e report: API

- [x] 326 Riepilogo complessivo delle bacheche accessibili.
- [x] 327 Indicatori separati per ogni bacheca del portfolio.
- [x] 328 Ricerca testuale delle schede fra più bacheche.
- [x] 329 Filtro per stato, blocco, ritardo, scadenza imminente o assegnazione mancante.
- [x] 330 Filtro per account assegnatario.
- [x] 331 Filtro per priorità.
- [x] 332 Filtro per etichetta.
- [x] 333 Filtro per bacheca.
- [x] 334 Filtro per intervallo delle scadenze.
- [x] 335 Paginazione deterministica della ricerca nel portfolio.
- [x] 336 Creazione di un report personale con filtri salvati.
- [x] 337 Elenco dei propri report salvati.
- [x] 338 Modifica di nome e filtri di un report.
- [x] 339 Eliminazione di un report personale.
- [x] 340 Duplicazione di un report personale.
- [x] 341 Report fissati per l'accesso frequente.
- [x] 342 Serie giornaliera delle attività delle bacheche accessibili.
- [x] 343 Distribuzione delle schede in ritardo per fasce di anzianità.
- [x] 344 Carico di lavoro per account fra più bacheche.
- [x] 345 Confronto fra stime e tempo effettivo, incluse le registrazioni.
- [x] 346 Individuazione dei colli di bottiglia delle liste con limiti WIP.
- [x] 347 Avanzamento aggregato delle checklist.
- [x] 348 Elenco dei blocchi dovuti a dipendenze incompiute.
- [x] 349 Avanzamento dei traguardi fra più bacheche.
- [x] 350 Esportazione CSV delle schede del portfolio filtrato.

## Revisioni e approvazioni: interfaccia

- [x] 351 Apertura delle revisioni dall'editor della scheda.
- [x] 352 Composizione del titolo e della descrizione di una richiesta.
- [x] 353 Impostazione della scadenza della revisione.
- [x] 354 Selezione multipla dei revisori autorizzati.
- [x] 355 Scelta della regola di approvazione dal catalogo API.
- [x] 356 Consultazione dell'inbox delle revisioni della bacheca.
- [x] 357 Consultazione della propria inbox di revisione.
- [x] 358 Filtro visivo delle revisioni per stato.
- [x] 359 Filtro visivo delle revisioni scadute.
- [x] 360 Filtro visivo delle revisioni per revisore.
- [x] 361 Filtro visivo delle revisioni per richiedente.
- [x] 362 Lettura delle decisioni e dell'abilitazione attuale dei revisori.
- [x] 363 Modifica dei dettagli di una richiesta dall'interfaccia.
- [x] 364 Sostituzione dei revisori dall'interfaccia.
- [x] 365 Approvazione con nota facoltativa.
- [x] 366 Richiesta di modifiche con motivazione.
- [x] 367 Ritiro del proprio voto dall'interfaccia.
- [x] 368 Annullamento della richiesta dall'interfaccia.
- [x] 369 Riapertura della richiesta dall'interfaccia.
- [x] 370 Consultazione del cestino delle revisioni.
- [x] 371 Ripristino di una revisione dal cestino.
- [x] 372 Consultazione paginata della cronologia delle revisioni.
- [x] 373 Download CSV delle revisioni filtrate.
- [x] 374 Duplicazione con scelta della scheda di destinazione.
- [x] 375 Visualizzazione del riepilogo e delle statistiche delle revisioni.

## Portfolio e report: interfaccia

- [x] 376 Consultazione dei totali del portfolio.
- [x] 377 Indicatori per bacheca e navigazione alla bacheca selezionata.
- [x] 378 Ricerca testuale delle schede fra bacheche dall'interfaccia.
- [x] 379 Filtro del portfolio per stato della scheda.
- [x] 380 Filtro del portfolio per assegnatario.
- [x] 381 Filtro del portfolio per priorità.
- [x] 382 Filtro del portfolio per etichetta.
- [x] 383 Filtro del portfolio per bacheca.
- [x] 384 Selezione dell'intervallo delle scadenze del portfolio.
- [x] 385 Caricamento delle pagine successive del portfolio.
- [x] 386 Salvataggio dei filtri correnti come report personale.
- [x] 387 Consultazione dei propri report salvati.
- [x] 388 Applicazione di un report alla ricerca del portfolio.
- [x] 389 Modifica del nome e dei filtri di un report dall'interfaccia.
- [x] 390 Eliminazione di un report dall'interfaccia.
- [x] 391 Duplicazione di un report dall'interfaccia.
- [x] 392 Comandi per fissare e rilasciare i report preferiti.
- [x] 393 Lettura dell'attività giornaliera fra bacheche.
- [x] 394 Lettura delle fasce di ritardo delle scadenze.
- [x] 395 Lettura del carico e dell'impegno per persona.
- [x] 396 Lettura dello scostamento tra stima e tempo effettivo.
- [x] 397 Lettura dei colli di bottiglia WIP.
- [x] 398 Lettura dell'avanzamento delle checklist del portfolio.
- [x] 399 Consultazione delle dipendenze bloccanti e dei traguardi fra bacheche.
- [x] 400 Download CSV del portfolio filtrato.

## Integrazione e verifica

L'implementazione mantiene il backend C limitato alle API autenticate e il frontend statico separato. Lo schema locale 6 aggiunge richieste, revisori, voti, cronologia e report; i filtri JSON dei report appartengono a MongoDB nello stack esterno, mentre i dati strutturati appartengono a PostgreSQL. La migrazione esterna 5 → 6 deve preservare le righe e i riferimenti JSON già presenti.

Le revisioni sono strumenti di coordinamento: non impediscono automaticamente il completamento di una scheda. Un report personale conserva i filtri, senza concedere accesso alle bacheche rimosse dai permessi dell'utente.

| Area | Evidenza |
|---|---|
| Revisioni 301–325 | `src/reviews.c`, `tests/test_reviews.py`: ciclo completo, quorum, voti, autoapprovazione vietata, osservatori, revoche permanenti, conflitti, paginazione, quote, CSV, rollback e idempotenza |
| Portfolio 326–350 | `src/portfolio.c`, `tests/test_portfolio.py`: filtri, paginazione, aggregati, antenati eliminati, archivio, permessi revocati, proprietà dei report, versioni e CSV |
| Interfaccia 351–400 | `web/enterprise.js`, `tests/test_enterprise.js`: rendering ostile, risposte tardive, bozze, conflitti, report, CSV e navigazione; prove browser indicate sotto |
| Migrazioni | `tests/test_release_05.py` con `fixtures/openboard_v5.sql` generata dal binario 0.4; conservati campi, zero numerico, checklist, tempo e risposte ai commenti, backup privato e riavvio |
| PostgreSQL/MongoDB | `tests/test_cloud.py`: nove casi eseguiti con database Docker temporanei, incluse persistenza di voti/report dopo ricostruzione della cache, BSON tipizzato, backup e rollback della migrazione con documento mancante |
| Distribuzione frontend | Asset esplicitamente autorizzati sia nel server di sviluppo sia in Nginx; verifiche HTTP in `test_dev_frontend.py` e `test_frontend_static.py` |
| Regressioni | Suite Python completa: 138 casi scoperti, 127 eseguiti e 11 opt-in saltati; ripetuta con ASAN/UBSAN. I casi di storage e container sono verificati separatamente. `make test-frontend`, `actionlint`, Compose config e `git diff --check` |

Nel browser, su un'istanza autenticata con dati dimostrativi separati, sono stati verificati panoramica del portfolio, inbox personale, dettaglio di revisione, approvazione con nota e cambio di stato, creazione di una richiesta con revisore selezionato, navigazione alla scheda, ricerca testuale e salvataggio di un report fissato. A 390 px, filtri e report non generano overflow orizzontale della pagina o del pannello. Le immagini `preview-portfolio.png` e `preview-reviews.png` documentano le schermate; non rappresentano dati personali.

Non ogni interazione è stata ripetuta manualmente nel browser: i contratti e i casi avversi sono coperti dai test automatici descritti sopra. Gli elenchi di analisi sono limitati a 100 righe e il CSV del portfolio si scarica per pagine. Il CSV delle revisioni comprende fino a 1000 righe e rifiuta un risultato più grande, chiedendo di restringere i filtri. Il carico multi-assegnatario attribuisce la scheda a ogni persona assegnata, quindi i totali individuali non vanno sommati per ricavare il totale del portfolio. L'attività giornaliera riguarda gli eventi delle bacheche; gli altri indicatori operano sulle schede.

Le revisioni non inviano email, non implementano firme elettroniche e non bloccano automaticamente il completamento delle schede. La persistenza esterna mantiene il limite di snapshot completo e transazioni serializzate già documentato nella [guida di installazione](DEPLOYMENT.md); questa versione non introduce SSO, SCIM o alta disponibilità.
