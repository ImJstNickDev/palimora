# 12 — Readiness della prima acquisizione massiva

Valutazione P5 del 9 novembre 2026, riferimento `7f0f41f02cf6833b6886d7637896069231437504`.
**NO-GO. P5 non completata; Performance Overhaul P0–P5 non dichiarato concluso.**
Non è stato effettuato deployment né ingest massivo. Il report macchina è
[performance-p5-final.json](performance-p5-final.json). Un NO-GO di capacità
non costituisce una verifica positiva dei criteri di stabilità ancora mancanti.

## Workload verificato

Inventario tramite stat, senza scansione dei contenuti: 139 ZIP, 853,081 GiB;
3 SQLite, 53,770 GiB; 10 `.part`, 16,820 GiB. Presenti anche sidecar SQLite.
Gli incompleti restano esclusi; gli SQLite rappresentano metadati, dipendenze e
possibili sovrapposizioni, non altri 54 GiB di nuovi testi.

Dimensioni ZIP min/p25/mediana/p75/p90/max: 0,213 / 1,997 / 4,075 / 8,662 /
15,781 / 34,775 GiB. Letta la central directory di sei ZIP a questi quantili.
Il riferimento P4 è **il più piccolo**. I quattro campioni intermedi contengono
77.364–429.980 EPUB; il maggiore contiene 2.097.044 TXT e 211.219 HTML,
89,666 GiB decompressi esterni. Questi byte non equivalgono ai byte interni EPUB.

`sample-p5-zip.py` legge al massimo dieci membri e 64 MiB per ZIP, verifica CRC
ed esamina le directory interne EPUB. Si esegue con sorgente montata `readonly`,
rete disabilitata, 1 CPU / 3 GiB RAM; non importa né estrae permanentemente opere.
La selezione primi/ultimi/più grandi è intenzionale, non casuale né pesata.
Non determina cardinalità globale, dedup, distribuzione dei capitoli, conflitti,
CRC dei membri non letti o copertura CSV. Lo schema dei tre SQLite è riconosciuto;
non è stato misurato il costo di costruzione dei loro indici derivati.

**Rischio memoria:** `run_zip` usa `ZipFile.infolist()`: la memoria della central
directory cresce col numero di membri, prima delle finestre bounded di parsing.
Il maggiore ZIP ha 2.308.264 membri. Non trasferire automaticamente la quota del
piccolo campione a quattro ZIP grandi contemporanei. Occorre misurare il massimo
aggregato e imporre un budget compatibile prima di promuovere il profilo.

## Configurazione candidata, non definitiva

P4: throughput-first, 4 sorgenti, 6 parser totali, 4 commit, pool PostgreSQL 12,
gruppi 256, I/O 8, Zstd 3, projection isolata, facet paralleli 0. Confronto P5
limitato: A quattro sorgenti; B due sorgenti con gli altri parametri invariati;
C ripetizione a due sorgenti. Nessuna ricerca esaustiva o tuning P95/PIT/facet.

Quote della fixture: worker (include API di prova) 4 CPU / 3 GiB; PostgreSQL
2 CPU / 2 GiB; OpenSearch 2 CPU / 3 GiB, heap 1 GiB; projection 2 CPU /
1,5 GiB; Redis 0,5 CPU / 256 MiB. Limiti CPU condivisi, non core riservati.
Host KVM, 14 CPU logiche, 62 GiB RAM; inizialmente circa 24 GiB disponibili.
Non sono state modificate quote o configurazioni di altri servizi.

Backlog 8 GiB, staging adapter 4 GiB e riserve per mount 8 GiB restano attivi.
La riserva di arresto di 8 GiB **non** sostituisce il dimensionamento completo.
Non applicare questi valori in produzione come configurazione P5 approvata.

## Capacità: scenari di sensibilità

Il conteggio globale di identità, revisioni e capitoli è ignoto. Le seguenti sono
**ipotesi di pianificazione**, non intervalli statistici o una previsione validata.
La quantità aggiuntiva dipende da queste ipotesi. Non si usa il rapporto fra
filesystem inizializzato e ZIP P4.

Modello: pack = 853,081 GiB × rapporto; PostgreSQL = 16 GiB fissi + 12.000 byte
per snapshot + 8.000 per capitolo; ricerca = 16 GiB + byte testo × amplificazione.
Il costo SQL P4 è circa 39 kB/opera con 2,08 capitoli/opera: la separazione dei
coefficienti non è identificabile con quel solo campione; quelli qui scelti sono
assunzioni, da ricalibrare su scala. Media pesanti possono aumentare pack senza
far crescere proporzionalmente SQL. Revisioni ripetute aumentano provenienza e
snapshot, ma non necessariamente tutti i contenuti. Nessuno sconto dedup globale
viene assunto sul volume pack.

| Componente GiB | Favorevole | Centrale | Prudente |
|---|---:|---:|---:|
| Snapshot ipotizzati (milioni) | 15 | 30 | 50 |
| Capitoli ipotizzati (milioni) | 25 | 60 | 150 |
| PackStore (rapporto 1,2 / 1,8 / 3) | 1.024 | 1.536 | 2.559 |
| PostgreSQL heap/indici/TOAST | 370 | 798 | 1.692 |
| OpenSearch e translog | 466 | 1.456 | 4.216 |
| WAL trattenuto, budget | 32 | 64 | 128 |
| Code durevoli | 8 | 8 | 8 |
| Staging e temporanei | 8 | 8 | 8 |
| Cache derivata SQLite, budget | 128 | 128 | 128 |
| Manutenzione/merge/compattazione | 256 | 512 | 1.024 |
| **Totale con margine 25%** | **2.865** | **5.637** | **12.205** |

Spazio disponibile rilevato su `/mnt/sdb`: circa **1.552 GiB**. Deficit nei tre
scenari: **1.312 / 4.085 / 10.652 GiB**. Per coprire lo scenario prudente servono
quindi circa **10,4 TiB aggiuntivi** sul volume di lavoro, esclusi backup/restore.
Non è una misura della necessità effettiva; nessuno dei tre scenari giustifica GO
sul disco attuale. Non si assume cleanup di directory preesistenti per colmare il
deficit. Il dump originale occupa altri 923,67 GiB su filesystem separato e resta
read-only; non va ricopiato nel volume di lavoro.

WAL generato cumulativo non è WAL trattenuto: slot, archiviazione bloccata e
transazioni lunghe possono superare qualunque budget qui indicato. Monitorare
entrambi e fermare l'acquisizione se la retention cresce senza limite.

Backup completo e restore vanno su destinazioni separate: prenotare provvisoriamente
almeno un ulteriore totale di lavoro per ciascuna destinazione e misurare cattura,
volumi e restore prima di approvare. Gli export canonici possono contenere byte
non compressi: il peso dei pack da solo non dimensiona un export. Verificare marker,
device, permessi, chiave auth e leggibilità dei volumi come in [08](08-backup-export.md).
Nessuna destinazione o prova restore definitiva viene attestata da questa valutazione.

## Tempo

Non esiste ancora una misura sostenuta rappresentativa dell'intero dump.
Sensibilità esplicita del **solo canonico ZIP**: 20 / 12 / 6 GiB sorgenti/ora
implicherebbero circa **43 / 71 / 142 ore** per 853 GiB. Sono rate ipotizzati,
non rate P5 garantiti. Non applicarli ai 54 GiB SQLite o ai `.part`.

Per il downstream, ipotizzare rispettivamente 10 / 20 / 35 milioni di opere
uniche a 70 / 50 / 25 opere/s dà circa **40 / 111 / 389 ore**. I processi si
sovrappongono: non sommare automaticamente tempi canonico, catalogo e full-text.
Aggiungendo contesa, SQLite, versioni e recuperi, finestre esplorative end-to-end
sono **2–4 / 5–10 / 17–30 giorni**, non una previsione operativa validata.
Catalogazione storica e indicizzazione di testi lunghi richiedono misure separate:
questi intervalli non attestano il loro throughput a decine di milioni di record.

## Preflight e avvio riservato all'operatore

```sh
python3 scripts/preflight-first-ingest.py --env-file .env \
  --compose infra/compose.yaml --required-gib 12205
```

Output JSON, exit 2 per NO-GO. Il comando legge Compose senza stampare segreti,
controlla bind, sorgenti read-only, quote, budget e spazio per device (non somma
due volte lo stesso filesystem). Non crea directory, utenti, backup o batch.
È un gate statico: le verifiche manuali obbligatorie restano elencate e non
vengono trasformate in PASS. Un esito NO-GO non deve essere ignorato perché
Compose è sintatticamente valido. Il modello assume un volume dati condiviso;
con filesystem separati serve un budget per ciascun componente.

Prima di ogni avvio: completare prove P5 mancanti; ricalibrare capacità e quote;
verificare mount effettivi/UID, PG/Redis/OpenSearch sani, heartbeat projection,
assenza ingest concorrenti o selezioni automatiche, connessioni disponibili,
WAL/slot e restore su fixture. Eseguire backup completo verificato dello stato
iniziale; solo l'operatore autorizza e avvia il batch dal pannello `/admin/ingest`.
Selezionare esplicitamente sorgenti e dipendenze; conservare report lacune.

Durante l'import registrare throughput per intervallo, opere/capitoli, checkpoint,
byte code correnti/storiche/testo, età del più vecchio job, WAL generato/trattenuto,
spazio e inode per mount, staging/prenotazioni, RSS/OOM, I/O, checkpoint PG,
autovacuum e dimensioni heap/indici/TOAST. Il campionamento non deve esporre testi.

Pausa tramite gestione ingest; attendere commit/checkpoint. Per arresto servizi
usare SIGTERM e periodo di grazia, evitando SIGKILL operativo. Riprendere lo stesso
batch dopo aver verificato dipendenze e capacità; non resettare checkpoint/code.
Un OpenSearch indisponibile non richiede fermare immediatamente il canonico se i
budget sono sicuri, ma richiede controllo della crescita delle code. Dopo il
ripristino verificare code vuote, documenti/generazioni e lettura dei contenuti.

Abort/pausa obbligatoria: checksum o riferimenti incoerenti, parser_blocked,
OOM ripetuto, mount sparito, riserva raggiunta, staging saturo, WAL non bounded,
backlog oltre budget o crescita incompatibile con lo spazio residuo. Conservare
log e fixture; nessuna cancellazione automatica di storico o sorgenti per ripartire.

## Evidenze ancora necessarie

La prova breve con quote non sostituisce una prova sostenuta: mancano una campagna
lunga con identità distinte, indisponibilità prolungata OpenSearch, recovery con
backlog grande e pausa disco, misure di autovacuum/bloat, ingest delle fixture
eterogenee con conflitti e verifica del backup/restore sul profilo definitivo.
Le prove P3/P4 restano evidenze storiche, non vengono ribattezzate come prove P5.
Fino alla loro chiusura, P5 resta incompleta anche con più disco disponibile.

Il campionamento bounded ha effettivamente letto **60 membri / circa 106 MiB**
(vedere byte esatti nel JSON). Il processo ha raggiunto **2.611.612 KiB di RSS**
nel campione con 2,3 milioni di membri, con quota 3 GiB. È un picco del sampler
sequenziale, non una misura del worker: include strutture di selezione e memoria
trattenuta dai campioni precedenti. Conferma comunque che 3 GiB non sono un
budget validato per quattro central directory grandi più parser/Node. Il conteggio
per filename `chapter` non misura i capitoli FanFicFare, riconosciuti anche dalla
classe HTML: i conteggi reali restano da rilevare con l'adapter.

Riproduzione del confronto breve con directory nuove e tre subnet libere:

```sh
AO3_DUMP_ROOT=/mnt/sdb/palimora-p3a-fixture \
 RELEASE_IMAGE=palimora-p4-promote \
 P5_BENCH_PREFIX=/mnt/sdb/palimora-p3-final-p5-nuovo \
 P5_SUBNET_OCTET=80 ./scripts/benchmark-p5-quotas.sh
```

Le fixture restano private, con container fermati al termine; nessun contenuto
archiviato viene committato. Le due preparazioni non avviate della campagna sono
rimaste isolate (pool subnet automatico esaurito; aggiornamento quota swap Docker
rifiutato). Il launcher ora imposta memoria e swap insieme per la projection.
I tentativi falliti non sono inclusi nelle misure. Nessun test distruttivo è stato
eseguito sul filesystem di produzione.

## Misure brevi con quote e integrità

Intervallo canonico dall'avvio persistito all'ultimo commit; end-to-end include
verifica della visibilità. Cache filesystem non svuotata, host condiviso.

| Prova | Sorgenti | Canonico s | Opere/s | GiB sorgenti/ora | End-to-end s | Drenaggio/verifica s |
|---|---:|---:|---:|---:|---:|---:|
| A | 4 | 48,423 | 227,83 | 15,837 | 176,938 | 128,515 |
| B | 2 | 50,188 | 219,81 | 15,280 | 180,072 | 129,884 |
| C | 2 | 51,098 | 215,90 | 15,008 | 177,364 | 126,266 |

C ripete B per verificare il costo della minore concorrenza; **non è una
validazione di un nuovo profilo migliore**. A rimane la più veloce di queste tre
prove. Nessun numero in tabella è dichiarato throughput sostenibile del dump.
Rispetto a P4 senza quote, il canonico è più lento; non si attribuisce tutto il
delta alle quote perché manca un controllo contemporaneo senza limiti.

Ogni prova verifica **107.054 oggetti** (decompressione e SHA-256), 11.032 opere,
11.032 snapshot, 22.928 revisioni/capitoli e tutti i documenti/generazioni di
OpenSearch. Manifest normalizzato uguale nelle tre prove e a P4. Staging finale
vuoto. Pack circa 291 MB, senza cambio di formato o compressione.

Massimi osservati: worker circa **407% CPU**, working set **1.104 MiB**, memoria
cgroup con cache **1.813 MiB**; OpenSearch **2.257 MiB** con cache. Sono picchi di
container distinti, non vanno sommati come se simultanei. Staging nominato
**860.202.904 byte** in A; B/C circa 585/611 MB. I/O PostgreSQL scritto per prova
circa 2.297–2.393 MiB, OpenSearch 1.108–1.185 MiB. Non è un picco di bandwidth:
il picco I/O non è stato calcolato; i contatori worker di A/projection risultano
indisponibili e sono `null`, non zero.

Code massime: **8.952 correnti, 8.952 storiche, 904 full-text** (picchi non
necessariamente simultanei); occupazione fisica combinata massima **3.588.096
byte**. Code finali vuote. WAL generato **721–727 MB** per pipeline; picco WAL
trattenuto non rilevato. Questi numeri non validano un backlog da 8 GiB o la
retention prolungata. Nessun outage OpenSearch è stato iniettato nelle tre
misure temporizzate.

Build completa riuscita; **8 test** pressione/scheduling, **2 test** preflight e
**2 test** integrazione recovery passati, zero skip/fallimenti. I recovery coprono
sorgenti sovrapposte, dedup/provenienza, SIGTERM/SIGKILL, barriera dentro transazione
SQL e seal pack, pausa disco simulata e URL OpenSearch irraggiungibile. Il caso
backlog è di **160 opere**; non è una sospensione prolungata del servizio reale.
Tre lettori concorrenti dopo il drenaggio: **30 richieste, zero errori**, p95
700,9 ms, massimo 721,4 ms; è un controllo di leggibilità, non una nuova campagna
P95. Nessun bug del motore è stato corretto o mascherato; il cambiamento esecutivo
è limitato al supporto delle quote nel launcher dei benchmark.

Misura aggiuntiva a container fermati: directory `pg_wal` B/C **754.987.008
byte** ciascuna; A **738.209.792 byte**, dopo i successivi test di recovery.
Sono occupazioni finali, non picchi né WAL cumulativo generato. La retention sotto
backlog prolungato resta non verificata.
