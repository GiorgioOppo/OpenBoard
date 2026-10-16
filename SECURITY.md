# Sicurezza di OpenBoard

Il backend OpenBoard 0.6 espone soltanto API, abilita gli account per impostazione predefinita e ascolta per impostazione predefinita su `127.0.0.1`. Il container imposta esplicitamente `OPENBOARD_BIND=0.0.0.0` sulla rete Docker privata; app, PostgreSQL e MongoDB non pubblicano porte sull'host. Nginx Proxy Manager espone HTTP/HTTPS su loopback per impostazione predefinita (`OPENBOARD_PUBLISH_IP=127.0.0.1`); il pannello amministrativo è sempre vincolato a `127.0.0.1:81`. L'esposizione alla rete richiede una scelta esplicita. Configurare prima l'amministratore OpenBoard e poi il Proxy Host. Per accesso remoto usare un dominio HTTPS come `OPENBOARD_PUBLIC_URL`.

Le credenziali dei database vengono generate in `.env` con permessi `0600`, escluso da Git e dal contesto di build. Le utenze dell'app sono separate dagli amministratori dei database. In modalità esterna i documenti JSON, gli allegati e i corpi dell'idempotenza sono in MongoDB; dati scalari, account e sessioni sono in PostgreSQL. Entrambi gli archivi e i backup contengono dati riservati. La cache SQLite ricostruibile usa un tmpfs nel container.

Gli account usano password di almeno 12 byte, PBKDF2-HMAC-SHA256 con 600.000 iterazioni e salt casuali. Le sessioni hanno token casuali memorizzati come hash, cookie HttpOnly/SameSite Strict, inattività massima di 30 minuti e durata assoluta di 8 ore. Con origine pubblica HTTPS il cookie ha anche l'attributo Secure. Le scritture autenticate richiedono un token CSRF.

I ruoli sono amministratore, membro e osservatore. L'amministratore dell'istanza può accedere a tutte le bacheche; gli altri utenti accedono soltanto a quelle condivise. Un osservatore non modifica i dati della bacheca, ma può gestire i propri preferiti. Le modifiche ai permessi sono verificate dal server a ogni richiesta.

La modalità esplicita `--no-auth` serve soltanto per lo sviluppo locale ed è rifiutata con bind diverso da `127.0.0.1`. Gli endpoint pubblici sono limitati a health/readiness/versione e alle operazioni necessarie per configurazione iniziale e accesso. Il frontend statico non riceve credenziali di PostgreSQL o MongoDB; il browser riceve solo dati consentiti dalle API e metadati del catalogo. Le revisioni controllate con `If-Match` proteggono le modifiche inviate dall'interfaccia; i client API devono inviare a loro volta la revisione attesa. Le bozze vengono conservate nel browser, che va considerato parte dell'ambiente dell'utente.

Gli allegati vengono validati per formato, nome e dimensione, conservati nel database e scaricati come file: la pagina non ne esegue il contenuto. I limiti sono 1 MiB per file, 10 file attivi e 5 MiB attivi per scheda. Il cestino conserva i contenuti per il ripristino, quindi queste quote non limitano lo spazio fisico totale del database. Non è inclusa una scansione antivirus: controllare i file ricevuti prima di aprirli.

Notifiche e sottoscrizioni rispettano l'accesso corrente alla bacheca. I template e i filtri salvati sono personali. Le metriche richiedono amministrazione globale con account attivi. CSV e Markdown applicano rispettivamente protezione dalle formule e escaping HTML; i link di riferimento ammettono solo HTTP/HTTPS.

Revisioni e report personali richiedono un account. Il richiedente non può votare la propria revisione; i revisori devono essere membri attivi con permessi di scrittura. La revoca, il ruolo osservatore e la disattivazione invalidano permanentemente le loro decisioni, anche dopo un reinvito. Le richieste di revisione sono un supporto al coordinamento, senza firme elettroniche o blocco automatico delle schede. I report personali salvano filtri, non copie dei dati né autorizzazioni: ogni ricerca ricalcola la visibilità corrente.

Sprint e moduli interni richiedono account. Pubblicare un modulo lo rende compilabile dai membri della bacheca, senza renderlo pubblico su Internet. Gli osservatori possono inviare e modificare le proprie richieste ancora in valutazione e aggiungere note; la valutazione e la conversione in schede richiedono permessi di scrittura. Le risposte mantengono uno schema originale, vengono validate per tipo e rispettano i permessi correnti. La conversione usa le stesse regole di creazione delle schede ed è atomica con il suo storico.

Per una segnalazione di sicurezza, contattare privatamente il maintainer attraverso il profilo GitHub del progetto prima di pubblicare dettagli riproducibili. Non includere password, token, database aziendali o informazioni personali nelle issue pubbliche.

I test descrivono il perimetro verificato della release; il progetto non dichiara certificazioni di sicurezza, SSO, isolamento SaaS multi-tenant o alta disponibilità.

## Audit prima della pubblicazione

[Audit del 16 ottobre 2026](docs/SECURITY_AUDIT_2026-10-16.md): perimetro, correzioni, regressioni e dipendenze da verificare prima dell’esposizione Internet. Il backend usa l’indirizzo TCP effettivo e ignora gli header IP inoltrati non attendibili. Dietro un unico reverse proxy la quota IP di login rimane aggregata: applicare limiti per client al perimetro prima di un servizio pubblico. Le risposte di idempotenza vengono restituite soltanto dopo la verifica dei permessi correnti; le scritture ricontrollano sessione e ruolo nella transazione.
