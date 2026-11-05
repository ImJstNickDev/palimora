# 10 — Contratti tra moduli, stati e invarianti

Questa specifica definisce **comportamenti obbligatori**, non un OpenAPI generato artificialmente prima dell'implementazione. I DTO concreti, schema SQL finale e codifica binaria v1 devono risultare coerenti e versionati durante le prime due milestone.

## API pubblica dei client ufficiali

- Namespace `/api/v1`, REST JSON, autenticazione per cookie/sessione web e meccanismo sicuro di token/sessione per futuri client ufficiali. `OpenAPI` generato dal codice, SDK TypeScript generato/derivato dal contratto, autorizzazione server-side.
- Aree funzionali: `/auth`, `/invites`, `/me`, `/works`, `/chapters`, `/tags`, `/authors`, `/series`, `/search`, `/library`, `/collections`, `/bookmarks`, `/reading-progress`, `/annotations`, `/notifications`, `/downloads`, `/admin/*`.
- Filtri e paginazione cursor-based su grandi insiemi, ordinamento stabile; URL pagina di opera basata su identificatore stabile locale, riferimenti originali AO3 preservati separatamente. Endpoint lettura storica seleziona `snapshot_id` esplicito.
- Operazioni di scrittura con `Idempotency-Key` (o vincoli equivalenti) dove retry lato client/workers è plausibile. Errori tipizzati, non stringhe libere per pilotare UI.
- SSE preferiti per feed di stato ingest/sync e notifiche: gli eventi devono avere ID riprendibile; UI non deve dipendere da WebSocket per mostrare dati fondamentali.
- Le API sono implementate **per client Palimora**, non una API pubblica da stabilizzare per terzi nella v1. Contratti interni non sono una promessa di compatibilità per plugin esterni.

## Envelope ingest (schematico)

```json
{
  "schema": "palimora.ingest.v1",
  "source": {"kind": "ao3_dump", "dump": "initial", "file": "queue01.zip", "entry": "..."},
  "identity": {"source": "ao3", "workId": "123456"},
  "observation": {"capturedAt": null, "confidence": "unknown"},
  "payload": {"metadata": {}, "chapters": [], "assets": []}
}
```

I `...` e gli oggetti vuoti sono **schema illustrativo**, non valori di runtime, né autorizzano a compilare campi ignoti con placeholder nei dati di produzione. Ogni elemento realmente importato porta una provenance verificabile e un contract version. Date non presenti non vengono inventate.

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
| Export/backup | `queued`, `running`, `verifying`, `completed`, `failed`, `interrupted_resumable` |

Non mescolare «assenza da dump», «assenza da AO3», «mancanza di dati su kudos» ed «errore temporaneo»: sono fatti differenti.

## Eventi durevoli e idempotenza

- Eventi esemplificativi: `work.snapshot.published`, `work.availability.changed`, `media.revision.acquired`, `ingest.source.completed`, `ingest.parser.blocked`, `sync.batch.completed`, `archive.object.verified`, `backup.completed`, `notification.created`.
- Produttore scrive **DB + outbox in una transazione**. Un dispatcher porta eventi a Redis/BullMQ e ad eventuali subscriber; delivery può essere almeno una volta, consumatori idempotenti, replay senza effetti duplicati.
- Concorrenza: lock logico per `(source,work_id)` durante merge+publish; pack writes possono essere parallele ma indici e head update seguono commit atomico; single-writer/leader per tick globale e reconciliation cursors.
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

Endpoint attuali: `/auth/status`, `/auth/setup`, `/auth/login`, `/auth/logout`, `/auth/register`, `/auth/invite`, `/auth/passkey/*`, `/me`, `/me/password`, `/me/sessions/*`, `/me/totp/*`, `/me/recovery`, `/me/passkeys/*`, `/admin/users` e relative azioni, `/invites`. Le liste utenti/inviti usano cursore UUID stabile e pagine di 50 elementi; gli stati eliminato/disabilitato e gli inviti revocati restano consultabili. Setup e consumo inviti sono protetti da lock/vincoli; creazione inviti deduplicata tramite `requestId`. Nessun contratto di ingest/pack viene dichiarato congelato in questa milestone.

### Conferma TOTP

Il client usa in sequenza `totpStart` (password → QR/chiave), `totpVerify` (sei cifre → codici di backup), `totpEnable` (`backupCodesSaved: true` → attivazione). Verificare il codice non attiva ancora la 2FA. Le configurazioni pendenti sono legate alla sessione, monouso e scadono dopo cinque minuti; una nuova configurazione invalida la conferma precedente nella stessa sessione. La migrazione `002_totp_confirmation.sql` estende i tipi di challenge, preservando quelli esistenti. Client e API devono essere aggiornati insieme per questo cambiamento del flusso Foundation.

### Login progressivo e recovery

`POST /auth/login` mantiene `{username, password, code?}`. `SECOND_FACTOR_REQUIRED` viene emesso solo dopo password corretta se TOTP è attivo; il client invia quindi le stesse credenziali con il codice a sei cifre. Il campo `password` accetta in alternativa un recovery code monouso: con codice valido non serve `code`. Errori per account inesistente, disabilitato, eliminato, password errata o recovery non valido restano `CREDENTIALS_INVALID`. Le operazioni di sicurezza autenticate continuano a richiedere la password reale. Le route WebAuthn mantengono il contratto precedente, compatibile con conditional mediation.
