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
