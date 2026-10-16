# Revisioni e approvazioni — OpenBoard 0.5

Le richieste di revisione appartengono a una scheda e seguono la bacheca attuale della scheda. Gli endpoint richiedono un account autenticato, anche nelle installazioni locali avviate con `--no-auth`: in tale modalità restituiscono `403`. Le richieste anonime in modalità autenticata restituiscono `401`; tutte le mutazioni richiedono il token CSRF e i controlli di origine già applicati dal router. Il frontend statico ricava enum e traduzioni da `/api/catalog` (`review_statuses`, `review_policies`, `review_decisions`) e dati e permessi dalle API.

## Le 25 funzioni backend 301–325

| ID | Miglioria | Metodo e percorso |
|---|---|---|
| 301 | Richiesta con titolo, descrizione e scadenza | `POST /api/cards/{card}/reviews` |
| 302 | Selezione di 1–20 revisori attivi della bacheca | `reviewer_ids` nella creazione e nella sostituzione |
| 303 | Approvazione di tutti oppure almeno un revisore | `policy: "all"` oppure `"any"` |
| 304 | Elenco revisioni della scheda | `GET /api/cards/{card}/reviews` |
| 305 | Dettaglio con revisori e voti individuali | `GET /api/reviews/{id}` |
| 306 | Modifica titolo, descrizione, scadenza e policy | `PATCH /api/reviews/{id}` |
| 307 | Sostituzione revisori e azzeramento voti | `PATCH /api/reviews/{id}/reviewers` |
| 308 | Approvazione con eventuale nota | `POST /api/reviews/{id}/vote`, `decision: "approved"` |
| 309 | Richiesta di modifiche con nota obbligatoria | Stesso endpoint, `decision: "changes_requested"` |
| 310 | Ritiro del proprio voto | `DELETE /api/reviews/{id}/vote` |
| 311 | Annullamento della richiesta | `POST /api/reviews/{id}/cancel` |
| 312 | Riapertura e azzeramento voti | `POST /api/reviews/{id}/reopen` |
| 313 | Eliminazione recuperabile | `DELETE /api/reviews/{id}` |
| 314 | Ripristino | `POST /api/reviews/{id}/restore` |
| 315 | Storico con cursore | `GET /api/reviews/{id}/history` |
| 316 | Inbox della bacheca con filtro per stato | `GET /api/boards/{board}/reviews` |
| 317 | Inbox personale delle richieste assegnate | `GET /api/me/reviews` |
| 318 | Filtro delle richieste scadute | `overdue=1` |
| 319 | Filtro per revisore | `reviewer_id={user}` |
| 320 | Filtro per richiedente | `requester_id={user}` |
| 321 | Stato aggregato con precedenza alle modifiche richieste | `status` calcolato sulle autorizzazioni correnti |
| 322 | Contatori della bacheca | `GET /api/boards/{board}/review-stats` |
| 323 | Esportazione CSV con neutralizzazione formule | `GET /api/boards/{board}/review-export` |
| 324 | Contatori della scheda | `GET /api/cards/{card}/review-summary` |
| 325 | Copia su una scheda della stessa bacheca senza voti | `POST /api/reviews/{id}/duplicate` |

## Permessi e stato aggregato

La lettura richiede l'accesso attuale alla bacheca e antenati vivi: scheda, lista e bacheca non eliminate. Gli osservatori possono leggere. Richiedente, amministratore globale e amministratore della bacheca possono gestire una richiesta soltanto se hanno anche accesso in scrittura; un richiedente retrocesso a osservatore perde quindi la gestione. Una risorsa estranea o nascosta restituisce `404`, una gestione non autorizzata di una risorsa leggibile `403`.

I revisori devono essere account attivi, membri effettivi della bacheca con ruolo `member` o `admin`, e avere un ruolo globale diverso da `observer`. Il richiedente non può selezionarsi né votare la propria richiesta. Un amministratore globale può essere revisore soltanto se ha anche una membership effettiva della bacheca. Votare e ritirare il voto richiedono una selezione come revisore tuttora valida; ogni account modifica soltanto il proprio voto.

Lo stato viene calcolato a ogni richiesta, senza memorizzare un'approvazione aggregata che possa diventare obsoleta:

1. Se annullata, `cancelled`.
2. Se almeno un revisore tuttora idoneo chiede modifiche, `changes_requested`.
3. Con policy `any`, almeno un'approvazione valida produce `approved`.
4. Con policy `all`, serve un'approvazione valida per ciascun revisore selezionato.
5. Altrimenti `pending`.

La rimozione di un membro non riduce il numero di approvazioni richieste: una richiesta `all` rimane in attesa finché il responsabile sostituisce i revisori. Rimozione dalla bacheca, retrocessione a osservatore e disattivazione invalidano anche i voti memorizzati; un reinvito o una riattivazione non ripristinano vecchie approvazioni. I cambi di ruolo e stato incrementano la versione della richiesta e registrano un evento di sistema. L'idoneità viene comunque verificata dinamicamente, anche quando una scheda cambia bacheca.

`overdue` è vero quando la scadenza precede la data UTC corrente e lo stato è `pending` o `changes_requested`. Una richiesta approvata o annullata non è scaduta ai fini dei contatori.

## Creazione e dettaglio

Esempio di creazione:

```http
POST /api/cards/42/reviews
Content-Type: application/json
X-CSRF-Token: <token di sessione>
Idempotency-Key: revisione-accessibilita-42
```

```json
{
  "title": "Verifica accessibilità",
  "description": "Controllare tastiera e contrasto prima della consegna.",
  "due_date": "2026-11-10",
  "policy": "all",
  "reviewer_ids": [7, 12]
}
```

`title` è obbligatorio, non composto soltanto da spazi, massimo 200 caratteri. `description` è facoltativa, massimo 4000 caratteri. `due_date` è facoltativa: data reale `YYYY-MM-DD` con anno almeno 1900 oppure stringa vuota. `policy` è facoltativa e vale `all` per impostazione predefinita. `reviewer_ids` deve essere un array di 1–20 ID interi positivi distinti; stringhe, decimali, booleani, membri non idonei e richiedente sono rifiutati con `400`.

Creazione e copia restituiscono `201`, le altre mutazioni il dettaglio aggiornato con `200`. Il dettaglio contiene:

```json
{
  "id": 3,
  "card_id": 42,
  "board_id": 2,
  "card_title": "Schermata di accesso",
  "requester_id": 1,
  "requester": "Amministratore",
  "title": "Verifica accessibilità",
  "description": "Controllare tastiera e contrasto prima della consegna.",
  "due_date": "2026-11-10",
  "policy": "all",
  "status": "pending",
  "version": 1,
  "created_at": "2026-10-16T10:00:00.000Z",
  "updated_at": "2026-10-16T10:00:00.000Z",
  "cancelled_at": null,
  "deleted_at": null,
  "overdue": false,
  "reviewer_count": 2,
  "approved_count": 0,
  "changes_count": 0,
  "can_manage": true,
  "can_vote": false,
  "reviewers": [
    {"user_id": 7, "name": "Anna", "username": "anna", "eligible": true,
     "decision": null, "note": "", "voted_at": null},
    {"user_id": 12, "name": "Luca", "username": "luca", "eligible": true,
     "decision": null, "note": "", "voted_at": null}
  ]
}
```

`reviewers` è ordinato per ID utente. `eligible` segnala la validità corrente del revisore e `can_manage`/`can_vote` descrivono i permessi dell'utente che sta leggendo. Le revisioni eliminate sono escluse dal dettaglio ordinario; `GET /api/reviews/{id}?include_deleted=1` consente di leggere un elemento da ripristinare, mantenendo gli stessi controlli ACL.

## Modifiche e ciclo di vita

`PATCH /api/reviews/{id}` accetta almeno un campo tra `title`, `description`, `due_date`, `policy`. Stringhe vuote cancellano descrizione o scadenza, ma non sono valide per titolo o policy. Cambiare policy azzera i voti precedenti. La sostituzione dei revisori richiede `{"reviewer_ids":[7,15]}` e azzera tutti i voti, anche se alcuni revisori rimangono selezionati.

`POST /api/reviews/{id}/vote` accetta `{"decision":"approved","note":"Verificato"}` oppure `{"decision":"changes_requested","note":"Correggere il contrasto"}`. `note` ha al massimo 2000 caratteri e, nel secondo caso, deve contenere testo diverso da spazi. Un nuovo voto sostituisce il precedente dello stesso utente. `DELETE /vote` senza un voto esistente restituisce `409`. Le richieste annullate non accettano voti e restituiscono `409`.

Gli endpoint `cancel`, `reopen` e `restore` usano `POST` con un oggetto JSON, anche `{}`. Annullare una richiesta già annullata o ripristinarne una già attiva restituisce `409`. Riaprire azzera tutti i voti e rimuove l'annullamento; può essere usato anche per azzerare una richiesta ancora aperta. L'eliminazione conserva richiesta, revisori, voti e storico; l'elemento non accetta modifiche o voti finché non viene ripristinato. Ripristinare non riapre una richiesta annullata.

Tutte le mutazioni di una richiesta esistente accettano `If-Match: "versione"` oppure un numero positivo senza virgolette. Una versione superata restituisce `412`; un valore malformato `400`. Il frontend invia sempre la versione letta. Una modifica riuscita incrementa `version`, aggiorna `updated_at`, registra lo storico e aggiorna la versione della bacheca. La copia controlla la versione della sorgente e crea una richiesta con versione 1 senza cambiare la sorgente.

`POST /api/reviews/{id}/duplicate` richiede `{"card_id":43}`. La destinazione deve essere una scheda viva nella stessa bacheca, altrimenti `404`. Il nuovo richiedente è l'utente che esegue la copia; sono copiati soltanto i revisori attualmente idonei diversi dal nuovo richiedente. Nessun voto, annullamento o eliminazione viene copiato. Se non rimane almeno un revisore, la risposta è `409`.

## Elenchi e storico

Gli elenchi per scheda, bacheca e utente restituiscono `{items,next_cursor}`. L'inbox personale include richieste in cui l'utente è selezionato come revisore e conserva soltanto bacheche tuttora leggibili; non è l'elenco delle richieste create dall'utente.

| Parametro | Significato |
|---|---|
| `status` | `pending`, `approved`, `changes_requested`, `cancelled`; assente significa tutti. |
| `overdue` | `1` restringe alle richieste scadute; `0` non restringe. |
| `reviewer_id` | ID intero positivo di un revisore selezionato. |
| `requester_id` | ID intero positivo del richiedente. |
| `include_deleted` | `1` include anche elementi eliminati; predefinito `0`. |
| `limit` | Da 1 a 100; predefinito 30. |
| `before` | ID positivo: restituisce elementi con ID inferiore. |

ID, booleani testuali e stati non validi restituiscono `400`; i flag accettano soltanto `0` o `1`. L'ordinamento è per ID decrescente; `next_cursor` è l'ultimo ID della pagina quando esistono altri risultati, altrimenti `null`. Conservare gli stessi filtri nelle pagine successive.

`GET /api/reviews/{id}/history` usa gli stessi `before` e `limit`, con gli stessi limiti e ordine, e può leggere lo storico di richieste eliminate. Ogni evento contiene `{id,review_id,actor_id,actor,subject_id,action,decision,note,created_at}`. Le azioni sono `review_created`, `review_edited`, `review_reviewers_changed`, `review_voted`, `review_vote_withdrawn`, `review_cancelled`, `review_reopened`, `review_deleted`, `review_restored`, `review_duplicated` e `review_eligibility_changed`.

Gli eventi di sistema per cambi di idoneità hanno `actor: "Sistema"`, `actor_id: null` e `subject_id` del revisore interessato, distinguendo il soggetto dalla persona che ha amministrato l'account. Gli eventi ordinari conservano il nome dell'autore al momento dell'azione; `subject_id` vale `null`.

## Contatori, CSV e limiti

I contatori della scheda e della bacheca restituiscono `{total,pending,approved,changes_requested,cancelled,overdue}`. Contano tutte le revisioni attive nel rispettivo ambito, senza applicare filtri o cursori; escludono revisioni e antenati eliminati.

`GET /api/boards/{board}/review-export` accetta gli stessi filtri degli elenchi e restituisce `{filename,csv,truncated:false}`. L'esportazione comprende tutte le righe filtrate fino a 1000, senza applicare la paginazione `before`/`limit`. Oltre 1000 righe oppure 2 MiB di risposta restituisce `413`, senza consegnare un CSV parziale. Ridurre i filtri in questo caso.

Il CSV contiene `id,card_id,card_title,title,description,requester,status,policy,due_date,reviewer_count,approved_count,changes_count`, con virgola e terminatori CRLF. Tutte le celle di testo libero sono quotate, le virgolette raddoppiate e i prefissi di formula `=`, `+`, `-`, `@`, anche dopo spazi, tab o ritorni a capo, sono neutralizzati con un apostrofo. I campi enum e date sono validati dal backend. Le risposte autenticate mantengono `Cache-Control: no-store`.

Sono consentite al massimo 200 revisioni per scheda, comprese quelle eliminate, e 10000 eventi per richiesta. Creazioni, copie o mutazioni oltre i rispettivi limiti restituiscono `409`. Le revoche di autorizzazione continuano a invalidare i voti e aggiornare la versione anche se lo storico ha raggiunto il limite; in quel caso non viene aggiunto un ulteriore evento automatico.

Le mutazioni usano la transazione del router: validazione, voti, versione, storico e attività vengono salvati insieme oppure annullati. I `POST` supportano l'idempotenza globale del router; un retry con lo stesso utente, percorso, chiave e corpo restituisce il risultato originale, mentre un corpo diverso con la stessa chiave restituisce `409`. Gli errori di salvataggio restituiscono `503` senza lasciare voti o versioni parziali.

La migrazione SQLite 6 aggiunge `reviews`, `review_members`, `review_votes`, `review_events`, due viste per idoneità e aggregati e trigger di invalidazione. Tutti i dati delle revisioni sono relazionali; il sistema di archiviazione esterno li conserva in PostgreSQL senza aggiungere documenti JSON artificiali a MongoDB.

Validazione: `tests/test_reviews.py` esercita le 25 funzioni con sessioni reali, revoche e reinviti, ruoli globali e di bacheca, anti autoapprovazione, versioni, filtri e cursori, CSV ostile, idempotenza, quote e un errore di storico iniettato per verificare il rollback atomico.
