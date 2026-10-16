# API teamwork — OpenBoard 0.4

Le rotte sono JSON, usano le sessioni e il token CSRF già documentati in
[API.md](API.md) e applicano le autorizzazioni correnti della bacheca a ogni
richiesta. Le risorse eliminate o non accessibili restituiscono `404`.
Le scritture sono atomiche insieme all'attività e alla revisione della bacheca.
Gli eventuali errori SQL restituiscono `503` e annullano tutte le modifiche.

## Registrazioni del tempo (231–240)

| Metodo e percorso | Comportamento |
| --- | --- |
| `POST /api/cards/:id/worklogs` | Crea una registrazione; `201` con la registrazione completa. |
| `GET /api/cards/:id/worklogs` | Elenca `{items,next_cursor}` in ordine di ID decrescente. |
| `PATCH /api/worklogs/:id` | Modifica minuti, data e/o nota della propria registrazione. |
| `DELETE /api/worklogs/:id` | Elimina logicamente la propria registrazione. |
| `POST /api/worklogs/:id/restore` | Ripristina una registrazione eliminata. |
| `GET /api/cards/:id/time-summary` | Restituisce `{manual_minutes,logged_minutes,total_minutes}`. |
| `GET /api/boards/:id/time-report` | Rapporto della bacheca con righe, totali per autore e giorno. |
| `GET /api/boards/:id/time-export` | Restituisce `{filename,csv}` per esportare il rapporto completo. |
| `GET /api/me/time-report` | Rapporto settimanale delle sole proprie registrazioni nelle bacheche ancora accessibili. |

Corpo di creazione:

```json
{"minutes":45,"date":"2026-10-16","note":"Revisione della proposta"}
```

`minutes` è un intero tra 1 e 1000000; `date` è una data gregoriana reale
`YYYY-MM-DD`, dall'anno 1900 al 9999; `note` è facoltativa, con massimo 2000
caratteri Unicode. Una scheda ammette al massimo 10000 registrazioni, comprese
quelle eliminate, per mantenere limitato lo storico. Il superamento restituisce
`409`. La modifica richiede almeno uno dei tre campi, con gli stessi limiti.

Una registrazione contiene:

```json
{"id":1,"card_id":1,"user_id":2,"author":"Alice","date":"2026-10-16","minutes":45,"note":"Revisione della proposta","version":1,"created_at":"2026-10-16T10:00:00.000Z","updated_at":"2026-10-16T10:00:00.000Z","deleted_at":null}
```

Per modificare, eliminare e ripristinare occorrono sia il permesso di scrittura
sulla bacheca sia la proprietà della registrazione; l'amministratore globale può
intervenire su tutte le registrazioni accessibili. Gli osservatori possono leggere
ma non registrare né modificare tempo. La modalità locale senza account usa
`user_id:0` e l'autore `Locale`.

`If-Match: "1"` consente di verificare la versione per modifica, eliminazione e
ripristino: una versione superata restituisce `412`, una sintassi non valida
`400`. L'intestazione è facoltativa per compatibilità con gli altri endpoint.
Ogni modifica effettiva incrementa `version`; il ripristino di una registrazione
già attiva è idempotente. I POST supportano anche `Idempotency-Key`.

La lista supporta `limit` da 1 a 100 (predefinito 30), `before` con ID positivo e
`include_deleted=1` per comprendere il cestino. La cancellazione di una scheda o
di un antenato nasconde anche le sue registrazioni fino al ripristino.

Il tempo manuale preesistente `cards.actual_minutes` rimane indipendente:
`logged_minutes` somma le registrazioni attive, mentre `total_minutes` somma
minuti manuali e registrati. Registrare tempo aggiorna la revisione della
bacheca, senza sovrascrivere il dato manuale o modificare `cards.version`.

Il rapporto della bacheca accetta `from`, `to` e `user_id`. Le date sono inclusive;
se omesse, l'intervallo è il mese corrente UTC. L'intervallo deve essere ordinato
e durare al massimo 366 giorni. Le righe aggiungono `card_title`, `board_id` e
`board_name` ai campi della registrazione. La risposta contiene:

```json
{"from":"2026-10-01","to":"2026-10-31","rows":[],"truncated":false,"by_user":[{"user_id":2,"author":"Alice","minutes":45}],"daily":[{"date":"2026-10-16","minutes":45}],"totals":{"logged_minutes":45,"entries":1},"total_minutes":45}
```

`rows` comprende al massimo 10000 righe; `truncated:true` segnala altre righe,
mentre totali e aggregati comprendono tutte le registrazioni eleggibili. Gli
archivi sono inclusi per conservare lo storico, le risorse eliminate sono escluse.

Il CSV applica gli stessi filtri del rapporto. Include intestazione e colonne
`date,card_id,card_title,user_id,author,minutes,note`; quota e raddoppia le
virgolette nei campi testuali, preserva virgole e a capo, e antepone un apostrofo
ai valori che potrebbero essere interpretati come formule da un foglio di
calcolo. Rifiuta con `413` un rapporto troncato o con JSON oltre 2 MiB: restringere
l'intervallo invece di esportare dati incompleti. La risposta usa
`Cache-Control: no-store`.

Il rapporto personale richiede `--auth`; `week=YYYY-MM-DD` può essere un giorno
qualsiasi, normalizzato al lunedì, fino alla domenica inclusa. Se omesso usa la
settimana UTC corrente. La risposta aggiunge `week_start` e `week_end`, oltre a
`daily`, `rows` e `total_minutes`. Comprende solo l'utente corrente e rivaluta
l'accesso alle bacheche; la revoca di una membership rimuove subito i dati.

## Discussioni e strumenti personali (241–250)

| Metodo e percorso | Comportamento |
| --- | --- |
| `POST /api/comments/:id/reactions` | Aggiunge la propria reazione `{reaction}`. |
| `DELETE /api/comments/:id/reactions` | Rimuove la propria reazione `{reaction}`. |
| `GET /api/comments/:id/reactions` | Restituisce `{items:[{reaction,count,mine}]}`. |
| `PATCH /api/comments/:id/pin` | Imposta `{pinned:true/false}` con eventuale `If-Match`. |
| `GET /api/cards/:id/pinned-comments` | Restituisce `{comments:[...]}` con i commenti fissati. |
| `GET /api/cards/:id/bookmark` | Restituisce `{id,bookmarked}` per lo stato personale della scheda. |
| `PATCH /api/cards/:id/bookmark` | Imposta il segnalibro personale `{bookmarked:true/false}`. |
| `GET /api/me/bookmarks` | Restituisce `{items,next_cursor}` dei propri segnalibri ancora accessibili. |
| `POST /api/comments/:id/replies` | Crea una risposta `{body}`; `201` con `{ok,id,version}`. |
| `GET /api/comments/:id/thread` | Restituisce `{parent,replies}`. |

Le reazioni ammesse sono `like`, `heart`, `celebrate`, `eyes`, `question`, `done`.
Una persona può usare una volta ciascuna reazione sullo stesso commento;
aggiunte e rimozioni ripetute sono idempotenti. Reazioni e segnalibri richiedono
`--auth` e accesso in lettura: sono disponibili anche agli osservatori. Il
segnalibro è privato, non genera attività condivisa; la lista usa `limit` e
`before` come le registrazioni, ordinati per ID della scheda decrescente.

Fissare un commento e rispondere richiede il permesso di scrittura sulla
bacheca. Il fissaggio incrementa la versione del commento solo quando cambia;
non modifica il suo testo né la data di modifica. Tutti i lettori vedono i
commenti fissati e i conteggi delle reazioni. Le risposte contengono da 1 a
5000 caratteri e non possono essere solo spazi.

`GET /api/cards/:id/comments` conserva il formato precedente e aggiunge a ogni
commento `card_id`, `parent_id`, `pinned` e `reactions`. `parent_id:null` indica
un commento principale. Il thread ha un solo livello: rispondere a una risposta
la collega al commento principale. L'eliminazione del commento principale
**conserva** le risposte, che diventano commenti principali; le sue reazioni
sono eliminate tramite chiave esterna. Modifica/eliminazione dei commenti
conservano le autorizzazioni di autore/amministratore preesistenti.

## Ricerca e filtro delle notifiche

`GET /api/notifications-filtered` conserva il formato della lista notifiche e
aggiunge `filtered_count`. Accetta `limit`, `before`, `unread=1` e `q` fino a
200 caratteri Unicode. La ricerca letterale comprende titolo, autore e azione;
il confronto senza distinzione maiuscole/minuscole usa `lower()` di SQLite
(ASCII), mentre le altre lettere sono confrontate letteralmente. I filtri si
applicano **prima** della paginazione. `unread_count` conta tutte le notifiche
non lette visibili, indipendentemente dalla ricerca; `filtered_count` conta le
notifiche visibili che rispettano i filtri, indipendentemente dal cursore.
Membership revocate e bacheche eliminate sono sempre escluse. L'endpoint
richiede account e restituisce `Cache-Control: no-store`.

## Verifica

`tests/test_teamwork.py` verifica registrazione/modifica/cancellazione/ripristino,
versioni obsolete, date e quote, separazione del tempo manuale, idempotenza,
rollback SQL e revisione, proprietà e osservatori, revoca delle membership,
rapporti settimanali e per intervallo, CSV con formule/virgolette/a capo,
reazioni deduplicate, segnalibri privati e paginati, commenti fissati e thread
con conservazione delle risposte, filtri notifiche prima della paginazione.
