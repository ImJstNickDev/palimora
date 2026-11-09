# 11 — Performance overhaul, riferimento P0–P5

## Priorità vincolanti aggiornate — P3–P5

Palimora serve 2–3 utenti contemporanei. La priorità è importare e rendere
ricercabile l'intero dump di oltre 900 GiB nel minor tempo possibile, conservando
integralmente informazioni, durabilità e deduplicazione senza aumentare
inutilmente lo spazio persistente. Il throughput end-to-end termina soltanto con
canonico, versioni, catalogo, full-text, leggibilità e checkpoint durevoli.
Opere parsate e commit canonici sono metriche di stadio, non completamento.

- **P3 — Parallel Ingestion & Pipeline Throughput:** concorrenza fra sorgenti e
  stadi; alimentazione continua di catalogo e full-text.
- **P4 — Archive/Ingest Engine Optimization:** profiling di parsing, CRC/hash,
  decompressione, compressione, PackStore, SQL e I/O, preservando lo storage.
- **P5 — Scale, Integrity & Final Validation:** throughput sostenibile, crescita
  dello storage, crash recovery e completezza; configurazione del primo ingest.

P0–P2 costituiscono la base implementata. Le conclusioni storiche sottostanti non
riaprono P1B.2/P2E né subordinano P3 al P95 interattivo. Verificare usabilità per
2–3 utenti e regressioni gravi; `SEARCH_PARALLEL_FACETS` resta disabilitato.
Il target sperimentale resta 2.000 opere/s completamente elaborate, senza
sacrificare dati o spazio. Nessun deployment definitivo o ingest reale del dump
completo prima della conclusione di P3, P4 e P5.

**P3 finale:** completata sul corpus isolato da 11.032 opere (risultati in fondo e
in `performance-p3-final.json`). Il canonico può avanzare senza attendere
catalogo/full-text finché i budget durevoli lo consentono. Il completamento
canonico rimane distinto dalla ricercabilità. P4 è completata come documentato in fondo; P5 resta da svolgere;
nessuna importazione definitiva è autorizzata da queste prove.

## Stato e perimetro

P0 misura il checkpoint 1.0.0 (`23afe66d36ac06c9716936987afdcdf05ffbfaa0`),
non un'installazione in produzione. Le sezioni P0 conservano la baseline originale;
le implementazioni P1A/P1B.1/P2A/P2B.1/P2B.2 e le misure P2C sono documentate in fondo.
P2C completa le campagne A/B/C. P2D isola le proiezioni e verifica throughput,
recovery e latenze. La regressione residua della ricerca sotto backlog resta
documentata, ma non blocca P3 secondo le priorità aggiornate sopra.
Il target **2.000 opere/s** è sperimentale: include canonico durevole,
provenienza/versioni/capitoli, catalogo, indicizzazione e visibilità nella ricerca.
Le prove riguardano soltanto `queue119_archive05.zip`, mai il dump completo.

## Pipeline effettiva e dipendenze

1. `ingest-worker.ts:tick` prende il lock leader `70210403`. I batch e le
   sorgenti vengono elaborati in ordine; aumentare i processi worker non abilita
   automaticamente più ZIP. BullMQ (`archive-queue.ts`) ha concorrenza 1; PostgreSQL
   conserva batch, checkpoint, outbox e ricevute, Redis non è autorità archivistica.
2. `ao3.py:run_zip` legge/decomprime il ZIP esterno nel padre, calcola SHA-256,
   verifica CRC e prepara finestre limitate. Il pool di processi interpreta EPUB,
   HTML/XML e scrive segmenti staging. I membri grandi passano da file temporanei;
   quelli piccoli passano anche per il trasporto multiprocessing. I risultati sono
   consumati in ordine sorgente: un membro lento trattiene quelli già pronti.
   SQLite è letto in sola lettura, con metadata e dipendenze ZIP; assenze/lacune
   non sono opere complete. Questo benchmark EPUB non misura il percorso SQLite.
3. JSON NDJSON Python → Node porta descrittori e metadata. `IngestPipeline`
   limita i gruppi concorrenti, ordina le dipendenze per identità e restituisce
   ACK FIFO solo sul prefisso committato. Il parser conserva staging finché serve:
   è backpressure intenzionale, non una coda illimitata.
4. `archive.ts:ingestRecords` prepara staging/hash prima delle transazioni.
   `archiveTransaction` prende lock archivio condiviso e lock per identità ordinati;
   non serializza ogni gruppo sotto un lock esclusivo globale. I percorsi senza
   chiavi e compaction hanno anche lock esclusivi. `archive-ingest.ts` riconcilia
   lo stato e conserva evidenze; `archive-bulk.ts` internizza payload e usa COPY
   binario/staging e INSERT set-based. Il commit canonico è già largamente a batch.
5. PackStore (`pack.ts`) comprime Zstd, deduplica tramite catalogo/hash, scrive,
   fsync/seal/verifica, registra locator e checkpoint prima del COMMIT. Le riletture
   per verificare checksum e durabilità non sono lavoro eliminabile senza sostituto.
6. Il trigger sulle head accoda `catalog_pending`; quello sugli snapshot accoda
   `catalog_snapshot_pending`. `catalog.ts:projectCatalog` prende il lock globale
   `70210408`, chiama `projectGraph`, idrata 20 opere e poi le proietta una per una.
   `loadSnapshot` torna a idratare opere già idratate nel batch. Bibliografia crea
   tag/autori/entità e associazioni tramite query individuali, chiusure ricorsive,
   DELETE/reinsert dei filtri. Solo quando la coda corrente è vuota vengono
   materializzate 20 viste storiche per passaggio, con altro lavoro bibliografico.
7. `projectGraph` legge l'intero `archive_tags` e accoda **tutte** le head.
   Migrazione 022: trigger tag a livello statement, anche se UPDATE non cambia
   righe; trigger edge per INSERT/DELETE. L'invalidazione non è limitata alle opere
   interessate. Non attribuire però ogni upsert in `catalog_tags` a questo trigger:
   la tabella trigger è `archive_tags`. Il costo dipende dai cambi effettivi del grafo.
8. `catalog-search.ts:projectText` fa HEAD dell'indice a ogni passaggio, poi fino a
   16 transazioni **sequenziali**, con `SKIP LOCKED`. Ogni documento rilegge head,
   payload, manifest, capitoli e note dai pack, decomprime/verifica e riestrae testo
   HTML, interroga tag/relazioni, serializza JSON e invia un PUT. Il lock della
   coda e la transazione SQL rimangono aperti durante HTTP; DELETE coda e COMMIT
   seguono la risposta. Non c'è `_bulk` né parallelismo documenti in questo loop.
9. `main.ts` ha due timer indipendenti da 1 s, con guardia anti-sovrapposizione
   distinta per catalogo/full-text. `operations-index.ts` aggiunge un advisory lock
   di sessione per tipo di proiezione; repliche API non moltiplicano gli indicizzatori.
   Modalità normale: un passaggio/tick; maintenance: quattro. La sovrapposizione
   ingest/catalogo/testo esiste già, ma ogni stadio conserva i propri colli seriali.

Limiti statici del normale scheduler: ≤20 opere correnti/s, ≤16 documenti/s;
per una prima importazione con una vista storica per opera servono almeno
`2 × ceil(11032/20) = 1104` passaggi catalogo, salvo materializzazione anticipata
nel lettore. Non è una misura di capacità del server PostgreSQL/OpenSearch.

## Metodo e riproduzione

Le directory devono essere nuove e private su disco con spazio sufficiente.
Nessuna porta host, rete Docker interna, bind mount persistenti, dump `readonly`.
Non modificare i servizi dell'istanza. Immagini e configurazione sono quelle del
report 10: PG 17.6, Redis 7.4.6 AOF, OpenSearch 2.19.4 heap 1 GiB,
Zstd 3, gruppi 256, libuv 8. Si abilita `pg_stat_statements` e `track_io_timing`
solo nel PostgreSQL della fixture. Nessun fsync o vincolo viene disabilitato.

```sh
# Costruire dalla revisione da misurare; evitare di riutilizzare immagini obsolete.
docker build -f infra/Dockerfile --target api -t palimora-p0-api .
RELEASE_IMAGE=palimora-p0-api RELEASE_KEEP=1 \
 RELEASE_BENCH_ROOT=/mnt/sdb/palimora-p0-A ./scripts/benchmark-p0.sh
RELEASE_IMAGE=palimora-p0-api P0_SCENARIO=B \
 RELEASE_BENCH_ROOT=/mnt/sdb/palimora-p0-B ./scripts/benchmark-p0.sh
# Due ingest nuovi per profilo, dopo aver terminato le altre misure:
./scripts/benchmark-performance-profiles.sh /mnt/sdb/palimora-p0-A
```

`P0_PARSERS`/`P0_COMMITS` selezionano il profilo anche per un intero scenario.
A usa tick ingest diretto, drenaggio catalogo, drenaggio testo; B avvia davvero
`main.js` e `ingest-worker.js`, senza replica del codice di scheduling nel benchmark.
Il tempo B parte dall'inserimento del batch con processi pronti e termina dopo
refresh, verifica insiemistica degli ID OpenSearch/PG e richieste autenticate a
`/works`, dettaglio e `/read`. Il lettore viene verificato su un'opera campione;
non si sostiene di avere aperto tutti i capitoli via HTTP.
Il tempo A include anche avvio processi/API e verifica, distinguendosi dalla
semplice somma dei tempi motore. Le verifiche non stampano testi o credenziali.

Le latenze diagnostiche sono intervalli client inclusivi: SQL include round-trip,
server e attese; HTTP include attesa rete/server fino agli header. Non sottrarre
intervalli annidati/contemporanei come se fossero tempi CPU esclusivi. Il profiler
esistente attribuisce l'unione dei gruppi ingest con precedenza SQL/pack/staging:
è una convenzione di attribuzione, non una prova che il parser fosse inattivo.
`performance-profiler.cjs` viene caricato soltanto con preload esplicito e percorso
`P0_PROFILE=/results/...`; aggrega chiamate senza parametri SQL o contenuti.
`performance-snapshot.cjs` cattura WAL, query, tabelle/indici, I/O e statistiche
OpenSearch. `performance-queues.cjs` campiona code e wait event ogni 5 s.
`p0-python/sitecustomize.py` abilita cProfile in una passata diagnostica separata:
`PYTHONPATH=/app/scripts/p0-python P0_PYTHON_PROFILE=/results/python`.
Questo profiler deterministico può alterare il tempo parser: non usarlo come
baseline senza confronto overhead. Profili e piani rimangono nella directory privata.

CPU Docker 100% = un core; RAM = working set cgroup, non RSS Python o heap JVM.
I/O cgroup include writeback; WAL è separato. Cache sorgenti non svuotata, host
condiviso: queste misure non sono prove a cache fisicamente fredda. Le ripetizioni
brevi non costituiscono un intervallo di confidenza robusto.

## Target 2.000 opere/s: budget fisico e logico

`11032 / 2000 = 5,516 s`. Le quantità seguenti sono divisioni dei byte del
campione per quel budget, **non throughput dimostrati**. Non sommare byte sorgente,
pack e indice come se fossero lo stesso canale I/O.

| Confine                                   |  Volume campione |  Flusso richiesto a 2.000 opere/s |
| ----------------------------------------- | ---------------: | --------------------------------: |
| ZIP sorgente                              |       218,03 MiB |                       39,53 MiB/s |
| Membri ZIP espansi, EPUB ancora compressi |       571,06 MiB |                      103,53 MiB/s |
| Oggetti canonici raw                      |       927,62 MiB |                      168,17 MiB/s |
| Record PackStore                          | circa 277,37 MiB |                       50,28 MiB/s |
| Capitoli                                  |           22.928 |                  4.157 capitoli/s |
| Oggetti fisici                            |          107.054 |                  19.408 oggetti/s |
| Associazioni tag del report 10            |          167.736 | 30.409 associazioni/s per tabella |

Il throughput minimo di storage da solo non include staging, riletture/verifiche,
WAL, indici B-tree/GIN, translog, merge e fsync. Ogni passaggio aggiunge traffico e
CPU. Il padre ZIP seriale deve decomprimere almeno 103,53 MiB/s e alimentare il
pool senza bolle. I due livelli ZIP/EPUB, JSON, hashing, Zstd e parsing competono
per CPU e banda memoria. La dedup riduce scritture ma non elimina lettura/hash.

Con l'architettura corrente servono almeno 2.000 PUT/s, 2.000 transazioni full-text/s,
più le query per documento. Gli indici nested rendono il numero di documenti
Lucene diverso dal numero di opere: usare `_count` per la completezza e statistiche
primarie per il lavoro server. Non confondere `index_time_in_millis` (tempo interno
cumulato) con il tempo end-to-end del client.

Sono necessari la rimozione dei limiti di scheduling e dei round-trip seriali,
un protocollo `_bulk` durevole e un livello di parallelismo misurato. Aumentare
solo parser o heap JVM non basta. Non è dimostrato che queste condizioni siano
sufficienti per 5,516 s: mancano prove di saturazione della VM e curve di scala
sotto carico con correttezza invariata. Il limite inferiore di ogni risorsa è
`byte / banda sostenuta` o `CPU-secondi / core utilizzabili`, ma la banda sostenuta
fisica dell'hypervisor e la CPU realmente disponibile agli altri servizi non
sono state determinate; non esiste qui un limite teorico numerico validato.

Il campione ha circa 2,08 capitoli/opera e molti oggetti piccoli; circa il 40% dei
byte raw del report 10 è costituito da ausiliari molto comprimibili. Non rappresenta
la distribuzione di opere lunghe, media, revisioni multiple, SQLite metadata-only,
ZIP mancanti, grafo sorgente ricco, né indici da milioni di opere. «Opere/s» va
sempre accompagnato da byte/s, capitoli/s e completezza; nessuna estrapolazione
lineare alla dimensione totale del dump è una previsione attendibile.

Diagnostica supplementare sulla fixture conservata, con gli altri benchmark fermi:

```sh
./scripts/benchmark-performance-overhead.sh /mnt/sdb/palimora-p0-A
fixture=$(cat /mnt/sdb/palimora-p0-A/name)
docker exec "$fixture-worker" node scripts/benchmark-profiler-overhead.cjs
docker exec "$fixture-worker" node scripts/performance-invalidation.cjs
for probe in query index; do
 docker exec "$fixture-worker" node "scripts/benchmark-$probe-plan.cjs"
done
```

Il probe invalidazione usa una transazione con rollback: anche un UPDATE di zero
righe su `archive_tags` attiva il marker statement-level. I piani EXPLAIN ANALYZE
esistenti vengono riutilizzati; i probe che scrivono code fanno rollback. I file
`.pstats` Python sono leggibili con `python3 -m pstats FILE`. Le misure Python
riportano anche CPU user/system e massimo RSS per processo, senza confonderli
con la somma dei tempi cumulativi delle funzioni.

## Baseline A misurata — 8 novembre 2026

Fixture privata `/mnt/sdb/palimora-p0-20261108-a/results/`. Immagine locale
`palimora-release-api:1.0.0`, sorgenti ingest/catalogo/parser confrontati tramite
SHA-256 con il checkpoint. SHA ZIP invariato rispetto al report 10.
La prima acquisizione A è stata raccolta durante la costruzione del runner:
l'intervallo complessivo deriva dai timestamp di avvio ingest e verifica finale,
mentre le fasi usano timer monotoni. Il runner consolidato usa anche per A
l'orologio monotono condiviso. I probe leggeri di osservazione SQL sono inclusi;
non sono state eseguite altre importazioni della fixture contemporaneamente.

| Misura                      |     Secondi |    Opere/s | Confine                                  |
| --------------------------- | ----------: | ---------: | ---------------------------------------- |
| Ingest canonico 2/2         |      49,322 |     223,67 | Tick fino al commit persistente          |
| Catalogo corrente + storico |     427,752 |      25,79 | Drenaggio di entrambe le code            |
| Full-text                   |     384,229 |      28,71 | Costruzione, PUT, DELETE coda e COMMIT   |
| Refresh + verifica finale   |       4,882 |          — | Tutti gli ID, ricerca e lettore campione |
| **A end-to-end osservato**  | **878,073** | **12,564** | Include avvii, interstizi e verifica     |
| Somma delle tre fasi motore |     861,303 |      12,81 | Solo somma aritmetica, non end-to-end    |

11.032 head, snapshot e documenti; 107.054 oggetti, 52 pack; tutte le code vuote.
`_count`, confronto dei 11.032 ID e `/works` concordano; `/read` restituisce il
lettore. Nessun documento fallito in OpenSearch; zero deadlock/rollback nelle
statistiche DB raccolte prima dei probe con rollback.

### Tempi diagnostici A

| Operazione                                 |  Chiamate | Tempo accumulato s | Interpretazione                                                 |
| ------------------------------------------ | --------: | -----------------: | --------------------------------------------------------------- |
| Unione gruppi ingest                       | 47 gruppi |             41,118 | Finestra attiva, non CPU                                        |
| SQL nella partizione ingest                |         — |             30,279 | Precedenza sugli altri span sovrapposti                         |
| Pack nella partizione ingest               |         — |              8,808 | Esclusivo rispetto a SQL secondo il profiler                    |
| Staging nella partizione ingest            |         — |              0,606 | Non tutta l'attività Python staging                             |
| Core restante nella partizione ingest      |         — |              1,425 | Residuo della stessa unione                                     |
| Compressione codec                         |     4.619 |             17,697 | Async inclusivo, sovrapposto                                    |
| Decompressione codec nel commit            |     1.694 |              6,089 | Include verifica pack                                           |
| Preparazione staging                       |        47 |              5,602 | Inclusivo, non sommabile alla partizione                        |
| Hash documenti nativo                      |        47 |              1,776 | Non include ogni SHA-256 del parser/pack                        |
| Preparazione COPY nativa                   |        47 |              4,120 | Inclusivo                                                       |
| COPY SQL                                   |        47 |              2,223 | Round-trip client                                               |
| Pack append                                |        52 |             10,362 | Inclusivo di scritture                                          |
| Pack finish/seal/verifica                  |        47 |              6,333 | Inclusivo di fsync e riletture                                  |
| fsync file pack                            |        47 |              1,263 | Directory sync separate                                         |
| COMMIT SQL ingest                          |        47 |              1,556 | Somma con gruppi concorrenti                                    |
| Checkpoint                                 |        47 |              2,499 | Dentro il commit archivistico                                   |
| `projectGraph`                             |     1.105 |              0,305 | Non domina questo ZIP                                           |
| `projectBibliography`                      |    22.064 |            280,638 | Corrente + storico; 65,6% del catalogo                          |
| `readObject`, intera proiezione            |    96.252 |            177,094 | Lookup, lock, lettura, decompressione/checksum                  |
| `loadSnapshot`, chiamate esterne full-text |    11.032 |             50,638 | Le chiamate lessicali interne al catalogo non sono intercettate |
| `chapterBytes`                             |    22.928 |             79,927 | Include lookup e letture                                        |
| `plain` full-text                          |    22.928 |             13,098 | Estrazione HTML visibile al wrapper                             |
| PUT OpenSearch fino agli header            |    11.032 |            160,420 | 41,8% del full-text, non solo CPU server                        |
| SQL client catalogo + testo                | 1.109.971 |            510,853 | Include inizializzazione; circa 100,61 chiamate/opera           |

Non sommare le righe annidate. Il residuo full-text escluso il tempo PUT è
223,81 s: include preparazione, altre richieste, risposta JSON e commit, non è
una misura pura di CPU per costruire documenti. Il profiler filesystem esistente
etichetta come `staging.sync` anche directory che non terminano in `.pmpack`:
quel contatore non è attribuito esclusivamente allo staging.

### PostgreSQL e OpenSearch A

`pg_stat_statements` registra 335.472 upsert tag (due passaggi bibliografici),
167.736 INSERT associazioni tag, 22.064 closure ricorsive e 24.909 INSERT
associazioni entità. I soli upsert tag e associazioni producono rispettivamente
115,36 e 115,26 MiB WAL e impiegano 19,87 e 16,52 s di esecuzione SQL server:
le chiamate seriali e i round-trip costano più del solo tempo SQL interno.
Il conteggio server complessivo include statement interni/inizializzazione e
monitor, quindi non coincide con le chiamate client del profiler.

Snapshot prima dei probe: WAL **744,32 MiB**, 13.176 commit DB, 0 rollback,
0 deadlock, 0 byte temporanei; lettura blocchi DB **0,669 s**, scrittura **1,914 s**.
WAL cumulativo include creazione database/migrazioni: non è il delta puro ingest.
Non si misura separatamente il costo CPU di manutenzione di ogni indice:
le sue scritture sono incluse in SQL/WAL e nelle dimensioni delle relazioni.

Documenti HTTP: **426.204.691 byte**, media **38.633,5 byte/opera**; 11.032 PUT,
più 694 richieste ausiliarie (prevalentemente HEAD dell'indice): circa 1,063
richieste per opera, prima delle richieste della verifica finale. A 2.000 opere/s
questi JSON richiederebbero circa **73,69 MiB/s**, senza overhead HTTP/translog.
OpenSearch registra **84,233 s** di `index_time`, 18,853 s di refresh interno,
2,615 s di merge (2 merge), nessun flush ancora avvenuto al campionamento,
0 `index_failed`. Il quoziente 11.032/84,233 = 131,0 documenti per secondo di
tempo interno cumulato **non è** una prova della capacità sostenuta del server;
il throughput applicativo osservato è 28,71 opere/s.

| Fase / container        | CPU media % | CPU max campionato % | RAM media MiB | RAM max MiB | Letture MiB | Scritture MiB |
| ----------------------- | ----------: | -------------------: | ------------: | ----------: | ----------: | ------------: |
| Ingest / Node + Python  |      224,29 |               353,26 |        544,44 |      665,93 |       22,70 |        810,56 |
| Ingest / PostgreSQL     |       71,09 |               172,15 |        173,94 |      252,52 |       25,34 |        457,82 |
| Ingest / OpenSearch     |        4,07 |                66,83 |       1486,49 |     1489,47 |        0,03 |          0,34 |
| Ingest / Redis          |        0,85 |                 1,23 |          3,88 |        3,88 |           0 |             0 |
| Proiezioni / Node       |       41,86 |               139,08 |        274,55 |      449,49 |       74,49 |          1,61 |
| Proiezioni / PostgreSQL |       43,28 |               147,26 |        294,74 |      339,24 |       10,11 |       2059,91 |
| Proiezioni / OpenSearch |       25,13 |               442,25 |       1601,94 |     1784,29 |        0,67 |       1135,63 |
| Proiezioni / Redis      |        0,72 |                 1,13 |          3,91 |        4,16 |           0 |             0 |

14 vCPU disponibili alla VM, circa **3,00 core medi** ingest e **1,11 core**
proiezioni: assenza di saturazione aggregata non significa assenza di sezioni
seriali sature. Circa **1.055,94 CPU-secondi** campionati in queste due fasi:
con lo stesso lavoro CPU e parallelismo perfetto sui 14 core, circa **75,42 s**.
È un budget ottimistico del codice attuale, non un limite fisico di una nuova
architettura. Per 5,516 s lo stesso lavoro richiederebbe circa 191 core; occorre
ridurre drasticamente il lavoro oltre a sovrapporre le attese.

### Ripetizioni ingest, profili invariati

Database e PackStore nuovi a ogni esecuzione; stesso PostgreSQL/container di
fixture, cache non azzerata. Ordine 1/1, 2/2, 6/4, ripetuto due volte.
Il denominatore della colonna aggregata è la media delle due durate, non la media
dei throughput. I/O, picchi per componente e span completi sono nei JSON privati.

| Parser/commit | Tempo 1 s | Tempo 2 s | Opere/s aggregate | Intervallo opere/s | MiB sorgente/s | CPU media fixture core | RAM media fixture MiB |
| ------------- | --------: | --------: | ----------------: | -----------------: | -------------: | ---------------------: | --------------------: |
| 1/1           |    74,562 |    69,770 |            152,87 |      147,96–158,12 |           3,02 |              1,89–1,96 |             2705–2839 |
| 2/2           |    47,453 |    48,546 |            229,83 |      227,25–232,48 |           4,54 |              3,00–3,02 |             2723–2947 |
| 6/4           |    42,369 |    40,109 |            267,52 |      260,38–275,05 |           5,29 |              4,00–4,04 |             2888–3153 |

Tutte e sei: 11.032 opere/snapshot e 107.054 oggetti, zero lacune; la granularità
pack varia con i gruppi temporali senza cambiare i byte raw preservati.
Da 2/2 a 6/4: −14,1% del tempo ingest medio, +16,4% throughput, circa un core
in più. La variazione picco-picco dei tempi nelle coppie è 6,64%, 2,28%, 5,48%:
le differenze tra profili superano quella variabilità osservata, ma due campioni
non stimano una distribuzione né un intervallo di confidenza. La RAM crescente
include cache dei servizi riutilizzati, non prova una crescita equivalente della
memoria strettamente necessaria al parser.

### Scoperta nel percorso operativo: invalidazione da seeding AO3

Oltre al grafo globale, esiste un'invalidazione ridondante indipendente:
`ao3-scheduler.ts:scheduleSync` crea fino a **256 job ogni 60 s**, anche quando
il gate non consente fetch remoti. La migrazione **026**, funzione
`ao3_availability_changed`, accoda l'opera a ogni INSERT di un job `kind='work'`,
anche se la disponibilità iniziale è soltanto `unknown` e il catalogo non cambia.
I cursori seed e catalogo ordinano entrambi per UUID: il seeding raggiunge opere
spesso già proiettate, quindi non basta il coalescing `ON CONFLICT DO NOTHING`.

Durante B: 2.304 job work inseriti quando non esisteva alcun tag sorgente/arco,
zero errori di proiezione; a una successiva lettura 9.160 elaborazioni catalogo
contro 7.128 documenti distinti. Non sono duplicati canonici: sono riproiezioni.
Gli INSERT di documenti OpenSearch aumentano a loro volta. Il probe `projectGraph`
resta una prova distinta: non è la causa di queste ripetizioni nel campione.

Questo cambia la priorità P1: eliminare l'invalidazione per un nuovo job con stato
informativo invariato, preservando quella per cambi di disponibilità reali, prima
di attribuire tutto il costo alla bibliografia o di aumentare soltanto i worker.
La pressione teorica del seeding è 4,27 riproiezioni/s, fino al 21,3% del tetto
catalogo normale di 20/s, più il full-text conseguente. È un calcolo di pressione,
non una percentuale misurata di accelerazione dopo una correzione. Il seeding
rimane attivo nel benchmark: disabilitarlo avrebbe falsato lo scenario operativo.

Per le code di proiezione B, `timeline.json` campiona ogni circa un secondo.
L'integrale della cardinalità misura **residenza comprensiva del servizio**.
Diviso per i DELETE effettivi registrati da PostgreSQL fornisce la residenza
media per visita, contando anche le riproiezioni. Non va diviso per 11.032 e
presentato come attesa media di una singola visita. Un intervallo conservativo
per l'attesa esclude al più la durata massima osservata di un passaggio dello
stadio e aggiunge l'incertezza di campionamento (due intervalli massimi).
Questa distinzione evita di chiamare «attesa» anche il tempo HTTP/SQL trascorso
mentre la riga resta nella coda fino al COMMIT. I limiti sono riportati come
intervalli, non come timestamp individuali esatti. Il metodo presuppone code
iniziali/finali vuote e assenza di rollback nel tratto misurato.

## Baseline B operativa misurata

Fixture `/mnt/sdb/palimora-p0-20261108-b/results/`, normale policy applicativa,
API e ingest worker reali in processi distinti dello stesso container senza quote.
PostgreSQL, Redis e OpenSearch sono container separati. Il cgroup applicativo
aggrega API, worker, Python e sonde; `/proc` li distingue con campionamento a 1 s.
Le fixture precedenti rimangono inattive; nessun altro benchmark in parallelo.
La rete interna impedisce fetch reali verso AO3: il seeding resta attivo, ma non
ci sono aggiornamenti remoti che cambiano il corpus durante la prova. B misura
il runtime locale in queste condizioni, non la sincronizzazione con AO3 online.

| Misura B                                                 |                               Valore |
| -------------------------------------------------------- | -----------------------------------: |
| **End-to-end monotono, inclusa verifica**                |      **1.474,721 s / 7,481 opere/s** |
| Prima osservazione di tutte le code vuote                |                          1.463,677 s |
| Attesa batch prima dell'avvio persistito                 |                              0,763 s |
| Elaborazione batch fino al completamento persistito      |            63,097 s / 174,84 opere/s |
| Tempo accumulato `projectCatalog` (sovrapposto al testo) |                            790,891 s |
| Tempo accumulato `projectText` (sovrapposto al catalogo) |                            695,075 s |
| Proiezioni correnti / storiche                           |                      17.160 / 11.032 |
| Documenti PUT / opere uniche                             |                      17.160 / 11.032 |
| Lavoro corrente aggiuntivo                               |             **6.128 opere, +55,54%** |
| `projectBibliography`                                    |          28.192 chiamate / 534,292 s |
| SQL client nello scope catalogo                          |       1.179.090 chiamate / 683,603 s |
| SQL client nello scope full-text                         |         384.777 chiamate / 272,834 s |
| Recupero capitoli                                        |          35.238 chiamate / 158,520 s |
| Estrazione `plain` dei capitoli                          |           35.238 chiamate / 21,798 s |
| Letture canoniche via `readObject`                       | 144.079 / 350,357 s / 885,59 MiB raw |
| PUT HTTP, attesa client fino agli header                 |          262,631 s / 631,39 MiB JSON |
| Tempo indicizzazione interno OpenSearch                  |                            133,946 s |
| WAL delta rispetto al DB migrato                         |                        1.247,876 MiB |
| Rollback / deadlock PG / documenti OS falliti            |                            0 / 0 / 0 |

Tutti gli 11.032 ID coincidono fra PostgreSQL e OpenSearch; ricerca autenticata
restituisce 11.032 risultati, lettore campione aperto. Il lavoro di seeding continua
normalmente nel tempo: il punto di completamento è una verifica effettiva con code
vuote, non la promessa che il runtime non genererà mai più lavoro derivato.

Il tempo operativo è **68,0% maggiore** di A1, con throughput **40,5% inferiore**.
Non è un confronto isolato della sola sovrapposizione: B include seeding/outbox,
intervalli dei timer e contesa fra stadi, mentre A drena direttamente i processori.
I tempi accumulati di catalogo e testo **non vanno sommati** come end-to-end B.
Anche l'ingest operativo rallenta rispetto ad A1; non si attribuisce tutta la
variazione a un lock senza riscontri. Il grafo sorgente è vuoto in questa prova.

| Coda B            | Visite completate | Residenza media s, incluso servizio | Intervallo conservativo attesa media s |
| ----------------- | ----------------: | ----------------------------------: | -------------------------------------: |
| Catalogo corrente |            17.160 |                              228,04 |                          222,99–230,22 |
| Viste storiche    |            11.032 |                             1063,15 |                        1058,11–1065,34 |
| Full-text         |            17.160 |                               85,02 |                            73,33–87,20 |

Incertezza campionamento usata: ±2,185 s; sottrazione massima servizio: 2,857 s
catalogo, 9,498 s full-text (intero passaggio, quindi limite conservativo).
Non sono percentili delle attese individuali. Le visite aggiuntive sono contate;
non vengono spacciate per nuove opere. Il rollback diagnostico sull'invalidazione
è stato eseguito nella fixture A dopo la sua misura, non durante B.

| Componente B                  | CPU media % | CPU max campionato % | RAM working set media/max MiB |   Read/write MiB |
| ----------------------------- | ----------: | -------------------: | ----------------------------: | ---------------: |
| API + worker + parser + sonde |       49,85 |               365,66 |               838,60 / 982,63 |   93,80 / 517,58 |
| PostgreSQL                    |       49,29 |               209,21 |               383,46 / 523,59 |  24,96 / 4320,31 |
| OpenSearch                    |       25,26 |               317,92 |             1697,18 / 2231,79 | 131,61 / 2340,30 |
| Redis                         |        0,81 |                 2,03 |                   4,59 / 4,88 |      0,62 / 1,04 |

Totale medio circa **1,25 core e 2923,83 MiB**, senza sommare picchi non simultanei.
RSS distinti dal working set: API media/max 284,74/367,47 MiB; worker
398,48/525,59 MiB; gruppo Python massimo osservato 134,44 MiB. La media Python
sull'intero intervallo è poco rappresentativa perché i parser terminano dopo ingest.
CPU `/proc` osservata: API ≥584,90 s, worker ≥78,75 s, Python ≥60,46 s; la coda
finale di CPU dei processi che escono fra due campioni può sfuggire. RSS di processi
multipli può contare pagine condivise più volte: per la RAM fisica usare il cgroup.
Heap JVM massimo **895,03 MiB** nei campioni raccolti da circa 99 s in poi,
con heap massimo configurato 1 GiB; il picco precedente non è coperto. Nessun
rifiuto dei thread pool nel periodo campionato. L'indice usa durabilità translog
`REQUEST`; PostgreSQL mantiene fsync, synchronous_commit e full_page_writes attivi.

I wait event campionati includono `WalSync`, `ClientRead` e autovacuum;
non sono stati osservati wait `Lock` fra i backend attivi campionati. Questo
non esclude lock brevi tra campioni e non elimina i lock serializzanti dimostrati
nel codice. Non si presenta il tempo client SQL come tempo esclusivo di contesa.

La misura B e la verifica erano terminate quando il wrapper iniziale, modificato
mentre era in esecuzione, ha fallito nel post-processing shell. Il sampler era
stato chiuso; `summarize-resources.py` e `summarize-performance.py` sono stati
rieseguiti sui campioni completi. Nessun dato della pipeline è stato ricostruito
artificialmente. Il runner consolidato viene verificato nella ripetizione A2.

### Target rapportato alle misure P0

A1 richiederebbe circa **159×** il throughput end-to-end osservato; B circa
**267×**. I budget delle singole fasi A1 sarebbero circa 8,94× ingest, 77,55×
catalogo e 69,66× full-text. Non sono fattori da moltiplicare né benefici promessi.
Con circa 100,61 chiamate SQL client/opera nelle sole proiezioni A1, mantenere
questa granularità a 2.000 opere/s richiederebbe circa **201.227 chiamate SQL/s**,
oltre al commit canonico e alle attività amministrative. Il conteggio B non va
estrapolato meccanicamente: parte del lavoro ridondante dipende dai minuti di
seeding trascorsi, non soltanto dal numero di opere.

Le scritture cgroup campionate in A1 sommano circa **4.465,87 MiB** fra ingest e
proiezioni: conservarne il pattern entro 5,516 s implicherebbe circa **809,62 MiB/s**,
non i soli 50,28 MiB/s dei pack. È una stima dalla write amplification osservata,
con cache/writeback e finestra di campionamento, non una misura della banda disco
sostenibile. Il solo WAL A1 cumulativo richiederebbe circa 135 MiB/s; il valore
include bootstrap e non sostituisce il delta di fase. CPU e round-trip devono
ridursi insieme alle scritture; nessuna misura attuale dimostra raggiungibili
2.000 opere/s sulla VM presente.

## Diagnostica parser, JSON e overhead

Passate separate sullo stesso corpus, DB e storage nuovi; il confronto seguente
è indicativo dell'overhead, non una distribuzione statistica. Nessuna passata
cProfile/V8 viene presentata come throughput baseline.

| Strumentazione ingest 2/2               | Motore s | Totale s | Differenza motore da off |
| --------------------------------------- | -------: | -------: | -----------------------: |
| Profiler disabilitato                   |   47,042 |   47,820 |                        — |
| Span ingest + V8 + misure JSON          |   50,753 |   52,123 |                   +7,89% |
| cProfile Python, span Node disabilitati |   49,438 |   50,279 |                   +5,09% |

Le due passate 2/2 con il solo profiler ingest preesistente erano 47,453 e
48,546 s: scarti rispetto alla singola passata off non isolano overhead da rumore,
cache e variabilità dei batch. In produzione l'overhead aggiunto è zero: nessun
modulo diagnostico viene caricato dall'API/worker senza preload esplicito.

| Misura diagnostica                       | Chiamate | Tempo s | Significato                                                      |
| ---------------------------------------- | -------: | ------: | ---------------------------------------------------------------- |
| Node `JSON.parse`                        |  107.207 |   0,591 | 80.300.201 byte input; include JSON DB oltre al trasporto Python |
| Node `JSON.stringify`                    |  615.914 |   3,660 | 480.375.210 byte output; non tutti sono byte di rete             |
| ZIP esterno: `ZipExtFile.read` nel padre |   22.119 |   3,431 | Lettura + decompressione, cache sorgente calda                   |
| zlib esterno nel padre                   |   11.082 |   2,585 | Sottoinsieme della riga precedente                               |
| zlib nei due parser                      |  100.152 |   6,982 | Membri EPUB, somma delle chiamate concorrenti                    |
| `epub` nei parser                        |   11.032 |  52,657 | Parsing completo inclusivo, non wall-clock del batch             |
| XML parser `feed`                        |   22.064 |   2,213 | Somma tempi funzione                                             |
| Scanner HTML nativo `analyze`            |   33.960 |   7,869 | Tempo inclusivo nel wrapper Python                               |
| Creazione SHA-256 Python                 |  152.341 |   2,264 | Non comprende ogni update/hash nativo Node                       |
| JSON `iterencode` nel padre              |   11.088 |   2,136 | Serializzazione envelope                                         |
| `acknowledge` nel padre                  |       53 |  15,934 | Attesa/backpressure, non CPU parsing                             |
| `readline` Python complessivo            |      109 |  19,371 | Include ACK/cache, non pura latenza rete                         |

CPU effettiva `getrusage` nella passata Python: padre **14,670 s user + 2,776 s
system**, parser **55,288 s user + 2,742 s system**, tracker circa 0,072 s CPU;
totale circa **75,55 CPU-secondi**. Massimo RSS: padre **104,47 MiB**, parser
**43,71 e 45,34 MiB** ciascuno. Questi massimi non sono simultanei né vanno
sommati come picco fisico. La funzione del resource tracker risulta attiva per
48,96 s nel profiler, ma consuma 0,072 s CPU: esempio concreto del motivo per cui
i tempi cProfile inclusivi non sono tutti tempi CPU.

Il campionamento V8 della passata Node attribuisce circa 23,22 s a idle,
4,07 s ai wrapper JSON, 3,13 s a `update`, 2,41 s a GC e 2,22 s a `train`.
Sono campioni del thread V8; non misurano tutta la CPU libuv/N-API/Python e non
permettono di assegnare ogni hash al relativo dominio. La verifica finale ha
riletto con checksum **107.054 oggetti in 21,478 s totali** nella fixture A.

`perf` non è installato e `perf_event_paranoid=3`; non sono disponibili qui stack
kernel/native per separare precisamente CPU codec, attese del filesystem e
I/O fisico dell'hypervisor. I contatori CPU user/system, I/O cgroup/PG, tempi
codec/hash/staging e gli span async vengono quindi riportati separati, senza
inventare una decomposizione CPU/I/O esclusiva. Il parser contribuisce al costo,
ma i 0,591 s di JSON.parse o i soli 2,213 s XML non spiegano centinaia di secondi
di attesa della pipeline completa.

### Piani PostgreSQL ripetuti

I probe riutilizzano le query storiche di confronto del report 10; **le varianti
ottimizzate erano già nel checkpoint**, non sono modifiche P0.

| Probe EXPLAIN ANALYZE                          | Variante storica ms / buffer hit | Variante corrente ms / buffer hit |
| ---------------------------------------------- | -------------------------------: | --------------------------------: |
| Acquisizioni di 256 opere                      |                 436,570 / 56.090 |                     1,748 / 2.050 |
| Dequeue ultimo migliaio, statistiche pre-drain |                   44,473 / 6.445 |                       2,890 / 123 |

Nel secondo probe le letture sono 1.730 → 4 blocchi. È lo scenario specifico di
statistiche obsolete preparato dal probe, non un guadagno generale da attribuire
alla nuova fase. Conferma di mantenere le query correnti e concentrare P1 sulla
granularità della proiezione, sulle invalidazioni e sullo scheduling; non fornisce
una motivazione per aggiungere indici duplicati a caso.

## Top 10 colli di bottiglia e priorità finali

L'ordine combina costo osservato e pressione sul percorso operativo. Gli span
si sovrappongono: questa tabella non è un conto economico di secondi risparmiabili.

| Ordine | Collo di bottiglia                                                   | Evidenza P0                                                                                        | Intervento / beneficio potenziale / rischio                                                                                                                                                                  |
| ------ | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1      | Catalogo seriale e query N+1, `catalog.ts`/`catalog-bibliography.ts` | A1: 427,75 s; bibliografia 280,64 s; 335.472 upsert tag                                            | Batch set-based; forte riduzione di round-trip e WAL attesa, fattore non misurato. Complessità alta: identità/alias, anonymous, closure e storico devono coincidere                                          |
| 2      | Timer e lock di proiezione, `main.ts`/`operations-index.ts`          | Tetti 20/16 per s; almeno 1.104 passaggi catalogo per prima acquisizione, prima delle riproiezioni | Drain con budget e wake-up; rimuove il tetto artificiale, non il costo delle query. Complessità media: fairness, stop, backpressure, servizi interattivi                                                     |
| 3      | Seeding AO3 invalida `unknown`, `ao3-scheduler.ts` e migrazione 026  | B: 17.160 proiezioni/PUT per 11.032 opere, +55,54%; 0 errori                                       | Sopprimere invalidazioni senza cambi informativi; evita quella classe di ripetizioni. Complessità contenuta ma testare INSERT con availability nota e tutti i cambi reali                                    |
| 4      | HTTP per documento dentro transazione, `catalog-search.ts`           | A1: 11.032 PUT / 160,42 s; server index_time 84,23 s                                               | `_bulk`, preparazione parallela bounded e claim/generation/ACK fuori transazione lunga. Complessità alta; retry parziali e aggiornamenti obsoleti. Non tutti i 160 s sono eliminabili                        |
| 5      | Rilettura canonico e ricostruzione testo                             | A1: 96.252 readObject / 177,09 s; capitoli 79,93 s, plain 13,10 s                                  | Riuso manifest/payload entro batch e testo derivato keyed per snapshot/hash/estrattore. Risparmio da misurare includendo il nuovo costo in ingest; rischio indicizzare testo di una versione non selezionata |
| 6      | Doppio lavoro bibliografico corrente/storico                         | A1: 22.064 chiamate per 11.032 opere; B: attesa storico circa 1.060 s                              | Condividere risultati soltanto quando snapshot e semantica storica coincidono, batching storico. Complessità alta: non cancellare storico o confondere grafi correnti/storici                                |
| 7      | Invalidazione globale del grafo                                      | Probe: 0 → 11.032 pending dopo UPDATE di zero righe; A1 projectGraph solo 0,305 s                  | Invalidazioni mirate/coalescing; importante sui dump tag, non causa dominante misurata di questo ZIP. Complessità alta per dipendenze transitive                                                             |
| 8      | SQL e checkpoint canonico                                            | Unione ingest: 30,279 s SQL su 41,118 s attivi; 47 commit / 1,556 s                                | Profilare staging COPY, selezioni e registrazioni set-based già presenti; ottimizzare lavoro reale, non togliere commit/fsync. Dipende da evidenze sui batch e test di crash/dedup                           |
| 9      | ZIP padre ordinato, IPC e ACK FIFO                                   | Python diagnostico: 15,934 s negli ACK; 6/4 migliora solo 14,1% rispetto 2/2                       | Pipeline lettura/parsing e più ZIP bounded, dopo avere liberato gli stadi a valle. Complessità alta: ordine ricevute, spazio, identità condivise; non dedurre scaling lineare dai processi                   |
| 10     | Codec/hash/staging e serializzazioni ripetute                        | Compressione async 17,697 s; staging.prepare 5,602 s; JSON Node 4,251 s in passata diagnostica     | Riuso buffer/preparazioni immutabili e profiling nativo successivo. Beneficio end-to-end inferiore alle proiezioni nel campione; mai omettere verifiche indipendenti dei pack                                |

Tre linee con maggiore beneficio potenziale: **proiezione PostgreSQL a batch**;
**scheduling continuo con invalidazioni informative corrette**; **indicizzazione
bulk con preparazione bounded parallela e protocollo durevole fuori SQL**.
Il riuso del testo è complementare alla terza, non un sostituto del batching.
Più ZIP contemporanei e una riscrittura del parser non sono le prime mosse
supportate da questi risultati.

P1 concreta: prima correggere e testare il no-op di seeding `unknown` e il budget
scheduler; poi una vertical slice set-based della bibliografia, confrontando
proiezioni correnti/storiche e ricerca con il percorso originale. Per ogni slice
rieseguire A/B, verificare tutte le identità e quantificare query/opera, WAL,
numero di riproiezioni e latenza interattiva. In particolare, un nuovo job sync
`unknown` non deve produrre modifiche informative; un cambiamento reale di
availability deve continuare ad aggiornare ricerca e lettore. Nessuna di queste
correzioni viene implementata in P0.

Gli snapshot OpenSearch rendono visibile anche il lavoro accessorio: A1 ha indice
primario **441,39 MiB**, 0 documenti cancellati e translog **407,33 MiB**; B ha
**537,71 MiB**, **2.304 documenti cancellati** ancora presenti nei segmenti e
translog **81,53 MiB**. In B: 3 merge / **60,132 s**, 11,956 s di throttling merge,
2 flush / **8,824 s**, refresh interno **28,257 s**. Sono snapshot live a tempi
differenti, non dimensioni finali dopo force-merge; non è stato forzato un merge
per abbellire il risultato. Il translog B più piccolo segue i flush già avvenuti,
non dimostra meno lavoro di indicizzazione. Gli upsert ridondanti aumentano il
lavoro derivato oltre al solo numero di PUT.

## Ripetizione A2 e verifica conclusiva

Runner consolidato, directory nuova `/mnt/sdb/palimora-p0-20261108-a2/results/`.

| Scenario                 | Ingest canonico s | Catalogo + storico s |    Full-text s | End-to-end s | Opere/s end-to-end |
| ------------------------ | ----------------: | -------------------: | -------------: | -----------: | -----------------: |
| A1 sequenziale           |            49,322 |              427,752 |        384,229 |      878,073 |             12,564 |
| A2 sequenziale, monotono |            51,117 |              413,530 |        386,423 |      869,978 |             12,681 |
| B operativo              |            63,097 |       790,891 attivi | 695,075 attivi |     1474,721 |              7,481 |

Le fasi B si sovrappongono e includono riproiezioni. A2: 11.032 opere, snapshot,
documenti e ID verificati, 107.054 oggetti, tutte le code vuote e lettore aperto.
A1/A2 differiscono dello **0,93%** rispetto al tempo medio; il throughput calcolato
sul tempo medio è **12,622 opere/s**. Due passate A e una B non costituiscono una
stima statistica robusta per ogni condizione di carico. I confronti dei profili
ingest hanno due passate ciascuno; non sono benchmark di cataloghi da milioni.

A2 separa il WAL per fase, al netto del DB migrato: **172,683 MiB ingest**,
**554,879 MiB catalogo/storico**, **3,142 MiB full-text**. Le query client sono
**862.392 catalogo** (78,17/opera, 351,341 s inclusivi) e **247.488 full-text**
(22,43/opera, 142,003 s inclusivi). I due indici delle associazioni tag/filtri
pesano circa **52 MiB ciascuno**; `catalog_documents` circa **62,77 MiB totali**,
di cui **20,16 MiB indici**. Non si è aggiunto alcun indice al prodotto.

Documenti OpenSearch A2: media 38.633,5 byte, massimo **3.708.478 byte**;
istogramma binario: mediana nell'intervallo (16,32] KiB, P95 (64,128] KiB,
P99 (256,512] KiB, 14 documenti oltre 1 MiB. Le latenze PUT fino agli header
hanno P95 nell'intervallo (16,32] ms, P99 (32,64] ms, massimo **7.302 ms**.
Gli intervalli derivano da bucket, non sono percentili esatti. Il massimo
osservato supera da solo il budget di 5,516 s del target per tutto il corpus;
non è un limite fisico, ma va affrontato insieme al throughput medio.

Probe HTTP successivo, separato dal tempo end-to-end: 3 warmup esclusi e 100
richieste autenticate sequenziali per endpoint, HTTP interno senza gateway/TLS.
I PIT creati dalla prova vengono chiusi. Percentili nearest-rank, nessun SLO.

| API                                    | Media ms | P50 ms | P95 ms | Max ms |
| -------------------------------------- | -------: | -----: | -----: | -----: |
| Ricerca `/works`                       |    82,04 |  73,15 | 133,37 | 182,77 |
| Dettaglio opera                        |    13,45 |  13,09 |  19,82 |  22,25 |
| Lettore `/read`, selezione predefinita |    24,93 |  23,04 |  39,06 |  67,00 |

### Overhead del profiler SQL

Probe contro PostgreSQL reale, connessione calda, 3.000 query `SELECT 1` per
campione, ordine off/on/on/off/off/on e warmup escluso. Off:
0,1215 / 0,1164 / 0,0991 ms per query; on: 0,1444 / 0,1817 / 0,1224 ms.
Media **0,1123 → 0,1495 ms**, circa **37 μs aggiunti/chiamata** in questo microprobe.
Su una query quasi vuota è +33%; non è +33% del tempo end-to-end. Non misura
separatamente il costo AsyncLocalStorage nei processori completi e ha variabilità
visibile. I baseline delle proiezioni sono **strumentati**: non vengono corretti
sottraendo una stima dal totale, né spacciati per misure senza observer effect.
Per confrontare P1 mantenere lo stesso profiler/configurazione e affiancare una
passata senza preload quando si vuole misurare il throughput non strumentato.

I risultati aggregati leggibili da strumenti sono in [performance-p0.json](performance-p0.json).
Le evidenze complete (profili, piani, campioni, configurazione runtime e checksum
script/immagine) restano nelle tre directory private sopra indicate. I contenuti
archivistici, gli ID delle opere e le sessioni non sono pubblicati nel repository.

P0 consegna una baseline end-to-end verificata, una diagnosi misurata e una
strategia concreta P1. Restano esplicitamente non dimostrati: saturazione massima
della VM, cache fisica fredda, scala a milioni, comportamento AO3 online,
attribuzione CPU nativa/kernel esclusiva e raggiungibilità del target 2.000/s.
Il riuso futuro del testo deve rimanere ricostruibile dai pack e non dipendere
più da staging o dump dopo il commit. Alla chiusura P0, P1 non era stata iniziata.

### Verifiche del codice e conservazione evidenze

- Runner A2 completato con exit code 0; confronto completo dei 11.032 ID, conteggi e API verificato in A1, A2 e B.
- `tsx --test tests/ingest-pipeline.test.ts tests/archive-native.test.ts` con `TEST_DATABASE_URL` della fixture: **5 passati, 0 falliti, 0 saltati**. I test DB usano schemi temporanei distinti e li eliminano.
- Sintassi Bash, Node e Python degli strumenti verificata; `git diff --check` e controllo numerico di `opere/s × secondi = 11032` per gli aggregati superati.
- Nessuna modifica al codice applicativo, alle migrazioni del prodotto o al formato canonico. Modificati soltanto strumenti benchmark, riepiloghi e documentazione.
- I container e le reti delle tre fixture vengono rimossi al termine; bind mount e risultati privati rimangono disponibili. Nessun servizio Docker estraneo viene modificato.


## P1A — invalidazioni e scheduling delle proiezioni

Perimetro: migrazioni 037–038 e scheduling in `operations-index.ts`, integrazione
lifecycle API, quote catalogo/storico e dimensione batch full-text. Nessuna
riscrittura di `projectBibliography`, query set-based bibliografiche, grafo tag,
PackStore, parser, parallelismo ZIP o invio `_bulk`; P1B e P2 restano separati.

### Decisioni tecniche

- Il job AO3 assente e il job `unknown` non sovrascrivono la disponibilità canonica
  nel catalogo. La 037 sostituisce soltanto la funzione trigger: salta INSERT
  `unknown` e UPDATE senza cambiamento; mantiene INSERT informativi e tutte le
  transizioni reali, incluso il ritorno a `unknown`. La 026 rimane intatta.
  Nessun cambiamento a seeding, watchlist, osservazioni o outbox notifiche.
- La prova concorrente ha riprodotto una perdita di invalidazione nel protocollo
  precedente: `ON CONFLICT DO NOTHING` può ignorare una riga pending bloccata dal
  consumatore, prima che quest'ultimo la cancelli dopo avere proiettato lo stato
  vecchio. La 038 coordina enqueue da head/disponibilità con il lock della coda
  corrente; il produttore full-text usa lo stesso principio. L'upsert della chiave
  attende il consumatore: dopo il suo DELETE la nuova invalidazione rimane in coda.
  Nessuna generazione di claim, nuovo formato coda o riprogettazione del grafo.
- I due timer fissi vengono sostituiti nello scheduler operativo esistente con
  due cicli limitati, catalogo e testo, indipendenti per default. Dopo un batch
  con lavoro si procede senza aspettare un secondo. Il ciclo senza lavoro,
  in pausa/retry o senza lock dorme; il polling recupera anche commit provenienti
  da altri processi senza dipendere da notifiche volatili.
- Ogni transazione catalogo riserva una quota allo storico anche quando c'è
  backlog corrente. Un lotto massimo per classe conserva la fairness; il lock
  bibliografico globale e le transazioni restano quelli precedenti. Non si
  riutilizzano arbitrariamente viste correnti per rappresentare lo storico.
- Batch default 20 correnti + 20 storici e 16 documenti; concorrenza 1 o 2 stadi,
  default 2. Budget cooperativo default 100 ms, moltiplicato per quattro nelle
  modalità di manutenzione. Un batch atomico può superarlo; non si interrompono
  transazioni o ACK a metà. Configurazione e intervalli in [02](02-architettura.md#motore-di-consultazione)
  e `.env.example`, inoltrati dal Compose al servizio API esistente.
- Con almeno 2.048 documenti full-text pendenti il catalogo sospende soltanto la
  quota corrente, continuando lo storico. La produzione può superare la soglia
  di un batch. Non è un limite alla coda archivistica persistente o alla dimensione
  totale del corpus. Indicizzazione sequenziale per documento e pool PG invariati.
- Ogni passaggio rivalida pausa/retry sotto i lock di sessione `70210472/73`.
  La guardia generation e il confine transazionale PUT/DELETE/COMMIT rimangono
  invariati. Nessun claim o checkpoint nuovo in memoria. La chiusura API/SIGTERM
  ferma nuovi batch e attende quelli attivi; dopo kill il lavoro non committato
  resta nelle code. `operations_index` e la sua cronologia restano il monitor.

### Riproduzione P1A

Stesso `benchmark-p0.sh`, profiler P0 e verificatore originale, scenario B, profilo
2 parser/2 commit, Zstd 3, PostgreSQL 17.6, Redis 7.4.6 e OpenSearch 2.19.4 heap
1 GiB. Fixture nuove sullo stesso disco; rete interna, nessuna porta host, dump
read-only, seeding AO3 attivo. Nessuna quota cgroup durante la misura, come P0.
L'immagine di attribuzione contiene la stessa immagine P0 più la sola migrazione:
misura la correzione delle invalidazioni mantenendo i timer e la priorità allo
storico di P0. La differenza successiva con P1A comprende scheduling, fairness e
backpressure; non è una misura della futura ottimizzazione bibliografica.

```sh
docker build -f infra/Dockerfile --target api -t palimora-p1a-api .
# Immagine di attribuzione: usare l'immagine P0 verificata, non una build P1A.
docker build -t palimora-p1a-invalidation-only -f - . <<'EOF_DOCKER'
FROM palimora-release-api:1.0.0
COPY apps/api/migrations/037_ao3_informative_availability.sql /app/apps/api/migrations/037_ao3_informative_availability.sql
EOF_DOCKER
# Eseguire in sequenza, dopo le build, senza altri benchmark concorrenti.
RELEASE_IMAGE=palimora-p1a-invalidation-only P0_SCENARIO=B RELEASE_KEEP=1 \
 RELEASE_BENCH_ROOT=/mnt/sdb/palimora-p1a-invalidation-clean-20261108 ./scripts/benchmark-p0.sh
RELEASE_IMAGE=palimora-p1a-api P0_SCENARIO=B RELEASE_KEEP=1 \
 RELEASE_BENCH_ROOT=/mnt/sdb/palimora-p1a-b-20261108 ./scripts/benchmark-p0.sh
python3 scripts/summarize-performance.py /mnt/sdb/palimora-p1a-invalidation-clean-20261108 /mnt/sdb/palimora-p1a-b-20261108
# Solo dopo la misura, con API/worker del benchmark già arrestati:
fixture=$(cat /mnt/sdb/palimora-p1a-b-20261108/name)
docker exec "$fixture-worker" node scripts/verify-projections.cjs
python3 scripts/summarize-p1a.py /mnt/sdb/palimora-p0-20261108-b \
 /mnt/sdb/palimora-p1a-invalidation-clean-20261108 /mnt/sdb/palimora-p1a-b-20261108 \
 /mnt/sdb/palimora-p1a-latency-p0-20261108 /mnt/sdb/palimora-p1a-latency-new-20261108
```

Una prima passata esplorativa è stata interrotta ed esclusa dai risultati perché
si sovrapponeva alla build Docker. Evidenze private conservate separatamente in
`/mnt/sdb/palimora-p1a-invalidation-20261108`; nessun dato di quella passata entra
nel confronto. Baseline e strumenti P0 originali conservati senza modifiche.


### Risultati B e attribuzione misurata

Fixture definitive: `/mnt/sdb/palimora-p1a-invalidation-clean-20261108` e
`/mnt/sdb/palimora-p1a-b-20261108`. Un'esecuzione per variante, in sequenza e senza
build/test concorrenti. La fixture intermedia con errore JVM all'avvio di
OpenSearch non ha avviato ingest o misura ed è esclusa. P1A è misurata dal working
tree poi pubblicato: `source-commit.txt` conserva il commit base P0; hash dei sei
file applicativi/migrazioni e patch sono nei risultati privati. Immagine P1A:
`sha256:20620eac0055345b255f0d758a04749314fc6b4a1d42ac3603fa4504dc7c73d4`.

| Misura | P0 B | Solo invalidazioni (037), timer P0 | P1A B |
| --- | ---: | ---: | ---: |
| End-to-end, s | 1474,721 | 1145,523 | **602,783** |
| Opere/s ricercabili | 7,481 | 9,631 | **18,302** |
| Ingest persistente, s | 63,097 | 57,208 | 65,079 |
| Proiezioni correnti | 17.160 | 11.032 | 11.032 |
| Riproiezioni aggiuntive | 6.128 | 0 | **0** |
| Proiezioni storiche | 11.032 | 11.032 | 11.032 |
| PUT documenti OpenSearch | 17.160 | 11.032 | 11.032 |
| Catalogo attivo, s | 790,891 | 553,683 | 581,222 |
| Full-text attivo, s | 695,075 | 445,077 | 464,166 |
| Chiamate SQL client catalogo | 1.179.090 | 862.462 | 859.731 |
| Chiamate SQL client full-text | 384.777 | 248.728 | 248.136 |

P1A termina a code vuote, con 11.032 ID corrispondenti, ricerca autenticata e
lettore verificati dal runner originale. Controllo aggiuntivo dopo la misura:
**11.032 generazioni coincidenti**, 11.032 viste storiche, 2.560 job work seminati,
zero errori di proiezione. Snapshot DB prima dei fault test: **0 rollback,
0 deadlock, 0 byte temporanei**. I risultati aggregati e le risorse complete sono
in [performance-p1a.json](performance-p1a.json).

Attribuzione, nei limiti delle singole passate su host condiviso:

- **Invalidazioni:** eliminano tutte le 6.128 riproiezioni aggiuntive e altrettanti
  PUT osservati in P0 (−35,71% dei passaggi correnti/PUT). La sola 037 porta il
  tempo da 1474,721 a 1145,523 s: **−329,199 s / −22,32%** osservati. Seeding attivo
  in entrambe le prove; il risultato non dipende dalla sua disattivazione.
- **Scheduling/fairness:** a conteggi di lavoro invariati, P1A passa da 1145,523
  a 602,783 s: **−542,739 s / −47,38%** osservati. Include quote storiche e drenaggio
  continuo; non è una prova isolata di ciascun parametro. La 038 protegge le race,
  ma questo corpus senza cambi AO3 informativi non ne misura un guadagno di velocità.
  Soglia backpressure 2.048 non raggiunta in B (massimo testo 187): è una protezione
  verificata separatamente, non la causa del miglioramento attribuita al benchmark.
- **Totale:** **−59,13% end-to-end**, throughput **2,447×** P0. Il tempo attivo
  catalogo/full-text aumenta rispetto alla sola 037: il beneficio dello scheduling
  è l'eliminazione delle attese e la sovrapposizione dello storico, non una riduzione
  del costo per opera. Le query bibliografiche restano dominanti; nessun risultato
  dimostra il target 2.000 opere/s. L'ingest varia fra passate e non è stato ottimizzato.

### Residenza delle code

Secondi per visita, servizio incluso; stesso integrale dei campioni P0 e stesso
conteggio DELETE. Fra parentesi l'intervallo conservativo dell'attesa, non una
misura individuale dei timestamp:

| Coda | P0 B | Solo 037 | P1A B |
| --- | ---: | ---: | ---: |
| Corrente | 228,04 (222,99–230,22) | 274,32 (269,60–276,43) | 276,08 (269,77–278,22) |
| Storico | 1063,15 (1058,11–1065,34) | 829,53 (824,82–831,65) | 276,08 (269,77–278,22) |
| Full-text | 85,02 (73,33–87,20) | 78,69 (67,47–80,81) | 1,29 (0–3,43) |

P0 ha visite aggiuntive: confrontare soltanto la media corrente per visita
confonderebbe popolazioni diverse. Normalizzata per opera iniziale, la residenza
corrente è **354,70 → 274,32 → 276,08 s**, testo **132,24 → 78,69 → 1,29 s**.
Il catalogo corrente non accelera sensibilmente rispetto alla sola 037; la quota
storica evita la seconda lunga fase e il full-text segue la produzione. P1A:
code massime 10.432 correnti, 10.432 storici, 187 testo; intervallo di campionamento
massimo circa 1,068 s, batch catalogo massimo 4,179 s, full-text 7,813 s.

### CPU, RAM e I/O

Cgroup dei quattro container, stesso sampler P0. CPU 100% = un core; working set
RAM, non heap o somma di RSS. Non sommare picchi RAM non contemporanei.

| Misura | P0 B | Solo 037 | P1A B |
| --- | ---: | ---: | ---: |
| CPU totale, CPU-s | 1851,926 | 1298,277 | 1275,433 |
| CPU media aggregata, % | 125,20 | 112,59 | 210,10 |
| I/O letto totale, MiB | 250,99 | 59,75 | 92,54 |
| I/O scritto totale, MiB | 7179,23 | 4603,93 | 4899,40 |
| Picco RAM applicazione, MiB | 982,63 | 1011,57 | 1027,81 |
| Picco RAM PostgreSQL, MiB | 523,59 | 391,48 | 428,03 |
| Picco RAM OpenSearch, MiB | 2231,79 | 1666,39 | 1721,59 |
| Picco RAM Redis, MiB | 4,88 | 5,15 | 8,23 |

P1A impiega meno CPU totale ma la concentra in meno tempo. Dettaglio CPU P1A:
applicazione 535,470 CPU-s (88,21% medio), PG 509,305 (83,90%), OpenSearch 225,321
(37,12%), Redis 5,335 (0,88%). I/O scritto P1A per container: applicazione
933,02 MiB, PG 2811,38, OpenSearch 1154,21, Redis 0,79. L'applicazione scrive più
I/O cgroup che in P0 (517,58 MiB), mentre il totale diminuisce: non si attribuisce
ogni differenza fisica allo scheduler. Campioni includono writeback, profiler e
cache non controllate; non sono byte logici PackStore o banda disco garantita.

### Verifiche P1A su servizi reali

La sonda `scripts/verify-projections.cjs` è stata eseguita dopo il benchmark di
attribuzione, con immagine P1A sul corpus conservato e risultati separati in
`/mnt/sdb/palimora-p1a-validation-clean-20261108/results/`. PostgreSQL, Redis e
OpenSearch sono quelli isolati della fixture; nessun accesso AO3 esterno.

- INSERT `unknown` e UPDATE invariati non accodano; transizioni fra tutti gli
  stati, ritorno a `unknown` e INSERT informativo accodano. Ciclo completo di
  seeding, watchlist prioritaria e nessuna invalidazione residua.
- Disponibilità aggiornata in catalogo e OpenSearch, viste storiche invariate.
  Due race sincronizzate con lock/PUT: cambio disponibilità durante proiezione e
  nuova proiezione durante indicizzazione. Dopo il vecchio ACK la nuova coda
  rimane e il documento aggiornato viene pubblicato. La seconda prova aveva
  fallito prima della correzione di enqueue; l'asserzione non è stata rimossa.
- Pausa/ripresa, retry persistente, errore iniettato, lock fra worker, storico
  mentre il corrente è sotto backpressure. Con soglia 8 e batch 2, nessuna
  crescita incontrollata della coda testo.
- SIGKILL di un processo scheduler realmente bloccato nel catalogo, ripresa con
  concorrenza 1: backlog di prova drenato in **5,016 s**. Intervallo massimo fra
  batch catalogo **236,07 ms**, includendo il servizio dello stadio testo; nessun
  timer obbligatorio di un secondo. Non è una misura end-to-end del corpus.
- Arresto attende il batch atomico; il full-text si ferma dopo il documento
  corrente lasciando il successivo pendente. Modalità normal/light/full verificate.
  A code vuote, 4 chiamate in 180 ms con polling di test 50 ms, poi nessuna dopo
  stop; configurazione con polling zero rifiutata.
- Tutte le **11.032 generazioni** PostgreSQL/OpenSearch confrontate; nessun ID
  mancante o aggiuntivo. Conteggi canonici/outbox e digest di tutte le viste
  storiche invariati dopo le prove.

Build locale completa e immagine API Docker riuscite. Suite mirata:
`ao3-monitor`, `ao3-sync`, `ao3`, `ingest-pipeline`, `archive-native`, `contracts`,
`social`: **16 test passati, 0 falliti, 0 saltati**, PostgreSQL e OpenSearch reali.
Copre anche semantica bibliografica, filtri, snapshot, sincronizzazione e
consumatore notifiche. I test usano schemi isolati ed eliminano i loro dati.

### Latenza interattiva: prova abbinata separata

Dopo il drenaggio, sullo stesso corpus conservato della prova di attribuzione:
prima immagine con timer P0, poi P1A; entrambe con le migrazioni 037–038. In ogni
variante `benchmark-projection-latency.cjs` riusa senza modifiche il probe HTTP P0:
3 warmup e 100 richieste sequenziali per endpoint, HTTP interno autenticato.
Prima code vuote, poi esattamente 1.000 correnti + 1.000 viste storiche riaccodate.
Il backlog è verificato ancora presente alla fine delle richieste. Nessun ingest
o worker AO3 concorrente in questa diagnostica; non sostituisce il benchmark B.

| p95 ms | Timer P0, vuoto | P1A, vuoto | Timer P0, backlog | P1A, backlog |
| --- | ---: | ---: | ---: | ---: |
| Ricerca | 115,19 | 88,08 | 118,16 | 159,92 |
| Dettaglio | 20,17 | 28,32 | 29,62 | 32,91 |
| Lettore | 39,97 | 31,36 | 43,02 | 57,21 |

**Regressione osservata sotto backlog:** ricerca +35,34%, dettaglio +11,10%,
lettore +33,00%. Anche il p95 dettaglio a vuoto aumenta nel campione. Il maggior
lavoro continuo compete con le richieste: non si dichiara una latenza invariata o
un SLO garantito. La singola coppia non separa causalmente rumore/cache e contesa;
restano host condiviso, ordine P0→P1A e cache non controllate. Alla fine delle
richieste P0 aveva ancora 800 correnti/1.000 storici/32 testo; P1A 800/800/10:
la quota storica sta avanzando mentre vengono servite le richieste.
I file completi sono in `/mnt/sdb/palimora-p1a-latency-{p0,new}-20261108/results/`.


### Stato finale P1A

P1A implementata e verificata, con regressioni di latenza interattiva sotto carico
riportate sopra. Restano costi N+1, proiezione bibliografica seriale, PUT individuali
con transazione aperta, invalidazioni del grafo e limiti di scala non affrontati.
P1B e P2 **non implementate**. Nessuna variazione a formati canonici, parser,
semantica bibliografica, versioni storiche, UI o topologia dei servizi.

Container e reti delle fixture P1A rimossi al termine; bind mount e risultati
privati conservati. Nessun servizio Docker estraneo modificato.

## P1B.1a — Tag e associazioni correnti bulk (8 novembre 2026)

Il percorso corrente di `projectCatalog()` usa ora `projectCurrentBibliographies()`:
normalizzazione condivisa con lo storico, prefetch dei tag del gruppo, risoluzione
in memoria delle evidenze nell'ordine originale, upsert collettivo e aggiornamento
differenziale di `catalog_work_tags`. Per un gruppo senza modifiche esplicite al
grafo sono **4 query tag**: lettura, upsert, rimozione delle sole associazioni
assenti, inserimento delle mancanti. Niente `ensureTag()` o INSERT per ogni
associazione in questo percorso; tag e associazioni invariati non vengono riscritti.

Lo staging è un recordset JSON tipizzato in PostgreSQL (`jsonb_to_recordset` e
`INSERT … SELECT`), come nei percorsi bulk di outbox/osservazioni già presenti.
È stata esaminata anche la pipeline COPY binaria di `archive-bulk.ts`: i suoi
slot e vincoli appartengono al commit canonico dell'ingest. Per gruppi limitati
si evita una seconda infrastruttura di staging, DDL temporaneo e protocollo COPY.
Non è stato misurato un confronto JSON/COPY: la scelta è sostenuta dalle misure
del percorso implementato, non da una superiorità generale di JSON.

Identità `(kind,name)`, ID AO3 esistente e prima evidenza non nulla, ultimo
attributo `canonical` non nullo e classificazione degli unclassified mantengono
le regole precedenti. Le righe tag restituite per ciascuna opera sono copie delle
evidenze visibili a quel punto, anche quando opere successive cambiano attributi.
Le opere con `synonym_of`, `meta_tags` o `parents` delimitano i gruppi: ricevono
prima tutti i propri tag sorgente, poi eseguono **lo stesso `tagEdges()`** e infine
la proiezione. Non si anticipano evidenze future al risolutore degli archi. Questi
casi conservano query aggiuntive proporzionali al grafo; non sono P1B.2.

Restano il lock bibliografico globale, la transazione del batch, i lock delle code
e gli ACK/generazioni P1A. Un errore annulla l'intero batch; nessun catalogo
parziale diventa visibile. Il limite corrente resta configurabile attraverso lo
scheduler P1A, default **20**. Nessuna migrazione necessaria: vincoli, tabelle e
code esistenti bastano. Entità, filtri ricorsivi, documenti e proiezione storica
conservano la loro implementazione; lo storico usa la stessa normalizzazione.

### Misura circoscritta su dati reali

`scripts/benchmark-tags.cjs` usa le prime **1.024 opere per ID** del corpus reale
P1A conservato: **8.294 tag distinti, 16.103 associazioni**, nessun arco esplicito
in questo campione. PostgreSQL 17.6 reale, rete interna senza porte host; database
copiato a freddo dalla fixture P1A, PackStore montato in sola lettura. Immagine P1A
originale contro stessa immagine con il nuovo JavaScript compilato. Per ciascuna
variante/dimensione: tabelle **logged** isolate con gli stessi indici/vincoli unici,
prima popolazione e poi riproiezione identica. Le FK sono verificate separatamente
nelle prove sul catalogo reale, non copiate da `LIKE INCLUDING ALL` nel benchmark.

Preparazione, lettura manifest e arricchimento sono identici e fuori dal timer.
Nel percorso P1A una sentinella JavaScript interrompe la funzione subito prima
della prima query delle entità, senza errore PostgreSQL: si misura esattamente
la fase tag. Nel nuovo percorso si chiama la stessa funzione bulk integrata nel
catalogo. BEGIN, lock e COMMIT sono inclusi in tempo e conteggio query. Singola
esecuzione seriale P1A→nuovo, host condiviso e cache non controllate: nessun
intervallo di confidenza o estrapolazione end-to-end.

| Batch | Fase | P1A s | P1B.1a s | Query P1A → nuove | Query/opera P1A → nuove |
| --- | --- | ---: | ---: | ---: | ---: |
| 20 | Prima popolazione | 13,766 | 1,573 | 34.410 → 364 | 33,604 → 0,355 |
| 20 | Riproiezione | 14,552 | 1,136 | 34.410 → 364 | 33,604 → 0,355 |
| 64 | Prima popolazione | 12,761 | 1,163 | 34.302 → 112 | 33,498 → 0,109 |
| 64 | Riproiezione | 16,768 | 0,877 | 34.302 → 112 | 33,498 → 0,109 |
| 256 | Prima popolazione | 15,840 | 0,938 | 34.266 → 28 | 33,463 → 0,027 |
| 256 | Riproiezione | 15,858 | 0,554 | 34.266 → 28 | 33,463 → 0,027 |

Al default 20 la fase tag accelera **8,75×** alla prima popolazione e **12,81×**
alla riproiezione; query −98,94%. Escludendo le 3 query di transazione/lock per
batch: **33,451 → 0,203 query tag/opera**, 34.254 → 208. I commit sono 52/16/4,
invariati fra implementazioni. Upsert con righe effettivamente scritte:
16.103 → 8.294 alla prima popolazione, 16.103 → **0** alla riproiezione.
Associazioni finali sempre 16.103; rimozioni alla riproiezione 16.103 → **0**.
Questi numeri riguardano la fase tag, non tutte le query di `projectCatalog()`.

| Batch 20 | P1A | P1B.1a |
| --- | ---: | ---: |
| WAL prima popolazione, byte | 17.712.784 | 16.316.320 |
| WAL riproiezione, byte | 16.265.824 | 733.000 |
| CPU Node prima popolazione, CPU-s | 5,424 | 0,539 |
| CPU Node riproiezione, CPU-s | 5,250 | 0,506 |
| RSS Node a fine prima popolazione, MiB | 146,96 | 140,94 |
| RSS Node a fine riproiezione, MiB | 158,44 | 140,70 |

WAL = differenza di LSN di inserimento, include eventuale attività di fondo della
fixture; non è I/O fisico. Il WAL residuo senza righe cambiate comprende anche
lock di righe/conflitti e commit. Lo stesso sampler cgroup P0, senza modifiche,
ha coperto **preparazione + tutte le sei fasi**, quindi un intervallo più ampio
dei timer precedenti: CPU worker 40,377 → 9,126 CPU-s, PG 58,832 → 7,899 CPU-s;
picco working set worker 112,36 → 102,59 MiB, PG 89,94 → 94,92 MiB. PG scrive
106,02 → 26,34 MiB; letture fisiche pressoché nulle (cache). Non sommare picchi
non contemporanei o confrontare working set cgroup con RSS Node. Le dimensioni
maggiori migliorano questa misura, ma il default non aumenta: lock più lunghi e
latenza interattiva richiedono la futura campagna completa.

Risultati aggregati: `docs/performance-p1b1a.json`; evidenze private in
`/mnt/sdb/palimora-p1b1a-results/`. Le baseline P0/P1A restano inalterate.

### Equivalenza e verifiche

Conservato e riutilizzato `scripts/compare-bibliography.cjs`: confronto per ID e
hash dei **valori normalizzati**, non solo conteggi. Cattura P1A sulla copia
isolata; riproiezione corrente integrata di tutte le **11.032 opere**, poi
indicizzazione ordinaria e drenaggio delle code. Risultato: **zero aggiunte,
rimozioni o differenze** per identità, snapshot, documenti, viste storiche,
tag/attributi, entità, archi, associazioni e filtri. Confrontate 57.661 identità tag,
167.736 associazioni opera-tag e 167.736 filtri; tutte le 11.032 viste storiche
rimangono identiche. Solo gli array semanticamente insiemistici sono ordinati nel
confronto; generazioni e timestamp di indicizzazione non sono usati come prova di
equivalenza bibliografica. Separatamente, OpenSearch reale contiene esattamente
le **11.032 coppie ID/generazione** attese da PostgreSQL.

`scripts/verify-bulk-tags.cjs` confronta anche il percorso P1A conservato con
quello bulk, dentro transazioni annullate, sulle tabelle reali con FK. Copre tag
condivisi, aggiornamento canonical e ID mancanti, conflitti di ID, nomi ambigui
fra categorie, duplicati, evidenze introdotte da opere successive, sinonimi,
meta-tag e parent. Confronta risultati, attributi, associazioni, filtri e archi;
verifica `xmin/ctid` invariati delle associazioni in una riproiezione identica e
rimozione effettiva quando i tag scompaiono. Conflitto di unicità e terminazione
del backend **dopo le scritture bulk, prima del commit**: rollback e successivo
retry verificati senza tag residui.

La sonda P1A `verify-projections.cjs`, riusata senza modifiche, passa con il nuovo
catalogo: invalidazioni durante proiezione e PUT sopravvivono agli ACK, seeding,
pausa/ripresa, retry, lock fra worker, fairness storica, manutenzione, stop atomico
e SIGKILL/ripresa dello scheduler. Code vuote e 11.032 generazioni ricontrollate
alla fine. Queste sono prove funzionali, non misure end-to-end comparabili a B.
Build completa riuscita (warning Vite sui chunk grandi); `tests/ao3.test.ts` su
PostgreSQL/OpenSearch reali: **2 passati, 0 falliti, 0 saltati**, inclusi ricerca,
wrangling, bibliografia, lettura e snapshot canonici. Controlli di sintassi,
formattazione del codice e `git diff --check` riusciti.

**P1B.1a completata. P1B.1 complessiva rimane incompleta.** Rimangono N+1 di
entità, lookup/lettura manifest, filtri ricorsivi per opera, documenti e storico;
il grafo conserva il costo e le invalidazioni precedenti. Nessuna conclusione
sul nuovo throughput end-to-end o sulle latenze interattive: non misurati in
questa fase. Non sono state avviate P1B.1b–d, P1B.2 o P2. Fixture isolate rimosse
al termine, bind mount ed evidenze conservati; nessun servizio estraneo cambiato.

## P1B.1b — Bibliografia corrente, filtri e documenti bulk (8 novembre 2026)

La pipeline corrente estende i gruppi P1B.1a senza cambiare il bulk dei tag o le
barriere delle opere che modificano il grafo. `projectEntityBatch()` prepara
identità e fatti con la stessa normalizzazione usata dal percorso storico:
ultimo nome, ultimo URL non nullo, merge superficiale dei dettagli nell'ordine
originale; i valori annidati sono sostituiti interamente come con `jsonb ||`.
Le entità nei documenti delle singole opere conservano le proprie evidenze,
mentre la riga condivisa riceve la fusione ordinata. Restano deduzione dagli URL
AO3, pseudonimi/owner, identità locali per opera, posizioni, relazioni e anonimato.
Gli autori anonimi possono conservare evidenze globali, ma non associazioni o
esposizione nel documento dell'opera, come prima.

Tre query per gruppo gestiscono upsert delle entità e differenze delle
associazioni. `projectFilterBatch()` usa una CTE ricorsiva su **(work_id,tag_id)**,
con UNION per deduplicare, attraversando synonym/meta e mantenendo le opere
separate. Altre due query applicano solo le differenze di `catalog_work_filters`.
Le barriere P1B.1a impediscono che un cambiamento successivo del grafo alteri la
chiusura catturata per un'opera precedente. Nessuna modifica a `tagEdges()` o
all'invalidazione globale.

Il catalogo idrata i metadata una sola volta, valida collettivamente gli snapshot
correnti e le identità canoniche/alias, poi recupera manifest e HTML con lookup
collettivi. Il ponte `readObjectBatches()` riusa `PackStore.readMany()` senza
cambiare PackStore: stesso flush/seal dei writer e lock condiviso contro GC,
verifica di ogni oggetto, massimo 256 oggetti/16 MiB raw per lettura, salvo un
singolo oggetto già più grande. Non conserva tutti i buffer HTML del batch:
conserva le evidenze estratte, riapplicate nell'ordine degli oggetti del manifest.
Oggetti condivisi sono letti/analizzati una volta per gruppo. La normalizzazione
e l'estrazione restano uniche; lo storico conserva query e ciclo precedenti.

Availability AO3: un prefetch per batch. Documenti: preparazione in memoria e
un upsert `INSERT … SELECT`, evitando UPDATE e modifica di `indexed_at` quando
la riga è identica. L'algoritmo di generazione resta SHA-256 dello stesso JSON;
i filterTags, insieme semantico prima restituito da SQL senza ORDER BY, sono ora
ordinati per ID. Una riproiezione dopo l'upgrade può quindi cambiare generazione
solo per quell'ordine; la nuova generazione rimane stabile al variare del batch.
Il documento e la sua generazione vengono sempre indicizzati insieme attraverso
il protocollo P1A esistente. Conservati lock globale bibliografico, lock delle
code, transazione e ACK; nessuna migrazione necessaria. Nessun riuso full-text.

Una sonda in sola lettura sulla vecchia query, forzando join diversi, ha
restituito gli stessi **42 tag in ordini differenti**: l'instabilità precedente
è verificata, non ipotizzata. Il test nuovo verifica anche generazioni identiche
proiettando lo stesso gruppo insieme e un'opera alla volta.

### Benchmark circoscritto e attribuzione

`scripts/benchmark-current.cjs`, PostgreSQL 17.6 reale, copia a freddo della fixture
P1B.1a e PackStore in sola lettura. **1.024 opere reali** selezionate per ID:
2.215 entità, 2.305 associazioni opera-entità, 16.103 filtri e 1.024 documenti.
Sette tabelle catalogo isolate **logged**, indici/unicità copiati; FK verificate
separatamente sul catalogo effettivo. Prima popolazione e riproiezione identica.
Baseline compilata P1B.1a contro nuovo codice nella stessa immagine runtime.
Worker riavviati prima della coppia finale per escludere memoria residua dei test;
esecuzioni seriali senza altre prove concorrenti. Default batch invariato: 20.

Entrambi includono **idratazione, lettura/verifica manifest e HTML, arricchimento,
tag, entità, filtri, availability e documenti**, oltre a BEGIN con
`SET LOCAL default_toast_compression=lz4`, lock e COMMIT come in produzione.
Non si confrontano questi tempi con il timer dei soli tag della fase precedente.
Il runner usa le funzioni di fase della pipeline; nella baseline intercetta
l'inizio della query ricorsiva per separare entità/filtri, senza saltare SQL.
Per entrambe le varianti i documenti sono scritti dopo la preparazione del gruppo.
Il campione non contiene modifiche esplicite al grafo (asserito); la normale
integrazione `projectCatalog()` è verificata separatamente sul corpus completo.
Fuori dai timer: setup, conteggi, queue/ACK, scheduler, storico, ingest e ricerca.
Una prova per caso finale, host condiviso e cache non controllate: nessun
intervallo di confidenza o accelerazione end-to-end dichiarata.

Per riprodurre: compilare il commit baseline e il nuovo codice in due directory
`dist`, montate sulla stessa immagine API insieme a `scripts`, fixture `_test`,
PackStore `/benchmark` in sola lettura e output `/results`. Eseguire in processi
separati `node scripts/benchmark-current.cjs old` e `new`, dopo il riavvio dei
worker; campionare con `benchmark-resources.py` e aggregare con
`summarize-resources.py`. Il runner crea e rimuove da solo gli schemi di misura.
Il baseline compilato usato resta in `/mnt/sdb/palimora-p1b1b-old-dist/`.

Le due esplorazioni precedenti sono conservate privatamente: una senza il SET
LZ4 e una con cgroup non ripuliti (circa 75 MiB residui nel worker nuovo contro 4
nella baseline). Le tabelle seguenti usano soltanto la coppia finale allineata;
non si attribuiscono al codice le differenze fra queste diverse condizioni.

| Batch | Fase | P1B.1a s | P1B.1b s | Fattore | Query totali prima → dopo | Query/opera prima → dopo |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 20 | Iniziale | 12,859 | 4,366 | 2,95× | 19.453 → 1.197 | 18,997 → 1,169 |
| 20 | Ripetuta | 13,958 | 3,415 | 4,09× | 19.452 → 1.196 | 18,996 → 1,168 |
| 64 | Iniziale | 11,170 | 2,413 | 4,63× | 19.092 → 368 | 18,645 → 0,359 |
| 64 | Ripetuta | 11,882 | 1,939 | 6,13× | 19.092 → 368 | 18,645 → 0,359 |
| 256 | Iniziale | 11,305 | 2,183 | 5,18× | 18.972 → 92 | 18,527 → 0,090 |
| 256 | Ripetuta | 12,309 | 1,733 | 7,10× | 18.972 → 92 | 18,527 → 0,090 |

Transazioni/commit invariati: 52/16/4. Il nuovo percorso usa 23 query per gruppo
ordinario nel campione, più una prima lettura del dizionario non in cache;
non dipendono dal numero di entità o associazioni. Incluse le query tag invariate.

| Fase, batch 20 | Iniziale prima → dopo, s | Ripetuta prima → dopo, s | Query iniziali prima → dopo |
| --- | ---: | ---: | ---: |
| Lookup/manifest/HTML/arricchimento | 5,716 → 1,859 | 5,639 → 1,662 | 8.335 → 417 |
| Tag, invariati | 0,928 → 1,087 | 0,669 → 0,751 | 208 → 208 |
| Entità e associazioni | 1,855 → 0,307 | 1,954 → 0,233 | 5.634 → 156 |
| Filtri | 3,040 → 0,436 | 4,240 → 0,290 | 3.072 → 156 |
| Availability/documenti | 1,110 → 0,450 | 1,278 → 0,373 | 2.048 → 104 |
| Transazione/lock/commit | 0,210 → 0,227 | 0,178 → 0,107 | 156 → 156 |

Upsert entità con righe realmente scritte: 2.305 → 2.215 iniziali e 2.305 → **0**
ripetute. Nella riproiezione nuova: **zero** inserimenti/rimozioni/aggiornamenti
nelle associazioni, nei filtri e nei documenti. Baseline: 2.305 associazioni e
16.103 filtri rimossi/reinseriti, 1.024 documenti aggiornati. Conteggi finali uguali.

### WAL e risorse

| Batch | WAL iniziale prima → dopo, byte | WAL ripetuto prima → dopo, byte |
| --- | ---: | ---: |
| 20 | 36.309.488 → 35.393.208 | 24.496.024 → 1.048.936 |
| 64 | 40.026.968 → 35.282.672 | 19.676.912 → 977.528 |
| 256 | 36.190.960 → 35.124.648 | 24.744.792 → 884.976 |

Al default il WAL cambia del **-2,52%** iniziale e
**-95,72%** ripetuto. LSN globali della fixture, non I/O fisico;
checkpoint/full-page images e attività di fondo non separati. Anche conflitti,
lock e commit possono produrre WAL senza UPDATE di righe. Nella prima esplorazione
non allineata il WAL iniziale aumentava: non si dichiara un risparmio garantito.

CPU Node batch 20: 5,964 → 2,684 CPU-s iniziali,
5,426 → 2,349 ripetuti. RSS Node a fine fase iniziale
142,77 → 151,95 MiB; ripetuta 159,38 → 156,67 MiB.
A batch 256 il nuovo RSS arriva a 197,78 MiB contro
160,57: la dimensione maggiore ha un costo di memoria.

Sampler cgroup P0 invariato: sei casi **con setup/teardown**, finestra più ampia
dei timer. Working set medio/massimo; non confondere con RSS o sommare picchi
non contemporanei. I contatori I/O sono fisici, non byte logici PackStore;
includono writeback, quindi non si attribuisce tutto il delta alle sole query
modificate.

| Risorsa | P1B.1a | P1B.1b |
| --- | ---: | ---: |
| CPU worker, CPU-s | 30,942 | 10,227 |
| CPU PostgreSQL, CPU-s | 45,199 | 7,330 |
| Working set worker medio / massimo, MiB | 100,91 / 110,86 | 99,08 / 135,02 |
| Working set PostgreSQL medio / massimo, MiB | 175,70 / 182,83 | 176,96 / 194,95 |
| I/O worker letto / scritto, MiB | non disponibile | non disponibile |
| I/O PostgreSQL letto / scritto, MiB | 0,00 / 286,12 | 0,00 / 57,37 |

**Costo residuo maggiore al default:** lookup/manifest/HTML/arricchimento
1,859 s (42,6% dell'iniziale) e
1,662 s (48,7% del ripetuto);
i tag invariati pesano 1,087/0,751 s.
Sono fasi aggregate: non si attribuisce tutto il residuo alla sola lettura
PackStore o al parser HTML. Storico e PUT OpenSearch non sono in questi timer.

### Equivalenza e conclusione

`compare-bibliography.cjs` invariato, riferimento catturato con il codice P1B.1a:
**zero differenze** nei valori normalizzati e nelle relazioni di **11.032 opere**,
11.032 snapshot/viste storiche, **22.140 entità**, **24.909 associazioni opera-entità**,
57.661 tag, 167.736 associazioni opera-tag e **167.736 filtri**. Documenti,
metadata e identità equivalenti. Il runner integrato ha proiettato e indicizzato
tutte le opere e verificato tutte le 11.032 coppie ID/generazione OpenSearch;
code drenate, storico immutato.

`verify-current.cjs` confronta anche fixture ordinate con P1B.1a: merge/precedenze
condivise, statistiche annidate, URL, posizioni, anonimato, pseudonimi, identità
locali, relazioni e chiusure transitive separate per opera; modifiche del grafo
fra gruppi, rimozioni e aggiornamenti, conflitto di unicità, rollback/retry.
Verificati xmin/ctid invariati per associazioni, filtri e documenti riproiettati;
snapshot estranei rifiutati, alias validi accettati e oggetti mancanti segnalati.
`verify-bulk-tags.cjs` e `verify-projections.cjs` P1A/P1B.1a passano invariati,
comprese invalidazioni concorrenti, pausa, backpressure, crash, stop e generazioni.

Build completa riuscita (warning Vite sui chunk grandi); suite reali
`archive-native`, `archive`, `ao3`: **8 test passati, 0 falliti, 0 saltati** nelle
esecuzioni finali. Coperti integrità PackStore, commit, dedup, lettura/export e
snapshot storici/on-demand. Per l'integrazione sono necessari OpenSearch e
`TYPST_PATH` al binario runtime: i tentativi iniziali senza queste impostazioni
fallivano per configurazione; log conservati, nessuna asserzione rimossa.

**P1B.1b completata; P1B.1 complessiva resta incompleta.** Restano costo del grafo,
storico opera-per-opera e PUT individuali. Nessuna misura end-to-end o di latenza
interattiva in questa fase. Nessuna implementazione P1B.1c/d, P1B.2 o P2.
Dati aggregati: `docs/performance-p1b1b.json`; evidenze private:
`/mnt/sdb/palimora-p1b1b-results/`. Baseline precedenti conservate. Fixture isolate
rimosse al termine, bind mount conservati; nessun servizio estraneo modificato.

## P1B.1c — materializzazione storica bulk (2026-11-08)

Riferimento: P1B.1b `d5fcde3837890cd82aa52dc80f2e8afb2b437c10`.
**P1B.1c completata**, limitatamente allo storico; P1B.1d, P1B.2 e P2 non avviate.
Baseline precedenti e strumenti di confronto conservati.

### Percorso integrato e semantica

`projectCatalog()` acquisisce il gruppo storico dalla coda persistente e chiama
`materializeHistoricalViews()`: verifica collettiva delle viste già presenti,
lookup degli snapshot mancanti, manifest verificati con `readObjectBatches()`,
HTML condiviso con `enrichBibliographyBatch()`, normalizzazione comune, dizionari
bulk, chiusura ricorsiva per opera, un INSERT set-based delle viste e un ACK
collettivo. Le letture condivise sono deduplicate. Nessun parser, formato o
motore di catalogazione aggiuntivo; nessuna migrazione necessaria.

Le componenti P1B.1a/b sono estese con modalità storica: i tag generici conservano
gli attributi già noti; gli attributi/archi dei tag sorgente non sono applicati,
come nel vecchio storico. Le entità esistenti usano `DO NOTHING`; per una nuova
identità vince la **prima evidenza nell'ordine del gruppo**, senza il merge usato
in modalità corrente. Nessuna modifica alle associazioni, ai filtri o ai
documenti correnti, né alle generazioni OpenSearch. La chiusura storica conserva
la particolarità preesistente: usa associazioni **correnti** e grafo attuale;
`filterTags` è restituito ma non salvato nella bibliografia della vista.
Non viene reinterpretato il grafo storico.

Rimangono lock bibliografico globale, lock di coda e transazione di produzione;
INSERT e ACK sono atomici, un errore annulla l'intero gruppo. Dopo il lock si
ricontrollano le viste già materializzate, senza sovrascriverle. Il background e
il lettore esplicito usano lo stesso materializzatore; il lettore riutilizza il
manifest già verificato da `loadSnapshot()`. Il limite esistente
`PROJECTION_HISTORICAL_BATCH` resta 20, configurabile fino a 256. Le letture
PackStore mantengono il limite esistente di 256 oggetti / 16 MiB raw per gruppo,
salvo un singolo oggetto più grande; metadata e oggetti parsati restano limitati
al batch di snapshot. Nessuna modifica allo scheduler.

**Divergenza preesistente esplicitata:** il fallback del lettore per snapshot
esplicito non persisteva la vista e, passando tramite alias canonico, poteva
calcolare gli ID delle entità locali dal contesto dell'opera richiesta; il
background usava invece l'opera proprietaria dello snapshot. La prima risposta
non materializzata poteva quindi differire da quella successiva. Ora il lettore
esplicito persiste una sola vista con il proprietario dello snapshot, come il
background: necessario per l'identità del risultato concorrente. Il test
riproduce la differenza con P1B.1b. Nessuna vista esistente viene riscritta,
nessuna identità canonica modificata; il fallback senza snapshot esplicito
continua a non salvare metadata correnti come vista storica.

### Equivalenza e recupero

Il confronto invariato `compare-bibliography.cjs` è stato eseguito sul corpus
reale completo: riferimento P1B.1b, rigenerazione precedente e rigenerazione
bulk, sempre contro lo stesso riferimento. **Zero valori o relazioni aggiunti,
rimossi o cambiati**: 11.032 opere, 11.032 snapshot e viste storiche, 11.032
documenti, 57.661 tag, 22.140 entità, 167.736 associazioni opera-tag,
24.909 opera-entità e 167.736 filtri. Nel corpus non ci sono archi/alias:
questi casi sono coperti dalla fixture mirata.

`scripts/reproject-history-fixture.cjs` verifica inoltre il fingerprint completo
dei documenti (incluse generazioni e `indexed_at`) e delle associazioni correnti:
immutati dopo entrambe le rigenerazioni; code correnti, storiche e full-text
vuote. Solo viste derivate eliminate nella copia isolata, mai snapshot canonici.
Nessuna reindicizzazione del corpus richiesta o eseguita in questa fase; non si
presenta questa verifica come un nuovo controllo di tutti gli ID OpenSearch.

`scripts/verify-history.cjs` confronta vecchio e nuovo sullo stesso PostgreSQL:
tre versioni con metadata diversi, entità condivise e precedenze, anonimato,
tag storici, chiusura transitiva synonym/meta con ciclo e modifica del grafo,
alias, lettore concorrente col background. Tre manifest e un HTML condiviso
sono letti/verificati una sola volta ciascuno. Verificati vista già presente
immutata (`xmin`/`ctid`), rollback e **SIGKILL dopo INSERT prima di COMMIT/ACK**:
la vista non persiste, la coda resta e il retry completa. Catalogo corrente e
generazioni invariati. Build completa riuscita (warning Vite sui chunk grandi);
suite `archive-native`, `archive`, `ao3`: **8 passati, 0 falliti, 0 saltati**, con
PostgreSQL/OpenSearch reali e Typst runtime, inclusi ricerca, lettore e integrità.

### Benchmark circoscritto riproducibile

`scripts/benchmark-history.cjs` esegue **il vero `projectCatalog(0,batch)`** su
1.024 snapshot reali ordinati per ID, stessa copia PostgreSQL 17.6 e PackStore
montato in sola lettura. Sei tabelle shadow **logged**, indici/unicità conservati,
dizionari completi copiati per ogni coppia; associazioni correnti reali in sola
lettura. Vincoli FK verificati separatamente nella fixture migrata completa.
Inclusi entrambi i percorsi: coda, lookup canonici, manifest/HTML, arricchimento,
tag/entità, chiusura, INSERT, ACK, transazione/commit e impostazione LZ4.
Esclusi setup/teardown e controlli esterni al timer. La rigenerazione elimina
soltanto viste derivate e riaccoda gli stessi ID: **non è una prova di cache hit**.

Una coppia per caso, baseline prima, worker riavviati prima della coppia finale;
nessun build/test concorrente, cache del sistema non svuotata. Nessun intervallo
di confidenza o attribuzione end-to-end. La sessione privata conserva anche le
prove preliminari escluse: prima della strumentazione I/O definitiva e del riuso
del manifest verificato; primo pilot di contesa sovrapposto al build e senza
ANALYZE delle copie. La contesa finale usa ANALYZE per entrambi, senza build.

| Batch | Fase | P1B.1b s → P1B.1c s | Snapshot/s prima → dopo | Fattore | Query prima → dopo | Query/snapshot prima → dopo |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 20 | Iniziale | 19,127 → 3,381 | 53,54 → 302,87 | 5,66× | 27.795 → 1.040 | 27,144 → 1,016 |
| 20 | Rigenerata | 14,120 → 2,901 | 72,52 → 352,98 | 4,87× | 27.795 → 1.040 | 27,144 → 1,016 |
| 64 | Iniziale | 18,891 → 2,041 | 54,21 → 501,64 | 9,25× | 27.579 → 320 | 26,933 → 0,313 |
| 64 | Rigenerata | 21,667 → 2,135 | 47,26 → 479,73 | 10,15× | 27.579 → 320 | 26,933 → 0,313 |
| 256 | Iniziale | 14,941 → 1,396 | 68,54 → 733,69 | 10,71× | 27.507 → 80 | 26,862 → 0,078 |
| 256 | Rigenerata | 11,978 → 1,353 | 85,49 → 756,73 | 8,85× | 27.507 → 80 | 26,862 → 0,078 |

Transazioni/commit invariati: **52 / 16 / 4**. Sempre 1.024 viste inserite;
**20 query client per batch** nel percorso nuovo misurato, compresi i comandi
transazionali. Le query corrispondono a round-trip client, non a statement
interni PostgreSQL. Riduzione al default: **96,26%**.

| Attribuzione, iniziale batch 20 | P1B.1b s | P1B.1c s |
| --- | ---: | ---: |
| Bibliografia inclusiva (normalizzazione/dizionari/chiusura) | 14,151 | 1,394 |
| Arricchimento inclusivo delle letture HTML | 2,079 | 0,778 |
| PackStore inclusivo delle decompressioni, manifest + HTML | 1,431 | 0,896 |
| Somma durate native delle decompressioni | 0,251 | 0,194 |
| SQL tag | 11,598 | 0,954 |
| SQL entità | 0,643 | 0,080 |
| SQL chiusure | 0,908 | 0,090 |
| SQL INSERT viste | 0,592 | 0,201 |
| Altre query SQL | 2,676 | 0,566 |

**Queste righe non sono additive:** SQL e letture sono annidati nei tempi
inclusivi; le durate native possono sovrapporsi fra lane. Il totale autorevole
è il timer della materializzazione. Residui al default: bibliografia inclusiva
1,394 s (41,2% del totale), di cui tag SQL 0,954 s; arricchimento 0,778 s (23,0%).
Il lock globale continua a serializzare il catalogo.

PackStore al default: chiamate `readMany` **2.048 → 104**, file aperti
**2.048 → 1.696**, letture file **4.096 → 3.737**. Byte logici letti
**3.443.100 → 3.752.086**, aumentati per gli intervalli accorpati dalle API
esistenti. Oggetti decompressi **2.048 → 2.048**, 6.147.887 byte raw: il campione
non ha hash condivisi da eliminare. Chiamate codec 2.048 → 2.041; nessun credito
per decompressioni risparmiate sul corpus. A batch 64/256 i file aperti scendono
a 1.104/374. Deduplicazione effettiva provata nella fixture multiversione.

### WAL, CPU, memoria e I/O

| Batch | WAL iniziale prima → dopo, byte | WAL rigenerato prima → dopo, byte |
| --- | ---: | ---: |
| 20 | 9.916.288 → 4.869.296 | 32.469.304 → 4.869.832 |
| 64 | 10.507.992 → 4.800.152 | 8.423.288 → 4.800.512 |
| 256 | 13.025.208 → 4.711.568 | 9.124.488 → 4.711.888 |

LSN globali della fixture, sensibili a checkpoint/FPI e attività di fondo;
il picco precedente nella rigenerazione batch 20 non è un costo garantito.
CPU Node al default: **7,336 → 2,462 CPU-s** iniziali e **5,912 → 1,989** rigenerate.
RSS a fine fase: **142,28 → 143,79 MiB** iniziali, **163,83 → 147,21** rigenerate.
A batch 256 RSS cresce da **156,97/157,29 a 180,47/183,79 MiB**: non si aumenta
il default sulla base del solo throughput.

Sampler cgroup P0 invariato, tutte le sei prove **inclusi setup/teardown**,
finestra 107,01 s prima e 20,00 s dopo. Working set non equivalente a RSS;
picchi di processi distinti non vanno sommati.

| Risorsa | P1B.1b | P1B.1c |
| --- | ---: | ---: |
| CPU worker, CPU-s | 38,047 | 9,984 |
| CPU PostgreSQL, CPU-s | 71,254 | 11,073 |
| Working set worker medio / massimo, MiB | 99,30 / 113,72 | 94,47 / 140,96 |
| Working set PostgreSQL medio / massimo, MiB | 181,21 / 197,46 | 184,74 / 201,03 |
| I/O fisico worker letto / scritto | non disponibile | non disponibile |
| I/O fisico PostgreSQL letto / scritto, MiB | 0,00 / 191,78 | 0,00 / 289,03 |

Le scritture fisiche PostgreSQL **aumentano nella finestra misurata**, pur con
meno WAL nei timer. Includono setup, checkpoint e writeback, non isolati per
fase: non si dichiara un miglioramento I/O né si attribuisce tutto il delta al
codice. I byte logici PackStore non sono letture fisiche del disco.

### Interazione mirata con il catalogo corrente

`probe-history-contention.cjs`: 256 opere correnti, sole oppure insieme a 256
snapshot storici, batch 20+20 nella stessa transazione come nel projector reale,
13 commit. Code entrambe drenate e 256 invalidazioni full-text preservate.

| Scenario | Durata P1B.1b → P1B.1c, s | P95 batch P1B.1b → P1B.1c, ms |
| --- | ---: | ---: |
| Solo corrente | 1,196 → 1,294 | 136,79 → 180,78 |
| Corrente + storico | 5,759 → 1,832 | 680,46 → 185,98 |

Costo aggiuntivo del backlog storico in questa prova: **4,563 → 0,538 s**.
Il controllo solo corrente è **8,17% più lento** nella nuova esecuzione: una
singola coppia non ne isola la causa. P95 di soli 13 batch, coincidente col
massimo: **non è latenza HTTP/interattiva** e non sostituisce P1B.1d.

Riproduzione: compilare il riferimento e il codice nuovo nelle rispettive
`apps/api/dist` di due worker sul database isolato con `DATABASE_URL` terminante
in `_test`, `ARCHIVE_ROOT=/benchmark/main` e `/results` privato; usare le API
native della stessa immagine runtime. Eseguire in sequenza
`node scripts/benchmark-history.cjs old` / `new`, campionando ciascuna sessione
con `benchmark-resources.py` e aggregando con `summarize-resources.py`.
Per il confronto completo: `compare-bibliography.cjs capture`, poi
`reproject-history-fixture.cjs old` / `new`, ciascuno seguito da
`compare-bibliography.cjs compare` contro la cattura originale.
`verify-history.cjs` richiede anche il riferimento compilato in
`apps/api/old-dist`; `probe-history-contention.cjs old` / `new` esegue la prova
mista senza ingest o indicizzazione. Nessuno di questi runner va eseguito su
produzione. Percorsi, misure complete e limiti in `performance-p1b1c.json`;
evidenze private in `/mnt/sdb/palimora-p1b1c-results/`, riferimento compilato in
`/mnt/sdb/palimora-p1b1c-old-dist/`. Container/rete della fixture rimossi al
termine, bind mount conservati. Nessun servizio di produzione modificato.

## P1B.1d — integrazione e campagne complete (2026-11-08)

Codice applicativo misurato: `c3dcb57118d19e8aeabaa70da1b21e29629c8486`.
Le tre trasformazioni bibliografiche sono integrate nel normale `projectCatalog`:
normalizzazione comune, tag/entità bulk, filtri per opera, documenti correnti e
viste storiche collettivi. Storico e corrente conservano le rispettive precedenze;
il lettore esplicito usa lo stesso materializzatore storico. Nessuna nuova
architettura, modifica al parser/PackStore, al grafo, allo scheduler o a OpenSearch.

Le sonde SQL sul nuovo runtime registrano **zero INSERT individuali** per tag,
entità, associazioni opera-tag/opera-entità e viste; il profiler registra zero
chiamate al vecchio `projectBibliography` nella proiezione normale. Le barriere
ordinate per modifiche del grafo e `tagEdges()` rimangono intenzionalmente: questo
corpus non ha archi e non misura il loro costo su un grafo popolato.

### Metodo e confini

Riutilizzati `benchmark-p0.sh`, `benchmark-release.cjs`, runner operativo,
profiler P0, sampler cgroup e verificatore HTTP. Aggiunto un preload opzionale
`performance-bibliography-profiler.cjs`: separa le sezioni corrente/storica
all'interno del batch e aggrega tempi SQL/arricchimento/lock, senza salvare
parametri o contenuti. Il runner accetta `BENCH_NODE_OPTIONS`, vuoto per default.
Il verificatore conserva tutti i controlli precedenti e aggiunge **11.032
corrispondenze di generazione** e conteggio delle viste storiche prima di fermare
il timer: verifica più forte, nessuna condizione rimossa. Il checksum iniziale
del setup A precede il rafforzamento del verificatore, caricato solo dopo la
proiezione: hash finali separati e output della verifica attestano il codice
effettivamente eseguito; il manifest iniziale è conservato.

Stesso ZIP `queue119_archive05.zip`, SHA-256
`fd8e01e155c1a668c91bd86bc67cfc9b2ac3ad9da1322a35925a74c226e85429`,
11.032 EPUB; parser 2 / commit 2, gruppo ingest 256, Zstd 3, PostgreSQL 17.6,
Redis 7.4.6, OpenSearch 2.19.4 heap 1 GiB. Batch di produzione invariati 20/20/16.
Fixture nuove sullo stesso disco, rete interna senza porte host, dump read-only,
nessuna quota CPU/RAM (verificata anche via Docker inspect). Fsync,
synchronous_commit e full_page_writes attivi. Build finita prima dei benchmark;
A, B e C sequenziali, senza altri benchmark concorrenti. Restano host condiviso,
cache non svuotate e una passata A/B: nessuna garanzia statistica o SLO.

### A — pipeline sequenziale

| Fase | P0 A2, s | P1B.1, s | P1B.1 opere/s |
| --- | ---: | ---: | ---: |
| Ingest canonico | 51,117 | 48,271 | 228,54 |
| Catalogo corrente + storico | 413,530 | 85,627 | 128,84 |
| Corrente, quota interna al catalogo | non separata | 52,449 | 210,34 |
| Storico, quota interna al catalogo | non separata | 32,577 | 338,65 |
| Full-text | 386,423 | 357,110 | 30,89 |
| Refresh e verifica finale | 5,317 | 6,899 | 1.599,03 |
| **End-to-end ricercabile** | **869,978** | **511,889** | **21,552** |

A conserva il drenaggio diretto dei processori dopo ingest e prima del full-text;
corrente e storico sono quote dello stesso batch normale, non due esperimenti
indipendenti. La strumentazione separa acquisizione corrente fino alla selezione
storica, quindi storico fino al commit; coordinamento iniziale circa 0,592 s.
Le quote non si aggiungono di nuovo al totale catalogo. Avvii, probe e verifica
sono inclusi nel tempo end-to-end, esclusi dai timer dei singoli motori.

**−41,16% end-to-end / 1,700× throughput** rispetto ad A2. Catalogo **4,829×**;
query catalogo **862.392 → 23.194**, **78,172 → 2,102/opera**. Nel nuovo percorso:
42 query per batch ordinario corrente+storico; 553 transazioni catalogo incluso
l'ultimo controllo vuoto. Full-text: 247.499 query, 11.032 PUT. Le variazioni di
ingest e full-text non sono presentate come riscritture di quei motori.

### B — runtime operativo e riepilogo P0 / P1A / P1B.1

| Metrica, scenario B | P0 | P1A | P1B.1 |
| --- | ---: | ---: | ---: |
| Tempo end-to-end, s | 1.474,721 | 602,783 | **434,043** |
| Opere/s end-to-end | 7,481 | 18,302 | **25,417** |
| Tempo catalogo corrente, s attivi | non separato | non separato | 75,322 |
| Tempo storico, s attivi | non separato | non separato | 50,103 |
| Catalogo corrente + storico, s attivi | 790,891 | 581,222 | 127,028 |
| Tempo full-text, s attivi | 695,075 | 464,166 | 411,849 |
| Query SQL client catalogo | 1.179.090 | 859.731 | **27.229** |
| CPU totale campionata, CPU-s | 1.851,926 | 1.275,433 | 804,125 |
| RAM working set massima simultanea, MiB | 3.629,10 | 3.154,32 | 3.266,29 |
| WAL rispetto al DB migrato, MiB | 1.247,876 | 790,537 | 670,181 |

I tempi attivi B **si sovrappongono**; non sommarli per ricavare end-to-end.
Le quote corrente/storico sono nuove misure; non sono disponibili separatamente
nelle baseline. RAM simultanea ricavata dai cicli completi del sampler originale,
non sommando massimi di container avvenuti in istanti diversi. Il sampler include
avvio e verifica (442,05 s nella nuova sessione); WAL comprende monitor e attività
di fondo del database isolato. Nessuna baseline storica modificata.

Rispetto a P1A: **−168,740 s / −27,99%**, throughput **1,389×**. Rispetto a P0 B:
**3,398×** throughput. Il target finale 2.000 opere/s resta lontano: questo ZIP
richiederebbe 5,516 s, contro i 434,043 s misurati.

Ingest persistente B: **55,863 s / 197,48 opere/s**, attesa iniziale 0,445 s.
Catalogo e viste storiche: **11.032 ciascuno**, **11.032 PUT**, **zero riproiezioni
ridondanti**. Seeding AO3 attivo: 1.792 job work, oltre a discovery/backfill;
nessuna rete AO3 esterna, come nelle baseline. La minore durata comporta meno
cicli di seeding, senza disabilitarlo. Tutti gli ID e le generazioni coincidono;
ricerca autenticata restituisce 11.032 opere, lettore verificato, code vuote.

Query catalogo: **77,931 → 2,468/opera**, **832.502 eliminate (−96,83%)**.
Query client registrate API+worker: **1.198.703 → 346.585**, **108,657 →
31,416/opera**; quelle full-text restano **247.533**, il 71,42% del totale nuovo.
Questi sono round-trip intercettati dal profiler P0, non statement interni PG.
Commit espliciti nello scope catalogo: 1.226 (incluse chiamate senza lavoro e
backpressure); nello scope full-text: 11.051. Delta commit dell'intero DB:
36.410, comprendenti autocommit amministrativi, sonde e monitor. Zero rollback,
deadlock e byte temporanei prima dei fault test.

| Coda | Massimo P1B.1 | Residenza P1A → P1B.1, s/visita | Intervallo attesa P1B.1, s |
| --- | ---: | ---: | ---: |
| Corrente | 8.352 | 276,08 → 128,45 | 124,50–130,61 |
| Storico | 6.512 | 276,08 → 23,23 | 19,28–25,39 |
| Full-text | 2.065 | 1,29 → 67,45 | 57,16–69,61 |

Residenza dall'integrale dei campioni, **servizio incluso**, non timestamp
individuali; stessa metodologia P0/P1A. Backpressure raggiunta: soglia 2.048 più
al massimo un batch corrente. Lo storico continua e termina prima; la coda
corrente segue poi la capacità del full-text. La maggiore residenza testo è
coerente con questo spostamento del limite, non lavoro perso.

### Risorse B

| Container | CPU-s | Working set medio / massimo, MiB | I/O letto / scritto, MiB | Rete RX / TX, MiB |
| --- | ---: | ---: | ---: | ---: |
| API + worker + parser + sonde | 355,242 | 898,93 / 1.046,71 | ≥47,39 / ≥830,07 | 307,39 / 973,63 |
| PostgreSQL | 234,756 | 393,53 / 480,75 | 19,86 / 2.499,41 | 561,43 / 300,03 |
| OpenSearch | 210,482 | 1.648,53 / 1.788,68 | 6,90 / 1.266,73 | 411,18 / 6,81 |
| Redis | 3,644 | 5,18 / 5,54 | 0,32 / 0,70 | 1,03 / 0,55 |

CPU totale **−36,95%** rispetto a P1A; working set massimo simultaneo **+3,55%**;
WAL **−15,22%**. Il primo campione I/O applicativo è `null`, i successivi 442
hanno contatori: il report conserva il dato completo mancante e aggiunge soltanto
il delta dell'intervallo osservato, senza assumere zero per il campione assente.
I/O fisico include cache/writeback, WAL non equivale a scritture fisiche; rete
interna osservata da entrambi gli estremi, non sommare RX/TX come traffico unico.

### C — latenza interattiva e controllo del precedente +8,17%

Probe HTTP P0 invariato: 3 warmup e 100 richieste sequenziali per endpoint,
autenticate, HTTP interno senza gateway. Stesso corpus B, prima P1A poi P1B.1,
API riavviata fra varianti, nessun ingest/AO3 worker. Ogni prova termina drenando
le code prima della successiva. Valori **P50 / P95 in ms**:

| Carico | Variante | Ricerca | Dettaglio | Lettore |
| --- | --- | ---: | ---: | ---: |
| Vuoto, prova standard | P1A | 68,18 / 102,46 | 13,30 / 22,76 | 22,73 / 39,41 |
| Vuoto, prova standard | P1B.1 | 71,13 / 104,77 | 14,27 / 23,06 | 20,87 / 31,32 |
| 1.000 corrente + 1.000 storico già presente | P1A | 65,60 / 116,05 | 20,41 / 34,14 | 26,03 / 50,50 |
| 1.000 corrente + 1.000 storico già presente | P1B.1 | 112,01 / 186,97 | 15,87 / 36,24 | 28,06 / 55,81 |

La prova standard conserva esattamente il carico P1A, ma a fine richieste P1A ha
ancora 800 correnti/800 storici/0 testo, P1B.1 **0/0/628**. Il nuovo percorso
salta correttamente le viste già persistite e drena il catalogo durante il probe:
non si presenta tutta questa finestra come contesa bibliografica costante.

Prova aggiuntiva: **5.000 correnti + 5.000 viste derivate eliminate e riaccodate**,
in entrambe le varianti; snapshot canonici intatti. Asserzione aggiuntiva:
entrambe le code bibliografiche ancora non vuote a fine HTTP. P1A termina il
probe con 4.800/4.800/23 pendenti, P1B.1 con **3.540/3.540/1.130**.

| Carico | Variante | Ricerca P50 / P95 | Dettaglio P50 / P95 | Lettore P50 / P95 |
| --- | --- | ---: | ---: | ---: |
| 5.000 corrente + storico da materializzare | P1A | 67,66 / 117,35 | 17,73 / 33,93 | 27,33 / 45,89 |
| 5.000 corrente + storico da materializzare | P1B.1 | 105,16 / 166,21 | 22,09 / 36,20 | 32,12 / 50,60 |
| Solo full-text, 1.000 documenti | P1A | 72,04 / 114,93 | 16,21 / 29,55 | 29,91 / 50,74 |
| Solo full-text, 1.000 documenti | P1B.1 | 80,02 / 134,45 | 19,73 / 31,55 | 32,12 / 55,27 |

**Peggioramento osservato della ricerca sotto backlog:** 116,05 → 186,97 ms nel
probe standard; **117,35 → 166,21 ms** con entrambe le code bibliografiche attive.
Nella seconda prova dettaglio 33,93 → 36,20 ms, lettore 45,89 → 50,60 ms.
La baseline P1A precedente era 159,92 / 32,91 / 57,21 ms: conservata, senza
sostituirla con la nuova coppia più favorevole o sfavorevole.

Il controllo con solo full-text lascia 669/675 documenti in coda dopo il probe:
carico comparabile, senza corrente/storico. Anche questo motore, il cui codice
non è cambiato, mostra variazione del P95 ricerca **114,93 → 134,45 ms**. I dati
non separano completamente cache/host dalla contesa dovuta al diverso ritmo di
produzione. Il peggioramento sotto carico rimane documentato: **nessuna promessa
di latenza invariata**, nessun rallentamento artificiale o modifica allo scheduler
per nasconderlo. Non è stato identificato un errore funzionale o una regressione
isolata e riproducibile del motore corrente che giustifichi un nuovo intervento
applicativo in questa fase.

Controllo dedicato P1B.1b → P1B.1c sul precedente **+8,17%**: runner
`probe-history-contention.cjs` invariato, 256 opere, stessi dati copiati e ANALYZE,
tre campioni per variante, ordine **vecchio/nuovo/nuovo/vecchio/vecchio/nuovo**.

| Scenario | P1B.1b, tre durate s | P1B.1c, tre durate s |
| --- | --- | --- |
| Solo corrente | 1,368; 1,158; 1,250 | 1,055; 1,092; 1,441 |
| Corrente + storico | 5,681; 5,992; 5,006 | 2,189; 2,069; 2,179 |

Mediana solo corrente **1,250 → 1,092 s**; intervalli sovrapposti. Il singolo
+8,17% **non è confermato come regressione**. Sei misure non sono un intervallo
di confidenza universale; la variabilità osservata è esplicita.

### Limite dominante e decisioni successive

Full-text: **411,849 s attivi**, rispetto a 434,043 s end-to-end. PUT fino agli
header **163,287 s (39,65% dello stadio)**; residuo **248,562 s**: ricostruzione,
lookup/SQL, letture, parsing, risposta JSON e commit, non sola CPU. Span annidati:
`loadSnapshot` 86,848 s, `chapterBytes` 87,305 s, `plain` 12,634 s. Non sommarli
fra loro o al full-text. Limitarsi a inviare `_bulk` non eliminerebbe quel residuo.

PostgreSQL usa **234,756 CPU-s, 29,19%** della CPU totale campionata. Il catalogo
rimane serializzato dal lock globale, ma i round-trip di acquisizione del lock
sommano **1,490 s**, massimo 18,23 ms: non sono tempo puro di contesa né prova
che il lock sia eliminabile. Arricchimento manifest/HTML inclusivo: **11,407 s
corrente + 12,221 storico**, dentro i relativi tempi catalogo. `projectGraph`
**0,520 s**; il corpus senza archi non rappresenta un grafo complesso.

Lo scheduler full-text registra **2,261 s** complessivi fra batch con lavoro,
massimo **18,80 ms**: nessuna attesa obbligatoria di un secondo sotto backlog.
I 220,528 s fra batch catalogo produttivi includono backpressure/attese quando
il testo è pieno; non sono tempo SQL sprecato da eliminare aumentando i batch.

**Default conservati a 20/20/16.** I microbenchmark 64/256 di P1B.1b/c dimostrano
maggior throughput del sottosistema e maggior memoria; non dimostrano miglior
end-to-end o latenza. Il nuovo limite full-text e i P95 osservati non giustificano
un aumento del default. Raccomandazione: nella fase autorizzata successivamente,
misurare e ridurre ricostruzione/lookup dei documenti **insieme** ai PUT individuali
(P2); per P1B.2 serve anche un corpus con grafo reale. Nessuna delle due fasi è
stata iniziata.

### Equivalenza, recupero e consegna

Confronto completo eseguito nuovamente con `compare-bibliography.cjs` invariato,
su una copia isolata del database P1A con **gli stessi ID** e PackStore originale
montato read-only: rigenerati tutti gli storici, riproiettate tutte le opere
correnti e reindicizzato il corpus. **Zero aggiunte, rimozioni o modifiche** nei
valori normalizzati e nelle relazioni: 11.032 opere/snapshot/documenti/viste,
57.661 tag, 22.140 entità, 167.736 associazioni opera-tag, 24.909 opera-entità,
167.736 filtri. Metadata, identità, hash manifest/versioni e provenienza
confrontati, non solo conteggi. Generazioni PostgreSQL/OpenSearch tutte coerenti;
non si richiede l'identità con l'ordinamento instabile dei vecchi hash P1A,
già documentato in P1B.1b. Le nuove acquisizioni A/B hanno ID locali propri:
il confronto esatto usa correttamente la copia con ID conservati.

Verificati **107.054 oggetti canonici** attraverso il reader PackStore con hash e
checksum. Il percorso API normale verifica ricerca e lettore; le fixture
storiche coprono tre versioni, anonimato, alias, evidenze condivise, modifica del
grafo e materializzazione concorrente on-demand/background. Confermata la
particolarità storica e la correzione del fallback alias documentate in P1B.1c,
senza ulteriori cambi di semantica.

`verify-projections.cjs` passa invariato: invalidazioni durante proiezione/PUT
sopravvivono agli ACK, disponibilità e ricerca aggiornate, seeding/watchlist,
pausa/ripresa, retry, lock concorrenti, fairness con backpressure, manutenzione,
stop pulito e SIGKILL/ripresa. Recupero mirato **5,109 s**, massimo intervallo
fra batch **218,82 ms** nella fixture di fault, non throughput del corpus.
`verify-history.cjs` passa: rollback e crash dopo INSERT prima del commit,
retry, viste già materializzate immutate, catalogo/generazioni correnti invariati.
Due test `ingest-pipeline` passati: ACK solo sul prefisso completato, nessun ACK
oltre un errore asincrono. Nessuna asserzione rimossa o indebolita.

Build Docker API completa riuscita, inclusi build di tutti i workspace (solo
warning Vite sui chunk grandi). Non ripetute le altre suite delle fasi a–c,
il cui codice applicativo è invariato. **P1B.1 consolidata e verificata**:
campagne A/B/C e controlli di correttezza terminati; resta il peggioramento
interattivo sotto backlog riportato sopra, senza spacciarlo per risolto.

Riproduzione dopo la build, in sequenza:

```sh
RELEASE_IMAGE=palimora-p1b1-api P0_SCENARIO=A RELEASE_KEEP=1 \
 BENCH_NODE_OPTIONS=--require=/app/scripts/performance-bibliography-profiler.cjs \
 RELEASE_BENCH_ROOT=/mnt/sdb/palimora-p1b1d-a-20261108 ./scripts/benchmark-p0.sh
# Arrestare i container A prima di B; mantenere i bind mount.
RELEASE_IMAGE=palimora-p1b1-api P0_SCENARIO=B RELEASE_KEEP=1 \
 BENCH_NODE_OPTIONS=--require=/app/scripts/performance-bibliography-profiler.cjs \
 RELEASE_BENCH_ROOT=/mnt/sdb/palimora-p1b1d-b-20261108 ./scripts/benchmark-p0.sh
```

I percorsi devono essere nuovi. Per C, worker temporanei delle immagini P1A e
P1B.1 sullo stesso database/PackStore B, risultati separati e API del benchmark
arrestata: `node scripts/benchmark-projection-latency.cjs`; poi, in entrambe le
varianti, `BENCH_LATENCY_WORKS=5000 BENCH_REGENERATE_HISTORY=1
BENCH_REQUIRE_BIBLIOGRAPHY_BACKLOG=1` per il caso con vero lavoro storico.
Diagnostica separata `BENCH_LATENCY_TEXT_ONLY=1` mantiene il carico a 1.000.
Il probe HTTP rimane invariato. Gli script rifiutano database non `_test`.

`collect-bibliography-integration.cjs` raccoglie solo aggregati dopo la misura;
`summarize-performance.py` e `summarize-bibliography-integration.py` elaborano
A/B; `summarize-p1b1d.py /mnt/sdb` consolida anche C, controlli alternati e
verifiche. Comandi effettivi, log e hash della strumentazione conservati nei
risultati privati. Report pubblico: [performance-p1b1d.json](performance-p1b1d.json).
Fixture `/mnt/sdb/palimora-p1b1d-{a,b,equivalence}-20261108/` e directory sorelle
`c-*`, `cold-*`, `text-latency-*`, `control-*`. Container/reti temporanei rimossi,
bind mount ed evidenze conservati; baseline e servizi di produzione intatti.

## P2A — trasporto bulk e protocollo di pubblicazione

Il runtime usa la stessa `catalog_text_pending`, lo scheduler P1A e i lock di
sessione operativi. La migrazione additiva 039 assegna revisioni bigint con una
sequenza persistente; gli hash `generation` continuano a identificare i contenuti.
Ogni invalidazione aggiorna la revisione e revoca il claim precedente. La sequenza
parte da 10^12 per separare la prima pubblicazione dalle versioni interne legacy.

Il claim usa una transazione breve, `SKIP LOCKED`, token UUID, generazione richiesta e lease di cinque
minuti. La costruzione resta sequenziale e usa una transazione read-only
repeatable-read per opera, senza lock di coda; verifica token e revisione prima
di leggere. Manifest, capitoli, note e bibliografia seguono il percorso P1B.1:
nessun prefetch, cache o cambiamento PackStore/P2B. Nessuna transazione della
proiezione rimane aperta durante HTTP.

NDJSON usa `index`, gli stessi ID e documenti, `version_type=external` stretto.
Un alias di scrittura con `require_alias` impedisce che un bulk ricrei
automaticamente un indice senza mapping quando questo scompare durante l’invio.
OpenSearch rifiuta revisioni uguali o precedenti: anche un retry con preparazione
ripetuta non sostituisce i byte già pubblicati. Un conflitto di versione conferma
che quella revisione o una successiva è già presente. Nei soli retry con conflitto,
un flush confermato da tutti gli shard rende durevole la scrittura osservata prima
dell'ACK, anche senza aver ricevuto la conferma originaria. Un flush fallito lascia
il documento pendente. I bulk normalmente riusciti usano la durabilità `request`
di OpenSearch e non eseguono flush aggiuntivi ([Flush API](https://docs.opensearch.org/latest/api-reference/index-apis/flush/)).
ACK set-based condizionato
sia dalla revisione sia dal token: non può cancellare invalidazioni o lease nuovi.
Riferimento: [Bulk API OpenSearch](https://docs.opensearch.org/latest/api-reference/document-apis/bulk/).

Limiti: default **16 opere**, configurazione P1A fino a 256, target **8 MiB di
NDJSON effettivi**. Un documento oltre il target viaggia da solo, fino a **64 MiB**;
oltre tale limite resta pendente con errore esplicito, senza troncamento. Il buffer
contiene al massimo il bulk corrente più il documento in preparazione; quest'ultimo
mantiene il costo di ricostruzione P1B.1. Nessun parallelismo illimitato. I gruppi
64/128 servono alla misura, non modificano il default.

Le risposte sono validate per item e ID. Errori di trasporto, timeout e risposte
incomplete conservano il lavoro; retry esponenziale fino a 300 s con jitter.
Errori permanenti per item e documenti oltre limite restano in coda, con retry
orario, e non sono considerati completati. Il controllo amministrativo retry
riabilita gli elementi disponibili. Stato e cronologia operativa registrano il
fallimento anche quando parte del gruppo è stata confermata. Il monitoraggio
include anche claim e documenti falliti nel backlog. Uno stop conserva i claim
non completati; il riavvio recupera quelli scaduti. La ricreazione accoda tutte
le opere **prima** della creazione HTTP dell'indice, eliminando la finestra di
crash fra creazione e accodamento.

Verifica riproducibile: `scripts/benchmark-text-bulk.cjs` su PostgreSQL/OpenSearch
isolati e copia fredda della fixture P1B.1, PackStore originale montato read-only.
`P2A_LABEL=old-16` usa l'immagine P1B.1 senza migrare; `bulk-16`, `bulk-64` e
`bulk-128` usano il nuovo runtime con migrazione. I confronti verificano hash
SHA-256 dell'intero `_source` per tutti gli ID e risultati di cinque ricerche.
`scripts/verify-text-bulk.cjs` esercita guasti e concorrenza su servizi reali.
Nessun ingest viene eseguito; questa misura riguarda solo il full-text e non è
la campagna end-to-end P2C.

```sh
# La fixture sorgente deve essere spenta; la directory risultato deve essere nuova.
docker build -f infra/Dockerfile --target api -t palimora-p2a-api .
P2A_SOURCE=/mnt/sdb/palimora-p1b1d-b-20261108 \
 P2A_ROOT=/mnt/sdb/palimora-p2a-repeat \
 P2A_IMAGE=palimora-p2a-api ./scripts/benchmark-p2a.sh
```

Il controllo legacy viene eseguito prima della migrazione e ripetuto dopo i
bulk sullo stesso schema additivo 039. Il report distingue il primo controllo
dalla ripetizione strumentata. Il campionamento risorse è esterno al processo;
la verifica dei documenti avviene dopo la finestra misurata. Il tempo HTTP del
wrapper termina agli header; quello dello stadio bulk include lettura e parsing
della risposta. Non sono due misure da sommare. I tempi SQL includono round-trip;
CPU e I/O sono contatori separati.

Per l'aggiornamento arrestare i proiettori precedenti prima di migrare/avviare
P2A: scrittori legacy con versioning interno non devono convivere con il nuovo
protocollo esterno. I controlli P1B.1 del benchmark sono sequenziali, senza
proiettori applicativi concorrenti.

### Risultati P2A — 2026-11-08

Aggregati pubblici in [performance-p2a.json](performance-p2a.json). Il JavaScript
legacy `catalog-search.js` è identico alla compilazione del riferimento
`16a018bef7a8ec777ac7ab2c66abc5938b141020` (hash nel report). La prima popolazione
legacy ha richiesto **378,307 s**, 29,162 documenti/s; il controllo ripetuto,
con indice già popolato e schema 039, è la colonna di confronto seguente.
Sono tempi del motore `projectText`, con claim, preparazione, invio e ACK durevoli;
refresh/verifica e wrapper amministrativi dello scheduler sono fuori dalla misura.
La compatibilità dello scheduler è verificata separatamente.

| Misura, 11.032 opere | P1B.1 ripetuto | P2A 16 definitivo | P2A 64 | P2A 128 |
|---|---:|---:|---:|---:|
| Full-text, s | 345,744 | 276,305 | 244,189 | 247,893 |
| Documenti/s | 31,908 | 39,927 | 45,178 | 44,503 |
| Richieste documenti PUT / bulk | 11.032 | 690 | 173 | 87 |
| HTTP totali, inclusi HEAD | 11.723 | 1.381 | 347 | 175 |
| Byte inviati | 426.204.691 | 428.013.939 | 428.013.939 | 428.013.939 |
| HTTP cumulativo agli header, s | 139,421 | 94,347 | 70,613 | 70,654 |
| Preparazione, s | 171,197 | 170,064 | 165,795 | 170,303 |
| Claim / ACK, s | — | 3,627 / 2,185 | 1,608 / 0,638 | 1,065 / 0,405 |
| Chiamate SQL client | 247.483 | 250.240 | 248.172 | 247.828 |
| Transazioni, inclusi ACK autocommit | 11.034 | 12.413 | 11.379 | 11.207 |
| WAL, MiB | 2,965 | 4,838 | 6,402 | 6,820 |
| CPU Node, s | 150,138 | 110,674 | 103,862 | 105,825 |
| CPU OpenSearch, s | 128,900 | 98,160 | 93,790 | 93,550 |
| RSS Node medio / massimo campionato, MiB | 187,85 / 211,95 | 194,65 / 254,52 | 203,11 / 269,36 | 248,40 / 327,51 |

Il default riduce il tempo del motore del **20,08%**, aumentando il throughput
del **25,13%** in questo confronto. Aumentano invece chiamate SQL, transazioni,
WAL e picco RSS: sono costi misurati del nuovo protocollo, non miglioramenti.
Il percorso legacy accumula 29,678 s nelle query BEGIN/dequeue/DELETE/COMMIT;
la preparazione P2A include la propria transazione di lettura, quindi non attribuire
l'intera differenza fra quel valore e claim/ACK a una riduzione equivalente di CPU.
Il bulk propriamente detto, risposta JSON inclusa, occupa **93,645 s** a 16;
la preparazione residua è **170,064 s, 61,55%** del tempo totale: riferimento per
P2B, che non è implementata qui.

I/O e CPU dei container, su intervalli campionati circa un secondo più brevi
dello stadio, nel confronto ripetuto → default 16:

- CPU PostgreSQL: **85,286 → 77,972 s**.
- Letture fisiche Node da `/proc/self/io`: **2.105.344 → 1.671.168 byte**;
  scritture fisiche Node zero in entrambi. Le cache rendono questi numeri diversi
  dai byte letti logicamente dai pack.
- Scritture PostgreSQL da cgroup: **2.768.896 → 25.063.424 byte**;
  letture zero negli intervalli osservati.
- Scritture OpenSearch da cgroup: **1.222.041.600 → 1.203.208.192 byte**;
  letture **0 → 4.096 byte**. Checkpoint e merge restano inclusi.
- RAM OpenSearch totale media/massima: **3.167.634.485 / 3.570.483.200 →
  2.957.856.649 / 3.342.770.176 byte**, inclusa cache. Working set medio
  **2.088.088.179 → 1.941.186.382 byte**. Il report conserva anche PostgreSQL,
  finestre, contatori I/O e dati degli altri gruppi.

**Zero retry/errori nelle misure.** Tutti i 11.032 `_source`, inclusi ID,
generation, snapshot e testo, hanno lo stesso hash del controllo; identiche
le cinque ricerche confrontate. Code drenate e indice completo dopo recupero.
Prove su PostgreSQL 17.6/OpenSearch 2.19.4 reali: mapping error parziale,
risposta persa dopo accettazione, lease scaduto/vecchio token, nuova generazione
durante preparazione/invio, risposte fuori ordine, SIGKILL prima del commit del
claim, prima/dopo invio e prima dell'ACK, backoff 429/503, limiti UTF-8 e documenti
singoli oltre 8 MiB, pausa/ripresa, repliche, cronologia/retry, manutenzione e stop.
Verificati perdita/ricreazione dell'indice e recupero completo; manifest e viste
storiche invariati. Il test aggiuntivo verifica flush fallito senza ACK e flush
reale confermato prima dell'ACK. Timeout/sovraccarico sono iniezioni lato trasporto;
le scritture, gli errori di mapping e i flush usano OpenSearch reale. Nei test di
crash il lease viene fatto scadere via SQL, senza attendere cinque minuti.

Build completa riuscita (warning Vite sui chunk già presente), due test mirati
`ingest-pipeline` passati. Nessuna verifica originale modificata o indebolita.
Le prove 64/128 precedono l'ultima barriera di flush, che riguarda soltanto
conflitti/retry assenti nelle misure; il default 16 è stato rimisurato con il
motore definitivo. Cache, segmenti e carico dell'host non sono controllati:
nessuna garanzia statistica o modifica del default. La baseline storica rimane
411,849 s attivi full-text e 434,043 s end-to-end, distinta dal controllo locale.
Non è stata misurata un'accelerazione end-to-end.

**P2A completata; P2 non conclusa. P2B e P2C non avviate.** Nessun ingest,
modifica dei dump, del formato canonico, del parser o di PackStore. Fixture ed
esiti privati conservati in `/mnt/sdb/palimora-p2a-20261108`; container temporanei
rimossi dopo le verifiche.

## P2B.1 — preparazione collettiva dei documenti

Il runtime `projectText()` usa `catalog-text-preparation.ts` per acquisire gruppi
coerenti, poi applica l'unica trasformazione `prepareTextDocument()` e pubblica
attraverso il motore P2A. Non esegue una serie di builder individuali in parallelo.
Il riferimento differenziale è `ad6f91ff16d8f66aaa36fd70025fbd096414cfc6`.

Una transazione **REPEATABLE READ, READ ONLY** per gruppo verifica token,
revisione e generazione richiesta; acquisisce catalogo/bibliografia, riferimenti
agli snapshot e manifest, identità/alias AO3, date archivistiche, tag canonici e
source IDs, epoch e dati dei filtri. Le query ricorsive sono collettive e restano
esatte: crossover cerca una radice che intersechi tutte le chiusure
synonym/meta; OTP conta i terminali della chiusura synonym. Le array dei tag
mantengono l'ordine del percorso precedente. Nessuna nuova migrazione o indice.

Il piano legge prima le dimensioni dei metadata, dei tag e dei manifest, poi
quelle degli oggetti referenziati. Seleziona un prefisso dei claim entro un
budget di **16 MiB**, ulteriormente limitato dal numero di documenti richiesto.
Il budget conta ogni inserimento delle note condivise nel testo ricostruito.
Le finestre di lettura deduplicano gli hash e chiamano `readObjectBatches()` /
`PackStore.readMany()`: lookup collettivo, raggruppamento per pack, decompressione
e SHA-256 nativi invariati. Capitoli e note vengono ricostruiti nell'ordine
originale. Il lettore e il builder condividono la funzione di inserimento note e
verifica `source_html_sha256`; la trasformazione bibliografica finale è unica.

Il budget limita i gruppi ordinari e i buffer decodificati, **non il valore RSS**:
una singola opera o un frame indivisibile oltre budget viene isolato, secondo
l'API nativa esistente. Stringhe JavaScript, ricostruzione e serializzazione
NDJSON aggiungono copie. Non si accumulano centinaia di capitoli grandi; rimane
il limite esplicito P2A di 64 MiB per documento, senza troncamento silenzioso.
Non c'è una cache persistente né riuso del testo prodotto durante ingest.

I lock della coda appartengono soltanto al claim breve P2A. La lettura mantiene
la protezione archivistica condivisa già prevista dalle API, e termina prima
dell'HTTP. Lease, revisione monotona, external versioning, barriera di flush sui
conflitti e ACK condizionato restano quelli P2A: una preparazione superata da
un'invalidazione non può cancellarla né sovrascrivere una revisione successiva.
Un oggetto mancante/corrotto produce un esito per la sola opera interessata;
le letture fallite vengono suddivise per isolare il problema. Un errore SQL
che abortisce la transazione provoca rollback e suddivisione del gruppo, fino
all'identificazione del documento in retry. I documenti sani vengono pubblicati.

### Riproduzione e verifiche P2B.1

`scripts/benchmark-p2b1.sh` usa una copia fredda della fixture PostgreSQL P2A,
PackStore originale in sola lettura e PostgreSQL 17.6/OpenSearch 2.19.4 isolati,
senza porte host. Durabilità PostgreSQL attiva, heap OpenSearch 1 GiB,
`UV_THREADPOOL_SIZE=8`. Servono le immagini API compilate dai due riferimenti:

```sh
docker build -f infra/Dockerfile --target api -t palimora-p2b1-api .
P2B1_SOURCE=/mnt/sdb/palimora-p2a-20261108 \
 P2B1_PACK_ROOT=/mnt/sdb/palimora-p1b1d-b-20261108/storage \
 P2B1_ROOT=/mnt/sdb/palimora-p2b1-repeat \
 P2B1_OLD_IMAGE=palimora-p2a-api P2B1_IMAGE=palimora-p2b1-api \
 ./scripts/benchmark-p2b1.sh
```

La misura comprende claim, transazioni coerenti, letture, trasformazione,
pubblicazione e ACK durevoli. Refresh e confronto successivo sono fuori dal
cronometro. Il controllo P2A viene ripetuto sull'indice popolato; i risultati
principali usano il codice finale. La variante `sql-16` mantiene acquisizione
collettiva e trasformazione, forzando soltanto letture fisiche singleton nelle
API native: misura separatamente il contributo del raggruppamento dei pack.
Questa modalità appartiene esclusivamente allo strumento di benchmark.

Il controllo calcola SHA-256 di ogni `_source` completo per tutte le 11.032
opere e confronta cinque ricerche (totale e primi 100 ID con ordinamento esplicito).
ID, generation, snapshot, testi e campi bibliografici fanno parte dell'hash.
`verify-text-bulk.cjs` P2A è eseguito senza modifiche: errori parziali, timeout
accettato, SIGKILL nelle quattro finestre, lease scaduto, invalidazione durante
preparazione, risposte fuori ordine, retry/flush durevole, pause, manutenzione,
cronologia, ricreazione e drenaggio dell'indice. I fault di trasporto sono
iniettati intorno a scritture reali; l'expiry viene anticipata via SQL dopo crash.

`verify-text-preparation.cjs` aggiunge uno schema, un indice e pack sintetici
separati: due capitoli per opera, note e capitoli condivisi, metadata incompleti,
alias, sinonimi/meta-tag transitivi, crossover/OTP, opera da 18 MiB, nota condivisa
da circa 9,35 MiB inserita in entrambi i capitoli, oggetto
mancante, frame realmente corrotto e errore SQL isolato con successiva
pubblicazione. Confronta anche lettore e sei snapshot storici con il builder
P2A compilato. Le fixture sintetiche non leggono né modificano i dump.

### Risultati P2B.1 — 2026-11-08

Aggregati in [performance-p2b1.json](performance-p2b1.json). Il riferimento
storico P2A resta **276,305 s full-text, 170,064 s preparazione, 39,927 documenti/s**.
La tabella usa la ripetizione locale P2A sullo stesso indice già popolato,
con durabilità attiva. Tutte le varianti finali usano il budget definitivo,
compreso il conteggio delle note condivise ripetute.

| Misura, 11.032 opere | P2A 16 | SQL collettivo, letture singleton 16 | P2B.1 16 | P2B.1 64 | P2B.1 128 |
|---|---:|---:|---:|---:|---:|
| Full-text, s | 270,560 | 156,884 | 154,593 | 130,614 | 128,641 |
| Documenti/s | 40,775 | 70,319 | 71,362 | 84,463 | 85,758 |
| Preparazione, s | 172,589 | 65,188 | 55,715 | 48,504 | 40,501 |
| Documenti preparati/s | 63,921 | 169,234 | 198,008 | 227,444 | 272,386 |
| SQL client / documento | 250.240 / 22,683 | 14.493 / 1,314 | 14.493 / 1,314 | 3.636 / 0,330 | 1.830 / 0,166 |
| Transazioni incluse ACK | 12.413 | 2.071 | 2.071 | 520 | 262 |
| Richieste bulk / HTTP totali | 690 / 1.381 | 690 / 1.381 | 690 / 1.381 | 173 / 347 | 87 / 175 |
| HTTP bulk con parsing, s | 84,191 | 76,621 | 84,427 | 72,796 | 81,266 |
| Claim / ACK, s | 4,851 / 2,056 | 5,656 / 2,944 | 5,686 / 2,373 | 2,649 / 0,855 | 1,202 / 0,456 |
| Chiamate PackStore.readMany | 52.124 | 51.923 | 1.382 | 391 | 275 |
| Oggetti letti / aperture pack | 52.124 / 52.124 | 51.923 / 51.923 | 51.923 / 18.933 | 51.923 / 12.531 | 51.923 / 10.974 |
| Letture file / MiB logici | 104.248 / 202,358 | 103.846 / 202,264 | 65.806 / 331,064 | 57.716 / 375,219 | 54.060 / 429,062 |
| MiB decodificati | 449,899 | 449,830 | 449,830 | 449,830 | 449,830 |
| Estrazione HTML, s | 12,243 | 11,549 | 11,799 | 12,768 | 11,304 |
| CPU preparazione Node, s | 97,413 | 52,793 | 45,575 | 44,953 | 38,853 |
| CPU Node totale, s | 111,893 | 70,353 | 63,426 | 60,314 | 51,373 |
| CPU PostgreSQL, s campionati | 78,297 | 20,543 | 19,849 | 10,949 | 7,991 |
| CPU OpenSearch, s | 107,610 | 159,710 | 196,710 | 175,530 | 165,200 |
| RSS Node medio / massimo, MiB | 199,58 / 272,71 | 210,55 / 271,87 | 203,12 / 262,00 | 248,04 / 324,26 | 297,35 / 399,57 |
| WAL PostgreSQL, MiB | 5,195 | 4,944 | 4,311 | 5,335 | 6,977 |

Al default, il tempo di preparazione diminuisce del **67,72%**,
con **94,21%** di chiamate SQL client in meno. L'ablazione attribuisce
**107,401 s** all'acquisizione collettiva e **9,473 s** aggiuntivi
al raggruppamento fisico dei pack in questa sequenza di misure. Sono differenze
fra prove su host condiviso, non componenti garantite o additive in ogni carico.
Il full-text diminuisce del **42,86%**; non è una misura end-to-end.

Il nuovo costo dominante è la pubblicazione HTTP/OpenSearch: **84,427 s,
54,61%** del full-text a 16. Restano **55,715 s** di preparazione,
di cui **11,799 s** di estrazione HTML; il resto include SQL,
letture, decompressione verificata, ricostruzione e trasformazione. Questi ultimi
costi non sono ulteriormente separati dal profiler. Il wrapper misura anche
HTTP fino agli header; quel valore si sovrappone al tempo HTTP dello stadio.
Le transazioni di preparazione passano da **11.032 a 690**,
con **247.477 → 11.730** round-trip SQL al loro interno.

La deduplicazione del corpus risparmia **201 letture di oggetti**:
la quantità decodificata rimane quasi identica. Le aperture diminuiscono, ma
le letture logiche aumentano da **212.187.964 a 347.145.819 byte** per
il range reading già previsto da PackStore, che include gli spazi fra frame.
Anche la RAM è un costo da osservare nella tabella; non si cambia il default.

La CPU OpenSearch complessiva aumenta da **107,610 a 196,710 s**:
è un costo osservato, incluso nelle misure. Le reindicizzazioni successive
condividono l'indice popolato ma non uno stato identico dei segmenti; i contatori
includono attività di fondo, fra cui i merge, senza una loro attribuzione separata.
Non è quindi una misura isolata dell'effetto del builder sulla CPU OpenSearch.

PostgreSQL, controllo P2A → default P2B.1: RAM cgroup media/massima
**143,54 / 143,92 → 176,97 / 178,95 MiB**
(inclusa cache); I/O fisico letto/scritto
**0 / 12.144.640 → 0 / 19.537.920 byte**.
Rete ricevuta/inviata: **87.505.579 / 175.981.334 → 47.748.215 / 133.426.352 byte**.

OpenSearch, controllo P2A → default P2B.1: RAM cgroup media/massima
**2.963,61 / 3.589,56 → 3.897,54 / 4.331,70 MiB**
(inclusa cache); I/O fisico letto/scritto
**28.672 / 1.248.964.608 → 16.384 / 1.931.444.224 byte**.
Rete ricevuta/inviata: **427.099.388 / 2.034.886 → 428.578.953 / 1.981.202 byte**.

Node legge fisicamente **81.920 → 9.293.824 byte** da `/proc/self/io`;
le scritture sono **0 → 0 byte**. Questi valori dipendono dalla cache e sono
diversi dai byte logici dei pack. RSS riguarda il processo full-text, non singole
allocazioni del builder. CPU di preparazione è misurata durante le transazioni
coerenti; RSS ogni 100 ms, risorse dei container ogni secondo. I contatori cgroup
omettono frazioni ai bordi dello stadio; WAL include attività di fondo. Il report
conserva anche rete/I/O del worker, working set e dati completi degli altri batch.

**Tutti i 11.032 documenti equivalenti**, incluse generazioni e snapshot; cinque
ricerche identiche, code catalogo/snapshot/grafo/testo a zero dopo recupero.
Zero errori e retry nelle misure. Passati i controlli P2A originali e le nuove
fixture di preparazione; build completa riuscita, otto test mirati
`ingest-pipeline`, `archive` e `archive-native` passati con PostgreSQL/OpenSearch
isolati, senza skip. Il warning Vite sui chunk rimane quello preesistente.
Nessuna regressione funzionale osservata; aperture e query ridotte, aumento
misurato delle letture logiche e limiti di memoria dichiarati sopra.

**P2B.1 completata; P2 non conclusa. P2B.2 e P2C non avviate.** Default 16
invariato. Nessuna modifica a parser, formato canonico, PackStore, bibliografia,
UI o dati di produzione; nessun ingest massivo. Risultati privati conservati
in `/mnt/sdb/palimora-p2b1-20261108`, servizi temporanei rimossi dopo le verifiche.

## P2B.2 — preparazione e pubblicazione concorrenti

La fase full-text usa ora producer e consumer nello stesso motore P2A. Ogni
passaggio acquisisce al massimo otto gruppi: prima prenota posti per i documenti,
poi esegue il claim persistente. La preparazione continua a usare `selectTextGroup`
e il trasformatore P2B.1, con una connessione propria e una transazione
`REPEATABLE READ, READ ONLY` per gruppo selezionato. La transazione termina prima
della serializzazione e della pubblicazione di quei documenti. Una transazione
read-only di un altro producer può sovrapporsi all'HTTP del consumer: nessuna
transazione di preparazione attende l'HTTP, nessun lock della coda è mantenuto.

I producer trasferiscono buffer NDJSON a una coda temporanea limitata. I consumer
usano le stesse revisioni esterne strettamente crescenti, gli stessi ID, la stessa
risposta per elemento e il flush durabile sui conflitti P2A. PostgreSQL resta
l'unica coda autorevole. La trasformazione, SQL bibliografico, PackStore, parser,
formato canonico e mapping non cambiano. Nessuna cache persistente.

Il consumer rinnova e ricontrolla token, revisione, generazione e lease ancora
valido subito prima dell'HTTP. Un monitor rinnova anche i claim in preparazione,
in coda o in volo, al massimo ogni 60 secondi, per altri cinque minuti. Un lease
scaduto non viene resuscitato; l'ACK richiede anche un lease non scaduto. La nuova
invalidazione revoca l'ownership precedente tramite il protocollo P2A. Il rinnovo
non sostituisce il fencing esterno: un'invalidazione dopo il controllo rimane
protetta contro invii fuori ordine e ACK obsoleti.

| Variabile | Default | Intervallo / significato |
| --- | ---: | --- |
| `PROJECTION_TEXT_BATCH` | 16 | 1–256, dimensione claim P1A invariata |
| `PROJECTION_TEXT_PREPARE_LANES` | 1 | 1–2 connessioni di preparazione |
| `PROJECTION_TEXT_PUBLISH_LANES` | 1 | 1–2 richieste bulk in volo |
| `PROJECTION_TEXT_GROUPS` | 8 | 1–64 gruppi per passaggio finito |
| `PROJECTION_TEXT_DOCUMENTS` | 256 | 1–4096 posti, almeno quanto il batch; include claim/preparazione/coda/HTTP |
| `PROJECTION_TEXT_NDJSON_MIB` | 384 | 320–1024 MiB, ammissione conservativa dei payload e delle copie |
| `PROJECTION_TEXT_MEMORY_MIB` | 448 | 352–2048 MiB, prenotazioni complessive preparazione e payload |
| `PROJECTION_TEXT_RENEW_MS` | 60000 | 100–60000 ms, intervallo massimo rinnovo |
| `PROJECTION_TEXT_OVERLAP` | 1 | `0` permette il controllo sequenziale con una lane per fase |

Il budget deve consentire almeno 32 MiB per lane di preparazione più 320 MiB per
serializzare un documento al limite P2A di 64 MiB. Il controllo prenota cinque
volte quel limite prima della serializzazione, poi riduce la prenotazione a
cinque volte i byte effettivi: copre buffer UTF-8 e copie temporanee UTF-16.
La pubblicazione mantiene la prenotazione fino all'ACK. Un gruppo parzialmente
serializzato viene consegnato al consumer prima di attendere altro spazio,
evitando deadlock anche al budget minimo. L'ammissione può essere conservativa:
con due lane e budget minimo può frammentare maggiormente i bulk.

Le finestre P2B.1 restano da 16 MiB. Un input indivisibile eccezionalmente grande
causa rollback prima delle letture pesanti, attesa fuori da SQL finché le altre
preparazioni e i payload sono drenati, poi ripreparazione esclusiva. Rimane
l'eccezione nativa P2B.1 del singolo frame/opera: può superare il budget ordinario,
è osservabile e non si moltiplica per le lane. Il limite di output resta 64 MiB;
un documento eccedente resta in coda con errore esplicito. I budget descrivono
buffer e prenotazioni applicative, **non un limite assoluto al RSS**: DOM, oggetti
JavaScript, GC, driver e codec aggiungono memoria, misurata separatamente.

I gate attendono notifiche, senza polling aggressivo. 429/503 e risultati incerti
fermano gli invii in attesa; i retry persistenti conservano il backoff P2A.
Un errore di preparazione non elimina gli altri claim. Pausa e arresto fermano
l'acquisizione, lasciano terminare l'HTTP già iniziato quando possibile e liberano
condizionatamente i claim residui. SIGKILL lascia lease recuperabili. Una perdita
del database interrompe il passaggio; se anche la pulizia fallisce, la coda
persistita recupera alla scadenza. La perdita della connessione del leader P1A
ferma la pipeline senza sovrascrivere lo stato di un nuovo leader. Gli errori
delle connessioni restano osservati anche durante la chiusura del socket.

La telemetria `text_bulk` conserva i contatori P2A e aggiunge tempi cumulativi di
attesa producer/consumer/coda, durata per gruppo, unioni temporali di preparazione
e HTTP, loro intersezione effettiva, concorrenza massima, picchi di documenti,
byte NDJSON e prenotazioni, rinnovi/scadenze/rifiuti dei lease. I tempi cumulativi
delle lane non sono tempo wall-clock e non vanno sommati per stimare throughput.

### Verifiche e metodo P2B.2

Le suite `verify-text-bulk.cjs` e `verify-text-preparation.cjs` sono invariate.
La suite P2A gira con `PROJECTION_TEXT_GROUPS=1`: conserva anche l'asserzione
storica che non vi siano transazioni SQL attive durante HTTP nel caso sequenziale.
La nuova `verify-text-concurrency.cjs` verifica invece che ogni documento sia
pubblicato dopo il commit della propria preparazione e che le due lane abbiano
connessioni/snapshot read-only indipendenti. Non impone l'assenza di transazioni
di altre lane durante l'HTTP, che impedirebbe la sovrapposizione richiesta.

Le prove aggiuntive coprono coda piena, budget minimo, rinnovo e scadenza dei lease
in coda, invalidazioni durante preparazione e attesa, due pubblicazioni dello
stesso ID fuori ordine con ACK vecchio mentre il nuovo è ancora pendente, errore
parziale con successo concorrente, 429/503 senza ulteriori invii buffered,
terminazione di una connessione e riavvio reale PostgreSQL, perdita del leader,
SIGKILL del producer/durante HTTP/prima dell'ACK, SIGTERM e pausa/ripresa. I crash
SIGKILL forzano la scadenza SQL per non attendere cinque minuti: i tempi di
recupero riportati escludono quell'attesa, non promettono ripartenza istantanea.
Restano le prove P2A di timeout dopo accettazione, flush durabile, manutenzione,
cronologia/retry amministrativi e ricreazione completa dell'indice. Le fixture
P2B.1 conservano lettore/versioni storiche, tag/alias/crossover/OTP, capitoli/note
condivisi, metadata incompleti e oggetti grandi/mancanti/corrotti.

Il benchmark `benchmark-p2b2.sh` usa PostgreSQL 17.6, OpenSearch 2.19.4 con heap
1 GiB e `UV_THREADPOOL_SIZE=8`, rete Docker interna senza porte host. Il database
è copiato a freddo dalla fixture P2B.1, i pack originali della fixture P1B.1d B
sono montati read-only. Nessuna modifica a fsync, synchronous_commit, integrità,
refresh, shard o mapping. Si salva una sola copia fisica dell'indice popolato
arrestando correttamente OpenSearch; ogni profilo ripristina quella stessa copia
e avvia una JVM nuova. Questo controlla i segmenti iniziali, non la cache del
filesystem, i checkpoint PostgreSQL o il carico dell'host condiviso.

Il timer del motore, senza il wrapper amministrativo e l’interleaving dello scheduler
per entrambi i commit, comprende tutti i passaggi claim/preparazione/pubblicazione/ACK e i
controlli interni del motore. Enqueue iniziale, bootstrap, refresh finale e verifica
sono fuori dal timer per entrambi i commit. Per ciascuna misura si confrontano
SHA-256 del `_source` completo di tutte le 11.032 opere e cinque ricerche
(totale e primi 100 ID in ordine esplicito), con il builder P2B.1 del commit
`641755db939b629ddef39a311dcca9ab445e89ec`. La campagna è esclusivamente full-text.
Il controllo `serial-16` usa il nuovo motore senza overlap: distingue il costo
del controllo/rinnovo/serializzazione dal beneficio osservato della concorrenza.

Riproduzione del benchmark con immagini costruite dalle revisioni indicate:

```sh
P2B2_SOURCE=/mnt/sdb/palimora-p2b1-20261108 \
 P2B2_PACK_ROOT=/mnt/sdb/palimora-p1b1d-b-20261108/storage \
 P2B2_ROOT=/mnt/sdb/palimora-p2b2-repeat \
 P2B2_OLD_IMAGE=palimora-p2b1-api P2B2_IMAGE=palimora-p2b2-api \
 ./scripts/benchmark-p2b2.sh
```

Lo script riproduce i benchmark e conserva le prove private; le verifiche di
fault sono separate per non contaminarne i timer. Nella fixture corrente sono
stati usati lo stesso contenitore API base e distribuzioni compilate montate
read-only: riferimento estratto da `git archive` del commit P2B.1, codice attuale
compilato dalla working tree. Il report registra Node e gli hash JavaScript
rilevanti. `verify-text-preparation.cjs` richiede inoltre il builder P2A originale
in `apps/api/p2a-dist`, come nella verifica P2B.1. Per il riavvio reale PostgreSQL,
`verify-text-concurrency.cjs` con `P2B2_POSTGRES_OUTAGE=1` segnala `pg-stop-ready`:
il supervisore della fixture arresta il solo container PostgreSQL isolato,
lo riavvia dopo due secondi e scrive `pg-restarted` dopo `pg_isready`.

### Risultati P2B.2 — 2026-11-09

Dati aggregati in `docs/performance-p2b2.json`; undici campioni completi,
zero errori/retry, nessun lease scaduto o rifiutato nelle misure. Le righe
«rip.» sono una seconda esecuzione completa sullo stesso checkpoint OpenSearch.

| Profilo | Full-text s | Doc/s | Preparazione cumulativa s | HTTP cumulativo s | Overlap / wall | Bulk |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| P2B.1 16 | 235,949 | 46,756 | 82,476 | 135,104 | 0,00% | 690 |
| Sequenziale nuovo 16 | 242,964 | 45,406 | 76,860 | 135,353 | 0,00% | 690 |
| 1 prep / 1 pub, 16 | 156,435 | 70,521 | 84,452 | 132,216 | 43,26% | 690 |
| 2 prep / 1 pub, 16 | 150,298 | 73,401 | 119,968 | 126,204 | 35,55% | 690 |
| 1 prep / 2 pub, 16 | 113,666 | 97,056 | 71,662 | 112,746 | 52,50% | 690 |
| 1 prep / 1 pub, 64 | 110,017 | 100,275 | 54,310 | 96,581 | 41,63% | 173 |
| 1 prep / 2 pub, 64 | 94,233 | 117,072 | 54,082 | 102,668 | 50,89% | 173 |
| P2B.1 16 rip. | 160,979 | 68,531 | 54,237 | 92,440 | 0,00% | 690 |
| 1 prep / 1 pub, 16 rip. | 123,936 | 89,014 | 68,097 | 103,312 | 43,68% | 690 |
| 1 prep / 2 pub, 16 rip. | 110,545 | 99,796 | 69,503 | 111,707 | 52,60% | 690 |
| 1 prep / 2 pub, 64 rip. | 91,715 | 120,285 | 55,735 | 105,855 | 53,51% | 173 |

Il controllo P2B.1 varia **235,949 → 160,979 s**; anche il default nuovo varia
**156,435 → 123,936 s**. Il riferimento storico **154,593 s / 71,362 doc/s**
resta valido per la campagna P2B.1, ma non è il denominatore di queste misure.
I confronti osservati della prima serie e della serie ripetuta riducono il
wall-clock del default rispettivamente del **33,70% e 23,01%**. Non sono un
fattore garantito né una stima isolata della sola concorrenza: cache, frequenza
CPU/carico condiviso e lavoro di fondo restano variabili. Sono riportati tutti
i campioni, senza selezionare soltanto quello più veloce.

Il controllo nuovo senza overlap costa **242,964 s**, contro **235,949 s** del
P2B.1 iniziale. Attivare 1+1 nella prima serie porta a **156,435 s**, con
**67,677 s** di intersezione reale preparazione/HTTP; il risparmio wall-clock
osservato è **86,529 s**. La differenza comprende anche sovrapposizione del
controllo/serializzazione e variabilità, non solo quella intersezione. La seconda
lane di preparazione mostra soltanto **6,137 s** di vantaggio in un campione;
non viene raccomandata. Due publisher a 16 ottengono **113,666 / 110,545 s**.
A 64, passare da uno a due publisher porta **110,017 → 94,233 s** nel primo
confronto; la ripetizione del secondo profilo dà **91,715 s**. Il confronto
complessivo 16 → 64 combina dimensione dei gruppi e concorrenza.

Le risorse seguenti confrontano i **campioni ripetuti**, nello stesso ordine
del benchmark. CPU in secondi cumulativi; RAM Node è RSS campionato, RAM dei
container include cache. I/O è fisico letto/scritto, distinto dai byte logici
PackStore e dalla rete.

| Misura | P2B.1 16 rip. | Default 1+1, 16 rip. | 1+2, 64 rip. |
| --- | ---: | ---: | ---: |
| Query SQL client | 14493 | 15966 | 4066 |
| Query SQL / documento | 1,314 | 1,447 | 0,369 |
| Transazioni esplicite + ACK + rinnovo | 2071 | 2762 | 694 |
| HTTP totali (bulk inclusi) | 1381 | 778 | 196 |
| CPU Node / PostgreSQL / OpenSearch s | 61,937 / 19,407 / 157,450 | 73,337 / 22,090 / 158,490 | 69,473 / 12,325 / 162,640 |
| RSS Node medio / massimo MiB | 208,53 / 270,33 | 214,25 / 268,00 | 261,16 / 324,91 |
| RAM PostgreSQL media / massima MiB | 159,46 / 162,34 | 159,83 / 164,95 | 173,56 / 178,85 |
| RAM OpenSearch media / massima MiB | 1942,95 / 2421,37 | 2025,94 / 2492,66 | 1981,52 / 2486,78 |
| WAL MiB | 4,866 | 6,711 | 9,273 |
| I/O Node letto / scritto byte | 8192 / 0 | 0 / 0 | 0 / 0 |
| I/O PostgreSQL letto / scritto byte | 0 / 23359488 | 36864 / 24313856 | 131072 / 16023552 |
| I/O OpenSearch letto / scritto byte | 12288 / 1104494592 | 12288 / 1047384064 | 12288 / 695971840 |
| Claim / ACK s | 5,029 / 2,286 | 4,614 / 3,122 | 5,879 / 1,355 |

Il default ripetuto paga **+10,16% query**, **+18,41% CPU Node** e circa
**+37,91% WAL** rispetto al controllo ripetuto; il tempo di preparazione attivo
sale **54,237 → 68,097 s** mentre il wall-clock scende. Questi costi non sono
nascosti: il builder è invariato, ma controllo/rinnovo e contesa fra fasi hanno
un prezzo. WAL e I/O includono checkpoint/autovacuum e attività di fondo; non
attribuire ogni variazione al singolo UPDATE del lease. Nessuna regressione
funzionale osservata.

Tutti e tre i campioni ripetuti inviano **428.013.939 byte**. A 16 le letture
logiche PackStore rimangono **347.145.819 byte**, **51.923 oggetti**, **18.933
aperture** nel controllo e nel default: nessuna nuova ottimizzazione del builder.
Il report include rete ricevuta/inviata per container, byte decompressi,
estrazione HTML, query/transazioni server e payload minimi/medi/p95/massimi.
I contatori OpenSearch includono attività interna: nella serie ripetuta,
indicizzazione **77,149 / 83,708 / 91,807 s**, refresh **14,190 / 8,388 / 9,065 s**,
merge **4,743 / 5,706 / 9,424 s**. Sono contatori cumulativi sovrapponibili,
non componenti additive del tempo wall-clock.

Nel default ripetuto si osservano **96 documenti buffered**, **11,943 MiB**
di NDJSON/copie equivalenti e **376,448 MiB** di prenotazioni massime; attesa
producer **0 s**, consumer **8,499 s cumulativi**, coda **116,497 s cumulativi**,
massimo in coda **7,469 s**. Il gruppo medio dura **451,643 ms**, massimo
**8,163 s**. Con 1+2 a 64 ripetuto: **256 documenti**, **26,026 MiB** NDJSON,
**415,469 MiB** prenotati; attesa producer **0,067 s**, consumer **49,517 s
cumulativi**, coda **5,475 s cumulativi**. A 64/1+1 il producer attende
**18,243 s**: backpressure effettiva sul corpus, senza accumulo illimitato.

Il costo dominante rimane la **pubblicazione HTTP**: nel default ripetuto
**103,312 s di unione temporale su 123,936 s (83,36%)**; con 1+2/64 ripetuto
**82,457 s su 91,715 s (89,90%)**. Restano **68,097 / 55,735 s** di preparazione
attiva nei due profili. L’HTTP comprende rete e gestione della risposta; queste
misure non dimostrano una saturazione hardware assoluta di OpenSearch. Non
si aggiungono altri worker, cache, riscritture SQL o cambiamenti JVM/shard.

Configurazione normale consigliata: **batch 16, preparazione 1, pubblicazione 1**,
overlap attivo e limiti della tabella. Per reindicizzazione isolata è misurata
l’opzione **batch 64, preparazione 1, pubblicazione 2**, con gli stessi budget.
Il default dei batch rimane 16; i risultati non sostituiscono le future misure
di carico misto. Nessuna campagna P2C è stata avviata.

**Verifiche finali riuscite**: build completa, Compose valido, cinque test mirati
`text-pipeline`/`ingest-pipeline` senza skip, suite P2A/P2B.1 originali e suite
concorrente. La verifica del commit prima dell'HTTP associa ciascuna preparazione
alla sua esatta revisione claimata, evitando di confonderla con un commit passato
della stessa opera. Dopo l'ultimo riavvio PostgreSQL, nuovo confronto completo:
**11.032 hash `_source` identici**, ID/snapshot/generazioni equivalenti, cinque
ricerche identiche, tutte le code a zero e operazioni `idle`, senza errori.
Fsync, synchronous_commit e full_page_writes sono `on`; OpenSearch usa durabilità
translog `REQUEST`. Recupero delle fixture da 12 documenti: **207–300 ms** dopo
scadenza forzata nei SIGKILL e **224 ms** dopo SIGTERM, con i limiti metodologici
indicati sopra. Le fixture grandi esercitano realmente la preparazione esclusiva
su input da circa 18–19 MiB e la successiva pubblicazione recuperabile.

**P2B.2 completata; P2 non conclusa. P2C non avviata.** Nessun ingest massivo,
nessuna modifica a dump, dati di produzione, formato canonico, parser, PackStore,
bibliografia o UI. Prove private conservate in
`/mnt/sdb/palimora-p2b2-20261108`; container e rete temporanei rimossi.

## P2C — Consolidamento e benchmark end-to-end

**Stato: campagne A/B/C ed equivalenza concluse; P2 non dichiarata completata.**
Rimane una regressione interattiva sotto backlog rispetto a P1B.1, ridotta ma
non eliminata. I risultati aggregati, le configurazioni e gli esperimenti scartati
sono in `performance-p2c.json`. Nessuna fase P3 o successiva è stata avviata.

Un incidente nel runner B2 è registrato nel JSON: una modifica al file Bash in
esecuzione ha interrotto i controlli successivi al timer. Timer e campioni risorse
operativi erano già conclusi; il verificatore aggiuntivo ha sovrascritto solo il
proprio JSON. Il confronto completo è stato ripreso sulla stessa fixture isolata.
La ripetizione partita con la vecchia fixture ancora attiva è stata fermata ed
**esclusa**, poi sostituita da una nuova prova pulita. Gli script sono stati congelati
per il resto della campagna; il wrapper ora installa il cleanup prima del runner.

La revisione misurata parte da `a3518765265d8b2577c40938f98ff4e8ddcc1f61`.
L'unica correzione applicativa P2C cede il thread all'I/O, con `setImmediate`,
fra le estrazioni HTML e fra le serializzazioni NDJSON dopo circa 8 ms di lavoro.
Le promise già risolte del controllo di capacità non consentivano da sole ai
socket dell'API di avanzare. Non è uno sleep, un limite di throughput o una nuova
lane. Una singola estrazione/serializzazione resta sincrona e può superare 8 ms.
Snapshot read-only, buffer, documenti, claim e ACK conservano le proprie garanzie.
La prova con slice da 1 ms non dà un miglioramento HTTP aggiuntivo consistente:
non è stata adottata. Parser, PackStore, bibliografia e formato restano invariati.

### Metodo e integrazione

`scripts/benchmark-p2c.sh` riusa runner e verificatore P0/P1B.1. Ogni A/B parte
da PostgreSQL, Redis, OpenSearch e PackStore nuovi ed elabora solo
`queue119_archive05.zip`: 11.032 EPUB, SHA-256
`fd8e01e155c1a668c91bd86bc67cfc9b2ac3ad9da1322a35925a74c226e85429`.
A rende sequenziali ingest, catalogo e full-text; il full-text conserva il proprio
overlap interno. B usa API, ingest-worker e scheduler reali. Parser 2/commit 2,
gruppi 256, Zstd 3, libuv 8 e seeding AO3 attivo; PostgreSQL 17.6, Redis 7.4.6
AOF, OpenSearch 2.19.4 heap 1 GiB, shard 1, replica 0, refresh 1 s e translog
`REQUEST`. Fsync, synchronous commit, full-page writes e SHA-256 attivi.
Nessuna quota CPU/RAM, porta host o build/benchmark concorrente. Dump read-only.

Il timer storico B va dall'accodamento alla fine del verificatore originale;
si conserva per confrontarlo alle baseline. Il timer richiesto **dall'avvio
effettivo dell'ingest alla stessa visibilità verificata** è riportato separatamente.
Entrambi attendono ingest completato, tutte le code drenate, refresh e verifica
delle 11.032 opere tramite indice/API e lettore. Tempi attivi sovrapposti non
vengono sommati per ricavare l'end-to-end.

Il preload corregge l'intercettazione di `projectText`: dopo P2 l'export getter
richiede di avvolgere il modulo proprietario. Il normale runtime passa da
`main` allo scheduler P1A, al builder collettivo e al producer/consumer P2.
I contatori verificano zero PUT individuali e zero SQL bibliografico individuale.
Il percorso statico e i contatori completi di A e della ripetizione B2 confermano
la preparazione collettiva: il primo preload non scaricava il contatore opzionale
degli input sul SIGTERM di B; ora lo registra dopo ogni passaggio durevole.
I campioni mancanti non vengono interpretati come zero. Le connessioni di
preparazione rilasciano la propria
transazione prima dell'HTTP; PostgreSQL resta l'autorità dei claim.
Preflight/rinnovo verificano revisione, token, generazione e lease vivo; versioni
esterne monotone impediscono overwrite fuori ordine; ACK condizionati e flush
su retry incerti impediscono perdita della coda. La ricerca normale esclude
anche hit con generazione non più corrente.

Dopo il timer ogni A/B confronta **tutti gli `_source` completi** col builder P2A
sullo stesso database, già verificato contro P1B.1. Un indice temporaneo con stessi
mapping/analyzer confronta cinque query; ID ordinati esplicitamente, totali e
primi 100 risultati. Nessuna normalizzazione elimina campi. Fixture nuove hanno
legittimamente UUID/date differenti. Si verificano inoltre viste storiche,
snapshot, generazioni e otto letture storiche. La verifica originale nel timer
rimane invariata. Dopo i guasti, sulla copia con gli stessi ID, si ricontrolla
l'intero digest precedentemente verificato, oltre a query e lettore.

C usa copie fredde indipendenti dello stesso B1 verificato prima della correzione,
stessi ID/segmenti iniziali e pack read-only. P1B.1 usa l'immagine del commit
applicativo registrato in P1B.1d, con schema 039 mantenuto uguale per il confronto.
Probe autenticato originale: tre warm-up e 100 richieste sequenziali per endpoint,
ricerca/dettaglio/lettore in successione, senza gateway. Backlog bibliografico:
5.000 correnti e 5.000 viste storiche da rigenerare; backlog testo: 5.000 opere.
Si registrano code prima/dopo ogni endpoint; non si rallenta un profilo per
pareggiare artificialmente il lavoro drenato. Prima dei probe, 30 s a code vuote.

CPU e I/O usano l'inviluppo cgroup di avvio/arresto, come nelle baseline; il JSON
contiene anche la finestra interna al timer B. Working set, memoria cgroup,
RSS Node e prenotazioni applicative sono distinti. Il picco RSS PostgreSQL non
si ricava sommando pagine condivise dei backend. Host condiviso, cache filesystem
non svuotata, merge/JIT variabili: non si attribuisce causalità esclusiva alla
concorrenza. Le prove iniziali senza correzione e quelle diagnostiche restano
nel report, non vengono sostituite selettivamente dai campioni migliori.

### A — Pipeline sequenziale

| Misura, secondi | P1B.1d | P2C A |
|---|---:|---:|
| Ingest | 48,271 | 47,472 |
| Catalogo | 85,627 | 95,023 |
| Full-text | 357,110 | 128,350 |
| End-to-end | 511,889 | 295,003 |

Corrente/storico: **57,934 /
36,313 s**; refresh/verifica:
**7,540 s**. Avvii e altri intervalli del runner
spiegano il residuo. Preparazione **71,747 s**, HTTP cumulativo
**102,241 s**, **690 bulk**, **428013939 byte**.
Throughput full-text **85,952 documenti/s**;
end-to-end **37,396 opere/s**, tempo ridotto del
**42,37%**. Questo è un risultato end-to-end,
non l'estrapolazione del microbenchmark P2B.2.

### B — Runtime operativo

| Metrica | P0 B | P1A B | P1B.1 B | P2 B1 | P2 B2 |
|---|---:|---:|---:|---:|---:|
| End-to-end s, timer storico | 1474,721 | 602,783 | 434,043 | 205,916 | 191,983 |
| Opere/s visibili | 7,481 | 18,302 | 25,417 | 53,575 | 57,463 |
| Ingest s | 63,097 | 65,079 | 55,863 | 65,609 | 63,227 |
| Catalogo attivo s | 790,891 | 581,222 | 127,028 | 174,940 | 165,008 |
| Full-text attivo s | 695,075 | 464,166 | 411,849 | 183,500 | 166,345 |
| CPU totale s | 1851,926 | 1275,433 | 804,125 | 666,168 | 616,673 |
| Picco working set simultaneo MiB | 3629,102 | 3154,320 | 3266,289 | 3181,352 | 3272,785 |
| WAL byte | 1308492806 | 828938517 | 702735505 | 718428673 | 723036227 |
| Ricerca P95 backlog bibliografico ms | — | — | 194,06 / 187,46¹ | 250,50 | 229,75 |

¹ Controlli P1B.1 contemporanei sulla stessa copia, non il dato storico
**166,21 ms** di P1B.1d. Per P0/P1A manca un campione C equivalente.
P0 comprendeva 6.128 riproiezioni aggiuntive; non sono sottratte dai costi.
Il picco RAM è simultaneo, non somma di massimi osservati in istanti diversi.

Dall'avvio effettivo del lavoro: **B1 205,134 s,
53,779 opere/s; B2
190,876 s,
57,797 opere/s**. Attese iniziali:
**0,780 / 1,106 s**.
Rispetto a P1B.1 il timer storico migliora di
**2,11 / 2,26 volte**.

Ripetizione B2: timer storico **192,064 s**,
**57,439 opere/s**; timer da lavoro effettivo
**191,670 s**. Ingest
**61,428 s**, catalogo attivo
**166,590 s**, full-text attivo
**168,827 s**, **401 bulk**.
CPU **638,585 s**, working set massimo
**3417,988 MiB**, WAL
**725222825 byte**. Il JSON conserva gli altri contatori completi.
Non si converte questa variabilità in una garanzia di capacità.

| Full-text / pipeline interna | B1: 16, 1+1 | B2: 64, 1+2 |
|---|---:|---:|
| Documenti/s per secondo attivo full-text | 60,120 | 66,320 |
| Preparazione s | 114,737 | 90,072 |
| HTTP cumulativo s | 125,485 | 116,582 |
| Unione temporale HTTP s | 125,485 | 106,039 |
| Claim s | 11,604 | 8,360 |
| ACK s | 5,589 | 3,791 |
| Overlap preparazione/HTTP s | 73,920 | 46,045 |
| Overlap / wall dei passaggi produttivi % | 40,527 | 27,899 |
| Bulk | 796 | 416 |
| Byte NDJSON inviati | 428013939 | 428013939 |
| SQL client full-text | 18912 | 10529 |
| Transazioni esplicite full-text | 1716 | 1053 |
| SQL client API + ingest-worker | 75643 | 65748 |
| Producer in attesa s | 0,000 | 0,020 |
| Consumer inattivi cumulativo s | 38,552 | 141,055 |
| Attesa coda interna cumulativa s | 71,854 | 1,988 |
| Attesa interna massima s | 9,219 | 0,861 |
| Massimo documenti buffered | 64 | 200 |
| Massimo claim in memoria | 80 | 244 |
| Massimo NDJSON/copie MiB | 13,509 | 20,575 |
| Massime prenotazioni MiB | 379,649 | 386,430 |
| RSS API medio MiB | 329,421 | 354,570 |
| RSS API picco MiB | 391,859 | 455,656 |

Ogni profilo compie **11.032 claim, ACK e rinnovi validi**, senza lease scaduti,
retry, errori o riproiezioni. Tutte le code terminano a zero. I bulk operativi
possono partire parzialmente pieni: media **13,859 / 26,519
documenti/richiesta**, concorrenza HTTP massima **1 / 2**, media nei periodi HTTP
**1,000 / 1,099**.
B2 cambia sia batch sia numero di publisher: non è un'ablazione di una sola variabile.

Code correnti/storiche, picco B1/B2: **8292 /
8232**; testo **828 /
600**, sotto il high-water 2.048.
Residenza media per opera, inclusa permanenza in servizio: catalogo
**66,602 / 61,568 s**,
testo **2,982 / 1,464 s**.
Overlap ingest + catalogo + full-text: **56,753 / 53,594 s**;
catalogo + full-text, includendo quell'intervallo: **167,911 / 153,490 s**.
Sono intervalli di servizio sovrapposti, non CPU simultaneamente occupata.
Slice corrente **105,240 / 99,628 s**,
storica **68,174 / 64,072 s**.
Il maggior costo attivo catalogo rispetto a P1B.1 resta visibile: l'overlap e la
contesa non rendono più veloce ogni singolo stadio.

### Risorse B1/B2

Ogni cella riporta B1 / B2; CPU 100% = un core. Applicazione comprende API,
ingest-worker e parser, come nelle baseline.

| Container | CPU-s | CPU media % | CPU massima % | Working set medio MiB | Working set massimo MiB |
|---|---:|---:|---:|---:|---:|
| Applicazione | 286,39 / 263,77 | 135,71 / 134,55 | 393,33 / 400,29 | 886,69 / 934,74 | 1016,89 / 1088,38 |
| PostgreSQL | 178,52 / 162,01 | 84,60 / 82,65 | 271,92 / 261,92 | 346,92 / 324,11 | 453,12 / 446,36 |
| OpenSearch | 199,03 / 188,92 | 94,32 / 96,37 | 448,74 / 442,27 | 1569,19 / 1584,91 | 1740,69 / 1803,26 |
| Redis | 2,24 / 1,97 | 1,06 / 1,01 | 2,73 / 1,85 | 4,58 / 7,93 | 4,89 / 8,23 |

| Container | Disco letto MB | Disco scritto MB | Rete ricevuta MB | Rete inviata MB |
|---|---:|---:|---:|---:|
| Applicazione | 26,141 / 34,312 | 367,337 / 562,065 | 265,342 / 262,264 | 977,340 / 973,964 |
| PostgreSQL | 20,578 / 13,230 | 2453,111 / 2511,053 | 547,264 / 543,889 | 262,485 / 259,509 |
| OpenSearch | 27,161 / 29,569 | 873,062 / 1121,497 | 429,178 / 429,196 | 2,316 / 2,242 |
| Redis | 0,307 / 0,303 | 0,696 / 0,688 | 0,899 / 0,881 | 0,541 / 0,513 |

MB decimali; MiB binari. La rete interna è osservata su entrambe le estremità,
non sommarle come byte unici. I/O fisico cgroup non è lettura logica PackStore.
RSS ingest-worker medio **388,528 / 398,449 MiB**,
picco **488,172 / 497,730 MiB**.
Il JSON include anche memoria cgroup comprensiva delle pagine file e statistiche SQL.

L'indice opere conta esattamente **11.032** operazioni in ogni prova. Tempo interno
OpenSearch indexing **102,599 / 100,292 s**,
refresh **17,360 / 15,811 s**,
merge **2,178 / 3,509 s**.
Flush/throttling/rifiuti write sono riportati nel JSON; gli indici interni di nodo
non sono conteggi di riproiezioni. Translog `REQUEST` preservato.

I budget **384 MiB NDJSON e 448 MiB complessivi non sono limiti RSS/Docker**.
La prenotazione include spazio di avanzamento per documenti eccezionali; il massimo
payload ordinario osservato è molto inferiore al budget. Non si abbassa quel margine
sulla base di un corpus senza grandi eccezioni e non lo si aumenta per aggiungere lane.

### C — Latenze e regressione residua

Ogni cella è **P50 / P95 in ms**, 100 richieste. Il controllo contemporaneo P1B.1
usa le stesse copie; le latenze storiche P1B.1d sotto backlog erano ricerca
105,16/166,21, dettaglio 22,09/36,20, lettore 32,12/50,60 ms.

| Profilo / carico | Ricerca | Dettaglio | Lettore |
|---|---:|---:|---:|
| P1B.1 code vuote | 78,73 / 115,85 | 15,14 / 28,31 | 20,17 / 29,04 |
| P1B.1 corrente + storico | 118,12 / 194,06 | 22,95 / 40,48 | 40,21 / 66,22 |
| P1B.1 full-text | 94,99 / 180,41 | 21,93 / 36,74 | 31,27 / 54,44 |
| P2 B1 code vuote | 92,69 / 143,20 | 16,01 / 25,07 | 23,11 / 35,28 |
| P2 B1 corrente + storico | 148,62 / 250,50 | 25,62 / 74,72 | 54,07 / 122,24 |
| P2 B1 full-text | 142,92 / 259,67 | 21,57 / 59,42 | 28,52 / 108,01 |
| P2 B2 code vuote | 84,44 / 135,99 | 17,46 / 27,99 | 24,36 / 41,47 |
| P2 B2 corrente + storico | 133,68 / 229,75 | 24,96 / 102,94 | 35,34 / 133,71 |
| P2 B2 full-text | 161,06 / 339,51 | 26,08 / 140,77 | 30,01 / 159,63 |

| Profilo / backlog | Correnti drenati | Storici drenati | Testi drenati |
|---|---:|---:|---:|
| legacy / bibliography | 1200 | 1200 | 295 |
| legacy / text | 0 | 0 | 330 |
| b1 / bibliography | 1260 | 1260 | 1240 |
| b1 / text | 0 | 0 | 1760 |
| b2 / bibliography | 1280 | 1280 | 1260 |
| b2 / text | 0 | 0 | 2432 |

Il testo drenato include i nuovi accodamenti prodotti dal catalogo: non è solo
la diminuzione netta della coda. I conteggi per singolo endpoint sono nel JSON.
L'indicizzazione più rapida produce più lavoro e più contesa durante lo stesso
probe; questo limita l'attribuzione causale ma non annulla la regressione percepita.

Prima della correzione la ripetizione B2 con backlog testo aveva ricerca P95
**391,72 ms** e lettore **227,23 ms**, contro 397,29/179,78 nel primo campione.
La versione consolidata misura **339,51 / 159,63 ms**. Il massimo ritardo event-loop
osservato passa da **333,97 ms** a **120,59 ms** nella finestra ricerca B2;
un singolo encoding resta capace di occupare **56,33 ms**. Nel profilo B1,
con backlog bibliografico, il massimo event-loop durante il lettore passa da
**104,33 a 46,86 ms**, ma il P95 HTTP non migliora coerentemente
(97,55 ms nel controllo ripetuto, 122,24 ms consolidato).
Non si attribuisce tutta la latenza all'event-loop né si considera il problema risolto.

Nel probe B2 testo consolidato, 100 richieste OpenSearch della ricerca, misurate
dal client fino agli header e quindi soggette anche alle attese Node, hanno
media **92,52 ms**, contro media API **176,18 ms**. La differenza delle medie
include PIT, SQL, API e attese; non si sottraggono percentili marginali per
inventare componenti di latenza. Nella stessa finestra OpenSearch indicizza
**1.408** opere e accumula **324 ms** di GC osservato: quel solo GC non spiega
l'intera coda delle latenze. CPU condivisa, pubblicazione e SQL restano concorrenti.

A code vuote lo scheduler compie circa un passaggio al secondo per fase,
come configurato, senza busy-loop. Nei 30 s dopo readiness, la CPU media del container applicativo è
**8,89%** nel controllo P1B.1, **10,71%** in B1 e **11,07%** in B2
(campioni bibliografici); la finestra può includere JIT/inizializzazione.
Il report conserva anche gli altri container e il numero dei passaggi. Non si afferma consumo
zero: polling e bookkeeping hanno un costo anche quando non ci sono documenti.

### Equivalenza, recovery e decisione operativa

Tutte le nuove A/B, la ripetizione e la verifica post-guasti hanno 11.032 opere,
snapshot, documenti catalogo, viste storiche e documenti OpenSearch; generazioni,
snapshot e hash completi coincidono col riferimento. Cinque query e lettore
passano; 107.054 oggetti canonici verificati dopo i guasti; nessuna coda residua.
Le regressioni critiche P2B.2/P2A sono riusate senza indebolirle: snapshot
indipendenti, nessuna transazione propria durante HTTP, invalidazione durante
preparazione/attesa, lease rinnovato/scaduto, versioni fuori ordine, errore parziale
mentre un altro bulk riesce, 429/503, perdita connessione PG, SIGKILL producer/
HTTP/prima dell'ACK, SIGTERM, pausa/ripresa e flush prima dell'ACK su retry incerto.
Il nuovo controllo esercita ricerca normale e scheduler nelle modalità di manutenzione.

Recupero fixture 12 opere dopo expiry forzata: producer **137,56 ms**,
HTTP **262,19 ms**, prima ACK **210,22 ms**; SIGTERM **230,73 ms** senza forzatura.
Non sono tempi comprensivi dei cinque minuti di lease naturale. Ricreazione indice,
oggetti grandi/corrotti e casi bibliografici complessi restano coperti dalle suite
P2A/P2B.1/P2B.2 già passate: codice relativo invariato, non duplicate integralmente.
Build completa e cinque test mirati pipeline/ingest passati.

Per uso interattivo si conserva **16 / preparazione 1 / pubblicazione 1**;
per ingest/reindicizzazione senza priorità alla latenza, **64 / 1 / 2** è un'opzione
misurata, non il nuovo default. Budget e configurazione OpenSearch invariati.
La presenza della regressione impedisce di promuovere B2 a default interattivo
oppure dichiarare P2 interamente chiusa.

### Limite dominante e seguito giustificato

B1: ultimo commit canonico a **66,152 s**, ultima slice corrente a **188,489 s**, storica a **188,541 s**, full-text a **193,457 s** dall'accodamento.
B2: ultimo commit canonico a **63,734 s**, ultima slice corrente a **177,910 s**, storica a **178,039 s**, full-text a **181,423 s** dall'accodamento.
B2 ripetuto: ultimo commit canonico a **61,550 s**, ultima slice corrente a **179,609 s**, storica a **179,639 s**, full-text a **181,867 s** dall'accodamento.

Questi estremi, le code e l'overlap nel JSON identificano il percorso critico:
il canonico finisce molto prima; catalogo corrente/storico e full-text avanzano
in contesa e chiudono vicini, oppure resta una breve coda testo nel default.
Il profilo 64/1+2 non mantiene due publisher pieni perché il catalogo fornisce
nuovi documenti più lentamente. Non è evidenza di saturazione globale dei 14 CPU
dell'host: serialità dello scheduler/catalogo e CPU condivisa dell'API limitano
il lavoro sfruttabile. Neppure i 120,29 documenti/s del full-text isolato P2B.2
rappresentano la capacità end-to-end.

Il prossimo intervento motivato dai numeri è analizzare la contesa del catalogo
corrente/storico con il lavoro CPU full-text nel processo API e progettare, in una
fase autorizzata, un'esecuzione che protegga le richieste interattive senza limitare
artificialmente l'indicizzazione. Occorre separare costo bibliografico, attesa SQL
e occupazione del thread prima di scegliere la modifica. Non è giustificato
anticipare parallelismo fra ZIP o riscrittura canonica per accelerare questo
percorso: l'ingest è già terminato mentre le proiezioni continuano. Il target
2.000 opere/s rimane lontano e non è attestato da questa campagna.

### Riproduzione

```sh
# Costruire una sola volta, prima delle prove; conservare il dist P2A di riferimento.
docker build -f infra/Dockerfile --target api -t palimora-p2c-api .
RELEASE_BENCH_ROOT=/mnt/sdb/palimora-p2c-new-b1 \
 RELEASE_IMAGE=palimora-p2c-api P0_SCENARIO=B \
 P2C_REFERENCE_DIST=/percorso/privato/p2a/apps/api/dist \
 PROJECTION_TEXT_BATCH=16 PROJECTION_TEXT_PUBLISH_LANES=1 \
 ./scripts/benchmark-p2c.sh
# A: P0_SCENARIO=A. B2: batch64/publish2. Ogni root deve essere nuova.
python3 scripts/summarize-p2c.py /mnt/sdb/palimora-p2c-new-b1
# C: clonare una fixture verificata e fermata; root nuova a ogni invocazione.
P2C_SOURCE=/mnt/sdb/palimora-p2c-new-b1 P2C_ROOT=/mnt/sdb/palimora-p2c-new-c \
 P2C_IMAGE=palimora-p2c-api P2C_EVENT_LOOP=1 \
 BENCH_LATENCY_TEXT_ONLY=0 BENCH_REGENERATE_HISTORY=1 \
 BENCH_REQUIRE_BIBLIOGRAPHY_BACKLOG=1 ./scripts/benchmark-p2c-latency.sh
# Solo testo: TEXT_ONLY=1, REGENERATE_HISTORY=0, REQUIRE_BIBLIOGRAPHY_BACKLOG=0.
```

Le directory private e gli ID immagine sono nel JSON; container/reti temporanei
rimossi, fixture conservate. Nessun contenuto delle opere o dato account pubblicato.

## P2D — Isolamento delle proiezioni e latenza interattiva (2026-11-09)

Implementato il ruolo Node `projection-worker.ts`, senza server HTTP, sulla stessa
immagine API. Riusa `startProjections(projectCatalog, projectText)` e quindi
`runProjection`, scheduler P1A, motori P1B.1/P2B.1/P2B.2 e protocollo P2A. Nessun
cambiamento a contenuti, mapping, code, parser o PackStore. API e worker hanno event
loop e pool PostgreSQL distinti. In modalità `isolated` l’API non avvia lo scheduler;
tutti i probe confermano zero chiamate di proiezione nel processo HTTP.

Compose configura API isolata e ruolo `projection`, con bind PackStore/secret read-only,
sola rete interna, nessuna porta, protezioni Docker esistenti, restart e grazia di 60 s.
L’avvio attende API/schema, PostgreSQL e OpenSearch; il worker verifica anche schema e
disponibilità search. `.env.example` espone modalità e risorse; override dev senza
quote. Modalità inline compatibile e rollback documentati in
[02](02-architettura.md#motore-di-consultazione). Il collector osserva il nuovo ruolo;
amministrazione, pause e manutenzione restano nell’API.

### Metodo e perimetro

Stessa immagine aggiornata per controllo inline B1, isolato B1 (16/1/1) e isolato B2
(64/1/2). Corpus reale di 11.032 opere, parser 2/commit 2, gruppi 256, Zstd 3 e seeding
AO3; PostgreSQL 17.6, Redis 7.4.6, OpenSearch 2.19.4/heap 1 GiB. Nessuna quota CPU/RAM,
build o benchmark concorrente; host condiviso. Il processo aggiuntivo ha heap/pool
propri: il suo costo è incluso. Le quote Compose di produzione (projection 2 CPU/1536m)
non sono applicate nelle prove e non sono una redistribuzione delle quote API. Non
ripetuta A, non avviato ingest massivo.

Il timer B include accodamento, ingest, catalogo, testo, refresh e verifica della
visibilità con code vuote. Anche il tempo dall’inizio effettivo ingest è riportato. Il
confronto completo col vecchio builder segue il timer. Le risorse container includono
avvio/arresto; il JSON contiene anche la finestra limitata al timer. Tempi attivi
sovrapposti non vengono sommati per derivare il wall-clock.

### End-to-end e risorse

| Metrica | Inline B1 | Isolato B1 | Isolato B2 |
|---|---:|---:|---:|
| Accodamento → visibilità s | 209.446 | 191.227 | 193.010 |
| Inizio ingest → visibilità s | 208.960 | 190.545 | 192.633 |
| Opere/s end-to-end | 52.672 | 57.691 | 57.158 |
| Ingest s | 65.710 | 62.796 | 71.616 |
| Catalogo attivo s | 179.586 | 165.428 | 167.079 |
| Corrente attivo s | 108.895 | 100.029 | 100.039 |
| Storico attivo s | 69.236 | 63.928 | 65.106 |
| Full-text attivo s | 186.221 | 169.411 | 169.936 |
| Preparazione s cumulativi | 118.438 | 106.319 | 89.782 |
| HTTP bulk s cumulativi | 125.992 | 114.917 | 121.204 |
| ACK s cumulativi | 5.550 | 5.695 | 3.069 |
| Bulk | 770 | 802 | 376 |
| CPU totale s (inviluppo container) | 676.359 | 660.075 | 662.900 |
| Picco working set aggregato MiB | 3247.641 | 3281.055 | 3248.246 |
| WAL MiB | 690.949 | 688.425 | 692.515 |
| I/O lettura MiB (timer) | 111.531 | 65.574 | 53.859 |
| I/O scrittura MiB (timer) | 4217.957 | 3684.129 | 3724.270 |
| Rete RX MiB (somma interfacce) | 1184.553 | 1184.027 | 1178.980 |
| Rete TX MiB (somma interfacce) | 1184.552 | 1184.025 | 1178.976 |
| Memoria applicativa prenotata massima MiB | 379.956 | 372.871 | 405.752 |
| NDJSON buffered massimo MiB | 14.446 | 11.573 | 25.772 |
| Documenti buffered massimi | 64 | 64 | 180 |

Budget applicativi invariati: 384 MiB NDJSON e 448 MiB complessivi; non sono limiti RSS.
I/O usa la finestra end-to-end, dove tutti i contatori sono disponibili: il primo
campione prima dell’avvio projection nell’inviluppo generale è nullo. I/O cgroup misura
operazioni fisiche osservate, non tutte le letture logiche dei pack in cache; sommare
RX/TX fra container conta entrambe le estremità. Dettagli CPU media/massima, RSS e
working set per processo/container, SQL, code, residenza, overlap, refresh/merge/flush e
concorrenza nel [JSON aggregato](performance-p2d.json).

| Profilo | CPU API / projection s¹ | RSS API / projection picco MiB¹ | CPU PG / OpenSearch s² |
|---|---:|---:|---:|
| inline-b1 | 149.53 / 0.00 | 394.49 / 0.00 | 179.46 / 204.18 |
| isolated-b1 | 13.07 / 136.72 | 168.28 / 287.93 | 173.37 / 194.35 |
| isolated-b2 | 14.48 / 131.94 | 208.46 / 289.90 | 171.37 / 197.50 |

¹ Campioni Node nella finestra end-to-end; zero projection separato nel controllo
inline. ² Inviluppo container, inclusi avvio/arresto. Non sommare campioni con perimetri
differenti.

### Latenze autenticate ed event loop

Clone della stessa fixture P2C B1, 5.000 lavori corrente+storico oppure 5.000 full-text,
tre warmup e 100 richieste sequenziali per endpoint, senza gateway. La seconda coppia
full-text inverte l’ordine isolato/inline. Nessun rallentamento artificiale. Ogni
finestra registra code iniziali/finali e lavoro drenato: percentili sotto quantità
diverse di lavoro non sono esperimenti a contesa identica.

Valori P50/P95 in ms. `work` è il dettaglio opera.

| Prova | Condizione | Ricerca | Dettaglio | Lettore |
|---|---|---:|---:|---:|
| inline-b1-bibliography | code vuote | 78.85/118.92 | 17.20/27.15 | 30.28/42.84 |
| inline-b1-bibliography | backlog | 121.09/192.86 | 33.81/70.88 | 49.86/138.18 |
| isolated-b1-bibliography | code vuote | 80.38/137.74 | 15.58/22.65 | 27.88/50.29 |
| isolated-b1-bibliography | backlog | 147.40/264.82 | 23.01/35.23 | 35.37/59.37 |
| inline-b1-text | code vuote | 80.18/126.26 | 15.55/22.39 | 22.79/37.59 |
| inline-b1-text | backlog | 126.47/207.99 | 26.41/87.11 | 40.98/117.60 |
| isolated-b1-text | code vuote | 85.17/137.49 | 13.61/21.21 | 17.55/26.10 |
| isolated-b1-text | backlog | 125.10/215.10 | 23.89/37.69 | 32.01/53.69 |
| isolated-b1-text-repeat | code vuote | 81.04/119.01 | 13.40/19.40 | 24.65/39.76 |
| isolated-b1-text-repeat | backlog | 127.19/222.11 | 21.27/36.92 | 31.78/48.21 |
| inline-b1-text-repeat | code vuote | 85.21/151.12 | 9.97/17.41 | 25.06/35.59 |
| inline-b1-text-repeat | backlog | 157.67/255.00 | 25.43/67.25 | 43.76/137.35 |
| isolated-b2-bibliography | code vuote | 88.82/166.67 | 14.02/20.95 | 22.94/35.55 |
| isolated-b2-bibliography | backlog | 126.24/218.19 | 21.68/36.38 | 29.19/44.34 |
| isolated-b2-text | code vuote | 72.47/120.88 | 13.98/20.53 | 30.03/45.51 |
| isolated-b2-text | backlog | 128.25/233.59 | 18.03/29.73 | 36.36/60.70 |

| Prova backlog | Drenati corrente / storico / testo | API event loop max ricerca / dettaglio / lettore ms | OS ricerca P95 client ms |
|---|---:|---:|---:|
| inline-b1-bibliography | 1100 / 1100 / 1080 | 50.89 / 40.80 / 42.76 | 125.86 |
| isolated-b1-bibliography | 1160 / 1160 / 1140 | 48.04 / 18.19 / 20.32 | 186.18 |
| inline-b1-text | 0 / 0 / 1712 | 39.06 / 60.19 / 39.98 | 129.30 |
| isolated-b1-text | 0 / 0 / 1424 | 23.79 / 16.78 / 20.15 | 164.09 |
| isolated-b1-text-repeat | 0 / 0 / 1312 | 38.99 / 30.67 / 14.65 | 172.53 |
| inline-b1-text-repeat | 0 / 0 / 1840 | 66.39 / 38.90 / 39.49 | 163.23 |
| isolated-b2-bibliography | 1140 / 1140 / 1080 | 27.43 / 32.29 / 14.69 | 160.57 |
| isolated-b2-text | 0 / 0 / 2112 | 32.46 / 17.91 / 30.24 | 176.14 |

Event-loop: campionamento a risoluzione 10 ms, statistiche per secondo; mediana/massimo
dei P95 delle finestre nel JSON, non un percentile globale ricostruito. SQL e attesa
pool sono durate client cumulative anche sovrapposte. Le classi di attesa PostgreSQL
sono campionate a 1 Hz: l’assenza di blocchi osservati non esclude attese brevi. HTTP
OpenSearch misura fino agli header, include scheduling/network e non equivale al solo
tempo server.

### Integrità e recovery

Tutte le tre B verificano 11.032 opere, snapshot, documenti catalogo, viste storiche e
documenti OpenSearch, identità/generazioni e hash completi del vecchio builder sul
medesimo database. Le nuove importazioni hanno UUID/timestamp propri: non si confrontano
digest fra identità differenti. La fixture C dopo i guasti coincide anche col digest P2C
salvato. Cinque ricerche di riferimento, otto campioni del lettore storico e code vuote
verificati. Il verificatore canonico conferma 107.054 oggetti in 54 pack.

Passano: API-only con lavori pendenti e letture disponibili; due worker; SIGTERM/SIGINT;
attesa del batch SQL atomico; pause/manutenzione; SIGKILL dopo HTTP accettato prima ACK;
perdita leader con vecchia risposta trattenuta e nuovo proprietario; transizioni
inline↔isolato; riavvio reale container projection e PostgreSQL. Suite P2B.2/P2A riusate
per invalidazioni, lease, risposte parziali, 429/503, crash producer/HTTP/pre-ACK, retry
e fencing. Nessuna modifica ai motori relativi.

Recupero del nuovo processo dopo expiry forzata: SIGKILL 1,165 s; PostgreSQL dopo ready 2,014 s. Non includono il lease naturale di cinque minuti. Build completa e sei test mirati passati; Compose base/dev verificati.


### Diagnosi, limiti residui e configurazione

Il controllo usa lo stesso codice e la stessa diagnostica dell'isolato: **209,446 s**
contro **191,227 s** per B1 isolato, −8,70% wall-clock e +9,53% opere/s.
P2C B1 aveva misurato 205,916 s senza la diagnostica P2D aggiuntiva: è un riferimento
storico, non il controllo causale di questa prova. B2 isolato richiede 193,010 s,
+0,93% rispetto a B1: una singola passata non dimostra una differenza statisticamente
significativa, né giustifica cambiare il default. Rispetto ai 434,043 s P1B.1,
B1 isolato misura 2,270× il throughput end-to-end, sul solo corpus di riferimento.

La normalizzazione e l'assemblaggio bibliografico, l'estrazione HTML e la
serializzazione NDJSON sono lavoro sincrono nel processo che ospita le proiezioni.
Nella prima finestra di ricerca con backlog testo, l'API inline registra
**1,199 s HTML + 0,760 s NDJSON**, contro zero nell'API isolata; questi contatori
non rappresentano tutta la CPU delle proiezioni. La CPU API nell'intera B scende
149,53 → 13,07 s, mentre il nuovo worker ne usa 136,72. Il massimo RSS di processo
rilevato con `resourceUsage`, inclusa la fase iniziale, è API/projection:
**414,98/— MiB** inline, **224,53/299,89 MiB** isolato B1,
**226,51/300,97 MiB** isolato B2. I picchi campionati nella tabella precedente
hanno un perimetro diverso e possono essere inferiori.

A code vuote il worker projection consuma circa **2,81% B1 / 2,80% B2 di un core**
nelle finestre di 30 s delle prove testo; mantiene il polling P1A a un secondo,
senza un nuovo busy-loop. La duplicazione di heap/pool ha un costo reale,
non mascherato dai budget NDJSON; la finestra generale dei container misura
+33,41 MiB di working set massimo B1 isolato rispetto al controllo.

**A — Effetto sul thread HTTP:** la riduzione P95 di dettaglio e lettore è
riproducibile. Prima coppia full-text: 87,11 → 37,69 ms e 117,60 → 53,69 ms;
ripetizione: 67,25 → 36,92 ms e 137,35 → 48,21 ms. Nella prima coppia,
event-loop API massimo ricerca/dettaglio/lettore passa da
39,06/60,19/39,98 a 23,79/16,78/20,15 ms. Il worker isolato registra invece
51,35/44,07/68,88 ms: il lavoro resta misurabile sul suo event loop.
Nella ripetizione la mediana dei P95 per secondo dell'API durante ricerca scende
22,34 → 12,77 ms; non è un P95 globale.

**B — Regressione rispetto a P1B.1:** la ricerca resta aperta. P95 full-text
inline/isolato: 207,99/215,10 ms, poi 255,00/222,11 ms. Non c'è una riduzione
riproducibile in entrambe le coppie. Il riferimento P1B.1 raccolto in P2C è
180,41 ms sul testo e 194,06 ms sul bibliografico; B1 isolato bibliografico
registra 264,82 ms. Sono carichi drenati differenti: P1B.1 indicizzava 330 documenti
durante il probe testo, contro 1.424 e 1.312 nei due probe B1 isolati. La parità
sotto contesa equivalente non è dimostrata; non si dichiarano percentili storici
causalmente equivalenti né una regressione interamente imputabile al thread HTTP.

Nella prima coppia bibliografica la CPU API durante ricerca scende dal 92,84%
al 28,52% di un core, ma la media HTTP OpenSearch sale 75,74 → 105,10 ms;
indicizzazione/refresh/merge osservati nella finestra OpenSearch passano da
4,323/2,897/0 s a 9,040/5,175/2,760 s, su finestre di 13,142 e 16,242 s e lavoro
differente. Nella coppia testo ripetuta OpenSearch usa circa quattro core medi
in entrambe le prove e la media HTTP passa 93,33 → 88,00 ms, mentre CPU API
81,29% → 30,60%. Il campionamento PG non osserva connessioni bloccate in queste
finestre. L'evidenza indica la latenza esterna OpenSearch come limite residuo
rilevante; non prova saturazione dell'intero host, né esclude attese PG brevi,
GC o altri effetti condivisi.

Il percorso critico end-to-end rimane catalogo corrente/storico con full-text:
ultimo commit canonico / fine corrente / fine storico / fine testo, in secondi
dall'accodamento:

| Profilo | Canonico | Corrente | Storico | Testo |
|---|---:|---:|---:|---:|
| inline-b1 | 65.640 | 192.357 | 192.426 | 196.885 |
| isolated-b1 | 63.003 | 178.517 | 178.610 | 179.385 |
| isolated-b2 | 71.536 | 180.309 | 180.370 | 182.326 |

B2 dimezza i bulk senza accorciare questo percorso nella prova operativa.
La configurazione raccomandata è **API isolata, batch 16, preparazione 1,
pubblicazione 1**, con budget invariati. B2 resta un'opzione esplicita per contesti
senza priorità interattiva; questa campagna non giustifica promuoverlo a default.
Il prossimo approfondimento è profilare la contesa search/indexing OpenSearch e
il costo SQL delle richieste a carico osservato, prima di proporre tuning.
Nessun intervento ulteriore è implementato; nessuna evidenza autorizza anticipare
parallelismo fra ZIP o riscrittura canonica.

**P2D completata, con regressione residua della ricerca. P2 complessiva aperta.**
L'isolamento del ruolo, il recupero, l'integrità e il costo end-to-end sono verificati;
non è attestata la risoluzione di tutte le latenze interattive rispetto a P1B.1.

### Riproduzione P2D

```sh
# Una sola build prima dei benchmark; conservare il dist P2A di riferimento.
docker build -f infra/Dockerfile --target api -t palimora-p2d-api .
RELEASE_BENCH_ROOT=/mnt/sdb/palimora-p2d-new-b1 \
 RELEASE_IMAGE=palimora-p2d-api P0_SCENARIO=B \
 BENCH_PROJECTION_MODE=isolated \
 BENCH_NODE_OPTIONS=--require=/app/scripts/performance-p2d.cjs \
 P2D_DIAGNOSTICS=1 P2C_EVENT_LOOP=1 \
 P2C_REFERENCE_DIST=/percorso/privato/p2a/apps/api/dist \
 PROJECTION_TEXT_BATCH=16 PROJECTION_TEXT_PUBLISH_LANES=1 \
 ./scripts/benchmark-p2c.sh
# Controllo: BENCH_PROJECTION_MODE=inline. B2: batch 64 / publish 2.
python3 scripts/summarize-p2d.py /mnt/sdb/palimora-p2d-new-b1
# C riusa benchmark-p2c-latency.sh, con fixture P2C B1 fermata e root nuova.
# Stessi flag di modalità/strumentazione sopra; impostare P2C_SOURCE/P2C_ROOT/P2C_IMAGE.
# Bibliografia: BENCH_LATENCY_TEXT_ONLY=0, BENCH_REGENERATE_HISTORY=1,
# BENCH_REQUIRE_BIBLIOGRAPHY_BACKLOG=1. Testo: rispettivamente 1, 0, 0.
# P2D_ROLE_TESTS=1 e P2C_RECOVERY=1 aggiungono le regressioni dopo il timer,
# con P2C_REFERENCE_DIST impostato; mai contro dati o container di produzione.
```

Il report JSON conserva configurazioni, immagine, checksum dei sorgenti runtime,
radici delle evidenze, code per endpoint e limiti della strumentazione. Le fixture
private restano sul disco; tutti i container e le reti temporanee sono rimossi.

## P2E.1 — Prima raccolta diagnostica, fase incompleta

Aggiunto `scripts/performance-search-spans.cjs`, preload esplicito per database
`_test`; il runtime normale non lo carica. Correla tramite AsyncLocalStorage le
query PostgreSQL client e le chiamate OpenSearch alla medesima richiesta HTTP,
separando header, lettura JSON e `took`. Non registra SQL, query, contenuti,
credenziali o identificativi PIT. Non modifica query o risposte.

Una prova esplorativa riusa la fixture P2C B1, API isolata e projection 16/1/1,
con 5.000 lavori testo. Le cento richieste misurate per condizione producono:

| Media per richiesta, ms | Code vuote | Backlog testo |
|---|---:|---:|
| HTTP server fino a finish | 88,05 | 131,48 |
| PostgreSQL client cumulativo | 10,06 | 14,68 |
| Stato indice, fino agli header | 3,81 | 4,44 |
| Apertura PIT, fino agli header | 8,39 | 11,71 |
| Ricerca OpenSearch, fino agli header | 54,52 | 86,77 |
| `took` OpenSearch | 47,47 | 78,23 |

`took` è contenuto nella durata client: non va sommato. Le durate SQL includono
trasporto e scheduling, non sono tempi server puri. Nessuna sottrazione di
percentili indipendenti. Dati e limiti in [performance-p2e1.json](performance-p2e1.json).

Il probe crea 104 PIT per invocazione (setup, tre warmup, cento prime pagine),
208 nelle due condizioni, e li conserva fino alla pulizia finale. Il frontend
usa cursor per paginare e refetch ogni due secondi quando `indexing=true`;
quindi può anch'esso aprire ripetutamente PIT, ma con frequenza diversa dal probe
sequenziale. Il costo di questa differenza non è ancora misurato.

Build completa passata. Il probe autenticato originale passa per ricerca,
dettaglio e lettore; 208 ricerche tracciate senza errori e code finali vuote.
Verificati anche assenza di wrapper quando disattivato e rifiuto di database
non di test. Nessun motore o contratto di prodotto modificato.

**P2E.1 non completata.** Mancano ablazioni, carico equivalente, ripetizioni,
span fini di costruzione/verifica/serializzazione, correlazione completa delle
risorse OpenSearch e misura del ciclo PIT. Questa raccolta non dimostra un
collo di bottiglia dominante e non seleziona un intervento P2E.2. P2 resta aperta.

Per abilitare la raccolta, aggiungere esplicitamente il preload a `NODE_OPTIONS`
della sola fixture API; destinazione default `/results/search-spans.jsonl`,
oppure `P2E_SEARCH_SPANS` con percorso privato. Gli span iniziano alla ricezione
Node e terminano a `finish`, che non equivale alla ricezione sul client.



## P2E.1a — Ablazioni query e PIT (2026-11-09)

**P2E.1a completata. P2E.1 complessiva e P2 restano aperte.** Nessuna modifica
applicativa, alle proiezioni, ai documenti, al mapping o alla durabilità.
La raccolta esplorativa P2E.1 e il relativo preload rimangono invariati.

Il runner cattura la query effettiva di `searchWorks(db, {})`: dieci facet,
`track_total_hits=true`, tre ordinamenti, PIT e generazione in docvalues.
Le ablazioni operano soltanto su copie nel runner. Il preload esistente traccia
anche il probe HTTP autenticato originale a code vuote, prima delle ablazioni.
Le misure seguenti sono chiamate dirette OpenSearch, non latenze API complete.

Due fixture indipendenti clonano lo stesso PostgreSQL/indice P2C B1 fermato e
usano gli stessi pack readonly: 11.032 opere. Stessa immagine P2D, PostgreSQL 17.6,
OpenSearch 2.19.4/heap 1 GiB, Redis 7.4.6, nessuna quota CPU/RAM, nessuna build
concorrente. API e projection sono processi Node distinti nel container della
fixture; il worker mantiene 16/1/1. Non viene avviato ingest.

Ogni variante ha 103 richieste: tre warmup prestabiliti e cento misurate.
L'ordine è invertito nella seconda fixture. Prima di ogni esperimento backlog
si accodano 2.000 opere e si riprende il worker senza limiti artificiali; la prova
successiva attende il drenaggio. I contenuti reindicizzati sono identici, ma
segmenti/cache/merge evolvono fra esperimenti: l'inversione d'ordine non rende
identico il carico. Il throughput include warmup, apertura PIT e campionamenti,
ma esclude la chiusura finale. I campioni grezzi, inclusi gli outlier, sono
conservati nelle radici private indicate nel [report](performance-p2e1a.json).

### Latenze e throughput concorrente

Client include ricezione e parsing del corpo; `took` è tempo server incluso
nella latenza client, non CPU e non additivo. Valori P50/P95 in ms; nessuna
sottrazione di percentili indipendenti per attribuire il costo di una fase.
`full-retain` è la query originale; `simple-sort` usa solo `id asc` e cambia
semantica. Le altre ablazioni mantengono filtri, pagina e ordinamento originali.

| Passata | Carico | Variante | Client P50/P95 | took P50/P95 | Indicizzati/s nella finestra |
|---|---|---|---:|---:|---:|
| forward | idle | full-retain | 42.49/78.54 | 36/69 | 0.00 |
| forward | idle | no-aggs | 19.25/27.57 | 14/21 | 0.00 |
| forward | idle | no-total | 43.03/63.27 | 37/56 | 0.00 |
| forward | idle | simple-sort | 32.11/53.16 | 28/48 | 0.00 |
| forward | idle | full-close | 35.33/58.56 | 31/54 | 0.00 |
| forward | idle | full-reuse | 38.25/60.78 | 34/52 | 0.00 |
| forward | backlog | full-retain | 54.92/108.03 | 49/95 | 57.31 |
| forward | backlog | no-aggs | 18.50/29.78 | 15/25 | 49.69 |
| forward | backlog | no-total | 59.36/113.51 | 54/108 | 79.35 |
| forward | backlog | simple-sort | 45.91/85.36 | 41/76 | 90.58 |
| forward | backlog | full-close | 57.39/97.04 | 52/92 | 91.59 |
| forward | backlog | full-reuse | 45.60/74.34 | 41/69 | 84.82 |
| reverse | idle | full-reuse | 40.25/64.27 | 33/57 | 0.00 |
| reverse | idle | full-close | 40.73/61.77 | 34/55 | 0.00 |
| reverse | idle | simple-sort | 32.31/53.09 | 27/47 | 0.00 |
| reverse | idle | no-total | 38.55/65.50 | 34/60 | 0.00 |
| reverse | idle | no-aggs | 16.37/21.30 | 12/17 | 0.00 |
| reverse | idle | full-retain | 37.62/60.30 | 33/52 | 0.00 |
| reverse | backlog | full-reuse | 51.89/94.70 | 46/90 | 65.40 |
| reverse | backlog | full-close | 54.41/102.65 | 49/96 | 84.88 |
| reverse | backlog | simple-sort | 57.07/103.96 | 52/98 | 75.21 |
| reverse | backlog | no-total | 49.66/101.39 | 46/96 | 85.98 |
| reverse | backlog | no-aggs | 16.65/25.61 | 13/19 | 56.21 |
| reverse | backlog | full-retain | 73.90/168.02 | 68/162 | 79.01 |

### Componenti della query

- **Facet:** a vuoto la media client completa/senza facet è 46,72/19,83 ms
  nell'ordine diretto e 40,19/16,44 ms nell'inverso; `took` 40,29/14,51 e 35,56/12,43 ms.
  È il costo intrinseco più grande e ripetibile osservato per questa query.
  Sotto backlog le medie client sono 62,05/20,14 e 86,22/17,91 ms, con `took`
  54,98/15,73 e 80,45/13,89 ms. Il miglioramento riguarda anche il server, ma
  la sua dimensione sotto carico non è una stima a throughput equivalente.
- **Conteggio completo:** medie client a vuoto 46,72→45,68 e 40,19→40,77 ms;
  nessun beneficio stabile rilevante. Sotto backlog 62,05→67,82 e 86,22→57,43 ms:
  variabilità, segmenti e lavoro concorrente impediscono attribuzioni isolate.
- **Sort:** medie a vuoto 34,82/34,96 ms contro 46,72/40,19 ms della query completa.
  Cambiano gli ID ordinati restituiti: non è una sostituzione equivalente.
- **Risposta:**21 hit in ogni query; circa 9.975 byte con query completa,
  5.682 senza facet, 9.935 senza conteggio e 9.492 con sort semplificato.
  Sono byte UTF-8 del corpo, non traffico totale di rete. Senza conteggio manca
  `total`; senza facet mancano le aggregazioni. Nessuna modifica al contratto API.

Tutte le varianti salvo il sort semplificato preservano gli stessi 21 ID ordinati
nelle prove. Questo corpus reindicizza gli stessi contenuti: non dimostra parità
di freschezza tra PIT differenti in presenza di aggiornamenti reali.

### PIT: apertura, chiusura e contesti

| Passata/carico | Conservati: apertura media ms | Chiusura batch 103 ms | Chiusura immediata: apertura/chiusura medie ms | Riuso: unica apertura/chiusura ms |
|---|---:|---:|---:|---:|
| forward/idle | 5.92 | 6.31 | 5.21/3.38 | 2.65/2.92 |
| forward/backlog | 5.64 | 12.23 | 6.10/4.32 | 3.57/5.33 |
| reverse/idle | 3.66 | 5.35 | 6.40/4.19 | 6.74/3.24 |
| reverse/backlog | 5.41 | 29.74 | 7.13/5.24 | 4.77/5.55 |

Il numero di contesti passa **0→103→0** conservando i PIT e **0→1→0**
riusandone uno. Con chiusura immediata i campioni presi dopo ogni chiusura sono
zero: durante la richiesta esiste un PIT, non un picco misurato di zero.
Le aperture sono 103 per le prime due modalità e 1 per il riuso, inclusi warmup.
La riduzione dopo DELETE verifica che l'accumulo osservato dipende dai PIT.

Il preload/probe storico crea 104 PIT (include anche il setup), conservandoli
fino a dopo dettaglio e lettore; questa ablazione ha 103 e termina con la fase
ricerca. Il frontend pagina tramite cursor e refetcha ogni 2 s sotto indicizzazione:
il ritmo di aperture del probe sequenziale è diverso. Un PIT riusato fissa uno
snapshot precedente: non è equivalente a un PIT nuovo durante modifiche reali.

La chiusura immediata non riduce uniformemente la latenza query: a vuoto
38,35/43,62 ms medi contro 46,72/40,19 ms con conservazione. Il riuso misura
40,46/43,27 ms a vuoto e 49,23/58,11 ms sotto backlog. Rimuove il costo delle aperture
ripetute, ma non dimostra da solo quanto della regressione API sia causato dalla
ritenzione dei segmenti. La chiusura ha un costo proprio e invalida il cursore.

### Risorse disponibili e limiti

Durante backlog, conservazione/chiusura immediata/riuso registrano CPU OpenSearch
media 419/279/193% nell'ordine diretto e 338/345/402% nell'inverso (100%=un core).
Heap campionato massimo 713/619/471 MiB e 714/757/670 MiB. Questi contatori comprendono
indicizzazione, ricerca, GC e osservazione: non sono CPU della singola query.

I segmenti osservati crescono 18→22 nel primo retain e 31→38 nel retain ripetuto;
nel primo reuse 22→27 e nel reuse ripetuto 18→22. Merge misurati nelle finestre
close: 7.067/4.198 ms; nelle finestre retain/reuse riportate: 0 ms. Il maggior costo
del retain finale coesiste con uno stato dei segmenti diverso: non viene scartato,
né attribuito integralmente ai PIT. GC, refresh, flush, thread pool, bulk client,
working set e I/O disponibili sono nel JSON; mancano attribuzione per query e
controllo del throughput concorrente, rinviati a P2E.1b. La liberazione immediata
dei contesti non dimostra liberazione immediata di heap o spazio su disco.

**Conclusione circoscritta:** i facet sono il componente più costoso e ripetibile
nella query predefinita studiata. PIT aggiungono round-trip e contesti misurabili;
conteggio e sort hanno effetti minori o non semanticamente equivalenti. Non si
estende il risultato a ogni filtro/full-text, non si dichiara una spiegazione
completa della regressione e non si seleziona definitivamente P2E.2.

### Verifica e riproduzione

24 esperimenti, 2.400 query misurate e 72 warmup; due probe HTTP autenticati
originali con 104 ricerche tracciate ciascuno. Controllati query catturata identica,
ordine atteso degli ID, cleanup PIT, 11.032 documenti e code drenate in entrambe
le fixture. Build completa e controlli sintattici passati. I container temporanei
sono rimossi; fixture/evidenze restano private. Nessuna baseline precedente cambia.

```sh
P2C_SOURCE=/mnt/sdb/palimora-p2c-b1-20261109 \
 P2C_ROOT=/mnt/sdb/palimora-p2e1a-new-forward \
 P2C_IMAGE=palimora-p2d-api BENCH_PROJECTION_MODE=isolated \
 P2D_DIAGNOSTICS=1 P2C_EVENT_LOOP=1 P2E_ORDER=forward \
 ./scripts/benchmark-search-ablations.sh
# Ripetere con root nuova e P2E_ORDER=reverse, senza campagne/build concorrenti.
python3 scripts/summarize-search-ablations.py /root/forward /root/reverse
```

## P2E.1b — Facet a carico comparabile e diagnosi conclusiva

**2026-11-09 — P2E.1b e diagnosi P2E.1 concluse; P2 resta aperta.**
Report: [`performance-p2e1b.json`](performance-p2e1b.json). Nessuna ottimizzazione
applicativa: nuovi runner diagnostici, estensione minima del preload esistente,
nessuna modifica ai report P2E.1/P2E.1a o al codice di produzione.

### Metodo e confronto matched

Quattro copie indipendenti della stessa fixture P2C B1 ferma, 11.032 opere;
ordine completa → senza facet → senza facet → completa. PostgreSQL 17.6,
OpenSearch 2.19.4 (heap 1 GiB), Redis 7.4.6, stessa immagine `palimora-p2d-api`
identificata nel JSON; PackStore sorgente in sola lettura, rete interna, nessuna
quota CPU/RAM, modifica durability, ingest o build concorrente. API e projection
sono processi Node distinti nello stesso container di test. Le finestre iniziali
a vuoto non avviano ancora il projection worker; restano i job di fondo dell'API.

Ogni finestra: 3 warmup, 80 richieste HTTP autenticate, 4 richieste/s per 20 s.
Per backlog: 800 invalidazioni del medesimo contenuto, worker reale 16/1/1,
5 s di avviamento; il solo preload diagnostico attende prima del bulk un budget
nominale di 20 documenti/s. Preparazione e HTTP aggiungono tempo: il throughput
**effettivo**, non quello nominale, decide il matching. Il pacing è rimosso solo
dopo la finestra per drenare. Non è una misura del throughput massimo di Palimora.

| Coppia | Variante | ACK nella finestra / s | Indicizzazioni interne OS / s | Bulk completi | Coda prima → dopo |
|---|---|---:|---:|---:|---|
| 1 | Completa | 336 / 16,80 | 352 / 17,60 | 21 | 736 → 400 |
| 1 | Senza facet | 336 / 16,80 | 347 / 17,35 | 21 | 720 → 384 |
| 2 | Completa | 352 / 17,60 | 352 / 17,60 | 22 | 736 → 384 |
| 2 | Senza facet | 352 / 17,60 | 352 / 17,60 | 22 | 720 → 368 |

ACK e indicizzazioni differiscono ai confini per bulk in-flight. Le letture dei
contatori precedono/seguono di pochi round-trip la finestra temporale: non sono
un'unica transazione atomica. Entrambi gli indicatori rispettano ±10%; anche
OpenSearch differisce solo dell'1,44% nella prima coppia. Il backlog non si esaurisce.

### Latenze

Millisecondi; OS client comprende header e consumo JSON. `took` è incluso nel
client, non va sommato. I percentili sono distribuzioni distinte, non contributi
sottraibili. Il JSON conserva gli span correlati di ciascuna richiesta.

| Condizione / replica | Variante | API media | API P50 / P95 | OS media | OS P50 / P95 | took medio |
|---|---|---:|---|---:|---|---:|
| Vuoto 1 | Completa | 75,72 | 71,25 / 111,92 | 46,01 | 42,74 / 75,62 | 39,10 |
| Vuoto 1 | Senza facet | 47,97 | 45,46 / 71,42 | 20,22 | 18,89 / 29,38 | 13,95 |
| Vuoto 2 | Completa | 74,72 | 72,66 / 104,42 | 45,20 | 41,81 / 68,00 | 38,23 |
| Vuoto 2 | Senza facet | 46,77 | 45,11 / 60,38 | 20,12 | 19,48 / 27,23 | 14,36 |
| Backlog 1 | Completa | 90,90 | 84,67 / 154,63 | 60,52 | 52,28 / 112,63 | 54,41 |
| Backlog 1 | Senza facet | 44,58 | 40,99 / 72,34 | 18,51 | 17,42 / 31,41 | 13,62 |
| Backlog 2 | Completa | 83,33 | 77,16 / 138,93 | 54,73 | 45,33 / 99,14 | 48,48 |
| Backlog 2 | Senza facet | 47,44 | 43,46 / 77,23 | 19,16 | 17,47 / 27,25 | 13,88 |

La differenza delle **medie** OS è 25,79/25,08 ms a vuoto e 42,01/35,57 ms
sotto carico matched. È il costo osservato dell'ablazione, non il guadagno già
ottenuto conservando i facet. Il P95 API scende in entrambe le ripetizioni;
non si attribuisce la differenza dei P95 a uno span specifico.

Per richiesta sotto backlog: 9 chiamate SQL, complessivamente 7,45–9,17 ms medi,
di cui recupero documenti 3,10–3,71 ms; filtro generazioni/cursore 0,08–0,10 ms.
Tre chiamate OpenSearch: HEAD stato 2,34–2,79 ms, apertura PIT 6,28–7,97 ms,
ricerca come sopra. Nessuna pagina aggiuntiva nei campioni. Serializzazione/invio
sincrono 1,93–2,63 ms; residuo per richiesta non coperto dall'unione degli span
4,68–5,48 ms. Il wall server è 87,14/41,37 e 79,90/44,10 ms medi; il client
include ricezione e consumo risposta. Le durate SQL includono trasporto/scheduling;
non sono tempo puro del server PostgreSQL. Il filtro generazioni include anche
costruzione cursore e scheduling microtask.

Due query aggiuntive a indice stabile, una coppia ciascuna:

| Query | Risultati | API media completa → senza facet | API P50/P95 completa → senza facet | OS header medio completa → senza facet |
|---|---:|---|---|---|
| Primo fandom della ricerca autorevole | 464 | 59,42 → 42,57 | 56,02/81,18 → 38,63/65,62 | 28,75 → 16,71 |
| Full-text `love` | 5.277 | 56,10 → 37,47 | 53,16/76,45 → 35,68/53,36 | 33,09 → 15,24 |

ID, ordine e totali identici fra varianti in tutti i campioni confrontati.
Il vantaggio persiste ma si riduce con queste selettività; non si estrapola ad
altri termini o al backlog, non misurato per queste due query.

### Risorse nella medesima finestra

| Metrica | Completa 1 | Senza facet 1 | Completa 2 | Senza facet 2 |
|---|---:|---:|---:|---:|
| CPU OS, secondi / 20 s | 31,36 | 20,04 | 27,33 | 17,73 |
| Heap massimo campionato, MiB | 642,18 | 620,60 | 641,96 | 675,54 |
| GC young, eventi / ms cumulativi | 5 / 110 | 2 / 34 | 5 / 81 | 1 / 22 |
| GC concurrent, eventi / ms cumulativi | 2 / 12 | 2 / 8 | 2 / 47 | 0 / 0 |
| Refresh, eventi / ms cumulativi | 17 / 3.107 | 17 / 2.741 | 18 / 2.540 | 18 / 2.062 |
| Merge, eventi / ms cumulativi | 2 / 1.879 | 2 / 1.513 | 2 / 1.453 | 2 / 1.100 |
| Indicizzazione interna, ms cumulativi | 2.128 | 1.490 | 1.815 | 1.395 |
| Bulk client medio, ms, pacing escluso | 120,89 | 89,31 | 105,57 | 82,21 |
| OS I/O disco letti / scritti, MiB | 0,047 / 10,40 | 0,047 / 16,32 | 0,047 / 13,79 | 0,047 / 21,62 |
| OS rete RX / TX, MiB | 9,45 / 0,47 | 9,93 / 0,33 | 10,47 / 0,47 | 9,93 / 0,33 |

Nessun old GC, flush, throttle o rejection search/write; code campionate sempre
zero, write active massimo 1. Campionamento OS ogni 2 s e ai confini: picchi brevi
possono sfuggire, specialmente search active misurato dopo la risposta. Docker è
campionato a 1 Hz, finestre effettive circa 19 s interne ai 20 s. Working set OS
massimo 1.711/1.649/1.631/1.583 MiB: **heap JVM e memoria container non coincidono**.
CPU PostgreSQL nelle quattro finestre Docker 2,16/2,35/2,05/2,05 s; CPU API
3,53/3,18/3,28/2,96 s, projection 2,82/2,79/2,56/2,74 s. RSS API massimo
282/281/219/219 MiB; projection 171/174/172/179 MiB.
Event-loop API medio 10,18–10,30 ms e projection 10,30–10,39 ms a risoluzione 10 ms;
massimi dei P95 per bin API 11,91–13,28 ms. Non emerge saturazione persistente
API; non si sottrae la risoluzione per inventare una latenza netta.

### Distorsioni e limiti

PIT nuovo per ricerca, chiuso dal probe dopo la prima pagina: al massimo un PIT
del probe aperto, nessun cursore successivamente usato. Apertura nello span API;
chiusura fuori dal suo timer ma dentro il ritmo di richieste. Contesti zero ai
confini e nei campioni post-chiusura: prova del cleanup, non assenza di contesti
mentre la ricerca è in corso. Segmenti backlog 21→20 / 22→21 / 21→21 / 24→24;
nessun accumulo di PIT residuo. Delta hit/miss/eviction delle cache query/request
zero; questo non esclude cache OS, page cache o JIT. Non sono state svuotate.
Merge/GC/segmenti differiscono: matching del ritmo non significa equivalenza
perfetta dello stato interno e non spiega esclusivamente ogni coda della latenza.

Controllo overhead dopo drenaggio, indice stabile: medie API strumentata/non
strumentata 39,69/38,88 ms senza facet e 64,98/64,92 ms completa; P95
60,55/58,80 e 99,85/88,54 ms. Restart/JIT e ordine fisso impediscono di dichiarare
overhead esattamente nullo. La prima fixture aveva solo il controllo non
strumentato (67,40 ms): escluso dall'attribuzione paired. Il profiler di query
è eseguito soltanto dopo le finestre; le sue durate non sostituiscono le latenze
normali. Nessuna attribuzione CPU per singola richiesta è ricavabile dai delta
CPU dell'intero nodo. Questa campagna diagnostica non risolve la regressione a
pieno throughput né sostituisce i benchmark operativi P2C/P2D.

### Diagnosi e unico intervento prioritario P2E.2

1. **Facet:** maggiore costo ripetibile, anche a ritmo matched; differenza media
   OS 35,57–42,01 ms sotto backlog, con riduzione contemporanea di `took` e CPU.
2. **Ricerca residua hits/query/sort/total:** 18,51–19,16 ms client senza facet.
   Le ablazioni sort/total precedenti restano valide, non sono state ripetute.
3. **SQL e round-trip PIT/stato:** circa 7–9 ms SQL e 9–10 ms PIT+HEAD; non
   mostrano un aumento paragonabile al costo facet in queste finestre.
4. **Trasformazione API e serializzazione:** pochi ms misurati, residuo non
   attribuito esplicitamente; nessuna evidenza di collo di bottiglia dominante.

**Unica proposta P2E.2: partizionare le dieci aggregazioni indipendenti in due
ricerche concorrenti bounded sul medesimo PIT e identico filtro**, ricomponendo
la risposta originale. Una mantiene hits/sort/total e un sottoinsieme bilanciato
di facet, l'altra `size:0` e gli altri facet. Candidato tecnico: `_msearch` con
`max_concurrent_searches=2`, previsto dalla
[documentazione OpenSearch](https://docs.opensearch.org/latest/api-reference/search-apis/multi-search/).
Non cambiare definizioni `terms`, bucket, ordine o semantica dei facet.

I due profili extra distribuiscono 61,90/35,84 ms fra dieci collector; fra questi
unclassified 19,31/13,06, relationships 12,19/6,26, fandom 9,16/5,53 ms. Sono tempi
**con profiler**, indicativi della distribuzione del lavoro, non del beneficio
atteso. Il costo non è concentrato soltanto nell'inizializzazione degli ordinali:
non giustifica assumere che eager ordinals elimini il problema.

La proposta mira ad accorciare il tratto seriale conservando tutti i facet, non
a eliminare il loro lavoro. Il margine dell'ablazione non è una previsione di
speedup: traversal duplicato, CPU/heap aggiuntivi possono annullare il vantaggio o
peggiorare l'indicizzazione. Complessità moderata di orchestrazione; modifica
query, nessuna modifica API/frontend/mapping/durability. Accettazione futura:
uguaglianza completa bucket/count/order, hits/totali/cursori/generazioni,
stesso PIT/epoch/filtro, gestione atomica degli errori e cleanup; misure operative
anche a pieno throughput prima di adottarla. **Non implementata in questa fase.**

### Verifiche e riproduzione

1.360 richieste misurate, zero errori HTTP; confronti hash ID/ordine/totali passati,
11.032 documenti catalogo e coda full-text vuota al termine di ogni fixture.
Build completa passata (warning frontend dimensione chunk preesistente), controlli
sintattici e guardia DB di test passati. Il preload disattivato lascia intatti
fetch, HTTP, pg ed Express. Nessuna suite crash ripetuta: motore e protocollo
non cambiano. Report storici preservati. Evidenze private nei quattro percorsi
elencati nel JSON; container e reti temporanei rimossi.

```sh
P2C_SOURCE=/mnt/sdb/palimora-p2c-b1-20261109 \
 P2C_ROOT=/mnt/sdb/palimora-p2e1b-new-full1 \
 P2C_IMAGE=palimora-p2d-api BENCH_PROJECTION_MODE=isolated \
 P2D_DIAGNOSTICS=1 P2C_EVENT_LOOP=1 P2E_VARIANT=full P2E_EXTRA=1 \
 ./scripts/benchmark-search-matched.sh
# Ripetere in root nuove: no-aggs/EXTRA=1, no-aggs/EXTRA=0, full/EXTRA=overhead.
python3 scripts/summarize-search-matched.py /root/full1 /root/noagg1 /root/noagg2 /root/full2
```

## P2E.2 — Due subquery facet sul medesimo PIT

Percorso sperimentale `SEARCH_PARALLEL_FACETS=1`, **disabilitato per default**
(`0`, esposto nell'ambiente API di Compose). Nessun cambio di contratto,
frontend, mapping, documento o motore di proiezione. Con flag spento resta
la query singola. Nessun fallback o retry aggiuntivo.

`POST /_msearch?max_concurrent_searches=2`, NDJSON con metadata vuoti e newline
finale. A conserva hits, sort, total, search_after e generazioni, aggregando
unclassified/rating/warnings/category. B usa la stessa query e PIT, `size:0`,
`track_total_hits:false`, aggregando fandom/characters/relationships/freeform/
media/language. Le definizioni originali `terms` con 15 bucket sono riutilizzate;
filtri e sort non sono ricostruiti in un secondo builder. La ripartizione deriva
dai profili P2E.1b, non dall'ipotesi di costi uguali per campo.

Entrambe le risposte devono essere valide, senza timeout/shard failure, con tutti
i facet attesi; niente risultati parziali. Un PIT nuovo viene chiuso su errore;
un PIT ricevuto dal cursore resta del chiamante. La versione 2.19.4 verificata
restituisce lo stesso identificativo PIT; un identificativo inatteso viene
rifiutato, non adottato silenziosamente. Gli errori query restano 400 e i cursori
scaduti 410. Nessuna modifica al formato dei cursori.

### Confronto sul corpus reale

Report: [`performance-p2e2.json`](performance-p2e2.json). Fixture nuove derivate
dal medesimo indice/PG P2C B1, 11.032 opere; stesso build applicativo per entrambe
le varianti, montato sopra l'immagine base `palimora-p2d-api`. L'ID dell'immagine
identifica quindi la base, non il codice applicativo montato. Worker isolato
16/1/1, PostgreSQL 17.6, OpenSearch 2.19.4 heap 1 GiB, Redis 7.4.6, niente quote,
cache drop, cambio durability o benchmark/build concorrenti.

Riutilizzati pacing e span P2E.1b: 80 richieste HTTP autenticate in 20 s,
4 richieste/s, 3 warmup, PIT chiusi dal probe dopo ciascuna prima pagina.
Ordine OFF→ON→ON→OFF su copie nuove. I test funzionali completi sono separati
per non riscaldare soltanto una variante. Senza pacing si accodano tutte le
11.032 opere; la finestra HTTP non pretende di essere un benchmark ingest.

| Condizione | Flag | API media / P50 / P95 ms | OS client media / P50 / P95 ms | Documenti/s ACK |
|---|---|---|---|---:|
| Vuoto 1 | OFF | 75,70 / 71,61 / 116,73 | 46,33 / 41,99 / 73,50 | 0 |
| Vuoto 1 | ON | 66,80 / 63,72 / 89,41 | 37,85 / 34,30 / 58,65 | 0 |
| Vuoto 2 | OFF | 75,50 / 71,81 / 109,96 | 45,56 / 42,30 / 69,56 | 0 |
| Vuoto 2 | ON | 65,20 / 62,38 / 87,98 | 36,32 / 33,10 / 55,11 | 0 |
| Matched 1 | OFF | 80,77 / 74,79 / 120,63 | 52,42 / 46,93 / 83,96 | 16,80 |
| Matched 1 | ON | 75,25 / 71,01 / 126,92 | 44,78 / 39,62 / 81,65 | 17,60 |
| Matched 2 | OFF | 84,30 / 80,76 / 125,38 | 53,58 / 48,40 / 88,89 | 16,80 |
| Matched 2 | ON | 73,75 / 66,73 / 122,06 | 45,30 / 40,64 / 82,22 | 17,60 |
| Senza pacing | OFF | 103,71 / 97,22 / 144,65 | 68,47 / 58,91 / 110,58 | 92,80 |
| Senza pacing | ON | 97,29 / 86,39 / 156,37 | 58,72 / 53,39 / 114,61 | 85,60 |

ACK matched entro 4,8%; non perfettamente identici. `took` medio subquery A/B
30,50/13,31 e 29,12/13,10 ms a vuoto; 37,49/18,16 e 38,45/18,80 ms matched;
49,45/29,15 ms senza pacing. Non si sommano i due took concorrenti al wall-clock
msearch. La parte con hits rimane più costosa: la ripartizione da profiler non
implica un bilanciamento perfetto nella query normale.

| Risorsa nella finestra backlog | OFF 1 | ON 1 | OFF 2 | ON 2 | OFF massimo | ON massimo |
|---|---:|---:|---:|---:|---:|---:|
| CPU OS, secondi | 28,42 | 29,65 | 24,53 | 28,27 | 49,52 | 52,28 |
| Heap campionato max, MiB | 643,7 | 648,8 | 689,6 | 673,2 | 716,9 | 734,4 |
| GC young, ms cumulativi | 75 | 88 | 103 | 92 | 164 | 147 |
| Refresh, ms cumulativi | 2.673 | 2.348 | 2.123 | 2.725 | 4.571 | 5.030 |
| Merge, ms cumulativi | 1.502 | 1.133 | 1.127 | 1.629 | 1.761 | 2.063 |
| SQL client medio/richiesta, ms | 8,06 | 8,53 | 7,78 | 7,90 | 10,25 | 11,27 |

Nove round-trip SQL e tre OpenSearch per prima pagina (HEAD/PIT/search o msearch),
più chiusura PIT del probe esterna al timer API. Byte request/response, took di
ciascuna subquery, risorse Docker/Node, thread pool, I/O, rete, code e bulk sono
nel JSON. Byte risposta sono misurati riserializzando il JSON decodificato, non
come byte TCP/compressi. Il tratto tra fine decodifica OS e avvio SQL documenti misura 0,044–0,049 ms
medi con msearch (0,024–0,030 ms con query singola): include validazione,
ricomposizione e dispatch SQL, non soltanto il merge. È derivato dagli span
della stessa richiesta, senza sottrarre percentili indipendenti.

### Decisione

**Default OFF.** A vuoto il miglioramento è ripetibile; sotto backlog il P95 API
non lo è, e senza pacing peggiora 144,65→156,37 ms mentre il ritmo ACK osservato
scende 92,8→85,6 documenti/s (−7,8%). Una sola coppia senza pacing non consente
un'attribuzione causale precisa dell'intero calo, ma non soddisfa i criteri di
adozione. L'aumento CPU e il lavoro duplicato delle subquery sono costi reali
possibili; non si forza un risultato positivo né si estende questa fase ad altre
ottimizzazioni. La regressione di ricerca sotto backlog rimane aperta.

Campionamento Docker/Node 1 Hz, statistiche OpenSearch ogni 2 s e ai confini;
le code istantanee possono perdere picchi brevi. Host condiviso, cache/GC/merge
non identici; pacing diagnostico e pieno throughput vanno tenuti distinti.
Gli hash JSON grezzi del runner dipendono anche dall'ordine delle proprietà:
non costituiscono da soli una prova di differenza semantica; l'equivalenza viene
verificata strutturalmente, compreso l'ordine degli array bucket/hits.

### Controllo end-to-end e verifica conclusiva

Due esecuzioni B circoscritte OFF→ON, parser2/commit2, gruppi256, zstd3,
seeding AO3 e durabilità invariati. Il probe originale verifica la ricerca al
termine: **non genera richieste di ricerca continue durante l'ingest**. È un
controllo d'integrazione/throughput, non sostituisce la misura di contesa sopra.

| Metrica | OFF | ON |
|---|---:|---:|
| Accodamento → visibilità verificata, s | 160,572 | 164,620 |
| Inizio effettivo ingest → visibilità, s | 160,321 | 163,487 |
| Opere/s end-to-end | 68,704 | 67,015 |
| Ingest, s | 53,095 | 53,116 |
| Refresh e verifica finale, s | 9,308 | 8,628 |
| WAL PostgreSQL, MiB | 688,11 | 691,15 |
| CPU container API/ingest, s | 128,62 | 129,96 |
| CPU PostgreSQL, s | 143,46 | 140,14 |
| CPU OpenSearch, s | 160,67 | 164,12 |
| CPU processo projection nella finestra, s | 115,37 | 116,37 |
| Working set max OS, MiB | 1.717,41 | 1.706,33 |
| I/O OS letti / scritti, MiB | 32,91 / 843,47 | 25,39 / 1.034,16 |

CPU container dalla finestra del sampler, che include avvio/arresto; CPU projection
dagli eventi Node entro il timer operativo. Il contatore Docker projection OFF
si azzera allo shutdown producendo un delta negativo: marcato non disponibile,
non presentato come consumo negativo. I/O projection container non disponibile;
non è zero. Le differenze cache/host e l'assenza di ricerca continua impediscono
di attribuire causalmente il +2,52% end-to-end al nuovo percorso.

Entrambe le esecuzioni verificano 11.032 opere, snapshot, documenti catalogo,
viste storiche e documenti OpenSearch, tutte le identità/generazioni, code vuote,
ricerca e lettore funzionanti. Le proiezioni hanno 11.032 partenze per coda.

Fixture funzionale separata: 29 combinazioni di query/filtri/direzioni, tre pagine
con cursore preesistente per caso quando disponibili e scansione completa delle
11.032 opere confrontata strutturalmente fra percorsi sul medesimo PIT. Confronto
integrale di hits, sort, total, cursori e tutti i facet, inclusi bucket/count/order.
PIT nuovi delle prime pagine sono normalizzati soltanto nel confronto del token;
i cursori condivisi delle pagine successive coincidono esattamente.

Verificate aggiunta/aggiornamento/eliminazione nell'indice, snapshot PIT precedente
alle modifiche, autorità PostgreSQL con generazione non corrente/documento rimosso
in transazione poi annullata, cursore scaduto e cleanup. I cambi indice avvengono
soltanto nella fixture funzionale e sono ripristinati. Guasti iniettati intorno a
risposte reali: errore individuale, timeout, shard failure, facet mancante e
fallimento trasporto. Nessuna risposta parziale accettata. Compatibilità reale
2.19.4: due subquery valide HTTP200/[200,200]; errore aggregazione individuale
HTTP200/[200,400]; PIT scaduto HTTP200/[200,404]. La prima prova preliminare con
sintassi volutamente malformata restituiva invece HTTP400 globale: è distinta
dall'errore individuale di esecuzione, non una prova del secondo comportamento.

Build completa, sintassi Node/Bash, configurazione flag Compose e controlli diff
passati. I primi due tentativi del probe funzionale avevano assunzioni errate
sul campo dell'eccezione NestJS e sulla presenza del primo bucket freeform:
corretti, rieseguiti, esclusi dalle prestazioni. Il build finale aggiunge inoltre
la traduzione HTTP400 globale nel codice di errore originale; il percorso di
successo misurato non cambia. Gli hash dei due build sono nel report; ogni coppia
OFF/ON usa rigorosamente lo stesso build.

**P2E.2 implementata e valutata, senza adozione di default. P2 ancora aperta.**
Nessuna ottimizzazione successiva avviata. La prova non dimostra la risoluzione
della regressione interattiva; non dichiara un guadagno dell'intera pipeline.

Riproduzione (una campagna alla volta, root nuove, dopo la build):

```sh
P2C_SOURCE=/mnt/sdb/palimora-p2c-b1-20261109 \
 P2C_ROOT=/mnt/sdb/palimora-p2e2-new-off \
 P2C_IMAGE=palimora-p2d-api BENCH_PROJECTION_MODE=isolated \
 P2D_DIAGNOSTICS=1 P2C_EVENT_LOOP=1 SEARCH_PARALLEL_FACETS=0 P2E_EXTRA=0 \
 ./scripts/benchmark-search-parallel.sh
# Coppie: OFF, ON, ON, OFF. Poi OFF/ON con P2E_UNPACED=1.
# Funzionale separata: P2E_EXTRA=1 P2E_CHECK_ONLY=1, root nuova.
RELEASE_IMAGE=palimora-p2d-api \
 RELEASE_BENCH_ROOT=/mnt/sdb/palimora-p2e2-new-operational \
 BENCH_NODE_OPTIONS=--require=/app/scripts/performance-p2d.cjs \
 P2D_DIAGNOSTICS=1 P2C_EVENT_LOOP=1 SEARCH_PARALLEL_FACETS=0 \
 ./scripts/benchmark-search-parallel-operational.sh
# Ripetere con flag1 e root nuova; nessuna campagna sequenziale A.
P2E_FUNCTIONAL_ROOT=/root/functional \
 P2E_OPERATIONAL_ROOTS=/root/operational-off:/root/operational-on \
 python3 scripts/summarize-search-parallel.py \
 /root/off1 /root/on1 /root/on2 /root/off2 /root/offmax /root/onmax
```

## P3A — ZIP concorrenti, verifica del 9 novembre 2026

Il coordinatore è nello stesso ingest worker, sotto il leader `70210403`.
`INGEST_SOURCE_CONCURRENCY=1–4`, default **1**, ripartisce i budget esistenti:
con 6 parser/4 commit le corsie sono rispettivamente 1, 2 o 4; con 2/2 il massimo
effettivo è 2. Ogni sorgente possiede pipeline, ACK, checkpoint, errori, staging e
connessione lease identità. SQLite costituisce una barriera rispetto ai ZIP.
Nessun nuovo servizio, formato, indice SQL, coda o cache persistente.
Il controllo downstream condiviso ferma l'alimentazione a 65.536 elementi per
coda corrente/storica/full-text; la campagna non raggiunge questa soglia.
Dettagli operativi in [04](04-ingest.md#coordinamento-multi-sorgente-p3a).

### Confronto end-to-end

Quattro ZIP disgiunti, ottenuti dall'unico corpus autorizzato
`queue119_archive05.zip`: **11.032 opere**, **228.732.607 byte** di sorgenti.
Partizioni artificiali, non un campione della distribuzione degli oltre 900 GiB.
Stessi contenuti, parser 6, commit 4, gruppi 256, Zstd 3, libuv 8,
OpenSearch 2.19.4/heap 1 GiB, proiezioni isolate. Host condiviso senza quote.
Baseline: worker del commit `6928e8844345f5b28ddddfb556c908aa32f4d897`,
ricompilato con le stesse dipendenze; gli altri moduli prodotto sono invariati.

| Modalità | Canonico s | Opere/s canoniche | GiB sorgenti/ora | End-to-end s | Opere/s ricercabili |
|---|---:|---:|---:|---:|---:|
| Worker precedente sequenziale | 52,639 | 209,58 | 14,569 | 161,656 | 68,24 |
| Nuovo, sorgenti 1 | 51,041 | 216,14 | 15,025 | 164,667 | 67,00 |
| Nuovo, sorgenti 2 | 44,420 | 248,35 | 17,264 | 163,451 | 67,49 |
| Nuovo, sorgenti 4 | 42,131 | 261,85 | 18,202 | 166,102 | 66,42 |

End-to-end da `started_at` durevole a code drenate, refresh, verifica di tutti
ID/generazioni e richieste autenticate di ricerca/lettura. Il canonico termina
alla chiusura del batch dopo tutti i commit: non viene confuso con la ricerca.
Una prova per modalità; il JSON conserva anche un run esplorativo di sorgenti 1
(49,797 s canonico, 164,748 s end-to-end), escluso dal confronto principale perché
il campionamento staging è iniziato tardi e piccoli test si sovrapponevano.
Nessuna significatività statistica attribuita alle differenze di pochi secondi.
Le ultime protezioni dello stato batch nei percorsi di errore/connessione sono
state verificate dopo l'immagine benchmark; non cambiano il percorso riuscito.

Il guadagno canonico 1→4 è **21,1%**; quello end-to-end non è dimostrato.
Dopo l'ultimo commit servono ancora circa **109 / 114 / 119 / 124 s** nelle
quattro modalità, inclusa la verifica della visibilità. Le code e la stima della
residenza, integrata dai campioni a circa 1 s, sono in `performance-p3a.json`:
non sono timestamp individuali di enqueue/dequeue.

### Risorse e storage

| Modalità | CPU-secondi worker/API | Picco working set worker MiB | Picco staging MiB | I/O worker letti/scritti MiB |
|---|---:|---:|---:|---:|
| Precedente | 134,64 | 1.000,36 | 520,70 | 5,31 / 803,13 |
| Nuovo 1 | 134,37 | 861,54 | 520,70 | 1,13 / 818,57 |
| Nuovo 2 | 134,65 | 1.000,02 | 816,63 | 44,34 / 679,27 |
| Nuovo 4 | 131,47 | 1.089,52 | 825,64 | 6,85 / 1.435,00 |

CPU-secondi e I/O coprono il container della campagna, non sono wall-clock né
solo parsing. La cache OS spiega perché letture block-device non equivalgono ai
byte sorgenti. Il JSON conserva CPU/RAM per processo campionato e per container,
PG, OpenSearch e proiettore inclusi. I/O del proiettore non disponibile nel sampler:
non viene sostituito da zero. Picchi di container differenti non sono sommati.
Il picco CPU worker arriva a 7,34 core con quattro sorgenti; nessuna quota è stata
misurata. La memoria e lo staging aggiuntivi non giustificano la promozione del default.

| Modalità | Pack byte / numero | PostgreSQL database byte | OpenSearch primario byte | Filesystem persistente totale byte |
|---|---:|---:|---:|---:|
| Precedente | 290.790.286 / 55 | 433.925.267 | 473.918.436 | 1.976.334.011 |
| Nuovo 1 | 290.791.378 / 56 | 430.247.059 | 474.242.657 | 1.973.060.328 |
| Nuovo 2 | 290.793.039 / 57 | 433.769.619 | 473.476.586 | 1.958.750.309 |
| Nuovo 4 | 290.789.046 / 59 | 440.282.259 | 489.952.430 | 1.965.117.726 |

Byte apparenti; allocati e componenti separati nel JSON. Il totale filesystem
include cluster PG/WAL, OpenSearch/translog, Redis e storage; esclude fixture
sorgenti e risultati. Il primario OpenSearch è misurato alla fine del timing,
il filesystem dopo la verifica. Cache filesystem persistenti **0 byte**, staging
finale **0 byte** in tutti i run. Nessuna compattazione/force-merge aggiuntiva.

I pack variano al massimo **+2.753 byte (+0,00095%)** rispetto al precedente:
UUID locali nei manifest compressi, confini dei gruppi e record fisici concorrenti
spiegano differenze che i soli conteggi non mostrano. **107.054 hash unici** in ogni
run; record fisici duplicati **6 / 8 / 12 / 4**, rispettivamente
**2.449 / 3.213 / 5.631 / 1.646 byte**. Non sono snapshot aggiuntivi.
PG a quattro sorgenti cresce di **6.356.992 byte (+1,47%)**; nel rilevamento delle
relazioni `catalog_work_filters` e `catalog_work_tags` crescono rispettivamente
3.694.592 e 3.686.400 byte, compensati in parte da altre relazioni.
Il primario OpenSearch varia fino a **+3,38%**, con documenti semanticamente
identici: layout di pagine/segmenti e tempi dei merge differiscono fra database
nuovi. Queste singole prove non isolano ogni causa fisica. Il totale persistente
misurato non aumenta; non si dichiara identità byte-per-byte dello storage.

### Integrità, recovery e nuovo limite

Ogni run verifica SHA-256 di **107.054 oggetti**, **11.032 snapshot**, **22.928
revisioni/associazioni capitolo**, catalogo corrente e storico e tutti gli ID e
le generazioni OpenSearch. Confronto dei manifest dopo normalizzazione dei soli
UUID locali, degli hash degli oggetti sorgenti e di tutto il contenuto del catalogo.
Le osservazioni preservate vengono confrontate normalizzando i riferimenti
work/snapshot/manifest dopo averli verificati contro SQL; provenienza ed evidenze
restano integralmente nel confronto.
Gli ID bibliografici senza sorgente, derivati dall'UUID dell'opera, sono prima
verificati contro la funzione di produzione e poi normalizzati per ID AO3.
Nel confronto OpenSearch si escludono ID locali, generazioni/epoch e timestamp
di acquisizione; si ordina soltanto l'insieme dei tag keyword, il cui ordine SQL
può variare fra database. Testi, metadata e valori bibliografici restano confrontati.

Dieci test mirati passano, senza skip. Fixture EPUB sovrapposta con ID capitolo
espliciti, revisioni e metadata discordanti: **20 acquisizioni, 15 opere, 17
snapshot**, evidenze di conflitto preservate. Replay senza nuove versioni/oggetti;
SIGTERM/SIGKILL su due sorgenti; crash dentro una transazione SQL senza avanzare
il checkpoint; pausa/ripresa multi-sorgente; staging liberato dopo resume.
Suite worker: assenze, `.part`, corruzione, parser non supportato e checkpoint.
Test scheduler/pipeline: completamento fuori ordine, sorgente lenta/veloce,
barriera SQLite e drenaggio degli errori. Il replay supplementare dell'intero
corpus preserva conteggi di opere/snapshot/revisioni/oggetti: osservati fino a
**3 / 4 / 4** gruppi/transazioni concorrenti e **1 / 2 / 4** sorgenti in commit;
la misura della transazione include l'acquisizione dal pool.

Tre lettori concorrenti dopo il drenaggio: 30 richieste ricerca/lettura per
modalità, zero errori, P95 **222 / 180 / 179 ms** (sorgenti 1/2/4), HTTP interno.
È una verifica d'uso, non una campagna P95 né una misura con backlog simultaneo.

Il limite dominante è il **catalogo serializzato**, non l'alimentazione ZIP.
Nel run esplorativo il profilo registra 552 lotti correnti e 552 storici:
`current_slice` **86,315 s**, `historical_slice` **55,191 s**, SQL corrente
**60,172 s**, SQL storico **28,905 s**; intervalli inclusivi/nidificati, non
additivi al wall-clock. L'attesa/acquisizione del lock bibliografico è **1,642 s**:
il costo è soprattutto il lavoro svolto serialmente sotto quel lock, inclusi
proiezione corrente/storica, arricchimento, tag/entità e materializzazione, non
una prova di forte contesa del lock. Questo individua il successivo problema P3;
qui non si riaprono bibliografia P1B.1 o facet e non si implementa il blocco successivo.

**Configurazione consigliata: `INGEST_SOURCE_CONCURRENCY=1`.** I budget Compose
restano invariati; 6/4 è il profilo comparativo, non una nuova configurazione
produttiva validata con quote. P4/P5 dovranno stabilire quella definitiva.

### Riproduzione P3A

```sh
docker build -f infra/Dockerfile --target api -t palimora-p3a-api .
RELEASE_IMAGE=palimora-p3a-api P3A_BASELINE_IMAGE=palimora-p3a-baseline \
 ./scripts/build-p3a-baseline.sh
python3 scripts/prepare-p3a-fixture.py \
 /mnt/teratron_data/AO3_dumper/ao3_dump/data/ao3_stories/queue119_archive05.zip \
 /mnt/sdb/palimora-p3a-fixture-nuova
# Avviare il sampler prima della prova; richiede directory private con prefisso P3A.
python3 scripts/sample-p3a-storage.py /mnt/sdb/palimora-p3a-nuova-mode2 &
AO3_DUMP_ROOT=/mnt/sdb/palimora-p3a-fixture-nuova \
 BENCH_SOURCES='["part0.zip","part1.zip","part2.zip","part3.zip"]' \
 P0_SCENARIO=B P0_PARSERS=6 P0_COMMITS=4 BENCH_PROJECTION_MODE=isolated \
 INGEST_SOURCE_CONCURRENCY=2 RELEASE_IMAGE=palimora-p3a-api RELEASE_KEEP=1 \
 RELEASE_BENCH_ROOT=/mnt/sdb/palimora-p3a-nuova-mode2 ./scripts/benchmark-p0.sh
```

Ripetere **in sequenza** per baseline, nuovo 1 e 4 su directory nuove, cambiando
solo immagine/concorrenza. Nel worker di ogni fixture, dopo il timing:
`collect-p3a-storage.cjs` verifica tutti gli oggetti/pack;
`normalize-p3a-catalog.cjs` confronta i contenuti indipendentemente dagli ID locali;
`normalize-p3a-observations.cjs` verifica e confronta le evidenze preservate.
`p3a-disk-sizes.py` misura i bind mount prima del replay supplementare;
`check-p3a-readers.cjs` verifica tre lettori e `check-p3a-retry.cjs` il replay.
Gli script richiedono database `_test`, storage `/benchmark/` e fixture private.
Conservare i servizi della fixture finché queste verifiche terminano, poi fermarli.
Lo script di aggregazione è
`scripts/summarize-p3a.py PREFIX FIXTURE`, che richiede suffissi `-baseline`,
`-1-repeat`, `-mode2`, `-mode4` e confronta gli hash prima di produrre il JSON.
Evidenze private di questa campagna: `/mnt/sdb/palimora-p3a-{baseline,1-repeat,mode1,mode2,mode4}/results/`.

**Stato P3A: implementata, verificata e misurata; completata sul corpus di test
indicato.** Il parallelismo migliora lo stadio canonico ma non il throughput
end-to-end in questa campagna. Default 1 confermato. Nessun deployment definitivo,
ingest del dump completo o lavoro sul blocco P3 successivo/P4/P5 avviato.

## P3 finale — throughput canonico e pressione disco, 9 novembre 2026

**P3 completata: implementata, verificata e misurata sul corpus di test.**
Riferimento `c8a75c0acfbd4cf1417c0d8b4fe4c2b2133be23e`;
[report aggregato](performance-p3-final.json). P3A e le baseline precedenti non
sono ricalcolate. Nessun nuovo blocco P3, intervento P4/P5, deployment definitivo
o ingest del dump completo è stato avviato.

### Comportamento consegnato

Due modalità, senza migrazioni: `conservative` conserva la soglia per coda
65.536 e rimane il default; `throughput-first` usa capacità reale dei filesystem,
byte delle relazioni/indici di coda e prenotazioni staging. La politica completa,
le soglie, l'isteresi e i mount richiesti sono in [04](04-ingest.md#pressione-e-capacità).
Non serve HTTP OpenSearch né superuser PostgreSQL per leggere la capacità.
Un mount mancante, un errore o una misura obsoleta impediscono l'ammissione.

I quattro slot core sono condivisi FIFO fra sorgenti e restano occupati fino
all'ACK ordinato, anche per commit conclusi fuori ordine. Non si moltiplicano
parser, pool o prefetch. Uno ZIP può occupare slot liberi di un altro; i gruppi
con meno sorgenti usano tutti i parser disponibili. Non si ridimensiona a caldo
il pool Python di una sorgente già avviata. Limiti invariati: sei parser nel
profilo misurato, quattro commit/gruppi core, pool 12, fino a quattro lease
identità più leader; ogni adapter ha il proprio namespace temporaneo.

Lo staging adapter prenota byte sotto `flock`, prima delle scritture, con crediti
fino a 8 MiB. Include anche spool anonimi e copie transitorie dei membri grandi;
le prenotazioni si liberano con le directory dopo ACK. Non è una nuova coda né
un dato canonico. PackStore mantiene riserva, SHA-256, Zstd, verifica, fsync e
seal. Dopo crash il worker rimuove i pack non sigillati sotto l'esistente lock
locator, prima dell'avvio del batch; non rimuove pack pubblicati o writer attivi.

La prima prova B, conservata separatamente, si è fermata correttamente a 2.071
opere per una stima staging iniziale troppo restrittiva: il corpus comprende un
membro da **262.421.940 byte**. La stima per singolo record è stata sostituita
con prenotazioni reali condivise fra parser, mantenendo **4 GiB** globali. Questa
prova interrotta non entra nel confronto. Nessun contenuto è stato saltato.

### Tre profili, stesso contenuto e stesse risorse

Quattro ZIP artificiali P3A, 11.032 opere, 228.732.607 byte compressi,
598.801.143 byte dei membri decompressi, 22.928 revisioni capitolo e 107.054
oggetti unici. Stessi sei parser, quattro commit, gruppi 256, Zstd 3, libuv 8,
PG 17.6, OpenSearch 2.19.4 heap 1 GiB, proiezione isolata. Una misura per profilo,
sequenziale su host condiviso senza quote e senza azzerare la cache filesystem:
il guadagno non è una garanzia
statistica né un throughput sostenibile già validato sull'intero dump.

Tempi dal `started_at` durevole all'ultimo ritorno di `ingestRecords` dopo COMMIT.
La chiusura del batch avviene dopo, rispettivamente a 41,899 / 39,291 / 41,912 s.

| Profilo | Sorgenti | Ultimo commit s | Opere/s canoniche | GiB sorgenti/h | MiB sorgenti/s | MiB decompressi/s | Capitoli/s | Oggetti/s |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| A, P3A conservativa | 4 | 41,865 | 263,52 | 18,318 | 5,211 | 13,641 | 547,67 | 2.557,14 |
| B, throughput-first e slot condivisi | 4 | 39,204 | 281,40 | 19,561 | 5,564 | 14,566 | 584,83 | 2.730,66 |
| C, ripartizione 3+3 parser | 2 | 41,740 | 264,30 | 18,373 | 5,226 | 13,681 | 549,31 | 2.564,79 |

B migliora il throughput canonico del **6,79%** rispetto ad A; C non migliora materialmente rispetto ad A e resta peggiore di B.
I MiB/s dividono i byte verificati per il wall-clock canonico: non misurano
la capacità isolata del decompressore. Nessuna delle tre prove raggiunge la soglia 65.536: il guadagno breve non viene
attribuito alla rimozione di una pausa che non si è verificata. Il vantaggio sotto
backlog è dimostrato separatamente con soglia ridotta e downstream fermo.

| Profilo | Catalogo e storico finiti s | Ultimo ACK full-text s | Ricercabilità verificata s | Opere/s end-to-end | Drain e verifica dopo ultimo commit s |
|---|---:|---:|---:|---:|---:|
| A | 151,192 | 151,453 | 162,702 | 67,81 | 120,837 |
| B | 146,745 | 150,923 | 160,910 | 68,56 | 121,706 |
| C | 150,833 | 152,713 | 163,499 | 67,47 | 121,759 |

La verifica end-to-end comprende refresh, tutti gli ID/generazioni e ricerca e
lettura autenticata di campione. Include circa 10–11 secondi dopo l'ultima
proiezione; non sono tempo CPU del catalogo. Sul proprio intervallo produttivo
prima–ultima operazione, catalogo e testo elaborano circa **75 opere/s**;
la capacità dell'intera pipeline rimane circa **67–68 opere/s**.

Al commit canonico di B restano 9.252–9.272 opere da catalogare, 9.272 snapshot
storici e 9.312–9.440 pubblicazioni full-text da confermare, includendo le opere
non ancora proiettate. Gli intervalli derivano dai gruppi che attraversano
l'istante di misura, non da un conteggio di opere parsate. Il primo campione
SQL successivo vede 9.252 elementi corrente, 9.252 storico, 76 testo.

| Profilo | Picco coda corrente | Picco storico | Picco testo | Picco fisico combinato delle code, byte |
|---|---:|---:|---:|---:|
| A | 9.152 | 9.152 | 780 | 3.858.432 |
| B | 9.252 | 9.252 | 860 | 3.923.968 |
| C | 9.112 | 9.112 | 824 | 3.817.472 |

Campionamento circa 1 s; i picchi delle singole relazioni non sono necessariamente
simultanei. Residenza stimata dall'integrale della coda: corrente/storico
58,29 / 58,76 / 59,23 s; testo 3,19 / 2,67 / 2,38 s. Non sono timestamp per opera.

### Risorse, SQL e storage

| Profilo | CPU-s worker/API | Picco working set MiB | I/O worker letti/scritti MiB | Picco staging nominato MiB | Picco prenotazioni adapter MiB | WAL pipeline MiB |
|---|---:|---:|---:|---:|---:|---:|
| A | 133,919 | 1.174,00 | 6,80 / 606,84 | 779,25 | n.d. | 694,54 |
| B | 129,410 | 1.172,46 | 1,68 / 373,89 | 790,86 | 1.258,06 | 683,57 |
| C | 131,448 | 983,21 | 5,59 / 887,97 | 829,09 | 1.298,06 | 691,15 |

CPU e I/O coprono la campagna fino alla verifica; dettagli per processo e ruolo
nel JSON. Il filesystem cache aumenta il valore cgroup `memory` rispetto al
working set. Nessun OOM osservato. I picchi dei diversi container non vengono
sommati come simultanei. I contatori block I/O dipendono da cache/writeback;
non equivalgono ai byte letti logicamente dagli ZIP.

Lo staging nominato non include gli spool anonimi: le prenotazioni B/C includono
anche questi e crediti prudenziali, ma escludono i pack temporanei (già inclusi
nel nominato). Non si sommano le due colonne. Per A, l'ulteriore spazio anonimo
ha un limite conservativo di 386.955.863 byte dalla dimensione massima dei membri
grandi per sorgente, non un picco simultaneo misurato. Il budget adapter 4 GiB
non è stato esaurito nelle prove finali; lo staging residuo è zero.

Span inclusivi ingest A → B: SQL ordinario 83,528 → 81,340 s; COPY 4,500 →
3,865 s; COMMIT 4,659 → 4,340 s; preparazione staging 15,110 → 14,075 s;
append pack 23,325 → 25,115 s; finish/seal 16,795 → 14,567 s; checkpoint
4,104 → 4,129 s. Sono attese sovrapposte di gruppi concorrenti, **non wall-clock**.
Il massimo di gruppi osservato è quattro in tutte le modalità. Il replay
conferma anche quattro transazioni massime, con attesa acquisizione connessione
inclusa. B esegue 27 controlli condivisi, 5,454 s complessivi trascorsi nei probe
(inclusi attesa SQL/event loop), zero attese o rallentamenti di pressione; C
32 controlli / 3,960 s. I controlli avvengono in sovrapposizione agli stadi.

Byte finali, prima dei probe supplementari e del replay:

| Componente | A | B | C |
|---|---:|---:|---:|
| PackStore | 290.790.494 | 290.792.699 | 290.792.018 |
| Packfile | 62 | 63 | 58 |
| PostgreSQL database | 437.603.475 | 428.461.203 | 433.024.147 |
| OpenSearch primari | 473.623.441 | 474.122.934 | 473.948.112 |
| Filesystem PG, WAL incluso | 1.214.199.843 | 1.205.944.707 | 1.209.627.561 |
| Filesystem OpenSearch, translog incluso | 901.235.560 | 901.896.216 | 901.839.145 |
| Cache contenuti / staging residuo | 0 / 0 | 0 / 0 | 0 / 0 |
| Totale filesystem persistente, Redis incluso | 2.406.619.293 | 2.399.016.770 | 2.402.638.467 |

B aggiunge **2.205 byte PackStore (+0,00076%)**, mentre il totale filesystem è
inferiore di 7.602.523 byte (−0,32%). La concorrenza modifica layout fisico, pack
boundary, pagine e tempi di merge/retention; non i contenuti logici. Record fisici
duplicati A/B/C: 7 / 10 / 11, per 2.783 / 4.989 / 4.700 byte; sempre **107.054
hash unici**. Il delta PackStore B si scompone in +2.206 byte di record duplicati,
+8 byte di header del pack aggiuntivo e −9 byte negli altri record (compressione
con UUID locali differenti). Il JSON conserva dimensioni dei singoli pack, spazio allocato,
byte/opera e rapporti sorgente/persistente. Nessuna copia persistente degli ZIP,
EPUB o nuova cache è stata introdotta.

### Costo del backlog

Probe separato su cloni logged delle tre relazioni con colonne e indici reali,
100.000 UUID sintetici per relazione. Non include FK/trigger canonici né contenuti.
Misure per il primo riempimento, esclusa allocazione vuota:

| Coda | Byte/pendente | Indici a 100.000, byte | WAL enqueue, byte | WAL DELETE, byte |
|---|---:|---:|---:|---:|
| Corrente | 88,72 | 4.423.680 | 16.391.760 | 5.616.520 |
| Snapshot storico | 88,72 | 4.423.680 | 16.391.760 | 5.616.504 |
| Full-text | 163,43 | 9.502.720 | 29.144.888 | 5.616.480 |

DELETE non riduce la dimensione fisica. VACUUM ha troncato gli heap vuoti,
lasciando gli indici: 4.440.064 / 4.440.064 / 9.527.296 byte per relazione.
Dopo refill le allocazioni erano 13.271.040 / 13.271.040 / 25.804.800 byte:
la manutenzione non garantisce un ritorno immediato alla taglia iniziale.
Per questo il limite throughput-first misura pagine allocate, non solo tuple vive.

Con una voce per opera in ciascuna delle tre code: circa **34,1 MB per 100.000**
al primo riempimento, **52,3 MB** dopo il ciclo misurato; extrapolazione a un
milione **341–523 MB**, senza promessa che il bloat si fermi qui. Per pianificare
prudenzialmente, prevedere almeno il doppio del ciclo osservato (circa **1 GiB
per milione** soltanto per le code), oltre a catalogo, WAL, indici finali e
versioni aggiuntive. Enqueue+DELETE hanno generato circa **78,8 MB WAL per
100.000**; claim/retry, aggiornamenti e checkpoint possono aggiungerne altro.
Non è una previsione lineare garantita del dump.

Su 100.000 tuple, query dimensione fisica 0,18–0,47 ms; controllo conservativo
bounded 3,72–4,78 ms; `COUNT(*)` 5,74–6,05 ms (media di 20 query). Le soglie di
byte non obbligano a scandire una coda enorme o vuota. Una lettura reale delle
capacità con ruolo PostgreSQL **non-superuser**, OpenSearch fermo e mount
accessibili è riuscita; un mount mancante ha prodotto `capacity_unavailable`.

### Integrità e ripresa

**17 test mirati passati, nessun fallimento o skip**, build completa riuscita.
Verifica su tutte le configurazioni: 11.032 opere e snapshot, 22.928 revisioni,
107.054 oggetti letti e verificati SHA-256; metadata, bibliografia corrente e
storica, manifest, provenienza e tutti i documenti OpenSearch equivalenti tra
A/B/C e alla semantica P3A. La normalizzazione elimina soltanto riferimenti UUID
locali validati e campi operativi; non si dichiara uguaglianza binaria dei manifest
con UUID diversi. Replay integrale senza nuovi oggetti/versioni e code drenate.

Fixture ridotta: soglia conservativa quattro, arresto osservato dopo un piccolo
prefisso già ammesso (6–10 opere nelle esecuzioni); throughput-first completa
160 opere con catalogo assente. Pressione disco iniettata soltanto dal test
impedisce progressi e riprende automaticamente quando il margine torna sicuro.
Esaurimento delle prenotazioni staging: pausa persistita, checkpoint zero per il
record non acquisito, cleanup e resume dopo il ripristino del budget. Quattro
processi parser non superano la prenotazione condivisa; ledger corrotto rifiutato.

OpenSearch irraggiungibile conserva 160 invalidazioni; dopo il ripristino tutte
si drenano con generazioni corrette. La proiezione riprende in processi distinti,
senza un nuovo ingest. SIGTERM/SIGKILL durante ingest con backlog, kill nella
transazione SQL e dentro il seal mantengono il prefisso durevole; il resume
elimina staging sorgente e pack non sigillati. Passano identità sovrapposte,
metadata conflittuali, 17 snapshot per 20 acquisizioni, ACK fuori ordine,
sorgente lenta/veloce, pausa, sorgenti mancanti, `.part` e ZIP corrotti.

### Limite residuo e configurazione

Il catalogo serializzato resta dominante end-to-end: B impiega 83,253 s nei
passaggi correnti e 51,620 s negli storici, mentre la contesa misurata sul lock
bibliografico è 1,332 s. Il costo è soprattutto la materializzazione/SQL dentro
il singolo esecutore, non un'attesa del parser. Il canonico mantiene costi
sostanziali SQL, staging, compressione e seal concorrenti. Profilare e ottimizzare
questi motori/costi appartiene a **P4**; sostenibilità prolungata, quote definitive,
crescita WAL/indici e corpus multi-sorgente rappresentativo appartengono a **P5**.
Non si aprono nuove sottophase P3 né tuning facet/PIT.

Default invariati: **conservative, una sorgente**. Profilo esplicito candidato
per grandi importazioni: **throughput-first, quattro sorgenti, sei parser,
quattro commit, staging 4 GiB, backlog 8 GiB, riserva 8 GiB per mount**, Zstd 3.
Come punto iniziale operativo restano 4 CPU e 4 GiB al worker, ma le prove qui
non avevano quote: P5 deve validarle. Monitorare spazio effettivo per mount,
prenotazioni e staging reale, code/indici, WAL trattenuto, memoria e tempo di
drenaggio. Non aumentare parser/commit o dichiarare raggiunte 2.000 opere/s.

Riproduzione dei tre profili, uno alla volta, su nuove directory private:

```sh
docker build -f infra/Dockerfile --target api -t palimora-p3-api .
RELEASE_IMAGE=palimora-p3-api P3_BASELINE_IMAGE=palimora-p3-baseline \
  ./scripts/build-p3-baseline.sh
AO3_DUMP_ROOT=/mnt/sdb/palimora-p3a-fixture P3_PROFILE_NAME=A \
  RELEASE_BENCH_ROOT=/mnt/sdb/palimora-p3-final-A \
  ./scripts/benchmark-p3-final.sh
# Ripetere con B e C e directory nuove. BENCH_SUBNET opzionale se i pool Docker
# automatici sono esauriti; scegliere una sottorete libera per la sola fixture.
```

`measure-p3-queues.cjs` e `check-p3a-retry.cjs` sono probe separati dopo la
cattura dello storage; la riproduzione non li include nel tempo ingest.
`summarize-p3-final.py` confronta tutte le fingerprint prima di produrre il JSON.
Evidenze private `/mnt/sdb/palimora-p3-final-{A,B-final,C-final}/results/`.
B/C usano l'implementazione finale dei permessi, compresi gli artefatti ausiliari;
le precedenti prove B/C di coordinamento restano separate e non fanno parte dei
risultati principali. L'ultima guardia di cleanup in caso di cancellazione prima
dello spawn è verificata separatamente; non modifica il percorso produttivo
misurato. Non si è riempito il disco host per simulare pressione e non si è
modificato alcun servizio o dato di produzione.

## P4 finale — Archive Engine, 2026-11-09

**P4 completata sulla fixture isolata; percorso ottimizzato promosso. P5 non
iniziata.** Riferimento codice P3:
`b23b9e0a3a96169873b4f06f1a079381855f60df`. Evidenze aggregate, immagini,
fingerprint, risorse, code e storage in `performance-p4-final.json`.
Nessun dump originale o dato produttivo modificato.

### Decisione e implementazione

Il profiling esistente indica lavoro CPU nel worker, attese SQL/client e
contesa di ammissione al pool, oltre a compressione/append/seal. I campioni
PostgreSQL distinguono attività, ClientRead, advisory/transaction lock e I/O;
ClientRead durante una transazione non equivale a CPU SQL. Il pool raggiunge
12 connessioni: richieste in attesa campionate 3/3 nelle baseline, 5/4 nel
finale. Il riuso delle connessioni riduce acquisizioni, ma **non** si dichiara
ridotto quel massimo né una durata di attesa non misurata. Il profiler aggiunge
solo campioni pool/event loop; non nasce un secondo framework.

Interventi integrati:
- PackStore scrive header e payload con writev, gestendo scritture parziali;
  elimina le due copie per concatenazione dei payload. Compressione fino a
  256 oggetti / 16 MiB per finestra, con percorso per il singolo oggetto grande.
- Precompressione condivisa per hash verificato nel gruppo limitato di staging,
  senza cache permanente. Zstd resta 3 e i contesti nativi sono quelli esistenti.
- Lookup SQL dipendenti omessi solo quando non esistono identità precedenti
  sotto lock; DDL della tabella COPY e del suo indice temporaneo nello stesso
  round-trip. Nessun nuovo indice persistente.
- Artefatti ausiliari senza mutazioni di identità usano il lock archivistico
  condiviso contro GC/compattazione, evitando un blocco esclusivo superfluo.
- Stato per envelope, cache parser e lookup identità riusano il client
  autocommit già assegnato alla sorgente. Commit e controllo periodico di
  cancellazione restano separati.

Il parser C++17, pool Python, formato NDJSON, CRC/hash dei membri, staging
aggregato, modello canonico e precedenze del merge restano invariati. La
serializzazione del padre ZIP e le finestre ordinate esistono ancora: i campioni
CPU di processo non isolano una durata wall-clock di parsing/decompressione,
quindi non si attribuisce loro un guadagno. Nessuna modifica ai moduli nativi:
ASan/UBSan non rieseguiti; passano i test del codec/preparazione esistenti.

### Confronti e variabilità

Stesso corpus P3: quattro ZIP, 11.032 opere. Configurazione invariata:
throughput-first, **4 sorgenti / 6 parser / 4 commit / pool 12**, gruppi 256,
I/O 8, Zstd 3, projection worker isolato, facet paralleli disabilitati.
Nessun aumento dei budget adottato, nessun tuning della ricerca.

Una prima candidata (copie/batch pack e SQL) migliorava append ma non il
canonico: 43,684 e 44,151 s contro baseline 43,316 e 42,764 s; non promossa
come soluzione sufficiente. L'aggiunta di dedup della precompressione e lock
artefatti ha dato 41,452 s in una prova esplorativa, insufficiente da sola.
La versione finale include anche il riuso delle connessioni. La campagna finale
è **baseline → ottimizzato → ottimizzato → baseline**, senza build/test in
concorrenza con gli intervalli misurati:

| Esecuzione | Canonico s | Opere/s | GiB sorgenti/ora | End-to-end s | Opere/s end-to-end |
|---|---:|---:|---:|---:|---:|
| Baseline A3 | 41,261 | 267,37 | 18,586 | 169,770 | 64,98 |
| Ottimizzato D1 | 39,862 | 276,75 | 19,239 | 164,611 | 67,02 |
| Ottimizzato D2 | 40,192 | 274,49 | 19,081 | 164,845 | 66,92 |
| Baseline A4 | 45,637 | 241,73 | 16,804 | 169,699 | 65,01 |

Medie delle esecuzioni: **43,449 → 40,027 s**, **254,55 → 275,62 opere/s**,
**17,695 → 19,160 GiB/ora**; capitoli/s **529,04 → 572,83**,
oggetti/s **2.470,14 → 2.674,61**. Le medie dei rate non sono il reciproco
della media dei tempi. Riduzione tempo nelle coppie: **3,39% e 11,93%**.
La dispersione della baseline è rilevante: due coppie non stabiliscono un
intervallo di confidenza né eliminano gli effetti dell'host condiviso.
Non attribuire automaticamente l'intero delta medio al solo codice.

La baseline storica P3 **39,204 s / 281,40 opere/s / 19,561 GiB/ora** è
addirittura più veloce della media finale corrente: non è un controllo
contemporaneo. Non si dichiara un miglioramento rispetto a quel singolo numero.
Cache filesystem non svuotata, corpus riutilizzato, nessuna quota CPU/RAM.
I tempi end-to-end in tabella partono dall'avvio persistito del batch;
i log scenario includono anche l'attesa iniziale e sono circa un secondo maggiori.

### Costi e risorse

Span inclusivi medi, **concorrenti e non additivi**, in secondi:

| Stadio | Baseline | Ottimizzato |
|---|---:|---:|
| SQL ordinario worker | 90,898 | 79,705 |
| COPY | 4,055 | 4,592 |
| COMMIT | 4,005 | 6,144 |
| Preparazione staging | 16,525 | 16,725 |
| Append PackStore | 25,455 | 18,720 |
| Finish/seal/verifica | 16,997 | 21,552 |
| Checkpoint | 4,167 | 4,471 |

SQL e append diminuiscono rispettivamente del **12,3% e 26,5%**; staging non
migliora, COPY/commit/seal aumentano. Il beneficio è sul percorso completo,
non su ogni span. Fsync, synchronous commit, WAL, vincoli e verifiche
indipendenti del seal non vengono disabilitati.

CPU worker per opera sul canonico, campioni cgroup più vicini agli estremi:
**0,010908 → 0,010577 CPU-s/opera**; comprende API e figli Python, non solo Node.
Sull'intera pipeline: **0,012431 → 0,012034 CPU-s/opera**. I ruoli PostgreSQL,
OpenSearch e projection sono separati nel JSON; SQL serve anche il downstream.
Non sommare i picchi di memoria di processi/container come fossero simultanei.

Working set massimo worker: baseline **1.139,81–1.167,87 MiB**, ottimizzato
**1.153,45–1.186,98 MiB**; nessun OOM. I/O fisico worker sull'intera misura:
baseline letti **8,47–15,17 MiB**, scritti **645,13–975,88 MiB**;
ottimizzato letti **2,32–4,00 MiB**, scritti **959,30–1.143,12 MiB**.
Questi contatori dipendono da page cache/writeback; non attestano una riduzione
delle scritture fisiche. Byte/opera e intervalli campionati sono nel JSON.
WAL medio pipeline **692,23 → 688,57 MiB**. Picchi medi staging nominato
**849.872.730 → 806.534.553 byte**, prenotazioni adapter
**1.344.337.070 → 1.264.645.294 byte**: non sommare questi due conteggi.

### Storage e correttezza

Medie dei byte finali prima del replay:

| Componente | Baseline | Ottimizzato |
|---|---:|---:|
| PackStore | 290.793.287 | 290.789.283 |
| PostgreSQL database | 436.346.003 | 429.616.275 |
| OpenSearch primari | 466.986.489 | 469.198.615 |
| Totale filesystem, WAL/translog/Redis inclusi | 2.407.136.094 | 2.399.456.923 |
| Cache contenuti / staging finale | 0 / 0 | 0 / 0 |

Pack baseline **61/65**, finale **65/67**; duplicati fisici **13/8 → 3/3**,
sempre **107.054 hash unici**. La crescita naturale del numero di pack e
OpenSearch (+0,47%) non introduce contenuti duplicati permanenti; totale
filesystem −0,32%, PackStore sostanzialmente invariato. Il JSON contiene
composizione compressa per tipo e dettaglio heap/indici/TOAST supplementare,
rilevato dopo un replay identico per ogni profilo; non confonderlo con i byte
principali catturati prima del replay.

**21 test pertinenti passati**, poi **7 test dei percorsi cambiati rieseguiti
sul codice finale**, senza fallimenti o skip; build completa riuscita.
Tutti gli oggetti vengono riletti, decompressi e verificati SHA-256 in ogni
esecuzione. Identità, metadata, provenienza, snapshot, contenuti, catalogo
corrente/storico e documenti OpenSearch equivalgono fra i profili e alla
semantica P3A. Le normalizzazioni eliminano solo UUID locali validati e campi
operativi come nelle verifiche P3.

I test coprono scritture vettoriali parziali, rotazione/corruzione pack,
dedup globale, replay, sorgenti sovrapposte, artefatti condivisi, SIGTERM/SIGKILL,
crash dentro transazione e seal, checkpoint contigui, assenze/.part/ZIP corrotti,
pressione disco, quota staging, OpenSearch assente e ripresa downstream.
Replay completo delle fixture finali: conteggi invariati, nessun nuovo snapshot,
massimo quattro commit, code corrente/storico/testo vuote.

### Limite residuo e riproduzione

End-to-end medio **169,735 → 164,728 s**, **65,00 → 66,97 opere/s**;
drenaggio/visibilità dopo il canonico **126,286 → 124,701 s**.
Il catalogo serializzato e la sua materializzazione SQL restano dominanti.
Sul canonico restano SQL, preparazione e verifica pack concorrenti, pool
saturo e finestre ordinate del parser. Non si è dimostrato un unico limite
fisico assoluto né la possibilità di raggiungere 2.000 opere/s.

Promozione motivata da miglioramento in entrambe le coppie, correttezza completa,
recovery affidabile e assenza di espansione persistente materiale. Default
operativi invariati; il profilo esplicito sopra resta il migliore **misurato qui**,
non un ottimo globale. P5 dovrà verificare sostenibilità prolungata, distribuzioni
di opere grandi, crescita di DB/WAL/indici, quote e configurazione definitiva.
Non è iniziata e non autorizza l'ingest degli oltre 900 GiB.

Per riprodurre: costruire due immagini immutabili dal riferimento P3 e dal
codice finale, senza modificare l'istanza. Usare directory nuove e quattro
subnet libere:

```sh
AO3_DUMP_ROOT=/mnt/sdb/palimora-p3a-fixture \
 P4_BENCH_PREFIX=/mnt/sdb/palimora-p3-final-nuovo-p4 \
 P4_BASELINE_IMAGE=palimora-p4-baseline P4_CANDIDATE_IMAGE=palimora-p4-promote \
 P4_SUBNET_OCTET=30 ./scripts/benchmark-p4-final.sh
```

La campagna usa gli stessi script P3; il prefisso delle directory è mantenuto
per le loro guardie di isolamento. `summarize-p4-final.py PREFIX A3,D1,D2,A4`
ricostruisce gli aggregati delle esecuzioni riportate. `check-p3a-retry.cjs`
e `collect-p4-storage.py ROOT` sono verifiche supplementari dopo la cattura
principale; per il dettaglio SQL avviare soltanto il PostgreSQL della fixture.
Evidenze private `/mnt/sdb/palimora-p3-final-p4-*-final/results/`; immagini e
hash del codice runtime registrati nel JSON.

## P5 — valutazione di scala e readiness (9 novembre 2026)

**NO-GO, P5 incompleta.** La valutazione e i criteri operativi sono in
[12-first-ingest-readiness](12-first-ingest-readiness.md); inventario, quote e
risultati puntuali in [performance-p5-final.json](performance-p5-final.json).
Non è stato avviato alcun ingest massivo o deployment.

Il campione P4 era il più piccolo dei 139 ZIP. Il campionamento di sei central
directory rivela anche 2,3 milioni di TXT/HTML in un solo ZIP; cardinalità globale,
sovrapposizioni e costo degli SQLite non sono ancora sufficientemente misurati.
Il modello di sensibilità separa pack, snapshot, capitoli, testo indicizzato,
WAL, code, cache SQLite, manutenzione e backup. Il volume dati disponibile non
copre gli scenari proposti. I deficit sono condizionati alle ipotesi, non misure
dello spazio esatto richiesto dall'archivio.

Il controllo con quote aggiunge evidenza sul piccolo corpus ma non dimostra
throughput sostenuto, recovery con backlog prolungato o correttezza dell'ingest
eterogeneo. Le prove precedenti non vengono riclassificate come P5. Non si
promuove una configurazione definitiva né si dichiara raggiunto il target 2.000/s.

Riepilogo: **P0** diagnosi/baseline completata; **P1** storage e ingest completati;
**P2** proiezioni/ricerca completate, facet paralleli sempre 0; **P3** indipendenza
e backpressure completate; **P4** percorso canonico completato con confronto
alternato; **P5** verifica di scala ancora incompleta, decisione operativa NO-GO.
Il Performance Overhaul P0–P5 non è dichiarato concluso.
