# Contribuire a OpenBoard

Le proposte, le segnalazioni di bug e le pull request sono benvenute.

1. Compila con `make` e avvia con `make run`.
2. Mantieni il backend in C11/POSIX e l'interfaccia senza dipendenze esterne.
3. Usa statement preparati per il database e verifica i dati ricevuti dalle API.
4. Per modifiche al comportamento delle API, aggiungi una verifica significativa in `tests/test_api.py`.
5. Esegui `make test`; per modifiche all'interfaccia controlla anche tastiera, layout mobile e stati vuoti.

Nella proposta descrivi il problema, il comportamento risultante e la verifica effettuata. Non includere database personali, eseguibili o dati sensibili.

Le aree di sviluppo future comprendono autenticazione, permessi per bacheca, aggiornamenti in tempo reale e importazione delle esportazioni JSON. Vanno progettate insieme al relativo modello dei dati prima di esporre il server su una rete condivisa.
