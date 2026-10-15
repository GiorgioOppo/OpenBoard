# API di OpenBoard

Le API sono servite dalla stessa origine dell'interfaccia, per impostazione predefinita `http://127.0.0.1:8080`. Le risposte sono JSON. Le richieste `POST` e `PATCH` devono avere `Content-Type: application/json` e un oggetto JSON come corpo.

| Metodo | Percorso | Operazione |
| --- | --- | --- |
| GET | `/api/health` | Stato del server: `{"status":"ok"}` |
| GET | `/api/boards` | Elenco: `{"boards":[...]}` |
| GET | `/api/boards/:id` | Bacheca completa con colonne e schede ordinate |
| POST | `/api/boards` | Crea bacheca e tre colonne iniziali |
| PATCH | `/api/boards/:id` | Modifica bacheca |
| DELETE | `/api/boards/:id` | Elimina bacheca, colonne e schede |
| POST | `/api/boards/:id/columns` | Aggiunge colonna |
| PATCH | `/api/columns/:id` | Rinomina colonna |
| DELETE | `/api/columns/:id` | Elimina colonna e schede |
| POST | `/api/columns/:id/cards` | Aggiunge scheda |
| PATCH | `/api/cards/:id` | Modifica, sposta o riordina scheda |
| DELETE | `/api/cards/:id` | Elimina scheda |

Le creazioni restituiscono HTTP `201`, le altre modifiche HTTP `200`, con corpo `{"ok":true,"id":123}`. Gli errori hanno forma `{"error":"Messaggio leggibile"}`: `400` per dati non validi, `403` per origine o host non consentiti, `404` per risorse mancanti, `405` per metodi non previsti, `413` per corpi troppo grandi e `415` per formato non supportato.

## Campi

Una bacheca contiene `id`, `name`, `description`, `color` e `starred`. `name` è obbligatorio alla creazione. `color` può essere `sage`, `peach`, `lavender` o `blue`. Le colonne contengono `id`, `title`, `position` e, nella risposta completa, `cards`.

Una scheda contiene:

```json
{
  "id": 123,
  "column_id": 4,
  "title": "Preparare il lancio",
  "description": "Dettagli dell'attività",
  "label": "sviluppo",
  "due_date": "2026-10-20",
  "assignee": "Giulia",
  "cover": "sage",
  "position": 0,
  "completed": false,
  "checklist": [{"id": "item-1", "text": "Revisione", "done": false}]
}
```

Alla creazione basta `title`. I campi facoltativi testuali hanno valore iniziale vuoto; `checklist` è un array vuoto e `completed` è `false`. Le etichette ammesse sono `design`, `sviluppo`, `ricerca`, `marketing`, `urgente` o stringa vuota. Le copertine usano i colori delle bacheche oppure stringa vuota. La scadenza è una data di calendario valida `YYYY-MM-DD` oppure stringa vuota.

Le modifiche alle schede sono parziali: i campi omessi conservano il valore precedente. Per spostare una scheda, invia `column_id` della colonna di destinazione nella stessa bacheca. `position` è l'indice da zero nell'elenco dopo aver rimosso la scheda dalla posizione precedente. Se cambi colonna senza specificare la posizione, la scheda viene inserita in fondo. Il server aggiorna entrambe le colonne in una transazione.

## Limiti

Nomi di bacheche e titoli di colonne: 200 caratteri Unicode; titoli delle schede: 300. Descrizioni: 2.000 per le bacheche e 10.000 per le schede. Una checklist può contenere fino a 100 voci con identificativi univoci, testo fino a 500 caratteri e stato booleano. Il corpo HTTP può contenere fino a 65.536 byte; le intestazioni fino a 16.384 byte.

Il server ascolta solo su loopback, verifica l'host e rifiuta scritture provenienti da origini diverse. Non implementa autenticazione o autorizzazioni per utenti: queste API sono destinate all'istanza locale personale.
