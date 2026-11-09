# Storage Overhaul pre-ingest

Riferimento iniziale: `1a7dd6ac65e7d6dbfa154113c50fefef5c7a09fc`.
Nessun ingest massivo, deployment o modifica delle sorgenti originali.
Il primo ingest resta **NO-GO**. Le misure di questa indagine non autorizzano
un layout o una capacità inferiori alle riserve operative approvate.

## Identità e capacità

Il censimento legge soltanto colonne URL SQLite e directory centrali ZIP,
con input Docker `readonly`, rete assente, un core e 512 MiB. Non decomprime
i testi per contare le identità. Bitmap da 128 MiB (ID interi minori di 134.217.728); eventuali
ID esterni al dominio sono contati esplicitamente, mai ignorati come duplicati.
L'esecuzione ha impiegato 529 s, con RSS Python massimo 156.032 KiB.
Nessun ID osservato cade fuori dal dominio della bitmap.
I conteggi URL sono esatti nel dominio osservato. Gli ID ricavati dai suffissi
ZIP sono **candidati**, non identità canoniche verificate nel contenuto.

| Sorgente/tabella | Righe effettive | ID distinti | Senza URL AO3 |
|---|---:|---:|---:|
| ao3 / ao3_metadata | 22.249.303 | 14.495.580 | 1 |
| ao3_deduped / ao3_metadata | 17.656.566 | 16.178.783 | 1 |
| ao3_old_files / metadata_full_old | 7.973.784 | 7.447.191 | 32 |
| ao3_old_files / stories | 357.812 | Tutti già in metadata_full_old | 0 |

Il censimento separato di `ao3_tags` conta esattamente 14.467.138 tag (chiave
primaria intera), con 3.466.917 `merger_id` non nulli: non sono nuove opere.
Il costo del grafo completo non si deduce dal solo numero di archi; la densità
delle closure resta una sensibilità esplicita.

Totale: **48.237.465 acquisizioni metadata potenziali**, ma **16.468.371 ID
SQLite distinti**. Tutti gli ID di `ao3` compaiono in `ao3_deduped`.
Intersezioni con il vecchio SQLite: 7.157.594 per `ao3`, 7.157.603 per
`ao3_deduped`. Le righe ripetute non si possono eliminare: locator, osservazione,
contenuto metadata e provenienza restano indipendenti dall'identità corrente.

I 139 ZIP completi contengono 30.407.749 membri non-directory: 15.301.809 ID
candidati distinti e 4.048.643 membri senza ID ricavabile dal suffisso.
269.093 occorrenze di ID sono ripetute all'interno del rispettivo ZIP.
L'intersezione candidati ZIP/URL SQLite è 14.989.315; l'unione è 16.780.865.
Il secondo passaggio sulle directory misura separatamente duplicati interni
al file e duplicati rispetto agli ZIP precedenti: 172,90 s e RSS massimo
165.968 KiB. `.part` esclusi dal censimento.

Non si può chiamare questa unione «numero esatto delle opere». I nomi possono
non rispecchiare l'identità nel documento; i membri sconosciuti comprendono TXT,
CSV e artefatti. I CSV possono rappresentare più opere per membro. Condizionata
alla correttezza dei suffissi, la sensibilità per i membri mono-opera va da circa
16,47 milioni di identità già documentate a 20,83 milioni se ogni membro senza
ID fosse una nuova opera; i record CSV non verificati restano separati. Non è
un intervallo di confidenza. Conteggi esatti di snapshot distinti richiedono
parsing e confronto canonico: **non si deducono dalle sole identità**.

I circa 2.351 GiB PostgreSQL attribuiti ai metadata nello scenario centrale P5
non sono una capacità dimostrata. I limiti basati su rowid coincidevano qui con
le somme dei conteggi, ma la proiezione di costi per riga confonde acquisizioni,
storia e nuove proiezioni correnti. La correzione non consiste nel dividere tutta
la componente PostgreSQL per il rapporto righe/ID: cancellerebbe dal modello
anche costi storici e di provenienza legittimi. Condizionata alla validità degli
ID nei nomi ZIP, la componente SQLite aggiungerebbe 1.479.056 identità correnti,
non 48.237.465. Una decomposizione corretta è `costo_acquisizione × righe +
costo_storico × snapshot_distinti + costo_corrente × identità + dizionari/relazioni`.
Solo il terzo termine può beneficiare direttamente di quel rapporto. Nella
campagna comparativa le relazioni correnti sono misurate separatamente da storia,
dizionari e canonico. Inoltre, 60 righe del campione `ao3_deduped` provocano
un'invalidazione globale del grafo: attribuire tutta la crescita del catalogo a
quelle 60 righe amplifica artificialmente il coefficiente SQL. Il modello nuovo
addebita il catalogo corrente una sola volta per identità. Mantiene il costo
canonico/storico per acquisizione, senza presumere snapshot o provenienze
eliminabili. I risultati P5 originali restano nel JSON storico.

Se si rinuncia anche all'ipotesi che i nomi ZIP identifichino correttamente le
opere, una sensibilità estrema è 46.876.154 identità mono-opera: tutti i membri
ZIP distinti più tutti gli ID SQLite e i 34 record senza ID. Anche questa non
limita i CSV multi-opera. L'intervallo principale non copre automaticamente tale
caso: il JSON espone separatamente questa incertezza.

## PostgreSQL

La migrazione `040` elimina `catalog_metadata` e `catalog_title`. Il GIN
`catalog_search` era già stato eliminato da `024`: nessun nuovo risparmio viene
attribuito a quell'indice. Lookup correnti, upsert, fencing e recovery usano
`catalog_documents_pkey`. Filtri, ordinamenti e facet operativi usano OpenSearch.
La biblioteca usa `position(lower(...) in ...)`, non una condizione utilizzabile
dal B-tree sul titolo. Nessuna query applicativa usa containment JSONB sul
catalogo. Statistiche della fixture: zero scansioni sui due indici eliminati;
46.086 sulla primaria. Il piano del lookup corrente conserva la primaria.

Sul clone P5 a 11.032 opere, i due indici occupano rispettivamente 19.136.512 e
958.464 byte. Dopo DROP e VACUUM ordinario, `catalog_documents` passa da
65.175.552 a 45.056.000 byte totali. La primaria, i payload e le viste storiche
restano invariati. Nessuna riscrittura delle tuple è necessaria per la migrazione.

Probe non adottato: 167.736 associazioni con SHA testuale occupano 58.245.120
byte dopo ricostruzione, contro 22.585.344 con bigint; la mappa separata di
57.661 tag costa 13.664.256 byte. Il confronto con i 68.640.768 byte originali
includeva bloat e **non** è il beneficio strutturale corretto. Lookup compatto
misurato: 0,302 ms su 19 tag, non una distribuzione p95. Non è misurato il
throughput della proiezione con le nuove chiavi. Nessuna conversione viene
promossa senza validare tutti i writer, invalidazioni, identità condivise e restore.

Nella fixture, tutte le 167.736 righe di `catalog_work_filters` sono anche tag
diretti. È un limite superiore del delta eliminabile su questo corpus, non prova
che la closure sia superflua su grafi con synonym/meta/parent. Restano la
materializzazione e gli indici di navigazione. Bibliografie storiche condivise,
interning aggiuntivo e retention di `archive_cache_data` non sono adottati:
immutabilità, replay e ricalcolo storico non sono stati validati con quelle
rappresentazioni. `archive_payloads` non viene ricompresso.

## PackStore

Formato v1, reader, locator, hash e byte canonici invariati. La verifica offline
rilegge ogni record, verifica checksum compresso e SHA-256 decompresso e prova
Zstd 3/6/9, mantenendo raw gli oggetti precedentemente raw. Questo è un probe
fisico, non una misura del throughput canonico: nessun nuovo livello viene
promosso sulla sua base. Dettaglio per tipo nel JSON.

Gli header occupano 24.517.541 byte su 290.788.914, circa l'8,43%:
questa è la soglia teorica massima eliminando interamente gli header, non un
risparmio ottenibile da un header binario reale. Non si introduce un formato
fisico nuovo senza prova di compatibilità, backup, restore e recovery.

Il TXT conserva ancora `original.txt` e `work.html`. Il secondo è derivabile,
ma sostituirlo con una ricetta cambia risoluzione degli oggetti, lettura standalone,
manifest e compattazione. Il probe sui 160 TXT P5 verifica gli hash delle sorgenti
e misura 2.176.838 byte di payload HTML contro 2.251.252 byte di TXT originale; nessun locator viene
creato per oggetti non persistiti. Il primo probe con quota 1 GiB è terminato con exit 137 durante
la directory ZIP; la riesecuzione con 6 GiB è riuscita. Non si riduce quindi la
quota operativa dei grandi ZIP. Non sono introdotti dizionari pack o compressione
solid; gli asset già compressi restano raw.

## OpenSearch

La ricerca applicativa usa `_source:false`, `docvalue_fields:[generation]` e
idrata da PostgreSQL. Il bulk invia documenti completi generati dal canonico,
con revisioni/claim/fencing invariati. Non esistono `_update`/`_reindex`
applicativi dipendenti dal testo stored. Le verifiche tecniche che confrontano
il testo devono usare il canonico, non presumere `_source` completo.

La prova B esclude `text` soltanto da `_source`, mantenendo inverted index,
posizioni, analyzer, doc values e tutte le query. Su OpenSearch 2.19.4 questo
aggiunge `_recovery_source`: 426.204.691 byte originali restano recuperabili,
oltre ai 36.903.462 byte dello `_source` filtrato. Prima dei merge non si ottiene
il risparmio intuitivamente atteso. Non si disabilita né si filtra il recovery.
La decomposizione Lucene distingue stored fields complessivi, postings,
posizioni e doc values, anche dentro compound files. Le dimensioni compresse
per singolo campo stored non sono separabili dal totale dei blocchi condivisi.

La campagna usa copie isolate dell'indice del corpus P5 con 11.032 EPUB distinti,
quote OpenSearch 2 CPU/3 GiB e client 1 CPU/1 GiB. Confronta default,
best_compression, Zstd 1/3/6 e combinazione con source filtering. Nessun dato
artificialmente ripetuto. Per ciascun indice registra bulk, translog, segmenti,
refresh/flush e confronto di risultati, score, generazioni e facet. Le operazioni
Lucene di misura aggiungono carico: i tempi non sono un benchmark di ingest
end-to-end né una misura isolata di sola CPU del codec.

I force merge sono diagnostici **solo sugli indici storage-bench-***: i byte
precedenti e i picchi restano nel report. Il risultato dopo force merge non
sostituisce il budget di scrittura/manutenzione. Nessuna riduzione del 25% di
margine o della riserva per riscrittura del componente maggiore è autorizzata.

Riferimenti upstream:
[codec OpenSearch](https://docs.opensearch.org/latest/im-plugin/index-codecs/),
[recovery source e source filtering](https://github.com/opensearch-project/OpenSearch/issues/13490).
La compatibilità è provata sull'immagine 2.19.4, non inferita dalla documentazione
corrente. `derived_source` è sottoposto a creazione con il mapping effettivo;
una creazione riuscita da sola non ne certificherebbe la ricostruzione semantica.

## Verifica e limiti della consegna

Evidenze private: `/mnt/sdb/palimora-storage-overhaul/`. Si pubblicano soltanto
aggregati e strumenti, mai testi, locator dei campioni o database del dump.
I test AO3 aggiungono eliminazione dell'indice e ricostruzione da pack/PostgreSQL,
verificando hit e generazioni prima di rieseguire filtri, sinonimi, ricerca per
frase, ordinamenti e lettura storica. Test di backup/restore, export portabile,
corruzione pack, scritture parziali, crash e multisorgente sono registrati nel JSON.

Il corpus eterogeneo P5, eliminato dalla precedente pulizia, viene ricostruito
dai manifest privati verificando ogni SHA-256: 968 membri reali EPUB/TXT/HTML,
media, 240 righe SQLite, 60 tag e due revisioni esplicite da 256 capitoli.
Le due revisioni sono fixture di correttezza, non un moltiplicatore artificiale
per la densità. Il corpus aggiuntivo di 11.032 EPUB distinti stabilizza il
confronto degli indici. Non vengono generate copie ripetute per simulare milioni
di opere.

Il confronto eterogeneo usa due database, archivi e nodi OpenSearch nuovi e
separati, senza porte host: worker 4 CPU/3 GiB, proiezioni 2 CPU/1,5 GiB,
PostgreSQL 2 CPU/2 GiB, OpenSearch 2 CPU/3 GiB (heap 1 GiB). Le campagne sono
sequenziali; schema, mapping e codec sono le sole differenze applicative.
La quota del worker riguarda ZIP ricostruiti piccoli: non ridimensiona la quota
operativa di 6 GiB raccomandata per le directory ZIP originali.
Il confronto è una coppia di esecuzioni, non una stima statistica di throughput.

### Audit dei campi di ricerca

| Campi | Decisione |
|---|---|
| `text.*`, `title`, `creators`, `summary`, `notes`, `endnotes`, `tag`, `series.title` | Analyzer, norme di ranking e posizioni conservati; necessari a full-text, query complesse e frasi. Solo il testo integrale viene escluso da `_source`. |
| `generation` | Doc values necessari al controllo di generazione; stored source mantenuto anche per gli strumenti di verifica. |
| `id`, `ao3_id`, `sort_title`, `sort_authors`, `memberships.position` | Doc values necessari a ordinamenti, tie-break e cursori; nested e relativo filtro invariati. |
| `word_count`, `hits`, `kudos_count`, `comments_count`, `bookmarks_count`, `created_at`, `revised_at`, `archived_at` | Range e ordinamenti conservati. |
| `fandom`, `rating`, `warnings`, `category`, `characters`, `relationships`, `freeform`, `unclassified`, `media`, `language` | Doc values necessari ai facet esatti. |
| `title.sort`, `creators.sort` | Copie interrogabili, ma non usate dagli ordinamenti applicativi; candidato E senza i soli doc values. Risparmio dopo merge circa 0,25% rispetto a D: non adottato. |
| `epoch`, `alias`, `snapshot`, `external_id`, `memberships.id`, `filter_ids`, `entity_ids`, `language_id`, `availability` | Indici conservati per filtri, identità e query esplicite; nessuna rimozione dei doc values senza beneficio misurato. |
| `complete`, `crossover`, `restricted`, `anonymous`, `unrevealed`, `otp`, `nonfiction`, `posted`, `hidden_by_admin`, `expected_number_of_chapters`, `chapter_count` | Predicati booleani/numerici conservati. Doc values piccoli; nessun beneficio misurato che giustifichi altre varianti. |
| `series.id`, `series.position`, `series_position`, `user_ids`, `pseud_ids`, `collection_ids` | Query AO3 e appartenenze conservate; nessun indice disattivato. |
| `rating_ids`, `archive_warning_ids`, `category_ids`, `fandom_ids`, `character_ids`, `relationship_ids`, `freeform_ids`, `work_types`, `work_skin_id`, `imported_from_url` | Filtri e query esplicite conservati. Campi assenti nei documenti non generano payload da eliminare. |

Il server 2.19.4 rifiuta `index.derived_source.enabled` con HTTP 400.
La funzionalità generale è successiva ([introduzione in 3.2](https://opensearch.org/blog/save-up-to-2x-on-storage-with-derived-source/));
quella sperimentale 2.19 riguarda i vettori. Non viene proposto un cambio di
versione né viene dichiarato compatibile il mapping nested/normalizer.


## Manutenzione e spazio temporaneo

Nessun risparmio di riserva viene accreditato. La compattazione esistente ha
checkpoint atomici per gruppi, target pack di 64 MiB e limite 65.536 locator;
un singolo oggetto può superare il target. Questo limita il gruppo pubblicato,
non il picco cumulativo: i vecchi pack sono conservati fino alla raccolta finale
e le lease dei backup/reader possono trattenerli. Un crash può lasciare nuovi
pack orfani, raccolti soltanto dopo verifica dei locator e delle lease. I test
coprono pubblicazione atomica, interruzione, lettori e raccolta; non dimostrano
un nuovo limite fisico inferiore alla riscrittura completa.

PostgreSQL consente manutenzione per relazione e indice, ma le tabelle maggiori
non sono partizionate: il DROP adottato libera gli indici senza riscrivere heap,
mentre REINDEX/VACUUM FULL richiederebbero spazio aggiuntivo. Non si inventa una
soglia per relazione sul dump non acquisito. La manutenzione misurata è VACUUM
ordinario; non si attribuisce alla migrazione il recupero di bloat preesistente.

La ricostruzione applicativa OpenSearch può ricreare l'indice mancante dal
canonico, con coda persistente, generazioni e fencing; comporta indisponibilità
della ricerca durante il rebuild. Non si introduce uno swap online né una
cancellazione progressiva non validata. I merge possono tenere vecchi e nuovi
segmenti contemporaneamente: i picchi diagnostici sono conservati. Le riserve
P5 per manutenzione e margine restano almeno pari ai precedenti valori assoluti.


## Confronto eterogeneo adottato

Dopo refresh/flush, assestamento osservato e VACUUM ordinario, senza force merge:

| Componente | Prima, byte | Dopo, byte | Risparmio |
|---|---:|---:|---:|
| PackStore | 253.111.372 | 253.111.820 | 0% (variazione fixture) |
| PostgreSQL, database | 81.439.891 | 76.958.867 | 5,50% |
| OpenSearch, primario | 389.654.411 | 234.914.946 | 39,71% |
| Totale dei tre componenti | 724.205.674 | 564.985.633 | 21,99% |

I 448 byte PackStore aggiuntivi sono variazione di compressione degli UUID locali
nelle fixture indipendenti, non un cambiamento di formato o contenuto. Entrambe
hanno 36 pack, 29.320 hash/record fisici unici, zero duplicati fisici, 568.472.715
byte raw, 1.210 snapshot, 14.614 revisioni capitolo e 15.352 associazioni
snapshot/capitolo. Le 1.210 acquisizioni canoniche distinte restano tali dopo il
replay; le associazioni alle esecuzioni di acquisizione sono 1.402.

Il totale sopra esclude cluster SQL, WAL e file di servizio. I bind completi
PostgreSQL/OpenSearch/archivio passano da **899.643.951 a 723.965.814 byte
apparenti** (−19,53%); i byte allocati sono nel JSON. Non includono sorgenti,
backup o copie di laboratorio. Heap, indici e TOAST per relazione sono rilevati
nella raccolta precedente alla manutenzione finale. La baseline ha avuto retry
della raccolta dopo VACUUM: il probe DROP sul clone separato identifica il
risparmio strutturale senza confonderlo con variazioni di bloat.

| Misura | Baseline | Candidato |
|---|---:|---:|
| Ingest canonico, s | 39,77 | 35,38 |
| Proiezioni e drenaggi per sorgente, s | 268,93 | 264,58 |
| Pipeline completa, s | 311,09 | 302,42 |
| Ultimo drenaggio, s | 5,31 | 5,16 |
| CPU worker inclusa attesa drenaggio, s | 74,99 | 67,12 |
| WAL generato, byte | 126.662.206 | 114.395.173 |
| Staging massimo campionato, byte | 211.067.436 | 200.829.739 |
| WAL trattenuto massimo, byte | 150.994.944 | 134.217.728 |
| Indice + translog, massimo ai confini delle sorgenti, byte | 1.330.764.200 | 952.694.357 |
| Translog massimo campionato, byte | 431.470.051 | 431.470.051 |

La pipeline termina senza backlog. Il replay idempotente impiega 1,14/1,32 s e
non aggiunge oggetti né snapshot. L'ingest canonico cambia di −11,02%, il totale
proiezioni di −1,62%: una coppia non dimostra causalità o un throughput garantito.
Il tempo HTTP cumulativo dei bulk **aumenta** da 103,61 a 110,88 s; le richieste
sono 203 in entrambi i casi. I bulk completati contabilizzano 2.014 documenti,
comprendendo la ricostruzione dopo invalidazione del grafo. Errori transitori e
cancellazioni sono conservati nel JSON: il drenaggio applicativo recupera la coda.

| Processo | CPU campionata prima/dopo, s | Picco working set prima/dopo, MiB |
|---|---:|---:|
| worker | 75,33 / 67,35 | 573,8 / 559,5 |
| pg | 36,75 / 35,08 | 145,3 / 137,5 |
| search | 166,28 / 164,28 | 1.796,3 / 1.729,9 |
| projection | 128,25 / 123,43 | 658,2 / 646,1 |
| redis | 2,19 / 2,05 | 3,6 / 4,8 |

La CPU di questi contatori è un limite inferiore campionato, soprattutto fra
restart della proiezione; i picchi includenti page cache sono registrati separatamente.
I picchi staging sono campionati a 1 s, quelli dei merge diagnostici a 0,5 s:
non sono limiti massimi garantiti. Il working set del worker campionato internamente
raggiunge 553,7/579,7 MiB; i due campionatori hanno istanti differenti.

Con tre client, 30 richieste warm per percorso, p95 dell'handler ricerca
149,94 → 286,48 ms e reader dell'opera da 256 capitoli 844,34 → 1.172,98 ms.
Sono inclusi idratazione e cleanup PIT della ricerca, esclusi HTTP e browser.
Questi peggioramenti osservati sono riportati senza attribuirli automaticamente
al codec: il percorso PackStore/reader non è cambiato e la serie è breve.
Nessuna ottimizzazione per migliaia di utenti viene introdotta.

## Matrice OpenSearch sul corpus distinto

11.032 opere reali, stessi documenti e query. Byte ordinari e diagnostici restano
separati; le finestre di assestamento dei segmenti non coincidono con il primo flush.

| Variante | Bulk, s | Byte ordinari osservati | Byte dopo merge diagnostico |
|---|---:|---:|---:|
| a | 130,73 | 478.328.489 | 457.670.338 |
| b | 137,34 | 489.732.839 | 188.523.510 |
| c-best | 167,19 | 356.057.133 | 338.774.427 |
| c-zstd1 | 101,08 | 375.674.348 | 354.131.904 |
| c-zstd3 | 102,93 | 371.386.754 | 349.426.042 |
| c-zstd6 | 117,79 | 355.177.094 | 338.961.972 |
| d-zstd3 | 106,11 | 373.946.848 | 179.941.048 |
| e-zstd3 | 104,99 | 369.537.795 | 179.486.701 |

`a` è default; `b` esclude text; `c-*` cambia solo codec; `d-zstd3` combina
source filtering e Zstd 3; `e-zstd3` elimina inoltre i doc values dei due
multifield sort duplicati. D risparmia circa il 21,82% nella finestra ordinaria
e il 60,68% dopo merge rispetto ad A. Il picco fisico osservato nel merge A è
934.703.185 byte: il risultato finale di 457.670.338 byte non lo sostituisce.
Il documento della prova SIGKILL viene espunto dal solo indice diagnostico D
prima della misura finale: corpus nuovamente identico, zero documenti cancellati.
I byte subito dopo il merge, prima della pulizia dei vecchi segmenti, restano nel JSON.

## Alternative misurate e non promosse

- **Zstd Pack 6/9:** payload 266.270.877 → 255.767.431/253.665.006 byte,
  tempi 44,57 → 69,65/89,29 s. Il risparmio sul pack intero è 3,61%/4,34%;
  il costo CPU e la mancanza di una validazione end-to-end di quei livelli non
  giustificano cambiare il default.
- **TXT virtuale:** 2.176.838 byte di HTML compresso eliminabili sui 160 campioni.
  Trasferire linearmente quel coefficiente ai TXT del dump darebbe circa 108 GiB,
  solo come sensibilità. Occorre una rappresentazione con ricetta versionata,
  locator compatibili, reader standalone e backup/restore verificati. Non si
  adotta una scorciatoia che lasci hash senza oggetti o cambi byte storici.
- **Dizionari pack per piccoli oggetti:** prove Zstd 3 su hash di training e
  validazione disgiunti, oggetti fino a 16 KiB, massimo 1.000 per gruppo. Dopo
  aver incluso un dizionario da 16 KiB per tipo, metadata 528.673 → 333.350 byte,
  note 581.602 → 443.846, capitoli 3.026.442 → 2.641.745, documenti HTML
  439.276 → 262.858, package metadata 386.896 → 205.455. Ogni roundtrip verifica
  gli stessi byte. Non è un holdout indipendente per opera; non si estrapola
  all'intero pack. Distribuzione/versionamento dei dizionari richiederebbero
  modifiche a formato, reader e backup: candidato non adottato.
- **Header binari e frammenti condivisi:** restano l'accesso indipendente e il
  dedup per hash. L'overhead misurato non giustifica un nuovo formato senza una
  prova completa; nessuna compressione solid o ricompressione degli asset binari.
- **Chiavi SQL bigint:** beneficio netto della singola relazione misurata
  21.995.520 byte, includendo la mappa univoca. Non esteso per ipotesi a tutte le
  relazioni. Mancano prove della conversione completa, delle invalidazioni e del
  throughput con writer modificati; gli ID deterministici restano invariati.
- **Closure delta:** 20.481/20.481 associazioni dirette coincidenti nella fixture
  eterogenea, relazione filtri 8.871.936 byte. È un potenziale locale, non prova
  per il grafo completo con sinonimi, parent, meta e invalidazioni concorrenti.
- **Interning bibliografico:** 2.417 coppie current/storico, 2.415 payload distinti;
  solo 18.621 byte JSON eliminabili condividendo la coppia intera. Separando i
  campi, metadata 4.918.644 → 2.457.422 byte e bibliografia 9.642.622 → 9.619.239.
  Sono byte JSON prima di TOAST, indici e riferimenti, non risparmi SQL fisici.
  Non si modifica la semantica immutabile delle viste storiche.
- **Retention cache parser:** 970 righe, 8.348.245 byte raw, 2.017.116 byte di
  payload già compressi, circa 2,55 MB con indici/TOAST. È una cache di parsing
  ricostruibile, distinta da payload, evidenze e snapshot autoritativi. Rimuoverla
  richiede una regola transazionale che protegga acquisizioni in corso e replay;
  il trigger immutabile non viene aggirato. Nessun risparmio viene accreditato.
- **OpenSearch E/derived source:** E migliora il risultato finale di D di appena
  0,25%; non adottato. Generic derived source è rifiutato da 2.19.4. Codec
  best_compression e altri livelli Zstd non offrono un compromesso complessivo
  migliore della combinazione adottata nelle prove.

## Equivalenza e ripristino

Build completa e **19 test mirati distinti** passati: AO3, export portabile,
codec nativo, pipeline testo, archive/compattazione, backup engine, ingest
multisorgente e integrity streaming. Errori iniziali di configurazione dei test
(OPENSEARCH_URL/TYPST_PATH) sono seguiti da riesecuzioni riuscite.

La campagna confronta ogni oggetto decompresso tramite SHA-256, manifest con soli
UUID locali normalizzati, acquisizioni/provenienza, metadata e bibliografie
correnti/storiche. Ogni vista storica è legata alle sue acquisizioni prima del
confronto: ordinare soltanto per ID opera sarebbe ambiguo fra revisioni. I test
AO3 e la matrice di ricerca coprono generazioni, visibilità, sinonimi, filtri,
facet, ranking, frasi multilingua, sort e query complesse. La paginazione completa
visita 61 pagine, senza duplicati e con tutte le 1.207 generazioni visibili.

Il backup completo misura **300.143.039 byte**; creazione inclusa verifica
sorgente 53,88 s, restore dati 50,23 s, ricostruzione delle proiezioni 145,66 s.
L'intera verifica backup/restore/rebuild dura 259,87 s. Tutti i 29.320 oggetti,
le firme canoniche, le 1.210 viste storiche e le relazioni immutabili aggiuntive
sono identici. Il segreto di fixture è decifrabile con la configurazione
ripristinata; tre lettori ottengono gli stessi due documenti storici. Nessun dump
esterno è richiesto dalla ricostruzione; i test AO3 usano sorgenti non presenti
sul filesystem per provare esplicitamente quel percorso.

Il primo tentativo del runner P5 si era fermato al primo HTTP 429: 583 righe
restavano nella coda persistente, di cui due con errore HTTP_429. Il runner
Storage usa ora lo scheduler applicativo già esistente e attende anche retry e
lease, non soltanto un claim vuoto. La nuova prova completa riesce con le stesse
quote, senza cambiare retry_at, lease, fsync o controlli. Il fallimento del runner
resta nell'evidenza privata; non è stato nascosto azzerando la coda. La prova
SIGKILL separata dimostra che un documento confermato, non ancora refreshato,
resta ricercabile per frase dopo il riavvio con `_source.text` assente.

## Capacità ricalibrata

GiB binari, **sensibilità condizionate**, non intervalli statistici. Le formule e
ogni coefficiente per strato sono nel JSON. Pack e ricerca restano pesati per
byte ZIP compressi; per prudenza il testo di tutte le versioni ZIP resta nel
coefficiente ricerca, senza applicare una riduzione proporzionale agli ID duplicati.
Canonico/storia/dizionari SQL sono addebitati per acquisizione; il catalogo
corrente una volta per identità. Il costo SQL include cache parser conservate.

Gli scenari principali assumono validi gli ID candidati nei nomi ZIP: 16.780.899
opere nei primi due, 20.829.542 nel prudente; i 34 record senza ID sono conservati
separatamente. Si aggiungono circa 1,042 milioni di record CSV stimati P5, senza
presumere dedup. Le identità SQLite aggiuntive ricercabili vanno da zero (coperte
dai membri ZIP sconosciuti) a 1.479.090. I 48.237.465 record restano tutti nel
costo canonico/storico. La quota tag implicita nel campione metadata non è ridotta
al censimento reale più piccolo: scelta conservativa, non una calibrazione del
grafo completo.

| Scenario | Pack | PostgreSQL | OpenSearch | Core persistente | Working con riserve | Un backup extra |
|---|---:|---:|---:|---:|---:|---:|
| Favorevole | 1.297,3 | 1.515,3 | 1.321,6 | 4.134,1 | 7.489,6 | 3.196,9 |
| Centrale | 1.305,4 | 1.629,9 | 1.479,4 | 4.414,6 | 10.781,1 | 3.336,4 |
| Prudente | 1.316,5 | 1.708,6 | 1.588,9 | 4.614,0 | 11.149,2 | 3.438,4 |

Il PostgreSQL favorevole è maggiore della precedente ipotesi favorevole P5:
la correzione preserva sistematicamente il costo per acquisizione, senza
attribuirgli risparmi solo perché gli ID si sovrappongono. Non tutte le correzioni
al modello riducono la stima.

| Budget separato, GiB | Favorevole | Centrale | Prudente |
|---|---:|---:|---:|
| Cache metadata derivata conservata | 58,8 | 90,6 | 90,6 |
| WAL | 16,0 | 16,0 | 16,0 |
| Backlog | 8,0 | 8,0 | 8,0 |
| Staging ingest | 8,0 | 8,0 | 8,0 |
| Translog | 8,0 | 8,0 | 8,0 |
| Sorgenti non tipizzate, riserva P5 | 7,7 | 7,7 | 7,7 |
| Manutenzione | 1.736,7 | 3.546,1 | 3.642,5 |
| Margine di sicurezza | 1.512,2 | 2.682,1 | 2.754,4 |
| Working + un backup | 10.686,5 | 14.117,5 | 14.587,6 |
| Target restore separato | 7.489,6 | 10.781,1 | 11.149,2 |
| Working + backup + restore simultaneo | 18.176,1 | 24.898,7 | 25.736,8 |

Nel centrale, PostgreSQL corrente è 346,4 GiB; il
resto SQL è 1.283,5 GiB. Il termine metadata SQLite
non corrente è 655,8 GiB, contro l'attribuzione P5
indifferenziata di 2.351 GiB. Il costo corrente delle circa 1,479 milioni di
identità aggiuntive sarebbe circa 28,7 GiB,
già incluso nel conteggio globale: non va sommato di nuovo.

Se gli ID nei nomi non sono affidabili e ogni membro mono-opera fosse distinto,
la sensibilità estrema aggiunge 585,0 GiB di
catalogo corrente e 98,9 GiB di ricerca metadata al
centrale, prima di ulteriori margini. Non limita i CSV multi-opera. Ogni filtro
materializzato aggiuntivo per opera centrale vale circa 7,19 GiB
alla densità del campione: la cardinalità della closure completa resta ignota.

Il backup usa il rapporto misurato sul corpus (0,909) rispetto a
pack + database, con un ulteriore 25%; è anch'esso condizionato al mix dei dati.
Il target di restore è separato dal sistema ancora attivo: non basta lo spazio
per la sola copia del backup. Nessun risparmio della riserva di manutenzione è
attribuito alle ottimizzazioni; margine e manutenzione restano almeno pari ai
valori assoluti P5. Il fabbisogno centrale working + un backup è circa
**13,79 TiB**, esclusi dump originali e retention di ulteriori backup.

La decisione è adottare soltanto `040` e OpenSearch source filtering + Zstd 3,
conservando PackStore v1. **Il primo ingest resta NO-GO**: mancano l'approvazione
del layout fisico, la capacità da riservare e i controlli operativi;
le incertezze su identità nei nomi, CSV, snapshot distinti e closure non diventano
limiti garantiti. Non si sostiene che l'archivio sarà più piccolo del dump.
La lettura dei filesystem alle 20:00 UTC del 9 novembre trova circa 1,77 TiB
liberi su `/mnt/sdb` e 2,76 TiB su `/mnt/teratron_data`: sono spazi condivisi,
non riserve approvate. Nessuno dei due soddisfa il working centrale; nessun
layout aggregato viene assunto o applicato.

## Riproduzione

- Censimento: `storage-identity-audit.py` con dump bind `readonly`, rete assente,
  512 MiB; `--zip-only` ripete soltanto le directory centrali.
- Fixture: `restore-p5-storage-fixture.py`, manifest privati P5 e sorgenti `readonly`;
  confronto degli hash prima di qualsiasi ingest del campione.
- Due setup `benchmark-p0.sh` con `BENCH_SETUP_ONLY=1`, quote uguali e immagini
  baseline/candidato; `run-storage-campaign.py` esegue il solo corpus eterogeneo,
  replay, componenti, manutenzione ordinaria e cursori. `--collect-only` conserva
  i contatori della campagna temporizzata e scrive log di raccolta separati.
- `storage-pack-probe.cjs`, `storage-txt-probe.py`, `storage-dictionary-probe.py` e
  `storage-postgres-probe.sql` misurano alternative senza mutare il canonico.
- `storage-search-benchmark.cjs`, `storage-search-settle.py` e `StorageIndexFiles.java`
  richiedono il clone isolato con baseline `_source` completo. Il probe recovery
  opera esclusivamente sul container e sull'indice diagnostico nominati.
- `storage-backup-check.py` crea il restore separato e verifica oggetti, reader,
  SQL immutabile e coda; `storage-drain.cjs` usa lo scheduler applicativo.
- `summarize-storage-overhaul.py` aggrega i probe; `finalize-storage-overhaul.py`
  richiede campagne, equivalenze e restore riusciti prima di scrivere il report
  conclusivo e l'appendice al modello storico P5.

## Misure canoniche successive

[Final Canonical Storage Optimization](final-canonical-storage-optimization.md)
implementa TXT virtuali, metadata referenziati, manifest compatti selezionati
su byte Zstd e metadata-only unificati. Le misure di questo documento e del suo
JSON rimangono storiche: i nuovi coefficienti PackStore sono nel report
successivo. Nessuna modifica ulteriore a PostgreSQL o al modello OpenSearch.
