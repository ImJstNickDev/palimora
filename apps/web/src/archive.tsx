import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { Button, Field, Select } from "@palimora/ui";
import type { Input } from "@palimora/contracts";
import { call } from "./api";
import { Heading, Loading, QueryError, useText } from "./shared";
import {
  Reconciliation,
  DecisionDialog,
  type Decision,
} from "./archive-reconciliation";
import {
  Status,
  Empty,
  Facts,
  Live,
  Pager,
  Diagnostic,
  useArchiveParams,
  bytes,
  date,
  number,
  valueText,
  workTitle,
} from "./archive-common";
export { Ingest, IngestDetail } from "./archive-ingest";

export function ArchiveWorks() {
  const t = useText(),
    p = useArchiveParams();
  const [search, setSearch] = useState(p.params.get("q") ?? "");
  const filter = (p.params.get("filter") ??
    "all") as Input<"archiveWorks">["filter"];
  const queryText = p.params.get("q") ?? "";
  useEffect(() => setSearch(queryText), [queryText]);
  const q = useQuery({
    queryKey: ["archive-list", p.cursor, filter, p.params.get("q")],
    queryFn: () =>
      call("archiveWorks", {
        cursor: p.cursor,
        filter,
        q: p.params.get("q") ?? "",
      }),
    refetchInterval: 15000,
  });
  return (
    <div className="archive-view">
      <div className="archive-page-heading">
        <div>
          <p className="eyebrow">Archive Engine</p>
          <Heading>{t("Archivio tecnico", "Technical archive")}</Heading>
        </div>
        <Live
          updated={q.dataUpdatedAt}
          fetching={q.isFetching}
          error={q.isError}
          refresh={q.refetch}
        />
      </div>
      <div className="archive-toolbar">
        <form
          className="archive-search"
          onSubmit={(e) => {
            e.preventDefault();
            p.set("q", search);
          }}
        >
          <Field
            label={t("Titolo, ID AO3 o ID locale", "Title, AO3 ID or local ID")}
            value={search}
            type="search"
            maxLength={100}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Button type="submit">{t("Cerca", "Search")}</Button>
        </form>
        <Select
          label={t("Mostra opere", "Show works")}
          value={filter}
          onChange={(e) => p.set("filter", e.target.value)}
        >
          <option value="all">{t("Tutte le opere", "All works")}</option>
          <option value="current">
            {t("Con versione corrente", "With current version")}
          </option>
          <option value="missing">
            {t("Senza versione corrente", "Without current version")}
          </option>
          <option value="conflicts">
            {t("Conflitti aperti", "Open conflicts")}
          </option>
        </Select>
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
                title={t("Nessuna opera corrispondente", "No matching works")}
              >
                <p>
                  {t(
                    "Modifica i filtri o acquisisci nuove sorgenti.",
                    "Change filters or acquire new sources.",
                  )}
                </p>
                <Link to="/admin/ingest">
                  {t("Apri importazioni", "Open imports")} →
                </Link>
              </Empty>
            ) : (
              <div className="archive-table table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>{t("Opera", "Work")}</th>
                      <th>{t("Contenuto corrente", "Current content")}</th>
                      <th>{t("Versioni", "Versions")}</th>
                      <th>{t("Da riconciliare", "To reconcile")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {q.data.items.map((w) => (
                      <tr key={w.id}>
                        <td className="archive-work-cell">
                          <Link
                            className="archive-title-link"
                            to={"/admin/archive/" + w.id}
                          >
                            {workTitle(w)}
                          </Link>
                          <small>
                            {valueText(
                              w.metadata.creators ??
                                w.metadata.author ??
                                w.metadata.Author ??
                                w.metadata.authors ??
                                "",
                            )}
                          </small>
                          <small>
                            {w.external_id
                              ? `AO3 · ${w.external_id}`
                              : t(
                                  "Identità locale provvisoria",
                                  "Provisional local identity",
                                )}
                          </small>
                        </td>
                        <td>
                          <Status
                            state={
                              w.current_snapshot_id ? "current" : "missing"
                            }
                          />
                        </td>
                        <td>{number(w.snapshots)}</td>
                        <td>
                          {w.conflicts ? (
                            <Link to={`/admin/archive/${w.id}?tab=reconcile`}>
                              {number(w.conflicts)}{" "}
                              {t("conflitti", "conflicts")} →
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
    </div>
  );
}
export function ArchiveWork() {
  const { id } = useParams();
  return <WorkDetail key={id} id={id!} />;
}
function WorkDetail({ id }: { id: string }) {
  const t = useText(),
    p = useArchiveParams();
  const [decision, setDecision] = useState<Decision>();
  const q = useQuery({
    queryKey: ["archive-work", id, p.cursor],
    queryFn: () => call("archiveWork", { id, cursor: p.cursor }),
  });
  const snapshot =
    p.params.get("snapshot") ??
    q.data?.work.current_snapshot_id ??
    q.data?.snapshots[0]?.id;
  const tab = p.params.get("tab") ?? "versions";
  const m = useQuery({
    queryKey: ["snapshot", snapshot],
    queryFn: () => call("archiveSnapshot", { id: snapshot! }),
    enabled: !!snapshot,
  });
  const loaded = q.isSuccess;
  useEffect(() => {
    if (loaded) document.querySelector<HTMLElement>("main h1")?.focus();
  }, [loaded]);
  if (q.isPending) return <Loading />;
  if (q.isError) return <QueryError retry={() => void q.refetch()} />;
  const { work, snapshots } = q.data;
  const selected = snapshots.find((s) => s.id === snapshot);
  return (
    <div className="archive-view">
      <Link className="security-back" to="/admin/archive">
        ← {t("Archivio tecnico", "Technical archive")}
      </Link>
      <div className="archive-page-heading">
        <div>
          <p className="eyebrow">
            {work.external_id
              ? `AO3 · ${work.external_id}`
              : t("Identità locale provvisoria", "Provisional local identity")}
          </p>
          <Heading>{workTitle(work)}</Heading>
          <p className="archive-help">
            {valueText(
              work.metadata.creators ??
                work.metadata.author ??
                work.metadata.Author ??
                work.metadata.authors ??
                "",
            )}
          </p>
        </div>
        <Status state={work.current_snapshot_id ? "current" : "missing"} />
      </div>
      {work.canonical_work_id && (
        <div className="archive-callout">
          <Link to={"/admin/archive/" + work.canonical_work_id}>
            {t("Apri l’identità collegata", "Open linked identity")} →
          </Link>
        </div>
      )}
      <div
        className="archive-tabs"
        aria-label={t("Dettagli opera", "Work details")}
      >
        {[
          ["versions", t("Versioni e contenuti", "Versions and content")],
          ["metadata", t("Metadati", "Metadata")],
          ["reconcile", t("Riconciliazione", "Reconciliation")],
        ].map(([key, label]) => (
          <Button
            key={key}
            aria-pressed={tab === key}
            onClick={() => p.set("tab", key, false)}
          >
            {label}
          </Button>
        ))}
      </div>
      {tab === "versions" && (
        <div className="archive-inspector">
          <aside className="archive-version-list">
            <div className="archive-section-heading">
              <h2>{t("Versioni conservate", "Preserved versions")}</h2>
            </div>
            {work.current_snapshot_id && (
              <Button
                onClick={() =>
                  p.set("snapshot", work.current_snapshot_id!, false)
                }
                disabled={snapshot === work.current_snapshot_id}
              >
                {t("Apri corrente", "Open current")}
              </Button>
            )}
            {snapshots.map((s) => (
              <button
                className="archive-version"
                aria-pressed={snapshot === s.id}
                key={s.id}
                onClick={() => p.set("snapshot", s.id, false)}
              >
                <span>{date(s.imported_at)}</span>
                <Status
                  state={
                    s.id === work.current_snapshot_id ? "current" : s.state
                  }
                />
                <small>
                  {s.id.slice(0, 8)} · {t("acquisizione", "acquisition")}
                </small>
                {s.ordering_uncertain && (
                  <small>
                    {t(
                      "Cronologia sorgente incerta",
                      "Uncertain source chronology",
                    )}
                  </small>
                )}
              </button>
            ))}
            <Pager next={q.data.next} {...p.pager} />
            {!snapshots.length && (
              <Empty title={t("Nessuna versione", "No versions")} />
            )}
          </aside>
          <div className="archive-snapshot">
            {snapshot &&
              (m.isPending ? (
                <Loading />
              ) : m.isError ? (
                <QueryError retry={() => void m.refetch()} />
              ) : (
                <>
                  <div className="archive-section-heading">
                    <div>
                      <h2>
                        {snapshot === work.current_snapshot_id
                          ? t("Versione corrente", "Current version")
                          : t("Versione selezionata", "Selected version")}
                      </h2>
                      <small>{snapshot}</small>
                    </div>
                    {selected?.state === "valid" &&
                      selected.work_id === id &&
                      snapshot !== work.current_snapshot_id && (
                        <Button
                          onClick={() =>
                            setDecision({
                              kind: "head",
                              target: snapshot,
                              label: t(
                                "Imposta versione corrente",
                                "Set current version",
                              ),
                              value:
                                date(selected.imported_at) + " · " + snapshot,
                            })
                          }
                        >
                          {t("Imposta come corrente", "Set as current")}
                        </Button>
                      )}
                  </div>
                  <SnapshotInspector
                    key={snapshot}
                    manifest={m.data.manifest}
                    snapshot={snapshot}
                    workId={id}
                  />
                </>
              ))}
          </div>
        </div>
      )}
      {tab === "metadata" && (
        <>
          <div className="archive-section-heading">
            <h2>{t("Metadati riconciliati", "Reconciled metadata")}</h2>
            <Button onClick={() => p.set("tab", "reconcile", false)}>
              {t("Esamina evidenze", "Review evidence")} →
            </Button>
          </div>
          <Metadata values={work.metadata} />
          <div className="archive-panel">
            <h3>
              {t(
                "Identità e scelta corrente",
                "Identity and current selection",
              )}
            </h3>
            <Facts
              items={[
                ["ID", <code>{work.id}</code>],
                ["AO3 ID", work.external_id ?? "—"],
                [
                  t("Versione corrente", "Current version"),
                  <code>{work.current_snapshot_id ?? "—"}</code>,
                ],
              ]}
            />
            <p className="archive-help">{work.head_reason}</p>
          </div>
        </>
      )}
      {tab === "reconcile" && (
        <Reconciliation
          id={id}
          linked={!!work.canonical_work_id}
          refresh={() => q.refetch()}
        />
      )}
      {decision && (
        <DecisionDialog
          id={id}
          decision={decision}
          close={() => setDecision(undefined)}
          refresh={() => q.refetch()}
        />
      )}
    </div>
  );
}
function Metadata({ values }: { values: Record<string, unknown> }) {
  const t = useText();
  return Object.keys(values).length ? (
    <dl className="archive-metadata">
      {Object.entries(values).map(([field, value]) => (
        <div key={field}>
          <dt>{field}</dt>
          <dd>{valueText(value)}</dd>
        </div>
      ))}
    </dl>
  ) : (
    <Empty title={t("Nessun metadato disponibile", "No metadata available")} />
  );
}
type ObjectRef = { name: string; kind: string; hash: string };
function SnapshotInspector({
  manifest,
  snapshot,
  workId,
}: {
  manifest: Record<string, unknown>;
  snapshot: string;
  workId: string;
}) {
  const t = useText();
  const [search, setSearch] = useState(""),
    [kind, setKind] = useState("all"),
    [object, setObject] = useState<ObjectRef>();
  const preview = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (object) preview.current?.focus();
  }, [object]);
  const objects = (manifest.objects ?? []) as ObjectRef[];
  const chapters = (manifest.chapters ?? []) as {
    title?: string;
    name?: string;
    hash: string;
    chapter_id: string;
  }[];
  const filtered = objects.filter(
    (o) =>
      (kind === "all" || o.kind === kind) &&
      o.name.toLowerCase().includes(search.toLowerCase()),
  );
  const [limit, setLimit] = useState(50);
  return (
    <>
      <Facts
        items={[
          [t("Stato", "State"), <Status state={String(manifest.state)} />],
          [t("Unità di contenuto", "Content units"), number(chapters.length)],
          [
            t("Oggetti referenziati", "Referenced objects"),
            number(objects.length),
          ],
        ]}
      />
      <div className="archive-toolbar">
        <Field
          label={t("Cerca componente", "Find component")}
          value={search}
          type="search"
          onChange={(e) => {
            setSearch(e.target.value);
            setLimit(50);
          }}
        />
        <Select
          label={t("Tipo", "Type")}
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setLimit(50);
          }}
        >
          <option value="all">
            {t("Tutti i componenti", "All components")}
          </option>
          {[...new Set(objects.map((o) => o.kind))].sort().map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </Select>
      </div>
      <div className="archive-components">
        {filtered.slice(0, limit).map((o) => (
          <button
            className="archive-component"
            key={o.name}
            aria-pressed={object?.name === o.name}
            onClick={() => setObject(o)}
          >
            <span>
              {o.name}
              <small>{o.kind}</small>
            </span>
            <span aria-hidden="true">↗</span>
          </button>
        ))}
      </div>
      {!filtered.length && (
        <Empty
          title={t(
            "Nessun componente corrispondente",
            "No matching components",
          )}
        />
      )}{" "}
      {filtered.length > limit && (
        <Button onClick={() => setLimit(limit + 50)}>
          {t("Mostra altri componenti", "Show more components")} (
          {filtered.length - limit})
        </Button>
      )}
      {object && (
        <div className="archive-object-preview">
          <div className="archive-section-heading">
            <h3 ref={preview} tabIndex={-1}>
              {object.name}
            </h3>
            <Button onClick={() => setObject(undefined)}>
              {t("Chiudi anteprima", "Close preview")}
            </Button>
          </div>
          <ObjectContent hash={object.hash} />
          <Link
            to={`/admin/archive/objects/${object.hash}?work=${workId}&snapshot=${snapshot}`}
          >
            {t("Apri ispezione completa", "Open full inspection")} →
          </Link>
        </div>
      )}
      <details className="archive-diagnostic">
        <summary>
          {t("Metadati di questa versione", "Metadata of this version")}
        </summary>
        <Metadata
          values={(manifest.metadata ?? {}) as Record<string, unknown>}
        />
      </details>
      {chapters.length > 0 && (
        <details className="archive-diagnostic">
          <summary>
            {t("Ordine dei contenuti", "Content order")} ({chapters.length})
          </summary>
          <ol className="archive-chapter-order">
            {chapters.map((c, i) => (
              <li key={`${c.chapter_id}-${i}`}>
                <Link
                  to={`/admin/archive/objects/${c.hash}?work=${workId}&snapshot=${snapshot}`}
                >
                  {c.title ?? c.name ?? `${t("Contenuto", "Content")} ${i + 1}`}
                </Link>
              </li>
            ))}
          </ol>
        </details>
      )}
      <Diagnostic value={manifest} />
    </>
  );
}
function ObjectContent({ hash }: { hash: string }) {
  const t = useText();
  const q = useQuery({
    queryKey: ["archive-object", hash],
    queryFn: () => call("archiveObject", { hash }),
  });
  return q.isPending ? (
    <Loading />
  ) : q.isError ? (
    <QueryError retry={() => void q.refetch()} />
  ) : (
    <>
      <div className="archive-section-heading">
        <span>
          {q.data.kind} · {bytes(q.data.size)}
        </span>
        <a className="button" href={"/api/v1/admin/archive/blobs/" + hash}>
          {t("Scarica oggetto", "Download object")}
        </a>
      </div>
      <small className="archive-hash">SHA-256 · {hash}</small>
      {q.data.truncated && (
        <p className="archive-help">
          {t(
            "Anteprima dei primi 64 KiB. Il download contiene l’oggetto completo.",
            "Preview of the first 64 KiB. The download contains the complete object.",
          )}
        </p>
      )}
      {q.data.base64 !== null ? (
        <pre className="archive-code">
          {new TextDecoder().decode(
            Uint8Array.from(atob(q.data.base64), (c) => c.charCodeAt(0)),
          )}
        </pre>
      ) : (
        <p className="archive-help">
          {t(
            "Oggetto binario: scaricalo per ispezionarlo.",
            "Binary object: download it to inspect it.",
          )}
        </p>
      )}
    </>
  );
}
export function ArchiveObject() {
  const { hash } = useParams(),
    t = useText(),
    p = useArchiveParams();
  const id = p.params.get("work"),
    snapshot = p.params.get("snapshot");
  const back =
    id && /^[a-f0-9-]{36}$/i.test(id)
      ? `/admin/archive/${id}${snapshot ? `?snapshot=${encodeURIComponent(snapshot)}` : ""}`
      : "/admin/archive";
  return (
    <div className="archive-view">
      <Link className="security-back" to={back}>
        ← {t("Torna all’archivio", "Back to archive")}
      </Link>
      <p className="eyebrow">SHA-256</p>
      <Heading>{t("Oggetto canonico", "Canonical object")}</Heading>
      <ObjectContent hash={hash!} />
    </div>
  );
}
