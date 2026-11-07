import "./ao3.css";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@palimora/ui";
import { call } from "./api";
import {
  Heading,
  Loading,
  QueryError,
  Feedback,
  useAction,
  useText,
} from "./shared";
import { date, Live } from "./archive-common";
import {
  SyncQueue,
  SyncSettings,
  SyncHistory,
  SyncMedia,
} from "./ao3-operations";
import { SyncBadge, SyncMark, useSyncLabels } from "./ao3-common";
export function AO3Monitor() {
  const t = useText(),
    label = useSyncLabels(),
    a = useAction(),
    client = useQueryClient();
  const [params] = useSearchParams();
  const [pendingMode, setPendingMode] = useState<string | null>(null);
  const section = params.get("section") ?? "overview";
  const q = useQuery({
    queryKey: ["ao3-status"],
    queryFn: () => call("ao3Status", {}),
    refetchInterval: 10000,
  });
  const jobs = useQuery({
    queryKey: ["ao3-summary"],
    queryFn: () => call("ao3Jobs", {}),
    refetchInterval: 10000,
  });
  const refresh = async () => {
    await Promise.all([
      q.refetch(),
      client.invalidateQueries({ queryKey: ["ao3-summary"] }),
      client.invalidateQueries({ queryKey: ["ao3-jobs"] }),
    ]);
  };
  const control = (
    mode: "auto" | "force_online" | "force_offline",
    paused: boolean,
  ) =>
    void a.run(async () => {
      setPendingMode(mode);
      try {
        await call("ao3Control", { mode, paused });
        await refresh();
      } finally {
        setPendingMode(null);
      }
    });
  const c = q.data?.control;
  const tabs = [
    ["overview", t("Panoramica", "Overview")],
    ["queue", t("Coda", "Queue")],
    ["media", t("Media da recuperare", "Media recovery")],
    ["activity", t("Attività", "Activity")],
    ["settings", t("Impostazioni", "Settings")],
  ];
  const total = (states: string[]) =>
    jobs.data?.counts
      .filter((r) => states.includes(r.state))
      .reduce((n, r) => n + r.count, 0) ?? 0;
  return (
    <div className="archive-view sync-view">
      <div className="archive-page-heading">
        <div>
          <p className="eyebrow">
            {t("Controllo archivio", "Archive control")}
          </p>
          <Heading>{t("Sincronizzazione AO3", "AO3 synchronization")}</Heading>
        </div>
        <Live
          updated={q.dataUpdatedAt}
          fetching={q.isFetching}
          error={q.isError}
          refresh={refresh}
        />
      </div>
      <Feedback action={a} />
      {q.isPending ? (
        <Loading />
      ) : !q.data ? (
        <QueryError retry={() => void q.refetch()} />
      ) : (
        <>
          <div
            className={`sync-status-bar ${c!.eligible ? "enabled" : "suspended"}`}
          >
            <span className="sync-status-icon">
              <SyncMark />
            </span>
            <div className="sync-status-copy">
              <strong>
                {c!.paused
                  ? t("Scheduler in pausa", "Scheduler paused")
                  : c!.eligible
                    ? t("Sincronizzazione abilitata", "Synchronization enabled")
                    : t(
                        "Sincronizzazione sospesa",
                        "Synchronization suspended",
                      )}
              </strong>
              <span>
                {c!.eligible
                  ? t(
                      "Le attività riprendono secondo priorità e limiti di richiesta.",
                      "Jobs run according to priority and request limits.",
                    )
                  : c!.paused
                    ? t(
                        "Pausa amministrativa. Anche le elaborazioni locali sono ferme.",
                        "Administrative pause. Local processing is paused too.",
                      )
                    : c!.mode === "force_offline"
                      ? t(
                          "Modalità Offline. Anche le sonde di disponibilità sono sospese.",
                          "Offline mode. Availability probes are paused too.",
                        )
                      : t(
                          "Nessuna acquisizione remota. Restano attive soltanto le sonde di disponibilità.",
                          "No remote acquisition. Only availability probes remain active.",
                        )}
              </span>
            </div>
            <SyncBadge state={c!.observed_state}>
              {c!.observed_state === "blocked"
                ? t("Accesso bloccato", "Access blocked")
                : label(c!.observed_state)}
            </SyncBadge>
            <Button
              disabled={a.busy}
              onClick={() => control(c!.mode, !c!.paused)}
            >
              {c!.paused
                ? t("Riprendi scheduler", "Resume scheduler")
                : t("Pausa manuale", "Manual pause")}
            </Button>
          </div>
          <nav
            className="sync-nav"
            aria-label={t(
              "Sezioni sincronizzazione AO3",
              "AO3 synchronization sections",
            )}
          >
            {tabs.map(([id, title]) => (
              <Link
                key={id}
                to={`?section=${id}`}
                aria-current={section === id ? "page" : undefined}
              >
                {title}
                {id === "media" && !!jobs.data?.media_unrecoverable && (
                  <span className="sync-count">
                    {jobs.data.media_unrecoverable.toLocaleString()}
                  </span>
                )}
              </Link>
            ))}
          </nav>
          {section === "queue" ? (
            <SyncQueue status={q.data} />
          ) : section === "media" ? (
            <SyncMedia paused={c!.paused} />
          ) : section === "activity" ? (
            <SyncHistory status={q.data} />
          ) : section === "settings" ? (
            jobs.isError && !jobs.data ? (
              <QueryError retry={() => void jobs.refetch()} />
            ) : (
              <SyncSettings data={jobs.data} refresh={refresh} />
            )
          ) : (
            <div className="sync-overview">
              <section className="sync-section">
                <div className="sync-section-heading">
                  <h2>{t("Connessione ad AO3", "AO3 connection")}</h2>
                  <span className="muted">
                    {t("Modalità di disponibilità", "Availability mode")}
                  </span>
                </div>
                <fieldset className="sync-modes">
                  <legend className="sr-only">
                    {t("Disponibilità imposta", "Availability override")}
                  </legend>
                  {(
                    [
                      [
                        "auto",
                        "Auto",
                        t("Segui il monitor", "Follow the monitor"),
                      ],
                      [
                        "force_online",
                        "Online",
                        t("Consenti i tentativi", "Allow attempts"),
                      ],
                      [
                        "force_offline",
                        "Offline",
                        t("Ferma il traffico AO3", "Stop AO3 traffic"),
                      ],
                    ] as const
                  ).map(([mode, title, description]) => (
                    <label
                      key={mode}
                      className={
                        (pendingMode ?? c!.mode) === mode ? "selected" : ""
                      }
                    >
                      <input
                        type="radio"
                        name="ao3-mode"
                        value={mode}
                        checked={(pendingMode ?? c!.mode) === mode}
                        disabled={a.busy}
                        onChange={() => control(mode, c!.paused)}
                      />
                      <span>
                        <strong>{title}</strong>
                        <small>{description}</small>
                      </span>
                    </label>
                  ))}
                </fieldset>
                <p className="sync-caption">
                  {c!.mode === "auto"
                    ? t(
                        "Ripresa automatica quando il monitor conferma che AO3 è operativo.",
                        "Automatically resumes when the monitor confirms AO3 is operational.",
                      )
                    : c!.mode === "force_online"
                      ? t(
                          "Consente tentativi con stato incerto. Manutenzione, blocchi e cooldown restano vincolanti.",
                          "Allows attempts with an uncertain status. Maintenance, access blocks and cooldowns still apply.",
                        )
                      : t(
                          "La biblioteca locale resta disponibile. Seleziona Auto per riattivare il monitor.",
                          "The local library stays available. Select Auto to restart monitoring.",
                        )}
                </p>
                <dl className="sync-facts">
                  <div>
                    <dt>{t("Ultima sonda", "Last probe")}</dt>
                    <dd>{date(c!.checked_at)}</dd>
                  </div>
                  <div>
                    <dt>
                      {t(
                        "Prossima sonda di disponibilità",
                        "Next availability probe",
                      )}
                    </dt>
                    <dd>
                      {c!.paused || c!.mode === "force_offline"
                        ? t("Sospesa", "Paused")
                        : c!.probe_eligible_at &&
                            Date.parse(c!.probe_eligible_at) <= Date.now()
                          ? t("In attesa della sonda", "Waiting for the probe")
                          : date(c!.probe_eligible_at)}
                    </dd>
                  </div>
                  <div>
                    <dt>
                      {t("Limite richieste fino a", "Request cooldown until")}
                    </dt>
                    <dd>
                      {c!.cooldown_until &&
                      Date.parse(c!.cooldown_until) > Date.now()
                        ? date(c!.cooldown_until)
                        : t("Nessun cooldown attivo", "No active cooldown")}
                    </dd>
                  </div>
                </dl>
              </section>
              <section className="sync-section">
                <div className="sync-section-heading">
                  <h2>{t("Lavoro conservato", "Retained work")}</h2>
                </div>
                {jobs.isError ? (
                  <QueryError retry={() => void jobs.refetch()} />
                ) : jobs.data ? (
                  <div className="sync-ledger">
                    <Link to="?section=queue">
                      <span>
                        <strong>
                          {t("Attività in attesa", "Waiting jobs")}
                        </strong>
                        <small>
                          {c!.eligible
                            ? t(
                                "In coda o in monitoraggio",
                                "Queued or monitored",
                              )
                            : t(
                                "Riprenderanno quando consentito",
                                "Will resume when permitted",
                              )}
                        </small>
                      </span>
                      <b>
                        {total(["pending", "retry", "idle"]).toLocaleString()}
                      </b>
                      <span aria-hidden="true">→</span>
                    </Link>
                    <Link to="?section=queue&state=running">
                      <span>
                        <strong>
                          {t("Esecuzioni in corso", "Running jobs")}
                        </strong>
                        <small>
                          {t(
                            "Acquisizioni effettivamente avviate",
                            "Acquisitions actually started",
                          )}
                        </small>
                      </span>
                      <b>{total(["running"]).toLocaleString()}</b>
                      <span aria-hidden="true">→</span>
                    </Link>
                    <Link to="?section=media">
                      <span>
                        <strong>
                          {t("Media da recuperare", "Media recovery")}
                        </strong>
                        <small>
                          {t(
                            "Risorse confermate mancanti",
                            "Confirmed missing resources",
                          )}
                        </small>
                      </span>
                      <b>{jobs.data.media_unrecoverable.toLocaleString()}</b>
                      <span aria-hidden="true">→</span>
                    </Link>
                  </div>
                ) : (
                  <Loading />
                )}
                <div className="sync-note">
                  <strong>
                    {q.data.watching.toLocaleString()}{" "}
                    {t("opere in watchlist", "works on the watchlist")}
                  </strong>
                  <span>
                    {t(
                      "Monitoraggio per 48 ore dall’ultima apertura, al massimo un controllo ogni ora.",
                      "Monitored for 48 hours after the last opening, at most once per hour.",
                    )}
                  </span>
                </div>
              </section>
            </div>
          )}
        </>
      )}
    </div>
  );
}
