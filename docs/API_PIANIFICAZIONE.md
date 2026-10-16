# API di pianificazione — OpenBoard 0.4

Le funzioni 201–230 aggiungono campi personalizzati, traguardi, regole della bacheca e report di carico. Le richieste richiedono la stessa sessione, CSRF e autorizzazione della bacheca delle altre API. Le scritture sono transazionali: un errore annulla l'intera richiesta; gli osservatori possono leggere. Gli ID numerici sono locali al database, mentre le chiavi di campo e traguardo sono stabili nell'esportazione.

## Campi personalizzati

- `GET /api/boards/:id/fields` → `{fields:[...]}`. `?include_deleted=1` comprende il cestino.
- `POST /api/boards/:id/fields` → `201 {ok,id}`. Corpo: `{key,name,type,options?,position?}`.
- `PATCH /api/fields/:id` → `{ok,id}`. Corpo: `{name?,position?}`.
- `DELETE /api/fields/:id` nasconde la definizione conservando i valori delle schede.
- `POST /api/fields/:id/restore`, corpo `{}`, riattiva la definizione in fondo all'elenco.

La chiave è immutabile, unica nella bacheca anche nel cestino e segue `[a-z][a-z0-9_]{0,39}`. Il nome contiene da 1 a 100 caratteri, con almeno un carattere non bianco. Anche il tipo e le opzioni sono immutabili: cambiare tipo potrebbe reinterpretare dati già salvati. Per un'altra struttura si crea un nuovo campo. `position` è un indice da zero. La bacheca ammette 20 definizioni attive e 100 complessive, comprese quelle eliminate.

Ogni definizione restituisce `{id,key,name,type,options,position,deleted_at}`. Tipi e valori:

| Tipo | Valore JSON consentito |
| --- | --- |
| `text` | Stringa Unicode valida, al massimo 2000 caratteri; niente NUL |
| `number` | Numero JSON finito compreso fra −10¹² e 10¹² |
| `date` | Stringa `YYYY-MM-DD` con data di calendario valida |
| `boolean` | `true` o `false` |
| `select` | Stringa identica a una delle opzioni |

I campi `select` richiedono da 1 a 30 opzioni distinte, di 1–100 caratteri. Gli altri tipi usano un array vuoto. Chiavi JSON duplicate, valori strutturati, chiavi sconosciute e valori di tipo errato producono `400`.

Le schede complete e riassunte includono `custom_values`, un oggetto con chiavi stabili e valori JSON tipizzati. `POST` e `PATCH` ordinari della scheda accettano `custom_values`. In alternativa:

- `GET /api/cards/:id/fields` → `{values,version}`.
- `PATCH /api/cards/:id/fields` con `{values:{cost:120,approved:false,note:null}}` → `{ok,id,version}`.

Le modifiche sono un'unione parziale: i campi omessi mantengono il valore e `null` rimuove un valore. `If-Match: <version>` protegge dalle scritture concorrenti e restituisce `412` se la versione è cambiata. Si possono inviare soltanto chiavi attive; i valori dei campi eliminati restano conservati e tornano visibili ripristinando la definizione. Per modificare un'altra proprietà della scheda basta ometterli dalla richiesta.

`GET /api/boards/:id/field-search?key=approved&value=false` cerca un valore tipizzato esatto tra le schede attive della bacheca e restituisce `{cards:[...]}`. Il parametro `value` è JSON codificato nell'URL: una stringa richiede le virgolette, ad esempio `%22Italia%22`. I numeri interi e reali equivalenti corrispondono. Restano applicati i limiti HTTP sulla lunghezza della query.

## Traguardi

- `GET /api/boards/:id/milestones` → `{milestones:[...]}`.
- `POST /api/boards/:id/milestones` con `{key?,title,due_date?,completed?}` → `201 {ok,id}`.
- `PATCH /api/milestones/:id` con `{title?,due_date?,completed?}` → `{ok,id}`.
- `DELETE /api/milestones/:id` e `POST /api/milestones/:id/restore` con `{}` gestiscono il cestino.

Il titolo contiene 1–200 caratteri non tutti bianchi. La scadenza è una data valida o `""`; `completed` è booleano. Se omessa, la chiave viene generata. Le chiavi rispettano lo stesso formato dei campi, restano immutabili e uniche anche nel cestino. Limiti: 100 traguardi attivi, 200 complessivi.

Gli elementi restituiscono `{id,key,title,due_date,completed,deleted_at,total,done,overdue}`. I conteggi includono le schede non archiviate e non eliminate in liste attive; `done` conta quelle completate. Il completamento del traguardo è esplicito, indipendente dal conteggio delle schede. `overdue` è vero per un traguardo attivo non completato con scadenza precedente alla data UTC del server. `?overdue=1` filtra questo report; `?include_deleted=1` include il cestino.

Le schede includono `milestone_key`. Il salvataggio ordinario accetta una chiave attiva della stessa bacheca; `""` disassocia la scheda. Eliminare il traguardo conserva le associazioni per il ripristino. Le modifiche successive devono omettere la chiave eliminata se invariata, oppure inviare `""` per rimuoverla.

## Azioni multiple e linee guida

`POST /api/boards/:id/bulk` accetta, oltre a completamento e archiviazione, queste azioni:

```json
{"action":"priority","value":"high","cards":[{"id":12,"version":3}]}
{"action":"labels","value":["design","ricerca"],"cards":[{"id":12,"version":4}]}
{"action":"milestone","value":"release","cards":[{"id":12,"version":5}]}
```

Sono ammesse 1–500 schede univoche della bacheca. Ogni versione è verificata prima della scrittura; un conflitto restituisce `412` e nessuna scheda viene modificata. Priorità ed etichette mantengono gli enum dell'API ordinaria. L'azione `labels` sostituisce l'insieme e aggiorna anche l'etichetta primaria; `milestone` accetta `""` per disassociare. La risposta è `{ok:true,updated:N}`. `Idempotency-Key` usa le stesse garanzie delle altre richieste POST.

`POST /api/boards` e `PATCH /api/boards/:id` accettano `guidelines`, testo Markdown Unicode fino a 10000 caratteri. La bacheca completa lo restituisce; l'interfaccia visualizza un sottoinsieme sicuro del Markdown senza eseguire HTML.

## Report di carico

`GET /api/boards/:id/workload` restituisce:

- `total`, `completed`, `blocked` per schede attive, non archiviate, in liste attive.
- `estimate_minutes`, `actual_minutes`, `logged_minutes`, `total_minutes`.
- `by_priority`, oggetto priorità → conteggio.
- `by_milestone`, righe con `key,title,total,completed,estimate_minutes,total_minutes`.
- `cards`, dettagli sintetici per scheda con priorità, traguardo, tempi e motivo di blocco.

Una scheda è bloccata se ha un motivo esplicito oppure una dipendenza incompleta o eliminata, inclusa una dipendenza in una lista eliminata. `actual_minutes` è il tempo manuale preesistente. `logged_minutes` somma soltanto registrazioni di lavoro attive. `total_minutes` è la loro somma; le registrazioni non modificano il tempo manuale. Anche le schede complete e riassunte restituiscono questi ultimi due campi. Le somme possono superare il limite di una singola registrazione.

## Esportazione, importazione e copie

Il formato JSON OpenBoard versione 2 rimane retrocompatibile. La bacheca esportata aggiunge `guidelines`, `custom_fields`, `milestones`; le schede aggiungono `custom_values` e `milestone_key`. Le definizioni eliminate sono incluse con `deleted_at`, così i valori nascosti possono essere ripristinati dopo il trasferimento. L'importazione verifica tipi, opzioni, chiavi, limiti attivi e riferimenti prima del commit. Gli ID vengono rigenerati; lo stato di eliminazione viene conservato con un nuovo timestamp. La posizione segue l'ordine delle definizioni esportate. Un errore in qualsiasi scheda annulla l'intera importazione.

Le copie e i modelli di bacheca preservano regole, definizioni, traguardi e valori anche nascosti. La copia di una singola scheda mantiene i soli valori di campi attivi e un traguardo attivo; il modello di una singola scheda esclude tutti i campi personalizzati e l'associazione al traguardo per poter essere usato in un'altra bacheca. Le registrazioni di lavoro, i commenti e le reazioni non sono clonati dal formato bacheca: per il trasferimento del tempo usare l'esportazione dedicata, per un recupero completo usare il backup SQLite.

L'aggiornamento al database schema 5 conserva i dati precedenti e crea prima un backup `*.pre-v4.bak` con permessi `0600`.

## Verifiche

`tests/test_planning.py` copre i cinque tipi, Unicode/NUL e limiti, merge e cancellazione, conflitti di versione, ricerca, campi e traguardi eliminati/ripristinati, concorrenza su chiavi, importazioni atomiche, copie e modelli, operazioni multiple, carico con tempo registrato, migrazione da schema 4 e isolamento con osservatori e utenti senza accesso. La suite passa anche con AddressSanitizer e UndefinedBehaviorSanitizer.
