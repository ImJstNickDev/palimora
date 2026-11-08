# 10 — Contratti tra moduli, stati e invarianti

Questa specifica definisce **comportamenti obbligatori**, non un OpenAPI generato artificialmente prima dell'implementazione. I DTO concreti, schema SQL finale e codifica binaria v1 devono risultare coerenti e versionati durante le prime due milestone.

## API pubblica dei client ufficiali

- Namespace `/api/v1`, REST JSON, autenticazione per cookie/sessione web e meccanismo sicuro di token/sessione per futuri client ufficiali. `OpenAPI` generato dal codice, SDK TypeScript generato/derivato dal contratto, autorizzazione server-side.
- Aree funzionali: `/auth`, `/invites`, `/me`, `/works`, `/chapters`, `/tags`, `/authors`, `/series`, `/search`, `/library`, `/collections`, `/bookmarks`, `/reading-progress`, `/annotations`, `/notifications`, `/downloads`, `/admin/*`.
- Filtri e paginazione cursor-based su grandi insiemi, ordinamento stabile; URL pagina di opera basata su identificatore stabile locale, riferimenti originali AO3 preservati separatamente. Endpoint lettura storica seleziona `snapshot_id` esplicito.
- Operazioni di scrittura con `Idempotency-Key` (o vincoli equivalenti) dove retry lato client/workers è plausibile. Errori tipizzati, non stringhe libere per pilotare UI.
- SSE preferiti per feed di stato ingest/sync e notifiche: gli eventi devono avere ID riprendibile; UI non deve dipendere da WebSocket per mostrare dati fondamentali.
- Le API sono implementate **per client Palimora**, non una API pubblica da stabilizzare per terzi nella v1. Contratti interni non sono una promessa di compatibilità per plugin esterni.

## Envelope ingest eseguibile

NDJSON `palimora.ingest.v1`: ogni record contiene `schema`, `parser`, `cursor` e
`locator`. Il worker associa sorgente e fingerprint dall’inventario; conferma il
record o il gruppo solo dopo la persistenza. `checkpoint_detail.row` aggiunge il cursore interno
per i CSV. La riga contiene una delle seguenti forme:

- `record`: `external_id` nullable, `metadata` originali, `chapters`, `objects`,
  `state`, `observed_at` nullable; opzionali `source_entry`, `source_hash`,
  `media_urls`, `issues`, `document` per il layout HTML reversibile.
- `record.objects` (e `artifacts`): descrittori `{name,kind,path,size,hash}` nello staging locale; hash e
  confinamento del path vengono verificati prima del commit. L’adapter senza
  staging usa `data` base64 per le verifiche isolate.
- `total`, `tag`, `artifacts` o `skip`: inventario, evidenza tassonomica, artefatti
  tecnici o avanzamento su un membro senza contenuto bibliografico.
- `gap` con dettaglio recuperabile, `blocked` con codice/traceback strutturale,
  oppure `io_error` con errno per la policy I/O del worker.

Trasporto raggruppato `palimora.ingest.group.v1`: `{schema, parser, records}`,
con 1–1024 envelope `palimora.ingest.v1` omogenei (`record` oppure `tag`),
nello stesso ordine sorgente. I gruppi di opere possono committare fuori ordine;
`ingest_progress` conserva per record il predecessore, cursore/row e contatori.
L’aggiornamento della sorgente usa `FOR NO KEY UPDATE`, compatibile con i vincoli
FK delle altre transazioni, e consuma soltanto la catena contigua di ricevute.
Ack FIFO dopo commit, nessun ack oltre un errore. Massimo concorrenza+1 gruppi
in anticipo; i segmenti condivisi restano disponibili fino all’ultimo utilizzatore.
Controlli, tag, lacune e artefatti attendono lo scaricamento della pipeline.
Un errore asincrono interrompe anche un produttore fermo in attesa dell’ack.
La cache usa risposte su FD 3 quando `PALIMORA_CACHE_FD` è impostato; senza tale
canale resta disponibile il protocollo seriale. Questa ottimizzazione non cambia
result hash, versione del parser, byte canonici o identità delle acquisizioni.

Date e identità mancanti restano nulle; nessuna cronologia viene inferita dal nome
ZIP. Source record, result hash, associazione al batch e checkpoint sono registrati
insieme. Il trasporto binario verso lo staging è interno e transazionale;
condivide valori dei metadati, senza fondere identità o provenienze. Il formato fisico `020` usa riferimenti compatti e valori compressi; il livello
catalogo li decodifica mantenendo contratti API, ID delle evidenze e valori
originali. La migrazione richiede un archivio vuoto, senza cancellare dati
automaticamente; utenti e sessioni sono esclusi dal suo perimetro.
Contratto canonico e oggetti/layout sono definiti in 03.

## Macchina a stati

| Entità | Stati significativi |
|---|---|
| Istanza | `uninitialized`, `initializing`, `active` |
| Ingest batch | `pending`, `scanning`, `running`, `parser_blocked`, `paused`, `completed`, `completed_with_gaps`, `failed_global` |
| Sorgente | `discovered`, `valid`, `incomplete_transfer`, `missing_source`, `corrupt_source`, `parser_unsupported`, `ingested`, `retry_pending` |
| Contenuto opera | `metadata_only`, `partial`, `valid`; `current` è sempre uno snapshot validato, non uno stato di sorgente |
| Availability AO3 | `available`, `deleted`, `hidden_or_restricted`, `temporarily_unavailable`, `unknown` |
| Sync runtime | `running`, `backoff`, `offline_auto`, `offline_forced`, `paused_admin` |
| Maintenance | `normal`, `maintenance_light`, `maintenance_full` |
| Backup/export/restore | `pending`, `running`, `pause_requested`, `paused`, `cancel_requested`, `cancelled`, `completed`, `failed`, `deleted` |

Non mescolare «assenza da dump», «assenza da AO3», «mancanza di dati su kudos» ed «errore temporaneo»: sono fatti differenti.

## Eventi durevoli e idempotenza

- Eventi esemplificativi: `work.snapshot.published`, `work.availability.changed`, `media.revision.acquired`, `ingest.source.completed`, `ingest.parser.blocked`, `sync.batch.completed`, `archive.object.verified`, `backup.completed`, `notification.created`.
- Produttore scrive **DB + outbox in una transazione**. Un dispatcher porta eventi a Redis/BullMQ e ad eventuali subscriber; delivery può essere almeno una volta, consumatori idempotenti, replay senza effetti duplicati.
- Concorrenza: ordinamento per identità/provenienza nel produttore e lock logici DB durante merge+publish; pack e transazioni di opere indipendenti possono procedere in parallelo. Il lease delle identità (70210405) è distinto dal lock archivistico (70210402): la riconciliazione li acquisisce in questo ordine, la pausa acquisisce solo il secondo. Il leader del tick rimane unico; checkpoint solo sul prefisso committato. La compattazione acquisisce 70210407 prima di 70210402 condiviso; soltanto la pubblicazione aggiorna il lock archivistico a esclusivo (03).
- Quando un job è già in corso, non creare un nuovo current o una seconda notifica per lo stesso evento/versione; per sync in arrivo si può mantenere un solo follow-up consolidato.

## Invarianti cross-cutting

1. **Durabilità:** reader non vede pack/staging incompleti; lettura di snapshot storico produce sempre gli stessi byte canonici.
2. **Autonomia:** lettura, ricerca e export non accedono mai a `/dumps/ao3_stories` dopo l'import; reparse richiede sorgente di nuovo, ma non modifica il servizio corrente finché non validato.
3. **Sorgenti parziali:** missing/.part/CRC ⇒ lacuna registrata senza crash del batch; schema sconosciuto ⇒ `parser_blocked` con resume dopo fix.
4. **Versioni:** nessuna acquisizione incompleta sostituisce `current`; dedup per hash non elimina eventi/snapshot storici distinti.
5. **Rate control:** le risposte AO3 `429/503` provocano pause e backoff, mai bypass tramite rotazione identità; health site indipendente dal singolo work.
6. **Watchlist:** apertura rinfresca TTL 48h ma non causa fetch; per opera ≤ 1 richiesta periodica/ora soggetta a budget ed effettiva disponibilità AO3.
7. **Account:** Owner unico creato prima dell'accesso pubblico; dopo setup registrazione via invito; user soft deleted non può autenticarsi; audit per impersonazione e azioni critiche.
8. **Security:** HTML/CSS importati non possono fare XSS, CSS escape o fetch proibite; media downloader SSRF-safe; login e storage privati accessibili solo agli account autorizzati.
9. **Reti:** nessuna porta host; solo gateway su `prod-frontend`; dump `:ro`; backup esterni verificati prima di scrivere.
10. **Recovery:** backup e export hanno manifest e checksum, possono essere ricostruiti senza dipendere dalla disponibilità della Storage Box.

## Riferimento upstream

Il repository ufficiale [OTW Archive](https://github.com/otwcode/otwarchive) è il riferimento dei comportamenti AO3, non una dipendenza a runtime. Mantenere una matrice delle funzionalità originali realmente replicate ed eventualmente estese, **non un secondo insieme di regole parallele**. L'eventuale copia di sorgente richiede verifica licenza GPL-2.0-or-later.

## Contratti eseguibili Foundation

`packages/contracts/src/index.ts` è l'unica definizione di metodo, path, accesso, input/output ed errori delle operazioni implementate. Il backend monta queste route e valida entrambe le direzioni; `apps/web/src/api.ts` deriva input/output TypeScript dallo stesso registro. `GET /api/v1/openapi.json` genera OpenAPI 3.1 da questi schemi, senza una copia manuale divergente. Errori: `{code, requestId}`; i client traducono il codice, non il testo del server. I campi aggiuntivi delle risposte DB, inclusi hash e segreti, sono esclusi dagli schemi di output.

Endpoint attuali: `/auth/status`, `/auth/setup`, `/auth/login`, `/auth/logout`, `/auth/register`, `/auth/invite`, `/auth/passkey/*`, `/me`, `/me/password`, `/me/sessions/*`, `/me/totp/*`, `/me/recovery`, `/me/passkeys/*`, `/admin/users` e relative azioni, `/invites`. Le liste utenti/inviti usano cursore UUID stabile e pagine di 50 elementi; gli stati eliminato/disabilitato e gli inviti revocati restano consultabili. Setup e consumo inviti sono protetti da lock/vincoli; creazione inviti deduplicata tramite `requestId`. Il contratto pack v1 è definito in 03; gli endpoint Archive Engine sono nello stesso registro eseguibile.

### Conferma TOTP

Il client usa in sequenza `totpStart` (password → QR/chiave), `totpVerify` (sei cifre → codici di backup), `totpEnable` (`backupCodesSaved: true` → attivazione). Verificare il codice non attiva ancora la 2FA. Le configurazioni pendenti sono legate alla sessione, monouso e scadono dopo cinque minuti; una nuova configurazione invalida la conferma precedente nella stessa sessione. La migrazione `002_totp_confirmation.sql` estende i tipi di challenge, preservando quelli esistenti. Client e API devono essere aggiornati insieme per questo cambiamento del flusso Foundation.

### Login progressivo e recovery

Il login accetta il riutilizzo dei TOTP ancora validi. I fallimenti sono limitati a quattro in 60 secondi per IP e username, senza contare successi, `SECOND_FACTOR_REQUIRED` o logout. Un 429 `RATE_LIMITED` espone `Retry-After` in secondi; il client mostra l’attesa effettiva. Dettagli delle quote in [07](07-identita-admin.md#contratto-operativo-foundation).

`POST /auth/login` mantiene `{username, password, code?}`. `SECOND_FACTOR_REQUIRED` viene emesso solo dopo password corretta se TOTP è attivo; il client invia quindi le stesse credenziali con il codice a sei cifre. Il campo `password` accetta in alternativa un recovery code monouso: con codice valido non serve `code`. Errori per account inesistente, disabilitato, eliminato, password errata o recovery non valido restano `CREDENTIALS_INVALID`. Le operazioni di sicurezza autenticate continuano a richiedere la password reale. Le route WebAuthn mantengono il contratto precedente, compatibile con conditional mediation.

## Contratti Archive Engine

Operazioni amministrative versionate nello stesso registro Zod: inventario, batch,
report/diagnostica, controllo pausa/resume, opere/snapshot/oggetti, decisioni di
riconciliazione, storage/job. `requestId` deduplica creazioni e decisioni; paginazione
UUID/ID durevole per liste ed evidenze. Il download blob è `application/octet-stream`
con attachment e autenticazione admin, distinto dalle risposte JSON di ispezione
(`kind`, `size`, `base64` opzionale, `truncated`; anteprima massima 64 KiB).

Le liste batch usano ordine `(created_at DESC, id DESC)` e filtri server
`all/active/attention/finished`; ogni riga include sorgenti concluse, record e
lacune. Le opere usano `all/current/missing/conflicts` e conteggi di snapshot e
conflitti aperti. Gli snapshot sono ordinati per acquisizione
`(imported_at DESC, id DESC)`: ciò non risolve la cronologia incerta della sorgente.
Il cursore resta l’UUID dell’ultimo elemento. Il report accetta `path` per filtrare
le anomalie, mantenendo il riepilogo dell’intero batch. Storage restituisce totali
catalogati, aggregati per tipo, capacità/disponibilità del filesystem, riserva
configurata e data di creazione dei job. Gli input/output sono validati dal registro
condiviso; UI e API devono essere aggiornate insieme.

`POST /admin/archive/dev-reset` richiede Owner, CSRF, `requestId` UUID e
`confirmation: "RESET"`; senza `PALIMORA_DEV=1` restituisce 404. Storage espone
`dev_reset_available` soltanto all’Owner del dev. Il job `reset_dev` conserva la
fase `catalog_cleared` prima della pulizia ripetibile di code/file; un errore
mantiene il blocco delle mutazioni Archive/Ingest fino al retry. Il reset usa un
elenco esplicito di tabelle, senza `CASCADE` verso identità o futuri dati utente.
Il worker verifica il flag indipendentemente dall’API.

L'outbox contiene eventi di preservazione/pubblicazione snapshot, acquisizione
artefatti, rivalidazione e decisioni amministrative. BullMQ consegna almeno una
volta; `archive_dispatch.event_id` rende idempotente il consumatore. Le decisioni
amministrative vengono preservate nei pack prima dell’ack; gli eventi snapshot
restano disponibili come feed durevole per i consumatori successivi. PostgreSQL
rimane autorità anche se Redis viene perso. Consegne eventi esaurite vengono
rimesse in coda dopo un minuto, mantenendo lo stesso ID; un guasto di storage
non perde la decisione amministrativa né produce un ack prematuro. I nuovi moduli useranno queste identità
e revisioni, senza duplicare la logica di importazione o riconciliazione.

Il trasporto interno ingest accetta gruppi omogenei di record o tag (massimo
1.024); `palimora.ingest.cache.v1` scambia SHA-256 e risultati parser già
committati. Gli oggetti in staging includono offset e taglia del segmento.
`index_progress` nel dettaglio sorgente indica le righe dell’indice SQLite
derivato durante la costruzione, senza avanzare il checkpoint di acquisizione.

## API di consultazione

Route autenticate nel registro Zod condiviso: `catalogWorks`, `catalogBrowse`,
`bibliographyPage`, `readerWork`, `readerContent`, `readerInteractions`,
`readerMedia`, `readerDownload`. Snapshot, capitoli e asset sono verificati entro
l'identità opera; nessun hash arbitrario è leggibile tramite la route media.
`readerWork` restituisce metadati/bibliografia e un indice capitoli leggero;
`readerInteractions` pagina commenti radice/risposte e utenti kudos separatamente.
I campi sorgente opzionali sono definiti in `bibliography.ts`, non reinterpretati
come dati personali. Nessun endpoint acquisisce dati da AO3.

`catalogWorks.language` accetta uno o più nomi/codici separati da newline
(massimo 3000 caratteri), combinati in OR; gli altri criteri restano in AND.
I link esistenti con una sola lingua rimangono validi.

`catalogBrowse` accetta anche `kind=language`: nomi e conteggi provengono dalla
proiezione corrente, escludendo identità collegate e metadati lingua assenti.
Ricerca per nome e cursore ordinato consentono suggerimenti oltre le prime
lingue delle faccette OpenSearch, senza introdurre un catalogo di lingue fittizie.

`catalogWorks` combina query metadati `q`, titolo/autori, `fulltext` capitoli,
include/exclude per tag e categoria, lingua, completamento, crossover, capitolo
singolo previsto, restrizione e disponibilità. Numeri: esatti, `<`, `>`, `<=`,
`>=`, intervalli; date aggiornamento assolute o relative (`< 3 months`,
`1-2 years ago`). Query con AND/OR/NOT, parentesi, frasi, wildcard e campi AO3
(`creator`, `creators`, `id`, `word_count`, `kudos_count`, `complete`, `series.title`,
ID sorgente dei tag/autori/collezioni quando presenti). I filtri positivi sono
congiunti, le esclusioni negate singolarmente; i valori sconosciuti non soddisfano
filtri numerici o booleani. `sort` espone rilevanza, titolo, autori, pubblicazione,
aggiornamento, parole, hit, kudos, commenti, bookmark, archiviazione e posizione
nella serie; `direction` è esplicita. Articoli iniziali e ordinamento autori
seguono la semantica AO3.

`OPENSEARCH_URL` predefinito `http://opensearch:9200`; indice derivato
`palimora-works-v2`, query_string AND e analizzatori per lingua (standard per le
lingue senza stemming disponibile). PIT + search_after paginano oltre 10.000
risultati: cursore legato a query/ordinamento, rinnovo di cinque minuti. Errori
`SEARCH_QUERY_INVALID` (400), `SEARCH_CURSOR_EXPIRED` (410) e `SEARCH_UNAVAILABLE`
(503) sono recuperabili dalla UI. PostgreSQL verifica epoch/generazione e
restituisce metadati autorevoli; `indexing` segnala proiezioni pendenti. La perdita
dell'indice accoda automaticamente tutti i documenti per ricostruzione dai pack.

Media: GET/HEAD, Accept-Ranges, 206 per intervallo singolo valido, 416 per
intervallo non soddisfacibile, tipo rilevato dai byte; sconosciuti e allegati
usano Content-Disposition attachment. Segmenti e checksum sono verificati dal
lettore canonico. HTML/EPUB/PDF on demand leggono lo stesso snapshot e sono
risposte binarie documentate in OpenAPI, distinte dall'export archivistico M6.
HTML/EPUB non accumulano i media in RAM. Il PDF usa Typst 0.15.1 per HTML
semantico e stylesheet convenzionali; CSS/layout non rappresentabili passano
integralmente a Chromium. Nessuna suddivisione o parallelizzazione per capitoli.
Template fisso e testo JSON senza valutazione di codice, root temporanea privata,
asset canonici (SVG già sanitizzati), nessun import/fetch remoto. Il fallback ha
JavaScript disabilitato e consente solo risorse locali dello snapshot. Timeout
60 s, pulizia dei temporanei e arresto del browser con l’API.

Una generazione PDF attiva per processo; richieste contemporanee dello stesso
snapshot condividono il risultato, altre ricevono `CONFLICT`. Cache privata in
RAM per opera/snapshot: massimo 8 PDF/32 MiB, scadenza 10 minuti. Autorizzazione e
risoluzione dello snapshot precedono sempre la cache. Il browser del fallback è
riutilizzato e chiuso dopo 60 s di inattività. Nessun nuovo oggetto archivistico,
nessuna modifica a versioni o pack.

### Sincronizzazione AO3

`GET /api/v1/admin/ao3` espone il monitor; `GET /admin/ao3/jobs` code e cronologia,
con cursori UUID e filtro per lavoro. Le POST `control`, `manual`, `priorities`,
`account` e `jobs/:id` applicano ACL admin/CSRF/audit. I segreti dell'account non
sono restituiti. Upload tramite `uploads`, `uploads/:id/chunk` e `finish`:
ID idempotente, offset contiguo, retry identico verificato byte per byte, dimensione
finale verificata prima dell'accodamento. Nessuna scrittura pack dall'API.

`POST /api/v1/works/:id/open` rinnova soltanto la watchlist autenticata; il worker
rispetta un avvio per opera/ora. `ao3_jobs` è l'autorità e outbox del dispatch,
con unicità `(kind,target)`, generazione Redis, checkpoint e retry persistenti.
Il lock 70210423 serializza l'esecuzione e coordina il reset; 70210421 coordina
le richieste AO3 e il monitor; 70210422 serializza il seeding. Il commit canonico
accetta la precedenza remota solo tramite opzione interna, mai da un envelope dump
né da un endpoint amministrativo di editing. Dettagli e stati operativi in 05.

`metadata.ao3.comments_coverage` e `kudos_coverage` sono estensioni opzionali
`unknown|partial|complete`. Le risposte `readerInteractions` espongono sempre la
copertura, con default sconosciuto per le vecchie acquisizioni; nessuna riscrittura
dei pack v1. La proiezione della disponibilità corrente deriva dalle osservazioni
sync, mantenendo immutabile quella degli snapshot scelti esplicitamente.

Il monitor espone `control.gate` e `eligible` derivati dalla policy di esecuzione;
`probe_eligible_at` include budget richieste e cooldown, ed è null con sonde sospese.
La coda accetta filtri `state`, `kind`, `q`, `cursor`; ogni lavoro espone
`execution`, `eligible_at`, titolo e collegamento all'opera quando presenti.
`GET /api/v1/admin/ao3/media` (ACL admin) elenca i fallimenti `MEDIA_UNRECOVERABLE`,
con ricerca URL, cursore, riferimenti alle opere e stato dell'upload. La migrazione
027 indicizza errori media e ricerca inversa dei riferimenti.

### Biblioteca personale: prima slice

`libraryList`, `libraryWork`, `librarySave`, `bookmarkSave`, `libraryLater` e `libraryForget`
sono nel registro condiviso `/api/v1`. Ogni query usa l'utente della sessione;
nessun ID utente fornito dal client determina il proprietario. `bookmarkSave`
richiede la revisione letta (zero per la prima creazione) e restituisce quella
nuova. Anche una cancellazione incrementa la revisione; un retry con revisione
vecchia restituisce `CONFLICT` senza mutazioni. Le liste paginano 50 identità
in ordine UUID stabile, con filtro titolo/note e tag esatto. `readerOpen`
aggiorna anche la cronologia privata, senza togliere Mark for Later.

`librarySave` (`POST /library/works/:id/save`) assicura il salvataggio personale
senza sovrascrivere note, tag, raccomandazione o visibilità. È idempotente: un
salvataggio attivo mantiene la revisione; prima creazione e ripristino di un
tombstone la incrementano. «Opere salvate» riusa `kind=bookmarks` e lo stesso
modello: i client precedenti restano compatibili.
`collectionWork` in aggiunta assicura lo stesso salvataggio per l'utente agente,
atomicamente dopo i controlli ACL; non salva a nome degli altri membri. La
rimozione dalla collezione non modifica il salvataggio personale e viceversa.
`collectionList` accetta `work` opzionale e restituisce `contains_work` per il
selettore; gli inviti non accettati non rivelano l'appartenenza dell'opera.

### Collezioni e lettura personale

Il registro condiviso espone `collectionList/Create/Detail/Update/Member/Respond/Work`,
`readingProgress/Save` e `annotationList/Save`. Creazione collezione e annotazione
usano UUID del client; associazioni opera sono idempotenti per chiave composta.
Modifiche di metadati, progressi e annotazioni richiedono la revisione corrente:
`CONFLICT` non sovrascrive la modifica concorrente. Liste collezioni, opere e
annotazioni paginano per UUID stabile in gruppi di 50.
`readingProgress/Save` include `chapter_lengths` nello snapshot selezionato:
ID capitolo e lunghezza del testo canonico in unità UTF-16, nello stesso ordine
dell'opera. Il campo è opzionale per le copie locali già salvate; l'adapter offline
lo ricostruisce dai documenti della copia. Server, coda offline e percentuale
visibile usano `readingPercent`; la UI aggiorna la posizione durante lo scorrimento
e distingue sempre questa indicazione dal salvataggio confermato. Nessun offset
viene convertito in una diversa unità o salvato senza validazione server.

`collectionCandidates` (`GET /collections/:id/candidates`) richiede la proprietà
della collezione e restituisce solo username attivi, esclusi proprietario, membri
e inviti pendenti; ricerca letterale senza distinzione di maiuscole, 50 risultati
per pagina e cursore per username. La revoca permette di rimuovere anche account
disabilitati o eliminati logicamente.

Inviti alla condivisione rivolti a username locali: solo l'Owner invita/revoca o
cambia ruolo, il destinatario accetta/rifiuta e può lasciare la collezione.
Editor modifica metadati e opere; Viewer legge. Le annotazioni sono modificabili
solo dall'autore, condivisibili con collezioni di cui è Owner/Editor e leggibili
dai membri accettati. Condividere aggiunge anche l'opera alla collezione. Revoca
e cancellazione collezione sono verificate a ogni lettura, senza autorizzazioni
conservate nella cache server. Le operazioni sulle collezioni sono auditate.

### Contratti 5B

Registro condiviso: `socialPreferences/Save`, `personalStatistics/Activity`,
`readingHeartbeat`, `recommendationRecipients`, `recommendWork`, `subscriptionStatus/Save`, `subscriptions`,
`notifications`, `notificationRead`, `notificationsReadAll`, `pushDevices/Register/Revoke`.
Preferenze protette da revisione; gli ID utente effettivi provengono dalla sessione.
La condivisione per utenti selezionati/istanza si applica soltanto all'attività.
`GET /library/statistics` non accetta parametri e calcola soltanto le statistiche
della sessione; un `username` inviato direttamente viene rifiutato (400).
`GET /admin/users/:id` e `GET /admin/users/:id/statistics` richiedono Admin/Owner
(403 per User), includono account disabilitati/eliminati e registrano l'ispezione
nell'audit. Il calcolo statistico è condiviso, senza modello alternativo.
`socialPreferences/Save` non espone né applica `statistics` e `statistics_users`;
le colonne preesistenti restano conservate ma inerti, anche nei vecchi backup.
Le revoche dell'attività si applicano a ogni richiesta. Le risposte dispositivi escludono endpoint,
chiavi private e subscription cifrate. Notifiche paginate per data aggiornamento
con UUID come spareggio; opere e sottoscrizioni mantengono cursori stabili.

`GET /recommendations/recipients` è autenticato e restituisce soltanto `username`,
50 nomi per pagina, ordinati per nome case-insensitive; `cursor` è l'ultimo nome,
`q` cerca una sottostringa letterale senza distinzione di maiuscole. Esclude il
richiedente, gli account disattivati/eliminati e chi ha disabilitato i consigli.
`recommendWork` ricontrolla il destinatario al momento dell'invio; `note` omessa
vale stringa vuota, le note storiche restano leggibili. La UI multipla riusa
l'operazione singola con un `requestId` per destinatario, conservato nei retry;
il vincolo mittente/destinatario/opera impedisce consigli e notifiche duplicati.

`notificationsReadAll` (`POST /notifications/read-all`) aggiorna atomicamente
solo le notifiche non lette dell’utente autenticato, incluse quelle fuori dalla
pagina caricata. Le letture già registrate mantengono il proprio timestamp; i
nuovi arrivi successivi allo snapshot della richiesta restano non letti. La
richiesta usa autenticazione e CSRF come le altre mutazioni personali.

Le sottoscrizioni partono dallo snapshot transazionale PostgreSQL, usando
`pg_visible_in_snapshot` sul top-level XID del produttore outbox; nessuna
assunzione che l'ordine dei sequence ID coincida con quello dei commit.
Il payload Web Push contiene soltanto la lingua, il service worker apre sempre
il centro notifiche locale. Sessione attiva e preferenze sono ricontrollate prima
della consegna. La coda e le ricevute restano disponibili dopo un riavvio.

### Contratti 5C

Le risposte di autenticazione aggiungono `session: {id, expires_at}`.
`readingSave` e `annotationSave` accettano `requestId` UUID opzionale per compatibilità;
il client lo genera prima del primo tentativo e lo conserva fino all'ack. Le ricevute
sono separate per utente; autenticazione/CSRF precedono anche il replay idempotente.
Revisioni concorrenti restano `CONFLICT`. Una risoluzione esplicita genera una nuova
operazione con revisione riletta; le note eliminate da remoto possono essere
conservate con nuova identità privata, senza resuscitare una condivisione revocata.

Le copie locali sono selezionate con `local=1&snapshot=…` nell'URL del reader.
Questo parametro riguarda solo il client: API, identità opera, snapshot, ancore e
validazione rimangono quelli canonici. `alignAnchor` è condiviso tra server e client.
Download e scritture IndexedDB verificano la partizione attiva nella transazione;
la coda è serializzata tra schede e ogni mutazione conserva la revisione attesa.
Le Blob URL dei media esistono solo nel documento del lettore autenticato; nessuna
risposta privata viene inserita in Cache Storage o servita dal service worker.

### Motore backup/restore 6A

`createBackup`, `inspectBackup`, `restoreBackup` in `backup-engine.ts` sono
operazioni condivise dal worker amministrativo e dalla CLI operatore. `palimora-backup-v1`
riusa i volumi portabili ma include dati personali e configurazione sensibile;
non va confuso con `palimora-archive-v1`. Migrazione 033: ricevuta transazionale
`backup_restores`, più eleggibilità dei sottoscrittori per gli eventi personali
pendenti al cambio di cluster. Il consumatore ordinario usa ancora XID/snapshot;
gli eventi restaurati usano la visibilità catturata e la data della sottoscrizione,
senza cambiare deduplica, ACL o logica delle notifiche.

Lock 70210460 per restore target; backup serializzato per ID con
`hashtextextended(id,70210460)`. Lock condivisi 70210401/70210402 precedono lo
snapshot e proteggono migrazioni e pack fino al completamento della cattura.
Il restore richiede `RESTORE <digest>`, target vuoto (completo) o privo di utenti
(piattaforma); FK e integrità pack devono passare prima del commit. Dettagli,
checkpoint e procedura operativa sono in [08](08-backup-export.md).


### Administration & Integration 6A.3

Contratti Zod/OpenAPI `backupStatus/Create/Detail/Control/Destination/Schedule`,
`backupRestorePreview/Restore/File` sotto `/api/v1/admin/backups`. Accesso Admin
(o Owner); preview/restore solo Owner, download privati ulteriormente Owner.
Input con UUID idempotente e nomi logici, nessun percorso web. Il download è una
risposta binaria in streaming. Stati della tabella sopra; `kind` distingue
`full`, `platform`, `export`, `verify`, `restore`, `delete`. Progressi e risultati
non contengono credenziali né righe personali del report di riconciliazione.

Migrazione 034: destinazioni, pianificazioni disabilitate per default, outbox
`backup_runs` e ricevute d'import archivistico. Lock 70210462 per il worker;
le mutazioni backup usano il lock identità condiviso per consentire pausa durante
la cattura, restando coordinate con revoche e mutazioni identità esclusive.
Riconsegna BullMQ per ID/generazione, nessuna dipendenza dalla persistenza Redis
per ricostruire i job. Restore disabilita pianificazioni catturate e sospende
operazioni attive prima del commit. Retention non elimina una base referenziata.

`palimora-corpus-catalog-v1`: migrazioni, segmenti di tabelle pubbliche e indici
opere referenziati per hash; nessun locator fisico esportato. Re-ingest su catalogo
vuoto con schema identico; ricevuta per digest e FK verificate. Compatibilità del
contenitore e comandi standalone restano quelli di [08](08-backup-export.md).

### Operations & Monitoring 6B.1

Migrazione 035: layout per account, campioni correnti, aggregati gauge/istogrammi,
stato e cronologia delle proiezioni. `operations_jobs` è una vista UNION delle
code esistenti, non un secondo registro di esecuzione. Contratti tipizzati
`operationsOverview/Layout/Metrics/Jobs/History/Control`, tutti Admin/Owner;
`operationsControl` rivalida ruolo e azione effettivamente disponibile prima di
delegare. History accetta solo ID esistenti della famiglia richiesta, non query
arbitrarie dell'audit. Layout incluso nel backup piattaforma; telemetria e stato
operativo nel completo.

Lock 70210470 per campionamento, 70210471 per storage, 70210472/73 per i due
processi di proiezione. Questi ultimi mantengono i lock/transazioni interni dei
motori. Le latenze vengono aggregate senza identificatori di richiesta; p95
è il limite superiore del bucket, mai il percentile di medie o percentili.
I rollup si ricavano dai campioni minuti ancora completi e sono idempotenti.
Le preferenze e i bucket persistiti sopravvivono ai riavvii; un campione mancante
non viene interpretato come utilizzo nullo.

## Amministrazione e integrità — 6B.2

API v1 tipizzate in `packages/contracts`: `maintenanceSet`; `integrityStatus`,
`integrityIssues`, `integrityStart`, `integrityControl`, `integritySchedule`,
`integrityRepair`; `auditList`; `impersonationStart` e `impersonationStop`.
Owner/Admin leggono e controllano manutenzione e scrub; solo Owner accoda o
controlla recuperi. UUID richiesta rende idempotenti gli avvii; il riuso con
sorgenti diverse è un conflitto. Stati dei job: `pending`, `running`,
`pause_requested`, `paused`, `completed`, `failed`; problemi: `open`, `repaired`,
`unrecoverable`. I controlli unificati di Operations delegano allo stesso motore.

`status` espone `maintenance_mode`; `me` e le risposte di impersonazione includono
l'operatore originale e la scadenza, senza token. `MAINTENANCE` (503) blocca il
contenuto agli utenti ordinari; `IMPERSONATION_RESTRICTED` (403) blocca sicurezza
account e sessioni annidate. Audit e problemi hanno paginazione a cursore; il
pannello aggiorna integrità ogni 3 s, audit ogni 10 s. Nessun risultato o pack
viene caricato integralmente nel browser.
