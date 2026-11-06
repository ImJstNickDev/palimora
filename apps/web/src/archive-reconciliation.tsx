import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Field, Modal, Select } from "@palimora/ui";
import type { Input } from "@palimora/contracts";
import { call } from "./api";
import { Feedback, Loading, QueryError, useAction, useText } from "./shared";
import {
  Empty,
  Pager,
  useDebounce,
  valueText,
  workTitle,
} from "./archive-common";
export type Decision = Pick<
  Input<"archiveResolve">,
  "kind" | "target" | "field"
> & { label: string; value?: unknown };
export function DecisionDialog({
  id,
  decision,
  close,
  refresh,
}: {
  id: string;
  decision: Decision;
  close: () => void;
  refresh: () => unknown;
}) {
  const t = useText(),
    a = useAction(t, {
      CONFLICT: t(
        "Associazione incompatibile con i dati esistenti. Controlla identità e ID AO3 prima di confermare.",
        "Association conflicts with existing data. Check the identity and AO3 ID before confirming.",
      ),
    });
  const [reason, setReason] = useState(""),
    [requestId] = useState(() => crypto.randomUUID());
  return (
    <Modal
      open
      onClose={close}
      title={decision.label}
      closeLabel={t("Chiudi", "Close")}
      description={t(
        "La decisione viene registrata con il tuo account e conserva le versioni storiche.",
        "The decision is recorded under your account and preserves historical versions.",
      )}
    >
      <div className="archive-decision-value">
        {valueText(decision.value ?? decision.target)}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void a.run(async () => {
            await call("archiveResolve", {
              id,
              requestId,
              kind: decision.kind,
              target: decision.target,
              field: decision.field,
              reason,
            });
            await refresh();
            close();
          });
        }}
      >
        <Field
          label={t("Motivo della decisione", "Decision reason")}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
          minLength={3}
          maxLength={1000}
        />
        <Feedback action={a} />
        <div className="row">
          <Button type="button" onClick={close}>
            {t("Annulla", "Cancel")}
          </Button>
          <Button
            type="submit"
            tone="primary"
            disabled={a.busy || reason.trim().length < 3}
          >
            {t("Conferma decisione", "Confirm decision")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
export function Reconciliation({
  id,
  linked,
  refresh,
}: {
  id: string;
  linked?: boolean;
  refresh: () => unknown;
}) {
  const t = useText();
  const [decision, setDecision] = useState<Decision>();
  const [pages, setPages] = useState<(string | undefined)[]>([undefined]),
    [evidencePages, setEvidencePages] = useState<(string | undefined)[]>([
      undefined,
    ]);
  const [kind, setKind] = useState("external_id"),
    [target, setTarget] = useState(""),
    [search, setSearch] = useState("");
  const [evidenceSearch, setEvidenceSearch] = useState("");
  const term = useDebounce(search);
  const q = useQuery({
    queryKey: ["conflicts", id, pages.at(-1), evidencePages.at(-1)],
    queryFn: () =>
      call("archiveConflicts", {
        id,
        cursor: pages.at(-1),
        evidenceCursor: evidencePages.at(-1),
      }),
  });
  const candidates = useQuery({
    queryKey: ["identity-search", term],
    queryFn: () => call("archiveWorks", { q: term }),
    enabled: kind === "identity" && term.trim().length > 0,
  });
  const reload = async () => {
    await q.refetch();
    await refresh();
  };
  const labels: Record<string, string> = {
    metadata: t("Metadati", "Metadata"),
    chronology: t("Ordine delle versioni", "Version order"),
    identity: t("Identità dell’opera", "Work identity"),
  };
  return (
    <div className="archive-reconciliation">
      <h2>{t("Conflitti aperti", "Open conflicts")}</h2>
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <QueryError retry={() => void q.refetch()} />
      ) : (
        <>
          {q.data.items.length ? (
            <div className="archive-issues">
              {q.data.items.map((i) => (
                <details key={i.id}>
                  <summary>
                    {labels[i.kind] ?? i.kind}
                    {i.detail.field ? ` · ${String(i.detail.field)}` : ""}
                  </summary>
                  <pre>{JSON.stringify(i.detail, null, 2)}</pre>
                </details>
              ))}
            </div>
          ) : (
            <Empty title={t("Nessun conflitto aperto", "No open conflicts")} />
          )}
          <Pager
            next={q.data.next}
            previous={pages.length > 1}
            onNext={(s) => setPages([...pages, s])}
            onPrevious={() => setPages((p) => p.slice(0, -1))}
          />
          <div className="archive-section-heading">
            <h2>{t("Evidenze dei metadati", "Metadata evidence")}</h2>
            <span className="muted">
              {t(
                "Ogni valore mantiene la propria origine",
                "Each value retains its provenance",
              )}
            </span>
          </div>
          <Field
            label={t(
              "Filtra i campi di questa pagina",
              "Filter fields on this page",
            )}
            type="search"
            value={evidenceSearch}
            onChange={(e) => setEvidenceSearch(e.target.value)}
          />
          <div className="archive-evidence">
            {q.data.evidence
              .filter((e) =>
                String(e.field)
                  .toLowerCase()
                  .includes(evidenceSearch.toLowerCase()),
              )
              .map((e) => (
                <div key={String(e.id)} className="archive-evidence-row">
                  <strong>{String(e.field)}</strong>
                  <div>
                    <div className="archive-evidence-value">
                      {valueText(e.value)}
                    </div>
                    <small>
                      {String(e.source_path)} · {String(e.locator)}
                    </small>
                    <small>{String(e.parser)}</small>
                  </div>
                  <Button
                    onClick={() =>
                      setDecision({
                        kind: "metadata",
                        target: String(e.id),
                        field: String(e.field),
                        label:
                          t("Usa valore per ", "Use value for ") +
                          String(e.field),
                        value: e.value,
                      })
                    }
                  >
                    {t("Usa valore", "Use value")}
                  </Button>
                </div>
              ))}
          </div>
          {!q.data.evidence.length && (
            <Empty
              title={t("Nessuna evidenza disponibile", "No evidence available")}
            />
          )}
          <Pager
            next={q.data.nextEvidence}
            previous={evidencePages.length > 1}
            onNext={(s) => setEvidencePages([...evidencePages, s])}
            onPrevious={() => setEvidencePages((p) => p.slice(0, -1))}
          />
        </>
      )}
      <details className="archive-identity">
        <summary>
          {t("Correggi associazione dell’opera", "Correct work association")}
        </summary>
        <p className="archive-help">
          {t(
            "Collega solo identità verificate. Il collegamento non modifica gli snapshot conservati.",
            "Link only verified identities. Linking does not modify preserved snapshots.",
          )}
        </p>
        <Select
          label={t("Operazione", "Operation")}
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setTarget("");
          }}
        >
          <option value="external_id">
            {t("Correggi ID AO3", "Correct AO3 ID")}
          </option>
          <option value="identity">
            {t("Collega a un’opera locale", "Link to a local work")}
          </option>
          {linked && (
            <option value="unlink">
              {t("Rimuovi collegamento locale", "Remove local link")}
            </option>
          )}
        </Select>
        {kind === "external_id" && (
          <>
            <Field
              label="AO3 ID"
              value={target}
              inputMode="numeric"
              pattern="[0-9]+"
              onChange={(e) => setTarget(e.target.value)}
            />
            <Button
              disabled={!/^[0-9]+$/.test(target)}
              onClick={() =>
                setDecision({
                  kind: "external_id",
                  target,
                  label: t("Correggi ID AO3", "Correct AO3 ID"),
                  value: `AO3 · ${target}`,
                })
              }
            >
              {t("Rivedi modifica", "Review change")}
            </Button>
          </>
        )}
        {kind === "identity" && (
          <>
            <Field
              label={t(
                "Cerca opera per titolo o ID",
                "Find work by title or ID",
              )}
              value={search}
              type="search"
              maxLength={100}
              onChange={(e) => setSearch(e.target.value)}
            />
            {term && candidates.isPending ? (
              <Loading />
            ) : candidates.isError ? (
              <QueryError retry={() => void candidates.refetch()} />
            ) : (
              candidates.data && (
                <>
                  <div className="archive-candidates">
                    {candidates.data.items
                      .filter((w) => w.id !== id)
                      .map((w) => (
                        <div key={w.id}>
                          <span>
                            {workTitle(w)}
                            <small>
                              {w.external_id ? `AO3 · ${w.external_id}` : w.id}
                            </small>
                          </span>
                          <Button
                            onClick={() =>
                              setDecision({
                                kind: "identity",
                                target: w.id,
                                label: t("Collega identità", "Link identity"),
                                value: workTitle(w) + " · " + w.id,
                              })
                            }
                          >
                            {t("Seleziona", "Select")}
                          </Button>
                        </div>
                      ))}
                  </div>
                  {candidates.data.next && (
                    <small>
                      {t(
                        "Mostrati i primi 50 risultati. Affina la ricerca.",
                        "Showing the first 50 results. Refine your search.",
                      )}
                    </small>
                  )}
                  {!candidates.data.items.filter((w) => w.id !== id).length && (
                    <Empty
                      title={t(
                        "Nessun’altra opera corrispondente",
                        "No other matching work",
                      )}
                    />
                  )}
                </>
              )
            )}
          </>
        )}
        {kind === "unlink" && (
          <Button
            onClick={() =>
              setDecision({
                kind: "unlink",
                target: "",
                label: t("Rimuovi collegamento locale", "Remove local link"),
                value: id,
              })
            }
          >
            {t("Rivedi modifica", "Review change")}
          </Button>
        )}
      </details>
      {decision && (
        <DecisionDialog
          id={id}
          decision={decision}
          close={() => setDecision(undefined)}
          refresh={reload}
        />
      )}
    </div>
  );
}
