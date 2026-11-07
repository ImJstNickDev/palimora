import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Field, Select, Modal } from "@palimora/ui";
import type { Input, Output } from "@palimora/contracts";
import { call } from "./api";
import { useAction, useText, Feedback, Loading, QueryError } from "./shared";
import { date, bytes, Empty, Pager, useArchiveParams } from "./archive-common";
import {
  SyncBadge,
  SyncStatus,
  SyncData,
  useSyncLabels,
  useSyncError,
  mediaName,
} from "./ao3-common";
function useSyncRefresh() {
  const client = useQueryClient();
  return async () => {
    await Promise.all(
      ["ao3-jobs", "ao3-summary", "ao3-media"].map((key) =>
        client.invalidateQueries({ queryKey: [key] }),
      ),
    );
  };
}
export function SyncQueue({ status }: { status: SyncStatus }) {
  const t = useText(),
    label = useSyncLabels(),
    error = useSyncError(),
    a = useAction(),
    refresh = useSyncRefresh();
  const { params, set, cursor, pager } = useArchiveParams();
  const state = (
    ["pending", "running", "retry", "idle", "blocked"].includes(
      params.get("state") ?? "",
    )
      ? params.get("state")
      : "all"
  ) as Input<"ao3Jobs">["state"];
  const kind = (
    ["work", "discovery", "backfill", "entity", "media"].includes(
      params.get("kind") ?? "",
    )
      ? params.get("kind")
      : "all"
  ) as Input<"ao3Jobs">["kind"];
  const [search, setSearch] = useState(params.get("q") ?? "");
  const q = useQuery({
    queryKey: ["ao3-jobs", cursor, state, kind, params.get("q")],
    queryFn: () =>
      call("ao3Jobs", { cursor, state, kind, q: params.get("q") ?? "" }),
    refetchInterval: 10000,
  });
  const [manual, setManual] = useState(false),
    [manualKind, setManualKind] = useState<Input<"ao3Manual">["kind"]>("work"),
    [target, setTarget] = useState("");
  return (
    <section className="sync-section">
      <div className="sync-section-heading">
        <div>
          <h2>{t("Coda di sincronizzazione", "Synchronization queue")}</h2>
          <p>
            {status.control.eligible
              ? t(
                  "Le scadenze indicano quando un lavoro diventa eseguibile, secondo priorità e limiti.",
                  "Due dates indicate when a job becomes eligible, subject to priorities and limits.",
                )
              : t(
                  "Le scadenze sono conservate. Nessun controllo remoto parte finché AO3 non è disponibile.",
                  "Due dates are retained. No remote check starts while AO3 is unavailable.",
                )}
          </p>
        </div>
        <Button tone="primary" onClick={() => setManual(true)}>
          + {t("Accoda verifica", "Queue check")}
        </Button>
      </div>
      <Feedback action={a} />
      <form
        className="archive-toolbar sync-filters"
        onSubmit={(e) => {
          e.preventDefault();
          set("q", search.trim());
        }}
      >
        <Field
          label={t("Cerca opera o risorsa", "Find work or resource")}
          type="search"
          value={search}
          maxLength={200}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Button type="submit">{t("Cerca", "Search")}</Button>
        <Select
          label={t("Tipo di attività", "Job type")}
          value={kind}
          onChange={(e) => set("kind", e.target.value)}
        >
          {["all", "work", "discovery", "backfill", "entity", "media"].map(
            (k) => (
              <option key={k} value={k}>
                {k === "all" ? t("Tutti i tipi", "All types") : label(k)}
              </option>
            ),
          )}
        </Select>
        <Select
          label={t("Stato della coda", "Queue state")}
          value={state}
          onChange={(e) => set("state", e.target.value)}
        >
          {["all", "pending", "running", "retry", "idle", "blocked"].map(
            (s) => (
              <option key={s} value={s}>
                {s === "all"
                  ? t("Tutti gli stati", "All states")
                  : s === "blocked"
                    ? t("In pausa", "Paused")
                    : label(s)}
              </option>
            ),
          )}
        </Select>
      </form>
      {q.isPending ? (
        <Loading />
      ) : !q.data ? (
        <QueryError retry={() => void q.refetch()} />
      ) : (
        <>
          {!q.data.jobs.length ? (
            <Empty title={t("Nessuna attività trovata", "No matching jobs")}>
              {t(
                "Modifica i filtri o accoda una verifica.",
                "Change the filters or queue a check.",
              )}
            </Empty>
          ) : (
            <div className="sync-table">
              <table>
                <thead>
                  <tr>
                    <th>{t("Risorsa", "Resource")}</th>
                    <th>{t("Esecuzione", "Execution")}</th>
                    <th>{t("Pianificazione", "Scheduling")}</th>
                    <th>{t("Azioni", "Actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.jobs.map((j) => (
                    <tr key={j.id}>
                      <td data-label={t("Risorsa", "Resource")}>
                        <div className="sync-resource">
                          <span className="sync-kind">
                            {j.kind === "media" &&
                            typeof j.checkpoint.upload === "string"
                              ? t("Media · copia locale", "Media · local copy")
                              : label(j.kind)}
                          </span>
                          <Link to={`?section=activity&job=${j.id}`}>
                            {j.title ||
                              ({
                                discovery: t(
                                  "Discovery oraria",
                                  "Hourly discovery",
                                ),
                                backfill: t(
                                  "Backfill progressivo",
                                  "Progressive backfill",
                                ),
                              }[j.kind] ??
                                (j.kind === "work"
                                  ? `AO3 · ${j.target}`
                                  : j.kind === "media"
                                    ? mediaName(j.target)
                                    : j.target))}
                          </Link>
                          <small>
                            {t("Priorità", "Priority")} {j.priority}
                            {j.kind === "work" && j.title
                              ? ` · AO3 ${j.target}`
                              : ""}
                          </small>
                          {j.error && (
                            <span className="sync-inline-error" title={j.error}>
                              {error(j.error)}
                            </span>
                          )}
                        </div>
                      </td>
                      <td data-label={t("Esecuzione", "Execution")}>
                        <SyncBadge state={j.execution} />
                        {j.attempts > 0 && (
                          <small>
                            {j.attempts}{" "}
                            {t("tentativi non riusciti", "failed attempts")}
                          </small>
                        )}
                      </td>
                      <td data-label={t("Pianificazione", "Scheduling")}>
                        <strong className="sync-due">
                          {j.execution === "waiting_service"
                            ? t(
                                "Alla ripresa del servizio",
                                "When service resumes",
                              )
                            : ["paused", "deleted", "stopping"].includes(
                                  j.execution,
                                )
                              ? t("Non pianificata", "Not scheduled")
                              : j.execution === "running"
                                ? t("In esecuzione", "Running")
                                : j.execution === "ready"
                                  ? t(
                                      "In attesa del turno",
                                      "Waiting for its turn",
                                    )
                                  : date(j.eligible_at)}
                        </strong>
                        <small>
                          {t("Ultimo controllo", "Last check")}:{" "}
                          {date(j.checked_at)}
                        </small>
                      </td>
                      <td data-label={t("Azioni", "Actions")}>
                        <div className="sync-row-actions">
                          {j.work_id && (
                            <Link to={`/works/${j.work_id}`}>
                              {t("Apri opera", "Open work")}
                            </Link>
                          )}
                          <Button
                            disabled={a.busy || j.state === "running"}
                            onClick={() =>
                              void a.run(async () => {
                                await call("ao3JobControl", {
                                  id: j.id,
                                  action:
                                    j.state === "blocked" ? "resume" : "pause",
                                });
                                await refresh();
                              })
                            }
                          >
                            {j.state === "blocked"
                              ? t("Riprendi", "Resume")
                              : t("Pausa", "Pause")}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Pager next={q.data.next} {...pager} />
        </>
      )}
      <Modal
        open={manual}
        onClose={() => !a.busy && setManual(false)}
        title={t("Accoda una verifica", "Queue a check")}
        closeLabel={t("Chiudi", "Close")}
        description={
          status.control.eligible
            ? t(
                "La verifica rispetta il turno della coda e i limiti AO3.",
                "The check respects the queue and AO3 limits.",
              )
            : t(
                "La richiesta verrà conservata e avviata alla ripresa del servizio.",
                "The request will be retained and started when service resumes.",
              )
        }
      >
        <Feedback action={a} />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void a.run(async () => {
              await call("ao3Manual", {
                kind: manualKind,
                target,
                priority: 10,
              });
              await refresh();
              setManual(false);
              setTarget("");
            });
          }}
        >
          <Select
            label={t("Risorsa da verificare", "Resource to check")}
            value={manualKind}
            onChange={(e) => setManualKind(e.target.value as typeof manualKind)}
          >
            {["work", "entity", "discovery", "backfill"].map((k) => (
              <option key={k} value={k}>
                {label(k)}
              </option>
            ))}
          </Select>
          {!["discovery", "backfill"].includes(manualKind) && (
            <Field
              label={
                manualKind === "work" ? "ID AO3" : t("Percorso AO3", "AO3 path")
              }
              hint={
                manualKind === "entity"
                  ? "/users/nome · /series/123 · /tags/nome"
                  : undefined
              }
              value={target}
              required
              onChange={(e) => setTarget(e.target.value)}
            />
          )}
          <Button tone="primary" disabled={a.busy} type="submit">
            {t("Conferma accodamento", "Confirm queue request")}
          </Button>
        </form>
      </Modal>
    </section>
  );
}
export function SyncSettings({
  data,
  refresh,
}: {
  data: SyncData | undefined;
  refresh: () => Promise<unknown>;
}) {
  const t = useText(),
    label = useSyncLabels(),
    a = useAction();
  const [username, setUsername] = useState(""),
    [password, setPassword] = useState("");
  if (!data) return <Loading />;
  return (
    <div className="sync-settings">
      <Feedback action={a} />
      <section className="sync-section">
        <div className="sync-section-heading">
          <div>
            <h2>{t("Priorità dello scheduler", "Scheduler priorities")}</h2>
            <p>
              {t(
                "1 è la priorità massima, 100 la minima. L’attesa aumenta gradualmente la precedenza.",
                "1 is the highest priority, 100 the lowest. Waiting gradually raises precedence.",
              )}
            </p>
          </div>
        </div>
        <form
          key={JSON.stringify(data.control.priorities)}
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const priorities = Object.fromEntries(
              ["discovery", "work", "entity", "media", "backfill"].map((k) => [
                k,
                Number(f.get(k)),
              ]),
            ) as Input<"ao3Priorities">["priorities"];
            void a.run(async () => {
              await call("ao3Priorities", { priorities });
              await refresh();
            });
          }}
        >
          <div className="sync-priorities">
            {Object.entries(data.control.priorities).map(([k, v]) => (
              <Field
                key={k}
                label={label(k)}
                type="number"
                name={k}
                required
                min={1}
                max={100}
                defaultValue={v}
              />
            ))}
          </div>
          <p className="sync-caption">
            {t(
              "Intervallo minimo corrente fra richieste",
              "Current minimum request spacing",
            )}
            : {data.control.spacing_ms / 1000}s
          </p>
          <Button disabled={a.busy} tone="primary" type="submit">
            {t("Salva priorità", "Save priorities")}
          </Button>
        </form>
      </section>
      <section className="sync-section">
        <div className="sync-section-heading">
          <div>
            <h2>{t("Account tecnico AO3", "AO3 service account")}</h2>
            <p>
              {t(
                "Account autorizzato per le opere riservate agli utenti autenticati.",
                "Authorized account for works restricted to signed-in users.",
              )}
            </p>
          </div>
          <SyncBadge state={data.control.auth_state} />
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void a.run(async () => {
              await call("ao3Account", { remove: false, username, password });
              setPassword("");
              await refresh();
            });
          }}
        >
          <Field
            label={t("Nome utente AO3", "AO3 username")}
            required
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <Field
            label="Password"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <div className="sync-row-actions">
            <Button tone="primary" disabled={a.busy} type="submit">
              {t("Salva account", "Save account")}
            </Button>
            {data.control.auth_state !== "anonymous" && (
              <Button
                disabled={a.busy}
                type="button"
                onClick={() =>
                  void a.run(async () => {
                    await call("ao3Account", { remove: true });
                    setPassword("");
                    setUsername("");
                    await refresh();
                  })
                }
              >
                {t("Rimuovi account", "Remove account")}
              </Button>
            )}
          </div>
        </form>
      </section>
    </div>
  );
}
export function SyncHistory({ status }: { status: SyncStatus }) {
  const t = useText(),
    label = useSyncLabels(),
    error = useSyncError();
  const [params] = useSearchParams();
  const job = params.get("job") ?? undefined;
  const [view, setView] = useState<"runs" | "probes">("runs");
  const q = useQuery({
    queryKey: ["ao3-jobs", "history", job],
    queryFn: () => call("ao3Jobs", { job }),
    refetchInterval: 10000,
  });
  return (
    <section className="sync-section">
      <div className="sync-section-heading">
        <div>
          <h2>{t("Attività e diagnostica", "Activity and diagnostics")}</h2>
          <p>
            {t(
              "Ultime 50 esecuzioni. Le sonde controllano la disponibilità, senza acquisire opere.",
              "Last 50 runs. Probes check availability without acquiring works.",
            )}
          </p>
        </div>
      </div>
      <div
        className="sync-history-tabs"
        role="group"
        aria-label={t("Tipo di cronologia", "History type")}
      >
        <Button aria-pressed={view === "runs"} onClick={() => setView("runs")}>
          {t("Sincronizzazioni", "Synchronizations")}
        </Button>
        <Button
          aria-pressed={view === "probes"}
          onClick={() => setView("probes")}
        >
          {t("Sonde di disponibilità", "Availability probes")}
        </Button>
      </div>
      {view === "runs" ? (
        <>
          {job && (
            <p>
              <Link to="?section=activity">
                ← {t("Tutte le risorse", "All resources")}
              </Link>
            </p>
          )}
          {q.isPending ? (
            <Loading />
          ) : !q.data ? (
            <QueryError retry={() => void q.refetch()} />
          ) : !q.data.runs.length ? (
            <Empty
              title={t(
                "Nessuna sincronizzazione eseguita",
                "No synchronizations performed",
              )}
            >
              {t(
                "Le attività sospese restano nella coda e non vengono registrate come tentativi.",
                "Suspended jobs stay in the queue and are not recorded as attempts.",
              )}
            </Empty>
          ) : (
            <div className="sync-table">
              <table>
                <thead>
                  <tr>
                    <th>{t("Risorsa", "Resource")}</th>
                    <th>{t("Avvio", "Started")}</th>
                    <th>{t("Esito", "Outcome")}</th>
                    <th>{t("Dettagli", "Details")}</th>
                  </tr>
                </thead>
                <tbody>
                  {q.data.runs.map((r) => (
                    <tr key={r.id}>
                      <td data-label={t("Risorsa", "Resource")}>
                        <span className="sync-kind">{label(r.kind)}</span>
                        <span className="sync-wrap">{r.target}</span>
                      </td>
                      <td data-label={t("Avvio", "Started")}>
                        {date(r.started_at)}
                      </td>
                      <td data-label={t("Esito", "Outcome")}>
                        <SyncBadge state={r.outcome} />
                      </td>
                      <td data-label={t("Dettagli", "Details")}>
                        {typeof r.detail.code === "string"
                          ? error(r.detail.code)
                          : typeof r.detail.found === "number"
                            ? `${r.detail.found} ${t("opere individuate", "works discovered")}`
                            : r.detail.changed === true
                              ? t(
                                  "Nuova revisione conservata",
                                  "New revision preserved",
                                )
                              : r.detail.changed === false
                                ? t(
                                    "Nessuna modifica rilevata",
                                    "No changes detected",
                                  )
                                : r.detail.availability
                                  ? label(String(r.detail.availability))
                                  : r.finished_at
                                    ? date(r.finished_at)
                                    : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : !status.history.length ? (
        <Empty title={t("Nessuna sonda eseguita", "No probes performed")} />
      ) : (
        <div className="sync-table">
          <table>
            <thead>
              <tr>
                <th>{t("Data", "Date")}</th>
                <th>{t("Stato AO3", "AO3 status")}</th>
                <th>HTTP</th>
                <th>{t("Durata", "Duration")}</th>
                <th>
                  {t("Limite richieste fino a", "Request cooldown until")}
                </th>
              </tr>
            </thead>
            <tbody>
              {status.history.map((r) => (
                <tr key={r.id}>
                  <td data-label={t("Data", "Date")}>{date(r.started_at)}</td>
                  <td data-label={t("Stato AO3", "AO3 status")}>
                    <SyncBadge state={r.state} />
                  </td>
                  <td data-label="HTTP">{r.http_status ?? "—"}</td>
                  <td data-label={t("Durata", "Duration")}>
                    {r.duration_ms} ms
                  </td>
                  <td
                    data-label={t(
                      "Limite richieste fino a",
                      "Request cooldown until",
                    )}
                  >
                    {date(r.retry_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
export function SyncMedia({ paused }: { paused: boolean }) {
  const t = useText(),
    a = useAction(),
    refresh = useSyncRefresh();
  const { params, set, cursor, pager } = useArchiveParams();
  const [search, setSearch] = useState(params.get("q") ?? "");
  const q = useQuery({
    queryKey: ["ao3-media", cursor, params.get("q")],
    queryFn: () => call("ao3Media", { cursor, q: params.get("q") ?? "" }),
    refetchInterval: 10000,
  });
  const [selected, setSelected] =
      useState<Output<"ao3Media">["items"][number]>(),
    [file, setFile] = useState<File>(),
    [uploadID, setUploadID] = useState(() => crypto.randomUUID()),
    [uploaded, setUploaded] = useState(0),
    [done, setDone] = useState(false);
  const open = (item: Output<"ao3Media">["items"][number]) => {
    setSelected(item);
    setFile(undefined);
    setUploadID(crypto.randomUUID());
    setUploaded(0);
    setDone(false);
  };
  return (
    <section className="sync-section">
      <div className="sync-section-heading">
        <div>
          <h2>{t("Media da recuperare", "Media recovery")}</h2>
          <p>
            {t(
              "Risorse che hanno restituito 404 o 410. Seleziona un media per associargli una copia locale.",
              "Resources that returned 404 or 410. Select a media file to provide a local copy.",
            )}
          </p>
        </div>
      </div>
      <Feedback action={a} />
      <form
        className="archive-toolbar"
        onSubmit={(e) => {
          e.preventDefault();
          set("q", search.trim());
        }}
      >
        <Field
          label={t("Cerca nome, dominio o URL", "Search name, domain or URL")}
          type="search"
          value={search}
          maxLength={200}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Button type="submit">{t("Cerca", "Search")}</Button>
      </form>
      {q.isPending ? (
        <Loading />
      ) : !q.data ? (
        <QueryError retry={() => void q.refetch()} />
      ) : (
        <>
          {!q.data.items.length ? (
            <Empty
              title={t(
                "Nessun media confermato irrecuperabile",
                "No confirmed missing media",
              )}
            >
              {t(
                "Gli errori temporanei e le risorse non ancora controllate restano nella coda.",
                "Temporary errors and resources not yet checked remain in the queue.",
              )}
            </Empty>
          ) : (
            <ul className="sync-media-list">
              {q.data.items.map((m) => (
                <li key={m.id}>
                  <span className="sync-file-icon" aria-hidden="true">
                    ↳
                  </span>
                  <div className="sync-resource">
                    <strong>{mediaName(m.url)}</strong>
                    <span className="sync-wrap">{new URL(m.url).hostname}</span>
                    <small>
                      {m.work_count.toLocaleString()}{" "}
                      {t("opere collegate", "linked works")} ·{" "}
                      {t(
                        "Mancante dal controllo del",
                        "Missing at the check on",
                      )}{" "}
                      {date(m.failed_at)}
                    </small>
                    <span className="sync-media-state">
                      {m.upload_state === "queued"
                        ? t(
                            "Copia locale in attesa di acquisizione",
                            "Local copy awaiting acquisition",
                          )
                        : m.has_local_copy
                          ? t(
                              "Sorgente rimossa · copia precedente conservata",
                              "Source removed · previous copy retained",
                            )
                          : t(
                              "Sorgente rimossa · nessuna copia locale",
                              "Source removed · no local copy",
                            )}
                    </span>
                  </div>
                  <Button
                    disabled={m.upload_state === "queued"}
                    onClick={() => open(m)}
                  >
                    {t("Recupera media", "Recover media")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <Pager next={q.data.next} {...pager} />
        </>
      )}
      <Modal
        open={!!selected}
        onClose={() => !a.busy && setSelected(undefined)}
        title={t("Recupera media", "Recover media")}
        closeLabel={t("Chiudi", "Close")}
        description={t(
          "La copia verrà associata a tutti i riferimenti allo stesso URL, preservando le versioni precedenti.",
          "The copy will be linked to all references to the same URL, preserving previous versions.",
        )}
      >
        {selected && (
          <>
            <Feedback action={a} />
            <div className="sync-media-detail">
              <strong>{mediaName(selected.url)}</strong>
              <span className="sync-wrap">{selected.url}</span>
              <span>
                {t(
                  "Risorsa non trovata o rimossa (404/410)",
                  "Resource missing or removed (404/410)",
                )}
              </span>
            </div>
            {selected.works.length > 0 && (
              <div className="sync-affected">
                <h3>{t("Opere coinvolte", "Affected works")}</h3>
                {selected.works.map((w) => (
                  <Link key={w.id} to={`/works/${w.id}`}>
                    {w.title}
                  </Link>
                ))}
                {selected.work_count > selected.works.length && (
                  <small>
                    + {selected.work_count - selected.works.length}{" "}
                    {t("altre opere", "other works")}
                  </small>
                )}
              </div>
            )}
            {done ? (
              <p className="notice" role="status">
                {paused
                  ? t(
                      "Copia caricata. Verrà acquisita quando riprendi lo scheduler.",
                      "Copy uploaded. It will be acquired when you resume the scheduler.",
                    )
                  : t(
                      "Copia caricata e accodata per l’acquisizione locale.",
                      "Copy uploaded and queued for local acquisition.",
                    )}
              </p>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!file) return;
                  void a.run(async () => {
                    const start = await call("ao3UploadStart", {
                      id: uploadID,
                      url: selected.url,
                      size: file.size,
                      mime: file.type || "application/octet-stream",
                    });
                    setUploaded(start.received);
                    for (
                      let offset = start.received;
                      offset < file.size;
                      offset += 512 * 1024
                    ) {
                      const part = new Uint8Array(
                        await file
                          .slice(offset, offset + 512 * 1024)
                          .arrayBuffer(),
                      );
                      let binary = "";
                      for (let i = 0; i < part.length; i += 8192)
                        binary += String.fromCharCode(
                          ...part.subarray(i, i + 8192),
                        );
                      await call("ao3UploadChunk", {
                        id: uploadID,
                        offset,
                        data: btoa(binary),
                      });
                      setUploaded(offset + part.length);
                    }
                    await call("ao3UploadFinish", { id: uploadID });
                    setDone(true);
                    await refresh();
                  });
                }}
              >
                <Field
                  label={t("Copia locale del media", "Local media copy")}
                  type="file"
                  required
                  disabled={a.busy}
                  onChange={(e) => {
                    setFile(e.target.files?.[0]);
                    setUploadID(crypto.randomUUID());
                    setUploaded(0);
                  }}
                />
                {file && (
                  <div className="sync-upload-progress">
                    <span>
                      {bytes(uploaded)} / {bytes(file.size)}
                    </span>
                    <progress
                      aria-label={t("Caricamento media", "Media upload")}
                      value={uploaded}
                      max={file.size || 1}
                    />
                  </div>
                )}
                <p className="sync-caption">
                  {paused
                    ? t(
                        "Lo scheduler è in pausa: il file caricato resterà in attesa.",
                        "The scheduler is paused: the uploaded file will wait.",
                      )
                    : t(
                        "L’acquisizione della copia locale funziona anche durante la manutenzione AO3.",
                        "Local copy acquisition works even during AO3 maintenance.",
                      )}
                </p>
                <Button tone="primary" type="submit" disabled={a.busy || !file}>
                  {a.busy
                    ? t("Caricamento…", "Uploading…")
                    : t("Carica copia locale", "Upload local copy")}
                </Button>
              </form>
            )}
          </>
        )}
      </Modal>
    </section>
  );
}
