# 05 — Discovery, sync AO3 e aggiornamento continuo

## Obiettivo e vincoli

Quando AO3 è disponibile, Palimora scopre nuove opere e rende progressivamente il corpus storico coerente con la fonte, rispettando **limiti pubblicati, accessibilità, robot/rate control e disponibilità effettiva**. Frequenza richiesta: discovery **una volta all'ora**, non moltiplicazione dei crawler. L'orologio determina l'eleggibilità alla coda, non garantisce il completamento entro 60 minuti quando la fonte rallenta o blocca le richieste.

Non aggirare CAPTCHA, login, restrizioni, rate limiting o protezioni con IP/identità alternative. L'eventuale account AO3 tecnico opera con autorizzazione per le opere riservate ai soli utenti registrati; credenziali tenute in segreti e non in log. Questo account è separato dalla futura sync dei singoli utenti locali, **esclusa da v1**.

## Flussi distinti, dati condivisi

| Flusso | Scheduling e responsabilità |
|---|---|
| New works discovery | Tick orario; paginazione, cursori e intervalli di scoperta persistenti; niente esecuzioni sovrapposte |
| Recent updates | Priorità ai nuovi capitoli e alle opere aggiornate di recente |
| Active reading watchlist | Opera aperta da qualunque utente: verifica **al massimo una volta ogni ora** per **48 ore dall'ultima apertura** |
| Reconciliation | Controllo progressivo delle opere importate, confronto con fonte canonica, partendo da attive/in corso |
| Backfill storico | Ricerca lacune e vecchie opere quando c'è capacità residua, checkpoint per intervallo |
| Stats/comments | Acquisizioni originali AO3, pianificazione separata e più frequente per opere seguite/lette |
| Tag graph, autori, serie | Sync dedicata + aggiornamenti durante la riconciliazione per opera |
| Media | Nuovi media e controlli adattivi di URL già acquisiti, versioni storiche preservate |

**Priorità di default:** nuove opere → nuovi capitoli → modifiche di capitoli → metadati/tag/autori → statistiche/commenti → backfill storico. La watchlist di lettura costituisce una **classe di freschezza alta**, soggetta allo stesso budget globale del sito e alla fairness, senza fame permanente delle altre code. Opere segnate completed da AO3 sono riconciliate molto meno spesso di quelle ongoing. Controlli occasionali anche dei testi invariati da tempo rilevano modifiche silenziose.

## Watchlist 48h

- Alla richiesta di apertura reale della pagina di un'opera (non prefetch invisibile), aggiornare con UPSERT `watch_until = max(last_open + 48h, old_watch_until)` e `last_open_at`; non avviare subito una richiesta ad AO3.
- Chiave **unica per opera** per tutti gli utenti, nessun job duplicato; `next_due_at` non si anticipa per aperture ripetute. Quando dovuto, un controllo non può partire se è trascorsa meno di un'ora dall'ultimo avvio accettato per la stessa opera.
- Ogni successiva apertura rinnova la scadenza. Dopo 48h senza aperture non si pianificano più controlli privilegiati, ma continua la normale riconciliazione adattiva.
- Opere con **cancellazione confermata** non vengono inserite. Se lo stato AO3 è offline, i tick sono sospesi, senza «recupero» a raffica; quando ritorna, il budget determina quali richieste riprendere.
- Il lettore apre **l'ultimo snapshot valido già disponibile**, mai blocca la pagina in attesa della fetch esterna. Un refresh o cambio capitolo usa il current aggiornato dopo commit; non alterare a sorpresa il testo già renderizzato nel mezzo della lettura.

## Stato globale AO3

`mode = auto | force_online | force_offline`; **default `auto`**. Il monitoraggio automatico usa healthchecks mirati (non solo homepage), risultati autenticati e distinguibili da blocchi 429/403, timeout e opere assenti. `force_online` consente il tentativo anche se monitor considera il sito degradato, **senza** bypassare le pause da rate limit. `force_offline` sospende discovery/sync, non lettura locale. L'override non è fonte autorevole della reale disponibilità.

Riconoscere stati per opera `available`, `deleted`, `hidden_or_restricted`, `temporarily_unavailable`, `unknown`; distinguere prova definitiva da errore temporaneo. Revisione manuale solo per errori inattesi e persistenti. La UI ordinaria usa eventualmente unicamente il badge `Unavailable from AO3` e filtro `Eliminate` solo per eliminazioni **confermate**. Non interpretare l'assenza dal dump come cancellazione.

## Meccanica di scheduling

1. Registro duraturo in PostgreSQL per intervalli esplorati, puntatori di scansione, checkpoint per opera, risultati e `next_due_at`.
2. BullMQ per dispatch/retry; **Postgres rimane autorità**. Outbox transazionale, leases/idempotency key `(source,entity,type,window)` e dedup per evitare doppi aggiornamenti. Scegli API BullMQ Job Schedulers correnti, non le legacy repeatables.
3. Budget globale AO3 con limiti automatici adattivi: `Retry-After` quando presente, backoff esponenziale con jitter, cool-down globale per 429/503 e riduzione concorrenza. Errori di rete temporanei non diventano deleted.
4. Fairness e prioritizzazione del backlog dopo outage, evitando richieste duplicate a una stessa risorsa. Checkpoint e statistiche per ogni ciclo orario; no salti silenziosi.
5. Verifica revisioni tramite segnali della fonte, hash contenuti, metadata fingerprint e controlli periodici di modifiche silenziose. Solo snapshot coerenti diventano `current`; conservare vecchi contenuti e osservazioni.
6. Riconciliazione campi e versioni secondo `03-dati-storage.md`, update atomico con outbox per search, notifiche e cache invalidation.
7. **Commenti/kudos read-only:** se AO3 non espone dati storici o accessibili, archiviare `unknown`/copertura parziale; nessun numero fittizio né commenti «locali» mescolati a quelli ufficiali.

## Download dei media

Media esterni incorporati e file direttamente linkati: coda specializzata che riconosce URL, redirect, modifiche a stesso URL, hash e revisione. Salvare l'originale quando accessibile; collegare la copia alle opere pertinenti, con provenienza e data. Retry periodici e manuali; l'admin può caricare un media che soddisfa più riferimenti allo stesso URL. Proteggere da SSRF: bloccare indirizzi privati/loopback/link-local/metadata service, risolvere e rivalidare DNS/redirect, limitare protocolli e timeout, streaming con budget I/O. Nessun limite **arbitrario** fisso al singolo media, ma fermarsi in sicurezza quando risorse insufficienti.

## Notifiche

Dopo commit di una nuova versione verificata, generare eventi per opere/autori/serie seguiti, deduplicati per utente/opera/versione. In-app + push, aggregazione intelligente quando molti aggiornamenti arrivano insieme. Non inviare email; non notificare revisioni fittizie per cambiamento delle sole statistiche se l'utente segue i nuovi capitoli.

## Operazioni admin

Stato AO3 e override; job queue con priorità/pausa; manual sync di singola opera, serie, autore o tag; scansione aggiuntiva; backlog; cronologia breve con contatori e motivi dei retry; revisione per errore anomalo; controllo media; timeline tecnica di un'opera. No edit manuale dei valori canonici AO3 salvo correzioni di associazione tracciate e senza cancellazione della provenienza.
