# 09 — Milestone, ordine di implementazione e qualità

## Principio di consegna

**Sei milestone interne, una sola prima release pubblicabile.** Ogni vertical slice comprende modello, logica, endpoint, UI definitiva pertinente, error handling e persistenza; non si fa prima tutta la UI fittizia per «collegarla» dopo. Niente etichette Beta/WIP/coming soon o infinite fasi di polish. La sola funzionalità deliberatamente futura è la sync degli account **personali** AO3 e l'import multipiattaforma.

### Prima del codice (timeboxed, senza un altro giro di interviste)

1. Inserire questa documentazione nel monorepo, scegliere i package/versioni compatibili, consolidare env/mount/network invariants.
2. Definire l'insieme minimo di contratti API/eventi e le versioni di schema; programmare la freeze `pack-v1` prima che l'ingest scriva dati permanenti.
3. Usare campioni rappresentativi degli SQLite/ZIP già disponibili per capire **solo** adapter e struttura sorgenti; non aspettare i file assenti, non scandagliare inutilmente 923 GiB.
4. Avviare subito la milestone 1 e poi la 2; non dedicare settimane a documenti che non cambiano decisioni.

## Milestone 1 — Foundation

**Deliverable:** monorepo, pipeline build, Compose con bind mounts/reti/gateway, migrazioni Postgres, login/sessioni, bootstrap Owner via wizard locale, registrazioni con invito, ruoli e sicurezza, design system e shell di pagine realmente utilizzabili. Admin utenti/inviti completa, nessuna pagina «sezione in costruzione».

**Verifica critica:** impossibile ottenere due Owner iniziali, impossibile creare account senza invito dopo bootstrap, `prod-frontend` solo gateway, nessun `ports`, niente Docker named volume.

## Milestone 2 — Archive Engine + ingest

**Deliverable:** contratto binario/documentato del formato canonico v1; packStore/read/write, SHA-256, dedup, revisioni/snapshot, staging/commit/compaction sicura; inventario ZIP/SQLite, reader/adapters basati sui campioni, ingest parziale con lacune, checkpoint/resume, lista tecnica dell'opera e report batch. Importa realmente i primi ZIP completi nel nostro archivio.

**Verifica critica:** un elemento sorgente mancante/`.part` non arresta il batch, errore strutturale sì; re-ingest non duplica; capitoli leggibili anche smontando `dumps`; ritorno da crash non espone current incompleti.

## Milestone 3 — AO3 Experience

**Deliverable:** catalogo e autori/tag/serie/relazioni AO3, ricerca originale/metadati e full-text capitoli (Postgres + OpenSearch), filtri, version selector, reader Entire Work/classico/immersivo e Work Skins, media locali, statistiche originali/commenti/kudos read-only, download EPUB/HTML/PDF on demand. UI completa su desktop/mobile/tablet.

**Verifica critica:** il lettore restituisce la versione corrente corretta e preserva storiche; ricerca e filtri non inventano dati mancanti; nessun codice HTML/CSS importato può eseguire script o compromettere UI/sicurezza.

## Milestone 4 — AO3 Synchronization

**Deliverable:** monitor stato AO3 auto/override, discovery oraria + cursori, backfill e reconciliation, scheduler adattivo/429, snapshot nuovi, relazioni/serie/tag, commenti/statistiche, recupero/versioni media, watchlist 48h, alert/admin/sync manuali. Quando AO3 non è disponibile, code e biblioteca rimangono operative senza false eliminazioni.

**Verifica critica:** una sola verifica oraria per opera guardata; niente doppie esecuzioni incoerenti; rispettare `Retry-After` e limitazioni; update parziale non sostituisce head validata.

## Milestone 5 — Personal Library

**Deliverable:** bookmark, history/Mark for Later, subscriptions, liste e collezioni ACL condivise, annotazioni, stati/progressi sincronizzati, statistiche personali, visibilità consensuale, notifiche in-app e push, PWA con lettura offline e riconciliazione al ritorno online. La semantica AO3 originale non deve essere duplicata in modelli separati.

**Verifica critica:** un Viewer non modifica una collezione; progresso e annotazioni non si perdono nei cambi di revisione; offline non espone la cache privata dopo cambio account.

## Milestone 6 — Operations & Release

**Deliverable:** dashboard cliccabile e metriche dei soli container Palimora, gestione jobs, impostazioni risorse e manutenzione leggera/totale, audit e impersonazione, scrub/ripristino, backup piattaforma e completo, export storico completo/incrementale volumi max 2 GiB, CLI standalone, backup destinazioni esterne, restore. UX delle nuove pagine definitiva, non refactoring cosmetico di quelle già consegnate.

**Verifica critica:** backup/restore verificabili e consistenti, export legge senza Postgres, dischi esterni smontati non ricevono backup nella directory host sottostante, amministratori senza privilegi Owner non possono inviare inviti o ripristinare tutto.

## Riduzione del tempo senza ridurre la qualità

- **Parallelizzabile dopo milestone 2:** ricerca/reader, sync scheduler e personal library su contratti congelati. Non replicare adattatori parser e merge in team diversi.
- **Priorità durante sviluppo:** Foundation → Archive Engine che sfrutta subito il dump disponibile → reader/catalogo → sync pronta per il ritorno di AO3 → feature personali e operazioni.
- Se la fonte AO3 è down, progettare e implementare sync con interfaccia/queue reale e sorgenti di test controllate; attivare traffico vero solo quando consentito. Non introdurre endpoint di prodotto fittizi.
- Preferire query/indici/IO semplici a una proliferazione di microservizi, adozione di Rust/Go solo dopo profilo dimostrato.

## Strategia di verifica, senza test inflation

**Test mirati obbligatori** (e pochi smoke end-to-end):

1. formato pack/export: round-trip/hash, power-loss staging/commit, lettura vecchie revisioni, segmentazione media grandi;
2. ingest: Zip64/CRC, `.part` e sorgenti mancanti, schema sconosciuto che blocca, retry/restart, re-ingest idempotente, merge e provenienza;
3. sync: rate/`Retry-After`, lease, watchlist di 48h/1h, outage senza false deletions, commit atomico;
4. identità: setup owner atomic, sessioni/ACL/inviti/impersonazione, link e URL esterni sicuri;
5. restore: backup piattaforma e completo, export incrementale e standalone CLI, fail-closed disco esterno assente.

Niente centinaia di test che ricontrollano la stessa UI in varianti cosmetiche. Usare benchmark riproducibili sul corpus reale per p50/p95 di ricerca/lettura, CPU/RAM, throughput ingest e dimensioni dati/indici. Il target sub-secondo di ricerca rimane aspirazionale finché non misurato.

## Definition of done di una milestone

Feature realmente operativa e visuale definitiva, contratti documentati, schema/migrazione valida, dati preservati, errori mostrati e recuperabili, log e audit necessari, verifiche critiche passate. Niente placeholder funzionali né «implementato al 90%» lasciato al passaggio successivo.

## Verifica Foundation — 2026-11-05

Implementati monorepo, immagini/Compose, migrazioni, setup, autenticazione con password/passkey/TOTP/recovery, sessioni, preferenze IT/EN/temi/stili, ruoli, utenti e inviti. Nessun dominio delle milestone 2–6 è simulato. Audit delle operazioni di identità è già persistente; pannello audit e impersonazione rimangono nella milestone 6.

Verifiche eseguite localmente:

- Build TypeScript/Vite e immagini API/web riuscite; `npm audit` senza vulnerabilità segnalate al momento della verifica.
- 15 test contratti/integrazione su PostgreSQL reale: concorrenza bootstrap/inviti, rollback ownership in caso di errore transazionale, CSRF, confini Owner/Admin/User, soft delete e ripristino, reset/revoche, TOTP/recovery anti-replay, challenge WebAuthn invalide, rate limit durevoli, audit append-only, migrazioni e riavvio.
- Uno smoke browser Chromium desktop/mobile: setup Owner, invito, registrazione, preferenze persistenti, registrazione/accesso/rimozione passkey con autenticatore virtuale CTAP2 e svuotamento della cache privata alla revoca durante il refetch della sessione. Verifica visuale su 390 px e desktop. Non sostituisce una certificazione su tutti gli autenticatori fisici.
- Stack Compose completo avviato su reti di verifica separate: PostgreSQL, API, Redis e OpenSearch healthy; HTML e header di sicurezza serviti dal gateway. Confermati ruolo DB non-superuser, soli bind mounts persistenti e nessuna pubblicazione di porte. NPM e servizi preesistenti non modificati; nessuna istanza pubblica o Owner reale creati.

Misura Foundation tramite gateway HTTP interno, Node 22 in Docker, PostgreSQL 17, fixture minima, 200 richieste autenticate a `/api/v1/me`, concorrenza 10: p50 **17,58 ms**, p95 **40,55 ms**, circa **338 richieste/s**, zero errori. Dopo la prova `docker stats` riportava API **46,47 MiB**, PostgreSQL **49,96 MiB**, web **12,43 MiB**, gateway **11,62 MiB**, Redis **5,23 MiB**, OpenSearch **825,2 MiB**. Sono campioni sul presente host condiviso, senza TLS NPM e senza corpus, non SLO né stime per la ricerca. Throughput ingest, latenza reader/search e dimensione degli indici verranno misurati nei rispettivi domini.

Riproduzione: `./scripts/verify.sh` richiede Node, Docker Linux e Chromium Playwright con librerie di sistema. Usa un DB effimero in tmpfs (nessun volume persistente o porta host). `npm test` da solo verifica i contratti e abilita i test DB solo con `TEST_DATABASE_URL`; la procedura completa non salta l'integrazione. Le immagini si costruiscono con il Compose documentato in 02. Per ripetere la misura: `BENCH_ORIGIN`, `BENCH_USERNAME`, `BENCH_PASSWORD` ed eventuale `BENCH_CODE` nell'ambiente, quindi `node scripts/benchmark.mjs`; `BENCH_URL` consente un trasporto interno distinto dall'origin configurato. Usare account e dati di verifica separati.

Review Sicurezza: verificati anche conferma password, aggiunta passkey da dialogo e wizard 2FA su viewport mobile. La suite HTTP copre attivazione differita, scadenza e vincolo di sessione della conferma, hash dei codici pendenti e recovery monouso; lo smoke browser esegue navigazione dalle card alle viste dedicate, Indietro del browser e ricarica del dettaglio, download dei codici, attivazione e disattivazione con recovery. Verifica completa: 15 test contratti/integrazione e uno smoke browser passati; audit npm senza vulnerabilità segnalate.

Review login: 15 test contratti/integrazione e smoke browser passati con TOTP progressivo, componente OTP condiviso, accesso passkey tramite conditional mediation con autenticatore CTAP2 virtuale e recovery nel campo password. Verificati consumo concorrente monouso, rifiuto del replay, account disabilitati/eliminati e audit del metodo di recupero. API di review aggiornata; audit npm senza vulnerabilità segnalate.

## Verifica Archive Engine — 2026-11-06

Milestone 2 implementata: formato v1, Zstandard/SHA-256, dedup globale, revisioni e
snapshot immutabili, catalogo PostgreSQL, adapter ZIP/SQLite/CSV, BullMQ/outbox,
checkpoint e resume, riconciliazione amministrativa, media segmentati, controllo
spazio, compattazione/GC e pannello tecnico. I contratti operativi sono in 03, 04 e
10. Reader, ricerca AO3/full-text e sincronizzazione restano nelle milestone 3–4.

Verifica su database, Redis e storage dedicati sotto `/tmp/palimora-m2-verify`,
senza modificare produzione o dump:

- **ZIP completo reale:** `queue119_archive05.zip`, 228.622.123 byte; tre passaggi
  completi, ognuno con **11.040 membri, 11.032 opere, zero lacune**. Ultimo passaggio
  18 min 20,93 s, media 10,02 record/s sul presente host condiviso, durante build,
  test e campionamento concorrenti. Non è una previsione per tutto il dump.
- **SQLite reali:** riconciliazione degli ID acquisiti con `ao3.sqlite3` (11 record),
  `ao3_deduped.sqlite3` (2) e `ao3_old_files.sqlite3` (2), completata anche con
  l’adapter finale. I percorsi degli indici non coincidevano con il prefisso dello
  ZIP: selezione per identità AO3, senza modificare o copiare i database sorgente.
- **Incrementale:** nuova scansione dello stesso ZIP, zero record rielaborati;
  oggetti, snapshot e acquisizioni rimasti rispettivamente 175.553, 33.098 e 33.111
  nel confronto prima/dopo. La rielaborazione conserva le revisioni precedenti.
- **Campioni:** schemi dei tre SQLite, central directory di 139 ZIP e 417 opere
  distribuite tra inizio/centro/fine; tutte riconosciute. Ricostruiti e verificati
  1.576 capitoli e 1.384 frammenti di note. Letti integralmente i cinque CSV:
  968.750 righe, zero anomalie strutturali. Verificato il contenitore 7z vuoto
  presente nel corpus. Verifica aggiuntiva su otto HTML reali, inclusi documenti
  lunghi: ingest di 831 capitoli e sette note, con ricostruzione byte per byte degli
  otto file. Questo campionamento non certifica ogni membro dei 139 ZIP.
- **Ripresa reale:** SIGTERM/riavvio, sospensione per errore parser e ripresa dal
  checkpoint dopo correzione; perdita delle code Redis di verifica e recupero
  tramite PostgreSQL. Nessun current incompleto; 11.032 opere con head valida.
- **Compattazione reale dall’admin:** 175.570 oggetti riscritti, 107.482 pack
  obsoleti rimossi, 487.361.856 byte recuperati. Verifica successiva di tutti gli
  oggetti in 1.372 pack: hash corretti e nessun oggetto mancante. Catalogo misurato:
  1.392.717.917 byte canonici, 492.149.681 byte nei record pack e 368.001.024 byte
  di indici PostgreSQL Archive/Ingest; outbox interamente consegnata.
- **Indipendenza:** API senza dump; letti 100 manifest correnti, 730 capitoli e 192
  note dai soli pack, verificando hash e ricostruzione HTML. Nessun accesso ai
  sorgenti necessario per consultazione o download.

Misure HTTP dirette all’API, Node 20/PostgreSQL 17, 200 richieste per percorso,
concorrenza 8, ingest e campionamento attivi, senza gateway/TLS: lettura blob p50
**68,05 ms**, p95 **106,28 ms**, 132 richieste/s; ricerca tecnica per ID p50
**16,28 ms**, p95 **30,52 ms**, 450 richieste/s. Zero errori e hash dei download
verificati. La ricerca per ID usa il relativo indice; il filtro testuale riguarda
il titolo. Queste misure non riguardano la futura ricerca full-text. Campione di
memoria durante ingest: Node RSS 156,57 MiB, Python 38,37 MiB; non sono limiti
massimi garantiti. Lettura diretta dei 100 manifest: p95 38,61 ms, RSS 78,22 MiB.

**19 test contratti/integrazione** verificano integrità/corruzione pack, ENOSPC,
rollback e checkpoint atomici, dedup, A→B→A, metadati senza revisioni testuali finte,
ACL/CSRF, parser sconosciuto e ripresa anche con cambio versione, CSV, assenze e
`.part`, EPUB parziale, segmentazione/ricomposizione di media oltre 16 MiB,
riconciliazione, compattazione e lease/GC. Uno smoke Chromium copre Foundation e
admin ingest/storage su desktop e mobile; verifica aggiuntiva sul catalogo reale
per snapshot, oggetti, report completo e download, senza errori JavaScript.
Dipendenze Chromium risolte localmente tramite pacchetti Debian estratti, senza
modificare i servizi esistenti (`LD_LIBRARY_PATH=/tmp/palimora-browser-deps/root/usr/lib/x86_64-linux-gnu`
nella sessione di verifica). Build TypeScript/Vite e immagini API/web, Compose e
`npm audit` verificati; zero vulnerabilità segnalate.

Riproduzione: `./scripts/verify.sh` per build/test/browser; per il corpus,
`python3 scripts/verify-archive-corpus.py ROOT --all-zips --csv` oppure `--zip FILE.zip`.
L’importazione completa si avvia dall’admin selezionando uno ZIP in un ambiente
isolato; il dettaglio permette la riconciliazione con gli SQLite disponibili.
I report contengono checkpoint, fingerprint e associazioni immutabili dei record
al batch: ingest successivi degli stessi indici non alterano i conteggi dei batch
precedenti. Nessun dato o contenuto del corpus viene aggiunto al repository.

### Revisione UI operativa — 2026-11-06

Importazioni, storage e archivio tecnico rilavorati secondo i flussi documentati
in 04/06: selezione esplicita, filtri server, avanzamento e diagnostica per sorgente,
ispettore versioni/componenti, riconciliazione contestuale e manutenzione leggibile.
Verificati build, 19 test contratti/integrazione e lo smoke Chromium esteso con
selezione file, pausa/ripresa, filtro lacune, download report, anteprima HTML
inerte, scelta current/evidenze e accodamento manutenzione. Ispezione visuale
390 px/desktop, tema scuro forest, assenza di overflow della pagina. Fixture e
pack di browser isolati; nessun import automatico nel dev o modifica dei dump.

Profilo delle operazioni amministrative sul catalogo reale di verifica: 11.032
opere, 33.100 snapshot, 175.570 oggetti; 20 campioni dopo due warm-up, connessione
PostgreSQL diretta in transazione read-only, host condiviso. p95 lista opere
155 ms, filtro conflitti 186 ms, dettaglio versioni 5 ms, lista batch 2,4 ms,
storage 90 ms dopo aggregazione senza ordinamenti DISTINCT ripetuti (prima
610 ms). Sono tempi backend locali senza HTTP/TLS, non SLO sul dump completo.

### Profilo e ottimizzazione ingest — 2026-11-06

Il percorso precedente serializzava parser, singole query e circa quattro seal
pack per opera. Sul campione iniziale di 1.000 opere di `queue119_archive05.zip`:
78,18 s, 12,79 opere/s, 4.000 pack; 28,43 s nelle scritture/seal/verifiche pack.
Con commit raggruppati, SQL in blocco, prefetch e singola scansione HTML:
24,43 s, **40,93 opere/s**, 32 pack. Stesso host e limiti, schemi vuoti separati;
la cache dei sorgenti era più calda nelle prove successive.

Importazione completa con BullMQ e consumatore eventi attivi, sorgente originale
montata `:ro`, PostgreSQL/Redis/storage isolati su `/mnt/sdb`: **11.032 opere in
246,73 s di ingest** (247,92 s includendo chiusura worker, **44,50 opere/s**),
checkpoint 11.040, zero lacune. Il batch precedente nel dev registrava 688,23 s;
è un confronto operativo, non una prova simultanea nelle stesse condizioni.
Worker e PostgreSQL limitati ciascuno a 2 CPU/1 GiB; Redis a 0,5 CPU/256 MiB.
Worker: 261,19 secondi CPU; picco cgroup 816,05 MiB, inclusa page cache, distinto
dalla RAM applicativa (campione `docker stats` durante ingest: 200,8 MiB).

Stessi 107.054 oggetti e 11.032 snapshot, pack ridotti da 44.180 a **360**.
Confronto di tutti gli 11.032 result hash con il batch precedente: nessuna
differenza. Riletti e verificati tutti gli oggetti senza montare il dump.
Rielaborazione completa: 11.032 duplicati riconosciuti, zero nuovi oggetti,
snapshot o pack; scansione incrementale successiva con zero record rielaborati
e conteggi invariati. Outbox interamente consegnata. Verificati rollback dopo seal,
vincoli differiti al commit, checkpoint di gruppo, pausa/ripresa e consegna
concorrente dello stesso evento amministrativo. Build, 19 test di integrazione,
smoke Chromium desktop/mobile, Compose e audit npm superati.

Seconda ottimizzazione, verificata con **un solo nuovo import completo** dello
stesso ZIP: COPY e persistenza aggregata del catalogo, metadati per acquisizione,
6 processi parser, scanner HTML con offset originali, segmenti sequenziali,
cache parser, codec N-API a gruppi con contesti riutilizzati e Zstd livello 1,
conferme outbox a gruppi. **11.032 opere in 69,96 s di ingest**, 71,37 s comprese
code/chiusura (**154,58 opere/s**, 3,47× rispetto ai 44,50 precedenti).
Il successivo import manuale dev precedente a queste modifiche era stato di
234,50 s (47,05 opere/s): confronto operativo circa 3,3×. Stesso host condiviso,
cache sorgenti calda; worker senza cap, PostgreSQL del benchmark ancora
2 CPU/1 GiB, con i nuovi parametri cache/WAL. Il dev distribuito ha invece
CPU/memoria senza cap anche su PostgreSQL.

Nuova misura: **2.790 chiamate SQL complessive** (le sole 18 categorie riportate
nel vecchio profilo sommavano 232.766), 51 gruppi, 66 pack, 305.010.785 byte
in pack (+2,8% rispetto al livello 3 precedente). Append+seal/verifica passano
da 53,73 a 12,36 s; CPU worker da 261,19 a **122,14 secondi**. Picco cgroup
1.050,52 MiB inclusa page cache; campione RAM applicativa `docker stats`
314,4 MiB. Memoria superiore al vecchio pool singolo, costo CPU per opera
ridotto di circa il 53%.

Checkpoint 11.040, zero lacune, 22.069/22.069 eventi consegnati. Stessi 107.054
oggetti, 11.032 opere e snapshot; tutti gli 11.032 result hash coincidono.
Rilettura indipendente dai dump: **107.054 oggetti verificati in 14,16 s**.
Migrazione del catalogo popolato in 11,19 s: tutte le 253.012 evidenze mantengono
ID/valori/provenienza, verificati con hash complessivo prima/dopo. Le tre
strutture dei metadati passano da circa 336 a **36,4 MiB**; nel nuovo catalogo
la cache parser aggiunge circa 35 MiB. Lo scanner, su 2.904 documenti di 512
EPUB letti senza import, mantiene frammenti e URL identici al riferimento:
2,26 s contro 4,80 s per quel solo passaggio.

Verifiche mirate aggiuntive: A→B→A nello stesso gruppo conserva tre snapshot;
indici SQLite interrotti riprendono senza ricostruzione e gli indici derivati
corrotti vengono eliminati e ricreati al retry; i dump restano in sola lettura.
La verifica dell’indice usa fixture con schema reale, non una ricostruzione
integrale dei tre SQLite del dump. 19 verifiche di integrazione e browser
superati; nessun secondo import completo o reprocess del ZIP per queste
modifiche. Migrazione dev applicata, health HTTPS regolare, hash degli utenti
e degli snapshot presenti invariati prima/dopo il deploy.

Riproduzione: dopo la build, `node scripts/benchmark-ingest.cjs` con
`TEST_DATABASE_URL` di un database dedicato contenente `_test` nel nome,
`BENCH_STORAGE_ROOT` dedicato e `AO3_DUMP_ROOT` in sola lettura. Crea uno schema
isolato e la relativa directory; `BENCH_SOURCE` sceglie ZIP/SQLite (default
`queue119_archive05.zip`), `BENCH_LIMIT=1000` limita il campione.
`BENCH_QUEUE=1` abilita BullMQ e richiede anche un Redis dedicato tramite
`REDIS_HOST`/`REDIS_PORT`, poiché i nomi delle code sono quelli applicativi.
Il JSON riporta tempi, query aggregate, CPU/memoria cgroup, checkpoint e conteggi.
`BENCH_SCHEMA` riutilizza lo schema prodotto: senza altre opzioni verifica
l’incrementale; `BENCH_REPROCESS=1` rielabora, `BENCH_RESUME=1` riprende l’ultimo
batch interrotto ancora in stato `running`; `BENCH_VERIFY_ONLY=1` verifica tutti
gli oggetti anche senza sorgenti.
Le misure dipendono da dimensioni/formato delle opere, cache e carico dell’host;
non vengono estrapolate linearmente all’intero dump.

### Profilo delle fasi e matrice dei batch — 2026-11-06

L’import manuale dev successivo ha acquisito 11.032 opere in **67,10 s**
(**164,4 opere/s**), senza duplicati/lacune. Non disponeva di span per fase.
Per la diagnosi sono stati eseguiti 21 import isolati dello stesso campione di
**2.048 EPUB**, scelti a intervalli regolari fra gli 11.032 membri originali;
nessun nuovo import completo di `queue119_archive05.zip`. ZIP derivato con nomi,
contenuti e metodo di compressione originali, 36,4 MB di membri decompressi.
Ogni prova parte da catalogo/cache vuoti; stesso filesystem, cache OS calda,
worker e PostgreSQL senza cap, 6 parser salvo confronto esplicito. Il dev non
è stato modificato. Tempi seguenti del motore, senza coda/chiusura BullMQ.

| Limite record/gruppo | Opere/s | Osservazione |
|---|---:|---|
| 64 | 153,5 | 32 gruppi reali |
| 128 | 166,5 | 16 gruppi reali |
| 256 | 174,7 | 9 gruppi, riferimento senza profiler CPU |
| 512 | 173,0–184,0 | Due prove; variazione simile al beneficio |
| 1.024, soglie normali | 179,6 | Gruppi reali da 188 a 443 record |
| 1.024, 64 MiB e 500 ms | 177,9 | Gruppi reali da 113 a 669 record |
| 1.024, 64 MiB e 2 s | 172,8 | Due gruppi reali da 1.024; commit fino a 4,52 s |

Aumentare soltanto il limite record non elimina i limiti byte/tempo. Il gruppo
reale da 1.024 non migliora il throughput e aumenta durata della transazione
ed uso memoria (picco cgroup 436,6 MiB contro 354 MiB nel riferimento).
Con 256 record, 2 parser danno 147,9 opere/s e 10 parser 170,4: aumentare il
pool oltre 6 non mostra un beneficio convincente per l’ingest completo.

Il riferimento richiede 11,73 s. Ripartizione senza doppio conteggio degli span
annidati; la misura SQL comprende round trip e trasporto COPY, non solo CPU PG:

| Fase | Secondi | Quota |
|---|---:|---:|
| SQL, COPY e COMMIT | 3,99 | 34% |
| Lettura/verifica oggetti dallo staging | 1,91 | 16% |
| Pack, codec, verifica e seal | 1,63 | 14% |
| Preparazione residua nel coordinatore | 1,06 | 9% |
| Produttore, avvio e protocollo fuori dai gruppi | 3,14 | 27% |

Fsync e COMMIT insieme pesano circa il 4%. Il profilo CPU separato mostra il
thread principale Node per circa il 70% in attesa; i task nativi e i parser
hanno CPU propria. Il produttore da solo, con staging e serializzazione ma
senza persistenza finale, misura 375,6 opere/s con 2 processi, **641,3 con 6**
e 630,6 con 10. Sono throughput di uno stadio, non import completi.

Esperimenti diagnostici precedenti all’integrazione descritta sotto:

- `default_toast_compression=lz4` riduce SQL da 3,99 a **3,03 s** e COPY da
  1,26 a **0,71 s**; due prove a 186,2–186,7 opere/s contro 174,7. Catalogo
  38,21 MB contro 37,83 MB (+1%). È la compressione TOAST, distinta da WAL LZ4
  e pack Zstd: [parametro PostgreSQL 17](https://www.postgresql.org/docs/17/runtime-config-client.html#GUC-DEFAULT-TOAST-COMPRESSION).
- Lo staging effettua 17.469 letture di oggetti nel campione. Leggere l’intero
  segmento con `readFile` asincrono non porta un guadagno significativo.
  Una prova con letture aggregate sincrone limitate a 8 MiB riduce questo
  stadio da circa 1,9 a 0,62 s: indica costo delle chiamate/attese, ma richiede
  un percorso asincrono aggregato che mantenga reattività a stop/pausa e rinnovo
  dei lock BullMQ prima dell’impiego ordinario.
- La consultazione della cache fa `flush_records(); drain()` prima della
  finestra successiva: barriera fra parsing e commit. Saltare la consultazione
  nel catalogo vuoto misura l’effetto del suo disaccoppiamento; isolatamente il
  guadagno è variabile e la contesa I/O può peggiorare. Occorre un canale cache
  indipendente dagli ack, mantenendo cache e backpressure.
- LZ4 + letture sincrone diagnostiche + assenza della barriera raggiungono
  **242,2–251,1 opere/s** in due prove (211,1–220,2 con code/chiusura).
  Non è una configurazione proposta per il dev.
- Disabilitare la compressione solo della tabella TEMP riduce SQL a 3,54 s,
  senza un guadagno netto sul tempo totale in questa prova.

Con i costi del riferimento invariati, il coordinatore seriale impiega 8,58 s
per 2.048 opere: limite circa 239 opere/s anche con produttore istantaneo.
Per 500/1.000 deve scendere sotto 4,10/2,05 s. Dopo gli interventi precedenti,
la priorità è ridurre conversioni/copie del catalogo e provare 2–4 flussi di
commit con ordinamento per opera, dedup atomica e avanzamento del checkpoint
solo sul prefisso interamente committato. Il lock globale attuale impedisce
questa concorrenza: avviare semplicemente più worker non la introduce.
500 è un obiettivo da validare con questa ristrutturazione; 1.000 supera anche
il produttore misurato e richiede interventi aggiuntivi. Non sono prestazioni
garantite né stime per il corpus completo.

Tutte le 21 prove conservano 2.048 result hash identici e gli stessi 19.507
oggetti/2.048 snapshot. Il caso combinato è stato riletto senza dump.
Profilazione riproducibile con `scripts/benchmark-ingest.cjs`: `BENCH_DETAIL=1`
aggiunge tempi esclusivi, dimensioni dei gruppi e conteggi I/O;
`BENCH_CPU_PROFILE=/percorso/file.cpuprofile` abilita il profiler V8;
`BENCH_GROUP_MIB=16` varia la soglia per i soli benchmark. Il profiler CPU è
escluso dalla tabella dei confronti. `BENCH_CACHE_LOOKUP=0`, insieme alla soglia
esplicita, è soltanto un esperimento su cache miss. I tempi nativi paralleli
non vanno sommati fra loro o agli span che li contengono. I dati server sono
stati raccolti con pg_stat_statements nel solo database di test.

### Prova del percorso nativo HTML — 2026-11-06

Esperimento isolato in `scripts/bench-native/`, prima dell’integrazione delle
ottimizzazioni approvate. Uno scanner C++17 sostituisce il ciclo Python sui
tag, conservando gli offset sul testo originale; per sintassi ambigue torna
al parser corrente. Estrazione EPUB/XML, metadati e decodifica degli attributi
media riutilizzano l’adapter esistente. In questa prova preliminare il runtime dev non era stato modificato.

Sul campione precedente di 2.048 EPUB, mediana di tre ripetizioni alternate:

| Stadio | Attuale | Nativo | Rapporto |
|---|---:|---:|---:|
| Scansione HTML, 6.031 documenti | 3,899 s | 0,408 s | 9,55× |
| Parsing EPUB completo, un processo, oggetti inline | 6,208 s | 3,113 s | 1,99× |
| Produttore con staging, 1 parser | 252 opere/s | 393 opere/s | 1,56× |
| Produttore con staging, 6 parser | 636 opere/s | 857 opere/s | 1,35× |
| Produttore con staging, 10 parser | 652 opere/s | 805 opere/s | 1,24× |

Una coppia di passaggi sullo **ZIP intero**, 11.032 opere e 6 parser, misura
**21,582 → 15,324 s**, ossia **511 → 720 opere/s (+40,8%)**. Tempo CPU
cumulativo del container **77,08 → 47,13 s (−38,9%)**; picco memoria cgroup
761 → 755 MiB, comprensivo della cache. Il campione breve sovrastima il
throughput del corpus completo; 10 parser non migliorano il risultato.

Questi passaggi eseguono il produttore reale con lettura ZIP, CRC/hash,
staging, serializzazione e protocollo cache/ack; risposte cache vuote e ack
immediati escludono catalogo e packfile. Non sono nuovi import completi e
non misurano il throughput end-to-end. I container hanno rete disabilitata,
sorgenti montate read-only e staging temporaneo separato, rimosso a fine prova.

Parità verificata su note, capitoli, offset e URL dei 6.031 documenti reali
e 1.018 casi limite; sul corpus reale il fallback interviene in 4 delle
12.062 scansioni di confronto. Il parsing dei 2.048 EPUB restituisce lo
stesso hash aggregato di metadati e contenuti; tutti i passaggi del produttore
coincidono per record e hash degli oggetti, incluse le 11.032 opere complete.
Il controllo ASan/UBSan passa 300.000 chiamate su input mutati, verificando
anche i limiti degli offset restituiti. La prova non modifica dedup, versioning
o commit: la loro verifica end-to-end resta necessaria dopo l’integrazione.

Riproduzione su Linux con C++17, Python 3.11 e immagine `palimora-dev-ingest`:

```sh
python3 scripts/bench-native/build.py
PALIMORA_NATIVE_SCAN_LIBRARY="$PWD/.local/native-parser/html_scan.so" \
PALIMORA_NATIVE_REPORT="$PWD/.local/native-parser/comparison.json" \
python3 scripts/bench-native/compare.py /mnt/sdb/palimora-ingest-perf/samples/sample2048.zip
python3 scripts/bench-native/run-producers.py
```

Il runner accetta `--source`, `--records`, `--workers`, `--repeat`, `--storage`,
`--image` e `--report` per ripetere una coppia sullo ZIP completo o cambiare
pool. Richiede un percorso di staging di benchmark scrivibile, separato dai
dati applicativi. Build, copia isolata degli adapter e report sono sotto
`.local/native-parser/`, esclusa da Git. Non ricompilare la libreria mentre
una prova la sta usando. Il probe di memoria si compila con:

```sh
c++ -std=c++17 -O1 -g -fsanitize=address,undefined -fno-omit-frame-pointer \
  scripts/bench-native/sanitize.cc -o .local/native-parser/sanitize
.local/native-parser/sanitize
```

Il percorso nativo riduce sensibilmente CPU e costo del parser, ma da solo
non porta a 1.000 opere/s neppure il produttore. La prova ha motivato gli interventi approvati su TOAST, letture aggregate asincrone,
cache/ack disaccoppiati, commit concorrenti ordinati, trasporto interno,
COPY tipizzato e preparazione hash/compressione fuori dalla transazione,
integrati nella sezione successiva. Non si moltiplica questo guadagno per il throughput dell’import attuale:
catalogo e persistenza hanno costi e limiti indipendenti.

### Pipeline ottimizzata integrata — 2026-11-06

Implementati TOAST LZ4, letture aggregate asincrone, risposte cache indipendenti
dagli ack e 1–4 transazioni concorrenti ordinate per opera. Il percorso nativo
HTML è integrato nel build; i segmenti sono condivisi per parser/finestra, ogni
envelope viene serializzato una sola volta, COPY usa colonne tipizzate e i
contenuti sorgente vengono verificati/compressi prima della transazione.
Manifest e metadati derivanti dal merge restano preparati sullo stato canonico
bloccato. Formato archivistico, result hash e versione parser restano invariati.

Due cicli di implementazione/verifica, seguiti da revisione e confronto finale:
il primo benchmark concorrente ha rilevato un deadlock nell’upgrade del lock
sulla sorgente. Il secondo usa `FOR NO KEY UPDATE`, inserimento ordinato dei
locator dopo il seal, ricevute durevoli e checkpoint contiguo. La revisione ha
separato il lease delle identità dal lock archivistico, verificato la pausa via
operazione amministrativa e aggiunto l’interruzione del parser quando un task
asincrono fallisce. Nessun errore può produrre un ack oltre il primo buco.

Sul campione fisso di 2.048 EPUB, cache OS calda e cataloghi vuoti:

| Configurazione | Tempo motore | Opere/s |
|---|---:|---:|
| Riferimento precedente, gruppi 256 | 11,73 s | 174,7 |
| Pipeline concorrente, 2 flussi / gruppi 256 | 6,25 s | 327,6 |
| Pipeline concorrente, 4 flussi / gruppi 256 | 5,16 s | 396,6 |
| Pipeline concorrente, 3 flussi / gruppi 512 | 5,75 s | 356,4 |
| Segmenti condivisi, 4 flussi / gruppi 256 | 4,61 s | 443,9 |
| Segmenti condivisi, 3 flussi / gruppi 256 | 4,91 s | 417,1 |

La configurazione dev mantiene **256 record, 6 parser, 4 flussi, 8 thread
I/O/codec e Zstd 1**. Le letture staging scendono da 17.469 a **94** nel campione;
CPU cumulativa worker da 22,19 a **15,54 s**, memoria cgroup da 354 a **524 MiB**.
Il maggior working set accompagna la concorrenza; include cache del filesystem.
Una prova con quattro isolati Node separati non ha mostrato un vantaggio netto
(4,83 s, CPU 19,80 s e 737 MiB): non è stata integrata. Un profilo V8 separato
attribuisce circa il 61% del tempo campionato ad attività del thread principale,
inclusa la preparazione del catalogo, hash, serializzazione e GC.

**Un solo nuovo import completo** di `queue119_archive05.zip`, su PostgreSQL,
Redis e storage di benchmark separati, con dump read-only:

- **11.032 opere in 28,114 s: 392,4 opere/s**, contro 67,099 s / 164,4 del
  precedente import dev (**2,39×**, durata ridotta del 58,1%).
- **29,750 s / 370,8 opere/s** includendo il ciclo coda/chiusura. Stato
  `completed`, checkpoint 11.040, zero duplicati e zero lacune.
- 107.054 oggetti, 11.032 snapshot, 60 pack referenziati; CPU cumulativa del
  worker 85,85 s e picco cgroup 1,087 GiB. La CPU PostgreSQL è separata.
- Gli 11.032 `(locator, parser, result_hash)` coincidono esattamente con il
  catalogo dev precedente. Tutti i **107.054 oggetti** sono stati riletti e
  verificati senza rendere disponibile lo ZIP sorgente.

Nel campione, una rielaborazione da cache termina in 1,91 s nel motore, con
gli stessi 19.507 oggetti, 2.048 snapshot e 9 pack; l’incrementale successivo
non importa nuovi record. È riuso di contenuti già acquisiti, distinto dalla
velocità di un primo import.

Verificati commit fuori ordine, buco durevole con replay a gruppi diversi,
dedup concorrente, versioning A→B→A, pausa/ripresa, CSV e media grandi. Build,
21 test, browser desktop/mobile con librerie Chromium locali, audit npm e
Compose superati. Il profiler distingue intervalli sovrapposti e quote esclusive
(priorità SQL, pack, preparazione): i tempi delle fasi concorrenti non si sommano
al wall-clock. Script riproducibili `benchmark-ingest.cjs` / `ingest-profiler.cjs`;
report locali in `.local/optimization/`, esclusi da Git.
Distribuito nel solo dev con migrazione `018`: API healthy, frontend HTTP 200,
scanner nativo caricato e limiti CPU/RAM ancora rimossi. Conservati utenti e
catalogo esistente; nessuna modifica ai dump o alla produzione.

Il risultato misurato non raggiunge 1.000 opere/s. I costi residui di preparazione
del catalogo, persistenza e parsing variano con le opere: questi numeri non sono
una previsione lineare per l’intero dump. Non è stata avviata la Milestone 3.

### Payload condivisi e preparazione nativa — 2026-11-06

Integrati i tre interventi: payload JSONB immutabili condivisi per hash nel
catalogo (`019`), compilazione N-API di metadati/manifest e batch asincroni per
result hash/osservazioni, COPY binario con 13 colonne tipizzate riutilizzate.
Le scritture del catalogo usano un unico scambio SQL ordinato. Contratti in 03–04;
nessuna variazione di parser, byte canonici o decisioni di riconciliazione.

Il primo ciclo ha evidenziato il costo di molti COPY separati: sostituiti con
un solo flusso compatto. Il secondo ha eliminato copie dello staging e alberi
JSON superflui per i valori JSONB. Sul campione fisso, il confronto ravvicinato
è **5,153 s → 4,675 s** (397,4 → 438,1 opere/s); gruppi da 512 non migliorano
il risultato. Restano 256 record, 6 parser, 4 flussi, 8 thread e Zstd 1.

Un solo nuovo import completo dello ZIP, su catalogo/storage isolati e dump RO:

| Misura | Pipeline precedente | Tre interventi integrati |
|---|---:|---:|
| Motore, 11.032 opere | 28,114 s / 392,4 opere/s | 27,468 s / 401,6 opere/s |
| Inclusa chiusura coda | 29,750 s / 370,8 opere/s | 29,075 s / 379,4 opere/s |
| Catalogo, indici e TOAST | 193,90 MiB | 179,13 MiB |
| CPU cumulativa worker e parser, escluso PG | 85,85 s | 89,32 s |
| Picco memoria cgroup, inclusa cache filesystem | 1,087 GiB | 1,234 GiB |

Il guadagno sullo ZIP intero è **2,3%**, il catalogo si riduce del **7,6%**;
CPU e picco RAM crescono del **4,0%** e **13,5%**. Questi interventi non
realizzano l’accelerazione drastica auspicata e non avvicinano da soli a 1.000/s.
Le prove sul server condiviso non costituiscono una previsione per 18 milioni
di opere; il campione non va estrapolato al ZIP completo.

Stato `completed`, checkpoint 11.040, zero lacune/duplicati: 107.054 oggetti,
11.032 snapshot, 60 pack e 22.065 payload di catalogo. Tutti i result hash
coincidono con il riferimento. Riletti senza dump tutti gli oggetti, verificando
anche i byte ECMAScript dei 33.096 documenti canonici e i metadati dei manifest.
Rielaborazione del campione: stessi 19.507 oggetti, 2.048 snapshot e 9 pack;
incrementale successivo senza nuovi record.

Migrazione provata su copia delle 11.032 opere: zero differenze in valori,
ID delle evidenze, provenienze, selezioni, snapshot e locator. Superati 23 test,
percorso browser desktop/mobile, audit e Compose; ASan/UBSan sul compilatore
nativo e 2.000 input malformati. Verificati anche microsecondi, interi a 64 bit,
Unicode, JSON null/SQL NULL, reset dev con utenti preservati e resume.
Distribuito nel solo dev con `019`, servizi healthy e live reload conservato;
restano 1 utente e le 11.032 opere preesistenti. Limiti CPU/RAM ancora rimossi.
Report locali `shared-full-final.json`, `shared-full-integrity.json`,
`migration019-verification.json` e `shared-verify.log` in `.local/optimization/`.

### Reset dell’archivio dev — 2026-11-06

Reset completo dall’admin Storage, riservato all’Owner con flag server dev.
Verificati rifiuto fuori dal dev, ACL/CSRF e conferma testuale, blocco delle
mutazioni durante il reset, retry dopo errore tra svuotamento catalogo e pulizia,
conservazione di identità/sessioni e azzeramento dei file. Lo smoke Chromium
esegue il pulsante con PostgreSQL, Redis e worker reali isolati, poi prosegue
le operazioni sull’account nella stessa sessione. Build, 19 test d’integrazione,
smoke desktop/mobile, Compose e audit npm superati. Nessun backup automatico;
procedura e perimetro sono in 02/04/10.

### Catalogo compatto — 2026-11-06

`020` applica hash binari completi, dizionari di provenienza/pack/parser,
associazioni batch→acquisizione, metadati e cache Zstd con dizionari persistenti,
evidenze/selezioni in array tipizzati e proiezione del titolo. Contratto fisico
in 03, ingest in 04. Richiede un archivio vuoto; il test su catalogo popolato
verifica il rifiuto prima di qualsiasi modifica. Non esegue conversioni distruttive.

Il profiling del primo ciclo ha rilevato attese sul training concorrente e
scansioni ripetute delle entry della stessa sorgente. Corretti con training
non bloccante, lookup indicizzati completi e indice/statistiche dello staging.
La rielaborazione del campione mantiene 19.507 oggetti, 2.048 snapshot e 9 pack;
ciascuno dei tre batch (iniziale, ripetuto, incrementale) conserva 2.048 risultati.
L’incrementale non rielabora record. I test coprono anche resume con ricevute
fuori ordine, A→B→A, selezioni amministrative, corruzione e reset con utenti intatti.

Un solo nuovo import completo di `queue119_archive05.zip`, con dump RO e
catalogo/storage isolati, stessa configurazione dev (256 record, 6 parser,
4 flussi, 8 thread, pack Zstd 1):

| Misura | `019` | `020` |
|---|---:|---:|
| Catalogo, indici e TOAST, dopo assestamento | 179,13 MiB | **109,06 MiB** |
| Indici delle tabelle applicative | 51,23 MiB | 33,95 MiB |
| Motore, 11.032 opere | 27,468 s / 401,6 opere/s | 31,193 s / 353,7 opere/s |
| Inclusa chiusura coda | 29,075 s / 379,4 opere/s | 32,823 s / 336,1 opere/s |
| CPU cumulativa worker e parser, escluso PG | 89,32 s | 96,23 s |
| Picco memoria cgroup, inclusa cache filesystem | 1,234 GiB | 1,210 GiB |

Risparmio del catalogo **39,1%**; in questa misura l’ingest impiega **13,6% più
tempo**. Non è un aumento di throughput: compressione e riferimenti condivisi
hanno un costo. WAL, file di servizio PostgreSQL e pack non sono inclusi nel
risparmio del catalogo; la dimensione della data directory non si riduce nella
stessa proporzione. Server condiviso e cache OS calda, nessuna estrapolazione
lineare all’intero dump.

Letture backend locali, senza HTTP/TLS, 100 campioni dopo 3 warm-up sul catalogo
reale; p95 prima→dopo: lista 52,1→57,8 ms, titolo (`love`) 125,6→58,7 ms,
ID AO3 3,0→5,1 ms, dettaglio 2,9→3,9 ms, evidenze/conflitti 1,4→3,4 ms.

Import `completed`, checkpoint 11.040, zero lacune/duplicati: 107.054 oggetti,
11.032 snapshot, 60 pack. Riletti **senza sorgente** tutti gli oggetti, i 33.096
documenti canonici, 22.065 payload compressi/raw e 11.032 cache. Confronto con
`019`: stessi valori dei 22.065 payload e delle 11.032 cache, zero differenze
nei result hash. Build, **24 test**, browser desktop/mobile, audit npm e Compose
superati; C++ verificato anche con `-Wall -Wextra -Werror`.
Report locali in `.local/optimization/`: `compact-full-final.json`,
`compact-full-integrity.json`, `compact-equivalence.json`,
`catalog-latency-{before,after}.json`, `compact-verify.log`, `compact-browser.log`.

Distribuito nel solo dev con `020`: servizi healthy, endpoint pubblico health
`ok`, homepage HTTP 200, live reload e assenza di limiti CPU/RAM conservati.
Il dev resta vuoto (zero opere e oggetti); l’unico utente preesistente è
preservato. I risultati del benchmark rimangono nello storage isolato. Nessuna
modifica alla produzione o ai dump originali, nessun avvio della Milestone 3.

### Verifica e consolidamento pack v1 — 2026-11-06

Audit del dev dopo l’import utente di `queue119_archive05.zip`: 11.032 opere,
107.054 oggetti indicizzati, **61 pack / 290,89 MiB**, sorgente ZIP 218,03 MiB.
Nessun pack vuoto o totalmente orfano. Il file da **389 byte** contiene un
artefatto sorgente valido di 180 byte, referenziato. Le corse iniziali fra writer
hanno lasciato 14 frame non indicizzati (6.231 byte), senza oggetti logici duplicati.

Composizione fisica prima dell’intervento: 223,00 MiB di payload dei componenti
sorgente, 44,51 MiB di payload canonici aggiuntivi (manifest, metadati e
osservazioni), 23,38 MiB di header dei record. L’header di file è soltanto 8 byte:
consolidare pack riduce il numero di file, non l’overhead per oggetto. Le copie
canoniche dei metadati appartengono al contratto v1 e restano preservate.

Correzioni: target sui byte fisici anziché originali, verifica del seal a finestre,
compressione degli asset XML/NCX senza riclassificazione, fallback raw se Zstd
espande il contenuto, controlli completi di locator/tipo/taglia e letture aggregate.
La compattazione precedente sigillava ogni pagina di 128 oggetti: ora accumula
fra pagine, legge e scrive in streaming, aggiorna i locator in blocco e committa
il checkpoint insieme ai locator. Copia/verifica sotto lock condiviso, esclusivo
soltanto per pubblicare; un lettore concorrente è verificato dal test. Contratto e limiti in 03. Il report admin
specifica «Byte dei pack rimossi»: è spazio lordo, non risparmio netto.

Confronto mirato su tutti i 107.054 oggetti già importati, output isolati, Zstd 1,
lettura/verifica originali + riscrittura + seal verificato; un passaggio per target,
cache filesystem calda, server condiviso. Nessun nuovo ingest completo necessario:

| Target fisico | Pack prodotti | Tempo | Picco RSS del processo |
|---|---:|---:|---:|
| 32 MiB | 9 | 15,63 s | 371,6 MiB |
| **64 MiB** | **5** | **15,29 s** | **365,5 MiB** |
| 128 MiB | 3 | 16,06 s | 361,5 MiB |

Scelti **64 MiB**, compromesso fra numero di file e dimensione del gruppo
da pubblicare; la piccola differenza temporale non dimostra una superiorità universale.
La RAM della verifica resta limitata indipendentemente dal target. Campione di
3.343 oggetti, 17,11 MiB originali, esclusi oggetti oltre 1 MiB: Zstd 1/3/6 produce
7,65/7,41/7,16 MiB in 169/214/475 ms di codec. Restano livello 1 nel dev e default
3 generale; non viene sacrificato alcun byte per ridurre la taglia.

Compattazione eseguita dal worker dev: **5 pack / 285,48 MiB**, minimo **34,19 MiB**;
risparmio netto **5,41 MiB (1,86%)**, 61 file precedenti rimossi. Tutti gli hash,
le taglie originali, i tipi, le opere, gli snapshot e le acquisizioni coincidono
con lo stato precedente; utenti preservati. Zero frame duplicati o non indicizzati
nei pack risultanti. Ricostruiti tutti i 107.054 locator e riletti tutti gli
oggetti da un processo nuovo; 256 letture casuali locali, p95 **0,47 ms**.
Dopo riavvio dei servizi, ripetuta la verifica integrale: p95 casuale **0,60 ms**.
Cache calda, esclusi API/DB/TLS. Verificata anche lettura opera/snapshot dall’API dev.

Rielaborazione reale del medesimo ZIP su catalogo isolato preesistente: 11.032
duplicati riconosciuti, zero nuovi oggetti, snapshot o pack. SIGKILL dopo seal ma
prima del commit: catalogo/checkpoint invariati, unico pack orfano recuperato.
SIGKILL durante compattazione dopo checkpoint a 23.635 oggetti: processo nuovo
riprende e termina a 107.054, cinque pack, stesso digest del catalogo.
Superati sei test mirati su pack, transazioni, worker e pipeline, build API e
validazione Compose. Dump e produzione invariati; nessuna migrazione di formato.

Il commit continua a sigillare il proprio residuo: artefatti isolati e nuovi
piccoli import possono ancora produrre pack piccoli validi. La compattazione è
esplicita dall’admin, non una riscrittura automatica dell’intero archivio dopo
ogni batch. Non sono state misurate milioni di opere: i limiti di memoria e i
checkpoint sono verificati, non vengono promessi throughput o latenze a quella scala.
Report locali in `.local/pack-audit/` (`before.json`, `after.json`, `target*.json`,
`compression.json`, `crash.json`, `compact-resume.json`, `dev-integrity.json`,
`dev-after-restart-integrity.json`, `tests.log`, `final-lock-tests.log`); reingest in `.local/optimization/pack-reprocess.json`.

## AO3 Experience — completata, 2026-11-06

**Milestone 3 chiusa il 2026-11-07**, incluse le revisioni UI/UX e la
composizione PDF documentate sotto. Ulteriori confronti fra motori PDF sono
ottimizzazioni separate; la Milestone 4 non è avviata.

Implementati catalogo, navigazione per fandom/tassonomia e pagine bibliografiche,
ricerca AO3 e full-text OpenSearch, reader current/storico/Entire Work/immersivo,
Work Skins e media locali, interazioni originali di sola lettura e download
HTML/EPUB/PDF. Nessuna acquisizione/sync AO3 o funzione personale delle milestone
successive è stata anticipata.

| Dominio | Comportamento implementato |
|---|---|
| Ricerca | Query booleane/frasi/wildcard/campi, include/exclude, filtri numerici/date/lingua/stato, ordinamenti AO3 e serie, stemming, faceting, PIT oltre 10.000 risultati |
| Tassonomia | Tag canonici, sinonimi, metatag e parent; ricerca e conteggi condividono la chiusura; categorie mancanti restano sconosciute |
| Bibliografia | Autori e pseudonimi sorgente, profili, serie ordinate, collezioni e gerarchie, relazioni fra opere e link locali/AO3 |
| Interazioni | Statistiche note, kudos nominativi/guest, commenti radice/risposte/cancellazioni e versione storica; nessuna interazione locale |
| Lettura e media | Capitoli/Entire Work, versioni, lettura immersiva e aspetto; CSS isolato, immagini/SVG/audio/video/font/tracce/allegati, segmenti e HTTP Range |
| Download | HTML/EPUB con asset in streaming, EPUB con indice e metadati, PDF tipografico nativo con fallback Chromium isolato |

Riferimento: [OTW Archive, commit 452391b](https://github.com/otwcode/otwarchive/tree/452391b648f2fb06b55c36133812449747634504),
`work_search_form.rb`, `work_query.rb`, `taggable_query.rb`, `search_range.rb`,
`work_indexer.rb`, `work.rb`, `tag.rb`, `work_skin.rb`, `fandom_crossover.rb` e
frontespizio dei download. Implementazione nuova, senza riuso di codice GPL.
Contratti e gestione dell'assenza di metadati in 03/10; resa e isolamento in 06.

Verifiche: build TypeScript/Vite e immagini Docker; 28 test backend/contratti con
PostgreSQL e OpenSearch reali, seguiti dai controlli mirati delle modifiche finali;
due smoke Chromium, inclusi bootstrap/ACL esistenti, ricerca su dati importati,
cambio versione, Range 206/416, download HTML/EPUB autenticati e isolamento CSS/JS.
Audit npm senza vulnerabilità segnalate; Compose valido. I casi strutturati di
wrangling/commenti/kudos/media passano attraverso ingest e pack canonici, senza
mock del motore di ricerca. Verificati anche HTML, XML EPUB e PDF di un'opera del
corpus via HTTP autenticato. Schermate reali controllate a 1440, 768 e 390 px.

Misura su copia isolata delle **11.032 opere realmente importate**, senza mount
dei dump. **552 pagine** percorse senza duplicati o troncamenti. OpenSearch 2.19.4,
heap 1 GiB, container 2 CPU/3 GiB; host condiviso, cache calda. Cento richieste per
misura, mix ricerca metadati/full-text/filtri/ordinamento; lettura Entire Work.

| Percorso | p50 | p95 |
|---|---:|---:|
| Ricerca backend, sequenziale | 71 ms | 112 ms |
| Lettura backend, sequenziale | 33 ms | 79 ms |
| Ricerca backend, concorrenza 10 | 310 ms | 514 ms |
| Ricerca HTTP autenticata, concorrenza 10 | 245 ms | 580 ms |

Indice circa **1,04 GiB**; RSS rilevata nel processo della prova circa **254 MiB**,
OpenSearch circa **2,33 GiB** dopo il carico. Le prove iniziali hanno rilevato
pressione memoria: il controllo generazione ora usa doc values, evitando di
decomprimere il testo completo per ogni risultato. Questi numeri includono
PostgreSQL/OpenSearch locali; HTTP attraversa il proxy locale di verifica,
senza NPM/TLS. Sono misure del presente corpus, non garanzie a milioni di opere.

Log e artefatti locali in `.local/m3/`: `verify.log`, `targeted-final.log`,
`series-test.log`, `browser-verify.log`, `benchmark.log`, `downloads.log`,
`docker-build.log`, screenshot e download reali. I documenti canonici e le
versioni preesistenti non vengono riscritti dalle proiezioni.

Integrata anche nel dev: **11.032 opere** indicizzate, code current/storico/testo
vuote; verificati ricerca full-text, paginazione, lettura e pagina autore dopo
il riavvio. PDF generato nel container con filesystem in sola lettura. I cinque
pack canonici hanno SHA-256 invariati; preservati l'account esistente e tutti
gli 11.032 snapshot. Aggiornati soltanto i servizi Palimora. Evidenze in
`dev-validate.log`, `container-pdf-final.log`, `dev-packs-before.json` e
`dev-after.log` nella medesima directory locale.

### Revisione UI/UX — 2026-11-07

Catalogo e lettore rivisti secondo [06](06-frontend-ux.md#revisione-di-consultazione--2026-11-07):
navigazione bibliografica separata dall'admin, ricerca e filtri compatti, dettagli
espandibili, lettura continua e concentrazione, download con scelta esplicita del
formato. Risolto il conflitto fra tema scuro e sfondo bianco delle Work Skins,
verificato sull'opera AO3 **85167866** con la skin attiva.

Build TypeScript/Vite e Docker, test mirato di sanitizzazione e smoke browser
esistenti superati. Controllati catalogo, ricerca combinata metadati/full-text,
ordinamento, bibliografia, reader, Escape e download reale su copia isolata del
corpus di 11.032 opere; schermate a 1440, 768 e 390 px e temi chiaro/scuro.
Integrata nel dev; verificato il reader dell'opera segnalata dopo il riavvio.
Nessuna migrazione dati o modifica ai pack. Evidenze in `.local/ui/`.

Filtri successivamente resi guidati: suggerimenti reali per categoria, selezioni
include/exclude, intervalli minimo/massimo e stato delle modifiche da applicare.
Esteso lo smoke esistente con selezione da tastiera, esclusione, rimozione,
intervallo e azzeramento; superati build web e due smoke browser. Verifica visiva
su copia del corpus reale in `.local/filters/`, senza modifiche alle API o ai dati.

Uniformati i selettori tag/lingua mediante un componente condiviso, inclusi
conteggi, tastiera/touch e apertura dei suggerimenti nello spazio disponibile.
`catalogBrowse` esteso alle lingue realmente acquisite: sul corpus di verifica
sono 36, consultabili anche oltre le prime faccette. Allineate esplorazione,
filtri rapidi, conteggi localizzati, paginazione da link diretto e ritorno dal
reader ai risultati filtrati. Build e smoke esistenti aggiornati; controllati
anche navigazione, cambio aspetto e selezione/rimozione lingua su dati reali.
Evidenze in `.local/consistency/`; nessuna migrazione o acquisizione AO3.

Il filtro lingua supporta ora selezioni multiple in OR, con chip indipendenti,
URL ripristinabile e compatibilità con i link a lingua singola. Verificati nel
test di integrazione esistente nomi/codici, duplicati, metadati assenti e
combinazione con altri criteri; nello smoke selezione, ricarica e rimozione.
Evidenze in `.local/languages/`.

### Composizione PDF — 2026-11-07

Impaginazione da libro e percorso nativo descritti in [06](06-frontend-ux.md#pdf-da-lettura)
e [10](10-contratti.md). La lentezza principale era composizione/stampa nel browser,
non lettura dai pack. Confronto sullo stesso host e corpus, prima generazione
senza cache: opera da **316.297 parole**, **9,73 s → 4,94 s**; opera da **23.650
parole**, **1,07 s → 0,84 s**. HTML/EPUB della prima: circa **0,34 s**.

Prova aggiuntiva con tutto il testo lungo raccolto in memoria in **un solo
capitolo**, senza cambiare i dati canonici: vecchio renderer **9,74–9,96 s**,
nuovo **5,37–5,67 s**. RSS aggregato dei processi circa **1731 → 1132 MiB**
(non PSS). Questi sono campioni locali, non garanzie di latenza; skin complesse
usano ancora Chromium. La cache separata restituisce i campioni in **6–12 ms**.
Con limite effettivo di **2 CPU/1536 MiB**, il documento lungo è stato
completato in **6,04 s**, picco cgroup **1239 MiB**, senza swap.

Verificati visivamente frontespizio, indice e prosa; confronto integrale di
**1.377.528 caratteri alfanumerici** fra testo canonico e PDF lungo identico,
escludendo frontespizio/indice/folii e normalizzando Unicode. Test mirati su
rimandi reali, Unicode, media locali, isolamento, cache e scelta del renderer;
integrazione canonica HTML/EPUB/PDF nello smoke archivistico esistente.
Dopo il deploy nel dev: API healthy, esportazioni reali **1,05 s / 5,75 s**
(opera media/lunga), cache **7–14 ms**; verificato anche il fallback su layout
CSS applicato in memoria. Evidenze locali in `.local/pdf/`. Nessuna migrazione
o modifica dei pack.

### Milestone 4 — integrazione AO3, 2026-11-07

Implementati discovery/backfill a checkpoint, scheduler persistente BullMQ/PostgreSQL,
watchlist oraria, acquisizioni canoniche atomiche, profili/tag/serie, interazioni,
account tecnico cifrato, media in streaming/versionati e upload manuale, controlli
amministrativi e recupero dopo indisponibilità. Contratto operativo e restrizioni
in [05](05-sincronizzazione.md#implementazione-operativa--2026-11-07).

Verifiche locali mirate con PostgreSQL isolato e sorgenti HTTP controllate:
maintenance HTTP 200, cooldown/override, dedup discovery, modifiche silenziose,
A→B→A, rifiuto acquisizioni incomplete, orologio watchlist, login/revoca account,
SSRF, media segmentati/CSS, localizzazione offline, interruzione di stream e
ripresa dei thread profondi dei commenti. Dispatcher verificato con Redis reale.
Smoke browser desktop/mobile su API reale per controllo modalità, accodamento e
pausa e upload; artefatti locali in `.local/m4/`. Nessuna acquisizione ufficiale attestata.

**Limite operativo esterno:** il riferimento upstream vieta mediante robots le
query dell'indice usate dalla discovery. La policy effettiva viene controllata a
runtime e, se conferma il divieto, il lavoro resta sospeso con errore esplicito.
Non si dichiara verificata né completata una scansione remota vietata o non eseguita.
Nessuna implementazione della Milestone 5, nessuna modifica ai dump originali.

### Rework pannello AO3 — 2026-11-07

Navigazione in cinque sezioni, controlli disponibilità espliciti, coda con stato
eseguibile derivato dalla policy e recupero guidato dei soli media mancanti.
Verifica mirata: nessun tentativo durante manutenzione neppure con Online forzato;
scadenze sospese senza ETA, elenco 404/410 distinto dagli errori temporanei.
Smoke browser con API/PostgreSQL reali: cambio modalità persistente, pausa lavoro,
selezione media e upload, layout desktop/mobile e tema scuro.
