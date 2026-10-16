# API dei moduli e delle richieste interne — OpenBoard 0.6

Le richieste raccolgono esigenze dei membri di una bacheca prima di creare una scheda. Tutte le API richiedono un account autenticato e appartenenza attuale alla bacheca; gli amministratori globali mantengono l'accesso. Le route restituiscono `403` anche in modalità locale `--no-auth`. Non sono moduli pubblici, non inviano email e non contengono credenziali nel frontend.

Le mutazioni usano sessione e `X-CSRF-Token`. `If-Match: "version"` è facoltativo per i client API ed è inviato dal frontend; una versione superata restituisce `412`, un header malformato `400`. Le operazioni POST supportano l'idempotenza globale con `Idempotency-Key`: ripetere chiave e payload restituisce lo stesso risultato senza duplicare record. Ogni scrittura, storico e conversione in scheda partecipa alla stessa transazione: un fallimento annulla tutte le modifiche.

## Permessi

| Operazione | Accesso |
| --- | --- |
| Leggere moduli, richieste, note e storico attivi | Membri attuali, compresi osservatori; amministratori globali |
| Creare/modificare/pubblicare/cestinare/ripristinare moduli e campi | Amministratori della bacheca con ruolo globale scrivente; amministratori globali |
| Inviare una richiesta | Tutti i membri attuali, compresi osservatori, su modulo pubblicato |
| Modificare titolo/risposte | Solo autore, finché lo stato è `new` o `in_review`, senza scheda convertita |
| Aggiungere note | Autore o membri scriventi della bacheca |
| Cambiare stato e convertire | Membri scriventi della bacheca |
| Cestinare/ripristinare una richiesta | Autore o membri scriventi della bacheca |

Ogni lettura ricontrolla appartenenza e bacheca attiva. Una richiesta il cui modulo o bacheca è nel cestino non viene restituita neppure negli elenchi personali. La rimozione di un membro revoca subito l'accesso, anche conservando una sessione già aperta. La pausa del modulo blocca nuovi invii e mantiene leggibili le richieste esistenti.

## Moduli: migliorie 426–432

| Metodo e percorso | Payload / risultato |
| --- | --- |
| `POST /api/boards/:board/intake/forms` | `{name, description?, column_id}` → modulo `201` |
| `GET /api/boards/:board/intake/forms` | `{items: [...], next_cursor: id|null}` |
| `GET /api/intake/forms/:id` | Modulo e campi attivi ordinati |
| `PATCH /api/intake/forms/:id` | Almeno uno di `{name, description, column_id}` |
| `POST /api/intake/forms/:id/publish` | `{}` → pubblica il modulo |
| `POST /api/intake/forms/:id/pause` | `{}` → sospende gli invii |
| `DELETE /api/intake/forms/:id` | Cestino; mantiene campi, risposte e storico |
| `POST /api/intake/forms/:id/restore` | `{}` → ripristina il modulo |

Il modulo contiene `id`, `board_id`, `name`, `description`, `column_id`, `published` booleano, `version`, `created_at`, `updated_at`, `deleted_at`, `can_manage` booleano e `fields`. Nome: 1–200 caratteri non vuoti; descrizione: fino a 4000 caratteri. La destinazione deve essere una colonna attiva della stessa bacheca. Massimo 100 moduli per bacheca, compresi quelli nel cestino. Se una colonna viene rimossa definitivamente, la destinazione diventa `null`, la versione del modulo aumenta e lo storico registra `target_column_removed`: modulo e richieste restano leggibili. Un amministratore deve selezionare una nuova colonna attiva prima di pubblicare nuovamente o convertire richieste.

Gli elenchi supportano `before=<id positivo>` e `limit=1..100` (predefinito 30), in ordine decrescente di ID. `include_deleted=1` negli elenchi e nei dettagli dei moduli è riservato agli amministratori e include anche i campi cestinati. Per membri e osservatori usare il dettaglio senza questo parametro.

## Campi: migliorie 433–437

| Metodo e percorso | Payload / risultato |
| --- | --- |
| `POST /api/intake/forms/:id/fields` | `{key, name, type, required?, options?}` → campo `201`; `If-Match` del modulo |
| `PATCH /api/intake/fields/:id` | Almeno uno di `{name, type, required, options}`; `If-Match` del campo |
| `POST /api/intake/forms/:id/fields/reorder` | `{field_ids: [id,...]}`: ogni campo attivo esattamente una volta; `If-Match` del modulo |
| `DELETE /api/intake/fields/:id` | Cestina il campo; `If-Match` del campo |
| `POST /api/intake/fields/:id/restore` | `{}`; `If-Match` del campo |

Un campo contiene `id`, `key`, `name`, `type`, `required` booleano, `options` array, `position`, `version`, `deleted_at`. La chiave immutabile segue `[a-z][a-z0-9_]{0,39}`; `constructor`, `prototype` e `__proto__` sono vietate. Le chiavi restano univoche nel modulo anche dopo il cestinamento. Nome fino a 200 caratteri; massimo 20 campi attivi. Ripristinare oltre questa quota restituisce `409`.

Tipi ammessi: `text`, `number`, `date`, `boolean`, `select`, forniti anche da `/api/catalog`. `required` accetta booleani JSON, non numeri. I campi `select` richiedono da 1 a 30 opzioni testuali distinte e non vuote, fino a 400 byte ciascuna; gli altri tipi richiedono opzioni vuote. Per cambiare un campo select in un altro tipo inviare anche `options: []`. Ogni variazione di campo incrementa la sua versione e quella del modulo.

## Invio, inbox e dettagli: migliorie 438–441

| Metodo e percorso | Payload / risultato |
| --- | --- |
| `POST /api/intake/forms/:id/requests` | `{title, answers: {key: typedValue}}` → richiesta `201`; `If-Match` del modulo |
| `GET /api/boards/:board/intake/requests` | Inbox della bacheca, paginata |
| `GET /api/me/intake/requests` | Solo richieste dell'autore, ricontrollando accesso attuale |
| `GET /api/intake/requests/:id` | Richiesta, risposte, schema storico e note |

Titolo: 1–300 caratteri non vuoti. `answers` è un oggetto JSON fino a 50000 byte, con sole chiavi dei campi attivi. Il server rifiuta proprietà duplicate, sconosciute, tipi errati, valori null e valori non finiti. Testo: fino a 8000 byte; numeri JSON conservano `0`; booleani conservano `false`; date reali nel formato `YYYY-MM-DD`; scelte presenti nell'elenco delle opzioni. Un campo obbligatorio deve essere presente; testo obbligatorio non può contenere solo spazi, mentre `false` e `0` sono risposte valide. Una data facoltativa può essere stringa vuota. Massimo 10000 richieste per bacheca, compresi record cestinati.

L'invio salva una copia immutabile dei campi ordinati in `schema_snapshot`, le risposte JSON e `form_version`. Le modifiche successive ai campi non alterano lo storico. Se il client invia `If-Match`, l'invio con modulo cambiato restituisce `412` prima della validazione delle risposte.

La richiesta contiene `id`, `form_id`, `form_name`, `board_id`, `author_id`, `author`, `title`, `answers`, `schema_snapshot`, `state`, `converted_card_id`, `converted_card_available` booleano, `version`, `form_version`, `form_changed` booleano, timestamp, `deleted_at`, `can_triage`, `can_edit`, `notes_count` e, nel dettaglio, `notes`. `form_changed` segnala modifiche del modulo successive all'invio. Il frontend usa lo schema storico per le richieste esistenti.

Gli elenchi della bacheca e personali omettono il corpo delle note e includono solo `notes_count`, così il loro payload non cresce con la discussione. Le note complete restano disponibili nel dettaglio e nell’endpoint dedicato.

Gli elenchi supportano `before`, `limit`, `state=new|in_review|accepted|rejected`, `q=<testo fino a 200 caratteri>` e `include_deleted=0|1`. La ricerca usa titolo, autore e nome modulo; i caratteri `%` e `_` sono letterali. I record cestinati vengono restituiti solo all'autore o ai membri scriventi; il dettaglio richiede esplicitamente `?include_deleted=1`.

## Gestione e conversione: migliorie 442–447

| Metodo e percorso | Payload / risultato |
| --- | --- |
| `POST /api/intake/requests/:id/state` | `{state: "new"|"in_review"|"accepted"|"rejected"}` |
| `POST /api/intake/requests/:id/notes` | `{body}` → dettaglio aggiornato `201` |
| `GET /api/intake/requests/:id/notes` | `{items: [note,...]}` in ordine cronologico |
| `PATCH /api/intake/requests/:id` | Almeno uno di `{title, answers}`; solo autore e stato modificabile |
| `POST /api/intake/requests/:id/convert` | `{description?: string}` → dettaglio con `converted_card_id` |
| `DELETE /api/intake/requests/:id` | Cestina la richiesta |
| `POST /api/intake/requests/:id/restore` | `{}` → ripristina |

Le note sono append-only, con autore e data, fino a 2000 caratteri; massimo 1000 per richiesta. Le modifiche alle risposte vengono validate contro **lo schema originale**, anche se il modulo è cambiato, è in pausa o un campo è stato rimosso. Una richiesta accettata o rifiutata può essere rimessa in esame da un membro scrivente prima della modifica dell'autore.

La conversione richiede stato `accepted`, destinazione attiva e permesso di scrittura. Crea una sola scheda con il titolo della richiesta e una descrizione derivata dai nomi e dalle risposte dello schema storico, conservando `false` e `0`. Rispetta quote, WIP, ACL ed eventi della normale creazione schede. Senza descrizione esplicita, testo derivato oltre 10000 byte restituisce `413` senza creare schede. Il client può inviare `description` fino a 10000 caratteri per un riassunto esplicito; le risposte complete restano sulla richiesta. Non vengono troncate silenziosamente.

Creazione scheda e associazione alla richiesta sono atomiche: anche un errore durante l'associazione annulla la scheda. Una seconda conversione senza replay idempotente restituisce `409`. Dopo la conversione titolo, risposte e stato della richiesta non sono modificabili; note e cestino restano disponibili. Cestinare la richiesta non cestina la scheda creata. L’associazione `converted_card_id` resta un riferimento storico immutabile, senza vincolo FK, anche se la scheda viene eliminata definitivamente; la richiesta non diventa nuovamente convertibile e resta conteggiata tra quelle convertite. `converted_card_available` è vero solo quando scheda, colonna e bacheca sono attive e la scheda appartiene ancora alla stessa bacheca: il frontend evita collegamenti indisponibili o ad altre bacheche.

## Storico, statistiche ed esportazione: migliorie 448–450

| Metodo e percorso | Risultato |
| --- | --- |
| `GET /api/intake/requests/:id/history` | `{items, next_cursor}`: eventi con autore, azione, data e nota |
| `GET /api/intake/forms/:id/history` | Storico del modulo e delle sue richieste |
| `GET /api/boards/:board/intake/stats` | Conteggi `total`, `new`, `in_review`, `accepted`, `rejected`, `converted` |
| `GET /api/boards/:board/intake/export` | CSV UTF-8 con download e risposte/schema JSON senza perdita di tipi |

Lo storico usa lo stesso cursore `before` e `limit=1..100`, ed è disponibile anche nel cestino ai soggetti autorizzati a leggere il record cancellato. Le mutazioni registrano creazione, modifica, pubblicazione, pausa, gestione campi, invio, note, stato, conversione, cestino e ripristino. Le statistiche e il CSV escludono richieste o moduli cestinati.

Il CSV contiene `id,form,author,title,state,answers_json,schema_snapshot_json,converted_card_id,created_at`, con quoting corretto per virgole, virgolette e ritorni a capo. I testi che possono essere interpretati come formule vengono prefissati da apostrofo; i documenti JSON restano validi e mantengono le risposte originali. Limite di 1000 richieste o 2 MiB: oltre il limite risponde `413`, senza esportazione parziale.

## Verifica

`tests/test_intake.py` copre le 25 capacità 426–450, incluse autorizzazioni attuali e revocate, ruolo osservatore, CSRF, concorrenza ottimistica, schema evolutivo, date bisestili, `false`/`0`, quote, idempotenza, errori transazionali dopo la creazione della scheda, WIP, cestino, cursori e CSV sicuro. Tutti i dati dei test sono temporanei.
