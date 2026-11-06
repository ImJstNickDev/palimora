import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Button, Field, Select } from "@palimora/ui";
import { call } from "./api";
import { Feedback, Loading, QueryError, useAction, useText } from "./shared";
import {
  bytes,
  number,
  duration,
  Status,
  Empty,
  Facts,
  Pager,
} from "./archive-common";
export { Reconciliation } from "./archive-reconciliation";
export { ArchiveStorage } from "./archive-storage";

export function SourceSelection({
  selected,
  setSelected,
  disabled = false,
}: {
  selected: string[];
  setSelected: (s: string[]) => void;
  disabled?: boolean;
}) {
  const t = useText();
  const [search, setSearch] = useState(""),
    [format, setFormat] = useState("all"),
    [order, setOrder] = useState("name");
  const q = useQuery({
    queryKey: ["archive-inventory"],
    queryFn: () => call("archiveInventory", {}),
    refetchInterval: 10000,
  });
  if (q.isPending) return <Loading />;
  if (q.isError) return <QueryError retry={() => void q.refetch()} />;
  const items = q.data.items
    .filter(
      (s) =>
        s.path.toLowerCase().includes(search.toLowerCase()) &&
        (format === "all" ||
          (format === "gaps"
            ? s.state !== "valid" && s.state !== "discovered"
            : s.path.endsWith(format))),
    )
    .sort((a, b) =>
      order === "size"
        ? Number(a.size) - Number(b.size)
        : a.path.localeCompare(b.path, undefined, { numeric: true }),
    );
  const total = q.data.items
    .filter((s) => selected.includes(s.path))
    .reduce((n, s) => n + Number(s.size), 0);
  const toggleAll = () =>
    setSelected(
      items.every((s) => selected.includes(s.path))
        ? selected.filter((p) => !items.some((s) => s.path === p))
        : [...new Set([...selected, ...items.map((s) => s.path)])],
    );
  return (
    <div className="archive-source-picker">
      <div className="archive-toolbar">
        <Field
          label={t("Cerca sorgenti", "Find sources")}
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <Select
          label={t("Formato", "Format")}
          value={format}
          onChange={(e) => setFormat(e.target.value)}
        >
          <option value="all">{t("Tutti i file", "All files")}</option>
          <option value=".zip">ZIP</option>
          <option value=".sqlite3">SQLite</option>
          <option value="gaps">{t("Lacune", "Gaps")}</option>
        </Select>
        <Select
          label={t("Ordina", "Sort")}
          value={order}
          onChange={(e) => setOrder(e.target.value)}
        >
          <option value="name">{t("Nome", "Name")}</option>
          <option value="size">
            {t("Dimensione crescente", "Smallest first")}
          </option>
        </Select>
      </div>
      <div className="archive-selection-bar">
        <span>
          {number(items.length)} {t("file visibili", "visible files")} ·{" "}
          <strong>
            {selected.length} {t("selezionati", "selected")}
          </strong>{" "}
          · {bytes(total)}
        </span>
        <Button disabled={disabled || !items.length} onClick={toggleAll}>
          {items.length > 0 && items.every((s) => selected.includes(s.path))
            ? t("Deseleziona visibili", "Deselect visible")
            : t("Seleziona visibili", "Select visible")}
        </Button>
        <Button
          disabled={disabled || !selected.length}
          onClick={() => setSelected([])}
        >
          {t("Azzera", "Clear")}
        </Button>
      </div>
      <div
        className="archive-source-list"
        role="group"
        aria-label={t("Sorgenti disponibili", "Available sources")}
      >
        {items.map((s) => (
          <label className="archive-source-option" key={s.path}>
            <input
              type="checkbox"
              disabled={disabled}
              checked={selected.includes(s.path)}
              onChange={(e) =>
                setSelected(
                  e.target.checked
                    ? [...selected, s.path]
                    : selected.filter((p) => p !== s.path),
                )
              }
            />
            <span className="archive-file-name">
              {s.path}
              <small>
                {s.path.endsWith(".sqlite3")
                  ? t("Indice metadati", "Metadata index")
                  : s.path.endsWith(".zip")
                    ? t("Archivio di contenuti", "Content archive")
                    : t("Trasferimento incompleto", "Incomplete transfer")}
              </small>
            </span>
            <span className="archive-size">{bytes(s.size)}</span>
            <Status state={s.state} />
          </label>
        ))}
        {!items.length && (
          <Empty
            title={t("Nessuna sorgente corrispondente", "No matching sources")}
          />
        )}
      </div>
      <small className="archive-help">
        {t("Inventario del mount in sola lettura", "Read-only mount inventory")}{" "}
        · /dumps/ao3_stories
        {q.data.items[0] &&
          " · " +
            t("Rilevato alle ", "Scanned at ") +
            new Date(q.data.items[0].updated_at).toLocaleTimeString()}
      </small>
    </div>
  );
}

export function BatchReport({ id, path }: { id: string; path?: string }) {
  const t = useText(),
    a = useAction(),
    navigate = useNavigate();
  const [pages, setPages] = useState<(string | undefined)[]>([undefined]);
  const cursor = pages.at(-1);
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const q = useQuery({
    queryKey: ["report", id, path, cursor],
    queryFn: () => call("ingestReport", { id, path, cursor }),
    refetchInterval: 3000,
  });
  const inventory = useQuery({
    queryKey: ["archive-inventory"],
    queryFn: () => call("archiveInventory", {}),
  });
  const sqlite =
    inventory.data?.items
      .filter(
        (s) => s.path.endsWith(".sqlite3") && s.state !== "missing_source",
      )
      .map((s) => s.path) ?? [];
  async function download() {
    const detail = await call("ingestDetail", { id });
    const issues = [];
    let cursor: string | undefined;
    let summary;
    do {
      const p = await call("ingestReport", { id, cursor });
      summary = p.summary;
      issues.push(...p.issues);
      cursor = p.next ?? undefined;
    } while (cursor);
    const url = URL.createObjectURL(
      new Blob(
        [
          JSON.stringify(
            {
              schema: "palimora-ingest-report-v1",
              batch_id: id,
              ...detail,
              summary,
              issues,
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `ingest-${id}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="archive-report">
      <div className="archive-section-heading">
        <h2>{t("Report e diagnostica", "Report and diagnostics")}</h2>
        <Button disabled={a.busy} onClick={() => void a.run(download)}>
          {t("Scarica report JSON", "Download JSON report")}
        </Button>
      </div>
      <Feedback action={a} />
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <QueryError retry={() => void q.refetch()} />
      ) : (
        <>
          <Facts
            items={[
              [
                t("Acquisizioni già presenti", "Existing acquisitions"),
                number(q.data.summary.duplicates),
              ],
              [
                t("Sorgente verificata", "Verified source data"),
                bytes(q.data.summary.bytes),
              ],
              [
                t("Velocità media", "Average throughput"),
                number(Number(q.data.summary.records_per_second.toFixed(2))) +
                  " rec/s",
              ],
              [
                t("Tempo trascorso", "Elapsed time"),
                duration(q.data.summary.elapsed_seconds),
              ],
              [
                t("Tempo restante stimato", "Estimated remaining time"),
                ["running", "scanning"].includes(q.data.summary.state)
                  ? duration(q.data.summary.eta_seconds)
                  : "—",
              ],
            ]}
          />
          <div className="archive-outcomes">
            {q.data.summary.works.map((w) => (
              <span key={w.state}>
                <Status state={w.state} /> <strong>{number(w.count)}</strong>
              </span>
            ))}
          </div>
          <div className="archive-inline-action">
            <div>
              <strong>
                {t(
                  "Completa i metadati da SQLite",
                  "Enrich metadata from SQLite",
                )}
              </strong>
              <small>
                {t(
                  "Elabora gli indici disponibili per le sole opere acquisite da questo batch.",
                  "Process available indexes only for works acquired by this batch.",
                )}
              </small>
            </div>
            <Button
              disabled={
                a.busy || !sqlite.length || !q.data.summary.works.length
              }
              onClick={() =>
                void a.run(async () => {
                  const batch = await call("ingestCreate", {
                    requestId,
                    reprocess: true,
                    selection: sqlite,
                    reconcileBatchId: id,
                  });
                  setRequestId(crypto.randomUUID());
                  navigate("/admin/ingest/" + batch.id);
                })
              }
            >
              {t("Riconcilia con SQLite", "Reconcile with SQLite")}
            </Button>
          </div>
          {!sqlite.length && (
            <small>
              {t(
                "Nessun indice SQLite disponibile nell’inventario.",
                "No SQLite index available in the inventory.",
              )}
            </small>
          )}
          <h3>
            {t("Anomalie registrate", "Recorded issues")}
            {path && <small>{path}</small>}
          </h3>
          {!q.data.issues.length ? (
            <Empty
              title={t("Nessuna anomalia registrata", "No recorded issues")}
            />
          ) : (
            <div className="archive-issues">
              {q.data.issues.map((i) => (
                <details key={i.id}>
                  <summary>
                    <span className="archive-issue-code">{i.code}</span>
                    <span>
                      {i.path}
                      <small>{i.locator}</small>
                    </span>
                  </summary>
                  <pre>{JSON.stringify(i.detail, null, 2)}</pre>
                  <small>
                    {t("Fingerprint sorgente", "Source fingerprint")}:{" "}
                    {i.fingerprint}
                  </small>
                </details>
              ))}
            </div>
          )}
          <Pager
            next={q.data.next}
            previous={pages.length > 1}
            onNext={(s) => setPages([...pages, s])}
            onPrevious={() => setPages((p) => p.slice(0, -1))}
          />
        </>
      )}
    </div>
  );
}
