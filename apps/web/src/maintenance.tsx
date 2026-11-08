import { useContext, useState } from "react";
import { Link, NavLink, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Button, Select, Field, Modal } from "@palimora/ui";
import { call, settleWrites } from "./api";
import {
  Auth,
  client,
  Heading,
  Loading,
  QueryError,
  Feedback,
  useAction,
  useText,
  Form,
  val,
} from "./shared";
import { date, number, Live } from "./archive-common";
import { Login } from "./access";
import type { Output, User } from "@palimora/contracts";
import "./maintenance.css";
function AdminHeading({ title }: { title: string }) {
  const t = useText();
  return (
    <>
      <Link className="library-back" to="/admin">
        ← {t("Operazioni", "Operations")}
      </Link>
      <Heading>{title}</Heading>
      <nav
        className="catalog-tabs"
        aria-label={t(
          "Amministrazione operativa",
          "Operational administration",
        )}
      >
        <NavLink to="/admin/maintenance">
          {t("Manutenzione", "Maintenance")}
        </NavLink>
        <NavLink to="/admin/integrity">{t("Integrità", "Integrity")}</NavLink>
        <NavLink to="/admin/audit">Audit</NavLink>
      </nav>
    </>
  );
}
export function MaintenancePage() {
  const t = useText(),
    [login, setLogin] = useState(false);
  return (
    <main id="main" className="maintenance-screen">
      <div className="maintenance-rule" />
      <Heading>
        {t(
          "La biblioteca è in manutenzione",
          "The library is under maintenance",
        )}
      </Heading>
      <p>
        {t(
          "L’accesso tornerà disponibile al termine delle operazioni.",
          "Access will return when the work is complete.",
        )}
      </p>
      {login ? (
        <Login
          onDone={async () => {
            location.href = "/admin";
          }}
        />
      ) : (
        <Button onClick={() => setLogin(true)}>
          {t("Accesso amministratori", "Administrator sign in")}
        </Button>
      )}
    </main>
  );
}
export function ImpersonationBar({ data }: { data: Output<"me"> }) {
  const t = useText(),
    a = useAction();
  if (!data.impersonation) return null;
  return (
    <aside
      className="impersonation-bar"
      aria-label={t("Sessione impersonata", "Impersonated session")}
    >
      <span>
        {t("Stai utilizzando Palimora come", "You are using Palimora as")}{" "}
        <strong>{data.user.username}</strong>{" "}
        <small>· {date(data.impersonation.expires_at)}</small>
      </span>
      <Button
        disabled={a.busy}
        onClick={() =>
          void a.run(async () => {
            await settleWrites();
            await call("impersonationStop", {});
            client.clear();
            location.href = "/admin/users/" + data.user.id;
          })
        }
      >
        {t("Torna al tuo account", "Return to your account")}
      </Button>
      <Feedback action={a} />
    </aside>
  );
}
export function ImpersonateButton({
  user,
}: {
  user: Pick<User, "id" | "username" | "role" | "disabled" | "soft_deleted_at">;
}) {
  const t = useText(),
    a = useAction(),
    [open, setOpen] = useState(false);
  if (user.role !== "User" || user.disabled || user.soft_deleted_at)
    return null;
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        {t("Accedi come utente", "Use as this user")}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t("Accedi come ", "Use as ") + user.username}
        closeLabel={t("Chiudi", "Close")}
      >
        <p>
          {t(
            "La sessione dura 15 minuti. Le modifiche appartengono a questo utente e ogni operazione resta attribuita a te.",
            "The session lasts 15 minutes. Changes belong to this user and every operation remains attributed to you.",
          )}
        </p>
        <Feedback action={a} />
        <Button
          disabled={a.busy}
          onClick={() =>
            void a.run(async () => {
              await settleWrites();
              await call("impersonationStart", {
                id: user.id,
                confirmation: true,
              });
              client.clear();
              location.href = "/works";
            })
          }
        >
          {t("Avvia sessione", "Start session")}
        </Button>
      </Modal>
    </>
  );
}
export function Maintenance() {
  const t = useText(),
    a = useAction(),
    q = useQuery({
      queryKey: ["status"],
      queryFn: () => call("status", {}),
      refetchInterval: 5000,
    }),
    [pending, setPending] = useState<
      "normal" | "maintenance_light" | "maintenance_full" | null
    >(null);
  const modes = [
    [
      "normal",
      t("Normale", "Normal"),
      t("Accesso e priorità ordinarie.", "Regular access and scheduling."),
    ],
    [
      "maintenance_light",
      t("Manutenzione leggera", "Light maintenance"),
      t(
        "Elaborazione prioritaria; la biblioteca rimane accessibile.",
        "Prioritize processing; the library stays accessible.",
      ),
    ],
    [
      "maintenance_full",
      t("Manutenzione totale", "Full maintenance"),
      t(
        "Accesso riservato agli amministratori; elaborazione prioritaria.",
        "Administrators only; prioritize processing.",
      ),
    ],
  ] as const;
  return (
    <section className="maintenance-admin">
      <AdminHeading title={t("Manutenzione", "Maintenance")} />
      <Feedback action={a} />
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <QueryError retry={() => void q.refetch()} />
      ) : (
        <div className="maintenance-modes">
          {modes.map(([mode, label, description]) => (
            <div
              key={mode}
              className={q.data.maintenance_mode === mode ? "selected" : ""}
            >
              <div>
                <h2>{label}</h2>
                <p>{description}</p>
              </div>
              <Button
                disabled={q.data.maintenance_mode === mode}
                onClick={() => setPending(mode)}
              >
                {q.data.maintenance_mode === mode
                  ? t("Attiva", "Active")
                  : t("Attiva modalità", "Activate mode")}
              </Button>
            </div>
          ))}
        </div>
      )}
      <p className="ops-caption">
        {t(
          "Le risorse Docker e le pause impostate sui singoli job restano rispettate.",
          "Docker resource limits and pauses on individual jobs remain in effect.",
        )}
      </p>
      <Link to="/admin/operations/jobs">
        {t("Apri job e code", "Open jobs and queues")} ↗
      </Link>
      <Modal
        open={!!pending}
        onClose={() => setPending(null)}
        title={t("Cambia modalità", "Change mode")}
        closeLabel={t("Chiudi", "Close")}
      >
        <p>{modes.find((m) => m[0] === pending)?.[2]}</p>
        <Button
          disabled={a.busy}
          onClick={() =>
            void a.run(async () => {
              await call("maintenanceSet", {
                mode: pending!,
                confirmation: true,
              });
              setPending(null);
              await q.refetch();
            })
          }
        >
          {t("Conferma", "Confirm")}
        </Button>
      </Modal>
    </section>
  );
}
function useIntegrityLabels() {
  const t = useText();
  return {
    states: {
      pending: t("In coda", "Queued"),
      running: t("In corso", "Running"),
      paused: t("In pausa", "Paused"),
      pause_requested: t("Pausa richiesta", "Pause requested"),
      failed: t("Non riuscito", "Failed"),
      completed: t("Completato", "Completed"),
      open: t("Da verificare", "Needs review"),
      repaired: t("Recuperato", "Recovered"),
      unrecoverable: t(
        "Non recuperabile dalla copia",
        "Not recoverable from this copy",
      ),
    } as Record<string, string>,
    phases: {
      inventory: t("Inventario pack", "Pack inventory"),
      packs: t("Struttura dei pack", "Pack structure"),
      objects: t("Oggetti e hash", "Objects and hashes"),
      relations: t("Riferimenti SQL", "SQL references"),
      verify: t("Verifica backup", "Verify backup"),
      search: t("Ricerca nella copia", "Search backup"),
      repair: t("Recupero e pubblicazione", "Recover and publish"),
      payloads: t("Metadati canonici", "Canonical metadata"),
      dictionaries: t("Dizionari del catalogo", "Catalog dictionaries"),
      completed: t("Concluso", "Finished"),
    } as Record<string, string>,
  };
}
export function Integrity() {
  const { states, phases } = useIntegrityLabels();
  const t = useText(),
    a = useAction(),
    { user } = useContext(Auth),
    [params, setParams] = useSearchParams(),
    [problem, setProblem] = useState<any>(null),
    [backup, setBackup] = useState(""),
    [backupCursor, setBackupCursor] = useState<string | undefined>();
  const q = useQuery({
    queryKey: ["integrity", params.get("job")],
    queryFn: () =>
      call("integrityStatus", { job: params.get("job") ?? undefined }),
    refetchInterval: 3000,
  });
  const selected = params.get("job")
      ? q.data?.jobs.find((j) => j.id === params.get("job"))
      : q.data?.jobs[0],
    job = selected?.id as string | undefined,
    cursor = params.get("cursor") ?? undefined;
  const issues = useQuery({
    queryKey: ["integrity-issues", job, cursor],
    queryFn: () => call("integrityIssues", { job: job!, cursor }),
    enabled: !!job,
    refetchInterval: 3000,
  });
  const copies = useQuery({
    queryKey: ["repair-copies", backupCursor],
    queryFn: () => call("backupStatus", { cursor: backupCursor }),
    enabled: !!problem,
  });
  const control = (action: "pause" | "resume") =>
    a.run(async () => {
      await call("integrityControl", { id: job!, action });
      await q.refetch();
    });
  return (
    <section className="maintenance-admin">
      <AdminHeading title={t("Integrità dello storage", "Storage integrity")} />
      <div className="integrity-toolbar">
        <Button
          disabled={a.busy}
          onClick={() =>
            void a.run(async () => {
              const r = await call("integrityStart", {
                requestId: crypto.randomUUID(),
              });
              setParams({ job: r.id });
              await q.refetch();
            })
          }
        >
          {t("Avvia scrub", "Start scrub")}
        </Button>
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
      ) : q.isError ? (
        <QueryError retry={() => void q.refetch()} />
      ) : (
        <>
          <details className="integrity-schedule">
            <summary>
              {t("Verifica periodica", "Periodic verification")} ·{" "}
              {q.data.schedule.enabled
                ? t("attiva", "enabled")
                : t("disattivata", "disabled")}
            </summary>
            <Form
              key={JSON.stringify(q.data.schedule)}
              busy={a.busy}
              onSubmit={(f) =>
                a.run(async () => {
                  await call("integritySchedule", {
                    enabled: f.get("enabled") === "on",
                    every_days: Number(f.get("days")),
                  });
                  await q.refetch();
                })
              }
            >
              <label className="inline-check">
                <input
                  type="checkbox"
                  name="enabled"
                  defaultChecked={!!q.data.schedule.enabled}
                />
                {t("Abilita scrub periodico", "Enable periodic scrub")}
              </label>
              <Field
                name="days"
                label={t("Ogni quanti giorni", "Every how many days")}
                type="number"
                min={1}
                max={365}
                defaultValue={Number(q.data.schedule.every_days)}
              />
              <Button type="submit">
                {t("Salva pianificazione", "Save schedule")}
              </Button>
            </Form>
          </details>
          {selected && (
            <section className="integrity-detail">
              <div className="integrity-toolbar">
                <div>
                  <h2>
                    {selected.kind === "repair"
                      ? t("Recupero da backup", "Backup recovery")
                      : "Scrub"}
                  </h2>
                  <span>
                    {states[String(selected.state)] ?? String(selected.state)} ·{" "}
                    {date(String(selected.updated_at))}
                  </span>
                </div>
                <div className="integrity-actions">
                  {["pending", "running"].includes(String(selected.state)) &&
                    (selected.kind !== "repair" || user.role === "Owner") && (
                      <Button
                        disabled={a.busy}
                        onClick={() => void control("pause")}
                      >
                        {t("Pausa", "Pause")}
                      </Button>
                    )}
                  {["paused", "pause_requested", "failed"].includes(
                    String(selected.state),
                  ) &&
                    (selected.kind !== "repair" || user.role === "Owner") && (
                      <Button
                        disabled={a.busy}
                        onClick={() => void control("resume")}
                      >
                        {t("Riprendi", "Resume")}
                      </Button>
                    )}
                </div>
              </div>
              <Progress data={selected.progress as any} />
              {(selected.result as any)?.code && (
                <p className="notice error" role="alert">
                  {String((selected.result as any).code)}
                </p>
              )}
              {selected.kind === "scrub" && selected.state === "completed" && (
                <p className="ops-caption">
                  {Number((selected.result as any)?.issues ?? 0)}{" "}
                  {Number((selected.result as any)?.issues) === 1
                    ? t("problema rilevato", "issue detected")
                    : t("problemi rilevati", "issues detected")}
                </p>
              )}
              {selected.kind === "repair" && selected.state === "completed" && (
                <details>
                  <summary>
                    {t("Oggetto recuperato", "Recovered object")}
                  </summary>
                  <code className="integrity-id">
                    {String((selected.result as any)?.hash ?? "")}
                  </code>
                  <code className="integrity-id">
                    {String((selected.result as any)?.pack ?? "")}
                  </code>
                </details>
              )}
              <code className="integrity-id">{job}</code>
            </section>
          )}
          <div className="table-scroll">
            <table>
              <caption>{t("Esecuzioni recenti", "Recent runs")}</caption>
              <thead>
                <tr>
                  <th>{t("Operazione", "Operation")}</th>
                  <th>{t("Avvio", "Started")}</th>
                  <th>{t("Stato", "State")}</th>
                  <th>{t("Avanzamento", "Progress")}</th>
                </tr>
              </thead>
              <tbody>
                {q.data.jobs.map((j) => (
                  <tr key={String(j.id)}>
                    <td>
                      <button
                        className="ops-job-link"
                        onClick={() => setParams({ job: String(j.id) })}
                      >
                        {j.kind === "repair"
                          ? t("Recupero", "Recovery")
                          : "Scrub"}{" "}
                        · {String(j.id).slice(0, 8)}
                      </button>
                    </td>
                    <td>{date(String(j.created_at))}</td>
                    <td>{states[String(j.state)] ?? String(j.state)}</td>
                    <td>{phases[String((j.progress as any).phase)] ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Link to="/admin/operations/jobs?family=admin">
            {t(
              "Storico amministrativo completo",
              "Full administration history",
            )}{" "}
            ↗
          </Link>
          {params.get("job") && !selected && (
            <p className="notice error">
              {t("Esecuzione non trovata.", "Run not found.")}
            </p>
          )}
          {!q.data.jobs.length && (
            <p className="ops-empty">
              {t("Nessuna verifica eseguita.", "No verification has run.")}
            </p>
          )}
          {job && (
            <>
              <h2>{t("Problemi rilevati", "Detected issues")}</h2>
              {issues.isPending ? (
                <Loading />
              ) : issues.isError ? (
                <QueryError retry={() => void issues.refetch()} />
              ) : (
                <>
                  <div className="table-scroll">
                    <table className="integrity-issues">
                      <thead>
                        <tr>
                          <th>{t("Oggetto / pack", "Object / pack")}</th>
                          <th>{t("Problema", "Issue")}</th>
                          <th>{t("Stato", "State")}</th>
                          <th>{t("Azione", "Action")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {issues.data?.items.map((p) => (
                          <tr key={String(p.id)}>
                            <td>
                              <code>
                                {String(p.object_hash ?? p.pack ?? p.identity)}
                              </code>
                              {p.object_hash != null && p.pack != null && (
                                <small>{String(p.pack)}</small>
                              )}
                            </td>
                            <td>
                              {String(p.code)}
                              {Object.keys(p.detail as object).length > 0 && (
                                <details>
                                  <summary>{t("Dettagli", "Details")}</summary>
                                  <pre>{JSON.stringify(p.detail, null, 2)}</pre>
                                </details>
                              )}
                            </td>
                            <td>
                              {states[String(p.state)] ?? String(p.state)}
                            </td>
                            <td>
                              {p.object_hash != null &&
                                p.repairable === true &&
                                p.state !== "repaired" &&
                                user.role === "Owner" && (
                                  <Button
                                    onClick={() => {
                                      setProblem(p);
                                      setBackup("");
                                    }}
                                  >
                                    {t("Recupera", "Recover")}
                                  </Button>
                                )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {!issues.data?.items.length && (
                    <p className="ops-empty">
                      {t(
                        "Nessun problema registrato per questa esecuzione.",
                        "No issues recorded for this run.",
                      )}
                    </p>
                  )}
                  <div className="integrity-actions">
                    {cursor && (
                      <Button onClick={() => setParams({ job })}>
                        {t("Prima pagina", "First page")}
                      </Button>
                    )}
                    {issues.data?.next && (
                      <Button
                        onClick={() =>
                          setParams({ job, cursor: issues.data!.next! })
                        }
                      >
                        {t("Successivi", "Next")}
                      </Button>
                    )}
                  </div>
                </>
              )}
            </>
          )}
        </>
      )}
      <Modal
        open={!!problem}
        onClose={() => setProblem(null)}
        title={t("Recupera oggetto", "Recover object")}
        closeLabel={t("Chiudi", "Close")}
      >
        <p>
          {t(
            "La copia deve contenere lo stesso SHA-256. I byte verificati saranno scritti in un nuovo pack, conservando quelli esistenti.",
            "The copy must contain the same SHA-256. Verified bytes will be written to a new pack, retaining existing files.",
          )}
        </p>
        <code className="integrity-id">
          {String(problem?.object_hash ?? "")}
        </code>
        {copies.isPending ? (
          <Loading />
        ) : copies.isError ? (
          <QueryError retry={() => void copies.refetch()} />
        ) : (
          <>
            <Select
              label={t("Backup o export", "Backup or export")}
              value={backup}
              onChange={(e) => setBackup(e.target.value)}
            >
              <option value="">{t("Seleziona copia", "Choose copy")}</option>
              {copies.data.runs
                .filter(
                  (r) =>
                    r.state === "completed" &&
                    ["full", "export"].includes(r.kind),
                )
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.kind} · {date(r.created_at)} · {r.id.slice(0, 8)}
                  </option>
                ))}
            </Select>
            {copies.data.next && (
              <Button onClick={() => setBackupCursor(copies.data.next!)}>
                {t("Copie precedenti", "Older copies")}
              </Button>
            )}
          </>
        )}
        <Feedback action={a} />
        <Button
          disabled={!backup || a.busy}
          onClick={() =>
            void a.run(async () => {
              const r = await call("integrityRepair", {
                requestId: crypto.randomUUID(),
                issue: String(problem.id),
                backup,
                confirmation: true,
              });
              setProblem(null);
              setParams({ job: r.id });
              await q.refetch();
            })
          }
        >
          {t("Verifica e recupera", "Verify and recover")}
        </Button>
      </Modal>
    </section>
  );
}
function Progress({ data }: { data: any }) {
  const { phases } = useIntegrityLabels();
  return (
    <div className="integrity-progress">
      <span>{phases[data?.phase] ?? data?.phase ?? "—"}</span>
      {Number(data?.total) > 0 && (
        <>
          <progress
            max={Number(data.total)}
            value={Number(data.completed ?? 0)}
          />
          <span>
            {number(data.completed ?? 0)} / {number(data.total)}
          </span>
        </>
      )}
      {data?.pack && data.phase !== "completed" && <code>{data.pack}</code>}
    </div>
  );
}
export function Audit() {
  const t = useText(),
    [params, setParams] = useSearchParams(),
    q = useQuery({
      queryKey: ["audit", params.toString()],
      queryFn: () =>
        call("auditList", {
          cursor: params.get("cursor") ?? undefined,
          actor: params.get("actor") ?? undefined,
          target: params.get("target") || undefined,
          action: params.get("action") || undefined,
          outcome: (params.get("outcome") || undefined) as
            | "success"
            | "failure"
            | undefined,
        }),
      refetchInterval: 10000,
    });
  return (
    <section className="maintenance-admin">
      <AdminHeading title="Audit" />
      <Form
        onSubmit={async (f) => {
          const next = new URLSearchParams();
          for (const k of ["target", "action", "outcome"])
            if (val(f, k)) next.set(k, val(f, k));
          setParams(next);
        }}
      >
        <div className="audit-filters">
          <Field
            label={t("Risorsa", "Resource")}
            name="target"
            defaultValue={params.get("target") ?? ""}
          />
          <Field
            label={t("Azione", "Action")}
            name="action"
            defaultValue={params.get("action") ?? ""}
          />
          <Select
            name="outcome"
            label={t("Esito", "Outcome")}
            defaultValue={params.get("outcome") ?? ""}
          >
            <option value="">{t("Tutti", "All")}</option>
            <option value="success">{t("Riuscito", "Success")}</option>
            <option value="failure">{t("Non riuscito", "Failure")}</option>
          </Select>
          <Button type="submit">{t("Filtra", "Filter")}</Button>
          {params.size > 0 && (
            <Button onClick={() => setParams({})}>
              {t("Azzera filtri", "Clear filters")}
            </Button>
          )}
        </div>
      </Form>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <QueryError retry={() => void q.refetch()} />
      ) : (
        <>
          <div className="table-scroll">
            <table className="audit-table">
              <thead>
                <tr>
                  <th>{t("Quando", "When")}</th>
                  <th>{t("Operatore", "Operator")}</th>
                  <th>{t("Azione / risorsa", "Action / resource")}</th>
                  <th>{t("Esito", "Outcome")}</th>
                  <th>{t("Dettagli", "Details")}</th>
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((r) => (
                  <tr key={String(r.id)}>
                    <td>{date(String(r.created_at))}</td>
                    <td>
                      {r.actor_id ? (
                        <button
                          className="text-button"
                          aria-label={
                            t("Filtra operatore: ", "Filter operator: ") +
                            String(r.actor)
                          }
                          onClick={() => setParams({ actor: r.actor_id! })}
                        >
                          {r.actor}
                        </button>
                      ) : (
                        t("Sistema", "System")
                      )}
                      {r.effective_user_id !== r.actor_id && (
                        <small>→ {String(r.effective_user ?? "—")}</small>
                      )}
                    </td>
                    <td>
                      {String(r.action)}
                      <small>{String(r.target ?? "—")}</small>
                    </td>
                    <td>
                      {r.outcome === "success"
                        ? t("Riuscito", "Success")
                        : t("Non riuscito", "Failure")}
                    </td>
                    <td>
                      <details>
                        <summary>{t("Apri", "Open")}</summary>
                        <dl>
                          <dt>IP</dt>
                          <dd>{String(r.ip || "—")}</dd>
                          <dt>{t("Sessione", "Session")}</dt>
                          <dd>{String(r.session_id ?? "—")}</dd>
                          <dt>Request ID</dt>
                          <dd>{String(r.request_id)}</dd>
                        </dl>
                        <pre>{JSON.stringify(r.details, null, 2)}</pre>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!q.data.items.length && (
            <p>
              {t(
                "Nessuna operazione corrispondente.",
                "No matching operations.",
              )}
            </p>
          )}
          <div className="integrity-actions">
            {params.has("cursor") && (
              <Button
                onClick={() => {
                  const n = new URLSearchParams(params);
                  n.delete("cursor");
                  setParams(n);
                }}
              >
                {t("Più recenti", "Most recent")}
              </Button>
            )}
            {q.data.next && (
              <Button
                onClick={() => {
                  const n = new URLSearchParams(params);
                  n.set("cursor", q.data.next!);
                  setParams(n);
                }}
              >
                {t("Precedenti", "Older")}
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
