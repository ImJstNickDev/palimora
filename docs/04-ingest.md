# 04 — Ingest sorgenti incomplete e normalizzazione

## Sorgente iniziale nota

**Bind mount host `:ro`:** `/mnt/teratron_data/AO3_dumper/ao3_dump/data/ao3_stories` → `/dumps/ao3_stories`. Nessun ingest di `fanfic_stories`, FictionPress, Fimfiction o Wattpad nella v1. Dump source separato da `/mnt/sdb/palimora-data` e mai rimosso/cambiato dal pannello.

Inventario fornito il 5 novembre 2026, **non ispezione dei byte**:

| Gruppo | File | Peso osservato |
|---|---:|---:|
| `*.zip` | 139 | 853,08 GiB |
| `*.sqlite3` | 3 | 53,77 GiB |
| `*.part` | 10 | 16,82 GiB |
| **Totale** | **152** | **923,67 GiB** |

Tre indici indicati: `ao3.sqlite3`, `ao3_deduped.sqlite3`, `ao3_old_files.sqlite3`. Alcuni ZIP `queue79`, `queue82`, `queue83`, `queue86`–`queue92` sono presenti come `.part`; `queue93`–`queue99` non sono elencati. **Queste non sono prove** di quali opere/versioni manchino né dell'esistenza prevista di tutti quei numeri. Gli ZIP finali non sono ancora stati verificati per CRC e coerenza interna.

## Regola di prodotto

Un dump può essere **parziale per design**. L'importazione produce un archivio consultabile con tutti gli elementi recuperabili, registra le lacune e permette un ingest incrementale in futuro. Mancanza/corruzione dei file e parser sconosciuto sono **classi diverse**:

| Condizione | Esito |
|---|---|
| ZIP presente, valido | Importa streaming, valuta CRC/struttura dei membri usati |
| ZIP atteso/indicato in indice ma assente | `missing_source`, record/locator conservati, procedi |
| `.part` | `incomplete_transfer`, escluso; non aprire come ZIP completo |
| ZIP presente ma troncato/CRC errato | `corrupt_source`, documenta lacuna, importa soltanto membri indipendentemente verificabili se la struttura lo permette; procedi |
| Metadata SQLite disponibili, testo assente | Record bibliografico `metadata_only`, **non** presentarlo come un'opera completa leggibile |
| EPUB HTML malformato ma riconoscibile | Registra problema/parte recuperabile se sicura; conserva informazioni disponibili senza fingere completezza |
| Struttura sorgente o schema mai supportato, bug parser | `parser_blocked`: **sospendi il batch** con errore e contesto riproducibile; fix codice, poi retry esatto elemento |
| Disconnessione/IO temporaneo | Retry con backoff, poi quarantena della sorgente e procedi secondo policy |
| Spazio disco insufficiente, DB indisponibile | Sospensione globale ordinata, stato persistente |
| Media esterno non raggiungibile | Coda media separata, non blocca il corpus; retry e upload manuale |

Stato terminale batch `completed` oppure `completed_with_gaps`, non `failed` solo perché l'inventario sorgente è incompleto. Report attendibile: fonti disponibili/importate, file assenti/part/corrotti, opere complete/parziali/metadata-only, errori parser, byte e versioni effettivamente preservati.

## Pipeline

1. **Selezione** da pannello, CLI o directory monitorata; predefinito un dump/cartella, senza scegliere milioni di singoli file. Nel caso iniziale l'admin seleziona `/dumps/ao3_stories`.
2. **Inventario** leggero, streaming: firma file (`path, size, mtime, hash` dove calcolato), identificazione ZIP/SQLite, esistenza e indice di dipendenze noto. Non presumere che tutti i filename seguano una sequenza completa.
3. **Adapter** specifici, registrati per formato/schema, lettura ZIP64/SQLite *read-only*, batch e memoria limitati, nessuna estrazione permanente di milioni di file. SQL sorgente in sola lettura e limitato, nessuna modifica al dump.
4. **Parse** in envelope normalizzato versionato, con provenance precisa (dump, archivio, entry, record ID, reader/versione). I formati effettivi sono da verificare sui campioni prima di scrivere adapter definitivi.
5. **Riconciliazione** per `(source, external_work_id)` o ID locale provvisorio: unisci campi non contraddittori, conserva osservazioni alternative, seleziona stato canonico usando precedenza per affidabilità/recenza **dimostrata**, non per filename. Non sovrascrivere contenuto migliore con metadata incompleti di altra copia.
6. **Persistenza**: oggetti canonici compressi e validati → transazione DB revisioni/snapshot/locator → outbox indicizzazione. L'opera completa diventa visibile appena lo snapshot è valido, senza attendere la fine del batch.
7. **Assets**: acquisizione separata di media incorporati e file direttamente collegati, riconciliazione URL/risorse e fallback manuale. Conservare sempre URL sorgente e status, anche quando un asset non è acquisibile.
8. **Checkpoint** durevoli per sorgente e record/member, con stato del parser, versione del codice e result hash; pausa/ripresa dopo Ctrl+C, crash e deploy. Riesecuzione con nuova versione adapter modifica solo le parti che richiedono riconciliazione.

## Merge e missing content

- **Unica identità, molte sorgenti/versioni:** conservare tutti gli snapshot realmente distinti. Gli stessi byte si deduplicano; acquisizioni identiche non producono nuove revisioni finte.
- **Metadata incompleti:** utilizzare l'insieme delle evidenze, mantenendo origine per campo o gruppo di campi; nuovi dati AO3 verificati potranno diventare canonici quando il sito torna online.
- **Snapshot con ordine incerto:** mantenerli e segnalare il conflitto, non fabbricare date. Ingest da sorgente incompleta non prova che l'opera sia stata eliminata da AO3.
- **Opere parziali:** conservare tutti i capitoli validi e la stima di completezza; la sola presenza di `chapters: 10/??` non implica che il download sia corrotto. La fonte potrà essere risincronizzata più tardi.
- **Bug strutturale:** arrestare il batch, creare debug bundle con record minimo, contesto e stack trace ma senza segreti; ripresa dopo fix senza rileggere da capo fonti già complete e valide.

## Sorgenti aggiunte successivamente

Una nuova scansione dell'input read-only riconosce file nuovi/riparati tramite identità/fingerprint, elabora **solo** i file/record nuovi o quelli da rielaborare e colma le lacune. L'admin non deve manipolare il DB manualmente. Un import già completato rimane valido anche se successivamente il mount dei dump viene scollegato.

## Verifica degli adapter prima dell'ingest vero

Analizzare **schemi**, primo/ultimo record e un campione casuale di entry e ZIP, senza leggere l'intero corpus. Verificare codifica, Zip64, EPUB/HTML, tipologie di ID, mappe SQLite→ZIP, versioni, metadata e provenance. Pubblicare una matrice dei formati realmente riconosciuti e congelare il contratto di input prima del grande ingest. Non dedurre il contenuto dalle sole dimensioni e dai nomi dei file.
