import { useContext, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { Button, Field, Select, Modal } from "@palimora/ui";
import { call } from "./api";
import {
  Auth,
  Heading,
  Loading,
  QueryError,
  useAction,
  Feedback,
  useText,
} from "./shared";
import { bytes, date, Live } from "./archive-common";
import type { Output } from "@palimora/contracts";
import "./backups.css";
type Schedule = Output<"backupStatus">["schedules"][number];
export function Backups() {
  const t = useText(),
    { user } = useContext(Auth),
    client = useQueryClient(),
    a = useAction();
  const [params, setParams] = useSearchParams();
  const view = params.get("view") ?? "runs",
    selected = params.get("id") ?? undefined,
    cursor = params.get("cursor") ?? undefined;
  const [create, setCreate] = useState(false),
    [kind, setKind] = useState<"full" | "platform" | "export">("full"),
    [dest, setDest] = useState(""),
    [base, setBase] = useState(""),
    [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [schedule, setSchedule] = useState<Partial<Schedule>>(),
    [target, setTarget] = useState<{
      name: string;
      label: string;
      enabled: boolean;
    }>(),
    [confirm, setConfirm] = useState<"delete" | "cancel" | "restore">(),
    [restoreTarget, setRestoreTarget] = useState(""),
    [phrase, setPhrase] = useState("");
  const q = useQuery({
    queryKey: ["backups", cursor],
    queryFn: () => call("backupStatus", { cursor }),
    refetchInterval: 3000,
  });
  const detail = useQuery({
    queryKey: ["backup", selected],
    queryFn: () => call("backupDetail", { id: selected! }),
    enabled: !!selected,
    refetchInterval: 2000,
  });
  const preview = useQuery({
    queryKey: ["backup-restore", selected],
    queryFn: () => call("backupRestorePreview", { id: selected! }),
    enabled: confirm === "restore",
    staleTime: 0,
  });
  const labels: Record<string, string> = {
    full: t("Backup completo", "Full backup"),
    platform: t("Backup piattaforma", "Platform backup"),
    export: t("Export archivistico", "Archive export"),
    verify: t("Verifica", "Verification"),
    restore: t("Ripristino", "Restore"),
    delete: t("Eliminazione", "Deletion"),
  };
  const states: Record<string, string> = {
    pending: t("In coda", "Queued"),
    running: t("In corso", "Running"),
    pause_requested: t("Pausa richiesta", "Pausing"),
    paused: t("In pausa", "Paused"),
    cancel_requested: t("Arresto richiesto", "Stopping"),
    cancelled: t("Annullato", "Cancelled"),
    completed: t("Completato", "Completed"),
    failed: t("Non riuscito", "Failed"),
    deleted: t("Eliminato", "Deleted"),
  };
  const phases: Record<string, string> = {
    preparing: t("Preparazione", "Preparing"),
    catalog: t("Cattura del catalogo", "Capturing catalogue"),
    packs: t("Copia dei pack", "Copying packs"),
    capture: t("Cattura dei contenuti", "Capturing content"),
    volumes: t("Scrittura dei volumi", "Writing volumes"),
    restore: t(
      "Ripristino e controllo integrità",
      "Restoring and checking integrity",
    ),
    completed: t("Operazione conclusa", "Operation complete"),
  };
  const errorText = (code: string) =>
    (
      ({
        BACKUP_MOUNT_UNAVAILABLE: t(
          "Disco non montato. Ricollega la destinazione e riprova.",
          "Disk is not mounted. Reconnect the destination and retry.",
        ),
        BACKUP_TARGET_IDENTITY: t(
          "Identità del disco diversa da quella configurata.",
          "The disk identity does not match the configuration.",
        ),
        BACKUP_PERMISSION_DENIED: t(
          "Permessi di scrittura insufficienti.",
          "Write permission is missing.",
        ),
        BACKUP_READ_ONLY: t(
          "Il disco è in sola lettura.",
          "The disk is read-only.",
        ),
        BACKUP_SPACE_INSUFFICIENT: t(
          "Spazio libero insufficiente. Libera spazio e riprendi la copia.",
          "Not enough free space. Free space and resume the copy.",
        ),
        RESTORE_USERS_EXIST: t(
          "La destinazione contiene già account.",
          "The destination already contains accounts.",
        ),
        RESTORE_DATABASE_NOT_EMPTY: t(
          "Il database di destinazione non è vuoto.",
          "The destination database is not empty.",
        ),
        RESTORE_CORPUS_REQUIRED: t(
          "Prepara prima il corpus di destinazione.",
          "Prepare the destination corpus first.",
        ),
        RESTORE_STORAGE_NOT_EMPTY: t(
          "La directory storage esiste già.",
          "The storage directory already exists.",
        ),
        RESTORE_TARGET_IS_SOURCE: t(
          "La destinazione coincide con l’istanza corrente.",
          "The destination is the current instance.",
        ),
        BACKUP_AUTHORITY_REVOKED: t(
          "L’operatore non ha più i permessi necessari.",
          "The operator no longer has the required permissions.",
        ),
      }) as Record<string, string>
    )[code] ??
    t(
      "Controllo non riuscito. Consulta il codice tecnico.",
      "Check failed. See the technical code.",
    );
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ["backups"] });
    await client.invalidateQueries({ queryKey: ["backup"] });
  };
  const act = (fn: () => Promise<unknown>) =>
    a.run(async () => {
      await fn();
      await refresh();
    });
  const control = (
    action: "pause" | "resume" | "verify" | "cancel" | "delete",
  ) =>
    act(() =>
      call("backupControl", {
        id: selected!,
        action,
        requestId: crypto.randomUUID(),
        ...(action === "delete" ? { confirmation: "DELETE " + selected } : {}),
      }),
    );
  const start = () => {
    setRequestId(crypto.randomUUID());
    setDest(
      q.data?.destinations.find((d) => d.enabled && d.health.available)?.name ??
        "",
    );
    setBase("");
    setCreate(true);
  };
  const r = detail.data?.id === selected ? detail.data : undefined,
    own = user.role === "Owner";
  const files = (r?.result.files ?? []) as {
    name: string;
    size: number;
    sha256?: string;
  }[];
  const select = (id?: string) => {
    const p = new URLSearchParams(params);
    if (id) p.set("id", id);
    else p.delete("id");
    setParams(p);
  };
  return (
    <section className="backup-manager">
      <div className="archive-page-heading">
        <div>
          <p className="backup-context">
            {t("Amministrazione", "Administration")}
          </p>
          <Heading>{t("Backup ed export", "Backups and exports")}</Heading>
        </div>
        <Button tone="primary" onClick={start}>
          {t("Nuova copia", "New copy")}
        </Button>
      </div>
      <div className="backup-toolbar">
        <nav aria-label={t("Sezioni backup", "Backup sections")}>
          {[
            ["runs", t("Operazioni", "Operations")],
            ["destinations", t("Destinazioni", "Destinations")],
            ["schedules", t("Pianificazioni", "Schedules")],
          ].map(([key, label]) => (
            <button
              key={key}
              aria-current={view === key ? "page" : undefined}
              onClick={() => setParams({ view: key })}
            >
              {label}
            </button>
          ))}
        </nav>
        <Live
          updated={q.dataUpdatedAt}
          fetching={q.isFetching}
          error={q.isError}
          refresh={q.refetch}
        />
      </div>
      <Feedback action={a} />
      {q.isPending ? (
        <Loading />
      ) : q.isError && !q.data ? (
        <QueryError retry={() => void q.refetch()} />
      ) : (
        q.data && (
          <>
            {view === "runs" && (
              <>
                {selected && (
                  <section
                    className="backup-detail"
                    data-operation-id={r?.id}
                    aria-label={t("Dettaglio operazione", "Operation details")}
                  >
                    <div className="backup-section-title">
                      <h2>
                        {r ? labels[r.kind] : t("Operazione", "Operation")}
                      </h2>
                      <Button onClick={() => select()}>
                        {t("Chiudi", "Close")}
                      </Button>
                    </div>
                    {detail.isPending || (!r && !detail.isError) ? (
                      <Loading />
                    ) : detail.isError ? (
                      <QueryError retry={() => void detail.refetch()} />
                    ) : (
                      r && (
                        <>
                          <div className="backup-detail-meta">
                            <span className={"backup-state " + r.state}>
                              {states[r.state]}
                            </span>
                            <span>{r.destination}</span>
                            <time>{date(r.created_at)}</time>
                          </div>
                          {[
                            "running",
                            "pending",
                            "pause_requested",
                            "cancel_requested",
                          ].includes(r.state) && (
                            <div className="backup-progress" aria-live="polite">
                              <span>
                                {phases[String(r.progress.phase)] ??
                                  states[r.state]}
                              </span>
                              <progress
                                aria-label={t("Avanzamento", "Progress")}
                                {...(Number(r.progress.total) > 0
                                  ? {
                                      max: Number(r.progress.total),
                                      value: Number(r.progress.completed ?? 0),
                                    }
                                  : {})}
                              />
                              {Number(r.progress.total) > 0 && (
                                <small>
                                  {String(r.progress.completed ?? 0)} /{" "}
                                  {String(r.progress.total)}
                                </small>
                              )}
                            </div>
                          )}
                          {r.error && (
                            <p className="notice error" role="alert">
                              {errorText(r.error)} <code>{r.error}</code>
                            </p>
                          )}
                          <dl className="backup-facts">
                            <div>
                              <dt>{t("Dimensione", "Size")}</dt>
                              <dd>{bytes(r.result.bytes as number)}</dd>
                            </div>
                            <div>
                              <dt>
                                {t("Ultima verifica", "Last verification")}
                              </dt>
                              <dd>{date(r.verified_at)}</dd>
                            </div>
                            {r.base_id && (
                              <div>
                                <dt>{t("Dipendenza", "Dependency")}</dt>
                                <dd>
                                  <button onClick={() => select(r.base_id!)}>
                                    {t(
                                      "Apri export precedente",
                                      "Open preceding export",
                                    )}
                                  </button>
                                </dd>
                              </div>
                            )}
                            {r.kind === "restore" && (
                              <>
                                <div>
                                  <dt>
                                    {t(
                                      "Istanza di destinazione",
                                      "Destination instance",
                                    )}
                                  </dt>
                                  <dd>{r.restore_target}</dd>
                                </div>
                                <div>
                                  <dt>
                                    {t("Righe ripristinate", "Restored rows")}
                                  </dt>
                                  <dd>{String(r.result.restored ?? "—")}</dd>
                                </div>
                                <div>
                                  <dt>
                                    {t(
                                      "Riferimenti irrisolvibili",
                                      "Unresolved references",
                                    )}
                                  </dt>
                                  <dd>{String(r.result.unresolved ?? "—")}</dd>
                                </div>
                              </>
                            )}
                            {r.source_id && (
                              <div>
                                <dt>{t("Copia di origine", "Source copy")}</dt>
                                <dd>
                                  <button
                                    className="backup-row-link"
                                    onClick={() => select(r.source_id!)}
                                  >
                                    {t("Apri copia", "Open copy")}
                                  </button>
                                </dd>
                              </div>
                            )}
                          </dl>
                          <div className="backup-actions">
                            {["pending", "running"].includes(r.state) &&
                              ["full", "platform", "export"].includes(
                                r.kind,
                              ) && (
                                <Button
                                  disabled={a.busy}
                                  onClick={() => control("pause")}
                                >
                                  {t("Pausa", "Pause")}
                                </Button>
                              )}
                            {["paused", "failed", "cancelled"].includes(
                              r.state,
                            ) &&
                              (r.kind !== "restore" || own) && (
                                <Button
                                  disabled={a.busy}
                                  onClick={() => control("resume")}
                                >
                                  {t("Riprendi", "Resume")}
                                </Button>
                              )}
                            {[
                              "pending",
                              "running",
                              "paused",
                              "failed",
                              "pause_requested",
                            ].includes(r.state) &&
                              [
                                "full",
                                "platform",
                                "export",
                                "restore",
                              ].includes(r.kind) &&
                              (r.kind !== "restore" || own) && (
                                <Button onClick={() => setConfirm("cancel")}>
                                  {t("Annulla operazione", "Cancel operation")}
                                </Button>
                              )}
                            {r.state === "completed" &&
                              ["full", "platform", "export"].includes(
                                r.kind,
                              ) && (
                                <>
                                  <Button
                                    disabled={a.busy}
                                    onClick={() => control("verify")}
                                  >
                                    {t(
                                      "Verifica integrità",
                                      "Verify integrity",
                                    )}
                                  </Button>
                                  {own && r.kind !== "export" && (
                                    <Button
                                      disabled={!r.verified_at}
                                      onClick={() => {
                                        setRestoreTarget("");
                                        setPhrase("");
                                        setConfirm("restore");
                                      }}
                                    >
                                      {t("Ripristina", "Restore")}
                                    </Button>
                                  )}
                                  {r.kind === "export" && (
                                    <Button
                                      onClick={() => {
                                        start();
                                        setKind("export");
                                        setBase(r.id);
                                      }}
                                    >
                                      {t(
                                        "Nuovo incrementale",
                                        "New incremental",
                                      )}
                                    </Button>
                                  )}
                                </>
                              )}
                            {[
                              "completed",
                              "failed",
                              "cancelled",
                              "paused",
                            ].includes(r.state) &&
                              ["full", "platform", "export"].includes(
                                r.kind,
                              ) && (
                                <Button
                                  tone="danger"
                                  onClick={() => setConfirm("delete")}
                                >
                                  {t("Elimina copia", "Delete copy")}
                                </Button>
                              )}
                          </div>
                          {files.length > 0 && (r.kind === "export" || own) && (
                            <details className="backup-files">
                              <summary>
                                {t("File da scaricare", "Download files")}{" "}
                                <span>{files.length}</span>
                              </summary>
                              <ul>
                                {files.map((f) => (
                                  <li key={f.name}>
                                    <a
                                      href={
                                        "/api/v1/admin/backups/" +
                                        r.id +
                                        "/files/" +
                                        f.name
                                      }
                                      download
                                    >
                                      {f.name}
                                    </a>
                                    <span>{bytes(f.size)}</span>
                                    {f.sha256 && (
                                      <code title={f.sha256}>
                                        {f.sha256.slice(0, 16)}…
                                      </code>
                                    )}
                                  </li>
                                ))}
                              </ul>
                            </details>
                          )}
                          <details className="backup-technical">
                            <summary>
                              {t("Dettagli tecnici", "Technical details")}
                            </summary>
                            <dl>
                              <dt>ID</dt>
                              <dd>
                                <code>{r.id}</code>
                              </dd>
                              {r.result.hash != null && (
                                <>
                                  <dt>SHA-256</dt>
                                  <dd>
                                    <code>{String(r.result.hash)}</code>
                                  </dd>
                                </>
                              )}
                              {r.progress.table != null && (
                                <>
                                  <dt>{t("Tabella", "Table")}</dt>
                                  <dd>{String(r.progress.table)}</dd>
                                </>
                              )}
                            </dl>
                            {Array.isArray(r.result.issues) &&
                              r.result.issues.length > 0 && (
                                <ul>
                                  {(r.result.issues as any[]).map(
                                    (issue, i) => (
                                      <li key={i}>
                                        {issue.table} · {issue.reason}
                                      </li>
                                    ),
                                  )}
                                </ul>
                              )}
                            {Array.isArray(r.result.issues) &&
                              Number(r.result.unresolved) >
                                r.result.issues.length && (
                                <p>
                                  {t(
                                    "Il report integrale è conservato nell’istanza ripristinata.",
                                    "The full report is stored in the restored instance.",
                                  )}
                                </p>
                              )}
                          </details>
                        </>
                      )
                    )}
                  </section>
                )}
                <div className="table-scroll">
                  <table className="backup-history">
                    <caption className="sr-only">
                      {t("Storico delle operazioni", "Operation history")}
                    </caption>
                    <thead>
                      <tr>
                        <th>{t("Operazione", "Operation")}</th>
                        <th>{t("Destinazione", "Destination")}</th>
                        <th>{t("Stato", "State")}</th>
                        <th>{t("Creata", "Created")}</th>
                        <th>{t("Dimensione", "Size")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {q.data.runs.map((run) => (
                        <tr
                          key={run.id}
                          className={
                            selected === run.id ? "backup-selected" : ""
                          }
                        >
                          <td>
                            <button
                              className="backup-row-link"
                              onClick={() => select(run.id)}
                            >
                              {labels[run.kind]}
                              {run.base_id && (
                                <small>
                                  {t("Incrementale", "Incremental")}
                                </small>
                              )}
                            </button>
                          </td>
                          <td>
                            {q.data.destinations.find(
                              (d) => d.name === run.destination,
                            )?.label ?? run.destination}
                          </td>
                          <td>
                            <span className={"backup-state " + run.state}>
                              {states[run.state]}
                            </span>
                          </td>
                          <td>{date(run.created_at)}</td>
                          <td>{bytes(run.result.bytes as number)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!q.data.runs.length && (
                  <p className="backup-empty">
                    {t(
                      "Nessuna operazione. Crea la prima copia scegliendo modalità e destinazione.",
                      "No operations yet. Choose a mode and destination to create your first copy.",
                    )}
                  </p>
                )}
                <div className="backup-pagination">
                  {cursor && (
                    <Button onClick={() => setParams({})}>
                      {t("Più recenti", "Most recent")}
                    </Button>
                  )}
                  {q.data.next && (
                    <Button
                      onClick={() => setParams({ cursor: q.data!.next! })}
                    >
                      {t("Precedenti", "Older")}
                    </Button>
                  )}
                </div>
              </>
            )}
            {view === "destinations" && (
              <>
                <div className="backup-section-title">
                  <h2>{t("Dischi autorizzati", "Authorized disks")}</h2>
                </div>
                {!q.data.destinations.length && (
                  <p className="backup-empty">
                    {t(
                      "Nessuna destinazione configurata. Monta il file operatore BACKUP_CONFIG_FILE e le directory di backup sul servizio.",
                      "No destinations configured. Mount BACKUP_CONFIG_FILE and the backup directories on the service.",
                    )}
                  </p>
                )}
                {q.data.destinations.map((d) => (
                  <div className="backup-destination" key={d.name}>
                    <div>
                      <h3>{d.label}</h3>
                      <small>
                        {d.name} ·{" "}
                        {d.enabled
                          ? t("Abilitata", "Enabled")
                          : t("Disabilitata", "Disabled")}
                      </small>
                    </div>
                    <div>
                      <strong>
                        {d.health.available
                          ? t("Disponibile", "Available")
                          : t("Non disponibile", "Unavailable")}
                      </strong>
                      {d.health.available ? (
                        <>
                          <span>
                            {bytes(d.health.free as number)}{" "}
                            {t("liberi su", "free of")}{" "}
                            {bytes(d.health.total as number)}
                          </span>
                          <meter
                            min={0}
                            max={Number(d.health.total) || 1}
                            value={
                              Number(d.health.total) - Number(d.health.free)
                            }
                            aria-label={t("Spazio occupato", "Used space")}
                          />
                        </>
                      ) : (
                        <small title={String(d.health.error ?? "")}>
                          {d.health.error
                            ? errorText(String(d.health.error))
                            : t("In attesa del controllo", "Awaiting check")}
                        </small>
                      )}
                    </div>
                    <Button onClick={() => setTarget(d)}>
                      {t("Configura", "Configure")}
                    </Button>
                  </div>
                ))}
              </>
            )}
            {view === "schedules" && (
              <>
                <div className="backup-section-title">
                  <h2>{t("Pianificazioni", "Schedules")}</h2>
                  <Button
                    onClick={() =>
                      setSchedule({
                        id: crypto.randomUUID(),
                        kind: "full",
                        destination:
                          q.data?.destinations.find((d) => d.enabled)?.name ??
                          "",
                        enabled: false,
                        every_hours: 24,
                        keep: 7,
                      })
                    }
                  >
                    {t("Nuova pianificazione", "New schedule")}
                  </Button>
                </div>
                {!q.data.schedules.length && (
                  <p className="backup-empty">
                    {t(
                      "Nessuna pianificazione attiva. Le copie automatiche si avviano solo quando le abiliti.",
                      "No schedules. Automatic copies start only when you enable them.",
                    )}
                  </p>
                )}
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>{t("Modalità", "Mode")}</th>
                        <th>{t("Destinazione", "Destination")}</th>
                        <th>{t("Frequenza", "Frequency")}</th>
                        <th>{t("Conservazione", "Retention")}</th>
                        <th>{t("Prossima copia", "Next copy")}</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {q.data.schedules.map((s) => (
                        <tr key={s.id}>
                          <td>{labels[s.kind]}</td>
                          <td>{s.destination}</td>
                          <td>{s.every_hours} h</td>
                          <td>
                            {s.keep} {t("copie", "copies")}
                          </td>
                          <td>
                            {s.enabled
                              ? date(s.next_at)
                              : t("Disattivata", "Disabled")}
                          </td>
                          <td>
                            <Button onClick={() => setSchedule(s)}>
                              {t("Modifica", "Edit")}
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        )
      )}
      <Modal
        open={create}
        onClose={() => setCreate(false)}
        closeLabel={t("Chiudi", "Close")}
        title={t("Nuova copia", "New copy")}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await call("backupCreate", {
                requestId,
                kind,
                destination: dest,
                ...(base && kind === "export" ? { base } : {}),
              });
              setCreate(false);
              setParams({ id: requestId });
            });
          }}
        >
          <Select
            label={t("Modalità", "Mode")}
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            {["full", "platform", "export"].map((k) => (
              <option value={k} key={k}>
                {labels[k]}
              </option>
            ))}
          </Select>
          <p className="backup-mode-description">
            {kind === "full"
              ? t(
                  "Istanza completa: database, account e corpus storico.",
                  "Entire instance: database, accounts and historical corpus.",
                )
              : kind === "platform"
                ? t(
                    "Account, impostazioni e biblioteca personale; corpus escluso.",
                    "Accounts, settings and personal library; excludes corpus.",
                  )
                : t(
                    "Corpus portabile, versioni e provenienza; nessun dato personale.",
                    "Portable corpus, versions and provenance; no personal data.",
                  )}
          </p>
          <Select
            label={t("Destinazione", "Destination")}
            value={dest}
            required
            onChange={(e) => setDest(e.target.value)}
          >
            <option value="">{t("Seleziona un disco", "Select a disk")}</option>
            {q.data?.destinations.map((d) => (
              <option
                key={d.name}
                value={d.name}
                disabled={!d.enabled || !d.health.available}
              >
                {d.label}
                {!d.health.available
                  ? " · " + t("Non disponibile", "Unavailable")
                  : ""}
              </option>
            ))}
          </Select>
          {kind === "export" && (
            <Select
              label={t("Export precedente", "Previous export")}
              value={base}
              onChange={(e) => setBase(e.target.value)}
            >
              <option value="">
                {t("Nessuno — export completo", "None — full export")}
              </option>
              {q.data?.runs
                .filter((r) => r.kind === "export" && r.state === "completed")
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {date(r.created_at)} · {r.destination}
                  </option>
                ))}
              {base && !q.data?.runs.some((r) => r.id === base) && (
                <option value={base}>{base}</option>
              )}
            </Select>
          )}
          <Feedback action={a} />
          <Button type="submit" tone="primary" disabled={a.busy || !dest}>
            {t("Crea copia", "Create copy")}
          </Button>
        </form>
      </Modal>
      <Modal
        open={!!schedule}
        onClose={() => setSchedule(undefined)}
        closeLabel={t("Chiudi", "Close")}
        title={t("Pianificazione", "Schedule")}
      >
        {schedule && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                await call("backupSchedule", schedule as Schedule);
                setSchedule(undefined);
              });
            }}
          >
            <Select
              label={t("Modalità", "Mode")}
              value={schedule.kind}
              onChange={(e) =>
                setSchedule({
                  ...schedule,
                  kind: e.target.value as Schedule["kind"],
                })
              }
            >
              {["full", "platform", "export"].map((k) => (
                <option key={k} value={k}>
                  {labels[k]}
                </option>
              ))}
            </Select>
            <Select
              label={t("Destinazione", "Destination")}
              required
              value={schedule.destination}
              onChange={(e) =>
                setSchedule({ ...schedule, destination: e.target.value })
              }
            >
              <option value="">{t("Seleziona", "Select")}</option>
              {q.data?.destinations
                .filter((d) => d.enabled)
                .map((d) => (
                  <option key={d.name} value={d.name}>
                    {d.label}
                  </option>
                ))}
            </Select>
            <div className="backup-form-columns">
              <Field
                label={t("Intervallo (ore)", "Interval (hours)")}
                type="number"
                min={1}
                max={8760}
                required
                value={schedule.every_hours}
                onChange={(e) =>
                  setSchedule({
                    ...schedule,
                    every_hours: Number(e.target.value),
                  })
                }
              />
              <Field
                label={t("Copie da conservare", "Copies to retain")}
                type="number"
                min={1}
                max={1000}
                required
                value={schedule.keep}
                onChange={(e) =>
                  setSchedule({ ...schedule, keep: Number(e.target.value) })
                }
              />
            </div>
            <label className="backup-check">
              <input
                type="checkbox"
                checked={schedule.enabled}
                onChange={(e) =>
                  setSchedule({ ...schedule, enabled: e.target.checked })
                }
              />
              {t("Abilita copie automatiche", "Enable automatic copies")}
            </label>
            <p className="backup-mode-description">
              {t(
                "Le basi degli export incrementali e le copie in uso non vengono eliminate.",
                "Incremental bases and copies in use are retained.",
              )}
            </p>
            <Feedback action={a} />
            <Button tone="primary" disabled={a.busy}>
              {t("Salva pianificazione", "Save schedule")}
            </Button>
          </form>
        )}
      </Modal>
      <Modal
        open={!!target}
        onClose={() => setTarget(undefined)}
        closeLabel={t("Chiudi", "Close")}
        title={t("Destinazione", "Destination")}
      >
        {target && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                await call("backupDestination", target);
                setTarget(undefined);
              });
            }}
          >
            <Field
              label={t("Nome visualizzato", "Display name")}
              required
              maxLength={100}
              value={target.label}
              onChange={(e) => setTarget({ ...target, label: e.target.value })}
            />
            <label className="backup-check">
              <input
                type="checkbox"
                checked={target.enabled}
                onChange={(e) =>
                  setTarget({ ...target, enabled: e.target.checked })
                }
              />
              {t("Consenti nuove copie", "Allow new copies")}
            </label>
            <Feedback action={a} />
            <Button disabled={a.busy} tone="primary">
              {t("Salva", "Save")}
            </Button>
          </form>
        )}
      </Modal>
      <Modal
        open={!!confirm}
        onClose={() => setConfirm(undefined)}
        closeLabel={t("Chiudi", "Close")}
        title={
          confirm === "restore"
            ? t(
                "Ripristino su istanza isolata",
                "Restore to an isolated instance",
              )
            : confirm === "delete"
              ? t("Elimina questa copia", "Delete this copy")
              : t("Annulla operazione", "Cancel operation")
        }
      >
        {confirm === "restore" ? (
          preview.isPending ? (
            <Loading />
          ) : preview.isError ? (
            <QueryError retry={() => void preview.refetch()} />
          ) : (
            <>
              <p>
                {r?.kind === "full"
                  ? t(
                      "Il database di destinazione deve essere vuoto. La nuova istanza viene ricostruita senza modificare quella corrente.",
                      "The destination database must be empty. The new instance is rebuilt without changing this instance.",
                    )
                  : t(
                      "La destinazione deve avere un corpus compatibile e nessun account locale. I riferimenti irrisolvibili saranno riportati nel risultato.",
                      "The destination must have a compatible corpus and no local accounts. Unresolved references will be reported.",
                    )}
              </p>
              <Select
                label={t("Istanza di destinazione", "Destination instance")}
                value={restoreTarget}
                onChange={(e) => setRestoreTarget(e.target.value)}
              >
                <option value="">{t("Seleziona", "Select")}</option>
                {preview.data?.targets.map((d) => (
                  <option key={d.name} value={d.name} disabled={!d.ready}>
                    {d.label}
                    {d.ready ? "" : " · " + errorText(d.error ?? "")}
                  </option>
                ))}
              </Select>
              {!preview.data?.targets.length && (
                <p>
                  {t(
                    "Nessun target di restore autorizzato nel file operatore.",
                    "No restore targets authorized in the operator configuration.",
                  )}
                </p>
              )}
              <Field
                label={t(
                  "Scrivi RIPRISTINA per confermare",
                  "Type RESTORE to confirm",
                )}
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
              />
              <Feedback action={a} />
              <Button
                tone="danger"
                disabled={
                  a.busy ||
                  !restoreTarget ||
                  phrase !== t("RIPRISTINA", "RESTORE")
                }
                onClick={() =>
                  act(async () => {
                    const requestId = crypto.randomUUID();
                    await call("backupRestore", {
                      id: selected!,
                      requestId,
                      target: restoreTarget,
                      confirmation: "RESTORE " + preview.data!.hash,
                    });
                    setConfirm(undefined);
                    setParams({ id: requestId });
                  })
                }
              >
                {t("Avvia ripristino", "Start restore")}
              </Button>
            </>
          )
        ) : (
          <>
            <p>
              {confirm === "delete"
                ? t(
                    "I file di questa copia saranno eliminati. Le dipendenze attive impediscono l’eliminazione.",
                    "The files of this copy will be deleted. Active dependencies prevent deletion.",
                  )
                : t(
                    "L’operazione si fermerà al prossimo controllo sicuro. Il corpus e le copie precedenti restano disponibili.",
                    "The operation stops at its next safe checkpoint. The corpus and earlier copies remain available.",
                  )}
            </p>
            <Feedback action={a} />
            <Button
              tone="danger"
              disabled={a.busy}
              onClick={async () => {
                if (await control(confirm === "delete" ? "delete" : "cancel"))
                  setConfirm(undefined);
              }}
            >
              {confirm === "delete"
                ? t("Elimina file", "Delete files")
                : t("Conferma annullamento", "Confirm cancellation")}
            </Button>
          </>
        )}
      </Modal>
    </section>
  );
}
