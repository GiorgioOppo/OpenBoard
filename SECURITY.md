# Sicurezza di OpenBoard

OpenBoard 0.2 mantiene il servizio HTTP su `127.0.0.1`. Per un'istanza condivisa avviare con `--auth`, configurare l'amministratore dal browser locale e solo successivamente configurare un proxy HTTPS sullo stesso host con `--public-url`.

Gli account usano password di almeno 12 byte, PBKDF2-HMAC-SHA256 con 600.000 iterazioni e salt casuali. Le sessioni hanno token casuali memorizzati come hash, cookie HttpOnly/SameSite Strict, inattività massima di 30 minuti e durata assoluta di 8 ore. Con origine pubblica HTTPS il cookie ha anche l'attributo Secure. Le scritture autenticate richiedono un token CSRF.

I ruoli sono amministratore, membro e osservatore. L'amministratore dell'istanza può accedere a tutte le bacheche; gli altri utenti accedono soltanto a quelle condivise. Un osservatore non modifica i dati della bacheca, ma può gestire i propri preferiti. Le modifiche ai permessi sono verificate dal server a ogni richiesta.

La modalità senza `--auth` serve per l'uso personale locale. Le revisioni controllate con `If-Match` proteggono le modifiche inviate dall'interfaccia; i client API devono inviare a loro volta la revisione attesa. Le bozze vengono conservate nel browser, che va considerato parte dell'ambiente dell'utente.

Per una segnalazione di sicurezza, contattare privatamente il maintainer attraverso il profilo GitHub del progetto prima di pubblicare dettagli riproducibili. Non includere password, token, database aziendali o informazioni personali nelle issue pubbliche.

I test descrivono il perimetro verificato della release; il progetto non dichiara certificazioni di sicurezza, SSO, isolamento SaaS multi-tenant o alta disponibilità.
