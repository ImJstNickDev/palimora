# 07 — Identità locale, autorizzazioni e amministrazione

## Account e accesso

- Utenti della **biblioteca Palimora**, non profili autore AO3. Ruoli `Owner`, `Admin`, `User`; uno e un solo Owner iniziale, creato mediante setup wizard da DNS locale prima di pubblicare NPM su Internet.
- Registrazione successiva esclusivamente tramite **inviti generati dall'Owner**. Inviti con token casuale non indovinabile memorizzato come hash, scadenza, usi massimi (default monouso), revoca e vincolo facoltativo a email. Senza servizio email non è possibile provare automaticamente la proprietà della casella: non attribuire al solo campo email proprietà di verifica dell'identità.
- Username/password obbligatori; email facoltativa; **nessun SMTP**. Password con hashing moderno (Argon2id o implementazione equivalente mantenuta), passkey/WebAuthn, TOTP e codici recovery monouso, sessioni persistenti e lista dispositivi revocabili. Ripristino password/codici tramite amministrazione autorizzata, non invio email.
- Cookie sicuri HTTP-only/SameSite con TLS pubblico gestito da NPM; protezione CSRF per le mutazioni che usano session cookies, rate limiting login, logout/revoca immediati. Nessuna password AO3 personale memorizzata per future sincronizzazioni non implementate.
- Utente rimosso = `soft_deleted_at` + blocco immediato accessi + revoca sessioni; dati personali rimangono nel DB, stato «eliminato» in UI. Nessuna cancellazione fisica o trasferimento proprietà collezione prevista in v1.

## Bootstrap senza token

La prima installazione è visibile **solo tramite DNS locale** per scelta operativa dell'host. Il wizard crea Owner, istanza e preferenze base con un'unica transazione protetta da lock/constraint; due richieste concorrenti non possono creare due proprietari. In caso di crash, il wizard riprende o ritorna allo stato sicuro senza creare una seconda ownership. Dopo `initialized_at`, endpoint wizard/registrazione pubblica non sono più accessibili. L'amministratore pubblicherà l'istanza tramite NPM **solo dopo** avere finalizzato ownership. Nessuna misura aggiuntiva di token monouso o filtro IP per il wizard.

## Permessi

| Azione | Owner | Admin | User |
|---|---|---|---|
| Registrazione da invito | sì, se invitato | sì, se invitato | sì, se invitato |
| Generare/revocare inviti | **sì** | no | no |
| Ruoli amministrativi, sicurezza globale, restore completo | **sì** | no | no |
| Gestione quotidiana account, sessioni, soft delete | sì | sì | proprie |
| Ingest, sync, media, index, jobs, backup/export | sì | sì (salvo restore critico) | no |
| Vedere dati privati altrui via admin | sì | sì | no |
| Vedere/modificare collezioni | secondo ACL | secondo ACL, con accesso admin documentato | secondo ACL |
| Impersonazione per debug | sì | sì | no |

Le policy vengono applicate **sul server** e sull'oggetto, non soltanto nascondendo controlli UI. `Owner` inviti e ruoli critici sono riservati al proprietario anche se l'admin vede altri dati. Collezioni locali con `Owner` (immutabile in v1), `Editor` e `Viewer`; condivisione revocabile; visibilità di lettura/statistiche privata per default, opt-in per utenti selezionati o istanza intera.

L'amministrazione può ispezionare anche dati personali privati come richiesto; non aggiungere banner di spiegazione ridondanti nelle pagine di lettura. Le operazioni amministrative di ispezione sensibile e impersonazione devono essere auditabili. L'utente impersonato resta distinto da `actor_admin_id` e dall'identità della sessione amministrativa originale.

## Admin panel

**Home:** card operativamente utili e navigabili (stato ingest, sync/AO3, code, anomalie, spazio, backup, utenti); default curato, sezioni personalizzabili senza framework di widget. Dettagli in pagine dedicate: overview jobs + ingest, sync, media, ricerca/index, opere, utenti/inviti, backup/export, integrità e impostazioni.

Funzioni richieste:

- **Ingest:** batch e fasi, cause di blocco parser, resume, sorgenti assenti, duplicati, provenance, progress/ETA, debug bundle mirato senza segreti, dettaglio opera e ricostruzione da dump.
- **Sync:** stato AO3 auto/forzato, cicli orari e contatori, rate-limit e backlog, azioni manuali su opera/serie/autore/tag, pause, retry e priorità essenziali.
- **Opera:** contenuto canonico, media, versioni, hash, snapshot sorgente, motivo scelta head, timeline eventi, risync e correzione delle associazioni errate con audit.
- **Media:** retry batch dei fallimenti, upload di file sostitutivo e riuso su riferimenti allo stesso URL, senza alterare la storia delle altre revisioni.
- **Utenti:** gestione/ricerca, ruoli nei limiti della matrice, sessioni, stato, inviti, impersonazione auditata.
- **Metriche:** solo container **di Palimora**, CPU/memoria/rete/I/O, uso storage per corpus/DB/indici, latenza richieste e search, contatori e timeline aggregate. Il backend non possiede il socket Docker.
- **Backups:** tre modalità e destinazioni esterne selezionabili, pianificazioni opzionali **spente di default**, stato, verifica e ripristino guidato.

## Manutenzione e audit

- `normal`: normale gestione dinamica risorse.
- `maintenance_light`: privilegia elaborazione catalogo/ingest/sync nei limiti dei container assegnati; lettura/UI possono funzionare degradate.
- `maintenance_full`: normali utenti, anche con sessione attiva, vedono **solo** pagina manutenzione; Owner/Admin mantengono accesso necessario alla gestione.
- Audit append-only: actor, effective user se impersonazione, IP e session ID, azione, target, timestamp, before/after filtrati, esito, correlazione job. **Mai** loggare token, password, recovery codes, cookie, segreti o contenuti privati non necessari.
- Operazioni critiche con conferma proporzionata, non una conferma per ogni click. Nessuna modifica arbitraria dei dati originali AO3 che cancelli provenance.

## Contratto operativo Foundation

- Sessione opaca casuale a 256 bit, nel DB solo SHA-256; durata assoluta 30 giorni, ultima attività aggiornata al massimo ogni cinque minuti. Cookie HttpOnly, SameSite=Strict, Secure in produzione. `Origin` esatto richiesto per ogni mutazione, anche login/setup; le mutazioni autenticate richiedono inoltre `X-CSRF-Token` della sessione. Nessun token in localStorage.
- Password 12–128 caratteri, Argon2id (64 MiB, 3 iterazioni, parallelismo 1). Username 3–32 caratteri ASCII alfanumerici con `_`, `.` e `-`, unicità case-insensitive; nomi degli account eliminati rimangono riservati. Email opzionali e non verificate, senza recupero via SMTP.
- TOTP a sei cifre/30 secondi, tolleranza di un intervallo; il contatore impedisce il replay. Attivazione in due fasi: `/me/totp/verify` verifica il codice e restituisce i codici di backup senza attivare il fattore; `/me/totp/enable` richiede `backupCodesSaved: true` dopo il download e la conferma nella UI. Il server verifica la configurazione già validata, vincolata alla sessione e con scadenza di cinque minuti; conserva soltanto il segreto cifrato e gli hash dei codici pendenti. Non può verificare il salvataggio effettivo del file sul dispositivo. L’attivazione installa fattore e hash e revoca le altre sessioni atomicamente; dieci recovery codes da 80 bit, memorizzati come hash e consumati atomicamente. La rigenerazione invalida i precedenti. Configurazioni pendenti scadono dopo cinque minuti.
- Login: username/password iniziali; il client mostra il campo TOTP solo dopo `SECOND_FACTOR_REQUIRED`, restituito esclusivamente dopo password corretta. Le credenziali del passaggio intermedio restano soltanto in memoria e vengono eliminate tornando indietro o completando l’accesso. Un recovery code valido nel campo `password` sostituisce password e TOTP per un accesso monouso; consumo e creazione sessione sono atomici, con rate limit invariati e audit `method: recovery`. Non vale come password per le operazioni sensibili dell’account. Account disabilitati/eliminati non possono consumare i codici.
- Passkey WebAuthn discoverable con user verification obbligatoria: sono un accesso alternativo resistente al phishing, non richiedono un ulteriore TOTP. Verifica di challenge, firma, origin, RP ID e contatore tramite [SimpleWebAuthn](https://simplewebauthn.dev/docs/packages/server). Nel login la conditional mediation propone le passkey disponibili attraverso l’autofill del browser sul campo username, senza endpoint pubblico che riveli quali account le possiedono. Nei browser privi di autofill WebAuthn rimangono password/TOTP e recovery; l’autofill non viene simulato. Aggiunta/rimozione richiede password e, se attivo, TOTP/recovery. Nessuna credenziale AO3.
- Cambio password, reset amministrativo, ruolo, disabilitazione e soft delete revocano le sessioni nell'identica transazione. Attivare TOTP revoca le altre sessioni. Ogni account può revocare le proprie sessioni; User/Admin possono eliminare il proprio account dopo riautenticazione. L'Owner non può essere disabilitato, eliminato o declassato, anche per vincolo SQL.
- L'Admin gestisce gli account User; solo l'Owner interviene sugli altri Admin. Nessuno resetta se stesso attraverso l'API amministrativa, né modifica l'Owner tramite essa. Il ripristino amministrativo imposta una nuova password e permette esplicitamente di rimuovere tutti i secondi fattori/passkey; il ripristino di un account eliminato conserva identità e dati.
- Inviti: 256 bit casuali, nel DB solo hash, 1–30 giorni, 1–100 utilizzi (default UI 7 giorni/1 utilizzo). Email vincolata confrontata case-insensitive. Il link usa `/register#token`, escluso da URL HTTP/referrer e rimosso dalla barra dopo apertura. Il token viene mostrato una volta; un retry della creazione con lo stesso `requestId` restituisce l'invito esistente, senza rivelarne nuovamente il token.
- Rate limit durevole PostgreSQL su finestre di 15 minuti: 40 mutazioni pubbliche sensibili per IP, 180 altre mutazioni per IP, 15 login per username e 20 prove di sicurezza per sessione. Le soglie comprendono i tentativi riusciti; gli endpoint restituiscono `RATE_LIMITED`. I record scaduti di challenge e rate limit vengono rimossi periodicamente.
- Le mutazioni di identità acquisiscono un advisory lock transazionale comune: verifica dell'autorità, consumo dei fattori/inviti, aggiornamento e audit sono indivisibili rispetto alla revoca. È una scelta semplice per la scala multiutente personale; la lettura rimane concorrente. Il costo di Argon2 e la contesa vanno misurati prima di aumentare il carico previsto.
- Audit append-only già presente per azioni di identità e consultazione amministrativa delle sessioni: actor/effective user, sessione, IP, esito, target e request ID. Before/after contiene solo ruolo/stato. Impersonazione, consultazione dell'audit e pannello operativo rimangono nella milestone 6: nessuna route o schermata simulata nella Foundation.
