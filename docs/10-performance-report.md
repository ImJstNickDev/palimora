# 10 — Report prestazionale della release 1.0.0

Misure del **2026-11-08**, Milestone 6C. Corpus reale, servizi isolati, nessun limite Docker esplicito di CPU o RAM, come richiesto. Questo documento riporta risultati osservati, non SLO. Le stime sono separate dalle misure.

## Ambiente e metodo

Host condiviso: VM KVM Linux 6.1.0-51-amd64, 14 vCPU esposte di Intel Core i9-13900H, 62,8 GiB RAM, nessuno swap. Sorgente su XFS (`/mnt/teratron_data`), dati di test su ext4 (`/mnt/sdb`) (filesystem da 3,5 TiB, circa 1,7 TiB disponibili); il tipo e la cache del disco fisico dell'hypervisor non sono osservabili. Gli altri servizi dell'host sono rimasti attivi. Nessuna modifica ai loro limiti, nessun flush globale della cache.

Stack: Docker Engine 29.6.2, Node 22.21.1, PostgreSQL 17.6, Redis 7.4.6 AOF, OpenSearch 2.19.4 single-node con heap JVM 1 GiB, Nginx 1.28 per la verifica HTTPS. PostgreSQL usa i parametri predefiniti dell'immagine (`shared_buffers=128MB`, `work_mem=4MB`); libzstd 1.5.4 (Debian `1.5.4+dfsg2-5`), livello 3, gruppi ingest da 256 record, `UV_THREADPOOL_SIZE=8`. Heap JVM e concorrenza sono parametri applicativi, non quote CPU/RAM dei container. Nessuna porta host, rete Docker privata, dump montato read-only; database e PackStore distinti dalla produzione.

Il worker richiama il processore ingest e le proiezioni esistenti; il tempo di attesa nella coda BullMQ non è incluso. La prima immagine locale di misura era `palimora-release-api:6c`; le correzioni sono state ricompilate nel solo worker privato, poi incluse nella build di produzione 1.0.0. I probe conservano entrambe le query per il confronto.

Ogni ingest confrontato usa un database e uno storage nuovi. Il reingest usa il corpus già acquisito. Tempi monotoni lato chiamante; tre richieste di riscaldamento escluse dai campioni SQL/ricerca/HTTP. Percentili empirici nearest-rank: P99 su 100 richieste è indicativo, non una stima robusta della coda su traffico prolungato. Nessun benchmark sintetico è usato per stimare la velocità di ingest reale. Le prove di guasto e del confine 2 GiB sono fixture funzionali dichiarate.

Le misure principali sono state raccolte prima della suite integrata e del disaster recovery. L'host resta condiviso e durante la prima proiezione sono stati eseguiti alcuni probe SQL e build: non è un confronto a macchina esclusiva. I profili di concorrenza non sono ripetizioni statistiche indipendenti; la cache sorgente può essere già calda.

## Corpus

Un intero `queue119_archive05.zip`: 11.040 membri, **11.032 EPUB/opere**, 22.928 capitoli canonici, zero lacune nell'ingest. I restanti membri sono directory e file ausiliari. Non è stato avviato l'ingest dell'intero dump.

| Misura                    | Valore                                                             |
| ------------------------- | ------------------------------------------------------------------ |
| ZIP sorgente              | 218.03 MiB (228622123 byte)                                        |
| Membri espansi dello ZIP  | 571.06 MiB; EPUB ancora compressi internamente                     |
| SHA-256 ZIP               | `fd8e01e155c1a668c91bd86bc67cfc9b2ac3ad9da1322a35925a74c226e85429` |
| Opere / snapshot iniziali | 11.032 / 11.032                                                    |
| Oggetti fisici / pack     | 107.054 / 51                                                       |

Il campione contiene opere di lunghezze diverse ma non rappresenta tutti i fandom, media remoti o la distribuzione del corpus completo. In questo ZIP autore, pubblicazione e completamento risultano presenti; i casi di metadati incompleti sono verificati separatamente. Un campione di **64 righe reali SQLite**, letto in sola lettura e copiato in un indice privato, produce 64 opere metadata-only in **1,302 s**, 192 oggetti e un pack. I quattro ZIP referenziati assenti sono segnalati senza arrestare il batch. Non è una misura dell'intero SQLite da decine di GB.

## A. Ingest, checkpoint e persistenza

| Profilo                       | Motore s | Totale s | Opere/s | Opere/min | MiB sorgente/s | Pack |
| ----------------------------- | -------- | -------- | ------- | --------- | -------------- | ---- |
| 1 parser / 1 commit           | 66.578   | 67.672   | 165.70  | 9942      | 3.27           | 53   |
| 2 parser / 2 commit (default) | 48.980   | 49.943   | 225.24  | 13514     | 4.45           | 51   |
| 6 parser / 4 commit           | 40.142   | 41.520   | 274.82  | 16489     | 5.43           | 50   |

Il totale include apertura/migrazioni, acquisizione e lettura dei conteggi; il tempo motore include parsing, deduplicazione, commit SQL e pack, ma **non** proiezione bibliografica e indicizzazione full-text. Il profilo 6/4 riduce il tempo motore del 18,0% rispetto a 2/2, usando più CPU. Non risulta saturata tutta la VM: 274,82 opere/s è il massimo osservato fra i tre profili, non il massimo teorico dell'host.

| Operazione sullo stesso ZIP            | Tempo totale s | Esito                                                                         |
| -------------------------------------- | -------------- | ----------------------------------------------------------------------------- |
| Reingest prima della correzione        | 85.864         | 11.032 duplicati; nessuna nuova versione                                      |
| Reingest dopo la correzione            | 15.835         | 11.032 duplicati; 107.054 oggetti invariati                                   |
| Scansione incrementale invariata       | 0.834          | Nessun record rielaborato                                                     |
| Ripresa dopo SIGTERM                   | 12.780         | Checkpoint 2.332, 2.329 opere già riconosciute; completamento senza duplicati |
| Verifica dopo riavvio PG/search/worker | 19.258         | 107.054 oggetti letti/verificati con sorgenti indisponibili                   |

Il worker interrotto lascia correttamente il batch `running`: il riavvio riconcilia il checkpoint persistito. Non si attribuisce al test di interruzione un tempo non registrato.

Profilazione del default: unione temporale dei gruppi **41,300 s**, suddivisa in SQL **29,493 s**, pack **9,110 s**, staging **1,281 s**, restante core **1,416 s**. Le misure delle singole chiamate possono sovrapporsi fra gruppi e non devono essere sommate come tempo totale.

| Profilo            | Checkpoint, n | Checkpoint attivo s | Preserve/dedup attivo s | COMMIT SQL attivo s |
| ------------------ | ------------- | ------------------- | ----------------------- | ------------------- |
| ingest-single      | 48            | 2.051               | 0.810                   | 0.827               |
| ingest-parallel    | 45            | 5.423               | 3.909                   | 3.074               |
| reingest-optimized | 45            | 3.004               | 0.001                   | 0.294               |

`Preserve/dedup` misura il tratto strumentato del core, non tutta la deduplicazione (lookup SQL, hashing e parsing hanno tempi propri). Non è stato disabilitato alcun fsync, checkpoint o vincolo per ottenere questi risultati.

## B. PostgreSQL

300 richieste sequenziali per query; tempi client comprensivi del round-trip sul bridge Docker, cache calda.

| Query        | Media ms | P50 ms | P95 ms | P99 ms |
| ------------ | -------- | ------ | ------ | ------ |
| head         | 0.286    | 0.251  | 0.504  | 0.690  |
| catalog_page | 0.245    | 0.224  | 0.431  | 0.571  |
| title        | 1.378    | 1.330  | 1.886  | 2.403  |
| history      | 0.204    | 0.166  | 0.391  | 0.483  |
| pending      | 0.146    | 0.099  | 0.358  | 0.535  |

`head`: lookup opera; `catalog_page`: prima pagina per ID; `title`: `ILIKE '%love%'`; `history`: snapshot dell'opera; `pending`: coda full-text vuota. I piani `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` sono conservati con i risultati privati. I lookup puntuali usano gli indici esistenti; nessun nuovo indice duplicato è stato aggiunto.

Ottimizzazioni guidate dai piani, sul medesimo catalogo:

| Query                                    | Prima media ms | Dopo media ms | Buffer hit prima | Buffer hit dopo |
| ---------------------------------------- | -------------- | ------------- | ---------------- | --------------- |
| Acquisizioni per 256 opere (10 campioni) | 445.243        | 3.044         | 45059            | 2050            |
| Esistenza di 12 oggetti (20 campioni)    | 29.171         | 0.594         | 1431             | 4               |

- Acquisizioni: il piano partiva dal percorso e visitava 11.032 entry per poi filtrare le opere. La query ora parte dai 256 ID e usa l'indice `work_id` con join laterale; identità delle righe confrontata. Reingest completo **85,864 → 15,835 s (5,42×)**.
- Verifica backup: il confronto sulla vista `encode(hash,'hex')` scansiva gli oggetti. Il confronto `bytea[]` usa la chiave primaria: piano `Index Only Scan`, 4 buffer hit. Anche i cursori export/verifica ordinano direttamente la chiave binaria; hash e formato restano invariati.
- Selezione prossimo documento: con statistiche precedenti allo svuotamento della coda e 1.000 documenti residui, il merge join percorreva 10.033 documenti. Il join laterale mantiene `FOR UPDATE SKIP LOCKED` e cerca il solo ID pendente. EXPLAIN: **16,418 → 1,778 ms**, buffer hit **6.604 → 123** (letture 1.490 → 4). È uno scenario riprodotto di statistiche obsolete; dopo ANALYZE il vecchio planner può già scegliere un piano efficiente. Non si presenta come accelerazione universale.

Dimensioni principali, comprensive degli indici:

| Tabella                | Righe stimate PG | Totale MiB | Indici MiB |
| ---------------------- | ---------------- | ---------- | ---------- |
| catalog_work_tags      | 167736           | 70.63      | 51.87      |
| catalog_work_filters   | 167736           | 70.56      | 51.80      |
| catalog_documents      | 11032            | 61.92      | 19.27      |
| catalog_snapshot_views | 11032            | 40.55      | 0.44       |
| catalog_tags           | 57661            | 31.44      | 21.91      |
| archive_object_data    | 107054           | 20.02      | 8.82       |
| archive_payloads       | 22065            | 18.02      | 1.62       |
| catalog_entities       | 22140            | 14.35      | 6.96       |

I due indici di associazioni tag/filtri pesano più degli oggetti canonici. Sono proiezioni per semantiche diverse, non duplicati rimossi senza prova. Non è stato misurato un catalogo da milioni di opere: questi tempi non ne dimostrano la latenza.

## C. Ricerca e indicizzazione

100 richieste per variante, incluse faccette, PIT OpenSearch e idratazione PostgreSQL; escluso HTTP. Non sono il solo campo `took` di OpenSearch. Risultati numerosi paginati, senza materializzare tutto il catalogo.

| Variante | Risultati | Media ms | P50 ms | P95 ms | P99 ms |
| -------- | --------- | -------- | ------ | ------ | ------ |
| all      | 11032     | 67.23    | 63.02  | 99.72  | 121.53 |
| simple   | 1728      | 42.59    | 40.71  | 64.84  | 78.71  |
| advanced | 208       | 41.44    | 40.47  | 53.39  | 65.83  |
| fulltext | 1360      | 55.89    | 52.23  | 79.13  | 91.70  |
| combined | 5280      | 54.80    | 48.72  | 92.74  | 107.20 |
| complex  | 788       | 53.24    | 50.61  | 75.45  | 96.45  |

Varianti: `all` catalogo completo; `simple` love; `advanced` titolo love, parole >1.000, ordinamento parole; `fulltext` frase “I love you”; `combined` inglese, 1.000–50.000 parole, esclusione Major Character Death, ordine kudos; `complex` love OR home −war con frase full-text/“she said”, ordine aggiornamento. Parametri esatti nello script di benchmark.

| Concorrenza | n   | Richieste/s | Media ms | P50 ms | P95 ms | P99 ms |
| ----------- | --- | ----------- | -------- | ------ | ------ | ------ |
| 1           | 120 | 18.86       | 53.02    | 50.60  | 76.32  | 80.49  |
| 4           | 120 | 58.11       | 67.79    | 63.73  | 98.35  | 107.61 |
| 8           | 120 | 76.05       | 103.64   | 103.44 | 138.48 | 151.68 |

Indicizzazione iniziale: proiezione catalogo **398,603 s**, full-text di **11.032 opere in 464,521 s (23,75 opere/s)**; intera fase **867,264 s**. Nessun documento fallito. Indice primario a fine fase **452,33 MiB**, translog non ancora consolidato **407,33 MiB**: la dimensione live varia durante merge/flush. Il successivo reindex di 1.000 documenti dopo l'ottimizzazione impiega **32,729 s (30,55 opere/s)**; campione caldo e dimensione differente, quindi **non** un prima/dopo dell'intera indicizzazione.

La proiezione catalogo seriale e l'indicizzazione rimangono il costo dominante della prima acquisizione completa: molto più lunghe del solo ingest. Il throughput OpenSearch comprende decompressione, costruzione dei documenti e commit della coda, non soltanto il tempo server di indicizzazione.

## D. Lettura pack e API

1.000 letture per concorrenza di oggetti selezionati in ordine hash (accessi sparsi), 17,889 MiB decodificati per passaggio, inclusi apertura, lettura, decompressione e SHA-256. Cache calda.

| Concorrenza | Media ms | P50 ms | P95 ms | P99 ms | MiB/s  |
| ----------- | -------- | ------ | ------ | ------ | ------ |
| 1           | 0.501    | 0.451  | 0.844  | 1.431  | 35.57  |
| 4           | 0.834    | 0.712  | 1.503  | 2.711  | 85.38  |
| 8           | 1.219    | 1.035  | 1.898  | 2.953  | 116.26 |

Dopo `POSIX_FADV_DONTNEED` sui soli pack privati: concorrenza 1, media **0.636 ms**, P95 **1.308 ms**, **28.01 MiB/s**. È un suggerimento di eviction al filesystem, non una prova di disco fisico freddo; cache hypervisor/dispositivo non controllate. Nessun `drop_caches` globale.

Apertura capitolo tramite servizio applicativo: 200 campioni, media **7,789 ms**, P50 **7,370**, P95 **13,439**, P99 **18,659 ms**. Percorso reale HTTPS con cookie di sessione, gateway e JSON, 100 campioni per endpoint:

| API     | Media ms | P50 ms | P95 ms | P99 ms |
| ------- | -------- | ------ | ------ | ------ |
| search  | 62.82    | 59.93  | 88.82  | 100.48 |
| work    | 12.67    | 12.24  | 18.05  | 22.13  |
| chapter | 10.91    | 10.52  | 14.99  | 16.91  |

Il browser ha aperto catalogo e lettore a 1440, 820 e 390 px; nessun errore JavaScript e nessun overflow dopo la correzione della navigazione Operations. Queste latenze non includono la rete Internet o NPM dell'installazione definitiva.

## E. Compressione, deduplicazione e capacità

| Dato                                        | Valore          |
| ------------------------------------------- | --------------- |
| Oggetti canonici non compressi              | 927.62 MiB      |
| Record nei pack                             | 277.37 MiB      |
| Rapporto raw/record                         | 3.344×          |
| Record pack / ZIP sorgente                  | 1.272×          |
| Pack / dimensione media                     | 51 / 5.44 MiB   |
| PostgreSQL dopo ingest                      | 122.03 MiB      |
| PostgreSQL dopo proiezione                  | 420.66 MiB      |
| Componenti logici / componenti fisici unici | 96.252 / 73.906 |
| Deduplicazione componenti                   | 23.22%          |

I componenti sono i riferimenti ai contenuti delle opere; i 107.054 oggetti fisici complessivi includono anche manifest, metadati, provenienza e ausiliari. Ogni pack aggiunge 8 byte di intestazione ai record contati. Il formato preserva informazioni assenti dal semplice ZIP: non si promette che il risultato sia più piccolo del dump già compresso.

| Tipo             | Oggetti | Raw MiB | Record MiB |
| ---------------- | ------- | ------- | ---------- |
| asset            | 11032   | 9.94    | 6.74       |
| chapter_html     | 22928   | 399.21  | 170.20     |
| chunk_manifest   | 2       | 0.00    | 0.00       |
| css              | 1       | 0.00    | 0.00       |
| document_html    | 11032   | 19.18   | 12.40      |
| manifest         | 11032   | 42.82   | 22.46      |
| metadata         | 11032   | 19.60   | 12.53      |
| notes_html       | 17880   | 7.78    | 9.18       |
| observation      | 11032   | 28.28   | 16.23      |
| package_metadata | 11033   | 29.99   | 14.27      |
| source_auxiliary | 50      | 370.82  | 13.36      |

Gli ausiliari sorgente costituiscono circa il 40% dei byte raw e sono molto comprimibili: il rapporto complessivo non è il rapporto dei soli capitoli. Manifest, provenienza e piccoli record spiegano una parte significativa dell'overhead. I dati sono preservati, non eliminati per migliorare il benchmark.

Codec su 256 capitoli reali, 4.657.405 byte raw, un passaggio per livello:

| Zstd | Output byte | Compressione ms | MiB/s  | Decompressione ms | MiB/s  |
| ---- | ----------- | --------------- | ------ | ----------------- | ------ |
| 1    | 2002173     | 42.731          | 103.94 | 16.142            | 275.17 |
| 3    | 1923169     | 54.610          | 81.33  | 17.974            | 247.12 |

Il livello 3 risparmia il 3,95% rispetto al livello 1 in questo piccolo campione, a costo di maggiore CPU. I tempi del codec non equivalgono al throughput dell'intero archivio. È mantenuto il livello 3 predefinito.

## F. Container e risorse

Docker stats campionato ogni secondo solo sui container della fixture. CPU 100% = un core; RAM working set = usage − inactive_file, quindi comprende cache attiva e non coincide con RSS. Container riutilizzati fra fasi: le cache possono persistere. I/O indica byte attribuiti da cgroup, anche writeback differito; `n.d.` significa contatore non restituito, non zero. RX/TX include il traffico interno fra servizi (non va sommato come traffico esterno).

### Ingest 2/2

| Container | n   | CPU % media | RAM media MiB | RAM max MiB | Read MiB | Write MiB | RX MiB | TX MiB |
| --------- | --- | ----------- | ------------- | ----------- | -------- | --------- | ------ | ------ |
| worker    | 51  | 220.48      | 534.29        | 642.86      | 97.20    | 277.50    | 8.66   | 167.96 |
| pg        | 51  | 71.65       | 172.00        | 287.76      | 64.31    | 430.28    | 167.96 | 8.66   |
| search    | 51  | 3.26        | 1435.80       | 1437.48     | 0.00     | 0.52      | 0.00   | 0.00   |
| redis     | 51  | 0.86        | 8.26          | 8.50        | 0.00     | 0.00      | 0.00   | 0.00   |

### Ingest 1/1

| Container | n   | CPU % media | RAM media MiB | RAM max MiB | Read MiB | Write MiB | RX MiB | TX MiB |
| --------- | --- | ----------- | ------------- | ----------- | -------- | --------- | ------ | ------ |
| worker    | 68  | 144.32      | 888.01        | 999.64      | 0.31     | 579.14    | 8.54   | 166.59 |
| pg        | 68  | 43.84       | 469.02        | 495.89      | 8.13     | 287.01    | 166.60 | 8.54   |
| search    | 68  | 14.10       | 1895.84       | 1937.21     | 0.03     | 0.37      | 0.00   | 0.00   |
| redis     | 68  | 0.81        | 8.10          | 8.33        | 0.00     | 0.00      | 0.00   | 0.00   |

### Ingest 6/4

| Container | n   | CPU % media | RAM media MiB | RAM max MiB | Read MiB | Write MiB | RX MiB | TX MiB |
| --------- | --- | ----------- | ------------- | ----------- | -------- | --------- | ------ | ------ |
| worker    | 42  | 298.94      | 941.71        | 1072.18     | 0.11     | 271.48    | 8.34   | 167.11 |
| pg        | 42  | 96.70       | 552.13        | 618.60      | 0.02     | 430.21    | 167.11 | 8.34   |
| search    | 42  | 1.20        | 1915.00       | 1917.37     | 0.00     | 0.14      | 0.00   | 0.00   |
| redis     | 42  | 0.89        | 7.99          | 8.16        | 0.00     | 0.00      | 0.00   | 0.00   |

### Reingest ottimizzato

| Container | n   | CPU % media | RAM media MiB | RAM max MiB | Read MiB | Write MiB | RX MiB | TX MiB |
| --------- | --- | ----------- | ------------- | ----------- | -------- | --------- | ------ | ------ |
| worker    | 17  | 137.52      | 640.50        | 706.93      | 0.05     | 410.27    | 128.21 | 23.76  |
| pg        | 17  | 78.47       | 397.75        | 419.19      | 35.37    | 16.96     | 23.76  | 128.21 |
| search    | 17  | 1.13        | 1885.13       | 1885.72     | 0.00     | 0.05      | 0.00   | 0.00   |
| redis     | 17  | 0.77        | 8.14          | 8.38        | 0.00     | 0.00      | 0.00   | 0.00   |

### Catalogo e full-text

| Container | n   | CPU % media | RAM media MiB | RAM max MiB | Read MiB | Write MiB | RX MiB | TX MiB |
| --------- | --- | ----------- | ------------- | ----------- | -------- | --------- | ------ | ------ |
| worker    | 868 | 36.91       | 368.34        | 520.11      | 52.18    | 0.08      | 445.89 | 940.56 |
| pg        | 868 | 49.47       | 332.60        | 372.51      | 3.98     | 2017.81   | 529.44 | 440.16 |
| search    | 868 | 22.70       | 1606.98       | 1791.16     | 0.25     | 1211.31   | 411.12 | 5.73   |
| redis     | 868 | 0.70        | 8.19          | 8.48        | 0.00     | 0.00      | 0.00   | 0.00   |

### SQL, ricerche e lettura

| Container | n   | CPU % media | RAM media MiB | RAM max MiB | Read MiB | Write MiB | RX MiB | TX MiB |
| --------- | --- | ----------- | ------------- | ----------- | -------- | --------- | ------ | ------ |
| worker    | 47  | 31.76       | 462.43        | 497.67      | 0.46     | 0.01      | 198.42 | 5.81   |
| pg        | 47  | 11.90       | 363.28        | 379.67      | 1.00     | 0.56      | 3.27   | 194.06 |
| search    | 47  | 195.22      | 1855.29       | 1892.00     | 3.69     | 76.81     | 2.53   | 4.36   |
| redis     | 47  | 0.77        | 8.13          | 8.13        | 0.00     | 0.00      | 0.00   | 0.00   |

### API HTTPS

| Container | n   | CPU % media | RAM media MiB | RAM max MiB | Read MiB | Write MiB | RX MiB | TX MiB |
| --------- | --- | ----------- | ------------- | ----------- | -------- | --------- | ------ | ------ |
| api       | 22  | 43.43       | 125.75        | 162.93      | n.d.     | n.d.      | 21.73  | 17.45  |
| web       | 22  | 1.61        | 15.36         | 17.05       | 0.09     | 0.00      | 15.55  | 16.52  |
| pg        | 22  | 15.30       | 141.07        | 150.19      | 0.14     | 1.47      | 1.90   | 20.82  |
| search    | 22  | 39.91       | 1514.69       | 1518.09     | 0.00     | 0.08      | 0.28   | 0.51   |
| redis     | 22  | 0.76        | 8.26          | 8.51        | 0.01     | 0.01      | 0.01   | 0.05   |

Le somme delle CPU medie sono circa 2,96 core nell'ingest 2/2 e 3,98 core nel 6/4; nella ricerca il costo principale è OpenSearch (1,95 core medi nella fase mista). Non sono stati osservati OOM o saturazione dei 14 vCPU nel campione. Non è stata misurata la latenza degli altri servizi dell'host: assenza di quote non equivale a garanzia di assenza d'interferenza.

Consumo aggregato della fixture (somma delle medie per container):

| Fase            | CPU media, core | RAM media MiB | Read MiB | Write MiB |
| --------------- | --------------- | ------------- | -------- | --------- |
| ingest-default  | 2.96            | 2150.35       | 161.52   | 708.30    |
| ingest-parallel | 3.98            | 3416.84       | 0.12     | 701.84    |
| projection      | 1.10            | 2316.11       | 56.41    | 3229.20   |
| queries         | 2.40            | 2689.13       | 5.14     | 77.38     |
| packs           | 1.23            | 2619.99       | 0.01     | 0.00      |
| http            | 1.01            | 1805.13       | n.d.     | n.d.      |

La fase pack dura circa 1,3 secondi: il campionamento Docker a 1 s è troppo breve per dedurre picchi affidabili o saturazione. I picchi per container non vengono sommati come se fossero simultanei.

## Backup ed export: granularità delle operazioni

La prova del corpus ha evidenziato controlli filesystem ripetuti anche durante
l'accumulo di righe in memoria o per oggetti già presenti nella base incrementale.
I controlli di mount, identità e spazio sono ora eseguiti prima delle scritture;
restano cancellazione, SHA-256, fsync, pubblicazione atomica e verifica della catena.
La cattura SQL scrive blocchi da massimo 1 MiB (o la singola riga se più grande),
con flush anche alla fine di ogni fetch da 128 righe. Formato NDJSON invariato.

Probe sullo stesso snapshot di `archive_object_data`, 10.000 righe reali,
1.501.971 byte, un passaggio per implementazione, stessa destinazione verificata:

| Cattura SQL      | Tempo s | Controlli prima della scrittura | Blocco massimo byte |
| ---------------- | ------- | ------------------------------- | ------------------- |
| Prima, per riga  | 22,584  | 10.000                          | 158                 |
| Dopo, per blocco | 0,248   | 79                              | 19.276              |

SHA-256 dei due file identico; miglioramento **90,9× di questa fase**, non
un'accelerazione attribuita all'intero backup. Misura raccolta durante le prove
di recovery e UI sullo stesso host condiviso. `benchmark-backup-capture.cjs`
richiama la funzione effettiva precedente e quella attuale, senza duplicare il
motore nel prodotto. Una cattura MVCC incompleta è stata interrotta nella sola
fixture e ricreata; i due export già committati sono stati riutilizzati. I tempi
di riapertura/verifica di tali export non sono tempi di creazione da zero.

Il caricamento SQL del restore completo usa gli stessi limiti di 128 righe/1 MiB
e passa il JSON originale a PostgreSQL, preservando gli interi oltre 2^53.
La riconciliazione del restore piattaforma resta sul percorso esistente.
`benchmark-backup-restore.cjs`, 10.000 righe reali nello stesso database di test,
tabelle temporanee, un passaggio per implementazione:

| Caricamento SQL  | Tempo s | Controlli/INSERT | Righe risultanti |
| ---------------- | ------- | ---------------- | ---------------- |
| Prima, per riga  | 25,253  | 10.000           | 10.000           |
| Dopo, per blocco | 0,358   | 79               | 10.000           |

Fingerprint SQL dei valori identico, **70,6× per questa fase**. Verifica dei pack,
checksum, migrazioni e commit non sono inclusi nel probe. Il restore reale è stato
interrotto prima del commit e ripreso: i tempi della sua ripresa sono distinti
da quelli di una prima estrazione dei file su disco vuoto.

Export incrementale completo, stessi corpus e base, una esecuzione per motore:

| Export incrementale | Tempo s | Oggetti nella catena | Delta byte |
| ------------------- | ------- | -------------------- | ---------- |
| Prima               | 615.272 | 107187               | 31425466   |
| Dopo                | 102.480 | 107187               | 31425466   |

**6.00×**, catalogo e inventario degli oggetti identici, catena nuovamente
verificata con SHA-256. La misura include verifica della base, cattura, packing e
verifica finale; non è il solo tempo di copia del delta. Il confronto è eseguito
in sequenza durante il recovery isolato: concorrenza I/O e cache condivisa sono
parte delle condizioni, non un SLO. I file compilati precedenti usati dai probe
sono conservati nei risultati privati (`backup-engine-before-batch.cjs`,
`archive-export-before-skip.cjs`); il wrapper standard misura il motore corrente.

La base contiene **107.171 oggetti e 1.076.550.217 byte in 17 volumi** con soglia
64 MiB; l'incrementale aggiunge **31.425.466 byte** (circa 2,92% della base), inclusi
i segmenti di catalogo modificati. Una revisione controllata della fixture porta
i conteggi canonici a **11.033 snapshot, 22.929 revisioni e 107.057 oggetti**:
soltanto **3 oggetti fisici nuovi**, **20.552 byte raw / 9.665 byte nei record**
e un pack aggiuntivo, mantenendo tutte le versioni precedenti. I segmenti di
catalogo dell'export spiegano perché il delta archivistico è più grande dei
soli oggetti canonici aggiunti. Nessuna revisione dei dump originali è modificata.

## Disaster recovery sul corpus reale

Backup e restore del corpus sopra descritto, con una revisione storica aggiunta
alla sola fixture e un account locale di test con bookmark, progresso e
annotazione. Database di destinazione distinto nello stesso PostgreSQL isolato;
PackStore distinto, senza accesso alle sorgenti originali durante il restore.

| Operazione                                         | Tempo s | Condizione                                                              |
| -------------------------------------------------- | ------- | ----------------------------------------------------------------------- |
| Backup completo, cattura e verifica                | 282,827 | Nuova cattura MVCC dopo interruzione della precedente                   |
| Backup piattaforma                                 | 37,484  | Nuova cattura, corpus escluso                                           |
| Restore completo                                   | 255,077 | Ripresa dopo rollback; file già estratti riutilizzati e verificati      |
| Rilettura SHA-256 dei 107.057 oggetti ripristinati | 18,657  | Successiva al restore, letture in gruppi di 256                         |
| Restore piattaforma                                | 193,620 | Corpus compatibile, nessun account locale, inclusa verifica riferimenti |

Confronto identico di conteggi e fingerprint SQL su nove tabelle: **11.032 opere,
11.033 snapshot, 22.929 revisioni, 22.931 associazioni snapshot/capitolo,
107.057 oggetti**, account e tre tipi di dati personali. Il restore piattaforma
preserva corpus e versioni, ricostruisce i dati personali e segnala **0 riferimenti
irrisolvibili**. Le fingerprint servono al confronto delle righe; SHA-256 verifica
separatamente contenuti, manifest e volumi. Una conferma errata viene rifiutata.
Non si presenta il tempo della ripresa come misura di un restore a disco freddo.

La prova separata del writer ha scritto e verificato due volumi di **2.147.483.648
e 8 byte**, con 129 oggetti di fixture, in **40,084 s**. Il corpus reale usa 17
volumi base e uno incrementale, con soglia 64 MiB; la catena incompleta viene
rifiutata. Il limite fisico da 2 GiB è quindi verificato, senza attribuire il
throughput della fixture sintetica al corpus reale.

CLI standalone su host Node 22, con API, worker, PostgreSQL, OpenSearch e Redis
spenti e variabili database/storage rimosse dall'ambiente:

| Operazione CLI | Tempo s | Campione/esito                                                                  |
| -------------- | ------- | ------------------------------------------------------------------------------- |
| `verify`       | 29,357  | Due export, 107.187 oggetti, SHA-256 valido                                     |
| `import`       | 382,477 | 107.187 file canonici estratti, verifica preventiva e fsync per file            |
| `list`         | 1,195   | 11.032 opere elencate                                                           |
| `read`         | 31,323  | Un oggetto identico al file estratto, inclusa nuova verifica dell'intera catena |

La prova importa in una directory nuova e privata; non ricostruisce PostgreSQL
e non dipende dal backend. L'incremento include i segmenti aggiornati del catalogo,
quindi la cardinalità archivistica supera quella dei soli oggetti canonici.

## Ottimizzazioni frontend e correttezza

Il caricamento differito delle pagine amministrative riduce il bundle iniziale JS **822,47 → 687,57 kB** (gzip **247,36 → 210,90 kB**, −14,7%) e il CSS iniziale **101,52 → 81,82 kB**. Misure Vite, non tempi di rete simulati. La PWA continua a precacheare i chunk della release: non si dichiara una riduzione equivalente del download offline totale. Design e funzionalità restano condivisi.

Corretto l'overflow della navigazione Operations a 390 px: larghezza documento **475 → 390 px**, mantenendo tutti i collegamenti accessibili su righe successive. Corretta anche l'isolazione dei test browser: ogni flusso di primo setup ha un database e un PackStore propri, senza dipendere dall'ordine dei test.

Il reset di sviluppo incontrava vincoli FK introdotti dai moduli personali e di
integrità, anche con tabelle vuote. Ora blocca prima dell'accodamento la presenza
di riferimenti personali, ripete il controllo sotto lock nel worker e include
soltanto le dipendenze vuote nel reset. Verificati rifiuto, inserimento concorrente
tra richiesta ed esecuzione, pulizia delle ricevute operative e conservazione di
account/audit; nessun `CASCADE` sui dati utente.

## Scalabilità e configurazione raccomandata

Estrapolazione aritmetica del **solo motore ingest**: `923,7 × 1024 MiB / throughput sorgente / 3600`. Non è una durata misurata né un impegno sul batch completo.

| Profilo  | Ore stimate per 923,7 GiB |
| -------- | ------------------------- |
| single   | 80.2                      |
| default  | 59.0                      |
| parallel | 48.4                      |

La stima esclude indicizzazione, metadata SQLite, media esterni, guasti, checkpoint di milioni di record, aumento degli indici e contesa host. La proiezione misurata aggiunge oltre 14 minuti per questo ZIP: **48–80 ore non è una previsione end-to-end** del corpus completo. Nessuna importazione massiva è stata avviata.

Scenario di capacità, a parità della distribuzione osservata: pack + DB proiettato + indice primario = **1150.4 MiB** per 11.032 opere, circa **101.8 GiB per milione**. Non include translog/WAL, staging, export non compressi, backup, cache, repliche né versioni future. Queste ultime aggiungono solo oggetti nuovi e metadati, con dedup globale, ma non hanno un tasso prevedibile. La latenza a milioni di opere non è stata misurata: non si estrapola linearmente il P95.

Un secondo scenario aritmetico, per **un milione di opere con la stessa complessità media** del campione, dà circa **1,01 ore** di ingest a 6/4, **10,04 ore** di proiezione catalogo e **11,70 ore** di full-text ai throughput osservati. Questi ultimi due processi, non il parser, determinano quanto rapidamente la biblioteca diventa ricercabile. Sono estrapolazioni a throughput costante, non misure: indici più grandi, opere più lunghe e cache insufficiente possono peggiorarle. Senza la cardinalità e la distribuzione del corpus completo non è attendibile convertire i 923,7 GiB in una durata end-to-end.

Per ingest massivo sul presente host: partire dal profilo **6 parser / 4 commit**, gruppi **256**, pool libuv **8**, Zstd **3**, misurando lag delle proiezioni e spazio prima di aumentare ancora. Il default **2/2** rimane adatto alla convivenza con l'uso interattivo. I benchmark non hanno quote; nell'uso permanente mantenere risorse configurabili e budget espliciti condivisi con gli altri servizi, senza dedurre limiti sicuri dai soli picchi di questo campione. Heap OpenSearch 1 GiB è sufficiente per la prova da 11.032 opere, non una raccomandazione dimensionale per milioni.

Per applicare il profilo 6/4 in produzione, il limite worker predefinito di 1 GiB
non offre margine sul massimo osservato di 1.072 MiB: aumentarlo prima del batch.
Un budget iniziale proposto è **`INGEST_CPUS=4`, `INGEST_MEMORY=4g`**, tenendo conto
anche di backup/export eseguiti nello stesso worker. È una configurazione da
validare sul carico permanente, non un ulteriore benchmark con quote: nessuna
delle misure qui riportate è stata eseguita con questi limiti. Conservare 2/2 per
l'uso interattivo e adattare separatamente heap/risorse OpenSearch al catalogo.

Tenere PostgreSQL, OpenSearch e temporanei su filesystem con margine reale. Una prima esecuzione della suite aveva il temporaneo sul filesystem root al 98%: OpenSearch ha correttamente bloccato le scritture per flood-stage. La verifica è stata spostata sul disco di test, senza disabilitare le soglie. Pianificare separatamente spazio per snapshot/cattura/export, retenzione e un backup esterno verificato prima dell'ingest massivo.

## Riproduzione ed evidenze

Richiede Docker Linux, Node ≥22.12, dipendenze native e Chromium come da README; nessuna porta pubblicata e nessuna credenziale produttiva. Costruire prima l'immagine dalla revisione da misurare:

```sh
docker build -f infra/Dockerfile --target api -t palimora-release-api:1.0.0 .
RELEASE_BENCH_ROOT=/mnt/sdb/palimora-release-nuova-prova \
  RELEASE_RECOVERY=1 ./scripts/benchmark-release.sh
```

La directory deve essere nuova; il wrapper rifiuta di riusarla. `RELEASE_KEEP=1` conserva i container per ulteriori diagnosi; altrimenti li rimuove lasciando i risultati e i dati privati. Il percorso del dump è configurabile con `AO3_DUMP_ROOT`; la prova seleziona soltanto `queue119_archive05.zip`. `scripts/rehearse-release-recovery.sh ROOT` completa UI/restore/CLI su una fixture benchmark conservata che non abbia già i container API/web.

Le misure qui pubblicate derivano dalle singole fasi degli stessi script, eseguite prima e dopo le correzioni. Il wrapper finale raccoglie la sequenza; i valori pre-correzione non sono riprodotti dal codice ottimizzato senza tornare alle query baseline incluse nei probe. I piani sono riproducibili con `benchmark-query-plan.cjs`, `benchmark-index-plan.cjs`, `benchmark-backup-plan.cjs` nel worker di test. Il campione SQLite e il suggerimento di eviction sono prove supplementari, separate dal wrapper standard.

Evidenze locali private: `/mnt/sdb/palimora-release-6c-20261108/results/`, JSON delle fasi, piani EXPLAIN, campioni Docker a 1 s e screenshot. Non sono copiati nel repository perché possono contenere riferimenti al corpus. Questo report contiene i dati aggregati consultabili. Le verifiche funzionali e i relativi limiti sono registrati nella chiusura 6C di [09](09-milestone.md).
