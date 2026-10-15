# Changelog

## 0.2.0

Evoluzione collaborativa con server concorrente, migrazioni, revisioni e conflitti, cestino, archivio, commenti, cronologia, import/export versionati, account opzionali e permessi per bacheca. L'interfaccia aggiunge bozze recuperabili, link diretti, viste statistiche e calendario, tema e densità configurabili.

L'elenco completo e verificabile è in [docs/MIGLIORIE_100.md](docs/MIGLIORIE_100.md).

Nuova dipendenza di compilazione: OpenSSL libcrypto e pkg-config. Il database della versione iniziale viene aggiornato senza reinserire i dati dimostrativi; prima della migrazione viene creata una copia con suffisso `.pre-vN.bak`.

## 0.1.0

Prima versione locale: server C, SQLite, bacheche, colonne e schede, checklist, scadenze, ricerca e trascinamento. Licenza MIT.
