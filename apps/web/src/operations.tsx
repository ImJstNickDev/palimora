import { useSyncLabels, useSyncError } from "./ao3-common";
import { useState } from "react";
import { Link, NavLink, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Select, Modal } from "@palimora/ui";
import { call } from "./api";
import {
  Heading,
  Loading,
  QueryError,
  Feedback,
  useAction,
  useText,
} from "./shared";
import { bytes, date, Live, number } from "./archive-common";
import type { Output, Input } from "@palimora/contracts";
import "./operations.css";
type Overview = Output<"operationsOverview">;
type Job = Output<"operationsJobs">["items"][number];
const snapshot = (data: Overview | undefined, name: string) =>
  data?.status.find((s) => s.name === name);
const value = (data: Overview | undefined, name: string) =>
  snapshot(data, name)?.value ?? {};
const fresh = (data: Overview | undefined, name: string, seconds = 45) => {
  const s = snapshot(data, name);
  return !!s && Date.now() - Date.parse(s.checked_at) < seconds * 1000;
};
const fmt = (n: unknown, unit = "") =>
  typeof n === "number"
    ? n.toLocaleString(undefined, { maximumFractionDigits: 1 }) + unit
    : "—";
function useOverview() {
  return useQuery({
    queryKey: ["operations"],
    queryFn: () => call("operationsOverview", {}),
    refetchInterval: 10000,
  });
}
function OpsNav() {
  const t = useText();
  return (
    <nav
      className="ops-nav"
      aria-label={t("Navigazione operativa", "Operations navigation")}
    >
      <NavLink to="/admin" end>
        {t("Panoramica", "Overview")}
      </NavLink>
      <NavLink to="/admin/operations/metrics">
        {t("Metriche", "Metrics")}
      </NavLink>
      <NavLink to="/admin/operations/jobs">{t("Job", "Jobs")}</NavLink>
      <NavLink to="/admin/maintenance">{t("Manutenzione", "Maintenance")}</NavLink>
      <NavLink to="/admin/integrity">{t("Integrità", "Integrity")}</NavLink>
    </nav>
  );
}
function Section({
  title,
  to,
  children,
}: {
  title: string;
  to?: string;
  children: React.ReactNode;
}) {
  const t = useText();
  return (
    <section className="ops-section">
      <div className="ops-section-heading">
        <h2>{title}</h2>
        {to && (
          <Link to={to}>
            {t("Apri dettagli", "View details")} <span aria-hidden>↗</span>
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}
export function Operations() {
  const syncLabel = useSyncLabels();
  const t = useText(),
    q = useOverview(),
    client = useQueryClient(),
    a = useAction();
  const perf = useQuery({
    queryKey: ["ops-performance"],
    queryFn: () => call("operationsMetrics", { range: "hour", series: "http" }),
    refetchInterval: 10000,
  });
  const [layout, setLayout] = useState<string[] | null>(null),
    [configure, setConfigure] = useState(false);
  const titles: Record<string, string> = {
    activity: t("Attività", "Activity"),
    containers: t("Container", "Containers"),
    performance: t("Prestazioni API", "API performance"),
    storage: t("Spazio", "Storage"),
  };
  const selected = layout ?? q.data?.layout ?? Object.keys(titles),
    app = value(q.data, "application"),
    storage = value(q.data, "storage"),
    sync = value(q.data, "sync"),
    queues = value(q.data, "queues"),
    containers = value(q.data, "containers");
  const counts = (value(q.data, "jobs").counts ?? []) as {
    family: string;
    state: string;
    count: number;
  }[];
  const count = (families: string[], states: string[]) =>
    counts
      .filter((c) => families.includes(c.family) && states.includes(c.state))
      .reduce((n, c) => n + c.count, 0);
  const active = ["pending", "running", "scanning", "retry"],
    failed = ["failed", "failed_global", "parser_blocked", "blocked"];
  const latest = (kind: string) =>
    perf.data?.http.filter((p) => p.kind === kind).at(-1);
  const body: Record<string, React.ReactNode> = {
    activity: (
      <Section title={titles.activity} to="/admin/operations/jobs">
        <div className="ops-cards">
          {[
            {
              name: t("Importazioni", "Imports"),
              to: "/admin/ingest",
              n: count(["ingest"], active),
              unit: t("batch in corso o in coda", "batches active or queued"),
              extra:
                app.ingest_per_second == null
                  ? null
                  : fmt(app.ingest_per_second, t(" record/s", " records/s")),
            },
            {
              name: t("Sincronizzazione", "Synchronization"),
              to: "/admin/ao3",
              n: count(["sync", "media"], active),
              unit: t("job in attesa o attivi", "jobs waiting or active"),
              extra: sync.paused
                ? t("In pausa", "Paused")
                : syncLabel(
                    String(sync.gate ?? sync.observed_state ?? "unknown"),
                  ),
            },
            {
              name: t("Backup ed export", "Backups and exports"),
              to: "/admin/backups",
              n: count(["backup"], active),
              unit: t("operazioni da completare", "operations to finish"),
              extra: null,
            },
            {
              name: t("Da controllare", "Needs attention"),
              to: "/admin/operations/jobs?state=attention",
              n: count(
                ["ingest", "sync", "media", "backup", "admin", "index"],
                failed,
              ),
              unit: t("job bloccati o non riusciti", "blocked or failed jobs"),
              extra:
                queues.available === false
                  ? t("Redis non disponibile", "Redis unavailable")
                  : null,
            },
          ].map((c) => (
            <Link className="ops-card" to={c.to} key={c.to}>
              <span className="ops-card-title">
                {c.name}
                <span aria-hidden>↗</span>
              </span>
              <strong>{snapshot(q.data, "jobs") ? number(c.n) : "—"}</strong>
              <span>{c.unit}</span>
              {c.extra && <small>{c.extra}</small>}
            </Link>
          ))}
        </div>
        <p className="ops-caption">
          {t("Conteggi aggiornati alle", "Counts sampled at")}{" "}
          {date(snapshot(q.data, "application")?.checked_at)}
        </p>
        <div className="ops-inline-links">
          <Link to="/admin/operations/jobs?family=index">
            {t("Indicizzazione", "Indexing")} ·{" "}
            {number(
              Number(app.catalog_pending ?? 0) +
                Number(app.search_pending ?? 0),
            )}{" "}
            {t("in attesa", "pending")}
          </Link>
          <Link to="/admin/users">
            {t("Utenti attivi", "Active users")} · {fmt(app.users)}
          </Link>
        </div>
      </Section>
    ),
    containers: (
      <Section
        title={titles.containers}
        to="/admin/operations/metrics?series=container:api"
      >
        <ContainerTable data={q.data} />
      </Section>
    ),
    performance: (
      <Section title={titles.performance} to="/admin/operations/metrics">
        <div className="ops-readings">
          {["api", "search"].map((kind) => (
            <div key={kind}>
              <span>
                {kind === "api" ? "API" : t("Ricerca", "Search")} · p95
              </span>
              <strong>
                {latest(kind)?.p95_overflow
                  ? "> 30 s"
                  : latest(kind)?.p95_ms != null
                    ? "≤ " + fmt(latest(kind)!.p95_ms, " ms")
                    : "—"}
              </strong>
              <small>
                {latest(kind)
                  ? date(latest(kind)!.bucket)
                  : t("Nessuna richiesta misurata", "No measured requests")}
              </small>
            </div>
          ))}
          <div>
            <span>{t("Richieste API / minuto", "API requests / minute")}</span>
            <strong>{fmt(latest("api")?.requests)}</strong>
            <small>
              {t("Ultimo minuto campionato", "Latest sampled minute")}
            </small>
          </div>
        </div>
        <Chart
          points={(perf.data?.http ?? [])
            .filter((p) => p.kind === "api")
            .map((p) => ({ time: p.bucket, value: p.mean_ms }))}
          label={t("Latenza media API", "Mean API latency")}
          unit="ms"
          step={60}
        />
      </Section>
    ),
    storage: (
      <Section
        title={titles.storage}
        to="/admin/operations/metrics?series=storage"
      >
        <div className="ops-readings">
          {[
            ["database_bytes", "PostgreSQL"],
            ["pack_bytes", t("Packfile", "Packfiles")],
            ["media_bytes", t("Media nei pack", "Media within packs")],
          ].map(([key, label]) => (
            <div key={key}>
              <span>{label}</span>
              <strong>{bytes(storage[key] as number)}</strong>
            </div>
          ))}
          <div>
            <span>OpenSearch</span>
            <strong>{bytes(value(q.data, "search").bytes as number)}</strong>
          </div>
        </div>
        <div className="ops-storage-note">
          <span>
            {bytes(storage.free_bytes as number)} {t("liberi su", "free of")}{" "}
            {bytes(storage.total_bytes as number)}
          </span>
          <time>{date(snapshot(q.data, "storage")?.checked_at)}</time>
          <Link to="/admin/archive/storage">
            {t("Apri storage", "Open storage")} ↗
          </Link>
        </div>
      </Section>
    ),
  };
  return (
    <section className="ops-page">
      <div className="ops-heading">
        <div>
          <p>{t("Amministrazione", "Administration")}</p>
          <Heading>{t("Operazioni", "Operations")}</Heading>
        </div>
        <Button
          onClick={() => {
            setLayout(q.data?.layout ?? Object.keys(titles));
            setConfigure(true);
          }}
        >
          {t("Configura sezioni", "Configure sections")}
        </Button>
      </div>
      <div className="ops-toolbar">
        <OpsNav />
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
        <>
          {(!fresh(q.data, "application", 90) ||
            !containers.fresh ||
            !fresh(q.data, "containers")) && (
            <p className="ops-notice" role="status">
              {t(
                "Alcune metriche non sono aggiornate. I campioni precedenti restano consultabili.",
                "Some metrics are stale. Previous samples remain available.",
              )}
            </p>
          )}
          {(q.data?.layout ?? selected).map((s) => (
            <div key={s}>{body[s]}</div>
          ))}
        </>
      )}
      <Modal
        open={configure}
        onClose={() => setConfigure(false)}
        title={t("Sezioni della panoramica", "Overview sections")}
        closeLabel={t("Chiudi", "Close")}
      >
        <div className="ops-layout">
          {Object.keys(titles)
            .sort((a, b) => {
              const ai = selected.indexOf(a),
                bi = selected.indexOf(b);
              return (ai < 0 ? 10 : ai) - (bi < 0 ? 10 : bi);
            })
            .map((s) => (
              <div key={s}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected.includes(s)}
                    onChange={(e) =>
                      setLayout(
                        e.target.checked
                          ? [...selected, s]
                          : selected.filter((x) => x !== s),
                      )
                    }
                  />
                  {titles[s]}
                </label>
                <Button
                  disabled={selected.indexOf(s) <= 0}
                  aria-label={t("Sposta su ", "Move up ") + titles[s]}
                  onClick={() => {
                    const next = [...selected],
                      i = next.indexOf(s);
                    [next[i - 1], next[i]] = [next[i], next[i - 1]];
                    setLayout(next);
                  }}
                >
                  ↑
                </Button>
              </div>
            ))}
        </div>
        <Feedback action={a} />
        <Button
          tone="primary"
          disabled={a.busy || !selected.length}
          onClick={() =>
            void a.run(async () => {
              await call("operationsLayout", {
                sections: selected as Input<"operationsLayout">["sections"],
              });
              await client.invalidateQueries({ queryKey: ["operations"] });
              setConfigure(false);
            })
          }
        >
          {t("Salva disposizione", "Save layout")}
        </Button>
      </Modal>
    </section>
  );
}
function ContainerTable({ data }: { data: Overview | undefined }) {
  const t = useText(),
    s = value(data, "containers"),
    rows = (s.containers ?? []) as any[],
    available = s.fresh && fresh(data, "containers");
  return (
    <>
      {!available && (
        <p className="ops-notice">
          {t(
            "Collector non disponibile o campione scaduto.",
            "Collector unavailable or sample expired.",
          )}
        </p>
      )}
      <div className="table-scroll">
        <table className="ops-containers">
          <caption className="sr-only">
            {t(
              "Risorse dei container Palimora",
              "Palimora container resources",
            )}
          </caption>
          <thead>
            <tr>
              {[
                "Container",
                t("Stato", "State"),
                "CPU",
                "RAM",
                t("Rete ↓ / ↑", "Network ↓ / ↑"),
                "I/O ↓ / ↑",
              ].map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id}>
                <td>
                  <Link
                    to={
                      "/admin/operations/metrics?series=container:" + c.service
                    }
                  >
                    {c.service}
                  </Link>
                  <small>{c.id.slice(0, 12)}</small>
                </td>
                <td>
                  <span
                    className={
                      c.state === "running" && c.health !== "unhealthy"
                        ? "ops-good"
                        : "ops-warning"
                    }
                  >
                    {c.health === "unhealthy"
                      ? t("Non sano", "Unhealthy")
                      : ((
                          {
                            running: t("In esecuzione", "Running"),
                            exited: t("Arrestato", "Stopped"),
                            paused: t("In pausa", "Paused"),
                            restarting: t("In riavvio", "Restarting"),
                            created: t("Creato", "Created"),
                          } as Record<string, string>
                        )[c.state] ?? c.state)}
                  </span>
                </td>
                <td>{available ? fmt(c.metrics?.cpu_percent, "%") : "—"}</td>
                <td>
                  {available ? bytes(c.metrics?.memory_bytes) : "—"}
                  <small>
                    {available ? bytes(c.metrics?.memory_limit) : "—"}
                  </small>
                </td>
                <td>
                  {available ? bytes(c.metrics?.rx_per_second) : "—"} /{" "}
                  {available ? bytes(c.metrics?.tx_per_second) : "—"}
                  <small>{t("al secondo", "per second")}</small>
                </td>
                <td>
                  {available ? bytes(c.metrics?.read_per_second) : "—"} /{" "}
                  {available ? bytes(c.metrics?.write_per_second) : "—"}
                  <small>{t("al secondo", "per second")}</small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!rows.length && (
        <p className="ops-empty">
          {t(
            "Nessun campione container disponibile.",
            "No container samples available.",
          )}
        </p>
      )}
    </>
  );
}
function Chart({
  points,
  label,
  unit,
  step,
}: {
  points: { time: string; value: number | null }[];
  label: string;
  unit: string;
  step: number;
}) {
  const t = useText(),
    [hover, setHover] = useState<number | null>(null);
  const valid = points.filter(
    (p) => p.value != null && Number.isFinite(p.value),
  );
  if (!valid.length)
    return (
      <p className="ops-empty">
        {t(
          "Nessun campione nell’intervallo selezionato.",
          "No samples in this time range.",
        )}
      </p>
    );
  const display = (n: number | null) =>
    unit === "B"
      ? bytes(n)
      : unit === "B/s"
        ? bytes(n) + "/s"
        : fmt(n, " " + unit);
  const start = Date.parse(valid[0].time),
    end = Date.parse(valid.at(-1)!.time),
    max = Math.max(...valid.map((p) => p.value!), 1),
    x = (time: string) =>
      20 + ((Date.parse(time) - start) / Math.max(end - start, 1)) * 940,
    y = (v: number) => 170 - (v / max) * 145;
  const path = valid
      .map(
        (p, i) =>
          (!i ||
          Date.parse(p.time) - Date.parse(valid[i - 1].time) > step * 1500
            ? "M"
            : "L") +
          x(p.time) +
          "," +
          y(p.value!),
      )
      .join(" "),
    selected =
      hover == null ? valid.at(-1)! : valid[Math.min(hover, valid.length - 1)];
  return (
    <figure className="ops-chart">
      <figcaption>
        <span>{label}</span>
        <strong>
          {display(selected.value)} <time>{date(selected.time)}</time>
        </strong>
      </figcaption>
      <div className="ops-plot">
        <span className="ops-axis-max" aria-hidden>
          {display(max)}
        </span>
        <span className="ops-axis-zero" aria-hidden>
          0
        </span>
        <svg
          viewBox="0 0 980 195"
          preserveAspectRatio="none"
          role="img"
          aria-label={label}
          onPointerMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect(),
              ratio = (e.clientX - rect.left) / rect.width;
            const at =
              start +
              Math.max(0, Math.min(1, (ratio * 980 - 20) / 940)) *
                (end - start);
            setHover(
              valid.reduce(
                (best, p, i) =>
                  Math.abs(Date.parse(p.time) - at) <
                  Math.abs(Date.parse(valid[best].time) - at)
                    ? i
                    : best,
                0,
              ),
            );
          }}
          onPointerLeave={() => setHover(null)}
        >
          <line x1="20" x2="960" y1="170" y2="170" />
          <line x1="20" x2="960" y1="25" y2="25" className="ops-chart-grid" />
          <path d={path} />
          <circle cx={x(selected.time)} cy={y(selected.value!)} r="4" />
        </svg>
      </div>
      <div className="ops-chart-scale">
        <span>{date(valid[0].time)}</span>
        <span>{date(valid.at(-1)!.time)}</span>
      </div>
      <details className="ops-chart-data">
        <summary>{t("Dati del grafico", "Chart data")}</summary>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t("Campione", "Sample")}</th>
                <th>
                  {label} ({unit})
                </th>
              </tr>
            </thead>
            <tbody>
              {valid.map((p) => (
                <tr key={p.time}>
                  <td>{date(p.time)}</td>
                  <td>{fmt(p.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
export function OperationsMetrics() {
  const t = useText(),
    q = useOverview(),
    [params, setParams] = useSearchParams();
  const series = params.get("series") ?? "http",
    range = (params.get("range") ??
      "hour") as Input<"operationsMetrics">["range"];
  const metrics = useQuery({
    queryKey: ["operations-metrics", series, range],
    queryFn: () => call("operationsMetrics", { range, series }),
    refetchInterval: 10000,
  });
  const metricNames: Record<string, [string, string]> = {
    running: [t("Container attivi", "Running containers"), "container"],
    cpu_percent: ["CPU", "%"],
    memory_bytes: [t("RAM utilizzata", "RAM used"), "B"],
    memory_limit: [t("Limite RAM", "RAM limit"), "B"],
    rx_per_second: [t("Rete in ingresso", "Network received"), "B/s"],
    tx_per_second: [t("Rete in uscita", "Network sent"), "B/s"],
    read_per_second: [t("Lettura disco", "Disk reads"), "B/s"],
    write_per_second: [t("Scrittura disco", "Disk writes"), "B/s"],
    database_bytes: ["PostgreSQL", "B"],
    index_bytes: ["OpenSearch", "B"],
    pack_bytes: [t("Packfile fisici", "Physical packfiles"), "B"],
    media_bytes: [t("Media nei pack", "Media within packs"), "B"],
    free_bytes: [t("Spazio libero", "Free space"), "B"],
    ingest_per_second: [t("Ingest", "Ingest"), "record/s"],
    index_per_second: [t("Indicizzazione", "Indexing"), "record/s"],
    sync_per_minute: [
      t("Sincronizzazioni concluse", "Completed sync runs"),
      "job/min",
    ],
    catalog_pending: [t("Catalogo in coda", "Catalogue pending"), "job"],
    search_pending: [t("Ricerca in coda", "Search pending"), "job"],
    waiting: [t("In attesa", "Waiting"), "job"],
    active: [t("Attivi", "Active"), "job"],
    failed: [t("Non riusciti", "Failed"), "job"],
    delayed: [t("Differiti", "Delayed"), "job"],
    paused: [t("In pausa", "Paused"), "job"],
  };
  const names = [
    ...new Set((metrics.data?.points ?? []).map((p) => p.metric)),
  ].filter((k) => metricNames[k]);
  const chosen = params.get("metric") ?? names[0] ?? "cpu_percent";
  const httpKey = params.get("metric") ?? "api";
  const measures = {
    mean_ms: [t("latenza media", "mean latency"), "ms"],
    p95_ms: [t("p95 · limite superiore", "p95 · upper bound"), "ms"],
    max_ms: [t("latenza massima", "maximum latency"), "ms"],
    requests: [t("richieste", "requests"), t("richieste", "requests")],
    errors: [t("errori 5xx", "5xx errors"), t("errori", "errors")],
  };
  const measure = (
    Object.prototype.hasOwnProperty.call(measures, params.get("measure") ?? "")
      ? params.get("measure")
      : "mean_ms"
  ) as keyof typeof measures;
  const points =
    series === "http"
      ? (metrics.data?.http ?? [])
          .filter((p) => p.kind === httpKey)
          .map((p) => ({ time: p.bucket, value: p[measure] }))
      : (metrics.data?.points ?? [])
          .filter((p) => p.metric === chosen)
          .map((p) => ({ time: p.bucket, value: p.average }));
  const selectedLabel =
    series === "http"
      ? httpKey === "api"
        ? "API"
        : t("Ricerca", "Search")
      : (metricNames[chosen]?.[0] ?? chosen);
  const unit =
    series === "http" ? measures[measure][1] : (metricNames[chosen]?.[1] ?? "");
  const update = (key: string, v: string) => {
    const next = new URLSearchParams(params);
    next.set(key, v);
    if (key === "series") next.delete("metric");
    setParams(next);
  };
  return (
    <section className="ops-page">
      <div className="ops-heading">
        <div>
          <p>{t("Amministrazione", "Administration")}</p>
          <Heading>{t("Metriche", "Metrics")}</Heading>
        </div>
      </div>
      <div className="ops-toolbar">
        <OpsNav />
        <Live
          updated={metrics.dataUpdatedAt}
          fetching={metrics.isFetching}
          error={metrics.isError}
          refresh={metrics.refetch}
        />
      </div>
      <div className="ops-filters">
        <Select
          label={t("Sorgente", "Source")}
          value={series}
          onChange={(e) => update("series", e.target.value)}
        >
          <option value="http">API / {t("Ricerca", "Search")}</option>
          <option value="application">{t("Elaborazione", "Processing")}</option>
          <option value="storage">{t("Storage", "Storage")}</option>
          {[
            "gateway",
            "web",
            "api",
            "ingest",
            "postgres",
            "redis",
            "opensearch",
            "metrics-proxy",
            "collector",
          ].map((n) => (
            <option key={n} value={"container:" + n}>
              {n}
            </option>
          ))}
          {["ingest", "ao3", "archive-events", "backup"].map((n) => (
            <option key={n} value={"palimora-" + n + "-v1"}>
              {t("Coda", "Queue")} · {n}
            </option>
          ))}
        </Select>
        <Select
          label={t("Intervallo", "Time range")}
          value={range}
          onChange={(e) => update("range", e.target.value)}
        >
          {[
            ["hour", t("Ultima ora", "Last hour")],
            ["day", t("24 ore", "24 hours")],
            ["week", t("7 giorni", "7 days")],
            ["month", t("30 giorni", "30 days")],
          ].map(([k, v]) => (
            <option value={k} key={k}>
              {v}
            </option>
          ))}
        </Select>
        <Select
          label={t("Metrica", "Metric")}
          value={series === "http" ? httpKey : chosen}
          onChange={(e) => update("metric", e.target.value)}
        >
          {(series === "http" ? ["api", "search"] : names).map((k) => (
            <option key={k} value={k}>
              {series === "http"
                ? k === "api"
                  ? "API"
                  : t("Ricerca", "Search")
                : metricNames[k][0]}
            </option>
          ))}
        </Select>
        {series === "http" && (
          <Select
            label={t("Misura", "Measure")}
            value={measure}
            onChange={(e) => update("measure", e.target.value)}
          >
            {Object.entries(measures).map(([k, v]) => (
              <option key={k} value={k}>
                {v[0]}
              </option>
            ))}
          </Select>
        )}
      </div>
      {metrics.isPending ? (
        <Loading />
      ) : metrics.isError ? (
        <QueryError retry={() => void metrics.refetch()} />
      ) : (
        <>
          <Section title={selectedLabel}>
            <Chart
              points={points}
              label={
                selectedLabel +
                (series === "http" ? " · " + measures[measure][0] : "")
              }
              unit={unit}
              step={metrics.data.step}
            />
            <p className="ops-caption">
              {metrics.data.step === 60
                ? t(
                    "Aggregati al minuto · conservati 24 ore",
                    "Minute aggregates · retained for 24 hours",
                  )
                : t(
                    "Aggregati orari · conservati 30 giorni",
                    "Hourly aggregates · retained for 30 days",
                  )}
            </p>
          </Section>
          {series === "http" && (
            <div className="table-scroll">
              <table>
                <caption>
                  {t(
                    "Ultimi campioni delle richieste",
                    "Latest request samples",
                  )}
                </caption>
                <thead>
                  <tr>
                    {[
                      t("Ora", "Time"),
                      t("Richieste", "Requests"),
                      "5xx",
                      t("Media", "Mean"),
                      "p95",
                    ].map((h) => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {metrics.data.http
                    .filter((p) => p.kind === httpKey)
                    .slice(-12)
                    .reverse()
                    .map((p) => (
                      <tr key={p.bucket}>
                        <td>{date(p.bucket)}</td>
                        <td>{p.requests}</td>
                        <td>{p.errors}</td>
                        <td>{fmt(p.mean_ms, " ms")}</td>
                        <td>
                          {p.p95_overflow
                            ? "> 30 s"
                            : "≤ " + fmt(p.p95_ms, " ms")}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {series.startsWith("container:") && (
        <Section title={t("Campioni correnti", "Current samples")}>
          <ContainerTable data={q.data} />
        </Section>
      )}
    </section>
  );
}
export function OperationsJobs() {
  const syncLabel = useSyncLabels(),
    syncError = useSyncError();
  const t = useText(),
    [params, setParams] = useSearchParams(),
    a = useAction(),
    client = useQueryClient();
  const family = (params.get("family") ??
      "all") as Input<"operationsJobs">["family"],
    state = (params.get("state") ?? "all") as Input<"operationsJobs">["state"],
    id = params.get("id") ?? undefined,
    cursor = params.get("cursor") ?? undefined;
  const q = useQuery({
    queryKey: ["operations-jobs", family, state, cursor, id],
    queryFn: () => call("operationsJobs", { family, state, cursor, id }),
    refetchInterval: 5000,
  });
  const selected = q.data?.items.find((r) => r.id === id),
    history = useQuery({
      queryKey: ["operations-history", selected?.family, id],
      queryFn: () =>
        call("operationsHistory", { family: selected!.family, id: id! }),
      enabled: !!selected,
      refetchInterval: 5000,
    });
  const [priorities, setPriorities] = useState<Record<string, number> | null>(
    null,
  );
  const labels: Record<string, string> = {
    ingest: t("Ingest", "Ingest"),
    sync: t("Sincronizzazione", "Synchronization"),
    media: t("Media", "Media"),
    index: t("Indicizzazione", "Indexing"),
    backup: t("Backup ed export", "Backups and exports"),
    admin: t("Operazioni storage", "Storage operations"),
  };
  const states: Record<string, string> = {
    pending: t("In coda", "Queued"),
    running: t("In corso", "Running"),
    scanning: t("Inventario", "Scanning"),
    retry: t("Retry programmato", "Retry scheduled"),
    idle: t("In attesa", "Idle"),
    blocked: t("Bloccato", "Blocked"),
    paused: t("In pausa", "Paused"),
    pause_requested: t("Pausa richiesta", "Pausing"),
    cancel_requested: t("Arresto richiesto", "Stopping"),
    cancelled: t("Annullato", "Cancelled"),
    completed: t("Completato", "Completed"),
    completed_with_gaps: t("Con lacune", "With gaps"),
    parser_blocked: t("Parser bloccato", "Parser blocked"),
    failed_global: t("Interrotto", "Interrupted"),
    failed: t("Non riuscito", "Failed"),
    deleted: t("Eliminato", "Deleted"),
  };
  const historyState = (h: Output<"operationsHistory">["items"][number]) => {
    if (
      ["operationsControl", "backupControl", "ao3JobControl"].includes(h.state)
    ) {
      return (
        {
          pause: t("Pausa richiesta", "Pause requested"),
          resume: t("Ripresa richiesta", "Resume requested"),
          retry: t("Retry richiesto", "Retry requested"),
          cancel: t("Annullamento richiesto", "Cancellation requested"),
        }[String(h.detail.action) as "pause"] ??
        t("Controllo operativo", "Operational control")
      );
    }
    return (
      states[h.state] ??
      {
        ingestControl: t("Controllo importazione", "Import control"),
        ingestStart: t("Importazione creata", "Import created"),
        backupCreate: t("Copia richiesta", "Copy requested"),
        backupRestore: t("Ripristino richiesto", "Restore requested"),
      }[h.state as "ingestControl"] ??
      syncLabel(h.state)
    );
  };
  const kinds: Record<string, string> = {
    catalog: t("Catalogo", "Catalogue"),
    search: t("Indice di ricerca", "Search index"),
    full: t("Backup completo", "Full backup"),
    platform: t("Backup piattaforma", "Platform backup"),
    export: t("Export archivistico", "Archive export"),
    restore: t("Ripristino", "Restore"),
    verify: t("Verifica", "Verification"),
    delete: t("Eliminazione copia", "Copy deletion"),
    work: t("Opera", "Work"),
    entity: t("Entità AO3", "AO3 entity"),
    discovery: t("Discovery", "Discovery"),
    backfill: t("Recupero storico", "Backfill"),
    media: t("Acquisizione media", "Media acquisition"),
    scrub: t('Verifica integrità','Integrity scrub'),
    repair:t('Recupero oggetto','Object recovery'),
    compact: t("Compattazione", "Compaction"),
    collect: t("Raccolta pack", "Pack collection"),
    reset_dev: t("Reset di sviluppo", "Development reset"),
    ingest: t("Importazione", "Import"),
  };
  const progressLabel = (p: Job["progress"]) => {
    const phase =
      {
        preparing: t("Preparazione", "Preparing"),
        catalog: t("Catalogo", "Catalogue"),
        packs: t("Packfile", "Packfiles"),
        capture: t("Cattura", "Capture"),
        volumes: t("Volumi", "Volumes"),
        restore: t("Ripristino", "Restore"),
      }[String(p.phase) as "preparing"] ??
      states[String(p.phase)] ??
      "";
    const count =
      p.completed != null
        ? `${number(p.completed)} / ${number(p.total)}`
        : p.processed != null
          ? number(p.processed) + " " + t("elaborati", "processed")
          : p.objects != null
            ? number(p.objects) + " " + t("oggetti", "objects")
            : p.attempts != null
              ? number(p.attempts) + " " + t("tentativi", "attempts")
              : "";
    return [phase, count].filter(Boolean).join(" · ") || "—";
  };
  const act = (r: Job, action: Job["actions"][number]) =>
    a.run(async () => {
      await call("operationsControl", {
        family: r.family,
        id: r.id,
        action,
        requestId: crypto.randomUUID(),
      });
      await client.invalidateQueries({ queryKey: ["operations-jobs"] });
      await client.invalidateQueries({ queryKey: ["operations-history"] });
    });
  const update = (key: string, v: string) => {
    const next = new URLSearchParams(params);
    next.set(key, v);
    next.delete("cursor");
    next.delete("id");
    setParams(next);
  };
  return (
    <section className="ops-page">
      <div className="ops-heading">
        <div>
          <p>{t("Amministrazione", "Administration")}</p>
          <Heading>{t("Job e code", "Jobs and queues")}</Heading>
        </div>
        <Button
          onClick={() =>
            void a.run(async () => {
              const result = await call("ao3Jobs", {});
              setPriorities(
                result.control.priorities as Record<string, number>,
              );
            })
          }
        >
          {t("Priorità sync", "Sync priorities")}
        </Button>
      </div>
      <div className="ops-toolbar">
        <OpsNav />
        <Live
          updated={q.dataUpdatedAt}
          fetching={q.isFetching}
          error={q.isError}
          refresh={q.refetch}
        />
      </div>
      <Feedback action={a} />
      <div className="ops-filters">
        <Select
          label={t("Famiglia", "Family")}
          value={family}
          onChange={(e) => update("family", e.target.value)}
        >
          <option value="all">{t("Tutti i job", "All jobs")}</option>
          {Object.entries(labels).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
        <Select
          label={t("Stato", "State")}
          value={state}
          onChange={(e) => update("state", e.target.value)}
        >
          {[
            ["all", t("Tutti", "All")],
            ["active", t("In corso e in coda", "Active and queued")],
            ["attention", t("Da controllare", "Needs attention")],
          ].map(([k, v]) => (
            <option value={k} key={k}>
              {v}
            </option>
          ))}
        </Select>
      </div>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <QueryError retry={() => void q.refetch()} />
      ) : (
        <>
          {selected && (
            <section
              className="ops-job-detail"
              aria-label={t("Dettaglio job", "Job details")}
            >
              <div className="ops-section-heading">
                <h2>{kinds[selected.kind] ?? selected.kind}</h2>
                <Button
                  onClick={() => {
                    const next = new URLSearchParams(params);
                    next.delete("id");
                    setParams(next);
                  }}
                >
                  {t("Chiudi", "Close")}
                </Button>
              </div>
              <div className="ops-job-facts">
                <span>{states[selected.state] ?? selected.state}</span>
                <time>{date(selected.updated_at)}</time>
                <code>{selected.id}</code>
              </div>
              {selected.error && (
                <p className="notice error" role="alert">
                  {selected.error === "SEARCH_INDEX_FAILED"
                    ? t(
                        "Indicizzazione non riuscita. Il lavoro resta in coda per il prossimo tentativo.",
                        "Indexing failed. Work remains queued for the next attempt.",
                      )
                    : selected.error === "CATALOG_PROJECTION_FAILED"
                      ? t(
                          "Aggiornamento del catalogo non riuscito. Il lavoro resta in coda.",
                          "Catalogue update failed. Work remains queued.",
                        )
                      : ["sync", "media"].includes(selected.family)
                        ? syncError(selected.error)
                        : t(
                            "Operazione interrotta. Consulta i dettagli nella pagina dedicata.",
                            "Operation interrupted. See details on the dedicated page.",
                          )}
                  <small className="ops-error-code">{selected.error}</small>
                </p>
              )}
              <div className="ops-job-progress">
                {Number(selected.progress.total) > 0 && (
                  <progress
                    max={Number(selected.progress.total)}
                    value={Number(selected.progress.completed ?? 0)}
                    aria-label={t("Avanzamento", "Progress")}
                  />
                )}
                <span>{progressLabel(selected.progress)}</span>
              </div>
              {selected.progress.execution != null && (
                <p className="ops-caption">
                  {syncLabel(String(selected.progress.execution))}
                  {selected.progress.eligible_at != null
                    ? " · " + date(String(selected.progress.eligible_at))
                    : ""}
                </p>
              )}
              <div className="ops-job-actions">
                {selected.actions.map((action) => (
                  <Button
                    key={action}
                    disabled={a.busy}
                    onClick={() => void act(selected, action)}
                  >
                    {action === "pause"
                      ? t("Pausa", "Pause")
                      : action === "resume"
                        ? t("Riprendi", "Resume")
                        : t("Riprova ora", "Retry now")}
                  </Button>
                ))}
                {selected.family !== "index" && (
                  <Link to={selected.url}>
                    {t("Apri pagina dedicata", "Open dedicated page")} ↗
                  </Link>
                )}
              </div>
              <details className="ops-history" open>
                <summary>{t("Cronologia", "History")}</summary>
                {history.isPending ? (
                  <Loading />
                ) : history.isError ? (
                  <QueryError retry={() => void history.refetch()} />
                ) : history.data?.items.length ? (
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>{t("Avviata", "Started")}</th>
                          <th>{t("Conclusa", "Finished")}</th>
                          <th>{t("Esito", "Outcome")}</th>
                          <th>{t("Elaborati", "Processed")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {history.data.items.map((h) => (
                          <tr key={h.id}>
                            <td>{date(h.started_at)}</td>
                            <td>{date(h.finished_at)}</td>
                            <td>
                              {historyState(h)}
                              {h.detail.error != null && (
                                <small>{String(h.detail.error)}</small>
                              )}
                            </td>
                            <td>
                              {h.detail.processed == null
                                ? "—"
                                : number(h.detail.processed)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="ops-empty">
                    {t(
                      "Nessuna esecuzione o azione registrata.",
                      "No recorded execution or action.",
                    )}
                  </p>
                )}
              </details>
            </section>
          )}
          <div className="table-scroll">
            <table className="ops-jobs">
              <caption className="sr-only">
                {t("Job operativi", "Operational jobs")}
              </caption>
              <thead>
                <tr>
                  {[
                    t("Job", "Job"),
                    t("Famiglia", "Family"),
                    t("Stato", "State"),
                    t("Avanzamento", "Progress"),
                    t("Priorità", "Priority"),
                    t("Aggiornato", "Updated"),
                  ].map((h) => (
                    <th key={h}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {q.data.items.map((r) => (
                  <tr key={r.family + r.id}>
                    <td>
                      <button
                        className="ops-job-link"
                        onClick={() =>
                          setParams({ family: r.family, id: r.id })
                        }
                      >
                        {kinds[r.kind] ?? r.kind}
                        <small>
                          {r.id.length > 16 ? r.id.slice(0, 8) : r.id}
                        </small>
                      </button>
                    </td>
                    <td>{labels[r.family]}</td>
                    <td>
                      <span className={r.error ? "ops-warning" : ""}>
                        {states[r.state] ?? r.state}
                      </span>
                      {r.error && <small>{r.error}</small>}
                    </td>
                    <td>{progressLabel(r.progress)}</td>
                    <td>{r.priority ?? "—"}</td>
                    <td>{date(r.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!q.data.items.length && (
            <p className="ops-empty">
              {t(
                "Nessun job corrisponde ai filtri.",
                "No jobs match these filters.",
              )}
            </p>
          )}
          <div className="ops-pagination">
            {cursor && (
              <Button
                onClick={() => {
                  const next = new URLSearchParams(params);
                  next.delete("cursor");
                  setParams(next);
                }}
              >
                {t("Più recenti", "Most recent")}
              </Button>
            )}
            {q.data.next && (
              <Button
                onClick={() => {
                  const next = new URLSearchParams(params);
                  next.set("cursor", q.data!.next!);
                  setParams(next);
                }}
              >
                {t("Precedenti", "Older")}
              </Button>
            )}
          </div>
        </>
      )}
      <Modal
        open={!!priorities}
        onClose={() => setPriorities(null)}
        title={t("Priorità di sincronizzazione", "Synchronization priorities")}
        closeLabel={t("Chiudi", "Close")}
      >
        {priorities && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void a.run(async () => {
                await call("ao3Priorities", {
                  priorities:
                    priorities as Input<"ao3Priorities">["priorities"],
                });
                setPriorities(null);
                await q.refetch();
              });
            }}
          >
            <p className="ops-caption">
              {t(
                "Valori più bassi hanno precedenza. I job in esecuzione proseguono.",
                "Lower values run first. Running jobs continue.",
              )}
            </p>
            {["discovery", "work", "entity", "media", "backfill"].map((k) => (
              <label className="ops-priority" key={k}>
                <span>{kinds[k]}</span>
                <input
                  type="number"
                  min="1"
                  max="100"
                  required
                  value={priorities[k]}
                  onChange={(e) =>
                    setPriorities({
                      ...priorities,
                      [k]: Number(e.target.value),
                    })
                  }
                />
              </label>
            ))}
            <Feedback action={a} />
            <Button tone="primary" disabled={a.busy}>
              {t("Salva priorità", "Save priorities")}
            </Button>
          </form>
        )}
      </Modal>
    </section>
  );
}
