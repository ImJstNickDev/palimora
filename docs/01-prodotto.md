# 01 — Contratto di prodotto

## Identità e perimetro

**Palimora** è un archivio AO3 privato, multiutente e self-hosted: stesso impianto funzionale di AO3, identità grafica nuova e lettura moderna. Il corpus è acquisito da dump e, quando possibile, sincronizzato con AO3. Gli autori originali sono entità bibliografiche della fonte, **non** account locali. I membri registrati leggono, organizzano e annotano; **non pubblicano opere**.

### Principi non negoziabili

1. Tutte le funzionalità originali AO3 pertinenti alla consultazione e alla bibliografia hanno **un'unica implementazione coerente**: opere/capitoli, autori e pseudonimi sorgente, serie, tag e wrangling, rating, warnings, search filters, collections, bookmarks, Mark for Later, history, subscriptions, note, Work Skins, esportazioni e visualizzazione delle interazioni originali.
2. **Kudos, commenti, hit e statistiche AO3 sono dati sorgente**, visualizzabili e sincronizzabili quando realmente disponibili; gli utenti locali non pubblicano commenti o kudos su AO3 e non creano una seconda «contabilità» locale di questi elementi. Mancanza di dati storici ≠ valore zero.
3. Ogni opera conserva la **provenienza**; la copia corrente rappresenta l'ultima acquisizione **valida e affidabile** nota. Le copie storiche restano leggibili inalterate, anche se la fonte originale scompare.
4. L'ingest converte in dati nativi; **nessun runtime dipende dagli ZIP/SQLite del dump** dopo il commit. La rilettura dei dump serve solo per future correzioni degli adapter.
5. Conservazione più completa possibile: capitoli, HTML, note, relazioni, tag, versioni, media originali incorporati e file direttamente collegati. Link al web originale sempre registrati; nessuno spider illimitato dell'intero web.
6. Comportamento AO3 prima di nuovi comportamenti: quando AO3 possiede già una funzione, studiare e replicarne la semantica; estenderla senza modelli paralleli. Funzionalità di pubblicazione, moderation community e infrastruttura di un sito pubblico non necessarie non vanno simulate.
7. UI coerente e pronta alla prima implementazione, senza lunghi testi esplicativi, banner educativi, badges decorativi, card enormi o falsi «Coming soon».
8. Software potenzialmente pubblico su GitHub, **corpus e informazioni degli utenti privati**. Palimora non è affiliato ad AO3/OTW.

## Funzionalità per utente locale

- Home di navigazione AO3 e dashboard personale distinta, semplice da personalizzare (sezioni visibili/ordine).
- Ricerca originale AO3 con sidebar, inclusioni/esclusioni, tag canonici/sinonimi, preferiti, linguaggi e sorting; full-text **dei capitoli**, con sintassi avanzata scopribile. Nessuna ricerca salvata/notificata nuova, salvo funzionalità originali come Favorite Tags e URL di filtri.
- Liste opere compatte come AO3, layout alternativo con copertine **solo se realmente presenti**; filtri disponibilità `Tutte` e `Eliminate`, unica indicazione discreta `Unavailable from AO3` quando supportata da prove.
- Lettura capitolo o Entire Work; modalità classica ed ebook/immersiva; tipografia/temi/skin; Work Skins attivabili/disattivabili; media serviti localmente, senza eseguire codice non affidabile importato.
- Posizione di lettura precisa e sincronizzata, capitoli letti, stati (`Da leggere`, `In lettura`, `Completato`, `In pausa`, `Abbandonato`), storia lettura, Mark for Later, bookmark, annotazioni.
- Nella UI personale bookmark e aggiunta a collezione confluiscono in **Salva in biblioteca**: le collezioni organizzano facoltativamente le opere salvate; note e tag appartengono ai dettagli personali. La condivisione resta una proprietà delle collezioni. I dati esistenti e i bookmark sorgente AO3 sono conservati.
- Collezioni private o condivise con ACL `Owner/Editor/Viewer`, senza trasferimento proprietà nella v1; consigli e liste condivise, attività di lettura visibile solo se consentito dall'utente, possibilità di condivisione con tutti i membri dell'istanza.
- Versioni storiche accessibili con semplice selettore, nessun diff obbligatorio, nessun «pin» versione preferita; default **sempre ultima versione corrente**. Al cambio versione, tentativo affidabile di riallineare posizione e annotazioni, altrimenti fallback senza perdere l'originale.
- Notifiche **in-app e push**, singole/aggregate secondo i casi e preferenze utente; nessuna email per notifiche. Statistiche personali (parole, opere, tempo, fandom e andamento), consultabili soltanto dal titolare e da Admin/Owner nella gestione utenti; nessuna condivisione fra utenti normali.
- PWA con lettura offline e sincronizzazione al ritorno online; architettura per client Capacitor Android e, eventualmente, iOS; UI IT/EN inizialmente e i18n estensibile, lingua interfaccia distinta dalla lingua dell'opera.

## Account e contesto di privacy

Ruoli locali `Owner`, `Admin`, `User`. Username e password obbligatori, email opzionale senza servizio SMTP. Password, passkey/WebAuthn, TOTP, recovery codes; sessioni e dispositivi revocabili. **Solo Owner** crea/revoca inviti e gestisce ruoli amministrativi e impostazioni globali critiche. Admin può vedere dati personali anche privati nella UI amministrativa; non richiede annunci ridondanti nella UI di lettura. Utenze «eliminate» sono soft-deleted senza rimozione fisica dei dati. Non esistono account autore fittizi con credenziali.

## Sincronizzazione e limiti di v1

- AO3 nuove opere controllate orariamente, con code e checkpoint; recupero dello storico con capacità residua, aggiornamenti canonici di opere/metadati/media/commenti/statistiche e watchlist di lettura 48 ore.
- Eventuale **account tecnico AO3** autorizzato per opere consultabili solo da iscritti, distinto dal futuro collegamento degli account degli utenti.
- **Fuori v1:** collegamento/sincronizzazione degli account AO3 personali (solo roadmap, non UI fittizia); integrazione di piattaforme non AO3; pubblicazione di opere, kudos e commenti locali; updater web; editor generico di workflow e widget.
- Non sono promessi accesso a dati storici non forniti dalla fonte, bypass delle restrizioni AO3 né discovery perfetta di tutte le opere. La copertura misurata è una metrica, non una garanzia.

## Prestazioni e qualità

Target di ricerca ordinaria idealmente sub-secondo su corpus reale, con costi d'indicizzazione ragionevoli; lettura rapida dei capitoli; integrazione e ingest idempotenti. I numeri effettivi saranno misurati e ottimizzati, senza soglie inventate prima dei benchmark. Nessuna UI «provvisoria da rifinire»: rilasciare un modulo solo quando le interazioni previste per esso funzionano realmente.
