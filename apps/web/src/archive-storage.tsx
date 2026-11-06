import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Button, Modal, Field } from "@palimora/ui";
import { call } from "./api";
import {
  Heading,
  Loading,
  QueryError,
  Feedback,
  useAction,
  useText,
} from "./shared";
import {
  bytes,
  number,
  date,
  Status,
  Empty,
  Facts,
  Live,
  Diagnostic,
} from "./archive-common";
export function ArchiveStorage() {
  const t = useText(),
    a = useAction(),
    client = useQueryClient();
  const [confirm, setConfirm] = useState<"compact" | "collect" | "reset_dev">(),
    [confirmation, setConfirmation] = useState(""),
    [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const q = useQuery({
    queryKey: ["archive-storage"],
    queryFn: () => call("archiveStorage", {}),
    refetchInterval: 5000,
  });
  const kindName = (kind: string) =>
    kind === "reset_dev"
      ? t("Reset archivio di sviluppo", "Reset development archive")
      : kind === "compact"
        ? t("Compattazione pack", "Pack compaction")
        : t("Recupero spazio", "Space reclamation");
  const busy = q.data?.jobs.some((j) =>
    ["pending", "running"].includes(j.state),
  );
  const resetFailed = q.data?.jobs.some(
    (j) => j.kind === "reset_dev" && j.state === "failed",
  );
  const free = q.data?.available_bytes,
    total = q.data?.total_bytes;
  return (
    <div className="archive-view">
      <div className="archive-page-heading">
        <div>
          <p className="eyebrow">Archive Engine</p>
          <Heading>{t("Storage archivistico", "Archive storage")}</Heading>
        </div>
        <Live
          updated={q.dataUpdatedAt}
          fetching={q.isFetching}
          error={q.isError}
          refresh={q.refetch}
        />
      </div>
      {q.isPending ? (
        <Loading />
      ) : q.isError && !q.data ? (
        <QueryError retry={() => void q.refetch()} />
      ) : (
        q.data && (
          <>
            <div className="archive-disk">
              <div className="archive-section-heading">
                <h2>{t("Spazio del filesystem", "Filesystem space")}</h2>
                <strong>
                  {bytes(free)} {t("disponibili", "available")}
                </strong>
              </div>
              {total != null && total > 0 && free != null ? (
                <>
                  <meter
                    min={0}
                    max={total}
                    value={total - free}
                    aria-label={t(
                      "Spazio occupato nel filesystem",
                      "Used filesystem space",
                    )}
                  />
                  <div className="archive-disk-legend">
                    <span>
                      {bytes(total - free)} {t("occupati", "used")}
                    </span>
                    <span>
                      {bytes(total)} {t("totali", "total")}
                    </span>
                  </div>
                </>
              ) : (
                <p>
                  {t(
                    "Misura dello spazio non disponibile. Verifica il mount dello storage.",
                    "Space measurement unavailable. Check the storage mount.",
                  )}
                </p>
              )}
              <small>
                {t(
                  "Il filesystem può contenere anche dati esterni all’archivio. Riserva minima per nuove scritture:",
                  "The filesystem may also contain data outside the archive. Minimum reserve for new writes:",
                )}{" "}
                {bytes(q.data.reserve_bytes)}.
              </small>
              {free != null && free <= q.data.reserve_bytes && (
                <div className="archive-callout archive-error">
                  {t(
                    "Spazio sotto la riserva: libera spazio prima di riprendere le importazioni.",
                    "Space below reserve: free space before resuming imports.",
                  )}{" "}
                  <Link to="/admin/ingest?filter=attention">
                    {t(
                      "Apri importazioni interrotte",
                      "Open interrupted imports",
                    )}
                  </Link>
                </div>
              )}
            </div>
            <Facts
              items={[
                [t("Oggetti unici", "Unique objects"), number(q.data.objects)],
                [t("Dati canonici", "Canonical data"), bytes(q.data.bytes)],
                [
                  t("Record nei pack", "Packed records"),
                  bytes(q.data.packed_bytes),
                ],
                [
                  t("Pack referenziati", "Referenced packs"),
                  number(q.data.packs),
                ],
              ]}
            />
            <div className="archive-section-heading">
              <h2>{t("Composizione dell’archivio", "Archive composition")}</h2>
              <Link to="/admin/archive">
                {t("Ispeziona opere", "Inspect works")} →
              </Link>
            </div>
            {q.data.kinds.length ? (
              <div className="archive-table table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>{t("Tipo di oggetto", "Object type")}</th>
                      <th>{t("Oggetti", "Objects")}</th>
                      <th>{t("Canonico", "Canonical")}</th>
                      <th>{t("Nei pack", "In packs")}</th>
                      <th>{t("Quota dei record", "Share of records")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {q.data.kinds.map((k) => (
                      <tr key={k.kind}>
                        <td>
                          <code>{k.kind}</code>
                        </td>
                        <td className="archive-numeric">{number(k.objects)}</td>
                        <td>{bytes(k.bytes)}</td>
                        <td>{bytes(k.packed_bytes)}</td>
                        <td>
                          <div className="archive-share">
                            <span
                              style={{
                                width: `${Number(q.data!.packed_bytes) ? (Number(k.packed_bytes) / Number(q.data!.packed_bytes)) * 100 : 0}%`,
                              }}
                            />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty
                title={t("Nessun oggetto archiviato", "No archived objects")}
              >
                <Link to="/admin/ingest?new=1">
                  {t("Avvia un’importazione", "Start an import")} →
                </Link>
              </Empty>
            )}
            <small className="archive-help">
              {t(
                "Dimensioni dei record indicizzati, inclusi gli header. I pack non referenziati e lo staging non sono inclusi.",
                "Sizes of indexed records, including headers. Unreferenced packs and staging are excluded.",
              )}
            </small>
            <h2 className="archive-section-title">
              {t("Manutenzione", "Maintenance")}
            </h2>
            <div className="archive-maintenance">
              <div>
                <div>
                  <h3>{t("Compatta i pack", "Compact packs")}</h3>
                  <p>
                    {t(
                      "Raggruppa gli oggetti in nuovi pack, aggiorna i riferimenti e recupera i vecchi file non più utilizzati.",
                      "Groups objects into new packs, updates references and reclaims old files no longer in use.",
                    )}
                  </p>
                </div>
                <Button
                  disabled={
                    a.busy || busy || resetFailed || q.data.objects === "0"
                  }
                  onClick={() => {
                    a.reset();
                    setRequestId(crypto.randomUUID());
                    setConfirm("compact");
                  }}
                >
                  {t("Compatta pack", "Compact packs")}
                </Button>
              </div>
              <div>
                <div>
                  <h3>
                    {t(
                      "Recupera spazio non referenziato",
                      "Reclaim unreferenced space",
                    )}
                  </h3>
                  <p>
                    {t(
                      "Rimuove pack senza riferimenti o lease attive e file temporanei abbandonati. Le versioni storiche restano conservate.",
                      "Removes packs without references or active leases and abandoned temporary files. Historical versions remain preserved.",
                    )}
                  </p>
                </div>
                <Button
                  disabled={a.busy || busy || resetFailed}
                  onClick={() => {
                    a.reset();
                    setRequestId(crypto.randomUUID());
                    setConfirm("collect");
                  }}
                >
                  {t("Recupera spazio", "Reclaim space")}
                </Button>
              </div>
            </div>
            {q.data.dev_reset_available && (
              <div className="archive-maintenance">
                <div>
                  <div>
                    <h3>
                      {t(
                        "Reset archivio di sviluppo",
                        "Reset development archive",
                      )}
                    </h3>
                    <p>
                      {t(
                        "Elimina opere, versioni, importazioni e pack senza backup. Conserva account, sessioni, preferenze e dump originali.",
                        "Deletes works, versions, imports and packs without a backup. Keeps accounts, sessions, preferences and original dumps.",
                      )}
                    </p>
                  </div>
                  <Button
                    tone="danger"
                    disabled={a.busy || busy}
                    onClick={() => {
                      a.reset();
                      setRequestId(crypto.randomUUID());
                      setConfirmation("");
                      setConfirm("reset_dev");
                    }}
                  >
                    {t("Reset archivio dev", "Reset dev archive")}
                  </Button>
                </div>
              </div>
            )}
            {busy && (
              <p className="archive-help" role="status">
                {t(
                  "Manutenzione in coda o in corso. L’avanzamento viene aggiornato automaticamente.",
                  "Maintenance queued or running. Progress updates automatically.",
                )}
              </p>
            )}
            {!confirm && <Feedback action={a} />}
            <div className="archive-section-heading">
              <h2>{t("Attività di manutenzione", "Maintenance activity")}</h2>
              <span className="muted">
                {t("Ultime 50 operazioni", "Latest 50 operations")}
              </span>
            </div>
            {!q.data.jobs.length ? (
              <Empty
                title={t(
                  "Nessuna manutenzione eseguita",
                  "No maintenance jobs yet",
                )}
              />
            ) : (
              <div className="archive-job-list">
                {q.data.jobs.map((j) => (
                  <div key={j.id} className="archive-job">
                    <div className="archive-section-heading">
                      <div>
                        <strong>{kindName(j.kind)}</strong>
                        <small>{date(j.created_at)}</small>
                      </div>
                      <Status state={j.state} />
                    </div>
                    {j.state === "completed" && j.kind === "reset_dev" ? (
                      <p>
                        {t(
                          "Archivio svuotato. Account e dump conservati.",
                          "Archive cleared. Accounts and dumps preserved.",
                        )}{" "}
                        <Link to="/admin/ingest?new=1">
                          {t("Avvia un’importazione", "Start an import")} →
                        </Link>
                      </p>
                    ) : j.state === "completed" ? (
                      <Facts
                        items={[
                          [
                            t(
                              "Byte dei pack rimossi",
                              "Bytes in removed packs",
                            ),
                            bytes(Number(j.result?.freed ?? 0)),
                          ],
                          [
                            t("Pack rimossi", "Packs removed"),
                            number(j.result?.removed),
                          ],
                          [
                            t("Oggetti riscritti", "Objects rewritten"),
                            number(j.result?.objects),
                          ],
                        ]}
                      />
                    ) : j.state === "running" ? (
                      <p role="status">
                        {j.kind === "reset_dev"
                          ? t(
                              "Svuotamento di catalogo, code e file…",
                              "Clearing catalog, queues and files…",
                            )
                          : j.kind === "compact"
                            ? number(j.result?.objects) +
                              " " +
                              t("oggetti riscritti", "objects rewritten")
                            : t(
                                "Verifica dei riferimenti e pulizia dei file non utilizzati…",
                                "Checking references and cleaning unused files…",
                              )}
                      </p>
                    ) : j.state === "failed" ? (
                      <p className="archive-error">
                        {String(
                          j.result?.message ??
                            j.result?.code ??
                            t("Operazione non riuscita", "Operation failed"),
                        )}
                      </p>
                    ) : (
                      <p className="muted">
                        {t("In attesa del worker", "Waiting for the worker")}
                      </p>
                    )}
                    <Diagnostic value={{ id: j.id, ...j.result }} />
                  </div>
                ))}
              </div>
            )}
          </>
        )
      )}
      {confirm && (
        <Modal
          open
          onClose={() => setConfirm(undefined)}
          title={kindName(confirm)}
          closeLabel={t("Chiudi", "Close")}
          description={
            confirm === "reset_dev"
              ? t(
                  "Le importazioni attive verranno fermate. Tutte le opere, le versioni storiche, i batch e i pack saranno eliminati definitivamente, senza backup. Account, credenziali, sessioni, preferenze, inviti e dump originali restano conservati. Scrivi RESET per confermare.",
                  "Active imports will be stopped. All works, historical versions, batches and packs will be permanently deleted without a backup. Accounts, credentials, sessions, preferences, invitations and original dumps are preserved. Type RESET to confirm.",
                )
              : confirm === "compact"
                ? t(
                    "La riscrittura richiede spazio temporaneo e può durare a lungo. I controlli di spazio e integrità restano attivi durante il lavoro.",
                    "Rewriting requires temporary space and can take a long time. Space and integrity checks remain active during the job.",
                  )
                : t(
                    "Verranno rimossi soltanto i file non più referenziati e i temporanei abbandonati. Nessuna versione storica viene eliminata.",
                    "Only unreferenced files and abandoned temporary files will be removed. No historical version is deleted.",
                  )
          }
        >
          {confirm === "reset_dev" && (
            <Field
              label={t("Conferma reset", "Confirm reset")}
              autoComplete="off"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
            />
          )}
          <Feedback action={a} />
          <div className="row">
            <Button onClick={() => setConfirm(undefined)}>
              {t("Annulla", "Cancel")}
            </Button>
            <Button
              tone={confirm === "reset_dev" ? "danger" : "primary"}
              disabled={
                a.busy || (confirm === "reset_dev" && confirmation !== "RESET")
              }
              onClick={() =>
                void a.run(
                  async () => {
                    if (confirm === "reset_dev") {
                      await call("archiveDevReset", {
                        requestId,
                        confirmation: "RESET",
                      });
                      await client.invalidateQueries({
                        predicate: (query) =>
                          /^(archive|ingest)/.test(String(query.queryKey[0])),
                      });
                    } else
                      await call("archiveMaintenance", {
                        requestId,
                        kind: confirm,
                      });
                    await q.refetch();
                    setConfirm(undefined);
                  },
                  confirm === "reset_dev"
                    ? t(
                        "Reset inserito in coda. Puoi seguirne lo stato nelle attività di manutenzione.",
                        "Reset queued. Follow its status in maintenance activity.",
                      )
                    : t(
                        "Manutenzione inserita in coda.",
                        "Maintenance queued.",
                      ),
                )
              }
            >
              {confirm === "reset_dev"
                ? t("Elimina archivio dev", "Delete dev archive")
                : t("Avvia manutenzione", "Start maintenance")}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
