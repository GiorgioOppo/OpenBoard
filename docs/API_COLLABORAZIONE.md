# API di collaborazione — OpenBoard 0.3

Le risposte sono JSON, salvo le metriche documentate altrove. Le scritture richiedono `Content-Type: application/json` e un oggetto JSON; `DELETE` può avere corpo vuoto. Con `--auth`, occorrono il cookie `ob_session` e, per le scritture, `X-CSRF-Token` restituito da `/api/auth/session`. Le scritture passano attraverso una transazione SQLite: errori di attività o notifiche annullano anche la modifica iniziale. I nuovi endpoint `POST` accettano l'intestazione `Idempotency-Key` già supportata dal server.

Watch, notifiche, profilo e gestione delle sessioni richiedono `--auth`: in modalità locale rispondono `403`. Allegati, modifica dei commenti e cronologia paginata funzionano anche in modalità locale. Con gli account, ogni accesso ai dati di una bacheca verifica i permessi correnti; una risorsa assente o non accessibile restituisce normalmente `404`.

## Seguire bacheche e schede

`PATCH` oppure `POST /api/boards/:id/watch` e `/api/cards/:id/watch`:

```json
{"watching":true}
```

Risposta `200`:

```json
{"ok":true,"id":1,"watching":true}
```

`false` interrompe la sottoscrizione. È sufficiente il permesso di lettura: anche un osservatore può seguire una risorsa.

`GET /api/me/watches` restituisce esclusivamente sottoscrizioni proprie ancora accessibili, escludendo risorse e antenati eliminati:

```json
{"boards":[{"id":1,"name":"Progetto"}],"cards":[{"id":7,"title":"Revisione","board_id":1}]}
```

## Notifiche personali

`GET /api/notifications?limit=30&before=82`:

```json
{
  "items":[{
    "id":81,"activity_id":120,"board_id":1,"actor":"Sofia","actor_id":2,
    "action":"updated","entity_type":"cards","entity_id":7,
    "title":"Revisione","created_at":"2026-10-15T20:00:00.000Z","read":false
  }],
  "next_cursor":null,
  "unread_count":1
}
```

L'ordine è per ID decrescente. `limit` è un intero da **1 a 100**, predefinito **30**. `before` è un ID positivo esclusivo. Se esistono altri risultati, `next_cursor` contiene l'ID dell'ultimo elemento della pagina; usarlo come `before` nella richiesta successiva. Altrimenti vale `null`. Parametri duplicati, limiti o cursori non validi restituiscono `400`. `unread_count` conta tutte le notifiche non lette attualmente accessibili, indipendentemente dalla pagina.

- `GET /api/notifications/unread-count` → `{"unread_count":1}`.
- `PATCH /api/notifications/:id` con `{"read":true}` segna una notifica come letta; `false` la rende nuovamente non letta. Risposta `200`: `{"ok":true,"id":81}`.
- `POST /api/notifications/read-all` con `{}` segna come lette tutte le notifiche proprie attualmente accessibili. Risposta `200`: `{"ok":true,"id":0}`.

Le notifiche sono **interne all'app**, senza invio email o push. Un trigger SQLite le genera insieme all'inserimento dell'attività per chi segue la bacheca o la scheda. L'autore dell'azione è escluso; seguire entrambe le risorse produce una sola notifica per attività. Gli utenti disattivati o privi di accesso non ricevono nuove notifiche. Ogni lettura e modifica dello stato verifica nuovamente l'accesso: revocare l'appartenenza nasconde anche le notifiche precedenti, salvo l'accesso globale degli amministratori. Gli osservatori possono gestire le proprie notifiche.

## Allegati

`POST /api/cards/:id/attachments`:

```json
{"name":"nota.txt","mime":"text/plain","data_base64":"Y2lhbw=="}
```

Risposta `201`: `{"ok":true,"id":12}`. `data_base64` usa base64 canonico RFC 4648, con padding quando necessario: spazi, ritorni a capo, alfabeti alternativi e bit di padding non canonici sono rifiutati.

Limiti e validazione:

- **1 MiB decodificato per file**, **10 file attivi** e **5 MiB decodificati attivi per scheda**.
- Nome da 1 a **180 caratteri Unicode**, UTF-8 valido; vietati `/`, `\`, caratteri di controllo ASCII, `.` e `..` come nome completo.
- MIME obbligatorio, massimo **100 caratteri**, nella forma `tipo/sottotipo` senza parametri o spazi.
- Un file vuoto è ammesso e occupa una delle dieci posizioni.
- Dati non validi restituiscono `400`; quota della scheda superata restituisce `409`. Il limite HTTP configurabile può rifiutare prima il corpo con `413`.

`GET /api/cards/:id/attachments` restituisce i metadati, inclusi gli allegati eliminati recuperabili, dal più recente:

```json
{"attachments":[{"id":12,"card_id":7,"name":"nota.txt","mime":"text/plain","size":4,"created_at":"2026-10-15T20:00:00.000Z","deleted_at":null}]}
```

`GET /api/attachments/:id` restituisce un involucro JSON; il contenuto caricato non viene servito direttamente come HTML o script:

```json
{"id":12,"name":"nota.txt","mime":"text/plain","data_base64":"Y2lhbw=="}
```

La risposta include `Cache-Control: no-store` e `Content-Disposition: attachment; filename="attachment.json"`. Il client può decodificare il contenuto e scaricarlo usando il nome originale. L'interfaccia usa un download esplicito, senza visualizzare il contenuto caricato nella pagina.

`DELETE /api/attachments/:id` imposta `deleted_at`, libera la quota attiva e restituisce `200` con `{"ok":true,"id":12}`. Il download di un allegato eliminato restituisce `404`. `POST /api/attachments/:id/restore` con `{}` lo ripristina soltanto se le quote attive lo consentono; altrimenti restituisce `409`. Eliminare un allegato già eliminato o ripristinarne uno già attivo restituisce `200` senza duplicarlo.

La lettura richiede accesso alla scheda; caricamento, eliminazione e ripristino richiedono il permesso di scrittura sulla bacheca. Gli osservatori possono leggere e scaricare, ma non modificare allegati. Scheda, lista e bacheca devono essere ancora attive rispetto all'eliminazione; l'archiviazione non equivale all'eliminazione.

Il contenuto è conservato come base64 validato in **SQLite**, senza percorsi di upload sul filesystem. Il backup SQLite include gli allegati, anche eliminati; l'esportazione JSON della singola bacheca non li include e non sostituisce un backup completo.

## Modifica dei commenti

`PATCH /api/comments/:id` con `{"body":"Testo aggiornato"}`. Il testo deve contenere da **1 a 5000 caratteri** e non può essere composto soltanto da spazi. Occorrono accesso in scrittura alla scheda e, con `--auth`, la proprietà del commento oppure il ruolo di amministratore globale.

L'intestazione facoltativa `If-Match: "1"` confronta la versione corrente; è ammessa anche la forma numerica senza virgolette. Una versione diversa restituisce `412` senza modificare il commento. Risposta `200`:

```json
{"ok":true,"id":9,"version":2}
```

`GET /api/cards/:id/comments`, già esistente, restituisce ora anche `version` ed `edited_at` per ciascun commento; `edited_at` vale `null` fino alla prima modifica. La modifica registra l'attività `comment_edited` e aggiorna la revisione della bacheca.

## Profilo personale

`GET /api/me/profile`:

```json
{"id":2,"name":"Sofia","username":"sofia","role":"member"}
```

`PATCH /api/me/profile` con `{"name":"Sofia Rossi"}` modifica esclusivamente il nome visualizzato e restituisce lo stesso oggetto aggiornato. Nome obbligatorio, non composto soltanto da spazi, massimo **100 caratteri**. Il ruolo e l'username non sono modificabili tramite questo endpoint. Anche gli osservatori possono aggiornare il proprio nome.

## Sessioni personali

`GET /api/me/sessions` elenca le sessioni proprie attive, escludendo quelle scadute o inattive da almeno 30 minuti:

```json
{"sessions":[{"id":"50b854be40754db09d220907ab1aecaa6","created_at":1792094400,"last_seen":1792094700,"expires_at":1792123200,"current":true}]}
```

Le date sono **secondi Unix**. Gli ID pubblici sono stringhe esadecimali casuali di 32 caratteri, distinti dai token e dai loro hash; l'endpoint non espone credenziali o token CSRF.

- `DELETE /api/me/sessions/:id` revoca una sessione propria diversa da quella corrente. Risposta `200`: `{"ok":true,"id":0}`. ID assente o di un altro utente: `404`.
- Tentare di revocare la sessione corrente restituisce **409**: usare `/api/auth/logout` per uscire dalla sessione corrente.
- `POST /api/me/sessions/revoke-others` con `{}` revoca tutte le altre sessioni dell'utente e mantiene quella corrente. Risposta `200`: `{"ok":true,"id":0}`.

Anche gli osservatori possono consultare e revocare le proprie sessioni. La revoca rende non valide le successive richieste della sessione interessata.

## Cronologia paginata

`GET /api/boards/:id/activity-page?limit=30&before=121` richiede accesso in lettura alla bacheca e usa gli stessi limiti e cursori esclusivi delle notifiche:

```json
{"items":[{"id":120,"action":"updated","entity_type":"cards","entity_id":7,"title":"Revisione","actor":"Sofia","actor_id":2,"created_at":"2026-10-15T20:00:00.000Z"}],"next_cursor":null}
```

L'endpoint precedente `/api/boards/:id/activity` rimane disponibile; quello nuovo consente di proseguire oltre la prima pagina senza offset.
