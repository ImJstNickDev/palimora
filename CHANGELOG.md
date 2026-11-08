# Changelog

## 1.0.0 — 2026-11-08

Prima release completa, verificata localmente su servizi isolati e su uno ZIP
AO3 reale di 11.032 opere.

- Setup Owner atomico, account locali, inviti, sessioni, passkey e TOTP.
- Ingest ZIP/SQLite riprendibile, storage canonico Zstandard, deduplicazione,
  provenienza e conservazione delle versioni storiche.
- Catalogo e filtri AO3, ricerca OpenSearch, bibliografie, lettore e download.
- Biblioteca personale, collezioni con ACL, progressi, annotazioni, notifiche e
  lettura PWA offline con riconciliazione.
- Scheduler AO3, watchlist, sincronizzazione e gestione dell'indisponibilità.
- Backup piattaforma/completi, restore isolato, export completi/incrementali,
  volumi fino a 2 GiB, CLI standalone e destinazioni esterne protette.
- Dashboard operativa, collector Docker ristretto, manutenzione, scrub e
  recupero dell'integrità, audit e impersonazione amministrativa.

Verificati backup/restore del corpus e dei dati personali, CLI a servizi spenti,
checkpoint, autorizzazioni e recovery da corruzione controllata. Ottimizzati
lookup SQL, reingest, export e bundle iniziale; corretti reset di sviluppo con
riferimenti personali e navigazione Operations mobile.

Requisiti e installazione in [02](docs/02-architettura.md#avvio-della-produzione).
Misure, campioni e condizioni nel [report prestazionale](docs/10-performance-report.md).

Limiti: integrazione remota ufficiale AO3 non verificata end-to-end; ingest dei
923,7 GiB non eseguito; benchmark sul corpus di prova, non su milioni di opere.
Le verifiche responsive/PWA non attestano dispositivi mobili fisici. La release
del codice non pubblica né distribuisce un'istanza, dati personali o opere.
