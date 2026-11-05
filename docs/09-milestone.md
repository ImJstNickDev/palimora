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
