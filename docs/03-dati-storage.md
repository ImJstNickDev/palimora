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

## Formato canonico v1

Il formato proprietario di Palimora è **documentato e leggibile autonomamente**; non è un lock-in verso PostgreSQL né un contenitore EPUB mascherato. Due livelli:

1. **Formato logico** (`palimora-canonical-v1`): documento/opera con ID, capitoli, ordine, metadati tipizzati, note, media, stili, provenance e link alle revisioni. Testo rappresentato tramite HTML UTF-8 preservato (non un nuovo markup), con rappresentazione di rendering sicura separata/derivata. Conservare sorgente HTML e semantica fino a quanto effettivamente presente nell'acquisizione.
2. **Formato fisico** (`palimora-pack-v1`, estensione `.pmpack`): contenitore append-only di record indipendenti, ognuno con `kind`, hash SHA-256 dei **byte canonici non compressi**, codec, offset, lunghezza compressa/originale, checksum, versione schema; indice ricostruibile dai record/metadata del pack. Ogni oggetto può essere letto e decompresso **senza** decomprimere altri record.

Il layout binario e i manifest v1 sono definiti sotto. I lettori rifiutano versioni
sconosciute e record troncati; le estensioni JSON opzionali non cambiano i byte degli
oggetti esistenti. Le migrazioni aggiungono tabelle/colonne senza riscrivere snapshot.

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

## Contratto binario `palimora-pack-v1`

`apps/api/src/pack.ts` implementa scrittura, lettura verificata e ricostruzione
indici senza PostgreSQL. Header file: otto byte ASCII `PMPACK01`. Seguono record
indipendenti fino a EOF: lunghezza header JSON uint32 little-endian, header UTF-8,
payload. L'header contiene `schema:1`, `kind`, `hash` (SHA-256 originale), `size`,
`length` (payload), `codec` (`zstd` o `raw`), `checksum` (SHA-256 payload). Nessun
padding/footer; EOF interno a un record è corruzione. Locator: offset del uint32 e
lunghezza dell'intero record. Header limitato a 65.536 byte dal reader.

JSON canonico: albero JSON con numeri finiti, chiavi ordinate ricorsivamente,
array nell'ordine originale, serializzazione JSON ECMAScript, UTF-8 senza BOM.
Le chiavi indice valide seguono l’ordine numerico ECMAScript; le altre l’ordine
lessicografico UTF-16. Il compilatore N-API preserva le rappresentazioni scalari
di `JSON.stringify`, senza conversioni dei numeri o normalizzazioni Unicode.
Compila insieme metadati e manifest sullo stato riconciliato; result hash e
osservazioni sono preparati in batch asincroni. Il limite è 256 livelli per i
documenti interni; numeri non finiti sono rifiutati prima della serializzazione.
I byte e gli schemi canonici v1 restano invariati.
SHA-256 riguarda sempre questi byte prima della compressione. Zstandard livello 3
per testi e JSON; asset binari `raw`. Gli asset XML riconoscibili (inclusa la
navigazione NCX già importata) sono comprimibili senza cambiarne tipo o byte.
Si usa `raw` quando Zstd non riduce la taglia. Il livello è una scelta misurabile, non una
promessa di ottimalità per ogni corpus.

Manifest `palimora-canonical-v1`: `work_id`, `external_id`, metadati,
`metadata_hash`, capitoli ordinati, riferimenti `{name,kind,hash}` e stato.
Ogni capitolo contiene identità/revisione, hash HTML e locator AO3 quando noto.
Revisioni capitolo e metadati sono immutabili e condivise; un ritorno A→B→A
riutilizza il blob A conservando il nuovo snapshot/osservazione.

Le note HTML riconoscibili sono oggetti indipendenti: il capitolo conserva note,
offset nei byte HTML originali e `source_html_sha256`. Reinserendo i frammenti alle
posizioni originali si ricostruisce l'HTML sorgente. Il testo restante non viene
riscritto da un serializer HTML. CSS, OPF e container metadata sono oggetti propri.
Gli HTML riconosciuti separano i blocchi capitolo, le note e il CSS dal documento.
`document` nel manifest descrive `palimora-html-layout-v1`: `shell` è il nome
nell’elenco oggetti della struttura HTML residua, `source_html_sha256` verifica il
file intero, `fragments:[{name,kind,offset,length}]` conserva posizioni e lunghezze
in byte originali. Ricostruire prima i capitoli reinserendo le note, poi inserire i
frammenti ordinati nella shell: si ottengono esattamente i byte sorgente. Modificare
un metadato HTML non duplica il testo dei capitoli.
I TXT senza delimitatori affidabili producono un documento `scope: entire_work`,
con numero capitoli dichiarato dalla fonte separato dall’unità fisica conservata.

Asset oltre 8 MiB: chunk indipendenti più manifest `palimora-chunks-v1` con `size`,
`sha256` dell'intero file e `chunks:[{hash,size}]` ordinati. La soglia segmenta,
non limita la dimensione del file. Download admin ricompone in streaming e verifica
hash e lunghezze; il browser non accumula l'intero media in una Blob JavaScript.
Gli URL esterni osservati restano risorse `unfetched`; il downloader AO3/media
appartiene alle milestone successive, senza richieste esterne durante l'ingest.

Oggetti `palimora-observation-v1` preservano snapshot/manifest, sorgente,
fingerprint, locator, parser e metadati originali. Lettura ed ispezione tecnica non
accedono ai dump. HTML/CSS sono restituiti come testo escapato o attachment, senza
esecuzione né fetch dal browser nell'admin.

Seal: staging sullo stesso filesystem, scrittura completa, verifica SHA-256 di
ogni record, fsync file, rename e fsync delle directory; poi commit di locator,
componenti, snapshot, head, outbox e checkpoint. Il writer condivide il pack tra
le preservazioni della stessa transazione. Ruota prima di superare il target di
**64 MiB fisici**, inclusi header (`ARCHIVE_PACK_MIB`: 32, 64 o 128); un singolo
record oltre il target resta ammesso. Il commit sigilla anche il residuo più
piccolo: il target non è una dimensione minima e writer di transazioni distinte
non condividono pack incompleti. Nessun file è aperto per un append vuoto.
La verifica rilegge finestre limitate a 256 record/16 MiB originali, con eccezione
per un singolo oggetto più grande; la RAM non cresce con il target del pack. Scritture e codec
scrivono a gruppi di 64 frame indipendenti; verifica e preparazione elaborano
fino a 256 frame con quattro task paralleli. I task di compressione
riutilizzano contesti Zstandard distinti. N-API mantiene vivi i buffer durante
il lavoro asincrono. Livello configurabile `ARCHIVE_ZSTD_LEVEL` (default 3,
1 nel dev). Checksum dei frame e SHA-256 dei contenuti sono ricontrollati sui
byte riletti dopo fsync. Gli hash già calcolati sui buffer immutati vengono
riutilizzati solo durante la preparazione, non nella verifica finale.

L’ingest accumula al massimo 16 MiB di oggetti canonici prima di deduplicare e
scrivere i pack; un singolo oggetto più grande resta ammesso. I locator sono
registrati in un unico inserimento ordinato per hash dopo il seal di tutti i pack,
prima del checkpoint. Scrittori concorrenti usano l’unicità del catalogo; una
corsa sugli stessi byte può lasciare record fisici non referenziati, recuperabili
con compattazione/GC, senza duplicare oggetti logici. La
migrazione `015` rende differibili al commit i tre vincoli dai componenti agli
oggetti: il buffer deve essere scaricato e ogni pack sigillato prima del commit,
che continua a rifiutare qualsiasi riferimento mancante. Nessun locator non
sigillato è visibile ad altre transazioni. Un errore annulla l’intero gruppo e il
checkpoint; può lasciare pack sigillati orfani, mai una head incompleta.

Il catalogo fisico `020` conserva SHA-256 completi in `bytea` (32 byte),
con riferimenti numerici condivisi a pack, tipo, parser, percorso, entry e
origine/fingerprint. `archive_record_data` registra una sola acquisizione;
`ingest_result_data` associa il batch alla sua identità, senza ripeterne i campi.
Gli ID pubblici delle opere, degli snapshot e delle evidenze restano stabili.

`archive_payloads` condivide i metadati fra head, osservazioni, acquisizioni e
cache. Il suo hash riguarda il JSON canonico del valore, distinto dai documenti
con schema nei pack. Payload e corpi della cache usano Zstandard livello 3 o raw
quando più piccolo, con taglia originale, codec e dizionario espliciti.
`archive_dictionaries` conserva byte e SHA-256 verificato dei dizionari immutabili:
uno per metadati e uno per cache, addestrati durante l’ingest su al massimo
256 documenti/2 MiB, con massimo 64 KiB per dizionario. Prima della loro
pubblicazione è valido Zstd senza dizionario; il training non blocca gli altri
scrittori. Nessun dizionario dipende dal dump originale o viene distribuito nel
repository. La lettura verifica taglia e SHA-256 dopo decompressione. I byte già
compressi usano `STORAGE EXTERNAL`, evitando una seconda compressione TOAST.

`archive_work_heads` conserva il riferimento corrente e la proiezione testuale
esatta del titolo per la ricerca tecnica; il resto dei metadati è decompresso
soltanto per le righe restituite. Le evidenze conservano gli ID per campo in
array tipizzati; provenienze, affidabilità e motivazioni delle selezioni usano
dizionari condivisi. Anche i valori storici non più selezionati restano
immutabili. Le viste ricostruiscono hash esadecimali e provenienze; il livello
catalogo idrata metadati, evidenze e cache prima delle risposte API. I contratti
API restano invariati; le viste SQL interne non espongono JSON già decompresso.
I lock sulle opere riguardano le head, non i payload condivisi.

`020` richiede un archivio vuoto e interrompe la migrazione prima di modificare
un catalogo popolato. Non cancella dati per soddisfare il requisito e non tocca
utenti, sessioni o audit. Sostituisce il formato fisico di `019`, senza cambiare
byte canonici o pack v1. Il reset dev svuota atomicamente tutte le tabelle
archivistiche, inclusi cache e dizionari; elimina anche gli indici SQLite derivati
in `storage/cache`.

Compattazione copy-on-write: accumula locator fra pagine SQL fino al target
fisico o a 65.536 oggetti, senza chiudere il pack al termine di ogni pagina.
Lettura e riscrittura avvengono a finestre di 256 record/16 MiB originali;
handle e intervalli adiacenti sono riusati, senza una query per oggetto.
Pubblicazione dei locator in blocco e checkpoint del job condividono il commit;
un riavvio non ripete i gruppi già pubblicati. La copia/verifica mantiene un lock
condiviso contro GC, compatibile con le letture e l’ingest; il lock esclusivo
copre soltanto la pubblicazione dei locator. Un lock dedicato (70210407)
serializza i compattatori prima del lock archivistico, evitando upgrade
concorrenti. Una compattazione esplicita consolida
anche piccoli pack validi di commit precedenti, preservando tutti gli hash. Il recupero spazio elimina solo pack
senza oggetti indicizzati e senza lease attive, sotto lock esclusivo coordinato
con writer/reader, in gruppi di 64 file. Staging pack e directory adapter
abbandonati da oltre un’ora possono essere rimossi. Snapshot, revisioni e
osservazioni hanno trigger SQL che impediscono UPDATE/DELETE.

Le decisioni amministrative sono eventi immutabili con stato precedente/successivo.
Il consumatore outbox le preserva come `palimora-admin-decision-v1` e registra le
revisioni dei metadati selezionati prima di confermare la consegna. L’API mantiene
lo storage in sola lettura. Le anteprime testuali sono limitate a 64 KiB; il download
verificato rimane completo e in streaming per i media segmentati.

## Proiezione di consultazione

Le migrazioni `021–024` aggiungono documenti correnti, viste degli snapshot,
tassonomia, entità bibliografiche e appartenenze. Sono proiezioni ricostruibili:
pack, manifest, revisioni e head canoniche restano l'autorità. Code PostgreSQL
con lock `SKIP LOCKED` invalidano le proiezioni al cambio di head, identità o
tassonomia. Un advisory lock serializza gli upsert bibliografici condivisi fra
opere; l'indicizzazione testo mantiene la concorrenza per opera; ogni commit conserva il lavoro ancora pendente. La generazione del
documento impedisce di restituire corrispondenze OpenSearch diventate obsolete.
Il reset dev include le proiezioni e cambia l'epoch dell'indice.

Il campo opzionale `metadata.ao3`, validato da `SourceBibliography` nel package
contratti, usa `schema: "palimora-ao3-v1"`: tag con identità sorgente, canonicalità,
sinonimo e relazioni; autori/pseudonimi, serie e collezioni con profilo e posizioni;
relazioni fra opere; commenti con ID/parent/capitolo e stato di cancellazione;
kudos nominativi/guest, statistiche e data di osservazione; disponibilità e
riferimenti URL→oggetto locale. Questi dati viaggiano nei metadati canonici dello
snapshot, senza cambiare `pack-v1`. Campi assenti restano sconosciuti; timestamp
di acquisizione e osservazione non sono intercambiabili. Commenti ciclici o ID
duplicati vengono rifiutati. Non esistono scritture locali di kudos/commenti.

`catalog_tags` è l'unica tassonomia di consultazione. I sinonimi risolvono il
filtro canonico; i metatag ereditano i discendenti; i collegamenti parent restano
descrittivi. La chiusura alimenta insieme ricerca e conteggi di navigazione.
Categorie e relazioni sono accettate solo da evidenze classificate: il campo
aggregato Genre resta «Tag sorgente» finché una classificazione acquisita non
lo risolve univocamente. Crossover/OTP con più tag richiedono la tassonomia
acquisita oppure il valore sorgente esplicito.

Le identità bibliografiche usano ID o URL AO3 acquisiti; un semplice nome senza
identità rimane circoscritto all'opera, senza unire omonimi. I link dei frontespizi
già preservati possono ricostruire serie, collezioni e posizioni esplicite. Le
pagine storiche conservano metadati, attribuzioni, posizioni e interazioni della
versione scelta. La classificazione corrente dei tag è condivisa fra versioni.

### Acquisizioni AO3 e media

`025–026` estendono il catalogo senza riscrivere pack o revisioni precedenti.
Acquisizioni live e localizzazione media riusano `ingestRecords` e i suoi lock,
seal, dedup e pubblicazione atomica. I callback interni registrano completamento
sync e osservazione nella medesima transazione; acquisizioni fallite lasciano
immutata la head. La localizzazione verifica sotto lock la head da cui deriva:
una modifica concorrente impone di rileggere il current.

`ao3_observations` e `ao3_media_revisions` hanno protezione SQL contro mutazioni.
I binding URL→oggetto sono versionati nei manifest; chunk e asset condividono gli
hash globali esistenti. Credenziali/sessioni tecniche appartengono soltanto al DB
operativo cifrato, mai ai documenti canonici. Staging upload e checkpoint sono
ripristinabili col database, indipendenti dai dump. Policy e stati in 05.

### Biblioteca personale: bookmark e cronologia

La migrazione `028_personal_library.sql` introduce `library_bookmarks` e
`library_readings`, entrambe con chiave `(user_id, work_id)` e FK all'identità
archivistica esistente. Tag e note dei bookmark non modificano la tassonomia
sorgente. La cancellazione del bookmark conserva una tombstone con revisione
crescente: una scrittura da un dispositivo arretrato riceve `CONFLICT` e non
ripristina dati cancellati. Cronologia e Mark for Later condividono la riga di
lettura; rimuovere la cronologia non rimuove il contrassegno per dopo.

### Collezioni, progressi e ancore di lettura

Le migrazioni 029–030 aggiungono collezioni locali, membri invitati/accettati e
associazioni alle identità opera. Il proprietario è immutabile. Le mutazioni
passano da una verifica SQL nella transazione; i trigger controllano inoltre
l'attore locale `palimora.user`, impedendo modifiche di Viewer, gestione membri
senza Owner e trasferimenti della proprietà. Eliminare una collezione la nasconde,
non elimina opere o annotazioni originali. Le collezioni sorgente AO3 rimangono
bibliografia, non diventano contenitori locali modificabili.

Progressi e annotazioni usano `{snapshot, chapter, offset, quote, prefix, suffix}`:
offset UTF-16 nel testo del capitolo reso dal renderer sicuro, incluso il titolo;
contesti fino a 32 caratteri. Il server valida l'ancora sullo snapshot selezionato.
Il riallineamento considera solo la stessa identità capitolo e richiede una sola
corrispondenza esatta di citazione e contesti. Nessuna corrispondenza o più
corrispondenze producono `unresolved`. Per il progresso si offre l'inizio del
capitolo corrispondente se presente; le annotazioni non vengono collocate a caso.

Ogni salvataggio del progresso crea una revisione append-only; note, riferimenti,
condivisione e cancellazioni delle annotazioni sono anch'essi conservati in una
storia append-only. Le letture riallineate sono proiezioni, non riscritture delle
ancore. La percentuale è calcolata dal server sulla posizione testuale nell'opera;
`completed` è una scelta esplicita, pari al 100%. Bookmark, cronologia e Mark for
Later mantengono i modelli esistenti; salvare progresso aggiorna la cronologia
senza rimuovere il contrassegno per dopo.

### Statistiche, social e notifiche (031)

Le statistiche leggono i progressi esistenti: opere distinte con progressi,
primo completamento per opera, parole sorgente dello snapshot completato,
completamenti per giorno UTC e fandom per opere distinte. I conteggi parole
assenti restano sconosciuti, con conteggio separato delle opere interessate.
Le parole delle opere parzialmente lette non vengono estrapolate dal progresso.
Il tempo misura intervalli di presenza attiva nel lettore: heartbeat ogni 15 s,
scheda visibile, testo nel viewport e attività negli ultimi 60 s; perdita del
focus/visibilità interrompe la misura. Intervalli server tra 5 e 25 s,
unione PostgreSQL dei periodi sovrapposti tra
sessioni. Nessuna ricostruzione del tempo precedente all'installazione della 031.
UUID delle misure deduplicano i retry, compreso il primo heartbeat senza durata.

`personal_settings` separa visibilità di attività e statistiche (privata,
utenti selezionati, istanza), ricezione consigli, aggiornamenti, push e
raggruppamento. I consigli sono unici per mittente/destinatario/opera; le liste
condivise restano le collezioni con le loro ACL.

Sottoscrizioni locali a identità opera e autori/serie del catalogo. La 031 aggiunge
`producer_xid` solo ai nuovi eventi outbox e conserva lo snapshot transazionale
all'iscrizione: le pubblicazioni ancora in corso vengono consegnate dopo commit,
anche se il loro timestamp precede l'iscrizione. Ricevute per evento e vincolo
utente/opera/snapshot rendono il consumatore ripetibile. Le proiezioni bibliografiche
dello snapshot determinano i destinatari, incluse le protezioni dell'anonimato.
Il centro notifiche raggruppa per utente/opera/finestra, mantenendo separati i consigli.

### Copie offline e ricevute (5C)

IndexedDB `palimora-personal-v1` contiene una sola partizione attiva utente/sessione:
metadati e quattro documenti sanificati per snapshot (skin on/off, tema chiaro/scuro),
media locali come Blob, progresso, sole annotazioni proprie e coda delle mutazioni.
Il lettore seleziona capitoli e tipografia dagli stessi documenti, senza reinterpretare
HTML sorgente. I media non disponibili nell'archivio non vengono acquisiti dal client.

Download espliciti, risorse scaricate in sequenza con avanzamento e annullamento;
la copia viene pubblicata in un'unica transazione solo dopo il completamento.
Errore/quota/annullamento conservano la copia precedente. Le risorse di staging
abbandonate da un arresto sono eliminate dopo 24 ore al successivo accesso online.
Una nuova versione crea una copia distinta: quelle precedenti rimangono consultabili
e rimovibili. Le copie con operazioni pendenti non si eliminano prima della risoluzione.
Lo spazio riportato per copia misura documenti e media; la quota complessiva proviene
da StorageManager e include l'overhead del browser. Persistenza richiesta su comando,
mai assunta come garanzia contro cancellazioni manuali o rimozione dati del browser.

Migrazione 032: `library_mutation_receipts`, chiave utente/request UUID, operazione,
hash input e risultato, nella stessa transazione delle revisioni personali. Replay
identici restituiscono il risultato originale; UUID riutilizzati con payload diversi
sono rifiutati. La coda locale conserva una sequenza monotona, revisione e riferimenti originali;
non usa l'orologio del dispositivo per decidere il vincitore di un conflitto.
Il tempo di lettura offline non viene stimato; completamenti e cronologia diventano
visibili nelle statistiche quando il server conferma il salvataggio.

### Scrub e recupero verificato — 6B.2

Migrazione 036: `archive_jobs` ospita anche `scrub` e `repair`, con checkpoint,
progresso ed esiti persistenti; `integrity_packs` conserva l'inventario e
`integrity_issues` i problemi deduplicati per esecuzione/oggetto/codice. Lo stesso
leader della manutenzione esegue i job; nessuna coda parallela. La pianificazione
`integrity_schedule` è disabilitata per default, evita scrub sovrapposti e
ricontrolla l'autorità dell'operatore.

Lo scrub controlla struttura/header, offset e lunghezze, checksum dei frame,
SHA-256 dei byte decompressi, manifest e ricomposizione dei media segmentati,
metadati/dizionari del catalogo, FK del corpus e associazione delle head.
Legge gli oggetti grandi in streaming; ogni gruppo usa il lock dei locator
contro pubblicazioni/GC concorrenti. È una scansione progressiva con checkpoint,
non uno snapshot immutabile dell'intera biblioteca: nuovi commit possono essere
inclusi nella scansione o nella successiva. Pausa e arresto interrompono ai punti
sicuri; un riavvio riparte dal gruppo confermato. Le verifiche non eliminano dati.

Il recupero cerca lo stesso hash in un backup completo o in una catena di export
verificata, controllando mount e checksum. Produce un nuovo pack raw temporaneo,
verifica byte/dimensione/SHA-256, esegue fsync/seal e pubblica il locator con
confronto del precedente valore sotto lock. Versioni e file precedenti restano
intatti; il nuovo locator e l'esito sono nella stessa transazione. Un arresto
prima del commit può lasciare un pack sigillato orfano, gestito dal GC esistente.
Le copie sorgente sono protette dalla retention mentre il recupero è attivo o
in pausa. La verifica dei volumi riparte alla ripresa; pack di staging già
completi sono riutilizzati solo dopo verifica del checksum.

Oggetti assenti dalla copia sono registrati come non recuperabili da quella
copia. Incoerenze semantiche/relazionali e identità dimensione/tipo discordanti
richiedono analisi o restore su target isolato: non vengono ricostruite per
ipotesi. I record corrotti rimasti in pack non più referenziati sono segnalati
separatamente (`UNREFERENCED_CORRUPT`), senza proporre un altro recupero del
locator già sano. Compattazione/GC conservano le protezioni esistenti.

## Storage Overhaul pre-ingest

La migrazione `040` rimuove i soli indici derivati `catalog_metadata` (GIN) e
`catalog_title` (B-tree). Restano primaria, relazioni e dati correnti/storici.
I nuovi indici OpenSearch usano codec Zstd livello 3 ed escludono `text` dallo
`_source` stored: il campo resta indicizzato con analyzer e posizioni invariati.
Doc values, generazioni, fencing, facet e sort restano invariati. OpenSearch
2.19.4 conserva il documento completo anche in `_recovery_source` fino ai merge;
questo costo entra nel budget di scrittura. Il recovery non viene disabilitato.

Gli indici esistenti non vengono riscritti automaticamente. Per ricostruire,
usare il percorso applicativo da canonico: su indice assente `ensureSearchIndex`
invalida tutti i documenti nella coda durevole e il worker ricrea i documenti
completi da PostgreSQL/pack. Non usare `_reindex` o `_update` standard per
ricostruire il testo escluso dallo stored source. La ricostruzione richiede
indisponibilità temporanea della ricerca finché la coda non si drena; non cambia
l'autorità archivistica e non richiede i dump. Il test AO3 verifica cancellazione,
ricostruzione, generazioni e query sullo stesso canonico.

Pack v1, default Zstd 3, TXT, cache parser e bibliografie immutabili non cambiano.
Misure, candidati non adottati e limiti della campagna sono in
[storage-overhaul](storage-overhaul.md) e
[performance-storage-overhaul.json](performance-storage-overhaul.json).
