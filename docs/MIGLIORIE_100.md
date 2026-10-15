# Le 100 migliorie di OpenBoard

Obiettivo: evolvere la base locale in un'applicazione collaborativa mantenendo C e SQLite. Ogni voce identifica una capacità concreta; la spunta viene aggiunta dopo implementazione e verifica. Le funzionalità enterprise non incluse, come SSO/SAML, allegati, SCIM e alta disponibilità, restano nella roadmap dello studio.

## Server e protocollo

- [x] 001 Pool di worker HTTP con connessioni SQLite separate.
- [x] 002 Coda di connessioni limitata e risposta di sovraccarico.
- [x] 003 Scadenza totale per la lettura degli header.
- [x] 004 Scadenza totale per la lettura del corpo.
- [x] 005 Scadenza totale per l'invio della risposta.
- [x] 006 Arresto ordinato dei worker e delle connessioni.
- [x] 007 Identificatore univoco di richiesta nelle risposte.
- [x] 008 Log HTTP strutturati senza credenziali o corpi.
- [x] 009 Origine pubblica configurabile per proxy HTTPS.
- [x] 010 Readiness con controllo del database.
- [x] 011 Endpoint versione applicativa e SQLite.
- [x] 012 Cache condizionale degli asset con ETag.
- [x] 013 Parametri query decodificati e limitati.
- [x] 014 Supporto HEAD sulle risorse GET dell'API.
- [x] 015 Rifiuto degli header di autenticazione e controllo duplicati.

## Persistenza e operazioni di dominio

- [x] 016 Migrazioni dello schema numerate e transazionali.
- [x] 017 Rifiuto degli schemi di database futuri non supportati.
- [x] 018 Backup automatico prima della migrazione.
- [x] 019 Date di creazione e aggiornamento delle risorse.
- [x] 020 Revisioni di bacheche, colonne e schede.
- [x] 021 Controllo atomico delle revisioni con If-Match.
- [x] 022 Endpoint di dettaglio della singola scheda.
- [x] 023 Cancellazione recuperabile delle schede.
- [x] 024 Cancellazione recuperabile delle colonne.
- [x] 025 Cancellazione recuperabile delle bacheche.
- [x] 026 Ripristino coerente delle gerarchie cancellate.
- [x] 027 Archiviazione di schede e bacheche.
- [x] 028 Elenco del cestino filtrato per accesso.
- [x] 029 Duplicazione delle schede.
- [x] 030 Duplicazione delle bacheche.
- [x] 031 Riordino delle colonne.
- [x] 032 Limiti WIP delle colonne applicati dal server.
- [x] 033 Priorità delle schede.
- [x] 034 Etichette multiple per scheda.
- [x] 035 Stima dell'impegno in minuti.
- [x] 036 Snapshot riassuntivo della bacheca.
- [x] 037 Commenti alle schede con autore e cancellazione autorizzata.
- [x] 038 Cronologia persistente delle attività.
- [x] 039 Ricerca trasversale alle bacheche autorizzate.
- [x] 040 Statistiche della bacheca.
- [x] 041 Esportazione OpenBoard con formato versionato.
- [x] 042 Importazione OpenBoard validata e transazionale.
- [x] 043 Creazioni idempotenti tramite identificatore di richiesta.
- [x] 044 Comando di backup SQLite consistente.
- [x] 045 Gestione recuperabile degli errori SQL nelle richieste.

## Identità e permessi

- [x] 046 Configurazione iniziale dell'amministratore.
- [x] 047 Login con account individuale.
- [x] 048 Logout con revoca della sessione.
- [x] 049 Password protette con derivazione lenta e salt casuale.
- [x] 050 Token di sessione casuali memorizzati come hash.
- [x] 051 Protezione CSRF delle scritture autenticate.
- [x] 052 Scadenza inattiva e assoluta delle sessioni.
- [x] 053 Limiti ai tentativi di autenticazione.
- [x] 054 Creazione degli utenti da parte dell'amministratore.
- [x] 055 Elenco degli utenti amministrabile.
- [x] 056 Gestione dei ruoli degli utenti.
- [x] 057 Disattivazione account con revoca delle sessioni.
- [x] 058 Appartenenza e ruoli nelle singole bacheche.
- [x] 059 Ruolo osservatore senza permessi di scrittura.
- [x] 060 Isolamento delle letture tra bacheche non condivise.
- [x] 061 Cambio della propria password.
- [x] 062 Preferiti personali per utente.
- [x] 063 Nomi utente univoci senza distinzione di maiuscole.
- [x] 064 Validazione delle credenziali e delle lunghezze.
- [x] 065 Protezione dell'ultimo amministratore attivo.

## Interfaccia e collaborazione

- [x] 066 Interfaccia di configurazione iniziale e login.
- [x] 067 Comando di logout nell'interfaccia.
- [x] 068 Pannello di amministrazione utenti.
- [x] 069 Gestione dei membri della bacheca.
- [x] 070 Gestione visibile dei conflitti con bozza conservata.
- [x] 071 Recupero delle bozze delle schede.
- [x] 072 Protezione delle modifiche non salvate alla chiusura.
- [x] 073 Distinzione tra scrittura confermata e aggiornamento fallito.
- [x] 074 Link diretti alle bacheche e alle schede.
- [x] 075 Navigazione Indietro e Avanti.
- [x] 076 Comando di duplicazione scheda.
- [x] 077 Comando di duplicazione bacheca.
- [x] 078 Cestino e ripristino nell'interfaccia.
- [x] 079 Consultazione e ripristino degli elementi archiviati.
- [x] 080 Priorità nell'editor e nei filtri.
- [x] 081 Selezione di etichette multiple.
- [x] 082 Configurazione e visualizzazione del limite WIP.
- [x] 083 Riordino delle colonne dall'interfaccia.
- [x] 084 Spostamento con scelta della posizione senza trascinamento.
- [x] 085 Commenti nell'editor della scheda.
- [x] 086 Pannello della cronologia delle attività.
- [x] 087 Ricerca globale con apertura del risultato.
- [x] 088 Filtri per scadenza superata e completamento.
- [x] 089 Ordinamento per scadenza e priorità.
- [x] 090 Vista delle statistiche della bacheca.
- [x] 091 Vista calendario delle scadenze.
- [x] 092 Anteprima prima dell'importazione JSON.
- [x] 093 Esportazione dello stato autorevole dal server.
- [x] 094 Contrasto e leggibilità migliorati.
- [x] 095 Nomi accessibili dei dialog e ritorno del focus.
- [x] 096 Focus stabile durante la modifica della checklist.
- [x] 097 Vista elenco mobile senza tagli delle colonne.
- [x] 098 Tema chiaro e scuro persistente.
- [x] 099 Densità dell'interfaccia configurabile e persistente.
- [x] 100 Aggiornamenti automatici tra sessioni con protezione delle bozze.

## Verifica finale

Le spunte attestano le capacità realizzate, non una certificazione di sicurezza o la parità completa con Trello Enterprise. Test API, regressioni, build con sanitizer e prove nel browser documentano il perimetro verificato. Account e permessi si attivano esplicitamente con `--auth`; l'istanza resta su loopback e il setup amministrativo va completato localmente prima di configurare un proxy.

Verifica eseguita il 15 ottobre 2026 su macOS:

| Interventi | Implementazione | Evidenza |
| --- | --- | --- |
| 001–015 | `src/http.c`, `src/openboard.h` | 7 test di trasporto: concorrenza, timeout totale header, sovraccarico, Host/Origin, duplicati, HEAD, ETag e CLI; revisione dei timeout di corpo e invio e dell'arresto ordinato. |
| 016–045 | `src/server.c` | 11 test di dominio: migrazioni e backup, schema futuro, conflitti paralleli, idempotenza parallela, WIP con rollback, gerarchie del cestino, archivi, import/export e recupero dagli errori SQL. |
| 046–065 | `src/auth.c`, `src/auth.h` | 15 test di autenticazione: storage hash, CSRF, isolamento, ruoli, revoca, scadenze, rate limit, password e ultimo amministratore. |
| 066–100 | `web/app.js`, `web/index.html`, `web/styles.css` | Controllo sintassi e ID HTML; prove manuali nel browser su flussi rappresentativi, indicate sotto. |
| Regressioni 0.1 | API pubbliche preesistenti | 9 test precedenti mantenuti. |

`make test`: **42 test superati**. `make test-sanitize`: **42 test superati** con AddressSanitizer e UndefinedBehaviorSanitizer. Le due esecuzioni usano database temporanei. La CI è configurata per macOS e Ubuntu; questa verifica locale non attesta l'esecuzione remota della CI.

Dopo la correzione del nome massimo della bacheca duplicata, gli 11 test di dominio sono stati rieseguiti con e senza sanitizer. L'editor è stato inoltre verificato con commento e attività ancora da aggiungere: il salvataggio conserva i testi e porta il focus al campo da completare. Il link diretto alla scheda è stato aperto dopo logout e nuovo login. La vista elenco a 390 pixel non produce scorrimento orizzontale della pagina; sono salvate le anteprime [desktop](preview.jpg) e [mobile](preview-mobile.jpg).

Le prove manuali nel browser hanno verificato login, salvataggio con priorità/etichette/stima/checklist, conservazione del focus nella checklist, commenti, statistiche, calendario, attività, ricerca globale e apertura dei risultati, link diretti, conflitto tra due sessioni con bozza conservata e recuperabile, duplicazione, spostamento per posizione, archivio, pannelli utenti e membri, importazione con anteprima e persistenza di tema/densità. La prova di conflitto usa una seconda sessione API reale. I controlli del browser sono manuali e non costituiscono una suite E2E automatizzata né un audit completo di accessibilità.

La vista calendario è un'agenda raggruppata per data. Le etichette sono selezionabili dal vocabolario previsto. L'esportazione JSON conserva bacheca, liste e schede; account, commenti, cronologia e cestino richiedono il backup SQLite. Gli aggiornamenti tra sessioni usano polling ogni cinque secondi mentre la pagina è visibile.
