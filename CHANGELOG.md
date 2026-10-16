# Changelog

## 0.5.0

Quarto gruppo di 100 interventi: revisioni delle schede con revisori nominativi, quorum tutti/almeno uno, decisioni motivate, ritiro del voto, annullamento, riapertura, duplicazione, cestino, cronologia e inbox filtrate. Nessuna autoapprovazione; autorizzazioni correnti e invalidazione permanente dei voti alla revoca dei permessi. Conflitti gestiti tramite versioni.

Portfolio autorizzato fra bacheche, ricerca paginata, report personali modificabili e fissabili, attività giornaliera, fasce di ritardo, carico per persona, confronto stime/tempo, WIP, checklist, dipendenze e traguardi. CSV protetti dalle formule dei fogli di calcolo. Interfaccia responsive con bozze personali, gestione dei conflitti e protezione dalle risposte tardive. [Elenco 301–400 e verifiche](docs/MIGLIORIE_400.md).

Schema SQLite 6 con backup precedente, migrazione esterna esplicita 5 → 6 sotto lock PostgreSQL e rollback se la ricostruzione fallisce. Dati strutturati delle revisioni in SQL, filtri JSON dei report in MongoDB. Immagini backend/frontend 0.5 separate; nuovi asset inclusi nelle whitelist di Nginx e del server di sviluppo.

## 0.4.0

Terzo gruppo di 100 interventi: campi personalizzati tipizzati, traguardi, azioni multiple per priorità/etichette/traguardi, linee guida e carico di lavoro. Registrazioni del tempo con cestino, riepiloghi per scheda, bacheca e settimana personale, CSV dal server. Risposte ai commenti, reazioni, commenti in evidenza, segnalibri personali e notifiche filtrate prima della paginazione.

Interfaccia con gestione dei campi, traguardi, report e vista tabellare. Le bozze delle risposte sopravvivono ai refresh; risposte HTTP tardive non sovrascrivono filtri e segnalibri. Schema locale 5 con backup prima della migrazione. JSON v2 comprende definizioni, valori e traguardi; il backup completo conserva le relazioni personali e collaborative. [Elenco 201–300 e verifiche](docs/MIGLIORIE_300.md).

Docker Compose separa backend C con sole API autenticate, frontend statico, PostgreSQL, MongoDB e Nginx Proxy Manager. Il binario e la sua immagine non contengono asset grafici; autenticazione predefinita e modalità senza account solo esplicita su loopback. Il frontend carica dati e cataloghi dalle API sulla stessa origine. PostgreSQL conserva colonne scalari tipizzate e riferimenti ai documenti JSON immutabili in MongoDB; SQLite diventa una cache ricostruibile. Commit SQL e lock tra processi coordinano la pubblicazione degli snapshot. Modalità locale SQLite conservata. Volumi persistenti separati, credenziali generate e reti private; [gestione e limiti](docs/DEPLOYMENT.md).

## 0.3.0

Secondo gruppo di 100 interventi: pianificazione e blocchi, tempo effettivo, assegnazioni multiple a utenti, attività personali, dipendenze senza cicli, template personali, filtri salvati e azioni multiple atomiche. Notifiche interne con sottoscrizioni, allegati recuperabili nel database, modifica dei commenti, profilo e revoca delle sessioni.

L'interfaccia include timer manuale, anteprima Markdown, export CSV e iCalendar, comandi rapidi e nuove funzioni per i team. Installazione con PREFIX/DESTDIR, Docker/Compose Linux, esempio systemd/nginx, configurazione da ambiente, metriche e manutenzione SQLite. Lo schema passa alla versione 4 con backup precedente.

Elenco e verifiche in [docs/MIGLIORIE_200.md](docs/MIGLIORIE_200.md). JSON v2 conserva i nuovi campi scalari delle schede; relazioni fra account, dipendenze, allegati e notifiche richiedono il backup SQLite.

## 0.2.0

Evoluzione collaborativa con server concorrente, migrazioni, revisioni e conflitti, cestino, archivio, commenti, cronologia, import/export versionati, account opzionali e permessi per bacheca. L'interfaccia aggiunge bozze recuperabili, link diretti, viste statistiche e calendario, tema e densità configurabili.

L'elenco completo e verificabile è in [docs/MIGLIORIE_100.md](docs/MIGLIORIE_100.md).

Nuova dipendenza di compilazione: OpenSSL libcrypto e pkg-config. Il database della versione iniziale viene aggiornato senza reinserire i dati dimostrativi; prima della migrazione viene creata una copia con suffisso `.pre-vN.bak`.

## 0.1.0

Prima versione locale: server C, SQLite, bacheche, colonne e schede, checklist, scadenze, ricerca e trascinamento. Licenza MIT.
