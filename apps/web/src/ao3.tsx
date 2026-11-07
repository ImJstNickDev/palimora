import { SyncOperations } from "./ao3-operations";
import { useQuery } from "@tanstack/react-query";
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
import { date, Live, Facts } from "./archive-common";

export function AO3Monitor() {
  const t = useText(),
    action = useAction();
  const q = useQuery({
    queryKey: ["ao3-status"],
    queryFn: () => call("ao3Status", {}),
    refetchInterval: 10_000,
  });
  const labels: Record<string, string> = {
    online: t("Operativo", "Operational"),
    maintenance: t("Manutenzione", "Maintenance"),
    rate_limited: t("Limite richieste", "Rate limited"),
    blocked: t("Accesso bloccato", "Access blocked"),
    unreachable: t("Non raggiungibile", "Unreachable"),
    unknown: t("Non verificato", "Unverified"),
  };
  return (
    <div className="archive-view">
      <div className="archive-page-heading">
        <Heading>{t("Disponibilità AO3", "AO3 availability")}</Heading>
        <Live
          updated={q.dataUpdatedAt}
          fetching={q.isFetching}
          error={q.isError}
          refresh={q.refetch}
        />
      </div>
      <Feedback action={action} />
      {q.isPending ? (
        <Loading />
      ) : !q.data ? (
        <QueryError retry={() => void q.refetch()} />
      ) : (
        <>
          <Facts
            items={[
              [
                t("Stato rilevato", "Observed status"),
                labels[q.data.control.observed_state],
              ],
              [
                t("Ultima verifica", "Last check"),
                date(q.data.control.checked_at),
              ],
              [
                t("Prossima verifica", "Next check"),
                date(q.data.control.next_probe_at),
              ],
              [
                t("Sospensione richieste fino a", "Request cooldown until"),
                date(q.data.control.cooldown_until),
              ],
              [
                t(
                  "Opere aperte nelle ultime 48 ore",
                  "Works opened in the last 48 hours",
                ),
                q.data.watching,
              ],
            ]}
          />

          <label>
            {t("Disponibilità imposta", "Availability override")}{" "}
            <select
              value={q.data.control.mode}
              disabled={action.busy}
              onChange={(e) => {
                const mode = e.target.value as
                  | "auto"
                  | "force_online"
                  | "force_offline";
                void action.run(async () => {
                  await call("ao3Control", {
                    mode,
                    paused: q.data!.control.paused,
                  });
                  await q.refetch();
                });
              }}
            >
              <option value="auto">Auto</option>
              <option value="force_online">Online</option>
              <option value="force_offline">Offline</option>
            </select>
          </label>
          <p>
            {t(
              "Online consente i tentativi senza modificare lo stato rilevato o le sospensioni imposte da AO3. Offline sospende anche le sonde.",
              "Online permits attempts without changing observed status or AO3 cooldowns. Offline also suspends probes.",
            )}
          </p>
          <Button
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await call("ao3Control", {
                  mode: q.data!.control.mode,
                  paused: !q.data!.control.paused,
                });
                await q.refetch();
              })
            }
          >
            {q.data.control.paused
              ? t("Riprendi sincronizzazione", "Resume synchronization")
              : t("Sospendi sincronizzazione", "Pause synchronization")}
          </Button>
          <h2>{t("Cronologia verifiche", "Check history")}</h2>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{t("Data", "Date")}</th>
                  <th>{t("Risultato", "Result")}</th>
                  <th>HTTP</th>
                  <th>ms</th>
                  <th>{t("Retry consentito da", "Retry allowed from")}</th>
                </tr>
              </thead>
              <tbody>
                {q.data.history.map((row) => (
                  <tr key={row.id}>
                    <td>{date(row.started_at)}</td>
                    <td>{labels[row.state] ?? row.state}</td>
                    <td>{row.http_status ?? "—"}</td>
                    <td>{row.duration_ms}</td>
                    <td>{date(row.retry_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!q.data.history.length && (
            <p>{t("Nessuna verifica eseguita.", "No checks performed.")}</p>
          )}
        </>
      )}
      <SyncOperations />
    </div>
  );
}
