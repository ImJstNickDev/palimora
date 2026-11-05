# 02 — Architettura, stack e deployment

## Decisione

**Nuova implementazione, monorepo, modular monolith + worker dedicati.** Non eseguire il codice Ruby on Rails di AO3. L'upstream OTW serve per verificare modelli funzionali e semantica; la logica canonica e il catalogo sono nostri.

| Blocco | Tecnologie e confini |
|---|---|
| Web | React  + TypeScript + Vite; router client; PWA, futuro Capacitor; API tipizzate |
| Componenti | shadcn/ui e primitive accessibili, stile Palimora personalizzato |
| API | NestJS con HTTP adapter scelto dalla compatibilità delle dipendenze; REST `/api/v1`, OpenAPI; SSE per job/notifiche, WebSocket solo se serve |
| DB | PostgreSQL, unica autorità per entità, identità, checkpoint, versioni e job applicativi |
| Ricerca | PostgreSQL per catalogo/filtri/ordinamenti; OpenSearch per full-text dei capitoli, ricostruibile dal DB e dallo store |
| Code | Redis/BullMQ per esecuzione e scheduling; stato durevole e outbox in PostgreSQL; worker idempotenti |
| Dump adapters | Worker dedicati per ZIP/SQLite/EPUB/HTML; Python ammesso per streaming affidabile di ZIP64/SQLite, senza replicare la logica di dominio TS |
| Storage | Content-addressed packfiles compressi e immutabili + indice nel DB; oggetti indipendenti, versione logica stabile |
| Edge | Nginx interno, routing `/` al frontend e `/api` / eventi all'API; TLS solo sul Nginx Proxy Manager preesistente |
| Metrics | Servizio isolato con accesso limitato ai soli container Palimora; API e frontend senza Docker socket |

Le integrazioni tra linguaggi usano **contratti versionati** (vedi `10-contratti.md`). Gli adapter leggono e mappano le sorgenti, mentre dedup, merge, invarianti e commit appartengono al core. Non aggiungere microservizi per ogni feature. Nest può usare NodeAdapter/FastifyAdapter in base a integrazioni reali e profilazione, non sulla sola promessa di throughput sintetico.

## Moduli logici dell'API

`Identity`, `Invitations`, `Reader`, `Catalog`, `TagGraph`, `Works`, `Chapters`, `Versions`, `Collections`, `Bookmarks`, `ReadingProgress`, `Annotations`, `Notifications`, `Ingest`, `Sync`, `Media`, `Search`, `ArchiveStore`, `Backups`, `Admin/Audit`, `Observability`.

Un solo proprietario dei dati per modulo: interazioni fra moduli tramite servizi e contratti tipizzati, non accessi incrociati arbitrari alle tabelle. Operazioni che incrociano DB e packfile sono orchestrate con staging, outbox e recupero.

## Monorepo previsto

```text
palimora/
├── apps/
│   ├── web/                # React/Vite + PWA
│   ├── api/                # NestJS
│   ├── workers/            # BullMQ sync/media/index/export
│   └── ingest-adapters/    # adapter stream ZIP/SQLite (Python se utile)
├── packages/
│   ├── contracts/          # OpenAPI/JSON Schema, eventi, codici errore
│   ├── archive-format/     # codec, pack reader/writer, invarianti
│   ├── archive-cli/        # reader/export standalone, no Postgres richiesto
│   └── ui/                 # componenti e token grafici condivisi
├── infra/
│   ├── compose.yaml
│   ├── compose.backups.yaml # opzionale, mount aggiuntivi
│   └── nginx/
├── docs/                  # questa documentazione
├── AGENTS.md
└── README.md
```

Monorepo non implica che ogni pacchetto debba diventare un servizio o un container distinto.

## Percorsi host vincolanti

```text
APP_DATA_ROOT=/mnt/sdb/palimora-data
AO3_DUMP_ROOT=/mnt/teratron_data/AO3_dumper/ao3_dump/data/ao3_stories
```

Persistenza sotto `APP_DATA_ROOT`: `postgres/`, `redis/`, `opensearch/`, `storage/packs/`, `storage/staging/`, `backups/`, `exports/`, `logs/`, `secrets/` secondo le necessità reali. Nessun Docker named volume; montaggi persistenti esclusivamente bind mounts con path host espliciti. Il dump è disponibile nel container ingest come **`/dumps/ao3_stories:ro`**. Il runtime lettura non vi accede.

Backups aggiuntivi: mount esterni configurabili (es. `/mnt/backupdisk/palimora` → `/backup-targets/disk1`, `/mnt/nas/palimora` → `/backup-targets/nas`) nel `compose.backups.yaml` opzionale. Il Backup Manager mostra solo le destinazioni montate e verificate. **Non** trattare una directory vuota lasciata da un disco smontato come destinazione valida: validare device/mount identity prima di scrivere; mount `create_host_path: false` non basta da solo.

## Reti Docker

```text
Internet — HTTPS → Nginx Proxy Manager (già esistente)
                          │ external prod-frontend
                     palimora-gateway (Nginx)
                          │ internal palimora-app
              ┌───────────┼───────────┐
            web          api        worker(s)
                          │             │
                    PostgreSQL       Redis / OpenSearch
                          │
                       PackStore

sync/media worker — palimora-egress (bridge non internal) → AO3/media esterni
```

- **Solo `palimora-gateway`** entra in `prod-frontend`. NPM raggiunge `palimora-gateway:80` per nome DNS Docker. Nessun servizio Palimora usa `ports:`; `expose` è metadato interno, non pubblicazione host.
- `palimora-app` con `internal: true` per API, DB, cache, motore ricerca, frontend/gateway. PostgreSQL/Redis/OpenSearch non aderiscono a `prod-frontend` e non hanno egress non necessario.
- `palimora-egress` non interna per i worker che leggono AO3/media e inviano push, pur mantenendo la rete applicativa privata. Accesso in ingresso sempre attraverso il gateway e l'API autorizzata.
- Limiti di CPU, memoria, I/O e numero worker all'interno delle risorse assegnate ai container Palimora. Nessuna metrica o riallocazione globale dell'host o di container esterni.

## Bootstrap e produzione

1. Primo deployment **solo DNS locale**, non esposto al pubblico da NPM.
2. Wizard HTTP applicativo: configurazione e prima creazione `Owner` in transazione atomica con vincolo univoco; stato `uninitialized → initializing → active` resistente a crash; nessun token iniziale o filtro IP aggiuntivo.
3. Setup disabilitato dopo ownership, mai riaperto per errore dopo restart.
4. Solo successivamente l'operatore abilita la route HTTPS pubblica in NPM. Richieste interne fra container restano HTTP.
5. Una sola produzione; aggiornamenti software via Git/Docker Compose con migrazioni e controllo compatibilità, non updater web. Usa fixture/campionatura separata per verificare le migrazioni rischiose, senza duplicare il corpus da terabyte.

## Affidabilità operativa

- API/catalogo restano disponibili quando OpenSearch o sync sono in errore; full-text può degradare temporaneamente, lettura e login no. Redis/worker offline non distruggono job grazie allo stato in Postgres/outbox.
- Snapshot/commit dello storage e del DB sempre consistenti; compattazioni mai su pack referenziati da snapshot/export attivi.
- Nginx interno agisce solo da gateway/routing, non gestisce certificati e non rimpiazza NPM.
- Il collector delle metriche (eventualmente via Docker API proxy read-only con endpoint autorizzati) isola l'accesso privilegiato; un semplice mount del socket Docker `:ro` **non** fornisce sicurezza read-only.

## Foundation implementata

Workspace npm con lockfile: `apps/api` (NestJS/Express), `apps/web` (React/Vite), `packages/contracts` (Zod, tipi e OpenAPI derivati dallo stesso contratto), `packages/ui` (token, controlli nativi e dialoghi Radix). I pacchetti dei domini successivi vengono aggiunti quando hanno un'implementazione reale. Node 22 per immagini e CI; Node ≥20.19 per sviluppo locale.

`infra/compose.yaml` avvia gateway, web, API, PostgreSQL, Redis AOF e OpenSearch single-node. L'API Foundation dipende soltanto da PostgreSQL: indisponibilità di Redis/OpenSearch non impedisce login o amministrazione. Nessun worker/job viene simulato. Il mount dump entrerà esclusivamente nel servizio ingest della milestone 2, in sola lettura; nessun servizio Foundation riceve i dump.

Le migrazioni SQL sono ordinate, transazionali e protette da advisory lock; il registro verifica SHA-256 e rifiuta migrazioni applicate modificate o uno schema più recente dell'API. Il ruolo DB `palimora` possiede il proprio database per eseguire migrazioni, senza superuser, creazione ruoli o database. Il superuser PostgreSQL ha una credenziale distinta, montata soltanto nel servizio database.

### Avvio della produzione

Dalla radice del repository:

```sh
cp .env.example .env
# Impostare APP_ORIGIN e NPM_TRUSTED_PROXY in .env.
sudo ./scripts/prepare-host.sh
docker compose --env-file .env -f infra/compose.yaml config --quiet
docker compose --env-file .env -f infra/compose.yaml up -d --build
```

`prepare-host.sh` crea solo le directory Palimora e tre segreti casuali, senza sovrascrivere quelli esistenti. Se si cambia `APP_DATA_ROOT`, passare lo stesso valore allo script. Conservare `secrets/auth`: cifra i segreti TOTP con AES-256-GCM. Le directory host dei segreti sono private; i singoli file sono montati in sola lettura nei container che ne hanno bisogno. OpenSearch richiede una directory scrivibile da UID 1000; usa NIO con `node.store.allow_mmap=false`, senza richiedere modifiche globali di `vm.max_map_count`. La scelta verrà profilata sul corpus quando entra in funzione il full-text.

La rete `prod-frontend` deve già esistere. In NPM configurare il proxy a `http://palimora-gateway:80`, con HTTPS sul dominio di `APP_ORIGIN`. Usare inizialmente risoluzione/accesso **solo locali**, completare il wizard e solo dopo rendere pubblica la route. Il medesimo hostname HTTPS permette cookie Secure e WebAuthn anche nel bootstrap locale. NPM rimane l'unico terminatore TLS.

`NPM_TRUSTED_PROXY` identifica l'indirizzo Docker esatto di NPM (o una rete amministrata esclusivamente per proxy fidati): il gateway accetta gli IP inoltrati solo da quella sorgente. Il valore iniziale `127.0.0.1` non concede fiducia agli altri container; finché non configurato, audit e rate limit vedono l'indirizzo di NPM. Non cambiare `APP_ORIGIN` senza considerare che le passkey sono legate al dominio originale.

`GET /api/v1/health` verifica PostgreSQL; Compose attende la salute dell'API prima del gateway. Log JSON su stdout con request ID, metodo, stato e durata, senza body, query string o credenziali; rotazione Docker 3 × 10 MiB. Limiti di memoria/CPU sono dichiarati per servizio. Arresto con SIGTERM e periodo di grazia di 30 secondi. Nessun accesso al socket Docker.

Aggiornamenti: ricostruire con `docker compose ... up -d --build`, poi eseguire `docker compose ... restart gateway` per rigenerare e caricare l'eventuale template Nginx modificato. Il gateway risolve API/web via DNS Docker con cache di cinque secondi, anche dopo sostituzione dei container. L'API applica le migrazioni prima di ascoltare. Non modificare una migrazione già distribuita: aggiungerne una nuova. Per lo sviluppo usare un database separato e `DATABASE_URL`, `AUTH_KEY` (64 cifre hex), `APP_ORIGIN=http://localhost:5173`, `PORT=3000`; `npm ci`, `npm run build`, `npm run dev -w @palimora/api` e `npm run dev`. Solo lo sviluppo localhost ammette cookie senza Secure.

### Ambiente di review UI con live reload

`infra/compose.dev.yaml`, applicato dopo il Compose principale, isola la review nel progetto `palimora-dev`, rete privata `palimora-dev-app` e gateway `palimora-dev-gateway:80`. Avvia soltanto PostgreSQL, API, Vite e gateway; Redis/OpenSearch sono opzionali con `--profile full`. I dati di review sono separati dalla produzione, sotto `/mnt/sdb/palimora-dev-data`.

Configurazione locale in `.local/dev.env` (ignorata da Git):

```dotenv
APP_DATA_ROOT=/mnt/sdb/palimora-dev-data
APP_ORIGIN=https://dev.palimora.imjstnick.com
DEV_HOST=dev.palimora.imjstnick.com
NPM_TRUSTED_PROXY=172.18.0.17
```

Verificare l'indirizzo corrente di NPM sulla rete `prod-frontend` prima di riutilizzare questa configurazione. Preparazione e avvio dalla radice:

```sh
APP_DATA_ROOT=/mnt/sdb/palimora-dev-data ./scripts/prepare-host.sh
docker compose --env-file .local/dev.env -f infra/compose.yaml -f infra/compose.dev.yaml up -d --build
```

In NPM: dominio `dev.palimora.imjstnick.com`, schema upstream **HTTP**, host **palimora-dev-gateway**, porta **80**, **Websockets Support** attivo e certificato HTTPS sul dominio. Per il primo Owner vale la procedura di bootstrap sopra. Nessuna porta host pubblicata; solo il gateway partecipa alla rete frontend esterna.

I sorgenti React, CSS, componenti UI e contratti frontend sono bind mount in sola lettura: le modifiche dell'host attivano Vite HMR senza rebuild. Host consentito esplicito e WebSocket sullo stesso dominio HTTPS; il template gateway di sviluppo permette gli script inline richiesti da React Refresh, lasciando invariata la CSP di produzione. Configurazione basata sulle [opzioni server Vite](https://vite.dev/config/server-options). L'API usa l'immagine compilata: per modifiche backend o dipendenze ripetere `up -d --build`; dopo modifiche ai template Nginx eseguire `restart gateway` con gli stessi argomenti Compose. Per arrestare usare `down`: i dati persistenti restano sul disco.
