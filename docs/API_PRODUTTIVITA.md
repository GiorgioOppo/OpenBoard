# API di produttività — OpenBoard 0.3

Queste API aggiungono pianificazione, assegnatari, dipendenze, modelli personali, filtri salvati e modifiche collettive. Usano le stesse sessioni, CSRF, risposte JSON e regole di accesso descritte in [API.md](API.md). In modalità locale gli oggetti personali appartengono all'utente locale `0`.

Le scritture condivise richiedono il permesso di modifica della bacheca. I filtri salvati richiedono soltanto la lettura della bacheca e appartengono all'utente corrente: anche un osservatore può crearli, rinominarli ed eliminarli. Nessuno può leggere o modificare i filtri di un altro account.

## Pianificazione delle schede

`POST /api/columns/:id/cards` e `PATCH /api/cards/:id` accettano questi campi aggiuntivi. Le risposte della scheda completa e della bacheca `?summary=1` li includono.

| Campo | Tipo e vincoli | Valore iniziale |
| --- | --- | --- |
| `start_date` | Data di calendario valida `YYYY-MM-DD`, oppure stringa vuota. Se entrambe presenti, inizio ≤ `due_date`. Anche una modifica parziale verifica la data già salvata. | `""` |
| `blocked_reason` | Stringa, massimo 1.000 caratteri. | `""` |
| `actual_minutes` | Intero fra 0 e 1.000.000. | `0` |
| `reference_url` | Stringa vuota o URL `http://`/`https://`, massimo 2.000 caratteri; niente caratteri di controllo, spazi, backslash o credenziali nel dominio. | `""` |
| `assignee_ids` | Array di massimo 100 ID numerici positivi, senza duplicati. | `[]` |

Esempio di aggiornamento con controllo di concorrenza:

```http
PATCH /api/cards/42
Content-Type: application/json
If-Match: "7"
X-CSRF-Token: <token>

{"start_date":"2026-11-02","due_date":"2026-11-05","blocked_reason":"In attesa della revisione","actual_minutes":90,"reference_url":"https://example.org/specification","assignee_ids":[3,8]}
```

Le stringhe vuote cancellano i campi testuali. I campi omessi conservano il valore precedente. Date o tipi non validi producono `400`; una versione `If-Match` superata produce `412`.

## Assegnatari reali e attività personali

Gli ID devono indicare utenti attivi che possano leggere la bacheca: amministratori globali oppure suoi membri espliciti. La validazione e la scrittura avvengono nella stessa transazione della scheda; un assegnatario non valido annulla l'intera modifica. In modalità senza account è ammesso soltanto l'array vuoto.

Il campo storico `assignee`, una stringa libera, rimane indipendente per compatibilità. Gli ID reali non sono dedotti dai nomi.

| Metodo e percorso | Corpo / risposta |
| --- | --- |
| `GET /api/cards/:id/assignees` | `{"assignees":[{"id":3,"name":"Ada","username":"ada"}]}` |
| `PATCH /api/cards/:id/assignees` | Corpo `{"user_ids":[3,8]}`. Risposta `{"ok":true,"id":42,"version":8}`. Supporta `If-Match`. |
| `GET /api/me/tasks` | `{"cards":[...]}`; ogni scheda completa contiene anche `board_id`, `board_name`, `column_title`. |

La scheda completa include sia `assignee_ids` sia `assignees`. “Mie attività” comprende soltanto schede assegnate all'ID della sessione corrente, aperte, non archiviate, appartenenti a bacheche non archiviate e attualmente accessibili. Non usa il nome libero `assignee`. La revoca dell'accesso alla bacheca rende immediatamente invisibili le relative attività; un osservatore può consultare le proprie attività senza acquisire il permesso di modificarle.

## Dipendenze

Una dipendenza `A → B` significa che B deve essere completata prima di completare A.

| Metodo e percorso | Corpo / risposta |
| --- | --- |
| `GET /api/cards/:id/dependencies` | `{"dependencies":[{"id":15,"title":"Revisione","completed":false}]}` |
| `POST /api/cards/:id/dependencies` | Corpo `{"required_card_id":15}`. Risposta `201` con ID e nuova versione della scheda. |
| `DELETE /api/cards/:id/dependencies/:required_id` | Elimina il collegamento; risposta `200` con ID e nuova versione. |

Le schede devono appartenere alla stessa bacheca. Una dipendenza verso se stessa produce `400`, un ciclo diretto o indiretto `409`. Il controllo del ciclo avviene nella transazione di scrittura: due richieste concorrenti non possono creare un ciclo.

Il completamento con dipendenze incomplete produce `409`. Una scheda prerequisito cestinata, o la cui lista sia cestinata, rimane insoddisfatta; la dipendenza va rimossa oppure il prerequisito ripristinato e completato. Non si può aggiungere un prerequisito incompleto a una scheda già completata. Le modifiche ai collegamenti supportano `If-Match`, incrementano la versione della scheda e registrano l'attività della bacheca.

## Modelli personali

Un modello conserva uno snapshot al momento della creazione. Successive modifiche o eliminazioni dell'originale non lo cambiano. Elenco e istanziazione sono riservati al proprietario; il proprietario e un amministratore globale possono eliminare il modello. Le operazioni condivise restano soggette ai permessi della destinazione.

| Metodo e percorso | Corpo / risposta |
| --- | --- |
| `POST /api/templates/cards` | `{"card_id":42,"name":"Scheda di revisione"}` → `201`, `{"ok":true,"id":5}` |
| `GET /api/templates/cards` | `{"templates":[{"id":5,"name":"Scheda di revisione","created_at":"..."}]}` |
| `POST /api/templates/cards/:id/instantiate` | `{"column_id":9}` → `201`, ID e versione della nuova scheda. Il limite WIP è applicato dal server. |
| `DELETE /api/templates/cards/:id` | Elimina il modello, senza eliminare schede già create. |
| `POST /api/templates/boards` | `{"board_id":2,"name":"Progetto standard"}` → `201`, ID del modello. |
| `GET /api/templates/boards` | Stessa struttura `templates` dell'elenco dei modelli di scheda. |
| `POST /api/templates/boards/:id/instantiate` | `{"name":"Nuovo progetto"}` oppure `{}`. Crea una bacheca con liste, limiti WIP e schede dello snapshot. La nuova bacheca è attiva e non preferita. |
| `DELETE /api/templates/boards/:id` | Elimina il modello. |

I modelli non assegnano automaticamente membri della bacheca sorgente alla destinazione e non copiano ID di assegnatari reali. I nomi liberi storici restano parte del contenuto della scheda. I modelli di scheda non copiano dipendenze, allegati, commenti, attività o cestino.

## Filtri salvati

| Metodo e percorso | Corpo / risposta |
| --- | --- |
| `POST /api/boards/:id/views` | `{"name":"Urgenti aperte","filters":{"priority":"urgent","status":"open","sort":"due"}}` → `201`, ID della vista. |
| `GET /api/boards/:id/views` | `{"views":[{"id":6,"name":"Urgenti aperte","filters":{...}}]}` |
| `PATCH /api/views/:id` | `{"name":"Nuovo nome"}` e/o `{"filters":{...}}`. L'oggetto `filters`, se presente, sostituisce quello precedente. |
| `DELETE /api/views/:id` | Elimina la vista personale. |

Il nome deve contenere testo e avere massimo 200 caratteri. L'oggetto `filters` ammette soltanto chiavi note, senza duplicati; tutti i valori sono stringhe di massimo 200 caratteri.

| Chiave | Valori ammessi dal server |
| --- | --- |
| `search`, `query` | Testo libero; `query` è un alias compatibile. |
| `label` | `""`, `design`, `sviluppo`, `ricerca`, `marketing`, `urgente` |
| `assignee` | Nome libero o valore di filtro del client. |
| `priority` | `""`, `low`, `normal`, `high`, `urgent` |
| `status` | `""`, `open`, `completed`, `overdue`, `due-soon`, `blocked` |
| `sort` | `manual`, `due`, `priority`, `title`, `created`, `updated` |

La persistenza non esegue query o codice inviato dal client. L'interfaccia 0.3 propone i filtri e gli ordinamenti che sa applicare; l'API conserva soltanto valori conformi alla whitelist.

## Modifiche collettive atomiche

```http
POST /api/boards/2/bulk
Content-Type: application/json

{"action":"complete","value":true,"cards":[{"id":42,"version":7},{"id":43,"version":12}]}
```

`action` accetta `complete` o `archive`; `value` è un booleano. Sono richieste da 1 a 500 schede, con ID univoci e versione intera positiva per ciascuna. Risposta: `{"ok":true,"updated":2}`.

Tutte le schede devono essere attive e appartenere alla bacheca indicata. Prima della scrittura il server verifica ogni versione e l'intero stato finale richiesto. Una versione superata produce `412`; dipendenze insoddisfatte o WIP superato producono `409`; una scheda estranea o non accessibile produce `404`. In ogni caso di errore nessuna scheda viene modificata.

Un batch può completare insieme una scheda e i suoi prerequisiti. Riapertura e ripristino dall'archivio verificano il WIP collettivo nelle sole liste coinvolte, impedendo che più schede riaperte contemporaneamente aggirino il limite. Ogni scheda modificata genera un evento; versioni, eventi e notifiche vengono confermati nella stessa transazione. Per un nuovo tentativo dopo un risultato ambiguo si può riusare la stessa `Idempotency-Key` e lo stesso corpo.

## Esportazione, importazione e conservazione

Il formato JSON resta `openboard`, versione `2`, compatibile con i file precedenti. Le quattro nuove proprietà testuali/numeriche di pianificazione sono esportate, validate durante l'importazione e conservate anche nelle copie delle bacheche.

L'esportazione include gli ID degli assegnatari nello snapshot della scheda, ma l'importazione li ignora: gli ID di account non sono portabili tra installazioni e non danno automaticamente accesso alla nuova bacheca. Occorre riassegnare gli utenti reali dopo l'importazione. La copia di una scheda nella stessa bacheca può conservare gli assegnatari ancora validi; la copia o istanziazione di una bacheca non copia queste relazioni.

Il JSON di bacheca non contiene dipendenze, account, membership, sessioni, allegati, commenti, attività, modelli personali o filtri salvati. Un backup SQLite conserva l'intero database, incluse queste relazioni. Cestino e archivio sono operazioni reversibili: non liberano automaticamente lo spazio fisico. I modelli e i filtri personali si eliminano mediante i rispettivi endpoint; i loro contenuti restano indipendenti dagli originali.

## Verifica

[tests/test_productivity.py](../tests/test_productivity.py) verifica campi e date parziali, round trip JSON, grafo delle dipendenze e richieste concorrenti, prerequisiti cestinati, snapshot dei modelli, WIP, persistenza e isolamento dei filtri, assegnatari attivi, revoca degli accessi, batch atomici, versioni superate e privilegi degli osservatori. I test del dominio precedente restano eseguiti nella suite completa.
