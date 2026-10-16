# API di OpenBoard 0.6.0

Il contratto di base della versione 0.2 resta disponibile qui. Le API della 0.3 sono descritte in [produttività](API_PRODUTTIVITA.md) e [collaborazione e account](API_COLLABORAZIONE.md); la 0.4 aggiunge [campi e traguardi](API_PIANIFICAZIONE.md) e [tempo e conversazioni](API_TEAMWORK.md). La 0.5 aggiunge [revisioni e approvazioni](API_REVISIONI.md) e [portfolio e report personali](API_PORTFOLIO.md); la 0.6 aggiunge [sprint e capacità](API_SPRINT.md) e [moduli e richieste](API_RICHIESTE.md). Configurazione, database separati e metriche sono in [installazione e gestione](DEPLOYMENT.md).

Le API sono disponibili sulla stessa origine dell'interfaccia, per impostazione predefinita `http://127.0.0.1:8090` in sviluppo o `http://openboard.localhost` con Compose. Il backend risponde soltanto con API JSON e restituisce `404` per HTML/CSS/JavaScript e tutti i percorsi non API. Il server locale ascolta su loopback; il container imposta `--bind 0.0.0.0` su una rete privata. `--public-url https://board.example.com` configura host e origine pubblici per il reverse proxy. TLS è gestito da Nginx Proxy Manager.

## Convenzioni HTTP

- Le risposte API usano `application/json; charset=utf-8` e `Cache-Control: no-store`.
- `POST` e `PATCH` richiedono `Content-Type: application/json` e un oggetto JSON, anche quando non servono campi: inviare `{}`.
- `DELETE` accetta un corpo vuoto. Se presente, il corpo deve essere un oggetto JSON con lo stesso content type.
- `HEAD` è disponibile per i percorsi `GET` e restituisce gli stessi header senza corpo. `OPTIONS` non è implementato.
- I campi omessi in un aggiornamento mantengono il valore precedente. I campi conosciuti hanno tipi rigorosi: ad esempio `false` è un booleano, `0` un intero e `null` non equivale a un campo omesso. I campi sconosciuti vengono ignorati.
- Il JSON e le stringhe devono essere UTF-8 validi. Le chiavi duplicate nell'oggetto della richiesta e nelle strutture validate vengono rifiutate.
- Gli identificativi dei percorsi sono interi decimali positivi. Usare URL senza slash finale.
- Ogni risposta comprende `X-Request-ID`, utile per collegare un errore ai log.
- Le scritture verificano `Host`, `Origin` quando presente e `Sec-Fetch-Site`. Le richieste dichiarate `cross-site` vengono rifiutate. Non sono disponibili API CORS.

Le creazioni di bacheche, colonne, schede e commenti restituiscono `201`; le altre modifiche restituiscono normalmente `200`. Le mutazioni di bacheche, colonne e schede restituiscono:

```json
{"ok": true, "id": 123, "version": 4}
```

Account, membri e commenti restituiscono `{"ok":true,"id":123}` quando non restituiscono una sessione. La configurazione iniziale restituisce una sessione con `201`, l'accesso una sessione con `200`.

## Stato del servizio

Questi endpoint sono disponibili anche senza sessione quando gli account sono abilitati.

| Metodo | Percorso | Risposta |
| --- | --- | --- |
| GET | `/api/health` | `{"status":"ok"}`: il processo risponde |
| GET | `/api/ready` | `200 {"status":"ready"}` se il database è aperto in scrittura e la lettura di controllo riesce; altrimenti `503 {"status":"unavailable"}` |
| GET | `/api/version` | `{"version":"0.6.0","sqlite":"…","auth_enabled":false,"workers":8,"storage":"sqlite"}`; lo storage esterno riporta `postgresql+mongodb` |

La readiness verifica apertura e lettura del database e, in modalità esterna, raggiungibilità di PostgreSQL e MongoDB; non esegue una scrittura di prova. Una scrittura non persistita sui servizi esterni restituisce `503`; riusare la stessa `Idempotency-Key` quando si ritenta un `POST` supportato.

## Cataloghi per il frontend

`GET /api/catalog` richiede una sessione e restituisce `labels`, `priorities`, `covers` e `custom_field_types`. Il frontend costruisce i selettori da questi metadati; le definizioni personalizzate e i dati delle bacheche arrivano dai rispettivi endpoint. Il backend resta responsabile di convalida e permessi.

## Account e sessioni

Con l'opzione esplicita `--no-auth`, ammessa solo su loopback, l'istanza opera in modalità di sviluppo locale: tutte le bacheche sono accessibili e non occorre un token CSRF. Per impostazione predefinita gli endpoint di dominio richiedono una sessione. Le eccezioni pubbliche sono stato del servizio, lettura della sessione, configurazione iniziale e accesso.

| Metodo | Percorso | Corpo / comportamento |
| --- | --- | --- |
| GET | `/api/auth/session` | Stato della sessione e token CSRF, anche per un visitatore anonimo |
| POST | `/api/auth/setup` | `{"name":"Giorgio","username":"giorgio","password":"una-password-lunga"}`; crea il primo amministratore e apre una sessione. Disponibile solo quando non esistono utenti; poi `409` |
| POST | `/api/auth/login` | `{"username":"giorgio","password":"una-password-lunga"}`; apre una sessione |
| POST | `/api/auth/logout` | `{}`; revoca la sessione corrente e cancella il cookie |
| POST | `/api/auth/password` | `{"current_password":"…","password":"nuova-password-lunga"}`; modifica la propria password e revoca le altre sessioni dello stesso account |

Esempio di risposta di sessione autenticata:

```json
{
  "enabled": true,
  "setup_required": false,
  "user": {"id": 1, "name": "Giorgio", "username": "giorgio", "role": "admin"},
  "csrf": "token-esadecimale-di-64-caratteri"
}
```

Per un visitatore anonimo `user` è `null` e `csrf` è vuoto. Senza `--auth`, `enabled` e `setup_required` sono `false`. Gli altri endpoint account, utenti e membri restituiscono `403` in modalità locale.

La sessione usa il cookie `ob_session`, `HttpOnly`, `SameSite=Strict`, `Path=/`. Con un URL pubblico HTTPS il cookie ha anche `Secure`. La durata massima è 8 ore, con scadenza dopo 30 minuti di inattività; un account può avere fino a 10 sessioni. Il token CSRF restituito dalla sessione deve essere inviato nell'header `X-CSRF-Token` per tutte le scritture autenticate, incluso il logout. Setup e login non richiedono una sessione precedente. Dopo un `401`, rileggere la sessione o effettuare nuovamente l'accesso.

Setup, login e cambio password hanno un limite di tentativi: 10 per chiave account, 60 per peer e 80 globali ogni 5 minuti. La risposta `429` include `Retry-After: 300`. Dietro il proxy i peer sono visti dal server come indirizzi della rete Docker; gli header inoltrati non sono usati per aggirare il limite.

### Utenti e permessi

| Metodo | Percorso | Corpo / risposta | Permesso |
| --- | --- | --- | --- |
| GET | `/api/users` | `{"users":[{"id":1,"name":"…","username":"…","role":"admin","active":true,"created_at":"…"}]}` | Amministratore globale |
| POST | `/api/users` | `name`, `username`, `password`; `role` facoltativo, predefinito `member`; risposta `201` | Amministratore globale |
| PATCH | `/api/users/:id` | Uno o più campi tra `name`, `role`, `active` | Amministratore globale |
| GET | `/api/boards/:id/members` | `{"members":[{"user_id":1,"name":"…","username":"…","role":"admin","global_role":"admin","active":true}]}` | Lettura della bacheca |
| POST | `/api/boards/:id/members` | `{"user_id":2,"role":"member"}`; aggiunge o aggiorna l'appartenenza; risposta `200` | Amministratore globale o della bacheca |
| DELETE | `/api/boards/:id/members/:user_id` | Rimuove l'appartenenza; corpo facoltativo | Amministratore globale o della bacheca |

I ruoli ammessi sono `admin`, `member`, `observer`, sia per l'account sia per la bacheca. L'amministratore globale accede a tutte le bacheche. Gli altri utenti vedono soltanto quelle di cui sono membri. Un ruolo globale `observer` impedisce le mutazioni del dominio anche se l'appartenenza alla bacheca è più permissiva; un ruolo di bacheca `observer` consente soltanto letture su quella bacheca. I preferiti personali restano modificabili anche dagli osservatori.

Chi crea, duplica o importa una bacheca ne diventa amministratore. La configurazione iniziale assegna al primo amministratore le bacheche già presenti. La disattivazione di un account revoca le sue sessioni; non è consentito disattivare o degradare l'ultimo amministratore globale attivo (`409`). Non esiste un endpoint di registrazione pubblica o di cancellazione fisica degli utenti.

## Bacheche

| Metodo | Percorso | Operazione |
| --- | --- | --- |
| GET | `/api/boards` | `{"boards":[...]}` con soli metadati, senza colonne o schede; esclude bacheche archiviate |
| GET | `/api/boards?include_archived=1` | Comprende anche le bacheche archiviate |
| POST | `/api/boards` | Creates the board and three initial lists. Optional `language` selects their names; omitted language preserves the Italian defaults. |
| GET | `/api/boards/:id` | Bacheca completa con colonne e schede; le schede archiviate sono escluse |
| GET | `/api/boards/:id?summary=1` | Bacheca con schede in formato riepilogativo |
| GET | `/api/boards/:id?summary=1&include_archived=1` | Riepilogo comprensivo delle schede archiviate |
| GET | `/api/boards/:id/revision` | `{"version":12}` per controllare gli aggiornamenti |
| PATCH | `/api/boards/:id` | Modifica uno o più campi scrivibili |
| PATCH | `/api/boards/:id/star` | `{"starred":true}`; modifica il preferito personale con account, oppure locale senza account |
| DELETE | `/api/boards/:id` | Sposta nel cestino la bacheca; colonne e schede diventano invisibili |
| POST | `/api/boards/:id/restore` | `{}`; ripristina una bacheca nel cestino |
| POST | `/api/boards/:id/duplicate` | `{}` o `{"name":"Nuovo progetto"}`; crea una copia con nuove identità e restituisce `201` |
| GET | `/api/boards/:id/activity` | Ultimi 200 eventi, dal più recente |
| GET | `/api/boards/:id/stats` | Conteggi e raggruppamenti delle schede attive |
| GET | `/api/boards/:id/export` | Esportazione OpenBoard v2, descritta sotto |

| Campo scrivibile | Tipo / valore iniziale | Limite |
| --- | --- | --- |
| `name` | Stringa obbligatoria alla creazione, non vuota né composta solo da spazi | 200 caratteri Unicode |
| `description` | Stringa, `""` | 2.000 caratteri Unicode |
| `color` | Stringa, `"sage"` | `sage`, `peach`, `lavender`, `blue` |
| `starred` | Booleano, `false` | Con account viene anche salvato il preferito personale; per modificare soltanto il preferito usare `/star` |
| `archived` | Booleano, `false` | `true` archivia; `false` riapre |
| `language` | Optional string, creation only; default `"it"` | Exactly `it`, `en`, `fr`, `es`, `de`, `zh-CN`, or `ja`; unknown values and non-string values return `400` |

`POST /api/boards` accepts `language` only as a creation hint for the three initial list names. For example, `{"name":"Release","language":"en"}` creates `To do`, `In progress`, and `Done`; the board name and other user content are preserved exactly. French defaults are `À faire`, `En cours`, `Terminé`; Spanish: `Por hacer`, `En curso`, `Completado`; German: `Zu erledigen`, `In Arbeit`, `Erledigt`; Simplified Chinese: `待办`, `进行中`, `已完成`; Japanese: `未着手`, `進行中`, `完了`. The legacy Italian defaults remain `Da fare`, `In corso`, `Completato`.

This hint is not persisted as a board property or returned by reads. Existing boards and lists are never translated. Any `language` field on `PATCH /api/boards/:id`, including `null`, returns `400` and leaves the board unchanged. Renaming a list continues to use its normal API. Board creation permissions, transaction boundaries, and idempotency rules remain unchanged.

La risposta contiene anche `id`, `created_at`, `updated_at`, `version`, `role`, `membership_role` e `readonly`. Le due proprietà di ruolo riportano il ruolo restituito per la bacheca; `readonly` tiene conto anche di un eventuale ruolo globale di sola lettura. Le risposte di dettaglio aggiungono `columns`.

L'archiviazione non equivale al cestino: una bacheca archiviata è ancora leggibile tramite il proprio URL diretto. `include_archived=1` sulla bacheca controlla le schede incluse, mentre sull'elenco controlla le bacheche incluse.

## Colonne e ordinamento

| Metodo | Percorso | Operazione |
| --- | --- | --- |
| POST | `/api/boards/:id/columns` | Crea una colonna; richiede `title`; accetta `position` e `wip_limit` |
| PATCH | `/api/columns/:id` | Modifica `title`, `position` e/o `wip_limit` |
| DELETE | `/api/columns/:id` | Sposta la colonna nel cestino e nasconde le sue schede |
| POST | `/api/columns/:id/restore` | `{}`; ripristina la colonna se la bacheca è attiva |

Le colonne si leggono dentro la bacheca: non è disponibile un `GET /api/columns/:id`. Ogni colonna contiene `id`, `title`, `position`, `wip_limit`, `version`, `created_at`, `updated_at` e `cards`.

`title` deve contenere da 1 a 200 caratteri Unicode e non può essere composto soltanto da spazi. `position` è un intero da zero: alla creazione può essere al massimo il numero delle colonne esistenti, in modifica al massimo il numero delle altre colonne. Le posizioni delle colonne visibili vengono mantenute dense (`0,1,2,…`). Se omessa alla creazione, la colonna è aggiunta in fondo.

`wip_limit` è un intero tra 0 e 100.000, predefinito 0, che significa nessun limite. Il conteggio WIP comprende le schede della colonna non eliminate, non archiviate e non completate. Creare, spostare, riaprire, ripristinare o togliere dall'archivio una scheda che supererebbe il limite restituisce `409`. Le schede completate possono entrare nella colonna senza consumare WIP. Ridurre il limite sotto il conteggio attuale è consentito: le schede esistenti restano presenti, ma le successive aggiunte sono bloccate.

## Schede

| Metodo | Percorso | Operazione |
| --- | --- | --- |
| POST | `/api/columns/:id/cards` | Crea una scheda nella colonna del percorso; basta `title` |
| GET | `/api/cards/:id` | Dettaglio completo, anche quando la scheda è archiviata |
| PATCH | `/api/cards/:id` | Modifica, sposta, riordina, completa o archivia |
| DELETE | `/api/cards/:id` | Sposta la scheda nel cestino |
| POST | `/api/cards/:id/restore` | `{}`; ripristina se bacheca e colonna sono attive e il WIP lo consente |
| POST | `/api/cards/:id/duplicate` | `{}` o `{"column_id":4}`; copia nella colonna attuale o in un'altra della stessa bacheca; restituisce `201` |

Esempio di dettaglio:

```json
{
  "id": 123,
  "column_id": 4,
  "title": "Preparare il lancio",
  "description": "Dettagli dell'attività",
  "label": "sviluppo",
  "labels": ["sviluppo", "urgente"],
  "due_date": "2026-10-20",
  "assignee": "Giulia",
  "cover": "sage",
  "position": 0,
  "completed": false,
  "archived": false,
  "priority": "high",
  "estimate_minutes": 90,
  "checklist": [{"id": "item-1", "text": "Revisione", "done": false}],
  "version": 4,
  "created_at": "2026-10-15T10:00:00.000Z",
  "updated_at": "2026-10-15T10:05:00.000Z"
}
```

| Campo scrivibile | Tipo / valore iniziale | Validazione |
| --- | --- | --- |
| `title` | Stringa obbligatoria alla creazione | 1–300 caratteri Unicode; non solo spazi |
| `description` | Stringa, `""` | Massimo 10.000 caratteri Unicode |
| `label` | Stringa, `""` | Etichetta singola compatibile con la prima versione |
| `labels` | Array di stringhe, `[]` | Massimo 5 etichette ammesse, senza duplicati |
| `due_date` | Stringa, `""` | Data di calendario valida `YYYY-MM-DD`, anno 0001–9999, oppure vuota |
| `assignee` | Stringa, `""` | Massimo 100 caratteri Unicode; è testo libero, non un ID utente |
| `cover` | Stringa, `""` | Vuota oppure `sage`, `peach`, `lavender`, `blue` |
| `completed` | Booleano, `false` | Non viene modificato automaticamente dal titolo della colonna |
| `archived` | Booleano, `false` | Archiviazione distinta dal cestino |
| `priority` | Stringa, `"normal"` | `low`, `normal`, `high`, `urgent` |
| `estimate_minutes` | Intero, `0` | 0–100.000 |
| `checklist` | Array, `[]` | Massimo 100 voci, ciascuna con `id`, `text`, `done` |
| `column_id` | Intero positivo | Solo per lo spostamento in `PATCH`; la creazione usa la colonna del percorso |
| `position` | Intero da zero | Posizione di inserimento dopo la rimozione dalla posizione precedente |

Le etichette ammesse sono `design`, `sviluppo`, `ricerca`, `marketing`, `urgente`. `label` ammette anche la stringa vuota. Fornire `labels` sincronizza `label` con il primo elemento o con `""` per l'array vuoto, anche se nella richiesta è presente `label`. Fornire soltanto `label` aggiorna anche `labels` a un array di un elemento oppure vuoto.

Ogni voce della checklist richiede un `id` non vuoto fino a 100 caratteri Unicode, un `text` non vuoto fino a 500 caratteri Unicode e un booleano `done`. Gli ID devono essere univoci nella scheda. La modifica di `checklist` sostituisce l'intero array: usare `If-Match` per proteggere le modifiche concorrenti.

Gli spostamenti sono consentiti soltanto tra colonne della stessa bacheca (`400` altrimenti). Se si cambia colonna senza `position`, la scheda viene aggiunta in fondo. Il server aggiorna origine, destinazione e ordinamento in una transazione. Le schede non archiviate vengono ordinate prima di quelle archiviate e mantengono posizioni visibili dense. Anche la duplicazione conserva descrizione, checklist, etichette, priorità, stima, assegnatario, scadenza, completamento e archiviazione; non copia i commenti.

Nel riepilogo `summary=1`, ciascuna scheda conserva i metadati ma sostituisce `description` e `checklist` con:

```json
{"description_preview":"Prime 160 lettere…","checklist_total":3,"checklist_done":1}
```

Il client deve leggere `/api/cards/:id` per aprire e modificare il dettaglio completo.

## Commenti, attività, ricerca e statistiche

| Metodo | Percorso | Contratto |
| --- | --- | --- |
| GET | `/api/cards/:id/comments` | `{"comments":[{"id":1,"body":"…","author_id":1,"author":"Giorgio","created_at":"…"}]}`, dal meno recente |
| POST | `/api/cards/:id/comments` | `{"body":"Testo del commento"}`; da 1 a 5.000 caratteri Unicode, non solo spazi; restituisce `201` |
| DELETE | `/api/comments/:id` | Autore o amministratore globale, con permesso di scrittura sulla bacheca; tutti gli utenti locali senza account possono eliminare i commenti locali |
| GET | `/api/boards/:id/activity` | `{"events":[{"id":1,"action":"updated","entity_type":"cards","entity_id":123,"title":"…","actor":"Giorgio","actor_id":1,"created_at":"…"}]}` |
| GET | `/api/search?q=testo` | `{"cards":[{"id":123,"title":"…","board_id":1,"board_name":"…","column_title":"…","priority":"normal","due_date":""}]}` |
| GET | `/api/boards/:id/stats` | Statistiche delle schede non eliminate e non archiviate in colonne attive |

In modalità locale i commenti hanno `author_id: 0` e `author: "Locale"`. Il corpo è testo, senza interpretazione HTML da parte del server.

L'attività comprende creazioni, modifiche, spostamenti, archiviazioni, cestino, ripristini, importazioni, duplicazione delle bacheche, commenti e modifiche alle appartenenze. I preferiti personali non producono attività condivisa. Il risultato contiene al massimo 200 eventi; non è disponibile la paginazione.

La ricerca richiede `q` non vuoto, fino a 200 caratteri Unicode, codificato nella query string. Cerca sottostringhe di titolo, descrizione e assegnatario, sulle sole bacheche autorizzate. Esclude bacheche e schede archiviate salvo `include_archived=1`, restituisce al massimo 200 schede e ordina per ultimo aggiornamento. Usa `lower()` di SQLite: la conversione delle maiuscole standard copre ASCII e non offre una ricerca linguistica Unicode completa.

Esempio di statistiche:

```json
{
  "total": 8,
  "completed": 3,
  "overdue": 2,
  "estimate_minutes": 360,
  "by_label": {"design": 4, "urgente": 2},
  "by_assignee": {"Giulia": 5, "Non assegnato": 3},
  "by_priority": {"normal": 6, "high": 2}
}
```

`overdue` conta schede non completate con scadenza precedente alla data UTC corrente; la scadenza odierna non è scaduta. `by_label` conta tutte le etichette della scheda, quindi la somma può superare `total`. `estimate_minutes` somma le stime anche delle schede completate incluse.

## Versioni e conflitti

Bacheche, colonne e schede espongono `version`, `created_at` e `updated_at`. I timestamp sono UTC in formato ISO 8601 con millisecondi. Le versioni crescono con le modifiche; un'operazione può incrementarle più volte, quindi non assumere un incremento esatto di uno. Gli aggiornamenti del dominio e delle appartenenze incrementano anche la revisione della bacheca; i preferiti personali non la incrementano.

`PATCH` e `DELETE` di `/api/boards/:id`, `/api/columns/:id` e `/api/cards/:id` supportano una precondizione facoltativa:

```http
PATCH /api/cards/123 HTTP/1.1
If-Match: "4"
Content-Type: application/json

{"title":"Titolo aggiornato"}
```

Se la versione corrente è diversa, la risposta è `412` e la mutazione non viene applicata. Rileggere la risorsa e presentare il conflitto all'utente mantenendo la sua bozza. Non ritentare automaticamente con una versione più recente sostituendo l'intera scheda.

È accettato un singolo numero decimale, con o senza virgolette. Non sono implementati wildcard `*`, liste di tag o tag deboli `W/`. Senza header l'aggiornamento resta consentito per compatibilità. Ripristino, duplicazione, commenti, appartenenze e account non applicano questa precondizione. Le API non inviano un ETag delle risorse: usare il campo `version`; gli ETag e `If-None-Match` riguardano gli asset statici.

## Idempotenza delle creazioni

I `POST` del dominio accettano l'header facoltativo `Idempotency-Key`, fino a 127 byte. È applicato a creazioni di bacheche, colonne, schede e commenti, duplicazioni, ripristini e importazioni. Non è applicato agli endpoint account, utenti e appartenenze, né a `PATCH` o `DELETE`.

```http
POST /api/columns/4/cards HTTP/1.1
Content-Type: application/json
Idempotency-Key: creazione-2026-10-15-001

{"title":"Preparare il lancio"}
```

La chiave è associata all'utente, al percorso senza query string e al corpo originale. Ripetere la stessa richiesta restituisce lo stesso status e corpo della prima risposta riuscita, con `Idempotency-Replayed: true`, senza creare altre risorse. Riutilizzare la stessa chiave sullo stesso percorso con un corpo differente restituisce `409`; anche differenze di spaziatura o ordine delle proprietà JSON costituiscono un corpo differente.

Mutazione e registrazione della chiave vengono confermate nella stessa transazione. Le risposte d'errore non vengono memorizzate. Le chiavi persistono nel database senza scadenza automatica: generarne una nuova per ogni operazione distinta e conservarla durante i tentativi della stessa operazione. In modalità locale tutte le richieste condividono l'identità locale `0`.

## Cestino e ripristino

`DELETE` esegue una cancellazione logica e conserva i dati. Una bacheca nel cestino nasconde tutte le sue colonne e schede; una colonna nel cestino nasconde le sue schede. Le letture delle risorse nascoste restituiscono `404`.

```http
GET /api/trash
```

```json
{
  "items": [
    {"kind":"cards","id":123,"title":"Preparare il lancio","deleted_at":"2026-10-15T11:00:00.000Z","board_id":1}
  ]
}
```

Il cestino comprende soltanto risorse esplicitamente eliminate e appartenenti a bacheche autorizzate. I discendenti nascosti dalla cancellazione del genitore non vengono aggiunti individualmente. I valori di `kind` sono plurali: `boards`, `columns`, `cards`.

Oltre ai percorsi `/api/:kind/:id/restore`, è disponibile:

```http
POST /api/trash/cards/123/restore
Content-Type: application/json

{}
```

Ripristinare prima la bacheca, poi la colonna e infine la scheda. Un genitore ancora nel cestino, una risorsa già ripristinata o un limite WIP raggiunto producono `409`. Il ripristino di un genitore rende nuovamente visibili i figli che non erano stati eliminati individualmente. Lo stato `archived` precedente viene conservato. Non esiste un endpoint per svuotare definitivamente il cestino.

## Esportazione e importazione

`GET /api/boards/:id/export` restituisce JSON e `Content-Disposition: attachment; filename="openboard-1.json"`:

```json
{
  "format": "openboard",
  "version": 2,
  "board": {
    "id": 1,
    "name": "Progetto",
    "description": "",
    "color": "sage",
    "starred": false,
    "archived": false,
    "version": 8,
    "created_at": "2026-10-15T10:00:00.000Z",
    "updated_at": "2026-10-15T10:30:00.000Z",
    "role": "admin",
    "membership_role": "admin",
    "readonly": false,
    "columns": [
      {"id": 4, "title": "Da fare", "position": 0, "wip_limit": 0, "version": 1,
       "created_at": "2026-10-15T10:00:00.000Z", "updated_at": "2026-10-15T10:00:00.000Z", "cards": []}
    ]
  }
}
```

L'esportazione comprende le colonne non eliminate e il dettaglio completo delle loro schede non eliminate, incluse le schede archiviate, anche se la schermata usa il riepilogo. Non comprende commenti, attività, appartenenze, account, sessioni o cestino. Non è un backup completo del database.

`POST /api/import` accetta lo stesso oggetto con `format: "openboard"`, `version: 2` e un oggetto `board` contenente `name` e un array `columns`. Ogni colonna richiede `title` e un array `cards`; ogni scheda richiede `title`. Gli array possono essere vuoti. Sono consentite al massimo 100 colonne e 10.000 schede complessive, entro il limite HTTP di 2 MiB, applicando gli stessi limiti dei campi dei normali endpoint.

L'importazione crea sempre una nuova bacheca: non aggiorna né sostituisce quella di origine. Genera nuovi ID, timestamp e revisioni; ricostruisce l'ordine dagli array ignorando i vecchi `position` e `column_id`. Conserva i campi funzionali supportati, compresi archivio, completamento, checklist, stime, etichette e limiti WIP. L'importatore applica i limiti WIP dopo aver caricato le schede, quindi può ripristinare una bacheca già oltre il limite senza perdere attività. Il preferito esportato è quello visibile al richiedente e viene applicato al nuovo proprietario.

L'operazione è atomica: se una colonna o una scheda non è valida, nessuna parte della nuova bacheca viene conservata. Una risposta riuscita è `201 {"ok":true,"id":…,"version":…}`. Non è implementata l'importazione diretta del JSON Trello.

Per una copia completa usare il comando `./build/openboard --db data/openboard.db --backup /percorso/backup.db`, che esegue il backup consistente tramite l'API SQLite ed esce. Il ripristino del database è un'operazione amministrativa descritta nel README, distinta da `/api/import`.

## Errori e limiti operativi

Gli errori applicativi hanno forma:

```json
{"error":"Messaggio leggibile"}
```

| Status | Significato |
| --- | --- |
| `400` | JSON, tipi, valori, posizioni o richiesta HTTP non validi |
| `401` | Sessione assente/scaduta o credenziali errate |
| `403` | Host/origine, token CSRF o ruolo non consentiti; funzionalità account disabilitata |
| `404` | Percorso o risorsa non trovata, eliminata, nascosta da un genitore oppure non accessibile |
| `405` | Metodo non supportato per il percorso |
| `408` | Scadenza del tempo di ricezione della richiesta |
| `409` | WIP, ripristino non possibile, username già usato, setup già completato, ultima amministrazione protetta o chiave idempotente incompatibile |
| `412` | Versione `If-Match` obsoleta o non corrispondente |
| `413` | Corpo oltre 2.097.152 byte (2 MiB) |
| `415` | Content type diverso da JSON per una scrittura che richiede un corpo |
| `429` | Troppi tentativi di autenticazione/cambio password |
| `431` | Intestazioni oltre 16.384 byte |
| `500` | Errore interno, per esempio lettura di un asset statico |
| `503` | Database temporaneamente indisponibile/occupato o servizio non pronto |

La risposta negativa di `/api/ready` usa `{"status":"unavailable"}` invece di `error`. Non tutte le limitazioni di trasporto producono una risposta JSON: una coda di connessioni piena o un socket già chiuso possono determinare la chiusura della connessione.

| Limite | Valore |
| --- | --- |
| Corpo HTTP | 2 MiB |
| Intestazioni HTTP complessive | 16 KiB |
| Target della richiesta, percorso e query insieme | 1.023 byte |
| `If-Match` | 79 byte |
| `Idempotency-Key` | 127 byte |
| Nome visualizzato di un utente | 1–100 caratteri Unicode, non solo spazi |
| Username | 3–64 caratteri ASCII: lettere, numeri, `.`, `_`, `-`; normalizzato in minuscolo |
| Password nuova | 12–256 byte UTF-8 |
| Ricezione degli header | 5 secondi complessivi |
| Ricezione del corpo | 10 secondi complessivi dopo gli header |
| Invio della risposta | 10 secondi complessivi |
| Worker | 8 predefiniti; `--workers` accetta 1–32 |
| Coda di connessioni | 64 |

È servita una richiesta HTTP/1.1 per connessione, poi la connessione viene chiusa. `Transfer-Encoding`, `Expect` e intestazioni sensibili duplicate vengono rifiutati; usare `Content-Length` per i corpi delle richieste.
