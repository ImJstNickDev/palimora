# Componenti e attribuzioni

Il codice originale Palimora è distribuito sotto [MIT](LICENSE). Questa licenza
non sostituisce quelle delle dipendenze, dei servizi esterni o delle opere
eventualmente importate. Il repository non distribuisce opere AO3 o dump.

## npm e frontend

[Inventario delle versioni e licenze](licenses/npm-inventory.json), ricavato dal
lockfile. `npm run notices` lo rigenera insieme alle
[attribuzioni complete del browser](apps/web/public/third-party-notices.txt),
incluse nella build web all'URL `/third-party-notices.txt`. `npm run build`
verifica che siano aggiornate. Non vengono distribuiti `node_modules` nel repo;
le immagini API costruite localmente conservano le licenze dei pacchetti installati.

Le dipendenze npm sono prevalentemente MIT, ISC, BSD e Apache-2.0. Eccezioni:

- `web-push` 3.6.7: [MPL-2.0](https://github.com/web-push-libs/web-push/tree/v3.6.7).
  Usato senza modifiche; i sorgenti installati in `node_modules/web-push/src`
  e la licenza rimangono nell'immagine API. Non viene incluso nel bundle browser.
- `pako`: MIT e Zlib, come dichiarato dal pacchetto.
- `caniuse-lite`: dati CC-BY-4.0; `mdn-data`: CC0-1.0. Conservare le rispettive
  attribuzioni quando si ridistribuiscono i pacchetti di sviluppo.
- `busboy` e `streamsearch` omettono il campo nel lockfile: le copie installate
  contengono il testo MIT nei rispettivi file `LICENSE`.

Alcuni pacchetti browser omettono il file della licenza nel tarball npm. Gli
avvisi supplementari in `licenses/` provengono da Radix UI, commit
`fcef0668a5c827e5a4baac405474d75680f9a4eb`, e react-remove-scroll-bar, commit
`8ca9ba5ea52de03308fe8ced94f7b159a44d28ff`. Per `@epic-web/invariant` 1.0.0 anche
l'upstream omette il file: sono riportati i termini MIT dichiarati in README e
package metadata, con attribuzione all'autore Kent C. Dodds.

## Servizi e componenti nativi

| Componente | Licenza e distribuzione |
|---|---|
| PostgreSQL 17 | [PostgreSQL License](https://www.postgresql.org/about/licence/), immagine upstream separata |
| OpenSearch 2.19 | [Apache-2.0](https://github.com/opensearch-project/OpenSearch/blob/2.19.4/LICENSE.txt), immagine upstream separata |
| Redis 7.4.6 | [RSALv2 oppure SSPLv1](https://github.com/redis/redis/blob/7.4.6/LICENSE.txt), immagine upstream separata; non è MIT né una versione sotto licenza OSI |
| Nginx | [BSD a due clausole](https://nginx.org/LICENSE), immagine upstream |
| Node.js | [MIT e avvisi inclusi](https://github.com/nodejs/node/blob/v22.21.1/LICENSE), immagine upstream |
| Zstandard | BSD oppure GPLv2; si usa la distribuzione Debian e si conservano gli avvisi di `/usr/share/doc` |
| OpenSSL 3 | Apache-2.0; licenze conservate dai pacchetti Debian |
| Typst 0.15.1 | Apache-2.0; installer con checksum, `typst-LICENSE` e `typst-NOTICE` inclusi accanto al binario |
| Chromium e font | Componenti con licenze proprie, distribuiti dai pacchetti Debian con i relativi copyright in `/usr/share/doc` |

La release GitHub pubblica i sorgenti e le ricette di build, senza allegare
immagini o binari di terzi. Chi ridistribuisce immagini modificate deve mantenere
gli avvisi e soddisfare gli obblighi di sorgente dei componenti inclusi.

## AO3 e materiali dimostrativi

[OTW Archive](https://github.com/otwcode/otwarchive) è un riferimento di comportamento,
non una dipendenza incorporata. Il suo codice è GPL-2.0-or-later: la revisione del
repository Palimora non ha individuato sorgenti Rails, template o asset upstream
copiati. Parser e interfacce sono implementazioni indipendenti. Un futuro riuso
di codice upstream richiede una nuova verifica della compatibilità di licenza.
Palimora non è affiliata a OTW/AO3 e non concede diritti sui contenuti importati.

`unslop-story/story.html` e `unslop-story/palimora.mp4` documentano la revisione UI
con contenuto sintetico. Metodo e renderer: **Unslop, Damir Sokolovsky
(@heydamir)**, <https://heydamir.design/unslop>,
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). La presentazione è
adattata all'interfaccia Palimora; l'attribuzione originale è conservata.
