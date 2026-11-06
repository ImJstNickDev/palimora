import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Button, Field, Select } from "@palimora/ui";
import type { Input } from "@palimora/contracts";
import { call } from "./api";
import {
  Heading,
  Loading,
  QueryError,
  useText,
  useAction,
  Feedback,
} from "./shared";
import { SourceSelection, BatchReport } from "./archive-operations";
import {
  Status,
  Empty,
  Facts,
  Progress,
  Live,
  Pager,
  Diagnostic,
  activeBatch,
  sourceProblem,
  useArchiveParams,
  bytes,
  date,
  number,
} from "./archive-common";

function NewImport({ close }: { close: () => void }) {
  const t = useText(),
    a = useAction(),
    navigate = useNavigate();
  const [selection, setSelection] = useState<string[]>([]),
    [scope, setScope] = useState("selected"),
    [mode, setMode] = useState("incremental");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <div className="archive-import-form">
      <div className="archive-section-heading">
        <h2 ref={heading} tabIndex={-1}>
          {t("Nuova importazione", "New import")}
        </h2>
        <Button onClick={close}>{t("Annulla", "Cancel")}</Button>
      </div>
      <div className="archive-toolbar">
        <Select
          label={t("Modalità", "Mode")}
          value={mode}
          onChange={(e) => {
            setMode(e.target.value);
            setRequestId(crypto.randomUUID());
          }}
          disabled={a.busy}
        >
          <option value="incremental">
            {t("Incrementale", "Incremental")}
          </option>
          <option value="reprocess">
            {t("Rielabora sorgenti", "Reprocess sources")}
          </option>
        </Select>
        <Select
          label={t("Sorgenti da elaborare", "Sources to process")}
          value={scope}
          onChange={(e) => {
            setScope(e.target.value);
            setRequestId(crypto.randomUUID());
          }}
          disabled={a.busy}
        >
          <option value="selected">{t("Scegli file", "Choose files")}</option>
          <option value="all">
            {t("Intero dump disponibile", "Entire available dump")}
          </option>
        </Select>
      </div>
      <p className="archive-help">
        {mode === "incremental"
          ? t(
              "Acquisisce file nuovi o cambiati e riprende i checkpoint disponibili.",
              "Acquires new or changed files and resumes available checkpoints.",
            )
          : t(
              "Rilegge le sorgenti selezionate; conserva la storia e riutilizza i contenuti identici.",
              "Reads the selected sources again; preserves history and reuses identical content.",
            )}
      </p>
      {scope === "selected" ? (
        <SourceSelection
          selected={selection}
          setSelected={(s) => {
            setSelection(s);
            setRequestId(crypto.randomUUID());
          }}
          disabled={a.busy}
        />
      ) : (
        <div className="archive-callout">
          {t(
            "Il batch comprende tutti gli ZIP e gli SQLite disponibili nel mount, incluse le lacune rilevate. Può richiedere molto tempo.",
            "The batch includes every available ZIP and SQLite in the mount, including detected gaps. It may take a long time.",
          )}
          <code>/dumps/ao3_stories</code>
        </div>
      )}
      <Feedback action={a} />
      <div className="archive-form-footer">
        <span>
          {scope === "all"
            ? t("Intero dump", "Entire dump")
            : `${selection.length} ${t("file selezionati", "selected files")}`}{" "}
          ·{" "}
          {mode === "incremental"
            ? t("incrementale", "incremental")
            : t("rielaborazione", "reprocess")}
        </span>
        <Button
          tone="primary"
          disabled={a.busy || (scope === "selected" && !selection.length)}
          onClick={() =>
            void a.run(async () => {
              const batch = await call("ingestCreate", {
                requestId,
                reprocess: mode === "reprocess",
                selection: scope === "all" ? [] : selection,
              });
              navigate("/admin/ingest/" + batch.id);
            })
          }
        >
          {a.busy
            ? t("Avvio…", "Starting…")
            : t("Avvia importazione", "Start import")}
        </Button>
      </div>
    </div>
  );
}
export function Ingest() {
  const t = useText(),
    p = useArchiveParams();
  const filter = (p.params.get("filter") ??
    "all") as Input<"ingestBatches">["filter"];
  const [search, setSearch] = useState(p.params.get("q") ?? "");
  const queryText = p.params.get("q") ?? "";
  useEffect(() => setSearch(queryText), [queryText]);
  const q = useQuery({
    queryKey: ["ingest-list", p.cursor, filter, p.params.get("q")],
    queryFn: () =>
      call("ingestBatches", {
        cursor: p.cursor,
        filter,
        q: p.params.get("q") ?? "",
      }),
    refetchInterval: 3000,
  });
  return (
    <div className="archive-view">
      <div className="archive-page-heading">
        <div>
          <p className="eyebrow">Archive Engine</p>
          <Heading>{t("Importazioni", "Imports")}</Heading>
        </div>
        {!p.params.has("new") && (
          <Button tone="primary" onClick={() => p.set("new", "1")}>
            {t("Nuova importazione", "New import")}
          </Button>
        )}
      </div>
      {p.params.has("new") ? (
        <NewImport close={() => p.set("new", "")} />
      ) : (
        <>
          <div className="archive-toolbar">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                p.set("q", search);
              }}
              className="archive-search"
            >
              <Field
                label={t("Cerca batch o sorgente", "Find batch or source")}
                type="search"
                value={search}
                maxLength={100}
                onChange={(e) => setSearch(e.target.value)}
              />
              <Button type="submit">{t("Cerca", "Search")}</Button>
            </form>
            <Select
              label={t("Mostra", "Show")}
              value={filter}
              onChange={(e) => p.set("filter", e.target.value)}
            >
              <option value="all">
                {t("Tutte le importazioni", "All imports")}
              </option>
              <option value="active">{t("In attività", "Active")}</option>
              <option value="attention">
                {t("Da controllare", "Needs attention")}
              </option>
              <option value="finished">{t("Concluse", "Finished")}</option>
            </Select>
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
                {!q.data.items.length ? (
                  <Empty
                    title={t(
                      "Nessuna importazione in questa vista",
                      "No imports in this view",
                    )}
                  >
                    <p>
                      {t(
                        "Scegli le sorgenti per avviare un batch, oppure modifica i filtri.",
                        "Choose sources to start a batch, or change the filters.",
                      )}
                    </p>
                    <Button onClick={() => p.set("new", "1")}>
                      {t("Scegli sorgenti", "Choose sources")}
                    </Button>
                  </Empty>
                ) : (
                  <div className="archive-table table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>{t("Importazione", "Import")}</th>
                          <th>{t("Stato", "Status")}</th>
                          <th>{t("Sorgenti concluse", "Finished sources")}</th>
                          <th>{t("Record", "Records")}</th>
                          <th>{t("Lacune", "Gaps")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {q.data.items.map((b) => (
                          <tr key={b.id}>
                            <td>
                              <Link
                                className="archive-title-link"
                                to={"/admin/ingest/" + b.id}
                              >
                                {date(b.created_at)}
                              </Link>
                              <small>
                                {b.reconcile_batch_id
                                  ? t(
                                      "Riconciliazione SQLite",
                                      "SQLite reconciliation",
                                    )
                                  : b.reprocess
                                    ? t("Rielaborazione", "Reprocess")
                                    : t("Incrementale", "Incremental")}{" "}
                                ·{" "}
                                {b.selection.length
                                  ? `${b.selection.length} ${t("file", "files")}`
                                  : t("Intero dump", "Entire dump")}
                              </small>
                              <small
                                className="archive-ellipsis"
                                title={b.selection.join(", ")}
                              >
                                {b.selection.slice(0, 2).join(", ")}
                                {b.selection.length > 2
                                  ? ` +${b.selection.length - 2}`
                                  : ""}
                              </small>
                            </td>
                            <td>
                              <Status state={b.state} />
                            </td>
                            <td>
                              <Progress
                                label={`${number(b.done_sources)} / ${number(b.sources)}`}
                                value={b.done_sources}
                                total={b.sources || null}
                              />
                            </td>
                            <td className="archive-numeric">
                              {number(b.processed)}
                            </td>
                            <td className="archive-numeric">
                              {Number(b.gaps) > 0 ? (
                                <Link to={`/admin/ingest/${b.id}?tab=report`}>
                                  {number(b.gaps)}
                                </Link>
                              ) : (
                                "—"
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <Pager next={q.data.next} {...p.pager} />
              </>
            )
          )}
        </>
      )}
    </div>
  );
}
export function IngestDetail() {
  const { id } = useParams();
  return <BatchDetail key={id} id={id!} />;
}
function BatchDetail({ id }: { id: string }) {
  const t = useText(),
    a = useAction(t, {
      CONFLICT: t(
        "Lo stato del batch è cambiato. Aggiorna i dati e riprova.",
        "The batch state changed. Refresh the data and try again.",
      ),
    }),
    p = useArchiveParams(),
    navigate = useNavigate();
  const [search, setSearch] = useState(""),
    [filter, setFilter] = useState("all");
  const [requestId] = useState(() => crypto.randomUUID());
  const tab = p.params.get("tab") ?? "sources";
  const q = useQuery({
    queryKey: ["ingest", id],
    queryFn: () => call("ingestDetail", { id }),
    refetchInterval: 2000,
  });
  const loaded = q.isSuccess;
  useEffect(() => {
    if (loaded) document.querySelector<HTMLElement>("main h1")?.focus();
  }, [loaded]);
  if (q.isPending) return <Loading />;
  if (q.isError && !q.data)
    return <QueryError retry={() => void q.refetch()} />;
  if (!q.data) return null;
  const { batch, sources } = q.data;
  const visible = sources.filter(
    (s) =>
      s.path.toLowerCase().includes(search.toLowerCase()) &&
      (filter === "all" ||
        (filter === "issues"
          ? sourceProblem(s.state) || Number(s.gaps) > 0
          : s.state === "ingested")),
  );
  const done = sources.filter((s) =>
    [
      "ingested",
      "missing_source",
      "incomplete_transfer",
      "corrupt_source",
    ].includes(s.state),
  ).length;
  const gaps = sources.reduce((n, s) => n + Number(s.gaps), 0);
  const problems = sources.filter(
    (s) => sourceProblem(s.state) || Number(s.gaps) > 0,
  );
  const retryPaths = problems
    .filter((s) => s.state !== "incomplete_transfer")
    .map((s) => s.path);
  const finished = ["completed", "completed_with_gaps"].includes(batch.state);
  const hint: Record<string, [string, string]> = {
    pending: [
      "Le sorgenti sono in coda. Il worker inizierà quando disponibile.",
      "Sources are queued. The worker will start when available.",
    ],
    scanning: [
      "Rilevamento delle sorgenti e dei checkpoint disponibili.",
      "Discovering sources and available checkpoints.",
    ],
    running: [
      "Ogni record viene confermato con un checkpoint persistente.",
      "Each record is committed with a persistent checkpoint.",
    ],
    paused: [
      "La ripresa prosegue dall’ultimo checkpoint confermato.",
      "Resuming continues from the last committed checkpoint.",
    ],
    parser_blocked: [
      "Correggi il parser indicato nella diagnostica, poi riprendi il batch.",
      "Fix the parser identified in diagnostics, then resume the batch.",
    ],
    failed_global: [
      "Risolvi l’errore indicato prima di riprendere. I checkpoint sono conservati.",
      "Resolve the reported error before resuming. Checkpoints are preserved.",
    ],
    completed: [
      "Tutte le sorgenti del batch sono state elaborate.",
      "All batch sources have been processed.",
    ],
    completed_with_gaps: [
      "I contenuti recuperabili sono acquisiti. Controlla le lacune prima di una nuova scansione.",
      "Recoverable content has been acquired. Review gaps before a new scan.",
    ],
  };
  return (
    <div className="archive-view">
      <Link className="security-back" to="/admin/ingest">
        ← {t("Importazioni", "Imports")}
      </Link>
      <div className="archive-page-heading">
        <div>
          <p className="eyebrow">
            {batch.reconcile_batch_id
              ? t("Riconciliazione SQLite", "SQLite reconciliation")
              : batch.reprocess
                ? t("Rielaborazione", "Reprocess")
                : t("Importazione incrementale", "Incremental import")}
          </p>
          <Heading>{date(batch.created_at)}</Heading>
        </div>
        <div className="row">
          <Status state={batch.state} />
          {!finished && (
            <Button
              disabled={a.busy}
              onClick={() =>
                void a.run(async () => {
                  await call("ingestControl", {
                    id,
                    action: activeBatch(batch.state) ? "pause" : "resume",
                  });
                  await q.refetch();
                })
              }
            >
              {activeBatch(batch.state)
                ? t("Pausa", "Pause")
                : t("Riprendi", "Resume")}
            </Button>
          )}
        </div>
      </div>
      <Feedback action={a} />
      <p className="archive-help">
        {hint[batch.state] && t(...hint[batch.state])}
      </p>
      {batch.error && (
        <div className="archive-callout archive-error">
          <strong>{valueError(batch.error)}</strong>
          <Diagnostic value={batch.error} />
          {batch.state === "failed_global" && (
            <Link to="/admin/archive/storage">
              {t("Controlla storage", "Check storage")}
            </Link>
          )}
        </div>
      )}
      <Facts
        items={[
          [
            t("Sorgenti concluse", "Finished sources"),
            `${number(done)} / ${number(sources.length)}`,
          ],
          [
            t("Record acquisiti", "Acquired records"),
            number(sources.reduce((n, s) => n + Number(s.imported), 0)),
          ],
          [
            t("Lacune", "Gaps"),
            <button
              className="archive-text-button"
              onClick={() => {
                p.set("tab", "sources");
                setFilter("issues");
              }}
            >
              {number(gaps)} ↗
            </button>,
          ],
          [t("Avvio", "Started"), date(batch.started_at)],
        ]}
      />
      <Progress
        label={t("Avanzamento sorgenti", "Source progress")}
        value={done}
        total={sources.length || null}
      />
      <div className="archive-section-heading">
        <div
          className="archive-tabs"
          aria-label={t("Dettagli batch", "Batch details")}
        >
          {[
            ["sources", t("Sorgenti", "Sources")],
            ["report", t("Report e anomalie", "Report and issues")],
            ["context", t("Configurazione", "Configuration")],
          ].map(([key, label]) => (
            <Button
              key={key}
              aria-pressed={tab === key}
              onClick={() => p.set("tab", key)}
            >
              {label}
            </Button>
          ))}
        </div>
        <Live
          updated={q.dataUpdatedAt}
          fetching={q.isFetching}
          error={q.isError}
          refresh={q.refetch}
        />
      </div>
      {tab === "sources" && (
        <>
          <div className="archive-toolbar">
            <Field
              label={t("Filtra sorgenti", "Filter sources")}
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Select
              label={t("Mostra sorgenti", "Show sources")}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="all">
                {t("Tutte", "All")} ({sources.length})
              </option>
              <option value="issues">
                {t("Da controllare", "Needs attention")} ({problems.length})
              </option>
              <option value="ingested">{t("Acquisite", "Ingested")}</option>
            </Select>
            {finished && retryPaths.length > 0 && (
              <Button
                disabled={a.busy}
                onClick={() =>
                  void a.run(async () => {
                    const b = await call("ingestCreate", {
                      requestId,
                      reprocess: true,
                      selection: retryPaths,
                      ...(batch.reconcile_batch_id
                        ? { reconcileBatchId: batch.reconcile_batch_id }
                        : { metadataScope: batch.metadata_scope }),
                    });
                    navigate("/admin/ingest/" + b.id);
                  })
                }
              >
                {t(
                  "Rielabora sorgenti con anomalie",
                  "Reprocess sources with issues",
                )}
              </Button>
            )}
          </div>
          {!visible.length ? (
            <Empty
              title={t(
                "Nessuna sorgente in questa vista",
                "No sources in this view",
              )}
            />
          ) : (
            <div className="archive-source-results">
              {visible.map((s) => (
                <details key={s.id} className="archive-source-result">
                  <summary>
                    <span className="archive-file-name">
                      {s.path}
                      <small>
                        {number(s.imported)} {t("record", "records")} ·{" "}
                        {bytes(s.bytes)}
                        {Number(s.gaps) > 0
                          ? ` · ${number(s.gaps)} ${t("lacune", "gaps")}`
                          : ""}
                      </small>
                    </span>
                    <Status state={s.state} />
                    <span className="archive-source-checkpoint">
                      {s.total
                        ? `${number(s.checkpoint)} / ${number(s.total)}`
                        : number(s.checkpoint)}
                      <small>checkpoint</small>
                    </span>
                  </summary>
                  <div className="archive-source-body">
                    {s.index_progress != null && (
                      <p role="status">
                        {t(
                          "Preparazione indice metadati",
                          "Preparing metadata index",
                        )}
                        : {number(s.index_progress)} {t("righe", "rows")}
                      </p>
                    )}
                    <Progress
                      label={t("Elementi verificati", "Verified entries")}
                      value={Number(s.checkpoint)}
                      total={s.total === null ? null : Number(s.total)}
                    />
                    <Facts
                      items={[
                        [t("Parser", "Parser"), s.parser],
                        [
                          t("Riga CSV", "CSV row"),
                          s.checkpoint_detail.row
                            ? String(s.checkpoint_detail.row)
                            : "—",
                        ],
                        [
                          t(
                            "Acquisizioni già presenti",
                            "Existing acquisitions",
                          ),
                          number(s.duplicates),
                        ],
                        [
                          t("Tentativi I/O", "I/O attempts"),
                          number(s.attempts),
                        ],
                        [
                          t("Prossimo retry", "Next retry"),
                          date(s.next_retry_at),
                        ],
                      ]}
                    />
                    <small className="archive-hash">
                      Fingerprint: {s.fingerprint}
                    </small>
                    {s.error && <Diagnostic value={s.error} />}
                    <Link
                      to={`?tab=report&source=${encodeURIComponent(s.path)}`}
                    >
                      {t("Apri anomalie della sorgente", "Open source issues")}{" "}
                      →
                    </Link>
                  </div>
                </details>
              ))}
            </div>
          )}
        </>
      )}
      {tab === "report" && (
        <>
          {p.params.get("source") && (
            <Button onClick={() => p.set("source", "")}>
              {t("Mostra tutte le anomalie", "Show all issues")}
            </Button>
          )}
          <BatchReport
            key={p.params.get("source") ?? "all"}
            id={id}
            path={p.params.get("source") ?? undefined}
          />
        </>
      )}
      {tab === "context" && (
        <div className="archive-panel">
          <Facts
            items={[
              ["Batch ID", <code>{id}</code>],
              [t("Ultima modifica", "Last change"), date(batch.updated_at)],
              [t("Conclusione", "Finished"), date(batch.finished_at)],
              [t("Riprese", "Resumes"), number(batch.generation)],
            ]}
          />
          {batch.reconcile_batch_id && (
            <Link to={"/admin/ingest/" + batch.reconcile_batch_id}>
              {t("Apri batch di origine", "Open original batch")}
            </Link>
          )}
          <h3>{t("Selezione originale", "Original selection")}</h3>
          {batch.selection.length ? (
            <ul>
              {batch.selection.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          ) : (
            <p>
              /dumps/ao3_stories ·{" "}
              {t("Intero dump disponibile", "Entire available dump")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
function valueError(error: Record<string, unknown>) {
  return String(error.message ?? error.code ?? error.type ?? "Error");
}
