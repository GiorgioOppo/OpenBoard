# Portfolio e report personali — OpenBoard 0.5

Il portfolio raccoglie le bacheche attualmente leggibili dall'utente. Tutti gli endpoint richiedono la sessione autenticata configurata dal backend; le mutazioni richiedono anche il token CSRF. Il frontend usa soltanto JSON e il catalogo autenticato `/api/catalog` per gli enum dei filtri.

## Filtri comuni

`GET /api/portfolio`, `/api/portfolio/cards`, `/api/portfolio/insights` e `/api/portfolio/export` accettano questi parametri:

| Parametro | Valore |
|---|---|
| `q` | Sottostringa letterale del titolo o della descrizione, massimo 200 caratteri. `%` e `_` non sono wildcard; il confronto ignora le maiuscole ASCII. |
| `status` | `all` predefinito, `open`, `completed`, `blocked`, `overdue`, `due_soon`, `unassigned`. |
| `assignee_id` | ID positivo di un assegnatario strutturato. |
| `priority` | `low`, `normal`, `high`, `urgent`. |
| `label` | Una delle etichette restituite dal catalogo. |
| `board_id` | ID positivo di una bacheca. Non concede accesso alla bacheca. |
| `from`, `to` | Scadenze ISO `YYYY-MM-DD`, estremi inclusi e ordinati; le schede senza scadenza sono escluse quando è presente un estremo. |
| `include_archived` | `0` predefinito, oppure `1` per includere bacheche e schede archiviate. |
| `before` | Cursore positivo, soltanto per le pagine delle schede e dell'export. |
| `limit` | Da 1 a 100, predefinito 30, soltanto per le pagine delle schede e dell'export. |

Parametri ripetuti, ID non validi, enum sconosciuti, date impossibili, intervalli invertiti e valori oltre i limiti restituiscono `400`. I parametri sono associati tramite binding SQLite. Ricerca, CSV e grafici non includono mai bacheche, liste o schede eliminate, né gli elementi appartenenti ad antenati eliminati. I controlli ACL vengono ripetuti a ogni richiesta, anche dopo una revoca dell'accesso.

`open` significa non completata; `blocked` aggiunge un motivo di blocco esplicito oppure almeno una dipendenza visibile non completata. `overdue` confronta la scadenza con la data UTC del server; `due_soon` comprende oggi e i successivi sette giorni. `unassigned` include soltanto schede aperte senza assegnatari strutturati e senza il nome libero legacy.

## Riepilogo e ricerca

`GET /api/portfolio` restituisce:

```json
{
  "summary": {
    "boards": 2,
    "total": 12,
    "open": 8,
    "completed": 4,
    "blocked": 1,
    "overdue": 2,
    "due_soon": 3,
    "unassigned": 1,
    "estimate_minutes": 600,
    "total_minutes": 420,
    "checklist_total": 10,
    "checklist_done": 6
  },
  "boards": [],
  "users": [],
  "boards_truncated": false
}
```

Ogni elemento di `boards` ha `id`, `name`, `color` e gli stessi contatori delle schede. Sono incluse anche le bacheche vuote; l'elenco contiene al massimo le 100 bacheche con ID maggiore, mentre il riepilogo conta l'intero insieme autorizzato. `boards_truncated` segnala il limite. `users` contiene al massimo 100 account attivi appartenenti alle bacheche visibili o assegnati alle schede del risultato, ordinati per nome e ID, con `{id,name,username}`.

`GET /api/portfolio/cards` restituisce `{items,next_cursor}`. Gli elementi contengono il riepilogo della scheda usato dalle bacheche, compresi `assignees`, `assignee_ids`, `labels`, priorità, scadenze, versione, stima, tempo manuale, tempo registrato e tempo totale. Si aggiungono `board_id`, `board_name`, `column_title` e `dependency_blocked` booleano.

L'ordinamento è sempre per ID decrescente. `next_cursor` è l'ultimo ID della pagina quando rimangono altri elementi, altrimenti `null`. Per continuare, conservare gli stessi filtri e passare `before=next_cursor`. Nuove schede create durante la navigazione non producono duplicati nelle pagine successive.

## Analisi

`GET /api/portfolio/insights` restituisce:

| Proprietà | Contenuto |
|---|---|
| `activity` | 30 giorni UTC consecutivi fino a oggi, ciascuno `{date,count}`; comprende i giorni senza eventi. Gli eventi sono filtrati per bacheche autorizzate e `board_id`, poiché possono riguardare anche liste e bacheche. |
| `overdue_buckets` | Tre righe `{bucket,count}`: `1-7`, `8-30`, `31+` giorni di ritardo. |
| `capacity` | `{user_id,name,cards,estimate_minutes,total_minutes}` per assegnatario di schede aperte; `user_id=0` indica schede senza assegnatari strutturati. |
| `time` | `estimate_minutes`, `manual_minutes`, `logged_minutes`, `total_minutes` e `variance_minutes`. |
| `bottlenecks` | Liste con WIP positivo raggiunto o superato: `{column_id,title,board_id,board_name,wip_limit,open,over_limit}`. |
| `checklists` | `{total,done}`: somma di tutti gli elementi delle checklist e degli elementi completati. |
| `dependency_blocks` | Schede aperte bloccate da dipendenze visibili non completate: `{id,title,board_id,board_name,remaining}`. |
| `milestones` | Traguardi non eliminati: `{id,key,title,board_id,board_name,due_date,completed,total,done,overdue}`. |

Gli aggregati delle schede rispettano gli stessi filtri della ricerca; `before` e `limit` non limitano gli aggregati. I tempi comprendono il tempo manuale della scheda e le registrazioni non eliminate. La differenza è `tempo totale − stima` e può essere negativa. Una scheda con più assegnatari contribuisce interamente alla capacità di ciascuno; sommare le righe degli assegnatari può quindi contare più volte la stessa stima. Le assegnazioni legacy libere sono incluse nella riga senza assegnatari strutturati.

Capacità, liste, dipendenze e traguardi hanno un massimo di 100 righe per risposta. La capacità è ordinata per numero di schede decrescente, le liste per superamento WIP e le dipendenze per numero di prerequisiti aperti. Le viste SQL aggregano i dati autorizzati senza caricare tutte le schede nel processo C.

## Report personali salvati

I report sono impostazioni personali; non sono snapshot dei dati e non conservano autorizzazioni. Richiedono `--auth` e un account, anche quando l'installazione locale permette modalità senza autenticazione. Gli osservatori possono salvare e modificare i propri report senza modificare contenuti condivisi.

| Metodo e percorso | Azione |
|---|---|
| `GET /api/me/reports` | `{reports:[...]}`, prima i preferiti, poi ID decrescente. |
| `POST /api/me/reports` | Crea con `{name,filters?,pinned?}`; restituisce il report e `201`. |
| `GET /api/reports/{id}` | Legge un proprio report. |
| `PATCH /api/reports/{id}` | Modifica almeno uno tra `name`, `filters`, `pinned`; sostituisce completamente i filtri forniti. |
| `DELETE /api/reports/{id}` | Elimina definitivamente il proprio report. |
| `POST /api/reports/{id}/duplicate` | Duplica i filtri con `{name?}`; il nuovo report non è preferito e parte dalla versione 1. |

Ogni report contiene `{id,name,filters,pinned,version,created_at,updated_at}`. `name` deve contenere da 1 a 100 caratteri e non essere composto soltanto da spazi. `filters` è un oggetto JSON fino a 4096 byte con i parametri della ricerca tranne `before`: numeri JSON interi positivi per ID e limite, booleano JSON per `include_archived`, stringhe per gli altri campi. Proprietà sconosciute, duplicate, null, coercizioni stringa/numero e tipi errati sono rifiutati. `pinned` è un booleano JSON. Proprietario e timestamp non sono modificabili.

Sono consentiti al massimo 100 report per account; creazione e duplicazione oltre il limite restituiscono `409`. Tutti gli endpoint su un report altrui restituiscono `404`, anche per amministratori. `PATCH`, `DELETE` e duplicazione accettano `If-Match: "versione"` oppure la versione numerica senza virgolette: una versione superata restituisce `412`, un valore malformato `400`. Le modifiche incrementano la versione; eliminazione e creazione vengono serializzate dalla transazione del router.

Esempio:

```json
{
  "name": "Urgenti senza responsabile",
  "filters": {"status": "unassigned", "priority": "urgent", "include_archived": false},
  "pinned": true
}
```

## Esportazione

`GET /api/portfolio/export` usa gli stessi filtri, ordine e cursori di `/cards`, e restituisce `{filename:"portfolio.csv",csv,next_cursor}`. Il CSV contiene `id,board,column,title,priority,due_date,completed,estimate_minutes,total_minutes`; separatore virgola e terminatori CRLF. Le celle testuali sono quotate, le virgolette raddoppiate e le formule che iniziano con `=`, `+`, `-`, `@`, anche dopo spazi, tab o ritorni a capo, sono neutralizzate con un apostrofo. Non viene omessa silenziosamente la paginazione: `next_cursor` indica se occorre esportare altre pagine.

La migrazione SQLite 6 introduce `saved_reports`; PostgreSQL conserva i campi strutturati e MongoDB conserva `filters` nel sistema di archiviazione esterno. La visibilità dei dati dipende sempre dalle ACL correnti. Le risposte API conservano `Cache-Control: no-store` come le altre risorse autenticate.

Validazione: `tests/test_portfolio.py` esercita tutte le migliorie backend 326–350, incluse revoca ACL, antenati eliminati, filtri combinati, cursori con inserimenti concorrenti, tipi JSON, versioni, quote, conteggi analitici deterministici e celle CSV ostili.
