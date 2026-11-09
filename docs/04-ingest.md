# 04 — Ingest sorgenti incomplete e normalizzazione

## Sorgente iniziale nota

**Bind mount host `:ro`:** `/mnt/teratron_data/AO3_dumper/ao3_dump/data/ao3_stories` → `/dumps/ao3_stories`. Nessun ingest di `fanfic_stories`, FictionPress, Fimfiction o Wattpad nella v1. Dump source separato da `/mnt/sdb/palimora-data` e mai rimosso/cambiato dal pannello.

Inventario del 5 novembre 2026; ispezione read-only di schemi e campioni documentata in 09:

| Gruppo | File | Peso osservato |
|---|---:|---:|
| `*.zip` | 139 | 853,08 GiB |
| `*.sqlite3` | 3 | 53,77 GiB |
| `*.part` | 10 | 16,82 GiB |
| **Totale** | **152** | **923,67 GiB** |

Tre indici indicati: `ao3.sqlite3`, `ao3_deduped.sqlite3`, `ao3_old_files.sqlite3`. Alcuni ZIP `queue79`, `queue82`, `queue83`, `queue86`–`queue92` sono presenti come `.part`; `queue93`–`queue99` non sono elencati. **Queste non sono prove** di quali opere/versioni manchino né dell'esistenza prevista di tutti quei numeri. La verifica CRC completa è stata eseguita sullo ZIP importato in 09; il campionamento degli altri ZIP non equivale a una verifica integrale del corpus.

## Regola di prodotto

Un dump può essere **parziale per design**. L'importazione produce un archivio consultabile con tutti gli elementi recuperabili, registra le lacune e permette un ingest incrementale in futuro. Mancanza/corruzione dei file e parser sconosciuto sono **classi diverse**:

| Condizione | Esito |
|---|---|
| ZIP presente, valido | Importa streaming, valuta CRC/struttura dei membri usati |
| ZIP atteso/indicato in indice ma assente | `missing_source`, record/locator conservati, procedi |
| `.part` | `incomplete_transfer`, escluso; non aprire come ZIP completo |
| ZIP presente ma troncato/CRC errato | `corrupt_source`, documenta lacuna, importa soltanto membri indipendentemente verificabili se la struttura lo permette; procedi |
| Metadata SQLite disponibili, testo assente | Record bibliografico `metadata_only`, **non** presentarlo come un'opera completa leggibile |
| EPUB HTML malformato ma riconoscibile | Registra problema/parte recuperabile se sicura; conserva informazioni disponibili senza fingere completezza |
| Struttura sorgente o schema mai supportato, bug parser | `parser_blocked`: **sospendi il batch** con errore e contesto riproducibile; fix codice, poi retry esatto elemento |
| Disconnessione/IO temporaneo | Retry con backoff, poi quarantena della sorgente e procedi secondo policy |
| Spazio disco insufficiente, DB indisponibile | Sospensione globale ordinata, stato persistente |
| Media esterno non raggiungibile | Coda media separata, non blocca il corpus; retry e upload manuale |

Stato terminale batch `completed` oppure `completed_with_gaps`, non `failed` solo perché l'inventario sorgente è incompleto. Report attendibile: fonti disponibili/importate, file assenti/part/corrotti, opere complete/parziali/metadata-only, errori parser, byte e versioni effettivamente preservati.

## Pipeline

1. **Selezione** da pannello, CLI o directory monitorata; predefinito un dump/cartella, senza scegliere milioni di singoli file. Nel caso iniziale l'admin seleziona `/dumps/ao3_stories`.
2. **Inventario** leggero, streaming: firma file (`path, size, mtime, hash` dove calcolato), identificazione ZIP/SQLite, esistenza e indice di dipendenze noto. Non presumere che tutti i filename seguano una sequenza completa.
3. **Adapter** specifici, registrati per formato/schema, lettura ZIP64/SQLite *read-only*, batch e memoria limitati, nessuna estrazione permanente di milioni di file. SQL sorgente in sola lettura e limitato, nessuna modifica al dump.
4. **Parse** in envelope normalizzato versionato, con provenance precisa (dump, archivio, entry, record ID, reader/versione). I formati riconosciuti e verificati sono elencati sotto.
5. **Riconciliazione** per `(source, external_work_id)` o ID locale provvisorio: unisci campi non contraddittori, conserva osservazioni alternative, seleziona stato canonico usando precedenza per affidabilità/recenza **dimostrata**, non per filename. Non sovrascrivere contenuto migliore con metadata incompleti di altra copia.
6. **Persistenza**: oggetti canonici compressi e validati → transazione DB revisioni/snapshot/locator → outbox indicizzazione. L'opera completa diventa visibile appena lo snapshot è valido, senza attendere la fine del batch.
7. **Assets**: acquisizione separata di media incorporati e file direttamente collegati, riconciliazione URL/risorse e fallback manuale. Conservare sempre URL sorgente e status, anche quando un asset non è acquisibile.
8. **Checkpoint** durevoli per sorgente e record/member, con stato del parser, versione del codice e result hash; pausa/ripresa dopo Ctrl+C, crash e deploy. Riesecuzione con nuova versione adapter modifica solo le parti che richiedono riconciliazione.

## Merge e missing content

- **Unica identità, molte sorgenti/versioni:** conservare tutti gli snapshot realmente distinti. Gli stessi byte si deduplicano; acquisizioni identiche non producono nuove revisioni finte.
- **Metadata incompleti:** utilizzare l'insieme delle evidenze, mantenendo origine per campo o gruppo di campi; nuovi dati AO3 verificati potranno diventare canonici quando il sito torna online.
- **Snapshot con ordine incerto:** mantenerli e segnalare il conflitto, non fabbricare date. Ingest da sorgente incompleta non prova che l'opera sia stata eliminata da AO3.
- **Opere parziali:** conservare tutti i capitoli validi e la stima di completezza; la sola presenza di `chapters: 10/??` non implica che il download sia corrotto. La fonte potrà essere risincronizzata più tardi.
- **Bug strutturale:** arrestare il batch, creare debug bundle con record minimo, contesto e stack trace ma senza segreti; ripresa dopo fix senza rileggere da capo fonti già complete e valide.

## Sorgenti aggiunte successivamente

Una nuova scansione dell'input read-only riconosce file nuovi/riparati tramite identità/fingerprint, elabora **solo** i file/record nuovi o quelli da rielaborare e colma le lacune. L'admin non deve manipolare il DB manualmente. Un import già completato rimane valido anche se successivamente il mount dei dump viene scollegato.

## Verifica degli adapter prima dell'ingest vero

Analizzare **schemi**, primo/ultimo record e un campione casuale di entry e ZIP, senza leggere l'intero corpus. Verificare codifica, Zip64, EPUB/HTML, tipologie di ID, mappe SQLite→ZIP, versioni, metadata e provenance. Pubblicare una matrice dei formati realmente riconosciuti e congelare il contratto di input prima del grande ingest. Non dedurre il contenuto dalle sole dimensioni e dai nomi dei file.

## Adapter e contratto esecutivo

Adapter `ao3-dump-4`, record NDJSON `palimora.ingest.v1`, raggruppati dal worker
tramite il trasporto `palimora.ingest.group.v1`. Predefinito 256 record per gruppo,
con soglia di 16 MiB di dati sorgente/metadati, controllata dopo ogni record:
il record che supera la soglia resta intero. Si scarica anche dopo 500 ms
di preparazione. `INGEST_GROUP_RECORDS` accetta 1–1024;
1 conserva il trasporto individuale.
Il core esegue 1–4 gruppi concorrenti (`INGEST_COMMIT_CONCURRENCY`, default 2,
4 nel dev), ordinati per identità/provenienza dell’opera e con lock DB per identità.
Il parser anticipa al massimo concorrenza+1 gruppi. Le ricevute `ingest_progress`
sono committate insieme al catalogo: checkpoint e contatori avanzano soltanto sul
prefisso contiguo. Dopo un crash si riparte dal primo buco; i record successivi
committati si riconoscono senza duplicare snapshot o contatori, anche cambiando
la dimensione dei gruppi. Gli ack seguono l’ordine sorgente, dopo seal e commit;
allora il parser libera i segmenti non più usati da altri gruppi. Controlli,
lacune ed errori strutturali vengono inviati dopo aver confermato i record validi
precedenti. Pausa/crash possono ripetere i gruppi oltre l’ultimo checkpoint contiguo, senza
saltare record o duplicare acquisizioni già committate.

Percorsi temporanei confinati a staging, hash e taglia verificati dal core.
Note e riferimenti ai media di un capitolo EPUB vengono estratti nello stesso
passaggio HTML con scanner C++17 a offset e fallback al parser Python per
sintassi ambigua, mantenendo frammenti e offset originali.
Il produttore legge il ZIP esterno in ordine, verifica CRC/SHA-256 e prepara
finestre limitate per un pool di processi (`INGEST_PARSER_WORKERS`, 2 predefiniti,
6 nel dev). I risultati vengono emessi nell’ordine sorgente. I membri fino a
8 MiB restano in memoria, quelli maggiori passano su disco; ogni parser scrive un segmento sequenziale per finestra, condiviso fra i suoi
record. Una directory resta protetta durante il parsing e fino all’ultimo ack
che ne usa i byte. Il core legge intervalli aggregati con massimo otto letture
asincrone e 32 MiB preparati per gruppo; segmenti maggiori mantengono il percorso
limitato per oggetto. Hash, normalizzazione e compressione dei contenuti sorgente
vengono preparati prima della transazione; manifest e metadati risultanti dal merge
si producono dopo aver letto e bloccato lo stato canonico. Gli
asset usano chunk da 8 MiB. Memoria e staging dipendono dalla finestra, dal pool,
dal documento più grande e dalla central directory, non dall’intero dataset.
SIGTERM termina tutto il gruppo di processi.

`archive_cache_data`, letta tramite il codec del catalogo, conserva il risultato sorgente indipendente dal locator,
indicizzato da SHA-256 del membro e versione parser. Il produttore interroga la
cache a finestre con `palimora.ingest.cache.v1`: nel worker le risposte usano
un pipe separato (FD 3, `PALIMORA_CACHE_FD`), senza scaricare o attendere gli ack
precedenti. Il produttore serializza ogni envelope una sola volta. Un hit riusa esclusivamente
oggetti già committati nel catalogo. CRC e SHA-256 del membro vengono comunque
verificati. Nuovo locator/provenienza produce la propria acquisizione; un cambio
parser invalida la cache, senza cancellare versioni precedenti.

Il core carica identità, selezioni e revisioni per l’intero gruppo ed esegue il
merge in ordine in memoria. I payload dei metadati vengono internati per gruppo
prima del trasferimento e condivisi globalmente nel catalogo (03).
Un solo COPY binario trasferisce colonne tipizzate riusate tra i tipi di riga,
con preparazione N-API asincrona. UUID, hash `bytea` e interi usano la codifica binaria PG;
i timestamp mantengono i microsecondi. JSONB sul protocollo COPY resta JSON
UTF-8 preceduto dal byte versione 1: PostgreSQL deve ancora interpretarlo.
Le proiezioni SQL ricostruiscono le righe logiche; insert/update finali vengono
inviati in un unico scambio ordinato, dentro la stessa transazione. TOAST usa
LZ4 per i valori non già compressi. Lo staging indicizza i payload locali e
aggiorna le statistiche delle chiavi a ogni gruppo; i lookup di provenienza
usano gli indici completi, evitando scansioni ripetute della sorgente.
La tabella TEMP è svuotata al commit e non costituisce un checkpoint.
I locator sono registrati in ordine di hash dopo il seal, con unicità globale.
Il target fisico dei pack è 64 MiB (03), ma ogni commit sigilla il proprio
residuo. Un piccolo artefatto sorgente isolato può quindi produrre un pack
piccolo valido; la compattazione lo consolida senza rielaborare il dump.
Le transazioni trattengono un lock condiviso contro GC/compattazione. Un lease
separato stabilizza le identità durante la pipeline; la riconciliazione acquisisce
prima quel lock esclusivo, poi quello archivistico. La pausa usa soltanto il lock
archivistico, così può inserirsi fra i commit senza attendere la fine del ZIP. Deadlock/serialization
failure causano rollback e fino a tre retry dell’intero gruppo, senza ack.
Il pool I/O/codec usa `UV_THREADPOOL_SIZE` (8 tramite Compose). Più
acquisizioni della stessa opera nello stesso gruppo restano ordinate: A→B→A
preserva tre snapshot e riusa le revisioni identiche. La tabella temporanea
non è un checkpoint; solo il commit del catalogo lo è.

| Input riconosciuto | Trattamento |
|---|---|
| `ao3_metadata` nei primi due SQLite | Cursore rowid, varianti di URL, metadati/provenienza |
| `metadata_full_old`, `stories` nel vecchio SQLite | Metadati e identità conosciute anche senza testo |
| `ao3_tags` | Evidenze immutabili di canonicalità/alias, senza inventare relazioni mancanti |
| EPUB FanFicFare / spine con capitoli `chapter*.xhtml` | OPF/spine, ordine, identità capitoli, note, CSS, asset; confronto con numero capitoli dichiarato |
| TXT FanFicFare, anche senza estensione | Intestazione verificata nei byte; documento intero conservato senza inventare confini capitolo |
| HTML FanFicFare/AO3 | Capitoli `story`/`chapters`, note, CSS e layout reversibile; confronto numero capitoli |
| CSV bibliografici FanFicFare | Metadati per riga, quoting/newline, checkpoint interno; file originale preservato a chunk |
| Log/manifest tecnici, TSV/JSON e contenitore 7z vuoto verificato | Artefatti sorgenti distinti dalle opere, segmentati quando grandi |
| Struttura sconosciuta | `parser_blocked` con locator/traceback; nessun avanzamento oltre l'elemento |

SQLite è aperto `mode=ro` e `query_only`. Un indice derivato in
`storage/cache/metadata` conserva rowid, evidenze, ID AO3 e prefissi dei percorsi.
Si costruisce leggendo il sorgente una sola volta per path/taglia/mtime/schema,
con commit e checkpoint ogni 4.096 righe, ed emette i metadati durante la
costruzione. Dopo un’interruzione riproduce il prefisso già indicizzato e
continua dal checkpoint dell’indice. Scope e riconciliazioni successive usano
indici locali; un indice derivato corrotto viene eliminato e ricostruito al
retry, mentre SQLITE_FULL della cache causa ENOSPC globale. Nessun indice
viene aggiunto ai dump originali. Il dettaglio
sorgente espone `index_progress` durante la preparazione. Anche i tag vengono
persistiti e confermati a gruppi. Checkpoint delle fasi metadata/tag/stories
usano intervalli disgiunti (base 2^40), senza confonderli con un conteggio di opere.
I CSV conservano anche `checkpoint_detail.row`: resume sul membro e sulla riga
confermata, senza duplicare i record già acquisiti. Il totale resta ignoto per ZIP
con CSV, evitando ETA ricavate dal conteggio dei membri. Le sorgenti selezionate
ma assenti, `.part`, CRC errati e membri EPUB mancanti sono lacune. Capitoli EPUB
indipendentemente leggibili vengono preservati; un EPUB con parti mancanti resta
`partial` e genera `partial_content`, anche se manca tutto il testo. I/O temporaneo: retry durevole con backoff fino a cinque tentativi, poi
quarantena della sorgente e prosecuzione. ENOSPC sospende globalmente; resume dopo
aver liberato spazio. Fonti modificate ripartono da zero mantenendo la storia. Un cambio parser durante
il resume mantiene il checkpoint dei byte invariati; una nuova scansione con
versione parser diversa rielabora la sorgente.

La scansione incrementale considera path, taglia, mtime, versione parser e scope;
la rielaborazione esplicita rilegge le sorgenti. Il result hash evita acquisizioni
duplicate. Scope SQLite diversi non possono far risultare completata una scansione
più ampia non eseguita. Gli snapshot validi non vengono rimpiazzati da copie parziali;
una rivalidazione del medesimo contenuto sorgente corregge il current preservando
la vecchia acquisizione.

Normalizzazione NFC/newline dei metadati, HTML originale immutato. Campi mancanti
vengono completati; evidenza del documento prevale sull'indice, decisione admin
tracciata prevale sulle selezioni automatiche. Conflitti alla stessa affidabilità e
ordine temporale incerto restano consultabili. `Genre` aggregato dagli esportatori
rimane `source_genre`, non viene falsamente attribuito a una singola classe tag.
`Path` è provenienza, non metadato bibliografico. In assenza di ID AO3, la chiave
provvisoria include sorgente e locator: omonimi in ZIP/indici diversi restano
separati fino a riconciliazione esplicita. Nessun merge per titolo/autore.

## Gestione amministrativa

`/admin/ingest`: batch dal più recente, ricerca per ID/sorgente e filtri attività,
interventi e conclusi. Il nuovo import sceglie esplicitamente file o intero dump;
l’inventario offre ricerca, formato, ordinamento per dimensione e selezione dei
risultati visibili. Il worker aggiorna l’inventario ogni 30 secondi. Modalità
incrementale e rielaborazione restano distinte, con riepilogo prima dell’avvio.

Il dettaglio separa sorgenti, report/anomalie e configurazione. Espandendo una
sorgente si vedono checkpoint, riga CSV, duplicati, tentativi, prossimo retry e
fingerprint. Filtri per anomalie/acquisite, pausa/ripresa e rielaborazione delle
sorgenti problematiche; quest’ultima conserva l’eventuale scope SQLite originale.
Avanzamento per sorgenti, throughput medio e stima residua solo quando il totale
è noto. Report JSON completo con sorgenti, fingerprint, checkpoint, riepiloghi e
anomalie paginabili, filtrabili per sorgente nella vista. La riconciliazione SQLite
seleziona gli URL AO3 effettivamente acquisiti dal batch, anche quando i percorsi
negli indici differiscono. Non richiede modifiche ai DB sorgente.

`/admin/archive`: ricerca tecnica per ID/titolo e filtri versione corrente assente
oppure conflitti aperti. L’ispettore apre la versione corrente, presenta le altre
per data di acquisizione (non cronologia AO3), componenti filtrabili, anteprime
testuali sicure e download completi. Metadati riconciliati distinti dai metadati
immutabili dello snapshot. Scelta del current direttamente dalla versione valida;
selezione di evidenze, correzione ID AO3 e ricerca dell’identità da collegare con
motivo obbligatorio in dialogo. Collegamenti conservativi, senza cicli né
accorpamento di due ID AO3 distinti; nessuna riscrittura delle revisioni storiche.

`/admin/archive/storage`: capacità del filesystem, riserva minima, oggetti unici,
pack referenziati e composizione per tipo. I byte dei record includono gli header;
non rappresentano lo spazio fisico di pack orfani o staging. Compattazione e
recupero spazio mostrano conferma, stato durevole, oggetti riscritti, pack rimossi,
byte dei pack rimossi e diagnostica (valore lordo, prima dello spazio occupato
dai nuovi pack); la UI evita di accodare manutenzioni mentre una è
attiva. Aggiornamento automatico e manuale, con ultimo aggiornamento visibile.

Nel solo ambiente dev, l’Owner dispone anche di **Reset archivio dev** con conferma
testuale `RESET`, senza backup. La richiesta sospende i batch attivi e accoda un
job `reset_dev`; durante il reset non sono ammesse altre mutazioni archivistiche.
Il worker attende la fine del gruppo corrente e delle consegne eventi, svuota
il catalogo in transazione, elimina le due code BullMQ e pulisce pack/staging.
Una fase persistente permette di riprendere dopo crash; in caso di errore il job
resta visibile e il medesimo pulsante ritenta, mantenendo bloccate le importazioni
fino al completamento. Occorre terminare eventuali compattazioni/GC già accodati.
Rimane soltanto l’esito del reset nelle attività di manutenzione; l’inventario
sorgenti resta consultabile per avviare subito una nuova importazione. Dati
utente e audit non vengono modificati dal reset; i dump non vengono mai scritti.
Il reset rifiuta di procedere se esistono dati personali o altre righe esterne
che referenziano il corpus (`RESET_REFERENCED_DATA`). Le tabelle dipendenti vuote
sono bloccate e incluse esplicitamente nella transazione, senza `CASCADE`; gli
esiti di scrub legati al corpus dev vengono eliminati con i relativi job.

Owner/Admin soltanto, autorizzazione e CSRF Foundation. Il runtime API non monta
i dump. Per ripetere il campionamento read-only usare
`python3 scripts/verify-archive-corpus.py ROOT --zip FILE.zip`; i risultati della
verifica completa di milestone sono in 09.

Riferimento semantico upstream: [template capitolo](https://github.com/otwcode/otwarchive/blob/master/app/views/downloads/_download_chapter.html.erb),
[prefazione](https://github.com/otwcode/otwarchive/blob/master/app/views/downloads/_download_preface.html.erb)
e [generatore download](https://github.com/otwcode/otwarchive/blob/master/app/models/download_writer.rb).
Adapter scritti per i byte osservati nel dump; nessun codice Rails/GPL incorporato.

## Coordinamento multi-sorgente P3

`INGEST_SOURCE_CONCURRENCY` accetta interi 1–4, default **1**. Il worker conserva
il leader PostgreSQL per tutto il tick, fino al drenaggio di tutte le corsie.
Le corsie effettive sono `min(sorgenti configurate, parser, commit)`; il budget
parser viene ripartito fra esse, non moltiplicato. I gruppi usano invece
`INGEST_COMMIT_CONCURRENCY` permessi globali FIFO: una sorgente può utilizzare
uno slot libero di un'altra, senza superare il budget complessivo. Anche record
singoli, tag, artefatti ausiliari e relativi checkpoint usano questi permessi.
Il permesso resta occupato fino all'ACK ordinato della propria sorgente, anche se il commit
finisce prima di un gruppo precedente. Con meno ZIP delle corsie configurate,
il gruppo di sorgenti usa comunque tutti i parser disponibili. Ogni corsia
libera prende il prossimo ZIP. Una sorgente non-ZIP
costituisce una barriera: attende i ZIP precedenti e usa il budget intero, evitando
concorrenza sul percorso SQLite/cache metadata. L'ordine di ammissione non è
un ordine cronologico delle revisioni.

Ogni ZIP ha adapter, pipeline FIFO, lease identità su connessione dedicata,
contatori, errori e staging `staging/source-<id>/run-<casuale>` propri. Prima
del resume si rimuovono i temporanei precedenti, che non sono necessari a nessun
commit durevole; il nuovo adapter ha un namespace distinto dai processi orfani.
I pack non sigillati rimasti nello staging sono rimossi prima di ripartire sotto
il lock esclusivo locator già esistente, dopo aver escluso gli altri writer.
I pack già sigillati senza riferimenti restano soggetti alla GC esistente.
Al termine si attende l'uscita dell'adapter prima di eliminare lo staging della sorgente. Un retry I/O
aggiorna soltanto la sorgente; parser strutturale e guasti globali sospendono il
batch. Ricevute, checkpoint contigui, lock per identità, transazioni e PackStore
restano quelli esistenti. Le corsie non condividono connessioni transazionali.

Massimo quattro commit e quattro connessioni lease, più il leader, nel pool
esistente da 12. La somma dei parser figli non supera il budget configurato;
si aggiungono un adapter padre e il resource tracker multiprocessing per corsia
(totale Python ≤ parser + 2 × corsie). Gruppi core in-flight ≤ budget
commit; prefetch adapter totale ≤ commit + corsie, più una finestra di parsing
per corsia. Rimangono soglia gruppo 16 MiB e gestione integrale dei singoli
record grandi: non è un limite assoluto di RAM per opere arbitrariamente grandi.
### Pressione e capacità

`INGEST_PRESSURE_MODE=conservative` rimane il default. Conserva il limite di
65.536 elementi per ciascuna delle tre code. La verifica condivisa visita al
massimo 65.536 tuple visibili per relazione (`EXISTS/OFFSET`), senza contare tutto
un backlog più grande; tuple morte restano un costo da gestire con autovacuum.
I gruppi già ammessi possono terminare. Non serve alcuna migrazione per tornare
alla modalità conservativa.

`INGEST_PRESSURE_MODE=throughput-first` disaccoppia il canonico dalle cardinalità
delle code. PostgreSQL rimane l'unica autorità per catalogo corrente, storico e
invalidazioni full-text; una sorgente `ingested` o un batch `completed` indicano
solo il completamento canonico. Le code vuote, le generazioni pubblicate e la
visibilità effettiva attestano separatamente catalogazione e ricercabilità.

Configurazioni, in GiB binari (0,25–1024):

| Variabile | Default | Significato |
|---|---:|---|
| `INGEST_DISK_RESERVE_GIB` | 8 | Riserva per filesystem persistente; si conserva anche il maggiore `ARCHIVE_RESERVE_BYTES` nei writer |
| `INGEST_BACKLOG_GIB` | 8 | Somma fisica delle tre code, TOAST e indici compresi, incluse pagine non ancora recuperate |
| `INGEST_STAGING_GIB` | 4 | Budget globale delle prenotazioni adapter e soglia di arresto sullo staging osservato |

Controlli condivisi al massimo ogni secondo; misure SQL ogni cinque secondi:
`pg_total_relation_size` delle code, `pg_database_size` e `pg_stat_wal.wal_bytes`.
Non richiedono superuser. Il percorso throughput-first non esegue `COUNT(*)`.
La crescita del DB e il WAL sono osservabili; la capacità reale comprende anche
WAL trattenuto, file temporanei SQL, translog e altri writer tramite `statfs`.
Non si assume che il WAL generato sia ancora tutto presente su disco.

Si controllano separatamente archivio, staging, temporanei e i percorsi dichiarati
in `INGEST_CAPACITY_PATHS`, JSON con chiavi obbligatorie `postgres`, `wal`,
`search`. Compose monta i dati PostgreSQL e OpenSearch **read-only** sotto
`/capacity/`; nella topologia fornita il WAL risiede nel mount PostgreSQL.
Con WAL esterno o altri mount, aggiungere i bind corrispondenti e impostare i
percorsi reali, senza usare una directory qualsiasi sul filesystem del worker.
Ogni tablespace PostgreSQL aggiuntivo richiede la chiave `tablespace:<nome>`;
un tablespace non dichiarato impedisce l'ammissione. Tutti i percorsi aggiuntivi
nel JSON vengono controllati. I temporanei del parser stanno nello staging;
`/tmp` ha una riserva pari al minore fra la riserva configurata e il 10% del
filesystem, per supportare anche tmpfs piccoli.

Per ogni filesystem il margine è il maggiore fra riserva configurata e dieci
secondi del consumo osservato fra campioni. Avviso sotto tre margini,
rallentamento sotto due, sospensione dell'ammissione a un margine. Si riprende
solo con almeno 2,5 margini. Per i byte delle code: avviso al 70%, rallentamento
all'85%, attesa al 100%, ripresa all'80%. Il rallentamento aggiunge 250 ms per
evento adapter; l'attesa ricontrolla ogni 250 ms senza creare altri gruppi core.
Metriche mancanti, errori di lettura o campioni più vecchi di cinque secondi
sospendono l'ammissione. Stop e pausa amministrativa restano osservati. La
mancanza di HTTP OpenSearch non è una metrica di capacità: con il suo mount
accessibile e capiente il canonico continua, lasciando i lavori durevoli pendenti.

Le prenotazioni staging sono ripartite fra le corsie, con ledger temporaneo
`.quota` protetto da `flock` fra padre e parser. Ogni scrittura o copia temporanea
prenota i byte prima di iniziare, anche per spool non visibili nell'inventario dei
file. Crediti fino a 8 MiB ammortizzano il costo; il cleanup dopo ACK restituisce
la prenotazione della directory. Si contano prudentemente anche buffer di input
che rimangono in memoria. Il ledger non è un checkpoint, non è fsyncato e non
contiene contenuti canonici: dopo crash viene ricreato; un ledger illeggibile non
autorizza nuove scritture. Il budget può rifiutare un singolo membro molto grande:
nessun troncamento o salto, occorre aumentare esplicitamente la capacità e riprendere.

Al superamento delle prenotazioni, della soglia staging osservata o a `ENOSPC`,
il batch passa a `paused` con causa esplicita; i gruppi già ammessi terminano o
fanno rollback, gli adapter si arrestano e lo staging viene liberato. Riprendere
con il normale controllo ingest dopo aver corretto la capacità. Le attese per
spazio/backlog invece riprendono automaticamente con isteresi e lasciano il batch
`running`. I log `ingest_pressure` espongono stato, causa e campione alle transizioni e ogni 30 secondi;
`ingest_pressure_summary` riporta controlli e attese (somme delle attese delle
corsie, non wall-clock). Se il limite code è occupato da pagine morte, drenare
non basta necessariamente: controllare vacuum/indici e capacità prima del resume.

Restano i limiti di parser, pool, gruppi e commit, i controlli di spazio prima
delle scritture PackStore, SHA-256, compressione, fsync e ACK dopo commit. Lo
staging PackStore dei gruppi già ammessi può aggiungersi alle prenotazioni adapter:
la soglia osservata arresta la produzione, non interrompe una transazione già
in corso. Dimensionare quindi la riserva con margine per questi gruppi e per gli
altri processi; la verifica P5 con quote e i suoi limiti sono documentati in [12](12-first-ingest-readiness.md).

### Percorso canonico P4

I lookup dipendenti dallo stato precedente (alias, selezioni, capitoli, revisioni,
snapshot, acquisizioni e riconciliazioni) non interrogano PostgreSQL quando il
lookup delle identità sotto lock non restituisce opere. Per gruppi misti e replay
rimangono le query complete. Creazione della tabella COPY temporanea e del suo
indice preesistente condividono uno scambio SQL; nessun nuovo indice persistente.

La precompressione riusa un frame per hash verificato nel solo gruppo di staging:
i buffer restano immutabili e ogni lettura dello staging verifica comunque il
proprio hash. Non è una cache fra transazioni. Il writer prepara al massimo 256
oggetti / 16 MiB non compressi per finestra, con eccezione per il singolo oggetto
più grande, ed esegue scritture vettoriali di lunghezze, header e payload senza
concatenare due volte i contenuti. Le scritture parziali avanzano correttamente
anche dentro un buffer. Il seal mantiene fsync, rilettura indipendente da disco,
checksum dei frame, decompressione, SHA-256 dei contenuti e fsync delle directory.

Gli artefatti ausiliari ZIP conservano oggetti, outbox e checkpoint nella stessa
transazione usando il lock archivistico condiviso contro GC/compattazione:
non modificano identità/versioni e non richiedono il lock esclusivo dell'intero
archivio. Pause, ammissione disk-aware e slot globali restano attivi.
Misure comparative e decisione di promozione sono in 11 e nel JSON P4.

Le letture di stato per envelope, cache parser e identità riusano la connessione
autocommit già assegnata al lease della sorgente. La lettura sequenziale degli
envelope ne garantisce l'ordine; non si apre una transazione sulla connessione
del lease. I commit usano ancora client indipendenti e il controllo periodico
di cancellazione resta separato. Questo evita di chiedere un secondo client
al pool da 12 per letture che la connessione della corsia può già eseguire.

### ZIP grandi e gate prima dell'importazione massiva

P5 introduce admission sulla central directory prima di aprire i contenuti.
Il probe CPython legge gli end record ZIP/ZIP64: oltre 100.000 membri o 16 MiB
di directory, la sorgente è una barriera esclusiva nello scheduler, come SQLite.
Conserva tutti i parser/commit del profilo, ma nessun altro ZIP rimane aperto.
Oltre 3 milioni di membri, 512 MiB di directory o con quota cgroup inferiore a
6 GiB per un ZIP grande, il batch si sospende per capacità. Non è una lacuna
`corrupt_source` e non viene avanzato il checkpoint per saltare membri.

L'allocazione di `ZipFile` è protetta temporaneamente da `RLIMIT_AS`: 384 MiB
per directory piccole, 3 GiB per grandi; il limite precedente viene ripristinato.
MemoryError/errno 12 diventa `INGEST_CAPACITY`. Il parser standard continua a
verificare ZIP64, nomi, duplicati, offset e CRC. Directory sconosciute o corrotte
sono ammesse esclusivamente al parser standard per la normale classificazione.
Il resume riparte dai checkpoint durabili, senza cambiare formato canonico.

La [valutazione P5](12-first-ingest-readiness.md) è tecnicamente conclusa, ma
l'ingest reale resta **NO-GO** sul layout attuale. Profilo verificato: quattro
sorgenti piccole concorrenti, sei parser, quattro commit, worker 4 CPU/6 GiB,
throughput-first, Zstd 3, backlog 8 GiB, staging 4 GiB, riserva 8 GiB per device.
I default conservativi restano invariati: nessun override di produzione viene
applicato automaticamente. Eseguire il preflight per componenti e completare i
gate capacità/layout/backup e i controlli operatore prima di selezionare il dump.
