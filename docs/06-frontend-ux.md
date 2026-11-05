# 06 — Frontend, ricerca, lettura e UX

## Stack e disciplina visiva

React + TypeScript + Vite, libreria di componenti accessibili adattata nel nostro `packages/ui`. React Router o equivalente consolidato, query client con cache e invalidazione, API OpenAPI tipizzate. PWA con offline sin dalla prima release e impostazione Capacitor-ready; i client nativi non sono richiesti per distribuire la v1.

- Design system Palimora autonomo (non copia dello stile di una demo di shadcn); nuova identità visiva ammessa, ma semantica, nomenclatura e navigazione AO3 riconoscibili.
- Interfaccia **densa ma leggibile**: elenco risultati compatto, summary/tag/statistiche ben gerarchizzati; niente card alte mezza pagina, KPI decorativi, sezioni fittizie o sovraspiegazioni.
- Topbar per biblioteca e navigazione ibrida; admin e collezioni con sidebar solo se porta beneficio. Desktop e smartphone prioritari, tablet/orizzontale pienamente previsti.
- Temi light/dark/auto e site skins; work skins sorgente per opera isolati in modo sicuro e disattivabili, senza inquinare navigazione o privilegi.
- Accessibilità concreta: tastiera, focus, screen reader, zoom elevato, contrasto, touch target, prefers-reduced-motion; non appesantire l'interfaccia normale con controlli non necessari.
- IT/EN iniziale, i18n espandibile; preferenza UI separata dalla lingua delle opere.

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

La ricerca ordinaria combina metadati e filtri in PostgreSQL; la ricerca full-text dei **capitoli** usa OpenSearch con analizzatori per lingua e stemming (non ricerca semantica cross-lingua nella v1). L'indice non diventa fonte canonica e va ricostruito senza scaricare nuovamente il corpus. Il layout alternativo con copertine è opzionale e usa copertine vere, **mai generate artificialmente**.

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
