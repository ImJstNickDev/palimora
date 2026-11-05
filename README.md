# Palimora — documentazione autorevole

**Stato:** Milestone 1 — Foundation implementata; milestone successive specificate · **Data:** 2026-11-05 · **Prodotto:** archivio personale self-hosted di opere Archive of Our Own (AO3), con account locali e preservazione storica.

Palimora replica l'esperienza funzionale di AO3 in una nuova applicazione, moderna e privata. Importa i dump disponibili, normalizza e conserva contenuti, media e versioni in un formato proprio, e in seguito si sincronizza responsabilmente con AO3. Non è un fork Rails, non è un servizio ufficiale AO3 e non pubblica opere per conto degli utenti.

## Lettura dei documenti

| File | Contenuto e autorità |
|---|---|
| [`AGENTS.md`](AGENTS.md) | Istruzioni vincolanti a Codex e agli sviluppatori |
| [`docs/01-prodotto.md`](docs/01-prodotto.md) | Scope, regole di prodotto, funzionalità e non-obiettivi |
| [`docs/02-architettura.md`](docs/02-architettura.md) | Stack, moduli, comunicazioni, Docker e confini |
| [`docs/03-dati-storage.md`](docs/03-dati-storage.md) | Modello dati, versioning e formato canonico |
| [`docs/04-ingest.md`](docs/04-ingest.md) | Importazione di sorgenti incomplete, errori, checkpoint |
| [`docs/05-sincronizzazione.md`](docs/05-sincronizzazione.md) | Discovery AO3, watchlist, policy scheduler e riconciliazione |
| [`docs/06-frontend-ux.md`](docs/06-frontend-ux.md) | Interfaccia, lettura, biblioteca, ricerca, offline e mobile |
| [`docs/07-identita-admin.md`](docs/07-identita-admin.md) | Account, inviti, amministrazione, audit, manutenzione |
| [`docs/08-backup-export.md`](docs/08-backup-export.md) | Backup, export da 2 GiB, destinazioni esterne, restore |
| [`docs/09-milestone.md`](docs/09-milestone.md) | Sequenza di consegna, qualità mirata, lavoro con Codex |
| [`docs/10-contratti.md`](docs/10-contratti.md) | Contratti tra moduli, stati e invarianti cross-cutting |

**Precedenza in caso di discrepanze:** le decisioni esplicite di prodotto in `01-prodotto.md` prevalgono; `03–08` specializzano ciascun dominio; `02` definisce la topologia; `10` impone gli invarianti tecnici; `09` organizza il lavoro. Non duplicare logiche per lo stesso concetto.

## Decisioni già prese

- **Applicazione nuova:** frontend React + TypeScript + Vite; backend NestJS modulare; PostgreSQL; OpenSearch per full-text; Redis/BullMQ; packfile compressi; Docker Compose, un'unica produzione.
- **Dati dell'app:** `/mnt/sdb/palimora-data` su bind mount. **Primo dump:** `/mnt/teratron_data/AO3_dumper/ao3_dump/data/ao3_stories` montato **read-only**. I dump non sono necessari al funzionamento dopo l'ingest; restano esterni per rielaborazioni.
- **Rete:** unico gateway Nginx di Palimora su external Docker `prod-frontend`; TLS terminato da Nginx Proxy Manager già presente; `ports:` vietato su tutti i container Palimora; database, cache e API non accessibili dalla rete condivisa.
- **Bootstrap:** primo avvio tramite DNS locale, prima della pubblicazione Internet; primo utente creato dal wizard diventa Owner in transazione atomica. Nessun token iniziale, filtro IP o ulteriore barriera NPM richiesta. Dopo bootstrap il wizard non è più disponibile.
- **Qualità:** UI completa e curata al primo passaggio, niente placeholder/WIP e niente batterie di test ridondanti. Verifiche mirate sui percorsi in cui si possono perdere dati o privilegi.
- **Prima release:** tutto il perimetro concordato; sincronizzazione degli **account personali AO3** e supporto a piattaforme diverse da AO3 sono esplicitamente futuri, non schermate fittizie nella v1.

## Cosa resta dipendente dall'analisi del corpus

L'architettura e gli invarianti sono stabiliti. Il layout binario byte-per-byte del formato v1, le definizioni finali degli adapter ZIP/SQLite, la classificazione dei file e i livelli ottimali di compressione saranno finalizzati **prima di importare il primo corpus**, usando campioni e benchmark reali. Questo non autorizza a cambiare i requisiti o a improvvisare un formato durante l'ingest.

## Fonti tecniche primarie

- [Codice ufficiale OTW Archive](https://github.com/otwcode/otwarchive) — riferimento per comportamenti, tassonomia e semantica delle feature AO3; licenza GPL-2.0-or-later per l'eventuale riuso di codice.
- [NestJS HTTP adapters](https://docs.nestjs.com/techniques/performance), [BullMQ Job Schedulers](https://docs.bullmq.io/guide/job-schedulers/), [Docker Compose networking](https://docs.docker.com/compose/how-tos/networking/), [Docker Compose services/bind mounts](https://docs.docker.com/reference/compose-file/services/).

**Non mettere nel repository pubblico dump, opere, account reali, segreti, file di backup o dati di sessione.**

## Foundation: utilizzo e verifica

Account, sicurezza (password/passkey/TOTP/recovery), dispositivi, amministrazione utenti e inviti sono implementati end-to-end. Le funzionalità di archivio iniziano dalla milestone 2; non sono esposte voci di navigazione prive di implementazione.

- **Deployment e aggiornamenti:** [procedura autorevole in 02](docs/02-architettura.md#avvio-della-produzione).
- **Regole di sicurezza e recupero:** [contratto operativo in 07](docs/07-identita-admin.md#contratto-operativo-foundation).
- **Build:** `npm ci && npm run build`.
- **Verifica completa:** `npx playwright install --with-deps chromium` e `./scripts/verify.sh` su Linux con Docker. Crea un PostgreSQL di test temporaneo, esegue contratti/integrazione/browser/audit e rimuove il container.
- **API:** OpenAPI generato su `/api/v1/openapi.json`; tipi condivisi in `packages/contracts`.

Risultati e limiti delle misure sono in [09](docs/09-milestone.md#verifica-foundation--2026-11-05). La pipeline GitHub Actions esegue gli stessi controlli e costruisce entrambe le immagini.
