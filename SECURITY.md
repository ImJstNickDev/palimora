# Sicurezza

La versione supportata è **1.0.x**. Non pubblicare vulnerabilità con token,
cookie, dump, database, URL privati o contenuti di utenti nelle issue.

Usare la [segnalazione privata GitHub](https://github.com/ImJstNickDev/palimora/security/advisories/new),
indicando versione/commit, configurazione minima, impatto e riproduzione con
fixture sintetiche. Non è garantito un tempo di risposta.

Il wizard iniziale deve essere raggiungibile soltanto tramite DNS/accesso locale
fino alla creazione del primo Owner. Seguire [installazione](docs/02-architettura.md#avvio-della-produzione)
e [backup/restore](docs/08-backup-export.md); preservare la chiave `secrets/auth`.
Non esporre PostgreSQL, Redis, OpenSearch o il socket Docker su porte host.

Le prove della release sono descritte in [09](docs/09-milestone.md#blocco-6c--final-integration-optimization--release-2026-11-08).
L'integrazione remota AO3 non è ancora attestata end-to-end. Le scansioni del
repository riducono il rischio di pubblicare segreti, senza costituire una
garanzia sull'assenza di vulnerabilità del software.
