# OpenBoard

Una piccola app kanban open source ispirata a Trello, con **server in C e database SQLite**. L'interfaccia web è scritta in HTML, CSS e JavaScript senza framework, dipendenze npm, CDN o servizi esterni.

![Bacheca OpenBoard](docs/preview.jpg)

## Avvio rapido

Servono un compilatore C11, `make` e la libreria di sviluppo SQLite con supporto JSON.

Su macOS, gli strumenti della riga di comando di Xcode includono il necessario:

```sh
xcode-select --install
```

Su Debian/Ubuntu:

```sh
sudo apt-get install build-essential libsqlite3-dev python3
```

Dalla cartella del progetto:

```sh
make
make run
```

Apri **http://127.0.0.1:8080**. Al primo avvio vengono create tre bacheche dimostrative; le modifiche successive vengono salvate in `data/openboard.db`. Ferma il server con `Ctrl+C`.

Puoi scegliere porta, database e cartella degli asset:

```sh
./build/openboard --port 8090 --db data/personale.db --web-root web
```

## Cosa puoi fare

- Creare, rinominare, personalizzare e rimuovere bacheche; aggiungerle ai preferiti.
- Aggiungere, rinominare e rimuovere colonne.
- Creare e modificare schede con descrizione, etichetta, scadenza, assegnatario, copertina e checklist.
- Spostare e riordinare schede con il trascinamento oppure dal selettore della colonna nell'editor.
- Cercare schede, applicare filtri e passare dalla bacheca alla vista elenco.
- Esportare una bacheca in JSON.

Le preferenze dell'interfaccia rimangono nel browser; bacheche e schede rimangono nel database. L'esportazione JSON è una copia leggibile della bacheca, non un backup ripristinabile dall'interfaccia.

## Struttura

```text
src/server.c        Server HTTP, API JSON, schema e dati iniziali SQLite
web/index.html      Struttura dell'interfaccia
web/styles.css      Stili e layout responsive
web/app.js          Interazioni e comunicazione con le API
tests/test_api.py   Test di integrazione con database temporaneo
Makefile            Compilazione e comandi di sviluppo
data/               Database locale, escluso dal controllo versione
build/              Eseguibile, escluso dal controllo versione
```

Il server usa socket POSIX e statement SQLite preparati. Serve soltanto gli asset previsti e le API; non necessita di Node.js. I dati iniziali vengono inseriti una volta sola per database.

La documentazione degli endpoint e dei campi si trova in [docs/API.md](docs/API.md).

## Verifica

```sh
make test
```

I test avviano il server su una porta locale libera con un database temporaneo, verificano operazioni CRUD, ordinamento, persistenza e gestione degli input non validi. Non toccano il database personale.

## Dati e ambito

Questa versione è pensata per **uso personale in locale**: ascolta su `127.0.0.1`, senza account, autenticazione o collaborazione in tempo reale. Gli assegnatari sono nomi sulle schede, non utenti con un accesso. Prima di un impiego condiviso servono autenticazione, autorizzazioni e una strategia per modifiche concorrenti.

Per un backup completo, arresta il server e copia il file SQLite. Per iniziare con un database separato usa `--db` con un nuovo percorso. `make clean` elimina soltanto gli artefatti di compilazione.

## Contribuire

Vedi [CONTRIBUTING.md](CONTRIBUTING.md). Il codice è disponibile con licenza [MIT](LICENSE). OpenBoard è un progetto indipendente e non è affiliato a Trello o Atlassian.
