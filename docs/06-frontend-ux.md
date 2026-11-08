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
Il focus automatico continua a gestire tastiera e screen reader, senza disegnare
riquadri sui titoli o sugli elementi di destinazione dopo reload e cambi di stato.
Mouse e touch non attivano contorni di focus; digitare in un campo raggiunto col
puntatore non cambia questa modalità. Tab e i comandi di navigazione da tastiera
abilitano un indicatore neutro da 1 px: bordo del campo per gli input, linea
inferiore per le ricerche senza bordo, contorno leggermente distanziato per
pulsanti e link. I controlli con input nascosti
(selezioni e OTP) mostrano l'indicatore sul controllo visibile. Le selezioni
persistenti, come un'opera salvata, restano distinte dal focus temporaneo.
Al reload la modalità riparte senza indicatori; il primo Tab li riattiva. Con
colori forzati si mantiene un contorno di sistema visibile. Gli avvisi restano
distinti dal focus e non cambiano colore.

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
Tema, font, dimensione e interlinea sono salvati sul dispositivo per account;
l'URL può sovrascriverli. Progressi, offline e annotazioni sono integrati nella
Milestone 5.

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

Il tema Automatico segue il sito; una scelta esplicita persiste sul dispositivo. Sfondo, colore e
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

`/library` espone Opere salvate, Mark for Later e cronologia tramite viste
nell'URL, filtri e paginazione. «Salva in biblioteca» salva immediatamente senza
richiedere note o tag. Il menu mostra le collezioni disponibili, «Nuova collezione»
come prima scelta di organizzazione e un segno sulle collezioni che contengono
l'opera. Un divisore separa il salvataggio dalla sezione collezioni;
«Nuova collezione» e la lista seguente sono contigue, senza divisori intermedi.
Le voci sono toggle: un secondo clic rimuove l'opera dalla collezione.
Il menu resta aperto per organizzare più collezioni. Ogni aggiunta salva
anche l'opera nella biblioteca personale di chi agisce, nella stessa transazione.

«Note e tag personali», nel menu dell'opera salvata, apre i dettagli privati:
note testuali, tag (uno per riga) e raccomandazione. Il modulo conserva il testo in
caso di conflitto e richiede di riaprire la versione aggiornata prima di salvare.
La voce «Salva in biblioteca» diventa «Salvato in biblioteca», con bookmark
pieno; un secondo clic rimuove il salvataggio. La conferma compare soltanto se
sono presenti note, tag o stato «Consigliata» da eliminare. Collezioni, progressi
e annotazioni rimangono disponibili. Il comando separato di rimozione scompare.
Il bookmark è pieno anche sul pulsante che apre il menu; le voci toggle espongono
lo stato selezionato alle tecnologie assistive e si aggiornano dopo la conferma
server, mantenendo lo stato precedente in caso di errore.
I vecchi bookmark sono le opere salvate: nessuna migrazione o duplicazione dei
dati. Le collezioni preesistenti restano accessibili con gli stessi contenuti.

### Collezioni, progressi e annotazioni

La biblioteca comprende `/library/collections`; il lettore offre il solo menu di salvataggio
per organizzare le opere. Dettagli, opere, inviti e membri condividono i componenti
esistenti; le azioni dipendono dal ruolo restituito dal server. L'eliminazione
richiede conferma e conserva opere archiviate e salvataggi personali. Rimuovere
un'opera da una collezione non la rimuove dalla biblioteca personale.
La lista collezioni usa il solo divisore sotto le tab prima della prima voce;
i separatori delle righe successive restano visibili. Il ruolo del proprietario
compare soltanto nel menu Membri e condivisione; nella lista si mostrano solo
«Puoi modificare» e «Sola lettura» per le collezioni ricevute.
Membri e condivisione si apre dall’icona utenti accanto alle azioni della collezione.
Il proprietario cerca e seleziona utenti da una lista paginata, sceglie il permesso
e invia gli inviti, anche multipli. Membri e inviti già presenti sono esclusi
dalla ricerca. Nel menu compaiono tutti i membri, con stato dell’invito e, per
il proprietario, azioni per modificare il permesso o confermare la rimozione.
Gli altri membri consultano la lista senza comandi di gestione.
Il dettaglio usa il nome della collezione come titolo, senza la label superiore
«Biblioteca personale». Mostra direttamente l’elenco delle opere, senza titolo «Opere» né
pulsante «+» verso la Biblioteca; si aggiungono opere dal loro menu di salvataggio.
Anche qui il primo elemento non aggiunge un divisore sotto quello delle tab;
restano i separatori tra le opere.

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
«Consiglia» nelle opere salvate e nel lettore invia un consiglio privato a uno o più utenti. Preferenze
di condivisione per la sola attività; profili non autorizzati non rivelano dati.
La pagina Attività di lettura in Biblioteca mostra la propria attività, senza
barra di ricerca utenti; i vecchi parametri `username` vengono rimossi dall’URL.
Le statistiche in Biblioteca riguardano esclusivamente l'utente autenticato,
senza ricerca di altri utenti e senza impostazioni di condivisione. I vecchi
parametri `username` nella pagina vengono rimossi. Admin/Owner aprono invece
`/admin/users/:id` dalla lista utenti: tab Account per le azioni di gestione
esistenti e tab Statistiche (`/admin/users/:id/statistics`) per la consultazione
amministrativa, anche degli account disabilitati o eliminati logicamente. Ricerca
e pagina della lista utenti restano nell’URL passando fra scheda e tab, così il
ritorno alla lista le conserva anche dopo un reload. Elenchi condivisi attraverso
le collezioni esistenti.

Statistiche con etichette che distinguono opere completate, parole di quelle opere
e tempo attivo misurato; andamento dei completamenti in UTC. Notifiche persistenti
lette/non lette e aggiornamento periodico ogni 30 s. Titolo «Notifiche» senza
contatore; filtro compatto Tutte/Non lette nell’URL, conteggio solo se positivo.
Le righe mostrano titolo, motivo e data breve (ora oggi, Ieri, data nei giorni
precedenti), con data completa accessibile. Un pallino e il peso del titolo
segnalano le non lette senza spostare il testo. Note storiche espandibili.
Aprire una notifica la segna letta; un’azione laterale permette di cambiare stato.
«Segna tutte come lette» nell’intestazione opera su tutte le notifiche dell’utente,
non solo sulla pagina caricata. Stato vuoto distinto tra «Nessuna notifica» e
«Hai letto tutte le notifiche». Preferenze
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

La pagina Offline mostra una sola riga per opera: titolo che apre il reader e
cestino. Nessun riepilogo, data, dimensione o dettaglio delle versioni nell’elenco.
Le versioni restano conservate e accessibili dal reader; il titolo apre quella
corrente verificata se scaricata, altrimenti l’ultima salvata. Il cestino rimuove
atomicamente tutte le copie locali dell’opera, dopo conferma, preservando le altre
opere e rifiutando la rimozione se ci sono modifiche dell’opera ancora da inviare.
Installazione, conservazione persistente e rimozione di tutte le copie stanno nel
menu del dispositivo. Quota e utilizzo del sito sono stime del browser, distinte
dai byte delle copie; non vengono presentati come spazio libero del dispositivo.
Caricamento, errori con retry e archivio vuoto hanno stati espliciti. L’assenza di
supporto al salvataggio offline viene segnalata senza impedire la consultazione
di copie esistenti. La sincronizzazione distingue attività in corso, attesa di
connessione e conflitti raggruppati per modifica, con titolo dell’opera coinvolta.


### Revisione visiva dopo la milestone 5

Il reader mantiene titolo serif e tema del foglio indipendente dal sito. Le azioni
personali sono visibili sotto titolo e statistiche, con icone e nomi accessibili:
offline e «Salva in biblioteca» precedono più tardi, consiglio e sottoscrizione.
Su telefono le azioni restano centrate sotto le statistiche. AO3, versioni e
download sono allineati verticalmente e passano insieme alla riga successiva
quando non c'è spazio accanto al ritorno all'elenco. I comandi del reader usano
icone con nomi accessibili e target di almeno 44 px; il selettore capitoli cede
spazio ai comandi e tronca i titoli lunghi senza allargare la pagina.
Il pulsante di salvataggio diventa «Salvato in biblioteca» quando l'opera è salvata.
Collezioni e dettagli personali stanno nello stesso menu ancorato, senza oscurare
la pagina. Il retry di creazione riusa l'identità della collezione creata.
Consiglio privato e sottoscrizione usano lo stesso tipo di menu.
«Consiglia» mostra subito i nomi utente disponibili, in ordine alfabetico, con
ricerca, selezione multipla e pulsante «Invia», senza campo nota. Sono esclusi sé
stessi, account disattivati/eliminati e utenti che non accettano consigli.
Le selezioni restano visibili filtrando o caricando altre pagine. Gli invii
riusciti vengono marcati; gli errori rimangono accanto al destinatario e «Riprova»
invia soltanto i consigli rimasti. Una conferma finale elenca i destinatari.
La sottoscrizione mostra tre scelte dirette, evidenzia quella selezionata e
conferma il salvataggio. Le icone di salvataggio e sottoscrizione indicano lo stato
attivo. Si apre un solo menu per volta; Escape chiude e restituisce il focus al
pulsante, l'apertura porta il focus al primo campo o alla scelta corrente.
I menu restano entro il viewport e scorrono internamente se necessario.
«Leggi» o «Riprendi lettura» precede i dettagli; avvertenze e rating restano
visibili, il riassunto è espandibile.

Il selettore capitoli occupa lo spazio del comando corrente, con un limite per i
titoli lunghi. In concentrazione capitolo/aspetto/uscita stanno sopra il testo;
percentuale e «Lettura e annotazioni» stanno nella barra inferiore, fra precedente
e successivo. In Opera intera questi pulsanti scorrono fra i capitoli senza
cambiare modalità. La percentuale visibile segue l'offset testuale durante lo
scorrimento; «Da salvare», «Salvataggio…», «Salvato» e salvataggio locale distinguono
la posizione in vista dalla conferma di persistenza.

Il pannello annotazioni non sposta il testo: stato in alto, note direttamente
visibili con citazione e azioni per il passaggio. Ha chiusura esplicita ed Escape;
resta possibile selezionare il testo. Il pulsante «Annota selezione» segue la
selezione nell'iframe, resta nei limiti dello schermo e scompare quando il
passaggio non è visibile. L'editor separa citazione, nota, visibilità e azioni.
Il campionamento continua a pannello chiuso; errori e conflitti offline restano
visibili. Un conflitto di posizione apre i controlli di risoluzione.

Ingresso/uscita dalla concentrazione e cambi di aspetto conservano l'ancora
visibile senza sovrascrivere il progresso con lo spostamento causato dal layout.
Font, dimensione e interlinea aggiornano l'iframe senza ricaricarlo; tema e skin
ripristinano l'ancora dopo il caricamento. Dimensione da 14 a 28 px e interlinea
compatta/normale/ampia (1,55/1,7/1,85), con etichette accessibili. Automatico
ripristina il legame con il tema del sito. Il documento dichiara la lingua
catalogata, o `und` quando non riconosciuta.

Cambiare capitolo azzera la selezione precedente e porta il focus al testo senza
contorni sul titolo, sul capitolo o sull’iframe. La regola viene applicata nel
documento isolato del reader, anche alle copie già salvate; i link mantengono il
proprio focus da tastiera. L'editor conserva la selezione usata per aprirlo.
Versione corrente, versione storica e copia offline sono distinte confrontando lo
snapshot effettivo con quello corrente, anche quando lo snapshot corrente è
esplicito nell'URL.

Controlli condivisi con raggio 8 px e target minimo 44 px; spaziature su passi
di 4 px, navigazione personale con lo stesso indicatore di selezione, etichette
in sentence case e titoli a peso 500. Si conservano palette ink/forest, temi
light/dark/auto e font locali. Nessuna immagine decorativa nel reader.

La verifica della revisione copre desktop 1440 px, tablet 820 px e mobile 390 px,
modalità immersiva/Esc, dettagli personali e tema scuro del testo. I test Chromium
su database temporaneo verificano l'ancora visibile e la revisione salvata durante
i cambi di modalità/aspetto, assenza di richieste per modifiche tipografiche,
ripresa, focus dei capitoli, selezioni invalidate e controlli senza spostamenti
del testo. Coprono inoltre annotazioni, isolamento Work Skin e il percorso offline
completo con riavvio, conflitti e separazione degli account.
La regressione Firefox copre anche paragrafi con nodi testuali lunghi: il calcolo
usa le API caret disponibili oppure cerca la riga visibile nel nodo, senza
ripiegare sull'inizio del paragrafo. Verificati su Firefox anche il contenuto
locale dell'opera AO3 85167866, i menu e la posizione dell'azione di annotazione;
i contenuti dell'opera non sono inclusi nei fixture del repository.
Lo story video in `unslop-story/palimora.mp4` (9,2 s, 2160 × 2160, 30 fps)
mostra la trasformazione su contenuto sintetico; `story.html` ne conserva le
fasi CSS. Metodo e renderer: Unslop di Damir Sokolovsky (@heydamir), CC BY 4.0.

### Biblioteca personale: navigazione e stile Fandom

Biblioteca e tutte le sottopagine personali riusano `catalog-heading` e lo stile
delle tab della pagina Fandom (`/browse/fandom`): contesto «Biblioteca
personale», titolo serif della vista corrente, selezione con superficie tenue.
Un solo selettore comprende Opere salvate, Da leggere più tardi, Cronologia,
Collezioni, Offline, Statistiche, Attività, Sottoscrizioni, Notifiche e Privacy e
notifiche. Le destinazioni sono `/library` (salvate), `/library/later`,
`/library/history`,
`/library/collections` (con dettagli `/:id`), `/library/offline`,
`/library/statistics`, `/library/activity`, `/library/subscriptions`,
`/library/notifications` e `/library/settings`. `kind` resta un filtro del
contratto API per i tre elenchi di opere. Le vecchie route e `/library?kind=…`
reindirizzano sostituendo la voce nella cronologia, preservando query, frammento
e stato di navigazione. I collegamenti interni e Web Push usano gli URL canonici.
Soltanto la vista corrente ha `aria-current`, anche dopo reload o navigazione
nella cronologia del browser.
I dettagli di una collezione mantengono selezionata Collezioni. Senza rete resta
solo Offline, come nella navigazione principale.

Intestazione, larghezza disponibile, separatori e ricerca seguono Fandom anche
nelle sottopagine. Le barre di ricerca mantengono label accessibili, filtri e
invio da tastiera e azzeramento esplicito. Su smartphone ricerca e invio stanno
sulla stessa riga, il tag personale sulla seconda. La navigazione personale è
una riga scorrevole con frecce, titoli testuali e sezione attiva sempre in vista.
Le azioni delle righe usano icone con nome accessibile, tooltip e target 44 px;
conferme e moduli mantengono testi espliciti. Gli elenchi mantengono note, tag e
progressi. Il filtro notifiche non lette è nell'URL e sopravvive al reload.
Statistiche a quattro colonne su desktop e due su telefono, senza card decorative.
La PWA parte da `/library/offline`; conserva `/` come identità applicativa
per non duplicare le installazioni esistenti.

Verifica: dieci destinazioni personali, redirect dai vecchi indirizzi con filtri
preservati, ricerca da tastiera e selezione unica dopo reload e avanti/indietro.
Controlli a 320/390/820 px e lista opere anche a 1280 px; tab attiva visibile dopo
ridimensionamento. Build web e test browser biblioteca, collezioni/annotazioni,
funzioni sociali e ciclo offline con riavvio e isolamento account superati.


## Backup Manager — 6A.3

`/admin/backups`, per Owner/Admin: tre sezioni Operazioni, Destinazioni e
Pianificazioni. Storico paginato, dettaglio collegabile tramite URL, avanzamento
con fase/contatori reali, azioni coerenti con stato e capacità del motore.
Creazione distingue completo, piattaforma ed export con base incrementale;
file e checksum sono nel dettaglio, informazioni tecniche espandibili. Mobile:
navigazione su una riga, comandi compatti, storico con modalità/stato/dimensione;
data e destinazione restano nel dettaglio.

Restore solo Owner: verifica del target autorizzato, conseguenze e conferma
scritta; nessun percorso filesystem inserito dal browser. Destinazioni con spazio,
disponibilità e messaggi operativi; configurazione solo di etichetta/abilitazione.
Pianificazioni con attivazione esplicita, frequenza e conservazione. Contratto
operativo e limiti in [08](08-backup-export.md#administration--integration--6a3).

## Dashboard operativa — 6B.1

Home amministrativa `/admin`: sezioni ordinate Attività, Container, Prestazioni
API e Spazio, configurabili per account senza framework di widget. Quattro card
compatte e interamente navigabili mostrano backlog e anomalie; le misure dettagliate
restano in tabella o nei grafici delle pagine dedicate. Stato del collector,
valori assenti e timestamp di campionamento sono espliciti.

`/admin/operations/metrics`: sorgente, metrica e intervallo, grafico SVG con
campioni consultabili e tabella accessibile; i buchi temporali interrompono la
linea. `/admin/operations/jobs`: filtro per famiglia/stato, dettaglio collegabile,
cronologia e soli controlli ammessi dal backend. Mobile: card su due colonne,
comandi compatti, tabelle tecniche scorrevoli; tablet mantiene la gerarchia delle
sezioni. Navigazione, dialoghi e focus riusano il design system esistente.
