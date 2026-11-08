# 08 — Backup, export archivistico, destinazioni esterne

## Tre prodotti distinti

| Operazione | Include | Esclude / scopo |
|---|---|---|
| **Backup piattaforma** | Utenti, credenziali hash, account, preferenze, collezioni, bookmark, progressi, annotazioni, configurazione, audit/stato necessitato | Non contiene testo e media del corpus; restore solo su corpus compatibile, con riconciliazione IDs |
| **Backup completo** | Tutti i dati necessari a migrare/ripristinare l'istanza: DB, packfiles e indice, media, configurazione/secret material necessario, utenti e stato applicativo | Non dipende dai dump sorgenti, non richiede una copia preesistente della libreria |
| **Export archivistico** | Opere, capitoli, metadata, tag, relazioni, versioni storiche, media e provenance, **senza dati personali della piattaforma** | Output portabile e indipendente da NestJS/Postgres/Docker |

Le copie devono essere **consistenti**: acquisire un punto di vista atomico del catalogo e un set sigillato di pack. Non copiare directory DB attive «a caldo» senza protocollo di snapshot/backup riconosciuto. Riferimenti tra backup e contenuti identificati da hash e ID stabili. Manifest con versione software/schema, origine, dipendenze, time/cutoff, contenuti e checksum.

## Export archivistico `palimora-archive-v1`

- Volumi file **≤ 2 GiB esatti (2.147.483.648 byte)**, ognuno verificabile; esempio `volume-000001.pmarc`. `manifest.json` esterno con struttura dello snapshot, schema, lista volumi, SHA-256, dimensione, chain ID e descrizione oggetti/versioni.
- **Completo:** tutti gli oggetti canonici referenziati e i dati necessari a ricostruire opere e versioni senza il database corrente.
- **Incrementale:** solo oggetti, revisioni, eventi e metadati aggiunti/cambiati dopo un export base, con riferimenti verificabili alla catena precedente. Nessuna dipendenza nascosta da un pack operativo.
- **Reader standalone CLI**: elenca opere, ispeziona manifest, verifica hash, legge capitoli e media, estrae/esporta formati leggibili e ricostruisce progressivamente una catena di export, senza API o database.
- Lettura perpetua dei vecchi export: estensioni compatibili, reader per versioni precedenti e migrazioni in ingresso quando necessarie. Test di round-trip e compatibilità essenziali prima di congelare v1.

Un export non deve includere password, sessioni, bookmark privati, cronologia o annotazioni personali. I dettagli binari del volume sono definiti assieme al canonical pack format prima del primo export reale, con contratto pubblico.

## Restore

- **Piattaforma:** verificare corpus di destinazione; correlare `ExternalIdentity` AO3 e ID stabili, non affidarsi a ID SQL locali. Ripristinare collezioni/progressi/annotazioni solo dove la corrispondenza è certa; report per riferimenti orfani invece di collegamenti sbagliati.
- **Completo:** ripristino assistito con controllo versione schema, checksum, database+blob consistenti, secret material, migrazione controllata e ricostruzione indici OpenSearch. Non necessita di `dumps/`.
- **Export:** re-ingest dal manifest e volumi in una installazione nuova, preservando contenuti e snapshot, senza importare account. Import idempotente per hash e ID originali.
- Un restore distruttivo è riservato all'Owner; preview, verifica del target e conferma esplicita. Export/backup in esecuzione non bloccano indefinitamente la lettura.

## Destinazioni multiple, anche esterne

- `APP_DATA_ROOT` = `/mnt/sdb/palimora-data`; backup di default possibile in `${APP_DATA_ROOT}/backups/`, ma **non** obbligatorio né unico.
- `infra/compose.backups.yaml` opzionale aggiunge bind mounts verso dischi esterni/NAS (es. `/mnt/backupdisk/palimora` → `/backup-targets/disk1`). Nessun Docker named volume; mount directory host non creata automaticamente per errore (`bind.create_host_path: false`).
- La UI propone soltanto le destinazioni realmente montate/autorizzate; percorsi selezionati come **nomi logici** configurati, non path host arbitrari forniti da utenti web.
- **Fail closed in caso di disco smontato:** il worker verifica l'identità del filesystem/mount sottostante (es. UUID/device/`mountinfo` o marker legato al target), writeability e spazio disponibile prima della prima scrittura e periodicamente. L'esistenza della directory host da sola **non dimostra** che il disco sia ancora montato.
- Backup locale e remoto tramite mount dedicato; backup software opzionali e pianificabili, ma **nessuna pianificazione attiva all'installazione**. Cifratura at-rest dell'archivio non obbligatoria; destinazioni remote vanno trattate come sensibili e protette secondo il contesto d'uso.

## Integrità e spazio

- SHA-256 e verifica per file/pack/volume/manifest; scrub programmabile e report anomalie. Ripristino da backup se esiste una copia valida.
- Le compattazioni non devono cancellare oggetti ancora referenziati da snapshot, esportazioni incrementali o backup attivi.
- Soglie di disco configurabili: bloccare scritture quando lo spazio non basta, lasciare lettura disponibile; backup/export possono fallire in modo sicuro senza alterare il corpus.

## Componenti portabili implementati — 2026-11-08

`packages/archive-format` e `packages/archive-cli` implementano il trasporto e
la lettura standalone degli oggetti canonici, senza dipendenze runtime esterne a
Node. Motore PostgreSQL, worker e Backup Manager riusano lo stesso contenitore.

Il writer produce volumi `.pmarc` di byte canonici non compressi, senza header
interno: il manifest associa ogni SHA-256 a tipo, dimensione e segmenti
`{volume,offset,size}`. Un oggetto può attraversare più volumi; il limite fisico
è 2.147.483.648 byte, inclusi tutti i byte del file. I pack operativi v1 restano
invariati. Il catalogo logico è fornito dal chiamante; la libreria non seleziona
le tabelle applicative e non attesta la completezza di un corpus.

`manifest.json` contiene `format`, `origin`, `created_at`, `dependencies`,
`catalog`, `volumes` e `objects`; `manifest.sha256` verifica i byte esatti del
JSON. I volumi vengono riletti e verificati dopo fsync, prima della pubblicazione
atomica del manifest. Un incrementale identifica il manifest precedente con il
suo SHA-256 ed esclude gli oggetti già presenti nella catena. I percorsi delle
basi vengono forniti esplicitamente dal chiamante, mai risolti dal manifest.
I campi JSON aggiuntivi sono ammessi; versioni di formato sconosciute rifiutate.
Il catalogo del corpus è `palimora-corpus-catalog-v1`, descritto sotto; la CLI
conserva anche la lettura dei cataloghi generici degli export precedenti.

Dopo `npm ci`, comandi standalone dalla radice del repository:

```sh
node packages/archive-cli/cli.cjs inspect /backup/base
node packages/archive-cli/cli.cjs verify /backup/base /backup/incremento
node packages/archive-cli/cli.cjs list /backup/base /backup/incremento
node packages/archive-cli/cli.cjs read SHA256 /backup/base /backup/incremento
node packages/archive-cli/cli.cjs import /destinazione /backup/base /backup/incremento
```

`extract` è sinonimo di `import`: produce file nominati con l'hash e un catalogo
JSON identificato dal digest dell'export. È un'importazione standalone, **non**
un re-ingest nel database Palimora. Verifica la catena prima di estrarre, pubblica
ogni oggetto atomicamente senza sovrascrivere file esistenti e permette di
ripetere l'importazione verificando gli oggetti già estratti. `read` emette i
byte dell'oggetto su stdout. Un export interrotto non pubblica il manifest;
il worker riparte dalla cattura sigillata e rigenera i volumi incompleti.
Non riprende a metà di un volume.

`apps/api/src/backup-target.ts` implementa il controllo Linux della destinazione:
percorso senza symlink, device atteso `major:minor`, identità nel file predisposto
dall'operatore `.palimora-backup-target`, mount ID e spazio disponibile. Mantiene
aperta la directory e restituisce un percorso `/proc/self/fd/…` per ancorare le
scritture al filesystem controllato. Un device o marker diverso viene rifiutato
prima di scrivere. Il motore mantiene aperto il descrittore e ripete il controllo
nel workflow reale; la creazione dei file verifica i permessi di scrittura.
UI e Compose usano questi stessi controlli, senza creare mount o marker.

Verifica mirata: `npx tsx --test tests/archive-export.test.ts`, quattro test
passati. Round-trip PackStore → export → nuovo PackStore dopo rimozione dello
store originale, due versioni sintetiche e media; catena incrementale e CLI
standalone; import ripetuto; checksum, traversal/symlink, interruzione e spazio
insufficiente; destinazione con mount/device errato senza scritture. Volumi di
1 KiB per forzare la segmentazione; nessuna prova con 2 GiB effettivamente scritti.
Questa verifica iniziale non copriva PostgreSQL: il ciclo applicativo successivo
è descritto sotto. Produzione e dump originali non modificati.

## Motore backup e restore — 2026-11-08

Il motore `apps/api/src/backup-engine.ts` e il comando operatore
`apps/api/src/backup-command.ts` implementano backup **full** e **platform**.
Il contenitore `palimora-backup-v1` riusa segmentazione, checksum e lettura dei
volumi già implementati, distinguendosi da `palimora-archive-v1`: contiene dati
privati e chiave di cifratura dell'istanza. Non è un export pubblico del corpus.
Il Backup Manager descritto sotto richiama direttamente questo motore.

### Acquisizione consistente

Il motore acquisisce i lock condivisi migrazioni e archivio **prima** di aprire
una transazione PostgreSQL `REPEATABLE READ READ ONLY`. Esporta le tabelle con
cursori e `row_to_json`, mantenendo numeri SQL, bytea, intervalli e tipi temporali
senza conversioni JavaScript distruttive. Il completo include tutte le tabelle,
sequenze, migrazioni, dizionari e metadati compressi, code e upload ancora nel DB.
Copia soltanto i pack referenziati nello stesso snapshot: i media canonici sono
nei pack. Rilegge tutti i locator tramite PackStore e controlla i riferimenti
agli oggetti dei manifest prima di completare la cattura. Non copia la directory
dati PostgreSQL; non consulta ZIP, SQLite o dump originali.

Il lock condiviso conserva le letture e le scritture archivistiche condivise;
compattazione con pubblicazione dei locator, GC e reset attendono la fine della
cattura. Non si mantiene una transazione aperta durante il successivo packing.
La cattura completa viene sigillata con `capture.json`, fsync dei file e delle
directory. File catturati e pack sono suddivisi in chunk da 8 MiB e passati al
writer portabile; dimensione massima dei volumi invariata a 2 GiB. I segreti
cifrati esistenti vengono decifrati per verificare la chiave fornita, senza
scrivere i valori in chiaro nei log.

Il piattaforma include identità, sessioni, credenziali, inviti, preferenze,
audit, biblioteca, ACL, ancore e loro versioni, sottoscrizioni, notifiche,
configurazioni push e controllo AO3. Non include testo, media, tabelle del corpus
o file pack. Un indice separato associa ID opera a ID AO3, snapshot a hash del
manifest e firma senza identità locali, capitoli a chiave sorgente. Le firme
conservano tutte le componenti del manifest: non si riconcilia per titolo o per
semplice somiglianza del testo. Il catalogo di cattura include la chiave AUTH_KEY,
APP_ORIGIN e la configurazione operativa esplicitamente fornita dall'operatore.
Le credenziali del nuovo database sono fornite separatamente al restore.

### Restore e protezioni

`inspect` verifica checksum, versione e checksum delle migrazioni locali; produce
una conferma legata al digest: `RESTORE <sha256-manifest>`. Il restore la richiede
anche sui target vuoti. Il completo accetta soltanto uno schema PostgreSQL vuoto
e una nuova directory storage, oppure il residuo marcato dello stesso restore.
Il piattaforma richiede corpus e schema compatibili, **senza account locali**.
Non esiste una modalità che distrugge utenti, corpus o storage preesistenti:
per sostituire un'istanza si ripristina su un nuovo database/storage e si cambia
la configurazione di deployment dopo la verifica.

Il completo applica le migrazioni fino alla versione catturata, carica i dati e
applica eventuali migrazioni successive nella stessa transazione. Versioni future,
checksum diversi e migrazioni non applicabili falliscono con rollback; non viene
aggirata la protezione della migrazione 020 su corpus popolati. Il piattaforma
richiede la stessa sequenza di migrazioni, senza tentare conversioni speculative.
Il ruolo di restore deve possedere lo schema e le tabelle; non serve superuser.
I trigger applicativi del solo target sono disabilitati transazionalmente durante
la copia e riattivati; FK rimangono abilitate, temporaneamente differite e poi
verificate esplicitamente, insieme ai CHECK e agli indici univoci.

Per il piattaforma: identità locale coerente oppure ID AO3 univoco; snapshot con
manifest/firma identica e corrispondenza non ambigua; capitoli della stessa opera
con chiave sorgente identica. Si aggiornano anche ancore storiche e riferimenti
nelle ricevute offline. Righe irrisolvibili e dipendenze da queste righe non sono
collegate arbitrariamente: il report conserva tabella, motivo e riga originale.
Le copie sorgenti rimangono nel backup. Il report è privato, persistito in
`backup_restores` (migrazione 033) e nel file del restore; stdout mostra solo i
conteggi. Il corpus target non viene modificato dal restore piattaforma.

I valori `pg_snapshot`/XID appartengono al cluster sorgente: le sottoscrizioni
ripartono dalla frontiera transazionale del restore; nel completo le eleggibilità dei sottoscrittori per gli eventi outbox ancora
pendenti vengono materializzate nello stesso snapshot. Il consumatore personale
riusa tali ricevute per gli eventi storici e la frontiera del nuovo cluster per
i nuovi eventi. La data della sottoscrizione impedisce che una rimozione e nuova
iscrizione ereditino eleggibilità passate. Notifiche persistite, consegne push,
stati e aggiornamenti ancora da trasformare in notifiche sono conservati.
Il completo cambia l'epoch della ricerca e accoda la ricostruzione delle
proiezioni; OpenSearch e Redis non sono necessari alla verifica del restore.
Il successivo avvio dei processi ordinari ricostruisce gli indici e le code.

### Ripresa, spazio e destinazioni

ID UUID stabile per il backup, lock di sessione per impedire esecuzioni concorrenti
sullo stesso ID. Un'interruzione **prima** di `capture.json` richiede una nuova
cattura MVCC: il vecchio snapshot non può sopravvivere al processo. La ripetizione
rimuove soltanto la cattura incompleta di quell'operazione. Dopo `capture.json`,
la ripetizione verifica i file catturati e rigenera i volumi senza rileggere DB o
pack sorgenti; la connessione sorgente resta necessaria per coordinare il comando.
Un backup già pubblicato viene verificato e restituito con lo stesso digest.
I volumi incompleti non sono dichiarati validi.

Il restore riprende dai file già estratti e verificati. Caricamento SQL,
migrazioni e ricevuta di completamento sono atomici; interruzione o errore non
pubblicano un database parziale. I pack vengono sigillati prima del commit.
Un retry dopo commit verifica i pack e riconosce la ricevuta, senza ricaricare
utenti o duplicare dati. Dopo successo si eliminano le copie temporanee di dati
e pack, conservando configurazione e report. I residui di restore falliti sono
marcati e riutilizzabili, mai confusi con uno storage ordinario.

Mount/device/marker e spazio sono controllati prima e durante le scritture.
Il target resta ancorato al descrittore aperto; verifica e lettura del backup non
richiedono spazio libero sul disco sorgente. `storageTarget` applica la stessa
protezione a uno storage di restore esterno: `storage` deve essere una directory
figlia diretta del target configurato. Senza `storageTarget`, `storage` è un
percorso locale, con genitore già esistente e senza symlink. Riserva locale di
restore 256 MiB. Per la cattura e il packing serve temporaneamente spazio per
**due copie** dei byte catturati; non è una stima compressa del solo corpus.
ENOSPC o SIGINT/SIGTERM lasciano soltanto uno stato riprendibile o ricatturabile.

### Comando operatore

Da sorgenti: `npm run backup -w @palimora/api -- create /percorso/job.json`;
nell'immagine compilata: `node apps/api/dist/backup-command.js create /percorso/job.json`.
Sono disponibili anche `inspect` e `restore`. `DATABASE_URL` identifica
esplicitamente il database sorgente o target; per `create` servono `AUTH_KEY_FILE`
(o `AUTH_KEY`) e `APP_ORIGIN`. Non stampare il file di configurazione recuperato.
Esempio di file operatore, da compilare con i valori effettivi della macchina:

```json
{
  "id": "e6259f88-015f-43da-8f56-b5f2d068cc71",
  "kind": "full",
  "storage": "/storage",
  "target": {
    "name": "disk1",
    "path": "/backup-targets/disk1",
    "marker": "identita-del-disco-predisposta-dall-operatore",
    "device": "8:17",
    "reserveBytes": 268435456
  },
  "configuration": { "ARCHIVE_ZSTD_LEVEL": "3" }
}
```

Il marker è il contenuto di `.palimora-backup-target`; `device` è il major:minor
atteso del filesystem, verificato nello stesso namespace del processo. Il motore
non crea mount o marker. `inspect` usa target e ID e restituisce la conferma.
Per `restore`, usare il DATABASE_URL del target, cambiare `storage` alla nuova
cartella e aggiungere `confirmation` con il valore restituito da `inspect`.
Configurazione recuperata: `storage/.restore-<digest>/configuration.json`;
report: `storage/.restore-<digest>/report.json`. Impostare la chiave recuperata,
origin/configurazione ed eventuali nuovi percorsi prima di avviare API/worker.
La registrazione passkey resta legata al dominio originario.


## Administration & Integration — 6A.3

`/admin/backups` riunisce operazioni, destinazioni e pianificazioni. Owner e Admin
possono creare copie, verificare integrità, controllare i job e impostare frequenza
(in ore) e numero di copie conservate. Solo l'Owner può avviare restore e scaricare
backup privati; gli export del corpus sono scaricabili anche dall'Admin. L'Utente
non accede alle API. CSRF, sessione e autorizzazione riusano il livello identità;
l'audit registra richieste, download ed esiti, senza credenziali o righe private.

Il dettaglio mostra fase e contatori effettivi, errori operativi, dipendenze,
checksum e file. Download autenticati in streaming con HTTP Range, `no-store`, con nomi ammessi
e descrittori aperti senza seguire symlink. Le risposte dello storico paginato
non includono gli elenchi dei volumi. Nessuna percentuale viene inventata nelle
fasi senza totale noto. Le destinazioni vengono controllate dal worker ogni 15 s;
la UI aggiorna storico e dettaglio ogni 3/2 s e permette l'aggiornamento manuale.

`backup_runs` è l'outbox persistente PostgreSQL; BullMQ `palimora-backup-v1`
esegue i job nel worker ingest esistente. Il lock 70210462 serializza i job anche
con più worker. Un riavvio recupera le operazioni pendenti/in corso; retry con
lo stesso ID riusa checkpoint e ricevute del motore. Pausa per acquisizioni ed
export, cancellazione cooperativa anche per restore; verifica ed eliminazione
non espongono una pausa inesistente. Annullare conserva i residui riprendibili;
«Elimina copia» li rimuove dopo conferma e controllo delle dipendenze.
La pausa prima della cattura sigillata comporta una nuova cattura MVCC alla ripresa.

Non vengono create pianificazioni all'installazione; anche una nuova pianificazione
rimane disabilitata finché l'operatore non seleziona l'abilitazione. Il recupero
non esegue una copia per ogni scadenza persa. La conservazione riguarda soltanto
le copie riuscite di quella pianificazione e preserva basi incrementali e copie
in uso. Un'eliminazione fallita resta nello storico per retry esplicito. Le
pianificazioni catturate in un restore vengono disabilitate e i job attivi messi
in pausa, evitando esecuzioni accidentali sulla nuova macchina.

### Configurazione operatore

`BACKUP_CONFIG_FILE` indica un JSON montato in sola lettura su API e worker:

```json
{
  "destinations": [
    { "name": "disk1", "label": "Disco locale", "path": "/backup-targets/disk1",
      "marker": "identita-disco-locale", "device": "8:17", "reserveBytes": 268435456 },
    { "name": "disk2", "label": "NAS", "path": "/backup-targets/disk2",
      "marker": "identita-nas", "device": "0:55", "reserveBytes": 1073741824 }
  ],
  "restores": [
    { "name": "recovery", "label": "Istanza di recupero",
      "databaseUrlFile": "/run/secrets/recovery-database-url", "storage": "/recovery/storage" }
  ]
}
```

I device dell'esempio devono essere sostituiti con quelli effettivi, letti nel
namespace dei container; predisporre il marker sul filesystem corretto.
`infra/compose.backups.yaml` aggiunge due bind mount, in sola lettura per API e
scrivibili per ingest, tramite `BACKUP_DISK1`, `BACKUP_DISK2` e il file JSON.
Per un diverso numero di dischi adattare l'override e l'elenco `destinations`.
La UI modifica etichetta e abilitazione, mai percorsi, device o mount Docker.
Senza configurazione l'elenco è vuoto e nessun job automatico viene creato.

I target di restore sono anch'essi autorizzati dall'operatore. Montare il file
con l'URL del database su API/ingest e il genitore dello storage di recupero sul
worker. Il database deve essere separato e raggiungibile sulla rete interna;
nessuna porta host è necessaria. Per storage esterno aggiungere `storageTarget`
con lo stesso contratto delle destinazioni: `storage` deve esserne figlia diretta.
I nomi logici vengono restituiti alla UI; URL e percorsi segreti rimangono sul server.

Il wizard controlla il target, riepiloga le conseguenze e richiede di scrivere
RIPRISTINA. La richiesta include il digest verificato, non un flag generico.
Il motore riverifica l'intero backup prima di modificare il target e applica i
vincoli vuoto/completo o corpus compatibile/senza account. Il server rifiuta come
target il database corrente e storage sovrapposti. Il risultato mostra conteggio
e motivi dei riferimenti irrisolvibili; il report integrale privato rimane nel
DB/storage restaurato. Nessuna commutazione automatica della produzione.

### Export del corpus e re-ingest

`archive-export.ts` cattura catalogo pubblico e oggetti canonici nello stesso
snapshot protetto da lock. Le tabelle sono una lista esplicita: provenienza,
identità, metadati, capitoli, selezioni, snapshot e media storici. Credenziali,
biblioteche personali, audit e decisioni amministrative non entrano nell'export.
Il manifest contiene migrazioni e riferimenti SHA-256 a segmenti NDJSON delle
tabelle e a indici delle opere; i payload sono oggetti canonici portabili,
indipendenti dai locator dei pack sorgenti. Il re-ingest ricrea i locator tramite
PackStore e accoda le proiezioni ordinarie del catalogo.

Un incrementale contiene soltanto oggetti/segmenti nuovi rispetto alla catena;
il catalogo dell'ultimo manifest descrive l'intero stato corrente. Dipendenza
esplicita dal digest precedente, basi verificate prima dell'export e protette
dall'eliminazione. `list` nella CLI legge gli indici per mostrare le opere senza
PostgreSQL. La memoria dei payload è limitata ai singoli oggetti/segmenti; gli
indici dei manifest crescono con il numero di oggetti e volumi. Non si dichiara
memoria costante rispetto alla dimensione del catalogo.

Per ricostruire un corpus in Palimora, dopo la build e con DATABASE_URL/ARCHIVE_ROOT
rivolti a un'istanza nuova:

```sh
node apps/api/dist/archive-import-command.js /backup/base /backup/incremento
```

Il comando verifica la catena, richiede catalogo vuoto e migrazioni identiche,
importa conservando ID/hash e versioni, verifica FK e registra una ricevuta
transazionale per digest. Ripeterlo per lo stesso export è idempotente. Non fonde
un export con un corpus già popolato e non importa account. La CLI standalone
`import` continua invece a estrarre file/catalogo senza dipendere dal backend.

### Recupero puntuale dell'integrità — 6B.2

Il pannello Integrità può usare backup completi ed export, incluse le basi degli
incrementali, per recuperare un singolo oggetto verificato. Riusa manifest,
verificatore streaming, configurazione destinazioni e controlli del mount del
Backup Manager. Il recupero Owner pubblica un nuovo pack e un locator validato;
non applica SQL, configurazioni o account della copia all'istanza corrente.
Problemi relazionali continuano a richiedere il restore isolato previsto sopra.

Durante un recupero pendente, in corso o in pausa, la sorgente non può essere
eliminata dalla UI o dalla retention; le dipendenze incrementali restano protette.
Un restore completo sospende i job di integrità in corso e disabilita la
pianificazione importata. I restore piattaforma/completo revocano le sessioni
impersonate importate, conservandone l'audit.

### Verifica del confine dei volumi — 6C

`verify-volume-boundary.cjs` usa il writer e il verificatore standalone con
129 oggetti di fixture, scrivendo realmente **2.147.483.648 byte + 8 byte** in
due volumi. Checksum e dimensioni verificati; memoria limitata al singolo oggetto
(16 MiB) e buffer di streaming, senza allocare un volume da 2 GiB. È una prova
del formato, distinta dai benchmark sul corpus AO3 reale in
[10-performance-report](10-performance-report.md).

La cattura SQL della release 1.0.0 raggruppa le righe in blocchi limitati a 1 MiB
(o una singola riga più grande), mantenendo NDJSON, transazione MVCC e fsync.
L'export verifica mount e spazio prima delle scritture, senza ripetere accessi
filesystem per oggetti già inclusi nella base o righe ancora in memoria.
La cancellazione resta controllata durante la scansione e i manifest vengono
pubblicati soltanto dopo la verifica dei contenuti.

Il restore completo carica fino a 128 righe/1 MiB per istruzione nelle tabelle
transazionali temporanee, passando il JSON originale a PostgreSQL per preservare
bigint e tipi. Riconciliazione piattaforma, validazione FK, controllo dei pack e
pubblicazione finale restano invariati; un'interruzione prima del commit non
espone righe parziali.

### Disaster recovery della release 1.0.0 — 6C

Verifica isolata su uno ZIP AO3 completo: **11.032 opere**, una revisione
controllata aggiuntiva, **11.033 snapshot e 107.057 oggetti**, account di test,
bookmark, progresso e annotazione. Backup completo ripristinato in database e
PackStore distinti, senza dump sorgente: conteggi/fingerprint delle righe
identici e rilettura SHA-256 di tutti gli oggetti. Ripristino piattaforma sul
medesimo corpus compatibile privo di account: dati personali identici, zero
riferimenti irrisolvibili. Interruzioni prima del commit recuperate senza
esporre righe parziali; conferma errata respinta.

Export completo in 17 volumi e incremento in un volume, soglia 64 MiB;
dipendenza dalla base obbligatoria e verificata. La prova del confine 2 GiB
descritta sopra è separata. Corruzione controllata, recupero puntuale, pause,
riavvio, spazio insufficiente e mount indisponibile sono coperti dai percorsi
mirati di integrità e Backup Manager. Tempi, condizioni e limiti in
[10-performance-report](10-performance-report.md#disaster-recovery-sul-corpus-reale).

CLI `verify`/`import`/`list`/`read` eseguita sulla catena reale con tutti i servizi
Palimora spenti e senza variabili database: **107.187 oggetti estratti**, 11.032
opere elencate, lettura confrontata con il file estratto. Nessun PostgreSQL o
backend richiesto per questa estrazione standalone.
