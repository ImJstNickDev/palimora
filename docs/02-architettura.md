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

Persistenza sotto `APP_DATA_ROOT`: `postgres/`, `redis/`, `opensearch/`, `storage/packs/`, `storage/staging/`, `storage/cache/`, `backups/`, `exports/`, `logs/`, `secrets/` secondo le necessità reali. Nessun Docker named volume; montaggi persistenti esclusivamente bind mounts con path host espliciti. Il dump è disponibile nel container ingest come **`/dumps/ao3_stories:ro`**. Il runtime lettura non vi accede.

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
- La rete `egress` del progetto Compose, non interna, serve i worker che leggono AO3/media e inviano push, pur mantenendo la rete applicativa privata. Accesso in ingresso sempre attraverso il gateway e l'API autorizzata.
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

Workspace npm con lockfile: `apps/api` (NestJS/Express), `apps/web` (React/Vite), `packages/contracts` (Zod, tipi e OpenAPI derivati dallo stesso contratto), `packages/ui` (token, controlli nativi e dialoghi Radix). I pacchetti dei domini successivi vengono aggiunti quando hanno un'implementazione reale. Node 22 per immagini e CI; Node ≥22.12 per sviluppo locale (runtime, header e codec nativo della stessa major).

`infra/compose.yaml` avvia gateway, web, API, PostgreSQL, Redis AOF e OpenSearch single-node. L'API Foundation dipende soltanto da PostgreSQL: indisponibilità di Redis/OpenSearch non impedisce login o amministrazione. Nessun worker/job viene simulato. Il mount dump appartiene esclusivamente al servizio ingest, in sola lettura; API e frontend non ricevono i dump.

Le migrazioni SQL sono ordinate, transazionali e protette da advisory lock; il registro verifica SHA-256 e rifiuta migrazioni applicate modificate o uno schema più recente dell'API. Il ruolo DB `palimora` possiede il proprio database per eseguire migrazioni, senza superuser, creazione ruoli o database. Il superuser PostgreSQL ha una credenziale distinta, montata soltanto nel servizio database.

### Avvio della produzione

Prerequisiti: Linux x86_64 o aarch64, Git, Docker Engine e Compose v2 (per
l'override di sviluppo con `!reset` serve Compose ≥2.24.4), OpenSSL e accesso ai
registri npm/Docker/GitHub durante la build. La build Docker installa Node,
compilatori e dipendenze native; non usa `.local`, database o dump dello
sviluppatore. Su questo host è stata verificata x86_64; aarch64 è previsto
dall'installer Typst ma non è stato provato nella campagna 1.0.0.

Nginx Proxy Manager e la rete Docker esterna `prod-frontend` devono già essere
configurati dall'operatore. Verificare con `docker network inspect prod-frontend`:
Palimora non installa o modifica altri reverse proxy. Le directory sorgenti e
dati possono trovarsi su percorsi diversi dall'ambiente originale.

Dalla radice del clone, con i percorsi dell'esempio `.env.example`:

```sh
cp .env.example .env
# Impostare APP_ORIGIN, NPM_TRUSTED_PROXY e i percorsi in .env.
# Se si cambiano i percorsi, adattare anche i due comandi seguenti.
sudo env APP_DATA_ROOT=/srv/palimora ./scripts/prepare-host.sh
sudo install -d -m 755 /srv/palimora-sources
docker compose --env-file .env -f infra/compose.yaml config --quiet
docker compose --env-file .env -f infra/compose.yaml up -d --build
```

`prepare-host.sh` crea solo le directory Palimora e tre segreti casuali, senza sovrascrivere quelli esistenti. Non legge `.env`: passare esplicitamente lo stesso `APP_DATA_ROOT`. La directory `AO3_DUMP_ROOT` deve esistere, ma può essere vuota; i dump non vengono scaricati o importati automaticamente. Conservare `secrets/auth`: cifra i segreti TOTP con AES-256-GCM. Le directory host dei segreti sono private; i singoli file sono montati in sola lettura nei container che ne hanno bisogno. OpenSearch richiede una directory scrivibile da UID 1000; usa NIO con `node.store.allow_mmap=false`, senza richiedere modifiche globali di `vm.max_map_count`. Le misure del corpus di prova sono nel [report della release](10-performance-report.md).

La rete `prod-frontend` deve già esistere. In NPM configurare il proxy a `http://palimora-gateway:80`, con HTTPS sul dominio di `APP_ORIGIN`. Usare inizialmente risoluzione/accesso **solo locali**, completare il wizard e solo dopo rendere pubblica la route. Il medesimo hostname HTTPS permette cookie Secure e WebAuthn anche nel bootstrap locale. NPM rimane l'unico terminatore TLS.

`NPM_TRUSTED_PROXY` identifica l'indirizzo Docker esatto di NPM (o una rete amministrata esclusivamente per proxy fidati): il gateway accetta gli IP inoltrati solo da quella sorgente. Il valore iniziale `127.0.0.1` non concede fiducia agli altri container; finché non configurato, audit e rate limit vedono l'indirizzo di NPM. Non cambiare `APP_ORIGIN` senza considerare che le passkey sono legate al dominio originale.

`GET /api/v1/health` verifica PostgreSQL; Compose attende la salute dell'API prima del gateway. Log JSON su stdout con request ID, metodo, stato e durata, senza body, query string o credenziali; rotazione Docker 3 × 10 MiB. Limiti di memoria/CPU sono dichiarati per servizio. `API_MEMORY` (default `1536m`) include il processo di composizione PDF; la prova da 316.000 parole ha raggiunto circa 1,1 GiB di RSS aggregato. Arresto con SIGTERM e periodo di grazia di 30 secondi. API e worker applicativi non accedono al socket Docker; il monitoraggio 6B.1 usa il proxy ristretto descritto sotto.

Aggiornamenti: ricostruire con `docker compose ... up -d --build`, poi eseguire `docker compose ... restart gateway` per rigenerare e caricare l'eventuale template Nginx modificato. Il gateway risolve API/web via DNS Docker con cache di cinque secondi, anche dopo sostituzione dei container. L'API applica le migrazioni prima di ascoltare. Non modificare una migrazione già distribuita: aggiungerne una nuova. Per lo sviluppo usare un database separato e `DATABASE_URL`, `AUTH_KEY` (64 cifre hex), `APP_ORIGIN=http://localhost:5173`, `PORT=3000`; `npm ci`, `npm run build`, `npm run dev -w @palimora/api` e `npm run dev`. Solo lo sviluppo localhost ammette cookie senza Secure.

### Ambiente di review UI con live reload

`infra/compose.dev.yaml`, applicato dopo il Compose principale, isola la review nel progetto `palimora-dev`, rete privata `palimora-dev-app` e gateway `palimora-dev-gateway:80`. Avvia PostgreSQL, API, Vite, gateway, Redis, worker ingest e OpenSearch, necessario per il catalogo AO3. I dati di review sono separati dalla produzione, sotto `/mnt/sdb/palimora-dev-data`.

Per le prove di carico, l’override dev rimuove i limiti Docker di CPU e memoria
da tutti i servizi e imposta Redis `maxmemory=0`. I container possono utilizzare
le risorse disponibili sull’host; non sono imposti limiti di banda/IOPS del disco.
Restano attivi controlli di integrità e riserva
disco. Il Compose principale conserva i limiti di produzione; i valori
`INGEST_CPUS`/`INGEST_MEMORY` sono superati dall’override dev.

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
./scripts/dev.sh
```

In NPM: dominio `dev.palimora.imjstnick.com`, schema upstream **HTTP**, host **palimora-dev-gateway**, porta **80**, **Websockets Support** attivo e certificato HTTPS sul dominio. Per il primo Owner vale la procedura di bootstrap sopra. Nessuna porta host pubblicata; solo il gateway partecipa alla rete frontend esterna.

I sorgenti React, CSS, componenti UI e contratti frontend sono bind mount in sola lettura: le modifiche dell'host attivano Vite HMR senza rebuild. Host consentito esplicito e WebSocket sullo stesso dominio HTTPS; il template gateway di sviluppo permette gli script inline richiesti da React Refresh, lasciando invariata la CSP di produzione. Configurazione basata sulle [opzioni server Vite](https://vite.dev/config/server-options). API e worker usano immagini compilate: dopo modifiche backend, contratti condivisi, migrazioni o dipendenze eseguire `./scripts/dev.sh`. Lo script aggiorna insieme API, worker e dipendenze Vite, attende i servizi e riavvia il gateway; conserva dati e sessioni. Il solo HMR del frontend non aggiorna l’API: lasciare il backend precedente produce endpoint mancanti o contratti incompatibili. Le risposte di autenticazione vengono validate prima di inizializzare lo stato locale: una risposta senza i riferimenti di sessione richiesti segnala versioni incompatibili, senza confondere l’errore con credenziali o 2FA errati. Redis e ingest sono parte della review dalla Milestone 2; il worker aggiorna l’inventario ma importa soltanto i batch richiesti dall’admin. Per arrestare usare `down`: i dati persistenti restano sul disco.

Il Compose di review imposta `PALIMORA_DEV=1` soltanto su API e ingest.
In Storage l’Owner può usare **Reset archivio dev**, confermando con `RESET`:
cancella catalogo, versioni, importazioni, code Archive/Ingest e file pack/staging,
senza backup. Account, credenziali, sessioni, preferenze, inviti, audit, inventario
dei sorgenti e dump rimangono conservati. Non impostare questo flag in produzione:
senza flag l’endpoint rifiuta il reset e il pulsante non compare. Non richiede
Docker socket, accesso scrivibile dell’API ai pack o cancellazione del database.
Il reset è rifiutato se il corpus è referenziato da dati personali; il controllo
è ripetuto dal worker sotto lock, senza cancellazioni in cascata dei dati utente.

### Worker Archive Engine

Il servizio `ingest` usa l'immagine API con entrypoint dedicato e Python 3 per gli
adapter. Riceve `/storage` scrivibile e `/dumps/ao3_stories:ro`; API riceve soltanto
`/storage:ro`. `prepare-host.sh` prepara storage/packs/staging con UID 1000.
`ARCHIVE_RESERVE_BYTES` configura la riserva libera, predefinita a 256 MiB;
controlli prima dello staging e della scrittura pack sospendono senza pubblicare
contenuti incompleti. Il codec N-API del progetto usa libzstd di Debian; il build installa g++ e
libzstd-dev, il runtime richiede soltanto libzstd.

BullMQ esegue `palimora-ingest-v1` e `palimora-archive-events-v1`. Batch, generazione,
checkpoint, retry e outbox restano in PostgreSQL. Il dispatcher ricrea job mancanti
con ID deterministici; il consumatore eventi conferma gli ID nella tabella
`archive_dispatch`. Redis AOF usa il bind mount già previsto. Un advisory lock
PostgreSQL protegge l'esecuzione anche dopo perdita delle code Redis. SIGTERM e
pausa interrompono il produttore Python e i processi del pool, conservando l’ultimo gruppo committato;
il trasporto con ack limita a due i gruppi preparati in anticipo. Il formato e gli
stati canonici restano invariati. `INGEST_GROUP_RECORDS` configura 1–1024 record
per gruppo (default 256); `INGEST_CPUS` e `INGEST_MEMORY` configurano il solo
container ingest (default 2 CPU e 1 GiB). Aumentare i limiti senza un profilo non
rimuove le attese seriali di database/storage.

Oggetti, capitoli, relazioni ed eventi sono inseriti in blocco dove indipendenti;
un writer per transazione condivide i pack tra opere. Gli ack degli eventi
ordinari non prendono il lock dello storage; le decisioni amministrative che
scrivono pack lo mantengono. Il dispatcher seleziona fino a 4.096 eventi
per ciclo e accoda gruppi di massimo 512 ID espliciti con `addBulk`; il
consumatore li conferma in una sola transazione. Non usa intervalli MAX(id),
che perderebbero eventi committati fuori ordine. Job individuali preesistenti
restano leggibili; ID deterministici e retry durevole sono preservati.

Il dev usa 6 processi parser (`DEV_INGEST_PARSER_WORKERS`), 4 gruppi concorrenti
(`DEV_INGEST_COMMIT_CONCURRENCY`), 8 thread I/O/codec (`DEV_INGEST_IO_THREADS`)
e Zstd livello 1
(`DEV_ARCHIVE_ZSTD_LEVEL`). PostgreSQL ha shared_buffers 4 GiB,
effective_cache_size 24 GiB, work_mem 16 MiB, maintenance_work_mem 512 MiB,
max_wal_size 8 GiB, checkpoint_timeout 15 minuti, WAL e TOAST LZ4 e track_io_timing.
Sono parametri del solo dev su questo host; fsync e synchronous_commit restano
attivi. Il catalogo mantiene un coordinatore unico delle scritture, con parsing
e codec paralleli, senza moltiplicare writer in contesa sullo stesso lock.

I job di compattazione/recupero spazio sono durevoli in PostgreSQL ed eseguiti dal
medesimo worker. Copia e sostituzione locator sono transazionali; letture protette
da lock condiviso e lease persistenti impediscono la rimozione dei pack in uso.

### Motore di consultazione

L'API proietta in batch le code catalogo/full-text PostgreSQL; non richiede un
nuovo servizio. OpenSearch è una dipendenza healthy dell'API, con heap 1 GiB e
limite container 3 GiB nel Compose principale. Conserva esclusivamente indici
ricostruibili nel bind mount dedicato. Chromium e font DejaVu/Noto (anche CJK) nell'immagine API
servono alla stampa PDF senza rete. Config/cache Chromium usano directory temporanee
isolate sotto `/tmp`, compatibili con root filesystem read-only e rimosse dopo
la stampa; il contenuto importato resta in sola lettura.
Le misure sul corpus di verifica e i limiti della prova sono in 09.

Il container API include [Typst 0.15.1](https://github.com/typst/typst/releases/tag/v0.15.1)
(Apache-2.0, LICENSE e NOTICE distribuiti) e Chromium. Il binario nativo è
verificato con SHA-256 per amd64/arm64 da `scripts/install-typesetter.sh`;
nessun servizio aggiuntivo. Fuori Docker installarlo in una directory locale e
impostare `TYPST_PATH`; `scripts/verify.sh` prepara automaticamente questa dipendenza.

### Integrazione deployment AO3

Il worker `ingest` aderisce alle reti `app` ed `egress`; solo il gateway resta su
`prod-frontend`. I gateway dev e produzione ammettono body da 1 MiB soltanto sotto
`/api/v1/admin/ao3/uploads/`, per i segmenti media da 512 KiB codificati base64.
Gli altri endpoint mantengono il limite di 32 KiB.

### Web Push e consegne personali

Il consumatore delle notifiche gira con le proiezioni API; la consegna Web Push
gira nel worker ingest/sync esistente, unico dei due con rete `egress`.
`push_deliveries` conserva generazione, tentativi e prossima esecuzione in
PostgreSQL; advisory lock coordinano repliche e revoche. Backoff e `Retry-After`,
rimozione degli endpoint 404/410, errore visibile dopo 100 tentativi e riattivazione
dal dispositivo. Delivery almeno una volta; il tag browser sostituisce l'avviso
precedente. Shutdown attende il tentativo attivo, senza cancellare lavori pendenti.

Chiavi VAPID generate una volta e salvate nel DB; chiave privata e subscription
cifrate con `AUTH_KEY`. Il worker riceve `APP_ORIGIN`; `VAPID_SUBJECT` facoltativo
accetta un URL HTTPS o un'identità `mailto:`, con default all'origin. Nessun invio
email. Nessuna credenziale di provider proprietario richiesta. Endpoint HTTPS
verificati prima dell'invio, DNS pubblico vincolato alla connessione, nessun redirect
seguito. Messaggi generici localizzati evitano di esporre titoli, utenti o note
sullo schermo bloccato. Il blocco 5C estende lo stesso `/push-worker.js` con
la sola shell pubblica; dati e copie private rimangono fuori da Cache Storage.

### PWA e client offline (5C)

La build Vite genera il precache esatto degli asset pubblici e dell'HTML senza
stato utente. Lo stesso `/push-worker.js` mantiene Web Push e gestisce la shell;
non intercetta né memorizza `/api/`. Aggiornamenti installati in attesa, attivati
su comando dopo il completamento delle scritture locali; le schede controllate
si ricaricano. Manifest, icone 192/512 e avvio su `/offline`; HTTPS richiesto fuori
localhost. Il server Vite di sviluppo non precachea moduli HMR: verificare offline
con build e `vite preview` o gateway di produzione.

`offline-store.ts` è l'adapter IndexedDB; `offline.ts` coordina copie e operazioni
usando i contratti API esistenti e la stessa funzione di riallineamento del server.
Il lettore React rimane unico. Futuri contenitori Capacitor potranno sostituire
l'adapter di persistenza/trasporto e installazione, senza un secondo modello di
bookmark, progresso o annotazione; nessun client nativo distribuito in questa fase.

Fonti piattaforma: [ciclo di vita service worker](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API/Using_Service_Workers),
[installabilità](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable).

### Collector operativo — 6B.1

Compose include `metrics-proxy` e `collector`, senza porte host. Solo il proxy
possiede il socket Docker e aderisce alla rete interna `metrics`; il collector
aderisce a `metrics` e `app`, senza socket, segreti o credenziali PostgreSQL.
API e worker non aderiscono a `metrics`. Entrambi i processi hanno filesystem
read-only, capability rimosse e limiti CPU/RAM; il collector esegue come `node`.
Il piccolo proxy esegue come UID 0 per aprire il socket dell'host: è il confine
privilegiato, non un proxy Docker generico.

Il suo unico endpoint è `GET /snapshot`. Costruisce internamente richieste GET
alla lista filtrata per `com.docker.compose.project` e alle statistiche degli ID
risultanti, con ulteriore allowlist dei servizi definiti in Compose. `PALIMORA_PROJECT`
segue `COMPOSE_PROJECT_NAME`; ID, path, query Docker e comandi non sono accettati
dai chiamanti. Le risposte escludono ambiente, comandi, mount, log e reti host.
Il mount `:ro` non è la restrizione dei metodi: questa è applicata dal proxy e
la separazione di rete impedisce al backend di interrogarlo direttamente.

Il collector calcola delta e rate ogni 10 s, mantenendo in memoria soltanto il
campione precedente per container. Docker CPU segue la formula documentata
(delta container / delta sistema × CPU online); 100% equivale a un core e può
essere superato. La RAM sottrae la cache inattiva cgroup v1/v2, come
[`docker stats`](https://docs.docker.com/reference/api/engine/version/v1.44/).
Per i rate, primo campione, restart/reset dei contatori e statistiche assenti
producono valori non disponibili, non zeri. ID cambiati non vengono confrontati con gli
ID precedenti. La UI distingue campioni correnti da collector indisponibile.

Il backend campiona solo `collector:9100/snapshot` e le proprie code/servizi;
lo storico è PostgreSQL, indipendente dalla durata dei processi di monitoraggio.
`OPERATIONS_COLLECTOR_URL` permette di collegare il collector dell'ambiente isolato;
non è configurabile da un browser. Nessuna interrogazione di container estranei
al progetto e nessun comando Docker operativo nell'API.

### Worker di integrità — 6B.2

Lo scrub e il recupero usano `archive_jobs` e il leader della manutenzione già
eseguito dal worker ingest. Nessun nuovo servizio o accesso Docker. Migrazione
036 prima dell'avvio dei processi aggiornati; nessuna pianificazione viene
attivata dalla migrazione. Il runtime Docker include `zstd`, usato dal verificatore
streaming per record grandi; per esecuzioni locali va installato sul PATH.
La modalità manutenzione modifica soltanto scheduling e quantità di lavoro per
passo, entro i limiti dei container. Protocollo di integrità e recupero in [03](03-dati-storage.md#scrub-e-recupero-verificato--6b2), accessi e impersonazione in
[07](07-identita-admin.md#manutenzione-integrità-e-impersonazione--6b2).

### Configurazione e verifica della release 1.0.0

`API_CPUS`, `API_MEMORY`, `POSTGRES_CPUS`, `POSTGRES_MEMORY`, `SEARCH_CPUS`,
`SEARCH_MEMORY` e `SEARCH_HEAP` rendono esplicito il budget dei servizi; i default
Compose restano conservativi. Il benchmark 6C usa container separati senza quote
CPU/RAM e non modifica i limiti della produzione. Misure, profili ingest e limiti
delle estrapolazioni in [10-performance-report](10-performance-report.md).

Verifica integrata: `./scripts/verify-release.sh`, dopo aver installato dipendenze
native e Chromium. `TMPDIR` e `PALIMORA_TEST_ROOT` possono indirizzare i temporanei
su un disco con spazio sufficiente; OpenSearch deve poter rispettare le proprie
soglie di capacità. Ogni flusso browser di bootstrap usa database e storage nuovi.
La pipeline costruisce i target Docker `api`, `web`, `monitoring` dal lockfile;
nessuna migrazione viene applicata alla produzione durante le prove.
