import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Field } from "@palimora/ui";
import { call } from "./api";
import { useAction, useText, Feedback, Loading, QueryError } from "./shared";
import { date } from "./archive-common";
export function SyncOperations() {
  const t = useText(),
    a = useAction();
  const [cursor, setCursor] = useState<string>(),
    [filter, setFilter] = useState<
      "all" | "pending" | "running" | "retry" | "idle" | "blocked"
    >("all");
  const [selected, setSelected] = useState<string>();
  const [kind, setKind] = useState<
      "work" | "entity" | "media" | "discovery" | "backfill"
    >("work"),
    [target, setTarget] = useState("");
  const [username, setUsername] = useState(""),
    [password, setPassword] = useState("");
  const [upload, setUpload] = useState<File>(),
    [uploadURL, setUploadURL] = useState(""),
    [uploadID, setUploadID] = useState(() => crypto.randomUUID()),
    [uploaded, setUploaded] = useState(0);
  const q = useQuery({
    queryKey: ["ao3-jobs", cursor, filter, selected],
    queryFn: () => call("ao3Jobs", { cursor, state: filter, job: selected }),
    refetchInterval: 10000,
  });
  const run = (fn: () => Promise<unknown>) =>
    void a.run(async () => {
      await fn();
      await q.refetch();
    });
  const labels: Record<string, string> = {
    work: t("Opera", "Work"),
    entity: t("Autore, serie o tag", "Author, series or tag"),
    media: t("Media", "Media"),
    discovery: t("Discovery", "Discovery"),
    backfill: t("Backfill", "Backfill"),
  };
  return (
    <section>
      <h2>{t("Sincronizzazione", "Synchronization")}</h2>
      <Feedback action={a} />
      {q.isPending ? (
        <Loading />
      ) : !q.data ? (
        <QueryError retry={() => void q.refetch()} />
      ) : (
        <>
          <p>
            {q.data.counts.map((c) => `${c.state}: ${c.count}`).join(" · ")} ·{" "}
            {t("Intervallo richieste", "Request spacing")}:{" "}
            {q.data.control.spacing_ms / 1000}s
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              run(() => call("ao3Manual", { kind, target, priority: 10 }));
            }}
            className="inline-form"
          >
            <label>
              {t("Tipo", "Type")}{" "}
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as typeof kind)}
              >
                {Object.entries(labels).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            {!["discovery", "backfill"].includes(kind) && (
              <Field
                label={
                  kind === "work"
                    ? "ID AO3"
                    : kind === "media"
                      ? "URL"
                      : "/users/… · /series/… · /tags/…"
                }
                required
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              />
            )}
            <Button disabled={a.busy} type="submit">
              {t("Accoda verifica", "Queue check")}
            </Button>
          </form>
          <details>
            <summary>{t("Priorità delle code", "Queue priorities")}</summary>
            <form
              key={JSON.stringify(q.data.control.priorities)}
              onSubmit={(e) => {
                e.preventDefault();
                const values = new FormData(e.currentTarget);
                run(() =>
                  call("ao3Priorities", {
                    priorities: {
                      discovery: Number(values.get("discovery")),
                      work: Number(values.get("work")),
                      entity: Number(values.get("entity")),
                      media: Number(values.get("media")),
                      backfill: Number(values.get("backfill")),
                    },
                  }),
                );
              }}
            >
              <p>
                {t(
                  "1 = priorità massima; 100 = minima. Il tempo di attesa aumenta progressivamente la priorità effettiva.",
                  "1 = highest priority; 100 = lowest. Waiting time progressively increases effective priority.",
                )}
              </p>
              {Object.entries(q.data.control.priorities).map(([k, v]) => (
                <Field
                  key={k}
                  label={labels[k]}
                  name={k}
                  type="number"
                  min={1}
                  max={100}
                  required
                  defaultValue={v}
                />
              ))}
              <Button disabled={a.busy} type="submit">
                {t("Salva priorità", "Save priorities")}
              </Button>
            </form>
          </details>
          <details>
            <summary>
              {t("Account tecnico AO3", "AO3 service account")} ·{" "}
              {q.data.control.auth_state}
            </summary>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                run(async () => {
                  await call("ao3Account", {
                    remove: false,
                    username,
                    password,
                  });
                  setPassword("");
                });
              }}
            >
              <Field
                label={t("Nome utente AO3", "AO3 username")}
                autoComplete="off"
                required
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
              <Button disabled={a.busy} type="submit">
                {t("Salva account autorizzato", "Save authorized account")}
              </Button>
              <Button
                disabled={a.busy}
                type="button"
                onClick={() => run(() => call("ao3Account", { remove: true }))}
              >
                {t("Rimuovi account", "Remove account")}
              </Button>
            </form>
          </details>
          <details>
            <summary>
              {t(
                "Carica un media irrecuperabile",
                "Upload an unrecoverable media file",
              )}
            </summary>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!upload) return;
                run(async () => {
                  const started = await call("ao3UploadStart", {
                    id: uploadID,
                    url: uploadURL,
                    size: upload.size,
                    mime: upload.type || "application/octet-stream",
                  });
                  for (
                    let offset = started.received;
                    offset < upload.size;
                    offset += 512 * 1024
                  ) {
                    const part = new Uint8Array(
                      await upload
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
                });
              }}
            >
              <Field
                label={t("URL originale del media", "Original media URL")}
                type="url"
                required
                disabled={a.busy}
                value={uploadURL}
                onChange={(e) => {
                  setUploadURL(e.target.value);
                  setUploadID(crypto.randomUUID());
                  setUploaded(0);
                }}
              />
              <Field
                label={t("File locale", "Local file")}
                type="file"
                required
                disabled={a.busy}
                onChange={(e) => {
                  setUpload(e.target.files?.[0]);
                  setUploadID(crypto.randomUUID());
                  setUploaded(0);
                }}
              />
              {upload && (
                <progress
                  value={uploaded}
                  max={upload.size || 1}
                  aria-label={t("Caricamento media", "Media upload")}
                />
              )}
              <Button disabled={a.busy} type="submit">
                {t("Carica e acquisisci", "Upload and acquire")}
              </Button>
            </form>
          </details>
          <h3>{t("Coda persistente", "Persistent queue")}</h3>
          <label>
            {t("Stato", "State")}{" "}
            <select
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value as typeof filter);
                setCursor(undefined);
              }}
            >
              {["all", "pending", "running", "retry", "idle", "blocked"].map(
                (s) => (
                  <option key={s}>{s}</option>
                ),
              )}
            </select>
          </label>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t("Risorsa", "Resource")}</th>
                  <th>{t("Stato", "State")}</th>
                  <th>{t("Prossimo controllo", "Next check")}</th>
                  <th>{t("Errore", "Error")}</th>
                  <th>{t("Azioni", "Actions")}</th>
                </tr>
              </thead>
              <tbody>
                {q.data.jobs.map((j) => (
                  <tr key={j.id}>
                    <td>
                      <button
                        className="link-button"
                        onClick={() => setSelected(j.id)}
                      >
                        {labels[j.kind]} · {j.target}
                      </button>
                    </td>
                    <td>
                      {j.state} · {j.availability}
                      <br />
                      {t("Priorità", "Priority")} {j.priority}
                    </td>
                    <td>{date(j.due_at)}</td>
                    <td>
                      {j.error ?? "—"}
                      {j.attempts > 0 && ` (${j.attempts})`}
                    </td>
                    <td>
                      <Button
                        disabled={a.busy || j.state === "running"}
                        onClick={() =>
                          run(() =>
                            call("ao3JobControl", {
                              id: j.id,
                              action:
                                j.state === "blocked" ? "resume" : "pause",
                            }),
                          )
                        }
                      >
                        {j.state === "blocked"
                          ? t("Riprendi", "Resume")
                          : t("Pausa", "Pause")}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!q.data.jobs.length && (
            <p>
              {t("Nessun lavoro in questo stato.", "No jobs in this state.")}
            </p>
          )}
          <Button disabled={!cursor} onClick={() => setCursor(undefined)}>
            {t("Prima pagina", "First page")}
          </Button>
          <Button
            disabled={!q.data.next}
            onClick={() => setCursor(q.data!.next!)}
          >
            {t("Successiva", "Next")}
          </Button>
          <h3>{t("Cronologia esecuzioni", "Execution history")}</h3>
          {selected && (
            <Button onClick={() => setSelected(undefined)}>
              {t("Tutte le risorse", "All resources")}
            </Button>
          )}
          <div className="table-scroll">
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
                    <td>{r.target}</td>
                    <td>{date(r.started_at)}</td>
                    <td>{r.outcome}</td>
                    <td>
                      <code>{JSON.stringify(r.detail)}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
