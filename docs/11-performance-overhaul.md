# 11 — Performance overhaul, riferimento P0–P5

## Stato e perimetro

P0 misura il checkpoint 1.0.0 (`23afe66d36ac06c9716936987afdcdf05ffbfaa0`),
non un'installazione in produzione. Le sezioni P0 conservano la baseline originale;
le implementazioni P1A/P1B.1 e le nuove misure sono documentate in fondo.
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
