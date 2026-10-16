# Changelog

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
