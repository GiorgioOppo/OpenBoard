# Sprint e capacità — OpenBoard 0.6

Gli sprint organizzano schede esistenti della stessa bacheca in iterazioni pianificate, attive o chiuse. Sono richiesti account autenticato, accesso attuale alla bacheca e, per le mutazioni, token CSRF e origine valida. In modalità `--no-auth` queste API restituiscono `403`; in modalità autenticata gli anonimi ricevono `401`.

## Le 25 migliorie 401–425

| ID | Miglioria | Metodo e percorso |
|---|---|---|
| 401 | Creazione con nome, obiettivo e intervallo | `POST /api/boards/{board}/sprints` |
| 402 | Elenco della bacheca con ricerca, stato e cursore | `GET /api/boards/{board}/sprints` |
| 403 | Dettaglio con permessi correnti | `GET /api/sprints/{id}` |
| 404 | Modifica di nome, obiettivo e date | `PATCH /api/sprints/{id}` |
| 405 | Attivazione di un solo sprint per bacheca | `POST /api/sprints/{id}/activate` |
| 406 | Chiusura senza completare artificialmente le schede | `POST /api/sprints/{id}/close` |
| 407 | Riapertura come pianificato con verifica conflitti | `POST /api/sprints/{id}/reopen` |
| 408 | Eliminazione recuperabile | `DELETE /api/sprints/{id}` |
| 409 | Ripristino con verifica sprint attivi e assegnazioni | `POST /api/sprints/{id}/restore` |
| 410 | Inserimento di una scheda esistente | `POST /api/sprints/{id}/cards` |
| 411 | Rimozione di una scheda dallo sprint | `DELETE /api/sprints/{id}/cards/{card}` |
| 412 | Pianificazione atomica di massimo 100 schede | `POST /api/sprints/{id}/cards/bulk` |
| 413 | Rimozione atomica di massimo 100 schede | `DELETE /api/sprints/{id}/cards/bulk` |
| 414 | Backlog delle schede non pianificate | `GET /api/boards/{board}/backlog` |
| 415 | Schede filtrate per ricerca, stato, priorità e assegnatario | `GET /api/sprints/{id}/cards` |
| 416 | Capacità dichiarata per membro attivo scrivente | `GET /api/sprints/{id}/capacity`; `PATCH /capacity/{user}` |
| 417 | Carichi individuali con ripartizione esatta delle schede condivise | `GET /api/sprints/{id}/capacity-report` |
| 418 | Fotografia esplicita della giornata UTC corrente | `POST /api/sprints/{id}/snapshots` |
| 419 | Serie delle fotografie storiche | `GET /api/sprints/{id}/snapshots` |
| 420 | Eliminazione di una fotografia errata | `DELETE /api/sprints/{id}/snapshots/{YYYY-MM-DD}` |
| 421 | Avanzamento da schede, stime e registrazioni reali | `GET /api/sprints/{id}/progress` |
| 422 | Confronto descrittivo tra residuo stimato e capacità | `GET /api/sprints/{id}/forecast` |
| 423 | Attività personali negli sprint attivi accessibili | `GET /api/me/sprint-tasks` |
| 424 | Piano CSV con protezione dalle formule | `GET /api/sprints/{id}/export` |
| 425 | Storico delle modifiche con cursore | `GET /api/sprints/{id}/history` |

## Creazione, dettaglio e permessi

Creazione:

```json
{"name":"Sprint accessibilità","goal":"Completare i flussi da tastiera","start_date":"2026-11-02","end_date":"2026-11-13"}
```

`name` è obbligatorio, contiene almeno un carattere diverso da spazi e ha massimo 120 caratteri; `goal` è facoltativo, massimo 4000 caratteri. Le date sono facoltative, vuote oppure date reali `YYYY-MM-DD`, con anno almeno 1900. Quando presenti entrambe, l'inizio non supera la fine. Non sono imposti durata, giorni lavorativi o calendario aziendale. Una modifica accetta almeno un campo tra questi quattro; una stringa vuota rimuove obiettivo o data. Campi sconosciuti, NUL, tipi errati e valori fuori limite restituiscono `400`.

Il dettaglio è restituito con `201` alla creazione e con `200` nelle altre mutazioni:

```json
{"id":2,"board_id":1,"name":"Sprint accessibilità","goal":"Completare i flussi da tastiera","start_date":"2026-11-02","end_date":"2026-11-13","state":"planned","creator_id":1,"version":1,"deleted_at":null,"created_at":"2026-10-16T12:00:00.000Z","updated_at":"2026-10-16T12:00:00.000Z","permissions":{"manage":true,"schedule":true}}
```

Amministratori globali o della bacheca con accesso in scrittura gestiscono dettagli, ciclo di vita, capacità e fotografie. I membri scriventi possono aggiungere e rimuovere schede negli sprint pianificati o attivi. Gli osservatori possono leggere; non possono modificare uno sprint anche se erano creatori o amministratori prima della retrocessione. `permissions` riflette l'utente corrente e lo stato dello sprint. Risorse non accessibili o antenati eliminati restituiscono `404`; una mutazione vietata di una risorsa leggibile restituisce `403`.

Tutte le mutazioni di uno sprint esistente accettano `If-Match: "versione"` oppure un intero positivo senza virgolette. Una versione superata restituisce `412`, un header non valido `400`. Ogni modifica riuscita incrementa una volta la versione dello sprint, aggiorna quella della bacheca e registra evento e attività nella stessa transazione. La sostituzione di una fotografia odierna richiede sempre `If-Match`; se assente restituisce `409`.

I `POST` supportano l'idempotenza globale del router: stesso utente, percorso, chiave e corpo restituiscono il risultato originale; un corpo diverso con la stessa chiave restituisce `409`. Le risposte autenticate usano `Cache-Control: no-store`.

## Ciclo di vita e pianificazione

Gli endpoint `activate`, `close`, `reopen` e `restore` ricevono `{}`. La creazione produce `planned`; soltanto uno sprint pianificato può diventare `active`, e al massimo uno sprint non eliminato può essere attivo per bacheca. `close` richiede `active` e produce `closed`. La chiusura conserva appartenenze, capacità e fotografie e non modifica il completamento delle schede. Le schede ancora aperte possono quindi rimanere nello storico ed essere pianificate in un nuovo sprint.

`reopen` richiede `closed` e produce `planned`. Prima della riapertura il backend verifica che nessuna scheda tuttora appartenente alla bacheca sia già assegnata a un altro sprint pianificato o attivo: in tal caso restituisce `409` senza sottrarre schede al nuovo piano. La verifica include schede archiviate o cestinate e liste cestinate, che potrebbero essere ripristinate in seguito: nascondere una scheda non consente una doppia pianificazione. Le stesse verifiche valgono nel ripristino di uno sprint eliminato; uno sprint ripristinato conserva il suo stato precedente. Ripristinare uno sprint attivo mentre la bacheca ne ha già un altro attivo restituisce `409`.

Negli sprint chiusi non si modificano dettagli, schede o capacità; occorre riaprirli. L'eliminazione conserva tutti i dati. Il dettaglio e l'elenco ordinari escludono gli sprint eliminati; `include_deleted=1` li include per consentire il ripristino. Lo storico è leggibile anche dopo l'eliminazione. Gli altri aggregati e le liste collegate richiedono uno sprint non eliminato.

Un inserimento singolo usa `{"card_id":42}`. I batch usano `{"card_ids":[42,43]}`, con 1–100 interi positivi distinti, senza stringhe, booleani o decimali. Tutte le schede devono essere vive, non archiviate e appartenere a liste vive della stessa bacheca. Una scheda può appartenere a più sprint chiusi, ma a un solo sprint pianificato o attivo non eliminato. L'inserimento duplicato o in conflitto restituisce `409`; una scheda estranea o nascosta `404`. Rimuovere una scheda che non appartiene allo sprint restituisce `409`.

I batch verificano interamente l'input prima delle scritture e salvano oppure annullano tutte le appartenenze insieme. Anche errori di storico o di persistenza annullano schede, versioni e attività. I limiti sono 200 sprint per bacheca, compresi quelli eliminati; 1000 appartenenze per sprint; 10000 eventi per sprint. Le mutazioni che superano un limite restituiscono `409`.

## Elenchi, backlog e attività personali

L'elenco sprint, le liste di schede e lo storico restituiscono `{items,next_cursor}` e sono ordinati per ID decrescente. `limit` è 1–100, predefinito 30; `before` è un ID positivo ed esclude tale ID. `next_cursor` è l'ultimo ID restituito se esistono ulteriori risultati, altrimenti `null`. Gli ID mantengono la paginazione stabile rispetto a nuovi inserimenti. Conservare gli stessi filtri nelle pagine successive.

L'elenco sprint accetta `q`, `state=planned|active|closed`, `include_deleted=0|1`. La ricerca è una sottostringa letterale su nome e obiettivo. Le liste schede, il backlog, le attività personali e il CSV accettano:

| Parametro | Significato |
|---|---|
| `q` | Sottostringa letterale su titolo e descrizione, massimo 200 caratteri; `%` e `_` non sono wildcard. |
| `status` | `all` (predefinito), `open`, `completed`, `blocked`. |
| `priority` | `low`, `normal`, `high`, `urgent`; assente non restringe. |
| `assignee_id` | ID positivo presente negli assegnatari strutturati della scheda. |
| `before`, `limit` | Cursore e dimensione pagina. |

`blocked` include schede aperte con motivo di blocco o dipendenze incomplete tuttora leggibili e vive. Parametri duplicati o valori non validi restituiscono `400`. Le schede restituite contengono il riepilogo standard e `board_id`, `board_name`, `column_title`, `sprint_id`, `sprint_name`.

Il backlog comprende schede non archiviate che non appartengono a sprint pianificati o attivi non eliminati. Un'appartenenza storica a uno sprint chiuso non rimuove una scheda dal backlog. L'inbox personale include soltanto schede strutturalmente assegnate all'utente corrente in sprint attivi, in bacheche non archiviate tuttora accessibili. L'accesso è rivalutato dopo ogni revoca.

Tutti i conteggi, carichi, esportazioni e liste seguono la bacheca attuale della scheda e antenati vivi. Schede archiviate, eliminate o trasferite altrove mediante importazioni o interventi amministrativi non rivelano dati attraverso vecchie appartenenze.

## Capacità, avanzamento e confronto

`PATCH /api/sprints/{id}/capacity/{user}` riceve `{"minutes":2400}`. Il valore è intero tra 0 e 1000000. La persona deve essere attiva, membro effettivo della bacheca con accesso in scrittura e ruolo globale diverso da osservatore. Gli amministratori globali richiedono comunque una membership per ricevere capacità. Il valore zero è una dichiarazione esplicita, distinta da capacità non configurata.

`GET /capacity` restituisce `{items:[{user_id,name,minutes}]}` per tutti i membri attualmente idonei, anche senza configurazione, che vale zero. Rimozione dalla bacheca, retrocessione a osservatore e disattivazione eliminano la capacità memorizzata; un reinvito o una riattivazione non ripristinano vecchi valori. Le query verificano comunque l'idoneità corrente.

`GET /progress` restituisce:

```json
{"total":3,"completed":1,"open":2,"estimate_minutes":121,"completed_estimate_minutes":20,"remaining_minutes":82,"logged_minutes":19,"completion_percent":33.33}
```

`logged_minutes` comprende minuti effettivi manuali della scheda più worklog non eliminati, anche per schede completate. Il residuo per una scheda aperta è `max(0, stima - effettivo manuale - worklog)`; quello di una scheda completata è zero. La percentuale misura schede completate su schede totali, arrotondata a due decimali; uno sprint vuoto restituisce zero.

`GET /capacity-report` restituisce `{items:[{user_id,name,capacity_minutes,assigned_minutes,logged_minutes,remaining_minutes,over_capacity}],totals:{capacity_minutes,assigned_minutes,remaining_minutes,unassigned_minutes}}`. Una scheda con più assegnatari attualmente idonei ripartisce equamente stima, minuti registrati e residuo: gli eventuali minuti di resto vanno agli ID utente minori. In questo modo 101 minuti tra due persone diventano 51 e 50, senza raddoppiare i totali. Le schede senza assegnatari idonei contribuiscono comunque ai totali e a `unassigned_minutes`. `over_capacity` confronta residuo attribuito alla persona e capacità dichiarata.

`GET /forecast` aggiunge ai campi dell'avanzamento `capacity_minutes`, `capacity_gap_minutes`, `estimate_missing`, `unestimated_cards`, `capacity_user_count`, `capacity_configured`, `description`. `estimate_missing` e `unestimated_cards` sono lo stesso conteggio delle schede aperte con stima zero: il loro impegno non è noto e non va interpretato come lavoro gratuito. `capacity_configured` è vero se esiste almeno una dichiarazione valida, anche zero; `capacity_user_count` conta tali persone. Il divario è `max(0, residuo stimato - capacità dichiarata)`. Questo confronto descrittivo non calcola date di consegna, velocità storica, festività o capacità giornaliera e non garantisce il completamento dello sprint.

## Fotografie UTC, storico e CSV

`POST /snapshots` con `{}` registra i conteggi e minuti correnti dello sprint attivo nella giornata UTC corrente. Non accetta una data retroattiva o futura e non viene eseguito implicitamente dalle letture o da uno scheduler. Una seconda cattura nello stesso giorno sostituisce la prima soltanto con `If-Match` della versione corrente. Sono conservabili fino a 366 giornate; oltre il limite si restituisce `409`, mentre la sostituzione di una giornata esistente rimane possibile.

`GET /snapshots` restituisce `{items:[{day,total,completed,estimate_minutes,completed_estimate_minutes,remaining_minutes,logged_minutes,captured_at}]}` ordinati per giornata crescente. I valori restano quelli realmente catturati, anche se schede e stime cambiano in seguito. `DELETE /snapshots/{YYYY-MM-DD}` elimina una fotografia errata, anche dopo la chiusura dello sprint, con permessi di gestione e versione dello sprint. Una giornata assente restituisce `404`. Le correzioni sono registrate nello storico.

`GET /history` restituisce eventi `{id,actor_id,actor,action,subject_id,note,created_at}`. Le azioni sono `sprint_created`, `sprint_edited`, `sprint_activated`, `sprint_closed`, `sprint_reopened`, `sprint_deleted`, `sprint_restored`, `sprint_cards_added`, `sprint_cards_removed`, `sprint_capacity_set`, `sprint_snapshot_captured`, `sprint_snapshot_deleted`. Il nome dell'autore è conservato al momento dell'azione; `subject_id` identifica la scheda nelle operazioni singole o la persona per una capacità. I batch conservano il numero delle schede nella nota.

`GET /export` usa i filtri delle schede e restituisce `{filename,csv,truncated:false,record_count}`. Ignora `before` e `limit` e include tutte le schede corrispondenti fino a 1000; oltre 1000 oppure 2 MiB restituisce `413`, senza CSV parziali. Le colonne sono `id,title,column,priority,completed,estimate_minutes,logged_minutes,assignee,due_date`. Il formato usa virgole e CRLF; testo libero quotato, virgolette raddoppiate e formule `=`, `+`, `-`, `@` neutralizzate con un apostrofo anche dopo spazi e caratteri bianchi.

La migrazione 7 aggiunge soltanto le tabelle relazionali `sprints`, `sprint_cards`, `sprint_capacity`, `sprint_snapshots`, `sprint_events`, relativi indici e trigger di invalidazione della capacità. L'archiviazione esterna conserva tutti questi valori in PostgreSQL; non crea documenti JSON artificiali. `tests/test_sprints.py` verifica le 25 funzioni con sessioni reali, concorrenza, ACL, revoche, storico, rollback iniettato, quote, conteggi effettivi e CSV ostile.
