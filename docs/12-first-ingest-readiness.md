# 12 — Readiness della prima acquisizione massiva

Valutazione conclusiva P5, 9 novembre 2026; base `a6a07d2d918a89ab5a4a6a56764c93827712cf15`.
**P5 tecnicamente conclusa. Primo ingest reale: NO-GO.** Le prove isolate sono
concluse; capacità, layout, configurazione definitiva e destinazione backup
richiedono ancora l'intervento dell'operatore. Nessun deployment o ingest massivo
è stato eseguito. Il [report macchina](performance-p5-final.json) conserva
integralmente la prima valutazione in `previous_assessment`; `completion` contiene
le nuove evidenze. I vecchi 2.865 / 5.637 / 12.205 GiB erano sensibilità ipotetiche,
non requisiti fisici dimostrati, e non sono il modello operativo corrente.

## Sorgenti e rappresentatività

Inventario: 139 ZIP, **853,081 GiB**, tre SQLite **53,770 GiB**, dieci `.part`
esclusi. Letti gli end record ZIP/ZIP64 e le central directory dei 139 ZIP,
**30.408.133 membri**, senza decomprimere il dump. Questa scansione dei soli
metadati serve a pesare i formati; non è una verifica CRC di tutti i contenuti.

| Formato / dimensione esterna del membro | Membri | GiB compressi nei ZIP |
|---|---:|---:|
| EPUB <16 KiB | 13.821.360 | 106,113 |
| EPUB 16–128 KiB | 7.539.151 | 297,020 |
| EPUB 128 KiB–1 MiB | 1.158.651 | 287,877 |
| EPUB ≥1 MiB | 24.754 | 39,987 |
| TXT | 7.633.006 | 109,475 |
| HTML | 230.791 | 3,694 |
| CSV | 5 | 0,287 |

Directory, log, TSV e altri membri spiegano la parte restante; la dimensione
fisica ZIP include anche directory e framing. **Membri ≠ opere uniche.** I GiB
esterni EPUB non sono i GiB del testo decompresso all'interno degli EPUB.

Campionati sette archivi: `queue73`, `queue100`, `queue03`, `queue22`,
`ao3_old_files_part17`, `pic_stories`, `login`. Reservoir per classe di dimensione
con seed fisso, più quattro EPUB estremi per sorgente. Totale **968 membri reali,
250.372.738 byte decompressi esterni**, importati solo da ZIP ricostruiti nella
fixture privata. I due campionamenti hanno limiti individuali di 1 GiB, 1.800
membri, 900 s; escludono dal campione membri oltre 24 MiB e non estraggono ZIP
completi. I loro manifest con locator e hash restano privati.

Dai tre SQLite: 240 righe metadata/stories e 60 tag, selezionate in cinque finestre
bounded di rowid. Dipendenze assenti nella fixture restano lacune esplicite;
nessun ZIP originale è montato nel worker di benchmark. Il limite superiore
osservato dei rowid è 22.249.303 / 17.656.566 per le due `ao3_metadata`, 7.973.784
per `metadata_full_old`, 357.812 per `stories`. Sono **limiti di righe**, non
conteggi esatti o opere uniche. Il planner della deduped riporta 16.390.750 righe,
ma la statistica può essere vecchia. Il massimo ID dei tag è sparso e non viene
usato come cardinalità.

Un caso sintetico aggiuntivo contiene un'opera, due versioni, 256 capitoli per
versione e un media da 1 MiB. Le fixture reali comprendono media, metadati incompleti,
14.102 revisioni di capitolo oltre alle 512 del caso sintetico e sovrapposizioni:
968 membri producono 966 identità reali. Il totale prima del carico sostenuto è
**1.207 opere, 1.210 snapshot, 29.320 oggetti**.

Supplemento CSV: 64 righe complete riserializzate da un prefisso bounded di 2 MiB
in `gap_filled.zip`, 53.166 byte di CSV nella fixture. Import canonico in un terzo
database isolato: 64 opere/snapshot, 193 oggetti verificati, staging vuoto e 64 documenti derivati con ID/generazioni
corrispondenti e code drenate.
Non verifica il CRC dell'intero membro originale. Il pack e la dimensione per
riga entrano soltanto nella sensibilità CSV; nessun throughput sostenuto è dedotto. L'opera reale più lunga campionata ha 1.630 capitoli.

Il campione non è un campione probabilistico dell'intero dump: solo sette archivi
forniscono contenuti, gli estremi sono sovracampionati, i TXT/HTML provengono da
un archivio, i media da due sorgenti mirate, i tag e i metadati SQLite da poche
finestre. Non misura dedup globale, ogni conflitto possibile, ogni dipendenza,
né la coda oltre 24 MiB. I risultati non sono intervalli statistici.

## Memoria dei grandi ZIP e configurazione verificata

Tre processi freschi, sul ZIP da **2.308.264 membri**, con memoria campionata:

| Percorso | RSS massimo KiB | Tempo s |
|---|---:|---:|
| Apertura `ZipFile`, nessun campionamento | 2.271.744 | 23,376 |
| Adapter precedente, solo inventory e EOF sull'ACK | 2.292.488 | 24,076 |
| Adapter definitivo, quota 6 GiB, stesso percorso | 2.286.088 | 24,240 |

Il vecchio picco del sampler, circa 2,49 GiB, includeva più archivi e strutture
aggiuntive. Quattro directory del massimo osservato richiederebbero già circa
**8,7 GiB RSS**, prima di Node e parser: la quota da 3 GiB non era sicura.

La correzione conserva il parser ZIP standard. Il probe legge soltanto gli end
record CPython, compreso ZIP64. Oltre **100.000 membri o 16 MiB di central
directory**, una sorgente diventa una barriera esclusiva: nessun altro ZIP è
aperto contemporaneamente; i sei parser e quattro commit restano disponibili.
Oltre 3 milioni di membri o 512 MiB di directory, oppure con quota cgroup sotto
6 GiB per un ZIP grande, l'ingest si sospende per capacità. Non salta membri.
Durante l'allocazione della directory `RLIMIT_AS` limita il processo a 384 MiB
per un ZIP piccolo o 3 GiB per uno grande; poi viene ripristinato. MemoryError
è pressione di capacità, non una sorgente corrotta. Il massimo reale passa con
6 GiB; con 3 GiB il nuovo adapter rifiuta prima dell'allocazione, senza OOM.

Quattro directory piccole hanno dunque un tetto aggregato di allocazione di
1,5 GiB; una grande di 3 GiB. I parser usano `spawn` e non ereditano la directory.
Il working set massimo della fixture eterogenea è 1.447 MiB per il worker:
la quota 6 GiB lascia margine per la directory esclusiva, Node e finestre bounded.
Questo non garantisce l'elaborazione di qualunque ZIP ostile o opera arbitraria:
fuori dall'inviluppo validato la risposta è pausa/errore esplicito, mai perdita
silenziosa. La prova sul ZIP da 2,3 milioni è di inventory, non il suo ingest.

Profilo candidato definitivo **verificato in isolamento**, da applicare solo
dopo i gate operativi:

```dotenv
INGEST_PRESSURE_MODE=throughput-first
INGEST_SOURCE_CONCURRENCY=4
INGEST_PARSER_WORKERS=6
INGEST_COMMIT_CONCURRENCY=4
INGEST_GROUP_RECORDS=256
INGEST_IO_THREADS=8
INGEST_CPUS=4
INGEST_MEMORY=6g
POSTGRES_CPUS=2
POSTGRES_MEMORY=2g
SEARCH_CPUS=2
SEARCH_MEMORY=3g
SEARCH_HEAP=1g
API_PROJECTION_MODE=isolated
PROJECTION_CPUS=2
PROJECTION_MEMORY=1536m
ARCHIVE_ZSTD_LEVEL=3
INGEST_BACKLOG_GIB=8
INGEST_STAGING_GIB=4
INGEST_DISK_RESERVE_GIB=8
```

Pool PostgreSQL 12 per processo; `UV_THREADPOOL_SIZE=8` deriva da
`INGEST_IO_THREADS` nell'avvio Compose. `SEARCH_PARALLEL_FACETS=0` invariato.
Nessun tuning PostgreSQL globale: fsync/checksum/conservazione intatti. La fixture
abilita soltanto statistiche PostgreSQL pertinenti. Redis: 0,5 CPU / 256 MiB.
Host rilevato: 14 CPU logiche, circa 62 GiB RAM, circa 24 GiB disponibili all'avvio.
Le quote CPU sono limiti condivisi, non core riservati; lasciare margine agli altri
servizi e all'API. Nessuna quota di altri progetti è stata modificata.

Il confronto breve precedente rimane valido e non è stato ripetuto: quattro
sorgenti **227,83 opere/s**, due **219,81**, ripetizione a due **215,90**. Si conserva
il profilo a quattro sorgenti; l'esclusività dei ZIP grandi è una protezione di
memoria. I risultati P4 senza quote e quelli P5 non sono una nuova campagna A/B.

## Throughput, stabilità e recovery

Una campagna bounded, con database, rete e storage privati: **70.000 identità e
contenuti TXT sintetici distinti**, 688.498.798 byte raw, ZIP per 191.357.584 byte.
Quattro sorgenti, quote sopra, projection e OpenSearch fermi durante il canonico.
Il contenuto sintetico non è una replica deduplicata dei testi del campione.

Canonico **135,352 s**, inclusi arresti/riprese e pausa disco: **517,17 opere/s e
capitoli/s**, **4,740 GiB sorgenti/ora**. Campionamento SQL ogni 5 s per **500,23 s**,
risorse ogni secondo anche durante verifica. Non è una prova di ore o un rate
garantito del dump. Il target 2.000/s non è raggiunto.

Intervalli attivi iniziali 15–35 s: mediana 870,23 opere/s; ultimi 105–130 s:
716,94 opere/s, circa **18% meno**. Non si afferma assenza di degrado né si usa il
picco iniziale per la previsione. Circa 185,43 CPU-s worker nella finestra canonica
campionata, 2,65 ms/opera; le pause sono incluse nel tempo wall. Attesa pool osservata
1.929,8 ms su 874 acquisizioni, massimo 137,1 ms e tre client in attesa; l'ultimo
intervallo del processo ucciso può mancare. Nessuna crescita RAM monotona o OOM
osservata; la durata limitata non prova assenza di leak su giorni.

| Picchi campionati della campagna sostenuta | Worker | PostgreSQL | OpenSearch | Projection |
|---|---:|---:|---:|---:|
| CPU, % di una CPU | 391,4 | 204,0 | 201,8 | 133,9 |
| Working set MiB | 778,8 | 768,6 | 1.767,7 | 355,0 |
| Memoria inclusa cache MiB | 1.202,5 | 1.688,5 | 2.358,2 | 367,5 |
| Scritture massime MiB/s, intervalli 1 s | 44,6 | 144,0 | 110,8 | 0,06 |

I picchi per servizio non sono necessariamente simultanei. Nella fixture reale
il worker raggiunge 1.447 MiB working set. Lo staging sintetico nominato raggiunge
**42.692.290 byte**, poi torna vuoto; la quota resta 4 GiB. Il pack finale contiene
763.999.190 byte di oggetti compressi, oltre al framing dei pack.

Recovery effettivi: SIGTERM dopo 6.144 nuove opere; SIGKILL dentro una transazione
SQL dopo 28.416; pressione disco iniettata dopo 47.872, 17 s di pausa, conteggio
canonico fermo per dieci secondi dopo l'assestamento, arresto durante la pausa e
ripresa dopo rimozione dell'iniezione. Non è stato riempito alcun filesystem.
Il test mirato multisorgente sul codice finale verifica inoltre crash nel seal,
versioni sovrapposte, dedup e checkpoint; le suite P0–P4 non sono state ripetute.

Il canonico completa con OpenSearch spento e **70.010 job correnti + 70.000
storici**, superando la vecchia soglia di 65.536. Backlog mantenuto ulteriori
30 s dopo il canonico. L'indisponibilità copre almeno **165,35 s**, più arresto e
riavvio del servizio. Code fisiche 14.139.392 byte alla fine del canonico;
massimo osservato durante drenaggio **17.907.712 byte**, full-text fino a 480 job.
Non è una prova di occupazione effettiva di 8 GiB: quello è il limite operativo.

Ripristino OpenSearch e projection: drenaggio **314,311 s**, senza nuovo ingest,
code finali zero. WAL generato circa **826 MiB** durante il canonico, **1.277 MiB**
fino al drenaggio; massimo WAL trattenuto **1.008 MiB**. Non sono byte equivalenti.
La campagna/cluster registra due checkpoint temporizzati e sei richiesti; il
contatore include le precedenti fixture e il restore e non è attribuito tutto
al sintetico. Le tre code registrano 10–11 autovacuum. `VACUUM (ANALYZE)` impiega
0,031 s e riduce le loro relazioni da 17.907.712 a 8.159.232 byte, zero tuple morte
stimate. Non è un `VACUUM FULL`, né una misura esatta del bloat interno.

## Integrità, backup e lettura

Verifica finale: **379.320 oggetti**, decompressione e SHA-256; 70.000 manifest
sintetici confrontati con il contenuto della propria identità originale;
**71.207 opere, 71.210 snapshot, 84.614 revisioni di capitolo**. Tutti gli ID e le
generazioni SQL corrispondono ai 71.207 documenti OpenSearch, code vuote.
Replay del campione EPUB piccolo: zero nuove opere/snapshot/oggetti. Seconda
versione del caso da 256 capitoli: quattro nuovi oggetti, contro 262 iniziali.
Nessuno sconto di dedup globale viene dedotto da questi casi.

Backup **full reale**, manifest e checksum verificati, 300.142.995 byte;
57,57 s per la fase che comprende anche la verifica preventiva degli oggetti.
Restore in database e storage nuovi: **47,61 s**, più circa **81,08 s** per
ricostruire i derivati. Ripristinati 29.320 oggetti, 1.207 opere e 1.210 snapshot;
firme delle tabelle canoniche identiche e segreto cifrato decifrabile con la
chiave conservata nella configurazione del backup. Dieci job pendenti prima del
backup diventano 1.207 lavori di ricostruzione; tutti drenati su OpenSearch separato.
Tutti i **968 hash delle sorgenti reali** sono verificati nella provenienza
anche dopo restore. Manifest e contenuti privati non sono pubblicati.

Tre client concorrenti, ciascuno legge entrambe le versioni storiche: sei letture
sull'originale e sei sul restore, zero errori, contenuti identici tra client e tra
istanze. È il percorso reale `readerContent` con tre connessioni; non una nuova
misura HTTP/P95. La prova HTTP precedente rimane nel report storico.

## Modello di capacità ricalibrato

**Aggiornamento Storage Overhaul:** le tabelle P5 sottostanti sono risultati
storici condizionati. Il censimento successivo conta 48.237.465 righe SQLite ma
16.468.371 ID distinti. Non trattare la componente centrale metadata PostgreSQL
come spazio necessario dimostrato. [Storage Overhaul](storage-overhaul.md) e
[nuovo report](performance-storage-overhaul.json) distinguono misure, sensibilità
e assunzioni residue. La campagna eterogenea comparativa è stata rieseguita,
separando catalogo corrente, canonico, storia e dizionari; i nuovi valori sono
sensibilità per il dimensionamento, non previsioni statistiche. Restano da
approvare layout fisico, capacità disponibile e controlli operativi del primo
ingest. Nessuna riduzione ipotetica delle riserve di manutenzione o del margine.
Il gate rimane NO-GO. Le nuove sensibilità per il core PackStore/PostgreSQL/indice
sono 4.134/4.415/4.614 GiB (favorevole/centrale/prudente). Nel centrale il working,
comprese le riserve, è 10,53 TiB; working più una copia di backup separata è
13,79 TiB. Il margine centrale resta 2.682 GiB e la manutenzione 3.546 GiB:
nessun risparmio di riserva viene accreditato. Il target per restore simultaneo
richiede ulteriore spazio, dettagliato nel nuovo report.

Le tabelle che seguono conservano il modello P5 **precedente** per confronto.
Il report conserva per categoria byte sorgente compressi e decompressi, opere,
snapshot, capitoli, oggetti, pack, crescita SQL, CPU e durata. I costi fissi sono
separati: database iniziale 12.659.859 byte. Il rapporto tra filesystem totale e
ZIP di una fixture non viene utilizzato.

Formula: pack e ricerca pesati per **byte compressi del rispettivo formato**;
PostgreSQL per **membro/record** della medesima classe. Gli EPUB usano min / campione
principale / max dei due gruppi osservati. TXT e HTML hanno coefficienti propri.
La classe ≥1 MiB usa il campione estremo: non è una stima senza bias della sua media.
Gli indici OpenSearch sono stati ricostruiti separatamente per categoria, con
refresh/flush, stessi mapping e una replica zero. Le differenze fra successive
misure di un indice in merge possono essere negative e **non** sono coefficienti.

Coefficienti pack/compressed osservati: EPUB piccoli 1,659–1,717; medi
1,235–1,245; grandi 1,097–1,115; estremi 0,931–1,055; TXT 2,296; HTML 1,484.
Crescita SQL completa per record: EPUB piccoli 24–37 kB, medi 33–51 kB,
grandi 95–125 kB, estremi 193–374 kB; TXT 30 kB, HTML 37 kB.
I piccoli indici di categoria includono overhead di segmenti: non si assume che
questa amplificazione resti identica su milioni di documenti.

La decomposizione SQL misurata è nel JSON: heap/indici/TOAST per tabella e oggetti
per tipo. Tra i costi dominanti: documenti 11,0 MB, filtri e associazioni tag
8,83 MB ciascuno, registro oggetti 5,62 MB; capitoli, revisioni e collegamenti agli
snapshot sono contabilizzati separatamente. Media: 52,16 MB raw / 50,56 MB pack;
HTML dei capitoli: 481,98 MB raw / 185,48 MB pack. Non si inventa una regressione
indipendente per opera, snapshot, capitolo e byte: i coefficienti sono correlati
in questo campione. I conteggi e i costi delle relative tabelle restano verificabili.

Per SQLite si usa il limite di **48.237.465 righe** (non identità) ricavato dai
rowid. Scenario favorevole: metadati su identità già presenti, solo crescita SQL
canonica e nessun nuovo documento corrente. Centrale/prudente: crescita completa
misurata per record, come se ogni riga aggiungesse anche una nuova proiezione;
questa è un'assunzione conservativa, **non** una previsione di unicità. Nessuno
sconto sui pack per sovrapposizioni ignote. Il costo molto alto delle associazioni
bibliografiche nel piccolo campione deduped può sovrastimare la crescita a regime.

Cache SQLite derivata: misurata con `metadata_index.indexed_rows` su fixture,
1,05–1,37 kB logici/record metadata, 1,64–2,18 kB fisici nei piccoli file;
`stories` 57/341 byte. Ne derivano 59–91 GiB, con overhead delle pagine dichiarato,
anziché il precedente budget arbitrario di 128 GiB. La cache non sostituisce la
provenienza canonica e non richiede modifiche agli SQLite originali.

CSV: 53.166 byte / 64 righe nel prefisso campionato suggeriscono circa 1,04 milioni
di righe se la stessa dimensione media valesse per i cinque CSV: **non è un
conteggio**. Pack misurato 216.193 byte; proiezioni stimate con i coefficienti
metadata SQLite min / principale / max come proxy esplicito: circa 3,3 GiB pack,
13–94 GiB SQL e 2–8 GiB ricerca, già inclusi nella tabella. I log/altri artefatti
non tipizzati hanno invece riserva pari ai byte raw (7,7 GiB), senza assumere
compressione. La precisione di questi formati resta inferiore a quella degli EPUB.

| Componente, GiB aggiuntivi | Favorevole | Centrale | Prudente |
|---|---:|---:|---:|
| PackStore | 1.297 | 1.305 | 1.316 |
| PostgreSQL heap/indici/TOAST | 1.172 | 3.546 | 3.643 |
| OpenSearch store, replica zero | 1.737 | 2.193 | 2.278 |
| Translog, budget operativo | 8 | 8 | 8 |
| Cache metadata derivata | 59 | 91 | 91 |
| WAL trattenuto, budget operativo | 16 | 16 | 16 |
| Backlog | 8 | 8 | 8 |
| Staging e temporanei | 8 | 8 | 8 |
| Artefatti minori non tipizzati: byte raw | 8 | 8 | 8 |
| Manutenzione: una riscrittura del componente maggiore | 1.737 | 3.546 | 3.643 |
| Margine operativo 25% | 1.512 | 2.682 | 2.754 |
| **Budget di lavoro** | 7.561 | 13.411 | 13.772 |
| Una copia full di backup, ulteriore destinazione | 2.776 | 5.454 | 5.575 |
| Restore simultaneo su destinazione separata | 7.561 | 13.411 | 13.772 |

Questi sono **scenari condizionati**, non intervalli statistici, minimi fisici o
una richiesta di acquisto già dimostrata. Il nucleo pack+SQL+search è circa
**4,1–7,1 TiB**. Il totale prudente 13,45 TiB include una riscrittura integrale del
componente maggiore e margine; la manutenzione globale simultanea di tutti i
componenti non è coperta. Una procedura di manutenzione più limitata può cambiare
quel budget, ma deve essere dichiarata prima dell'avvio, senza affidarsi a cleanup
futuri per far entrare il nucleo dei dati.

I 16 GiB WAL e 8 GiB translog sono **budget operativi**, non limiti imposti dal
motore. Slot/archiviazione fermi o transazioni lunghe richiedono pausa prima di
superarli e controllo della retention. Il backlog fisico non comprende tutti i
byte dei pack già canonici: quelli sono già nella riga PackStore.
Backup: rapporto full misurato 0,899 circa rispetto a pack+DB, poi margine 25%;
la distribuzione SQL globale può cambiarlo. Export canonico non compresso è
un'altra operazione e va dimensionato sui byte raw, non sui pack. Originali,
backup e restore non sono spazio riutilizzabile del volume attivo.

### Filesystem e layout proposti

I valori aggiornati dopo cleanup e i deficit esatti sono nel JSON. Ordini di
grandezza: `/mnt/sdb` **1.547,78 GiB (1,512 TiB)**, `/mnt/teratron_data`
**2.822,46 GiB (2,756 TiB)** liberi;
`/` circa **264 GiB**, separato e non destinato all'archivio. Il dump e sidecar
preesistenti occupano circa 923,67 GiB sul volume sorgenti e restano read-only.

1. **Layout attuale, tutti i dati su `/mnt/sdb`: NO-GO.** Mancano circa
   **6.021 / 11.871 / 12.232 GiB** rispetto ai tre budget di lavoro più riserva di arresto, oltre alle
   destinazioni backup/restore. Anche il nucleo persistente favorevole non entra.
2. **Proposta separata, da approvare:** PackStore, staging e cache su
   `/mnt/teratron_data`; PostgreSQL, WAL, code e OpenSearch su `/mnt/sdb`.
   Pack+cache+temporanei con margine 25% e riserva 8 GiB richiedono circa
   **1.713 / 1.763 / 1.777 GiB** sul primo volume, compatibili con il libero
   misurato. Il resto richiede ancora circa **5.864 / 11.664 / 12.011 GiB** sul
   volume SQL/search, quindi un'espansione di circa **4.316–10.463 GiB** lì.
   Non si somma il libero dei due device. Condividere il dispositivo dei dump
   introduce contesa I/O non misurata e richiede mount/permessi corretti.
3. **Espansione/storage dedicato:** pianificare il budget scelto per ogni device,
   più una destinazione backup e spazio restore approvati. Nessuno spostamento,
   nuovo bind o modifica del layout di produzione è stato eseguito.

## Tempo: misure e limiti della previsione

| Categoria reale | GiB sorgenti/ora misurati | Note |
|---|---:|---|
| EPUB piccoli | 2,39 principale; 0,27 media | 192 / 16 membri |
| EPUB medi | 8,63; 1,46 | 192 / 16 |
| EPUB grandi | 37,60; 10,65 | 192 / 16 |
| EPUB estremi | 47,55; 52,55 | 16 / 8, selezione intenzionale |
| TXT | 3,52 | 160 membri |
| HTML | 3,75 | 160 membri |
| SQLite metadata-only | 57–115 righe/s | 60 / 120 righe, startup incluso |

Sono piccoli ingest reali seriali con quote, non rate sostenuti per classe.
Il sintetico sostenuto misura 4,740 GiB/h e non sostituisce questi formati.
Il replay reale piccolo dura 1,127 s e crea zero snapshot: non è throughput di
nuove acquisizioni. Su grandi ZIP l'apertura aggiunge fino a 24 s misurati e la
barriera esclusiva riduce il parallelismo tra sorgenti; resta il parallelismo
interno. I testi lunghi rallentano soprattutto la proiezione.

Applicare letteralmente i costi seriali per byte alle distribuzioni dà, nei tre
scenari, circa **119 / 119 / 660 ore canoniche ZIP** e **299 / 300 / 1.785 ore
per le proiezioni ZIP**. SQLite, al limite di righe assunto e ai piccoli rate
misurati, aggiungerebbe circa **213 ore canoniche**. La scansione/costruzione della
cache su 54 GiB, l'overlap tra identità e il costo a regime dei tag non sono
misurati integralmente: **questi valori sono sensitività, non una previsione
attendibile di durata totale**. In particolare, estrapolare lo startup di 16
opere a milioni di opere rende lo scenario prudente temporale molto largo.

Le finestre condizionate sono quindi dell'ordine di **due settimane** nel caso
favorevole, **più settimane** nel centrale e **oltre due mesi** nella sensibilità
prudente; non costituiscono una scadenza o un minimo garantito di throughput.
Non c'è un tasso minimo del dump sostenuto dalle prove. Canonico, catalogo e
full-text lavorano in parallelo: il tempo fino al drenaggio dipende dal massimo
del lavoro residuo dei due stadi e dalle dipendenze, non dalla somma ingenua delle
ore sopra. Il rate downstream sintetico osservato è circa **223 opere/s**;
il corpus lungo reale è molto più costoso. Non si promette quel rate sul dump.

## Preflight, backup e avvio dell'operatore

`preflight-first-ingest.py` v2 legge Compose e filesystem senza mutazioni. Ogni
componente dichiara GiB aggiuntivi e bind effettivo; percorsi sullo stesso
`st_dev` sommano i budget una sola volta e usano una sola riserva, pari al massimo
dichiarato su quel device. Non somma filesystem indipendenti. Servono componenti
`pack`, `postgres`, `search`, `wal`, `backlog`, `staging`, `metadata_cache`,
`maintenance`, `backup`, `restore`. Un componente può avere budget zero solo se
la sua assenza/condivisione è motivata nel piano operativo.

Esempio della struttura del piano, da completare con **tutti** i componenti e
percorsi approvati (non è un piano eseguibile completo):

```json
{
  "components": [
    {"component":"pack","service":"ingest","target":"/storage","required_gib":1313.2},
    {"component":"postgres","service":"postgres","target":"/var/lib/postgresql/data","required_gib":3548.6},
    {"component":"backup","path":"/destinazione-backup-approvata","required_gib":5466}
  ],
  "reserves":[{"path":"/volume-dati-approvato","gib":8}]
}
```

Budget di manutenzione e margine vanno allocati ai device interessati, non persi
nel totale. Componenti core devono riferire il servizio corretto e un bind
scrivibile realmente presente in Compose; backup/restore possono indicare
percorsi esterni esistenti. Il preflight non crea directory.

```sh
python3 scripts/preflight-first-ingest.py --env-file .env \
  --compose infra/compose.yaml --capacity-plan /percorso/plan.json \
  --technical-evidence docs/performance-p5-final.json
```

`static_result=GO` ed exit 0 significano soltanto controlli statici superati.
`decision=NO-GO`, `operational_authorized=false` e controlli manuali obbligatori
rimangono finché l'operatore non li completa. Exit 2 segnala fallimento statico.
I blocker sono separati in software, memoria, capacità, configurazione/backup.
Il vecchio `--required-gib` non può più attestare un layout multivolume. Nessun
segreto viene letto o stampato: si controllano mount, presenza e leggibilità.

Nel checkout di questa valutazione `.env` non è presente: la prova CLI effettiva
restituisce NO-GO di configurazione, senza esporre segreti. Non si dichiara
validata una configurazione definitiva assente. I test isolati verificano anche
il caso `static_result=GO`, che mantiene l'autorizzazione operativa negata.

Prima dell'avvio, l'operatore deve:

1. Preparare la configurazione definitiva, scegliere capacità e layout, approvarli e predisporre i bind senza modificare
   gli originali. Ricontrollare identità dei device, UID, inode, quote filesystem,
   read-only dei dump e i mount `/capacity/*`, inclusi eventuali WAL/tablespace.
2. Applicare il profilo 6 GiB solo dopo verifica del margine RAM/CPU dell'host;
   controllare PostgreSQL/Redis/OpenSearch, connessioni disponibili rispetto ai
   pool dei processi, heartbeat projection, assenza di altri batch ingest e di
   selezioni automatiche concorrenti.
3. Approvare destinazione backup, device/marker, capacità e credenziali; conservare
   la chiave auth con permessi corretti. Eseguire backup iniziale e restore di
   una fixture sulla **destinazione definitiva**, seguendo [08](08-backup-export.md).
   La prova isolata qui riuscita non attesta il supporto fisico definitivo.
4. Archiviare preflight, piano e verbale dei controlli manuali. Solo l'operatore
   autorizza e seleziona il batch in `/admin/ingest`, con dipendenze esplicite,
   `.part` esclusi e report lacune conservato. Il preflight non avvia nulla.

Durante l'import: registrare intervalli di opere/capitoli/s e GiB sorgenti/h,
RSS/working set/OOM, staging, byte ed età delle tre code, WAL generato e trattenuto,
heap/indici/TOAST, checkpoint/autovacuum, translog/merge, spazio e inode per device.
Usare SIGTERM e grace period; attendere commit/checkpoint, riprendere lo stesso
batch. Non resettare checkpoint o code. OpenSearch assente consente il canonico
entro budget; al ripristino controllare code, ID/generazioni e lettura storica.

Pausa/abort: hash incoerenti, riferimenti mancanti, parser bloccato, OOM, mount
sparito, capacità non leggibile, riserva raggiunta, staging saturo, WAL/translog
oltre budget o crescita del backlog incompatibile con il libero. Conservare i
log e ripristinare capacità/servizi prima del resume; nessuna cancellazione di
versioni, fsync o controlli per guadagnare velocità.

## Riproduzione e stato finale

Le fixture sono private sotto una root nuova `palimora-p5-completion-*`;
`p5-workload.py` misura end record, directory e adapter in processi freschi;
`prepare-p5-fixture.py` e `prepare-p5-synthetic.py` preparano i soli campioni.
Per l'inventory montare gli originali `readonly`, rete disabilitata, quota 6 GiB;
nel worker montare **solo** la fixture. Il launcher `benchmark-p0.sh` con
`BENCH_SETUP_ONLY=1`, `BENCH_QUOTAS=1`, `BENCH_WORKER_MEMORY=6g`, `RELEASE_KEEP=1`,
`P0_PARSERS=6`, `P0_COMMITS=4`, modalità throughput-first e quattro sorgenti crea
soltanto l'ambiente isolato. Richiede ancora il riferimento P4 per la propria
guardia: può essere un symlink read-only al campione preesistente; il controller
P5 lo esclude dalla selezione. Scegliere una subnet libera della sola fixture.

`run-p5-campaign.py ROOT/run` orchestra campagne, outage e restore; i comandi
`p5-verify.cjs`, `p5-components.cjs` e `summarize-p5-completion.py ROOT` producono
le verifiche e gli aggregati. Limiti: un'ora di campagna e 12 GiB per
DB+pack+staging, oltre ai temporanei backup/search monitorati separatamente.
Il controller iniziale aveva timeout troppo corto per la verifica backup: corretto
il timeout e ripresa la stessa campagna, senza ripetere le categorie. Un errore nella diagnostica CSV (campo `kind` omesso nella lettura degli oggetti)
è stato corretto e la sola verifica ripetuta, senza reingest. Il suo handler ha
sovrascritto il report dettagliato del controller: l'aggregato completo già
salvato, i log temporali e le verifiche immutabili conservano le misure; ora i
report CSV sono separati. Non era corruzione dei pack. La misura
separata degli indici ha ridotto le richieste a un documento e gestito i 429 del
circuit breaker; questa diagnostica non è una misura di throughput del worker.

Build completa, nove test scheduling/pressione, tre test ZIP admission, tre test
preflight e il test integrazione multisorgente/crash sul codice finale riusciti.
Le prove precedenti su `.part`, sorgenti mancanti/corrotte e checksum pack restano
valide; il parser ZIP standard e il formato canonico non sono stati sostituiti.
Cleanup limitato alle fixture create da questo incarico; evidenze aggregate e
manifest privati conservati, nessun file o servizio preesistente rimosso.

**P0–P5: Performance Overhaul tecnicamente concluso.** Non sono emersi blocker
software residui nelle prove eseguite. Restano incertezze di estrapolazione e
l'inviluppo bounded dichiarato, non nuove milestone software. **Primo ingest:
NO-GO per capacità sul layout configurato e gate operativi/backup/layout ancora
pendenti.** La capacità fisica non è l'unica formalità mancante; le verifiche
operatore sono obbligatorie anche dopo l'espansione. Nessun vero ingest avviato.
