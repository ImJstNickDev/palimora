import "./archive.css";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@palimora/ui";
import { useText } from "./shared";

export function bytes(value: string | number | null | undefined) {
  if (value == null) return "—";
  const n = Number(value);
  const i = n > 0 ? Math.min(4, Math.floor(Math.log(n) / Math.log(1024))) : 0;
  return `${(n / 1024 ** i).toLocaleString(undefined, { maximumFractionDigits: i ? 1 : 0 })} ${["B", "KiB", "MiB", "GiB", "TiB"][i]}`;
}
export function number(value: unknown) {
  return Number(value ?? 0).toLocaleString();
}
export function date(value: string | null | undefined) {
  return value
    ? new Date(value).toLocaleString(undefined, {
        dateStyle: "short",
        timeStyle: "short",
      })
    : "—";
}
export function duration(value: number | null) {
  if (value == null) return "—";
  const s = Math.max(0, Math.round(value));
  return s < 60
    ? `${s}s`
    : s < 3600
      ? `${Math.floor(s / 60)}m ${s % 60}s`
      : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
export function valueText(value: unknown): string {
  if (value == null) return "—";
  return Array.isArray(value)
    ? value.map(valueText).join(", ")
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
}
export function workTitle(w: {
  metadata: Record<string, unknown>;
  external_id: string | null;
  id: string;
}) {
  return valueText(
    w.metadata.Title ??
      w.metadata.title ??
      (w.external_id ? `AO3 · ${w.external_id}` : w.id),
  );
}
export const activeBatch = (s: string) =>
  ["pending", "scanning", "running"].includes(s);
export const sourceProblem = (s: string) =>
  [
    "missing_source",
    "incomplete_transfer",
    "corrupt_source",
    "parser_unsupported",
    "retry_pending",
  ].includes(s);
export function Status({ state }: { state: string }) {
  const t = useText();
  const labels: Record<string, [string, string]> = {
    pending: ["In coda", "Queued"],
    scanning: ["Inventario", "Scanning"],
    running: ["In corso", "Running"],
    paused: ["In pausa", "Paused"],
    parser_blocked: ["Parser da correggere", "Parser blocked"],
    failed_global: ["Interrotto", "Interrupted"],
    completed: ["Completato", "Completed"],
    completed_with_gaps: ["Completato con lacune", "Completed with gaps"],
    discovered: ["Da elaborare", "Discovered"],
    valid: ["Validato", "Validated"],
    ingested: ["Acquisito", "Ingested"],
    incomplete_transfer: ["Trasferimento incompleto", "Incomplete transfer"],
    missing_source: ["Sorgente assente", "Missing source"],
    corrupt_source: ["Sorgente danneggiata", "Damaged source"],
    parser_unsupported: ["Parser non supportato", "Unsupported parser"],
    retry_pending: ["Retry in attesa", "Retry pending"],
    partial: ["Contenuto parziale", "Partial content"],
    metadata_only: ["Solo metadati", "Metadata only"],
    failed: ["Non riuscito", "Failed"],
    current: ["Corrente", "Current"],
    missing: ["Senza corrente", "No current version"],
  };
  const tone = [
    "failed",
    "failed_global",
    "parser_blocked",
    "parser_unsupported",
  ].includes(state)
    ? "danger"
    : sourceProblem(state) ||
        ["completed_with_gaps", "partial", "missing"].includes(state)
      ? "warning"
      : ["completed", "ingested", "current", "valid"].includes(state)
        ? "success"
        : activeBatch(state)
          ? "active"
          : "neutral";
  return (
    <span className={`archive-status ${tone}`}>
      <span aria-hidden="true" />
      {labels[state] ? t(...labels[state]) : state}
    </span>
  );
}
export function Empty({
  title,
  children,
}: React.PropsWithChildren<{ title: string }>) {
  return (
    <div className="archive-empty">
      <strong>{title}</strong>
      {children && <div>{children}</div>}
    </div>
  );
}
export function Facts({ items }: { items: [string, React.ReactNode][] }) {
  return (
    <dl className="archive-facts">
      {items.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}
export function Progress({
  value,
  total,
  label,
}: {
  value: number;
  total: number | null;
  label: string;
}) {
  return (
    <div className="archive-progress">
      <div>
        <span>{label}</span>
        <span>
          {total ? `${Math.min(100, Math.round((value / total) * 100))}%` : "—"}
        </span>
      </div>
      {total !== null && total > 0 && (
        <progress
          aria-label={label}
          max={total}
          value={Math.min(value, total)}
        />
      )}
    </div>
  );
}
export function Live({
  updated,
  fetching,
  error,
  refresh,
}: {
  updated: number;
  fetching: boolean;
  error: boolean;
  refresh: () => unknown;
}) {
  const t = useText();
  return (
    <div className="archive-live">
      <span className={error ? "archive-error" : "muted"}>
        {error
          ? t("Aggiornamento non riuscito", "Update failed")
          : updated
            ? t("Aggiornato alle ", "Updated at ") +
              new Date(updated).toLocaleTimeString()
            : t("Connessione…", "Connecting…")}
      </span>
      <Button
        aria-label={t("Aggiorna dati", "Refresh data")}
        disabled={fetching}
        onClick={() => void refresh()}
      >
        ↻
      </Button>
    </div>
  );
}
export function Pager({
  next,
  previous,
  onNext,
  onPrevious,
}: {
  next?: string | null;
  previous: boolean;
  onNext: (s: string) => void;
  onPrevious: () => void;
}) {
  const t = useText();
  if (!next && !previous) return null;
  return (
    <div className="archive-pager">
      <Button disabled={!previous} onClick={onPrevious}>
        ← {t("Precedenti", "Previous")}
      </Button>
      <Button disabled={!next} onClick={() => next && onNext(next)}>
        {t("Successivi", "Next")} →
      </Button>
    </div>
  );
}
export function useArchiveParams() {
  const [params, setParams] = useSearchParams();
  const set = (key: string, value: string, reset = true) =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      value ? n.set(key, value) : n.delete(key);
      if (reset) {
        n.delete("cursor");
        n.delete("before");
      }
      return n;
    });
  const cursor = params.get("cursor") ?? undefined;
  return {
    params,
    set,
    cursor,
    pager: {
      previous: !!cursor,
      onNext: (s: string) =>
        setParams((p) => {
          const n = new URLSearchParams(p);
          n.set(
            "before",
            [
              ...(p.get("before")?.split(",") ?? []),
              p.get("cursor") ?? "",
            ].join(","),
          );
          n.set("cursor", s);
          return n;
        }),
      onPrevious: () =>
        setParams((p) => {
          const n = new URLSearchParams(p);
          const stack = (p.get("before") ?? "").split(",");
          const c = stack.pop();
          c ? n.set("cursor", c) : n.delete("cursor");
          stack.length ? n.set("before", stack.join(",")) : n.delete("before");
          return n;
        }),
    },
  };
}
export function useDebounce(value: string) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), 300);
    return () => clearTimeout(timer);
  }, [value]);
  return debounced;
}
export function Diagnostic({ value }: { value: unknown }) {
  const t = useText();
  return (
    <details className="archive-diagnostic">
      <summary>{t("Dettagli tecnici", "Technical details")}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
