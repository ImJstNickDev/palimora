# 11 — Performance overhaul, riferimento P0–P5

## Stato e perimetro

P0 misura il checkpoint 1.0.0 (`23afe66d36ac06c9716936987afdcdf05ffbfaa0`),
non un'installazione in produzione. Le sezioni P0 conservano la baseline originale;
l'implementazione P1A e le nuove misure sono documentate in fondo.
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
