# Sviluppare Palimora

Leggere [AGENTS.md](AGENTS.md), [architettura](docs/02-architettura.md) e le
specifiche del dominio modificato. Le versioni storiche e i contratti di storage
non possono essere persi o riscritti per semplificare una modifica.

## Ambiente

Linux, Node ≥22.12 con header della stessa major, npm, Python 3, g++, OpenSSL 3,
`libssl-dev`, `libzstd-dev`, `zstd`, Docker Engine e Compose v2. Per browser/PDF
servono Chromium, font Noto e Typst; la build Docker li installa.

```sh
# Debian/Ubuntu, oltre a Node e Docker già installati:
sudo apt-get install -y python3 g++ libssl-dev libzstd-dev zstd
npm ci
npm run build
node node_modules/@playwright/test/cli.js install --with-deps chromium
./scripts/verify-release.sh
```

Per toolchain installate in percorsi personalizzati, il build nativo accetta
`NODE_INCLUDE_DIR` e `ZSTD_INCLUDE_DIR`. I file `node_api.h`, `zstd.h` e `zdict.h`
devono essere disponibili; la build Docker fornisce questi prerequisiti senza
usare SDK locali al repository.

La verifica integrata crea e rimuove servizi di test propri. Richiede Docker
accessibile e spazio per OpenSearch; `TMPDIR` e `PALIMORA_TEST_ROOT` devono
indicare directory esistenti con spazio libero. Non usare database o storage
produttivi. Per una modifica circoscritta eseguire il percorso pertinente,
senza ripetere benchmark o suite non interessate.

L'avvio locale di API/Vite e la review tramite Compose sono descritti in
[02](docs/02-architettura.md#ambiente-di-review-ui-con-live-reload). I dump sono
opzionali per sviluppare e testare: i test ordinari generano fixture sintetiche.
I benchmark con corpus reale richiedono sorgenti private, mai incluse nelle PR.

## Modifiche e verifica

- Aggiungere migrazioni, senza cambiare quelle già applicate.
- Aggiornare contratti, API, UI e documentazione dello stesso comportamento.
- Testare transazioni, ACL, storage e recupero quando interessati; evitare mock
  produttivi e nuove suite che duplicano controlli esistenti.
- Dopo cambi alle dipendenze: `npm ci`, `npm run notices` e `npm audit`.
  Committare lockfile e attribuzioni aggiornate.
- Nelle PR indicare comportamento risultante, verifiche eseguite e limiti reali.

Non aggiungere credenziali, `.env`, database, backup, opere, log di utenti o
screenshot privati. Segnalazioni di sicurezza: [SECURITY.md](SECURITY.md).
Contribuendo si concede il proprio codice sotto la [licenza MIT](LICENSE),
conservando le licenze e attribuzioni di eventuali componenti terzi.
