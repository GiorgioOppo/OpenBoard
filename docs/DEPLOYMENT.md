# Installazione e gestione di OpenBoard 0.3

Il servizio HTTP ascolta su `127.0.0.1`. Gli esempi condivisi attivano gli account; completare il primo setup localmente prima di abilitare un proxy. Eseguire un backup verificato prima di aggiornare l'eseguibile.

## Installazione da sorgente

Compilare con le dipendenze del README, poi:

```sh
make
make install PREFIX=/usr/local
/usr/local/bin/openboard --web-root /usr/local/share/openboard --db /percorso/openboard.db --auth
```

La scrittura in `/usr/local` può richiedere un account amministrativo. Per preparare un pacchetto senza installare nel sistema:

```sh
make install DESTDIR=/percorso/staging PREFIX=/usr/local
```

`install` copia eseguibile e asset, senza modificare database, account o servizi.

## Configurazione tramite ambiente

| Variabile | Predefinito | Valori |
| --- | --- | --- |
| `OPENBOARD_PORT` | `8080` | 1–65535 |
| `OPENBOARD_WORKERS` | `8` | 1–32 |
| `OPENBOARD_DB` | `data/openboard.db` | Percorso non vuoto |
| `OPENBOARD_WEB_ROOT` | `web` | Directory non vuota |
| `OPENBOARD_PUBLIC_URL` | Assente | Origine HTTP/HTTPS senza percorso o slash finale |
| `OPENBOARD_AUTH` | `false` | `true/false`, `yes/no`, `1/0` |
| `OPENBOARD_NO_DEMO` | `false` | Come sopra |
| `OPENBOARD_QUIET` | `false` | Come sopra |
| `OPENBOARD_BUSY_TIMEOUT` | `5000` | Millisecondi, 1–60000 |
| `OPENBOARD_BODY_LIMIT` | `2097152` | Byte, 4096–2097152 |

Le opzioni CLI prevalgono sulle variabili valide. Una variabile non valida interrompe l'avvio. `--busy-timeout` e `--body-limit` impostano gli stessi limiti; ridurre il secondo può impedire il caricamento di allegati grandi. Credenziali e token non vengono letti da queste variabili.

## Container Linux

L'immagine usa una fase di compilazione separata e avvia il processo con UID/GID 10001. Il database vive in `/var/lib/openboard`; il controllo health usa `/api/ready`. La base è Debian Trixie e il Dockerfile usa `USER`, `HEALTHCHECK` e `STOPSIGNAL` secondo i riferimenti ufficiali: [Debian](https://www.debian.org/releases/trixie/), [Dockerfile](https://docs.docker.com/reference/dockerfile/).

```sh
docker compose config --quiet
docker compose up --build -d
docker compose logs --follow
```

Il file Compose è per **Linux con rete host**: il loopback del container coincide con quello dell'host e non vengono pubblicate porte su tutte le interfacce. Questo esempio non costituisce una configurazione portabile per Docker Desktop con rete bridge. Su macOS il binario locale è il percorso di avvio diretto.

Il volume `openboard-data` conserva i dati. `docker compose down` arresta il servizio mantenendo il volume; non usare `down --volumes` se i dati devono essere conservati. Per aggiornare, creare e verificare prima un backup, ricompilare e riavviare. Il backup precedente alla migrazione viene scritto accanto al database.

In questo ambiente `docker compose config --quiet` è stato verificato. Il daemon Docker locale non è attivo: la build e lo smoke test del container sono configurati nella CI e richiedono la sua effettiva esecuzione.

## Servizio systemd e proxy

`deploy/openboard.service` usa `DynamicUser`, `StateDirectory`, `UMask=0077`, directory di sistema protette e nessuna capability. Dopo l'installazione del binario e degli asset, copiare l'unità nella directory systemd del sistema e abilitarla secondo la propria gestione del servizio. Non è necessario creare un utente permanente a mano.

Le personalizzazioni possono stare in `/etc/openboard.env`, ad esempio:

```text
OPENBOARD_WORKERS=8
OPENBOARD_PUBLIC_URL=https://board.example.com
```

`deploy/nginx.conf.example` mostra il virtual host HTTPS. Sostituire dominio e percorsi dei certificati, impostare la stessa origine pubblica in OpenBoard e completare il setup amministrativo prima di esporre il proxy. Il proxy inoltra un request ID; il backend accetta solo identificativi di 1–63 caratteri ASCII alfanumerici o `-_.:` e rifiuta i duplicati.

Questi esempi non modificano automaticamente firewall, certificati o servizi del computer corrente. Le unità systemd e nginx richiedono verifica sul sistema Linux di destinazione.

## Diagnostica e manutenzione SQLite

```sh
./build/openboard --db data/openboard.db --diagnostics
./build/openboard --db data/openboard.db --integrity-check
./build/openboard --db data/openboard.db --checkpoint
./build/openboard --db data/openboard.db --backup /percorso/backup.db
```

Diagnostica e integrità aprono un database esistente in lettura, senza creare lo schema o avviare il server. La diagnostica riporta versioni applicativa/SQLite/OpenSSL, supporto thread, schema e limiti; uno schema `-1` indica database non leggibile o inesistente. Il controllo di integrità restituisce successo solo per `PRAGMA integrity_check = ok`.

Il checkpoint apre il database esistente in scrittura ed esegue `wal_checkpoint(TRUNCATE)` senza migrazioni. Un writer o lettore persistente può impedire il checkpoint; in quel caso il comando termina con errore. Non combinare i comandi di manutenzione fra loro o con `--backup`.

Gli allegati sono base64 nel database. I limiti per scheda contano i file attivi; i file nel cestino conservano spazio fisico e contenuto per il ripristino. Non è previsto un comando di purge. Pianificare backup e capacità tenendo conto di questa conservazione.

## Metriche e verifiche

`GET /api/metrics` restituisce testo Prometheus con contatori di richieste, errori HTTP, durata complessiva e sovraccarichi, più gauge di richieste attive, connessioni in coda e worker. Non contiene percorsi, utenti, contenuti o credenziali. Con account attivi richiede la sessione di un amministratore globale; senza account è leggibile localmente. Le risposte hanno `Cache-Control: no-store`.

`/api/health` controlla il processo, `/api/ready` legge il database e `/api/version` riporta la versione. Un healthcheck riuscito non equivale a una prova di ripristino del backup.

```sh
make test
make test-sanitize
make test-frontend
```

L'ultimo comando usa Node.js soltanto per verificare Markdown, CSV e iCalendar. Il runtime del servizio resta C/SQLite/OpenSSL.
