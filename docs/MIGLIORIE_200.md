# Secondo gruppo di 100 migliorie di OpenBoard

> **Historical archive (Italian).** This document records an earlier analysis or implementation checklist. Its setup examples, security assumptions and roadmap may be superseded. For current guidance, use the [documentation index](README.md), [deployment guide](DEPLOYMENT.md) and [changelog](../CHANGELOG.md).

OpenBoard 0.3 amplia il lavoro quotidiano dei team. Questo elenco prosegue dagli interventi 001–100 della versione 0.2: le nuove voci sono numerate 101–200. Le spunte indicano funzionalità implementate e verificate nel perimetro descritto in fondo.

## Installazione e gestione del servizio

- [x] 101 Installazione di eseguibile e asset con PREFIX e DESTDIR.
- [x] 102 Immagine Docker con compilazione separata e utente non privilegiato.
- [x] 103 Configurazione Compose Linux con volume persistente e healthcheck.
- [x] 104 Unità systemd con directory di stato e restrizioni del servizio.
- [x] 105 Esempio di reverse proxy nginx HTTPS con limiti coerenti.
- [x] 106 Configurazione tramite variabili di ambiente con precedenza della CLI.
- [x] 107 Metriche Prometheus di richieste, errori, durate, code e worker.
- [x] 108 Comando di controllo dell'integrità di un database esistente.
- [x] 109 Comando di checkpoint WAL senza migrazioni applicative.
- [x] 110 Attesa dei lock SQLite configurabile.
- [x] 111 Limite del corpo HTTP configurabile entro il massimo supportato.
- [x] 112 Rifiuto delle codifiche del corpo HTTP non supportate.
- [x] 113 Protezione degli asset da collegamenti simbolici a file esterni.
- [x] 114 Diagnostica JSON con versioni delle dipendenze, schema e limiti.
- [x] 115 Correlazione delle richieste con X-Request-ID del client validato.

## Pianificazione e produttività

- [x] 116 Data di inizio delle schede, coerente con la scadenza.
- [x] 117 Motivo del blocco di una scheda.
- [x] 118 Registrazione dei minuti effettivamente impiegati.
- [x] 119 Collegamento esterno di riferimento con schema HTTP o HTTPS.
- [x] 120 Assegnazione multipla a utenti reali autorizzati della bacheca.
- [x] 121 API delle attività assegnate all'utente corrente.
- [x] 122 Creazione delle dipendenze fra schede della stessa bacheca.
- [x] 123 Consultazione delle dipendenze con stato di completamento.
- [x] 124 Rimozione delle dipendenze.
- [x] 125 Rifiuto dei cicli nelle dipendenze.
- [x] 126 Protezione dal completamento con prerequisiti ancora aperti.
- [x] 127 Creazione di template da una scheda.
- [x] 128 Catalogo personale dei template di scheda.
- [x] 129 Creazione da template in una lista rispettando il limite WIP.
- [x] 130 Rimozione autorizzata dei template di scheda.
- [x] 131 Creazione di template da una bacheca.
- [x] 132 Catalogo personale dei template di bacheca.
- [x] 133 Creazione di bacheche da template con liste e schede.
- [x] 134 Rimozione autorizzata dei template di bacheca.
- [x] 135 Salvataggio personale di filtri per bacheca.
- [x] 136 Elenco dei filtri salvati dell'utente.
- [x] 137 Aggiornamento e rinomina dei filtri salvati.
- [x] 138 Rimozione dei filtri salvati.
- [x] 139 Completamento multiplo atomico con controllo delle versioni.
- [x] 140 Archiviazione multipla atomica con controllo delle versioni.

## Collaborazione e account

- [x] 141 Sottoscrizione personale agli eventi di una bacheca.
- [x] 142 Sottoscrizione personale agli eventi di una scheda.
- [x] 143 Elenco delle proprie sottoscrizioni ancora accessibili.
- [x] 144 Notifiche persistenti generate insieme alle attività.
- [x] 145 Elenco delle notifiche con paginazione a cursore.
- [x] 146 Conteggio delle notifiche non lette.
- [x] 147 Segnalazione di lettura di una singola notifica.
- [x] 148 Segnalazione di lettura di tutte le proprie notifiche.
- [x] 149 Caricamento di allegati fino a un MiB per file.
- [x] 150 Elenco dei metadati degli allegati di una scheda.
- [x] 151 Download degli allegati con verifica dell'accesso.
- [x] 152 Rimozione recuperabile degli allegati.
- [x] 153 Ripristino degli allegati rimossi.
- [x] 154 Quote per numero e dimensione complessiva degli allegati.
- [x] 155 Modifica dei commenti con autore, data e versione.
- [x] 156 Modifica del proprio nome visualizzato.
- [x] 157 Elenco delle proprie sessioni senza esporre token o hash.
- [x] 158 Revoca delle altre sessioni del proprio account.
- [x] 159 Notifiche deduplicate, senza avvisi all'autore e con revoca dell'accesso.
- [x] 160 Paginazione a cursore della cronologia della bacheca.

## Interfaccia per il lavoro quotidiano

- [x] 161 Modifica della data di inizio nell'editor.
- [x] 162 Motivo del blocco nell'editor e indicatore sulle schede.
- [x] 163 Filtro delle schede bloccate.
- [x] 164 Modifica dei minuti effettivi nell'editor.
- [x] 165 Timer manuale persistente sul dispositivo.
- [x] 166 Modifica e apertura del collegamento di riferimento.
- [x] 167 Selezione di più assegnatari reali.
- [x] 168 Pannello delle proprie attività fra le bacheche.
- [x] 169 Aggiunta dei prerequisiti dall'editor della scheda.
- [x] 170 Rimozione dei prerequisiti dall'editor.
- [x] 171 Visualizzazione dello stato dei prerequisiti.
- [x] 172 Salvataggio della scheda come template.
- [x] 173 Selezione di un template per una nuova scheda.
- [x] 174 Gestione della rimozione dei template di scheda.
- [x] 175 Salvataggio della bacheca come template.
- [x] 176 Selezione di un template per una nuova bacheca.
- [x] 177 Gestione della rimozione dei template di bacheca.
- [x] 178 Salvataggio dei filtri correnti con un nome.
- [x] 179 Applicazione di un filtro personale salvato.
- [x] 180 Rinomina e rimozione dei filtri personali.
- [x] 181 Selezione multipla delle schede con controlli accessibili.
- [x] 182 Comando per completare le schede selezionate.
- [x] 183 Comando per archiviare le schede selezionate.
- [x] 184 Centro notifiche nell'interfaccia.
- [x] 185 Indicatore delle notifiche non lette.
- [x] 186 Comando per segnare una notifica come letta.
- [x] 187 Comando per segnare tutte le notifiche come lette.
- [x] 188 Comando per seguire o smettere di seguire la bacheca.
- [x] 189 Comando per seguire o smettere di seguire la scheda.
- [x] 190 Caricamento degli allegati dall'editor con controllo della dimensione.
- [x] 191 Download degli allegati senza eseguirne il contenuto nella pagina.
- [x] 192 Rimozione e ripristino degli allegati nell'editor.
- [x] 193 Modifica dei propri commenti nell'editor.
- [x] 194 Modifica del nome personale dal pannello account.
- [x] 195 Consultazione e revoca delle altre sessioni dal pannello account.
- [x] 196 Esportazione CSV della bacheca con protezione dalle formule.
- [x] 197 Esportazione delle scadenze in formato iCalendar.
- [x] 198 Anteprima Markdown della descrizione con HTML escapato.
- [x] 199 Guida e comandi rapidi da tastiera.
- [x] 200 Scadenze rapide per oggi, domani, una settimana o nessuna data.

## Perimetro di verifica

Le notifiche sono interne all'applicazione e richiedono account. Gli allegati sono conservati nel database e trasferiti come JSON/base64; non vengono scaricati URL remoti. Il backup SQLite comprende anche queste nuove tabelle. I template sono personali, i filtri sono personali e associati alla bacheca. Le configurazioni Docker e Compose mantengono il binding su loopback e sono destinate a Linux con rete host.

SSO, SCIM, notifiche email, automazioni, importazione diretta Trello e alta disponibilità restano nella roadmap. La verifica di questa versione riguarda le capacità elencate, senza dichiarare parità enterprise completa.

## Verifiche della versione 0.3

Verifica locale del 15 ottobre 2026 su macOS. `make test` ha superato **70 test**: 42 regressioni precedenti, 8 test operativi, 11 di produttività e 9 di collaborazione. `make test-sanitize` ha superato gli stessi 70 test con AddressSanitizer e UndefinedBehaviorSanitizer. La successiva correzione alla copia con assegnatari rimossi o disattivati è stata verificata con gli 11 test di produttività, anche con sanitizer, e con una nuova esecuzione completa dei 70 test normali.

| Interventi | Codice e configurazione | Verifica |
| --- | --- | --- |
| 101–115 | `src/http.c`, `src/openboard.h`, `Makefile`, `Dockerfile`, `compose.yaml`, `deploy/` | Test di staging installazione, configurazione e precedenza CLI, integrità/checkpoint senza migrazioni, metriche e permessi, limiti HTTP, request ID e asset. Compose validato; daemon Docker fermo, build e smoke test previsti in CI. Systemd e nginx sono esempi da provare sul sistema Linux di destinazione. |
| 116–140 | `src/server.c`, `tests/test_productivity.py` | Date parziali, export/import, assegnatari e revoca, dipendenze concorrenti senza cicli, blocco del completamento, template personali, filtri degli osservatori, versioni e rollback delle azioni multiple, WIP delle sole liste coinvolte. |
| 141–160 | `src/collaboration.c/h`, `tests/test_collaboration.py` | Contenuto binario degli allegati e quote, cestino/ripristino, permessi, notifiche deduplicate e revoca, sessioni private, versioni dei commenti e rollback dopo errori SQL. |
| 161–200 | `web/app.js`, `web/productivity.js`, `web/index.html`, `web/styles.css` | Sintassi JavaScript e 158 ID HTML univoci; test Node per Markdown, CSV, iCalendar e conservazione delle bozze; prove manuali rappresentative nel browser. |

Le prove browser hanno confermato login, salvataggio dei nuovi campi e di più assegnatari, attività personali, filtro delle schede bloccate e suo salvataggio, aggiunta di un prerequisito, rifiuto del completamento con prerequisito aperto, creazione di template e scheda da template, caricamento di un allegato e layout mobile. La conferma nativa di cancellazione dell'allegato ha interrotto il controllo automatizzato della scheda di prova: ripristino, notifiche e sessioni sono coperti dai test API e dalla revisione dell'interfaccia, senza dichiarare una prova browser completa di questi flussi.

A 390 pixel pagina, ricerca, notifiche e account restano entro il viewport. Le anteprime [desktop](preview.jpg) e [mobile](preview-mobile.jpg) mostrano la versione 0.3. I controlli manuali non sono una suite E2E automatizzata né un audit completo di accessibilità; la CI remota deve ancora essere eseguita sulle modifiche locali.

Il JSON v2 conserva i nuovi campi scalari di pianificazione, ma esclude assegnazioni tramite ID, dipendenze, allegati, notifiche, template, filtri e account. Il backup SQLite è il formato completo per il recupero dell'istanza. I template escludono relazioni di identità e collaborazione per essere riutilizzabili.
