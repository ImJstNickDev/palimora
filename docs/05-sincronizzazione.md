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

## Implementazione operativa — 2026-11-07

Le migrazioni `025–026` aggiungono controllo globale, lavori PostgreSQL, cronologia,
osservazioni immutabili, watchlist, media e upload. Il worker esistente usa
`palimora-ao3-v1` in BullMQ; i record PostgreSQL sono l'outbox rieseguibile.
Un lock di sessione serializza l'esecuzione anche fra processi; il riavvio registra
le esecuzioni interrotte e riprende i checkpoint. SIGTERM interrompe nuove
richieste e acquisizioni media, conservando il lavoro pendente. Il reset dev
coordina anche il worker AO3 e include esclusivamente i relativi dati archivistici.

Discovery: finestra sovrapposta degli ultimi due giorni, ordinamento sorgente
per pubblicazione, pagine e contatori persistenti, nuovo ciclo un'ora dopo la
conclusione. Backfill: finestre giornaliere retrocedenti e intervallo finale per
opere datate prima dell'apertura dell'archivio. Il catalogo locale viene percorso
a gruppi di 256 identità, inclusi record senza current; il cursore riparte dopo
l'esaurimento per intercettare nuovi ingest. Nessuna ricerca nei dump originali.
La ricerca AO3 non fornisce snapshot transazionali: finestre sovrapposte e
riconciliazione ripetuta recuperano variazioni della paginazione, senza attestare
una completezza remota non osservabile.

Priorità predefinite: discovery 10, opere 30, entità 40, media 50, backfill 80;
numeri inferiori precedono, con invecchiamento del backlog. Nuove opere scoperte
e watchlist ricevono precedenza; i controlli ordinari passano da 6 ore a 24 ore o
7 giorni per opere inattive, da 7 a 30 giorni per opere concluse. La watchlist
rinnova 48 ore dall'apertura visibile, porta l'eleggibilità a un'ora e mantiene
un limite globale di un avvio per opera per ora, anche per richieste manuali.
Aperture e prefetch non fanno richieste alla fonte; opere confermate eliminate
non entrano in watchlist. Le pause individuali non vengono annullate dalla discovery.

La sonda `/works/search` richiede un form riconoscibile; HTTP 200 e branding non
bastano. Manutenzione, blocchi, 429, errori di rete e stato sconosciuto restano
distinti. Monitor e client condividono un lock e budget persistente: una richiesta
alla volta, distanza iniziale 10 secondi, rallentamento su errori, recupero graduale,
`Retry-After` e cooldown non aggirabili dall'override Online. Offline sospende
il traffico AO3; la pausa sospende anche le elaborazioni locali. L'upload manuale
può essere acquisito con AO3 offline. Timeout HTML 25 secondi, budget memoria
64 MiB per documento/commenti; le sonde restano limitate a 1 MiB e 20 secondi.

**Restrizioni della fonte:** il client legge e memorizza per 24 ore `robots.txt`,
applicandolo a path **e query string**, oltre ai controlli HTTP. Il riferimento
[upstream robots.public.txt](https://github.com/otwcode/otwarchive/blob/master/public/robots.public.txt)
vieta `/works?` e le ricerche con query: se la policy effettivamente servita
mantiene questi divieti, discovery/backfill si sospendono con `ROBOTS_DISALLOWED`.
Non vengono usati URL alternativi, identità o proxy per eluderli. Il codice della
pipeline è verificabile con sorgenti controllate; l'esecuzione sulla fonte richiede
che questa consenta il percorso. Non è stata verificata la policy remota attuale.

L'acquisizione HTML controlla identità, numero e corpi dei capitoli, conserva note,
CSS e componenti indipendenti e usa **lo stesso ingest canonico**. Soltanto il
chiamante interno verificato può promuovere una nuova osservazione AO3; pack,
head, osservazione, outbox e completamento del job condividono il commit. I batch
con `source_kind=ao3` sono provenienza dello stesso motore, esclusi dal dispatcher
e dalla lista delle importazioni dump. Acquisizioni incomplete non sostituiscono
il current. Il checkpoint dei commenti conserva l'acquisizione in corso,
incluse le pagine separate dei thread profondi previste dal [template upstream](https://github.com/otwcode/otwarchive/blob/master/app/views/comments/_comment_thread.html.erb); le liste
kudos paginate vengono lette tramite endpoint HTML, senza eseguire JavaScript.
Copertura `unknown/partial/complete` è esplicita nel reader, separata dai totali
ufficiali. Statistiche invariate non producono snapshot duplicati.

Autori, serie e tag hanno lavori dedicati: profili, canonicalità, sinonimi e
relazioni vengono preservati, la tassonomia riutilizza `archive_tags` e
`catalog_tags`, le opere correlate vengono riaccodate. I nomi tag acquisiti senza
ID numerico usano il namespace `name:`; le associazioni al catalogo esistente
mantengono gli ID già presenti. Le pagine bibliografiche non creano utenti locali.
Un 404 generico non prova una cancellazione; solo evidenza esplicita/410 produce
`deleted`. La disponibilità osservata aggiorna la proiezione corrente e il filtro
Eliminate, senza riscrivere gli snapshot storici.

L'account tecnico è configurabile dall'admin, cifrato AES-GCM con la chiave
Foundation condivisa in sola lettura col worker. Login con CSRF, cookie limitati
all'origine AO3, verifica del login e invalidazione alla rimozione/cambio account.
Credenziali e cookie non entrano in log, risposte API o osservazioni canoniche.
Nessuna sincronizzazione di account personali.

Media: DNS verificato e fissato alla connessione, indirizzi non pubblici e
redirect pericolosi rifiutati, nessun cookie AO3 verso terzi. Streaming in chunk
di 8 MiB con verifica spazio, hash globali e manifest canonico esistente;
nessun limite totale fisso al file. Import CSS, URL relativi e `srcset` alimentano
la stessa coda; il parsing CSS ha un budget di 64 MiB. Budget per host e `Retry-After` persistenti.
404/410 o contenuti non allegabili restano errori visibili con retry diradato;
non vengono sostituiti i byte precedenti. Upload admin a segmenti da 512 KiB,
ripresa idempotente, staging PostgreSQL e commit nel worker: API mantiene storage
in sola lettura. I segmenti vengono rimossi solo dopo acquisizione verificata.
Nuove revisioni media aggiornano i binding degli snapshot correnti senza fetch
AO3 e senza perdere media storici; conflitti sul current provocano un retry.

`/admin/ao3` espone disponibilità, override, pausa globale, priorità, account tecnico,
code paginate, errori, scadenze, cronologia, pausa/ripresa individuale, sincronizzazione
manuale di opera/autore/serie/tag e upload media. Una verifica manuale dell'opera
riparte dalla pagina corrente se il lavoro non è in esecuzione; il retry della
coda conserva invece il checkpoint. Gli endpoint usano ACL admin,
CSRF e audit esistenti. Le notifiche personali restano nella Milestone 5;
il commit emette già gli eventi canonici senza introdurre abbonamenti paralleli.
