# Contribuire a OpenBoard

Le proposte, le segnalazioni di bug e le pull request sono benvenute.

1. Compila con `make` e avvia con `make run`.
2. Mantieni il backend in C11/POSIX e l'interfaccia senza dipendenze esterne.
3. Usa statement preparati per il database e verifica i dati ricevuti dalle API.
4. Per modifiche al comportamento delle API, aggiungi una verifica significativa nella suite pertinente in `tests/`.
5. Esegui `make test` e, per il codice C, `make test-sanitize`; per modifiche all'interfaccia controlla anche tastiera, layout mobile, bozze, conflitti e ruoli osservatore.

Nella proposta descrivi il problema, il comportamento risultante e la verifica effettuata. Non includere database personali, eseguibili o dati sensibili.

Le aree future comprendono automazioni, SSO, integrazioni e distribuzione ad alta disponibilità. La versione 0.6 comprende account e permessi, allegati e notifiche, pianificazione, revisioni, portfolio, sprint e moduli interni. I contratti delle API, gli elenchi numerati e il perimetro verificato sono documentati in `docs/`.
