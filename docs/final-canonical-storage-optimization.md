# Ottimizzazione finale del canonico

Baseline immutabile: `5c5774f84fdff9805c5e9e062312a4cef2fca6d6`.
Risultati riproducibili in [performance-final-canonical-storage.json](performance-final-canonical-storage.json).
Nessun ingest massivo, deployment, modifica dei dump, dei dati di produzione,
della configurazione operativa o del modello OpenSearch.

## Implementazione

- **TXT virtuali:** `ao3-dump-5` conserva soltanto `original.txt`. La ricetta
  `palimora-text-html-v1` congela gli offset UTF-8 calcolati da Python dopo la
  separazione dell'header e `strip()`. Conserva dimensione originale, dimensione
  HTML e SHA-256 derivato. `archive-format` verifica il sorgente e ricostruisce
  `<pre>` e gli escape esatti di `html.escape()`. Reader, indicizzazione,
  HTML/EPUB/PDF e CLI condividono la stessa ricostruzione. Nessuna cache è
  necessaria. Il budget dell'indicizzazione considera anche l'HTML espanso.
- **Metadata referenziati:** il compilatore nativo v2 salva i metadata completi
  una sola volta in `palimora-metadata-v1`. Il resolver comune carica le
  dipendenze in batch, verifica hash/schema e restituisce la vista logica.
  Non sostituisce mai metadata storici mancanti con quelli correnti.
- **Manifest compatti:** `object_ref` sostituisce nome/hash ripetuti del capitolo
  quando il confronto Zstd al livello configurato risparmia oltre 32 byte per
  manifest. Il resolver ripristina la vista precedente; mantiene ordine,
  identità/revisioni, note/offset, layout, CSS, media e checksum sorgente.
- **Metadata-only:** un documento `palimora-canonical-metadata-v1` soddisfa sia
  il riferimento metadata sia quello manifest. Le osservazioni restano
  individuali e complete. Nuove acquisizioni con lo stesso stato possono
  condividere il documento, senza fondere valori discordanti o sostituire la
  head completa. Il replay non aggiunge snapshot/oggetti.

Il contratto completo è in [03](03-dati-storage.md). La revisione SQL di un TXT
punta al sorgente fisico; il checksum derivato non viene inserito come oggetto
fittizio. La ricetta v1 è deterministica rispetto al sorgente; ricette sconosciute
sono rifiutate dal renderer. Nessun oggetto o snapshot precedente viene riscritto.
Restano leggibili manifest v1, HTML TXT persistenti e metadata-only a tre oggetti.
La migrazione `041` cambia solo il default del parser per nuove sorgenti.
PMPACK01, Zstd, SHA-256, checksum, fsync, seal e FK restano invariati.
Il backup piattaforma confronta la vista logica v2, così la scelta opzionale
`object_ref` non impedisce il riconoscimento di uno snapshot equivalente.
Le firme v1 restano identiche; un test cambia la codifica nella fixture di restore
e verifica il remapping dei riferimenti personali.

## Confronto fisico isolato

Stesso corpus P5: 1.207 opere, 1.210 snapshot/acquisizioni, incluse 160 TXT,
240 righe SQLite, EPUB estremi, HTML, note, media, asset segmentati e revisioni.
Il probe ricodifica i documenti con identità fissate, usando il vero writer,
rotazione e verifica del PackStore. Non è una migrazione del catalogo SQL.
Runtime Debian/Zstd **1.5.4**, livello 3, uguale alla baseline API; misure sul
filesystem dopo seal e rimozione ordinaria dello staging.

| Variante                        | Oggetti | Byte fisici |
| ------------------------------- | ------: | ----------: |
| A — baseline                    |  29.320 | 253.111.564 |
| B — solo TXT virtuali           |  29.160 | 250.907.575 |
| C — anche metadata referenziati |  29.160 | 249.811.916 |
| D — tutte le modifiche          |  28.920 | 249.682.272 |

Risparmio: **400 oggetti, 3.429.292 byte, 1,3549%** sul corpus eterogeneo.
I pack sorgente della fixture occupano 253.111.820 byte: la normalizzazione
riduce soltanto 32 header di file da 8 byte, senza duplicati di record. Quei
256 byte sono esclusi dal risparmio attribuito alle ottimizzazioni.

| Componente                            | Prima, byte fisici | Dopo, byte fisici |
| ------------------------------------- | -----------------: | ----------------: |
| Metadata                              |          1.347.463 |         1.367.444 |
| Manifest                              |          4.221.482 |         2.985.361 |
| Observation                           |          1.750.095 |         1.750.048 |
| TXT originali                         |          2.287.355 |         2.287.355 |
| HTML derivato dai TXT                 |          2.213.105 |                 0 |
| Categoria TXT, tutte le dipendenze    |          5.062.924 |         2.753.595 |
| Categoria SQLite, tutte le dipendenze |            656.023 |           457.921 |

La riga metadata finale comprende anche i 240 documenti unificati: il suo
piccolo incremento sostituisce manifest separati. Le osservazioni mantengono
lo stesso contenuto informativo e la stessa dimensione raw; la variazione di
47 byte deriva dalla compressione dei nuovi riferimenti hash.

I delta sequenziali separano gli interventi: TXT **2.203.989 byte**;
metadata referenziati **1.095.659**; consolidamento SQLite **79.924**;
riferimenti compatti degli altri manifest **49.720**, inclusi gli effetti sui
riferimenti delle osservazioni. Non sommare nuovamente i risparmi per categoria.
Il JSON contiene raw, payload, header, allocazione filesystem e dettagli per tipo.

### Alternative

Il manifest minimale con metadata separati rimane il formato delle opere con
contenuti. Sui metadata-only, il documento unificato con osservazione separata
occupa meno byte del modello a tre oggetti, anche dopo l'eliminazione dei
metadata incorporati: **537.845 → 457.921 byte** sulle 240 acquisizioni.

Separare anche i metadata originali delle osservazioni in payload condivisi
produrrebbe 480 oggetti al posto di 240 per questa componente e aumenterebbe
**253.111 → 333.720 byte**: variante scartata. Le informazioni specifiche della
sorgente restano nelle osservazioni. Un unico documento per acquisizione che
incorporasse anche la provenienza impedirebbe il riuso dello snapshot fra
osservazioni identiche e richiederebbe di cambiare il contratto di riferimento
osservazione→manifest: non è adottato. Non vengono eliminati eventi o provenienze.

Gli indici locali non sono imposti ai manifest che comprimono meglio nella
forma estesa. Non sono introdotti codec, dizionari o formati fisici nuovi.

## Ricostruzione e verifiche

I test confrontano il renderer con Python su BOM, CRLF/LF, Unicode, whitespace
non equivalenti a JavaScript `trim()`, accenti, emoji, virgolette/apostrofi,
ampersand, corpo vuoto, assenza di separatori affidabili e testo lungo.
I 160 TXT P5 e altri **384 TXT** da tre archivi sono byte-identici all'HTML
precedente. Il supplemento usa reservoir con seed fisso, 128 membri per archivio,
limite 4 MiB per membro, CRC dei membri letti e sorgenti montate read-only.
Non è un campione probabilistico dell'intero dump.

Sono verificati metadata mancanti/hash errati, compatibilità v1, ordine e
identità di 400 capitoli, CLI senza DB/dump, reader e download HTML/EPUB/PDF,
metadata-only sovrapposti a contenuti completi e replay. Il test di backup
confronta i contenuti storici ricostruiti prima e dopo restore PostgreSQL/pack,
includendo una revisione HTML persistente e una virtuale; la sorgente originale
è indisponibile durante il restore.

La suite multisorgente verifica SIGTERM, SIGKILL, pausa, crash in transazione e
nel seal, checkpoint contigui, FK, deduplicazione e ripresa. L'attesa della
barriera del test è ora bounded a 60 s anziché 300 poll da 20 ms: le condizioni
sul prefisso durevole e sull'integrità non sono cambiate. I primi tentativi
falliti e le correzioni sono riportati nel JSON, senza presentarli come successi.

Lettura verificata dei 20 TXT più lunghi: p95 **13,49 → 48,75 ms**;
20 letture del massimo da 609.915 byte: p95 **26,52 → 84,76 ms**. Sono letture
warm PackStore più trasformazione, con quota 2 CPU, senza HTTP/sanitizzazione.
La ricostruzione costa CPU: non si dichiara un miglioramento di latenza. La
memoria viene ammessa sulla dimensione espansa; non esiste una cache crescente.

### Backup e restore del corpus

Il backup completo verifica **28.920 oggetti**. Il restore ricrea il catalogo e
il PackStore in una directory e un database separati, ricostruisce **1.207
proiezioni OpenSearch** e termina con zero elementi pendenti. Coincidono le firme
degli oggetti e delle relazioni archivistiche, tutte le otto relazioni immutabili
confrontate, i contenuti di due versioni storiche lette da tre client e otto TXT
virtuali. Anche le letture concorrenti al backup terminano senza errori.

Tempi: backup **64,98 s**, restore fisico/SQL **48,04 s**, rebuild **76,11 s**;
backup, restore, rebuild e verifica **198,48 s** complessivi. Durante questa
verifica è attivo anche il confronto read-only dell'input full-text del sorgente.
Il rebuild di restore usa il worker da 4 CPU: il suo tempo non va confrontato
come un'accelerazione con la projection da 2 CPU della campagna integrata.
Il payload del backup è 296.606.606 byte, distinto dai byte finali dei pack.

L'export archivistico completo richiede **172,58 s** e produce un volume da
576.366.074 byte. La CLI verifica **28.951 oggetti portabili** (28.920 canonici
più i descrittori del catalogo esportato), risolve i metadata-only unificati e
ricostruisce otto TXT con contenuti identici al reader. I processi CLI hanno
riferimenti a database e dump non disponibili e usano soltanto l'archivio.

Il supplemento CSV isolato conserva 64 opere/snapshot: **193 → 129 oggetti**,
**216.231 → 156.738 byte** di record PackStore, staging finale zero. Non viene
usato per aggiungere un risparmio ipotetico alla proiezione principale.

La build completa finale e i test pertinenti sono passati. La prima esecuzione
integrale aveva 52 test top-level riusciti su 57; tutti i cinque fallimenti sono
stati risolti e rieseguiti con successo, oltre al nuovo test TXT integrato, ai
quattro test canonici e alla regressione del backup piattaforma. Il JSON conserva
cause, rerun e checksum delle evidenze. Non si presenta questo percorso come
un'unica nuova esecuzione integrale senza errori intermedi.

## Confronto integrato

Entrambi i runtime acquisiscono le stesse 15 categorie prima di un unico rebuild:
1.207 opere, 1.210 snapshot, 14.614 revisioni di capitolo. Il replay mantiene
invariati snapshot, revisioni e oggetti. Il candidato conclude con 28.920 oggetti,
la baseline con 29.320. Tutte le code terminano vuote e OpenSearch contiene
1.207 documenti in entrambi i casi.

| Misura                             | Baseline | Candidato |
| ---------------------------------- | -------: | --------: |
| Ingest canonico, s                 |   194.59 |    216.37 |
| CPU worker durante ingest, CPU-s   |   336.56 |    348.38 |
| Proiezioni e rebuild OpenSearch, s |   443.54 |    490.76 |
| Pipeline con replay, s             |   650.05 |    719.63 |
| Picco working set worker, MiB      |   457.13 |    509.27 |
| Picco working set projection, MiB  |   646.52 |    614.76 |
| Peak staging, MiB                  |   209.68 |    204.10 |
| WAL generato, MiB                  |    93.66 |     94.44 |
| Database dopo replay, MiB          |    70.06 |     69.65 |

L'ingest wall-clock aumenta dell'11,2%, la CPU canonica del 3,5%; la pipeline
complessiva del 10,7%. Non si attribuisce a questo intervento un aumento di
throughput. La memoria rimane bounded, entro le quote; il worker usa circa
52 MiB aggiuntivi di working set massimo e lo staging diminuisce di circa 5,6 MiB.
Il WAL aumenta di circa 0,8 MiB: nessun risparmio WAL viene dichiarato.

È una coppia di campagne su host condiviso, con quote e configurazione identiche,
non una distribuzione statistica. Una verifica read-only della baseline si è
sovrapposta a parte della campagna candidata; l'ordine dei gruppi di proiezione
dipende inoltre dagli UUID locali. I tempi sono misure descrittive del protocollo,
non stime causali precise della sola codifica. I delta fisici A/B/C/D usano invece
identità fissate e isolano gli interventi.

Dopo la manutenzione ordinaria, i pack integrati occupano
**253.111.372 → 249.681.894 byte** (risparmio 3.429.478 byte); allocazione filesystem
**253.206.528 → 249.778.176 byte**. La differenza minima rispetto alla matrice
isolata dipende da UUID/compressione e confini dei pack, non da dati eliminati.
Non ci sono duplicati fisici e lo staging finale è zero.

Il catalogo SQL degli oggetti, indici inclusi, passa da **5.668.864 a 5.603.328
byte**: 65.536 byte in meno. Il database dopo VACUUM/ANALYZE occupa
**74.189.971 → 74.050.707 byte**; le altre differenze includono allocazione e
manutenzione delle proiezioni. Nessuna estrapolazione di questo delta SQL.

Su 30 richieste warm con tre client, il reader di 256 capitoli misura p95
**5.105 → 5.091 ms**; la ricerca p95 **1.529 → 1.065 ms**. Sono tempi degli
handler senza HTTP; non dimostrano un miglioramento generale della ricerca.
Su un TXT reale comune alle due campagne: HTML **231 → 348 ms**, EPUB
**230 → 268 ms**, PDF **7,83 → 10,25 s**. È una singola generazione per formato,
non un p95; CPU Node e RSS sono nel JSON e non includono i subprocessi del PDF.
La latenza addizionale dei TXT lunghi è riportata separatamente sopra.

L'input full-text ricostruito per **tutti i 1.207 documenti**, 433.959.411 byte,
ha lo stesso SHA-256 nelle due campagne. Coincidono anche metadata correnti e
documenti OpenSearch normalizzati. Poiché `_source` esclude già `text`, il
controllo del testo usa esplicitamente la preparazione condivisa dell'indice,
senza cambiare mapping, analyzer, posizioni, facet, filtri o ranking.

## Proiezione condizionata

| Scenario   | Baseline GiB | Nuovo PackStore GiB |
| ---------- | -----------: | ------------------: |
| Favorevole |     1.297,28 |            1.117,96 |
| Centrale   |     1.305,38 |            1.126,94 |
| Prudente   |     1.316,46 |            1.139,82 |

Il centrale risparmia circa **178,44 GiB**. TXT: **251,37 → 136,71 GiB**,
compresi metadata/manifest; SQLite: **141,22 → 98,06 GiB**. La sola eliminazione
del payload HTML TXT vale circa **108,04 GiB** sul coefficiente P5; i tre campioni
aggiuntivi confermano l'ordine di grandezza. Header e metadata spiegano il delta
ulteriore della categoria. Nessun risparmio SQL ipotetico è sommato al PackStore.

I coefficienti sono separati per formato e classe EPUB, con sensibilità media;
SQLite è pesato sulle 48.237.465 acquisizioni, senza supporre eliminabili quelle
con identità ripetuta. L'intervallo TXT modifica solo il coefficiente del payload
sorgente in base ai nuovi campioni. CSV e altri budget non misurati nuovamente
nella matrice principale conservano le stime precedenti. Non si applica una
percentuale globale ai byte del dump. Questi scenari non sono intervalli di
confidenza né garanzie di capacità; cache, WAL, staging, backup e spazio di
manutenzione restano separati. Nessuna riserva operativa viene ridotta.

## Riproduzione

- Costruire baseline e candidato in checkout separati con il Dockerfile esistente;
  usare lo stesso runtime e Zstd, sorgenti di fixture read-only, directory nuove.
- `benchmark-final-canonical.ts PACK_FIXTURE OUTPUT TXT_ZIP` produce A/B/C/D
  tramite PackStore; `benchmark-canonical-reader.ts OUTPUT` misura la lettura.
- `benchmark-final-txt.py ZIP1 ZIP2 ZIP3` confronta i parser dei due checkout;
  i mount `/input`, `/app`, `/baseline` sono read-only. Emette soli aggregati.
- `benchmark-canonical-observation.ts PACK_FIXTURE OUTPUT` confronta il payload
  condiviso delle osservazioni; non modifica il writer applicativo.
- Il benchmark integrato usa `benchmark-p0.sh` in `BENCH_SETUP_ONLY=1` e
  `FINAL_CANONICAL_BATCHED=1 run-storage-campaign.py ROOT`, fixture P5 verificata,
  worker 4 CPU/3 GiB, projection 2 CPU/1,5 GiB, PostgreSQL 2 CPU/2 GiB,
  OpenSearch 2 CPU/3 GiB. Acquisisce tutte le categorie prima di un unico rebuild.
  Il primo tentativo con rebuild ripetuti per categoria è escluso dai tempi.
- `summarize-final-canonical.py PHYSICAL TXT_JSON OBSERVATION_JSON CAMPAIGN_ROOT`
  aggiorna il report nuovo, lasciando intatti P5 e Storage Overhaul.

I gate operativi di [12](12-first-ingest-readiness.md) restano separati e
vincolanti. Nessun primo ingest reale è stato avviato.
