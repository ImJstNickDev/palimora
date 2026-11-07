# 06 — Frontend, ricerca, lettura e UX

## Stack e disciplina visiva

React + TypeScript + Vite, libreria di componenti accessibili adattata nel nostro `packages/ui`. React Router o equivalente consolidato, query client con cache e invalidazione, API OpenAPI tipizzate. PWA con offline sin dalla prima release e impostazione Capacitor-ready; i client nativi non sono richiesti per distribuire la v1.

- Design system Palimora autonomo (non copia dello stile di una demo di shadcn); nuova identità visiva ammessa, ma semantica, nomenclatura e navigazione AO3 riconoscibili.
- Interfaccia **densa ma leggibile**: elenco risultati compatto, summary/tag/statistiche ben gerarchizzati; niente card alte mezza pagina, KPI decorativi, sezioni fittizie o sovraspiegazioni.
- Topbar per biblioteca e navigazione ibrida; admin e collezioni con sidebar solo se porta beneficio. Desktop e smartphone prioritari, tablet/orizzontale pienamente previsti.
- Temi light/dark/auto e site skins; work skins sorgente per opera isolati in modo sicuro e disattivabili, senza inquinare navigazione o privilegi.
- Accessibilità concreta: tastiera, focus, screen reader, zoom elevato, contrasto, touch target, prefers-reduced-motion; non appesantire l'interfaccia normale con controlli non necessari.
- IT/EN iniziale, i18n espandibile; preferenza UI separata dalla lingua delle opere.

I campi `Input`/`Field` non destinati all’autenticazione disattivano il
completamento e dichiarano l’esclusione ai gestori password (`data-1p-ignore`,
`data-bwignore`, `data-lpignore`, `data-form-type="other"`). Password, username,
email di registrazione e codici mantengono gli attributi `autocomplete` pertinenti.
Le esclusioni sono indicazioni alle estensioni, non un blocco imposto dal sito.
Riferimenti: [1Password](https://www.1password.dev/web/compatible-website-design),
[Bitwarden](https://bitwarden.com/help/releasenotes/#2021-06-29),
[Dashlane](https://support.dashlane.com/hc/en-us/articles/4420122792594-Optimize-your-web-forms-for-Dashlane-autofill).
Il focus usa il colore del tema: contorno da 2 px aderente ai campi, distanziato
sui pulsanti e sui link. Gli avvisi mantengono un colore distinto dal focus.

## Pagine principali

| Pagina | Funzione e comportamento |
|---|---|
| Home AO3 | navigazione per fandom/tag/autori e opere, con lista compatta |
| Dashboard personale | «continua a leggere», opere seguite aggiornate, biblioteca; sezioni riordinabili/nascondibili senza editor di widget |
| Risultati/ricerca | AO3 include/exclude sidebar, ordinamenti originali + `nuove archiviate`, `aggiornate`, `nuovi capitoli`, `popolari localmente`, `non lette`; search syntax AO3 di default e help contestuale per operatori estesi |
| Opera | summary, tag, rating/warnings, note, autori sorgente, serie, statistiche originali se disponibili, capitoli, selector versione, link fonte, disponibilità |
| Reader | capitolo o Entire Work, classic/immersive, controlli che spariscono quando non necessari, selettore versione e navigazione |
| Autori/serie/tag | profili bibliografici ricostruiti da AO3, mai account locali surrogati; alias e wrangling originali |
| Libreria | bookmark, Mark for Later, history, stati di lettura, collections ACL, annotazioni, liste e raccomandazioni condivise |
| Notifiche | centro in-app, preferenze push e raggruppamento intelligente |
| Profilo | sicurezza account, dispositivi/sessioni, temi, visibilità attività, statistiche personali |
| Admin | layout tecnico distinto ma stesso design system; vedere `07-identita-admin.md` |

La ricerca ordinaria usa la proiezione bibliografica PostgreSQL e query/filtri OpenSearch; la ricerca full-text dei **capitoli** usa lo stesso indice con analizzatori per lingua e stemming (non ricerca semantica cross-lingua nella v1). L'indice non diventa fonte canonica e va ricostruito senza scaricare nuovamente il corpus. Il layout alternativo con copertine è opzionale e usa copertine vere, **mai generate artificialmente**.

## Versioni e lettura

- In assenza di selezione esplicita, apre **sempre lo snapshot corrente**. Nessun pin preferito su versioni vecchie. Con selettore semplice si possono leggere snapshot storici mantenendone fedelmente il contesto.
- Progressi: ID capitolo + offset/ancora testuale + contesto attorno al punto letto; al cambio di versione cerca corrispondenza affidabile, se non la trova riparte dal principio del capitolo corrispondente. Non perdere o sovrascrivere il progresso passato in caso di ambiguità.
- Annotazioni: associare alla revisione originale e riallinearle alle nuove tramite ancore, mantenendo l'originale in ogni caso. Contrassegnare gli spostamenti incerti in modo discreto.
- Stati di lettura e bookmark condividono l'identità opera, non si replicano per ciascuna versione; contenuto canonico serve tutti i formati di esportazione on demand.
- Work Skins: preservare dati CSS e supportare una resa fedele compatibile con sicurezza del browser; script non affidabili, URL remoti e stile che esce dal contenitore lettore non hanno permessi di esecuzione.

## Offline e mobile

- PWA installabile con app shell e store locale di opere **esplicitamente salvate offline**. Cache versionata per opera/snapshot; aggiornamenti del reader non invalidano una copia offline finché non ne esiste una nuova integra.
- Offline: leggere opere salvate, registrare progresso e annotazioni locali; al ritorno online sincronizzare eventi idempotenti con risoluzione conflitti e priorità al timestamp/ordine di revisione affidabile.
- Nessuna copia di tutti i milioni di storie sui device; limiti e gestione spazio **per dispositivo**. Notifiche push Web Push con VAPID e permessi browser; adattabilità futura per APNs/FCM, senza inventare client nativi già distribuiti.
- Mai esporre cache privata ad altri account sullo stesso device: chiave di partizione per sessione/utente, cleanup o blocco cache alla disconnessione.

## Compatibilità funzionale AO3

Studiare l'implementazione upstream per ogni concetto originale: collections, bookmarks, history/Mark for Later, subscriptions, tag alias e tassonomia, pseudonimi, report statistici disponibili, work downloads, reading preferences. **Una sola logica** per concetto nel nuovo backend. AO3 original kudos/commenti visualizzati read-only, non creare pulsanti che fingono di inviare kudos o commenti non supportati.

## Admin UX e minimalismo

Dashboard operativa configurabile con default già ben costruito, **ogni card cliccabile** verso sezione con dettagli; contatori e anomalie, non un infodump. Stati, errori e azioni brevi; le spiegazioni tecniche esistono nelle schermate diagnostiche a richiesta, non nella biblioteca. Modalità manutenzione totale: anche gli utenti già loggati vedono soltanto la pagina dedicata.

## Design system Foundation

`packages/ui` definisce token semantici per superficie, testo, separatori, accento, focus ed errore. Tipografia di sistema per i controlli e marchio serif, densità da elenco, bordi sottili, target interattivi ≥44 px. Temi `auto/light/dark` e stili `ink/forest` sono preferenze persistenti per account; `auto` segue il sistema operativo. Dialoghi modali con focus gestito e tastiera, label associate ai campi, errori annunciati tramite alert, esiti tramite status, link per saltare la navigazione e supporto reduced-motion.

Le sole destinazioni Foundation sono Account, Sicurezza, Dispositivi, Utenti e Inviti (secondo ruolo), oltre a setup/login/registrazione. Sidebar su desktop, navigazione compatta a capo su mobile, tabelle amministrative scorrevoli e paginazione. UI IT/EN completa per questi percorsi; nessuna voce di catalogo, lettore o operazioni senza funzione. React Query gestisce cache/refetch; logout e scadenza svuotano la cache. Password e codici vengono svuotati dai moduli dopo operazioni riuscite. Le conferme distruttive precisano revoca e conservazione dei dati; inviti e recovery codes vengono mostrati in dialoghi effettivi, senza persistere nei browser storage.

La panoramica `/security` contiene tre card interamente cliccabili, con icona, descrizione breve e stato reale: Password, 2FA e Passkeys. Aprono viste dedicate (`/security/password`, `/security/2fa`, `/security/passkeys`), raggiungibili direttamente e compatibili con cronologia e ricarica. Il ritorno alla panoramica è sempre visibile; la navigazione aggiorna il focus al titolo e smonta i moduli precedenti. Transizioni direzionali con View Transitions nei browser compatibili, ingresso CSS come fallback e rispetto di reduced-motion. Il cambio password richiede conferma della nuova password e mantiene la revoca delle sessioni, spiegata nel testo del campo; il pulsante è «Cambia password». L'aggiunta passkey si apre dal pulsante «+»: nome e credenziali compaiono solo nel dialogo. Il wizard 2FA si svolge inline nella pagina dedicata, senza card contenitore né dialogo, con una sola freccia indietro senza bordo per tornare al passaggio precedente. QR e sei caselle OTP sono centrati; la chiave manuale ha un’icona copia senza bordo sulla destra, con label accessibile e conferma discreta. Tornando dal backup al QR si conserva la verifica già effettuata e il codice è in sola lettura; tornando alla password si ricomincia la verifica. I tre passaggi sono: password attuale, QR/chiave copiabile e codice a sei cifre, download dei codici di backup e conferma finale. Il campo OTP è un unico input accessibile con sei caselle visive, supporta incolla/autofill e animazioni disattivate con reduced-motion. Lasciare il wizard prima della conferma non attiva il fattore. Nessun segreto del wizard viene salvato nel browser storage.

Login progressivo: inizialmente soltanto username e password, con indicazione che il campo password accetta anche un codice di backup monouso. Il secondo passaggio compare dopo la verifica della password soltanto per account con TOTP; riusa `OtpInput`, lo stesso componente a sei caselle delle impostazioni, e una freccia indietro permette di tornare alle credenziali. Le passkey disponibili sono proposte dal browser nell’autofill del campo username tramite [conditional mediation SimpleWebAuthn](https://simplewebauthn.dev/docs/packages/browser#browser-autofill); nessun pulsante passkey permanente e nessuna interrogazione pubblica per username. La richiesta WebAuthn pendente viene annullata quando si invia la password o si lascia il login e rinnovata prima della scadenza della challenge.

## Interfaccia operativa Archive Engine

Importazioni, archivio tecnico e storage riusano token, controlli e dialoghi
Foundation. Elenchi densi e azioni contestuali; stato tradotto distinto dai codici
tecnici, diagnostica espandibile, stati vuoti operativi e nessun contenuto importato
eseguito nel browser. Le viste non costituiscono il catalogo/reader della milestone 3.

Filtri e cursori delle liste batch/opere sono nell’URL, con navigazione precedente/successiva;
la selezione dello snapshot e la sezione dell’opera sopravvivono al reload.
L’ispettore affianca versioni e componenti su desktop e li dispone in sequenza su
mobile. La ricerca di componenti e le anteprime restano entro la versione scelta.
La correzione di current, metadati o identità richiede una decisione motivata nel
dialogo con focus gestito. Per i flussi amministrativi dettagliati vedere 04.

Polling: batch 2–3 s, storage 5 s, lista opere 15 s; richieste sospese in background
da React Query e refetch al ritorno. Le viste operative mostrano ora dell’ultimo
aggiornamento, refresh manuale e fallimento di aggiornamento; nessun avanzamento
inventato quando il totale è ignoto. I dettagli immutabili si caricano alla
selezione, senza polling dei contenuti.

## Consultazione AO3 implementata

`/works` usa elenchi densi, filtri condivisibili nell'URL, gruppi include/exclude,
faceting, sintassi AO3 e ordinamenti originali più data di archiviazione. I filtri
si richiudono su mobile; risultati, navigazione e lettore usano l'intera larghezza
disponibile. L'indicizzazione in corso aggiorna la lista automaticamente.
`/browse/:kind` e `/bibliography/:kind/:id` collegano fandom, tassonomia,
autori/pseudonimi, serie e collezioni; canonicalità, relazioni, profili e statistiche
compaiono solo se acquisiti. Le serie rispettano le posizioni sorgente.

`/works/:id` apre current oppure lo snapshot esplicito, Entire Work o capitolo,
con navigazione precedente/successiva, modalità immersiva, tema/font/dimensione
e Work Skin disattivabile. Le note dei capitoli sono ricostruite agli offset
originali e verificate; il layout preservato distingue note iniziali e finali.
Kudos nominativi/guest e commenti con risposte sono paginati e di sola lettura.
Le opere eliminate da AO3 restano consultabili; testo assente e statistiche
sconosciute non vengono sostituiti con contenuti o zeri inventati.

HTML filtrato, CSP e iframe sandbox senza script isolano il testo. Le risorse
locali sono autenticate e vincolate allo snapshot: immagini, SVG sanitizzati,
audio/video con Range, tracce, font e allegati. CSS preserva media query, selettori,
keyframe e font locali; gli import sono espansi solo da oggetti già acquisiti.
URL esterni, dichiarazioni eseguibili, variabili e posizione fixed sono rimossi.
Nessun fetch remoto avviene durante consultazione o download. HTML ed EPUB
trasmettono i media in streaming; il PDF usa composizione nativa e, per layout
HTML/CSS non rappresentabili, Chromium senza JavaScript/rete.
Le preferenze di lettura sono nell'URL: progressi, offline, annotazioni e altre
funzioni personali appartengono alla Milestone 5.

### Revisione di consultazione — 2026-11-07

La biblioteca usa navigazione orizzontale; account e amministrazione conservano
le proprie viste operative. Conteggio e ordinamento affiancano il titolo «Opere»,
sopra la barra di ricerca; sui piccoli schermi vanno a capo sotto il titolo.
Su desktop il conteggio segue il bordo sinistro dell’elenco; pannello Filtri
ed elenco opere condividono lo stesso bordo superiore;
su mobile i filtri precedono l’elenco. Selezioni rimovibili e filtri raggruppati.
Gli elenchi privilegiano titolo, autore, fandom, avvertenze, riassunto e statistiche;
relazioni/tag estesi e riassunti troncati sono espandibili senza lasciare la lista.

Il pannello filtri distingue le scelte in preparazione dai risultati applicati.
Il selettore di tag offre inclusione/esclusione, categoria, suggerimenti dal
catalogo e conteggi esplicitamente riferiti ai risultati attuali o alla biblioteca.
Supporta frecce, Invio ed Escape; un tag può anche essere inserito come testo esatto.
La stessa scelta spostata nel gruppo opposto viene rimossa dal gruppo precedente.
Tag e criteri applicati sono rimovibili singolarmente. Parole e statistiche usano
minimo/massimo con validazione, mantenendo disponibile la sintassi AO3; stato,
lingua e date hanno controlli dedicati. «Azzera» conserva ricerca e contesto
bibliografico; l'ordinamento applica anche le scelte in preparazione. Su mobile e
tablet, applicare richiude il pannello e porta ai risultati. URL e cronologia
restano la rappresentazione dei filtri applicati, senza preferenze personali.

Tag e lingue condividono lo stesso combobox: freccia di apertura, ricerca,
conteggi, selezione da tastiera/touch e valori rimovibili. Le lingue si selezionano
insieme: basta che l’opera appartenga a una delle lingue scelte (OR), mantenendo
in AND gli altri filtri. La ricerca consulta tutte le lingue realmente presenti nel catalogo,
anche quando i risultati correnti sono già filtrati. Il pannello Filtri è l’unico
punto di selezione dei criteri: suggerimenti e conteggi restano nei selettori,
senza un secondo menu «Filtra nei risultati». Le pagine di esplorazione riusano gerarchia,
ricerca e paginazione del catalogo; aprire un'opera conserva il collegamento ai
risultati di provenienza anche dopo un cambio di capitolo, versione o aspetto.
La paginazione aperta da un link diretto propone «Prima pagina» senza rimandare
a una pagina esterna. Conteggi e date delle versioni seguono la lingua UI.

Il lettore dispone titolo e informazioni bibliografiche sopra una pagina continua:
l'iframe isolato si adatta al contenuto, inclusi media caricati successivamente.
La barra di lettura resta raggiungibile durante lo scorrimento. Aspetto e versioni
si aprono in dialoghi dedicati; la modalità concentrazione occupa lo schermo,
esclude la navigazione sottostante dal focus e si chiude anche con Escape.
I cambi di aspetto mantengono il contenuto visibile durante la richiesta.

Il tema iniziale segue il sito, salvo scelta esplicita nell'URL. Sfondo, colore e
geometria della pagina appartengono al lettore: in scuro la palette prevale anche
sui colori espliciti delle Work Skins e sugli stili inline. Struttura e media
restano preservati; in chiaro le decorazioni interne della skin restano visibili.
Nessuno script importato viene abilitato per il ridimensionamento dell'iframe.

«Scarica opera» è distinto dai comandi di lettura: apre la scelta EPUB/HTML/PDF,
poi avvia il download soltanto dal pulsante del formato selezionato. L'operazione
usa sempre l'opera intera nello snapshot visualizzato; preparazione ed errori
sono espliciti e non vengono proposti download per opere prive di testo.

### PDF da lettura

Formato libro 170 × 250 mm: titolo e autori centrati nel frontespizio, riassunto
e soli metadati disponibili; indice navigabile su pagina separata, poi testo,
note e media canonici. Numeri di pagina e rimandi dell’indice sono reali.
Prosa giustificata con rientro e ultima riga naturale; righe brevi, interruzioni
esplicite, citazioni e impaginazioni strette non vengono allargate artificialmente.
Le Work Skins complesse conservano il rendering HTML; la geometria della pagina
è propria del PDF. HTML ed EPUB mantengono la loro impaginazione.

## Pannello AO3

`/admin/ao3` separa Panoramica, Coda, Media da recuperare, Attività e Impostazioni
con navigazione nell'URL. Stato effettivo e pausa rimangono visibili; Auto/Online/Offline
sono controlli radio espliciti. Nessun menu `details` per funzioni operative.
La coda distingue disponibilità del servizio, pausa individuale, scadenza e avvio
effettivo; durante manutenzione mostra «Alla ripresa del servizio». Filtri e
paginazione sono nell'URL, righe adattate al mobile. Le sonde hanno una cronologia
separata dalle acquisizioni.

Media da recuperare elenca soltanto fallimenti confermati 404/410, con fonte,
ultima verifica, copie già conservate e opere coinvolte. Selezionare una risorsa
apre il dialogo di recupero: URL non editabile, file locale e avanzamento reale;
la copia entra nella coda locale esistente. Errori temporanei e URL non ancora
verificati non vengono presentati come irrecuperabili.

### Biblioteca personale: prima integrazione

`/library` espone bookmark, Mark for Later e cronologia tramite viste nell'URL,
filtri e paginazione. Il lettore riusa lo stesso editor dei bookmark della
biblioteca: note testuali, tag personali (uno per riga) e raccomandazione.
I bookmark creati da questa UI sono privati. Il modulo conserva il testo in caso
di conflitto e richiede di riaprire la versione aggiornata prima di salvare.
Collezioni, progressi e annotazioni sono descritti nella sezione successiva.

### Collezioni, progressi e annotazioni

La biblioteca collega `/collections` e il lettore/editor bookmark offre
«Aggiungi a collezione». Dettagli, opere, inviti e membri condividono i componenti
esistenti; le azioni dipendono dal ruolo restituito dal server. L'eliminazione
richiede conferma e conserva le opere archiviate.

Il lettore campiona la posizione testuale dopo lo scorrimento e salva dopo una
breve stabilizzazione. Stato e percentuale sono visibili anche in biblioteca.
«Riprendi lettura» usa la posizione riallineata nella versione selezionata, senza
forzare uno snapshot storico. Un conflitto conserva la posizione locale in memoria
e offre esplicitamente quella locale o quella salvata. Le annotazioni si creano
dalla selezione del testo; mostrano citazione, autore, condivisione e collegamento
alla versione originale. Il mancato riallineamento rimane visibile.

### Esperienza sociale, statistiche e notifiche

La biblioteca collega statistiche, attività, sottoscrizioni e centro notifiche.
Opere, autori e serie offrono lo stesso controllo di sottoscrizione; il comando
«Consiglia» nelle opere salvate e nel lettore invia una nota privata. Preferenze
con destinatari distinti per attività e statistiche; profili non autorizzati non
rivelano dati. Elenchi condivisi attraverso le collezioni esistenti.

Statistiche con etichette che distinguono opere completate, parole di quelle opere
e tempo attivo misurato; andamento dei completamenti in UTC. Notifiche persistenti
lette/non lette, filtro non lette e aggiornamento periodico ogni 30 s. Preferenze
per consigli, aggiornamenti, push e aggregazione singola/5 minuti/ora. Attivazione
push soltanto su gesto esplicito, permessi negati gestibili, elenco dispositivi e
revoca. IT/EN e layout compatti desktop/mobile/tablet.

### Integrazione offline (5C)

«Salva offline» nel lettore e «Offline» nella navigazione della biblioteca.
Elenco compatto per opera/versione con dimensione, data, apertura, rimozione e
nuova versione disponibile; spazio del browser, richiesta di persistenza e
installazione nello stesso percorso. Navigazione offline limitata alle copie:
capitoli, Entire Work, aspetto, Work Skins e lettura immersiva riusano il reader.

Progresso/stato e note proprie si salvano sul dispositivo; l'indicazione distingue
il salvataggio locale dalla conferma server. Riconnessione e riapertura online
riprendono la coda, con retry periodico mentre l'app è aperta. I conflitti mostrano
valore locale/server e scelta esplicita; una nota non più condivisibile può essere
conservata come nuova nota privata. Nessun merge automatico di testi o permessi.
Le note nuove senza rete sono private; una condivisione già esistente viene
ricontrollata dalle ACL durante il replay. La sincronizzazione non richiede il
supporto browser a Background Sync e riparte alla successiva apertura.

Revisione della biblioteca: navigazione personale uniforme anche nelle collezioni,
nessun collegamento duplicato alle collezioni, stato locale visibile nel lettore,
conferma prima di eliminare modifiche non inviate al logout. Installazione e
aggiornamento applicativo non modificano le copie delle opere.
