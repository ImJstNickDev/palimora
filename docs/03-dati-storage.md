# 03 — Dominio, versioni e formato canonico

## Autorità dei dati

**PostgreSQL = identità, relazioni, metadati, versioni e indice dei blob.** **PackStore = byte immutabili.** **OpenSearch = indice derivato, ricostruibile.** **ZIP/SQLite esterni = sorgenti importabili, non dipendenze operative.** Redis è solo il livello esecutivo delle code. Tutti i dati di lavoro durevoli hanno uno stato nel DB.

### Modello minimo (concettuale, nomi SQL affinabili)

| Area | Entità e invarianti |
|---|---|
| Provenienza | `Source`, `SourceFile`, `IngestBatch`, `SourceRecord`, `IngestCheckpoint`, `ParseIssue`: percorso, taglia, hash, reader/versione, locator originale, stato e cause |
| Identità | `Work` con ID locale stabile, `ExternalIdentity(source='ao3',work_id)`, `AuthorIdentity`, `Pseudonym`, `Series`, `CollectionSource` (AO3), `WorkRelation` |
| Testi | `ChapterIdentity` (ID AO3 se noto), `ChapterRevision` immutabile, `WorkSnapshot` immutabile e ordinamento dei capitoli; note e CSS associati a revisioni |
| Metadati | `MetadataRevision`, `Tag`, `TagAlias`, `TagRelation`, `WorkTag`, `SourceStatisticObservation`, `ExternalComment`, `SourceKudosObservation` |
| Asset | `MediaResource` URL originario, fetch storico/status, `MediaRevision`, blob contenuto; mappa URL→risorsa e riferimenti dai capitoli |
| Oggetti | `ContentObject(sha256, kind, size, codec)`, `PackFile`, `PackRecord(offset,length,checksum)`, `PackLease/Retention`, compaction manifest |
| Lettori | `LocalUser`, `AuthCredential`, `Session`, `Invite`, `Collection`, `CollectionACL`, `Bookmark`, `ReadingProgress`, `Annotation`, `Subscription`, `Notification`, `ActivityVisibility` |
| Lavori | `DurableJob`, `OutboxEvent`, `SyncCursor`, `SyncObservation`, `WatchEntry`, `RetryIssue`, `AdminAudit`, `BackupRun`, `ExportManifest` |

**Identificatori:** `Work.id` locale immutabile; `ExternalIdentity` con vincolo unico sulla coppia `(source, external_id)`; quando l'ID AO3 è sconosciuto, identificatore locale provvisorio senza inventare ID AO3. Una successiva riconciliazione collega l'identità verificata, **senza** perdere bookmark, annotazioni, storia delle revisioni o provenienza. Opere ripubblicate con ID differente restano distinte e possono essere collegate come correlate, senza merge automatico.

**Autori:** profili bibliografici derivati da AO3; nessuna associazione automatica con `LocalUser`, nessuna credenziale creata per gli autori originali. Preservare attribution e pseudonimi storici quando acquisiti; la rappresentazione pubblica rispetta lo stato corrente noto della fonte, mentre la provenienza non viene falsificata.

**Tag:** rappresentare classi AO3 (fandom, character, relationship, freeform, rating/warnings), canonicalità, alias e gerarchie. Tag non wrangled restano ricercabili. Dati AO3 sono autorità; niente override locali di canonici in v1. Filtri utente e tag bookmark rimangono dati personali, non correzioni al tag graph sorgente.

## Versioning

- Versionare indipendentemente contenuto capitoli, note, HTML, Work Skins, struttura opera, metadati, legami serie e statistiche. **WorkSnapshot** è un manifest immutabile che punta alle revisioni componenti e all'ordine dei capitoli in un punto di osservazione. Nessuna modifica in-place delle vecchie revisioni.
- Blob con lo stesso hash condivisi globalmente tra opere e snapshot; un ritorno al testo originale produce un **nuovo evento/snapshot** che referenzia il vecchio blob.
- Una correzione di un tag non replica il testo dell'opera. Un capitolo modificato produce un nuovo `ChapterRevision`, gli altri continuano a puntare ai vecchi blob.
- I dati delle statistiche sono **osservazioni della fonte** con timestamp: non creare revisioni duplicate se invariati; registrare separatamente che il controllo è avvenuto.
- Se provenienze o date sono incerte, preservare gli snapshot e marcare l'ordinamento come incerto; non inferire cronologie da nomi ZIP, inode o numeri queue. Per conflitti ordinari scegliere il valore più affidabile con motivazione registrata; problemi di identità non risolvibili vanno in controllo admin.
- `Work.current_snapshot_id` punta solo a una versione **completa e verificata**. Download parziali o danneggiati non sostituiscono il current. L'ultima copia AO3 verificata prevale come corrente quando la fonte è disponibile e affidabile.
- Se AO3 cancella un capitolo, esso sparisce dal current ma rimane negli snapshot storici. Riconoscere spostamenti mediante `ChapterIdentity`; casi di split/merge incerti non devono falsificare la continuità.
- Le revisioni storiche e i media storici si conservano **indefinitamente**; niente retention distruttiva di revisioni valide.

## Formato canonico — contratto preimplementazione

Il formato proprietario di Palimora è **documentato e leggibile autonomamente**; non è un lock-in verso PostgreSQL né un contenitore EPUB mascherato. Due livelli:

1. **Formato logico** (`palimora-canonical-v1`): documento/opera con ID, capitoli, ordine, metadati tipizzati, note, media, stili, provenance e link alle revisioni. Testo rappresentato tramite HTML UTF-8 preservato (non un nuovo markup), con rappresentazione di rendering sicura separata/derivata. Conservare sorgente HTML e semantica fino a quanto effettivamente presente nell'acquisizione.
2. **Formato fisico** (`palimora-pack-v1`, estensione proposta `.pmpack`): contenitore append-only di record indipendenti, ognuno con `kind`, hash SHA-256 dei **byte canonici non compressi**, codec, offset, lunghezza compressa/originale, checksum, versione schema; indice ricostruibile dai record/metadata del pack. Ogni oggetto può essere letto e decompresso **senza** decomprimere altri record.

I dettagli binari finali (magic bytes, endianness, struttura header/footer, segmentazione oggetti molto grandi e schema esatto del manifest) sono un **deliverable obbligatorio all'inizio della milestone Archive Engine, prima del primo ingest permanente**. Definirli con prove di round-trip e compatibilità, non lasciarli impliciti nell'implementazione. Dopo la prima scrittura di produzione la versione v1 è stabile.

### Oggetti e codec

| Tipo | Gestione |
|---|---|
| Capitolo HTML / note / CSS | Oggetti autonomi compressi con Zstandard, livello calibrato sul corpus reale |
| Metadati e manifest | Serializzazione canonica deterministica versionata; metadati consultabili nel DB, export autonomo senza DB |
| Immagini/audio/video/PDF collegati | Byte originali, compressione disattivata se formato già efficiente; miniature solo cache ricostruibile |
| Media molto grandi | Segmentazione/chunk indipendenti con manifest di ricomposizione, senza limiti arbitrari di dimensione |

Dedup **esatta** globale: hash SHA-256 + dimensione/tipo coerenti, nessun accorpamento fuzzy. Non fare content-defined chunking automatico dei capitoli: per lettura e versioning l'unità primaria è il capitolo; media grandi possono avere chunk. Compressione e packing sono ottimizzazioni fisiche, mai alterazioni del contenuto canonico.

### Scritture, recupero e garbage collection

1. Produrre in `storage/staging` oggetti validati e pack temporanei con record e hash; `fsync` e `rename`/seal in modo crash-safe sul medesimo filesystem.
2. Registrare record pack e riferimenti nel DB, quindi pubblicare lo snapshot corrente **atomicamente nel DB**, con outbox per ricerca/notifiche. Il reader non risolve mai pack non sigillati o dati parziali.
3. Se una transazione fallisce, gli oggetti non referenziati possono restare come orfani recuperabili/compattabili, ma i vecchi snapshot restano intatti.
4. Compattazione copy-on-write, lock/lease sui pack attivi e aggiornamento atomico dei locator; cancellare pack vecchi solo quando non vi sono reader, backup o export che li referenziano.
5. Verifica SHA-256 a ingest, lettura secondo policy (anche con cache dei verificati) e scrub periodico. Corruzioni evidenziate e riparabili tramite backup ove disponibile.

**Dimensione dei pack e livelli Zstd:** non fissare arbitrariamente numeri «ottimi»; benchmark su campioni reali. Progettare pack regolarmente compattabili, orientativamente centinaia di MiB, senza imporre un pack enorme per una singola opera.

## Export e interoperabilità

I dati possono essere resi in EPUB/HTML/PDF **su richiesta**, generando temporanei cancellabili. Export archivistico v1 è distinto dai pack operativi: manifest autosufficiente con volumi max 2 GiB, hash, collegamenti e record versionati. Reader CLI standalone usa librerie del formato, non richiede DB/app. Vedi `08-backup-export.md`.
