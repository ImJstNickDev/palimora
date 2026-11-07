import { useOffline } from "./offline-ui";
import { useState, useContext } from "react";
import { Link, NavLink, useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Button, Field, Modal, Notice, Select } from "@palimora/ui";
import type { Input, Output } from "@palimora/contracts";
import { call } from "./api";
import {
  client,
  Auth,
  useText,
  useAction,
  Loading,
  QueryError,
} from "./shared";
import { states } from "./reading";
import "./library.css";
export function SocialNav() {
  const t = useText();
  const { offline } = useOffline();
  if (offline)
    return (
      <nav
        className="library-tabs"
        aria-label={t("Biblioteca personale", "Personal library")}
      >
        <NavLink to="/offline">{t("Offline", "Offline")}</NavLink>
      </nav>
    );
  return (
    <nav
      className="library-tabs"
      aria-label={t("Biblioteca personale", "Personal library")}
    >
      <NavLink to="/library">{t("Biblioteca", "Library")}</NavLink>
      <NavLink to="/collections">{t("Collezioni", "Collections")}</NavLink>
      <NavLink to="/offline">{t("Offline", "Offline")}</NavLink>
      <NavLink to="/statistics">{t("Statistiche", "Statistics")}</NavLink>
      <NavLink to="/activity">{t("Attività", "Activity")}</NavLink>
      <NavLink to="/subscriptions">
        {t("Sottoscrizioni", "Subscriptions")}
      </NavLink>
      <NavLink to="/notifications">{t("Notifiche", "Notifications")}</NavLink>
      <NavLink to="/social-settings">
        {t("Privacy e notifiche", "Privacy and notifications")}
      </NavLink>
    </nav>
  );
}
export function Follow({
  kind,
  target,
}: {
  kind: Input<"subscriptionSave">["kind"];
  target: string;
}) {
  const t = useText(),
    a = useAction(t),
    q = useQuery({
      queryKey: ["subscription", kind, target],
      queryFn: () => call("subscriptionStatus", { kind, target }),
    });
  if (q.isPending) return null;
  if (q.isError) return <QueryError retry={() => void q.refetch()} />;
  return (
    <div className="library-controls">
      <Select
        label={t("Sottoscrizione", "Subscription")}
        value={q.data.mode ?? ""}
        disabled={a.busy}
        onChange={(e) =>
          void a.run(async () => {
            await call("subscriptionSave", {
              kind,
              target,
              mode: (e.target.value ||
                null) as Input<"subscriptionSave">["mode"],
            });
            await q.refetch();
            await client.invalidateQueries({ queryKey: ["subscriptions"] });
          })
        }
      >
        <option value="">{t("Non seguire", "Not following")}</option>
        <option value="chapters">
          {t("Nuove opere e capitoli", "New works and chapters")}
        </option>
        <option value="changes">
          {t("Anche modifiche al testo", "Include text changes")}
        </option>
      </Select>
      {a.error && <Notice error>{a.error}</Notice>}
    </div>
  );
}
export function Recommend({ work }: { work: string }) {
  const t = useText(),
    a = useAction(t),
    [open, setOpen] = useState(false),
    [requestId, setRequestId] = useState(() => crypto.randomUUID()),
    [sent, setSent] = useState(false);
  return (
    <>
      <Button
        onClick={() => {
          setRequestId(crypto.randomUUID());
          setOpen(true);
          setSent(false);
        }}
      >
        {t("Consiglia", "Recommend")}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t("Consiglia opera", "Recommend work")}
        closeLabel={t("Chiudi", "Close")}
      >
        {sent ? (
          <Notice>{t("Consiglio inviato.", "Recommendation sent.")}</Notice>
        ) : (
          <form
            className="bookmark-editor"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void a.run(async () => {
                await call("recommendWork", {
                  work,
                  requestId,
                  username: String(f.get("username")),
                  note: String(f.get("note")),
                });
                setSent(true);
              });
            }}
          >
            <Field
              label={t("Destinatario", "Recipient")}
              name="username"
              required
              maxLength={100}
            />
            <label>
              {t("Nota", "Note")}
              <textarea name="note" rows={4} maxLength={2000} />
            </label>
            <Button disabled={a.busy}>{t("Invia", "Send")}</Button>
            {a.error && <Notice error>{a.error}</Notice>}
          </form>
        )}
      </Modal>
    </>
  );
}
export function Statistics() {
  const t = useText(),
    [params, setParams] = useSearchParams(),
    username = params.get("username") || undefined;
  const q = useQuery({
    queryKey: ["statistics", username],
    queryFn: () => call("personalStatistics", { username }),
  });
  return (
    <section className="personal-library">
      <h1 tabIndex={-1}>
        {t("Statistiche di lettura", "Reading statistics")}
        {username ? " · " + username : ""}
      </h1>
      <SocialNav />
      <ProfileSearch
        username={username}
        onSearch={(name) => setParams(name ? { username: name } : {})}
      />
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <QueryError retry={() => void q.refetch()} />
      ) : (
        <>
          <dl className="personal-totals">
            <div>
              <dt>{t("Opere con progressi", "Works with progress")}</dt>
              <dd>{q.data.works}</dd>
            </div>
            <div>
              <dt>{t("Opere completate", "Completed works")}</dt>
              <dd>{q.data.completed}</dd>
            </div>
            <div>
              <dt>
                {t("Parole delle opere completate", "Words in completed works")}
              </dt>
              <dd>
                {q.data.words === null
                  ? "—"
                  : q.data.words.toLocaleString(t("it", "en"))}
                {q.data.unknown_words > 0 &&
                  " + " +
                    q.data.unknown_words +
                    " " +
                    t("opere senza conteggio", "works without a word count")}
              </dd>
            </div>
            <div>
              <dt>{t("Tempo attivo nel lettore", "Active reader time")}</dt>
              <dd>
                {Math.floor(q.data.seconds / 3600)} h{" "}
                {Math.floor((q.data.seconds % 3600) / 60)} min
              </dd>
            </div>
          </dl>
          <p>
            <small>
              {t("Tempo misurato dal ", "Time measured since ") +
                new Date(q.data.measured_since).toLocaleDateString(
                  t("it", "en"),
                )}
            </small>
          </p>
          <h2>{t("Fandom più letti", "Most read fandoms")}</h2>
          <ul className="library-entries">
            {q.data.fandoms.map((f) => (
              <li key={f.name}>
                {f.name} <strong>{f.works}</strong>
              </li>
            ))}
          </ul>
          {!q.data.fandoms.length && (
            <p>{t("Nessun fandom registrato.", "No fandoms recorded.")}</p>
          )}
          <h2>{t("Completamenti nel tempo", "Completions over time")}</h2>
          <table>
            <thead>
              <tr>
                <th>{t("Data (UTC)", "Date (UTC)")}</th>
                <th>{t("Opere", "Works")}</th>
              </tr>
            </thead>
            <tbody>
              {q.data.timeline.map((d) => (
                <tr key={d.day}>
                  <td>{d.day}</td>
                  <td>{d.completed}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!q.data.timeline.length && (
            <p>
              {t(
                "Nessun completamento registrato.",
                "No completions recorded.",
              )}
            </p>
          )}
        </>
      )}
    </section>
  );
}
function ProfileSearch({
  username,
  onSearch,
}: {
  username?: string;
  onSearch: (name: string) => void;
}) {
  const t = useText(),
    { user } = useContext(Auth);
  return (
    <form
      className="library-filter"
      key={username ?? ""}
      onSubmit={(e) => {
        e.preventDefault();
        onSearch(
          String(new FormData(e.currentTarget).get("username") ?? "").trim(),
        );
      }}
    >
      <Field
        name="username"
        label={t("Nome utente", "Username")}
        defaultValue={username ?? user.username}
        maxLength={100}
      />
      <Button>{t("Mostra", "Show")}</Button>
    </form>
  );
}
export function Activity() {
  const t = useText(),
    [params, setParams] = useSearchParams(),
    username = params.get("username") || undefined;
  const q = useInfiniteQuery({
    queryKey: ["activity", username],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      call("personalActivity", { username, cursor: pageParam }),
    getNextPageParam: (p) => p.next ?? undefined,
  });
  return (
    <section className="personal-library">
      <h1 tabIndex={-1}>{t("Attività di lettura", "Reading activity")}</h1>
      <SocialNav />
      <ProfileSearch
        username={username}
        onSearch={(name) => setParams(name ? { username: name } : {})}
      />
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <QueryError retry={() => void q.refetch()} />
      ) : (
        <>
          <ul className="library-entries">
            {q.data.pages
              .flatMap((p) => p.items)
              .map((w) => {
                const state = states.find((s) => s[0] === w.state)!;
                return (
                  <li key={w.id}>
                    <Link to={"/works/" + w.id}>{w.title}</Link>
                    <p>
                      {t(state[1], state[2])} · {Math.round(w.percent)}%
                    </p>
                  </li>
                );
              })}
          </ul>
          {!q.data.pages[0].items.length && (
            <p>{t("Nessuna attività.", "No activity.")}</p>
          )}
          {q.hasNextPage && (
            <Button
              disabled={q.isFetchingNextPage}
              onClick={() => void q.fetchNextPage()}
            >
              {t("Altre opere", "More works")}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
export function Subscriptions() {
  const t = useText(),
    a = useAction(t),
    q = useInfiniteQuery({
      queryKey: ["subscriptions"],
      initialPageParam: undefined as string | undefined,
      queryFn: ({ pageParam }) => call("subscriptions", { cursor: pageParam }),
      getNextPageParam: (p) => p.next ?? undefined,
    });
  return (
    <section className="personal-library">
      <h1 tabIndex={-1}>{t("Sottoscrizioni", "Subscriptions")}</h1>
      <SocialNav />
      {a.error && <Notice error>{a.error}</Notice>}
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <QueryError retry={() => void q.refetch()} />
      ) : (
        <>
          <ul className="library-entries">
            {q.data.pages
              .flatMap((p) => p.items)
              .map((s) => (
                <li key={s.kind + s.target}>
                  <Link
                    to={
                      s.kind === "work"
                        ? "/works/" + s.target
                        : "/bibliography/" + s.kind + "/" + s.target
                    }
                  >
                    {s.name}
                  </Link>
                  <Follow kind={s.kind} target={s.target} />
                </li>
              ))}
          </ul>
          {!q.data.pages[0].items.length && (
            <p>{t("Nessuna sottoscrizione.", "No subscriptions.")}</p>
          )}
          {q.hasNextPage && (
            <Button onClick={() => void q.fetchNextPage()}>
              {t("Altre sottoscrizioni", "More subscriptions")}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
export function Notifications() {
  const t = useText(),
    a = useAction(t),
    [unread, setUnread] = useState(false);
  const q = useInfiniteQuery({
    queryKey: ["notifications", unread],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      call("notifications", {
        cursor: pageParam,
        unread: unread ? "true" : "false",
      }),
    getNextPageParam: (p) => p.next ?? undefined,
    refetchInterval: 30000,
  });
  return (
    <section className="personal-library">
      <h1 tabIndex={-1}>
        {t("Notifiche", "Notifications")}
        {q.data ? " · " + q.data.pages[0].unread : ""}
      </h1>
      <SocialNav />
      <label className="check">
        <input
          type="checkbox"
          checked={unread}
          onChange={(e) => setUnread(e.target.checked)}
        />
        {t("Solo non lette", "Unread only")}
      </label>
      {a.error && <Notice error>{a.error}</Notice>}
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <QueryError retry={() => void q.refetch()} />
      ) : (
        <>
          <ul className="library-entries">
            {q.data.pages
              .flatMap((p) => p.items)
              .map((n) => (
                <li key={n.id}>
                  <h2>
                    <Link to={"/works/" + n.work_id}>{n.title}</Link>
                  </h2>
                  <p>
                    {n.kind === "recommendation"
                      ? t("Consigliata da ", "Recommended by ") + n.sender
                      : n.versions +
                        " " +
                        t("aggiornamenti archiviati", "archived updates")}
                  </p>
                  {n.note && <p className="bookmark-notes">{n.note}</p>}
                  <time dateTime={n.updated_at}>
                    {new Date(n.updated_at).toLocaleString(t("it", "en"))}
                  </time>
                  <div className="library-controls">
                    <Button
                      disabled={a.busy}
                      onClick={() =>
                        void a.run(async () => {
                          await call("notificationRead", {
                            id: n.id,
                            read: !n.read_at,
                          });
                          await client.invalidateQueries({
                            queryKey: ["notifications"],
                          });
                        })
                      }
                    >
                      {n.read_at
                        ? t("Segna non letta", "Mark unread")
                        : t("Segna letta", "Mark read")}
                    </Button>
                  </div>
                </li>
              ))}
          </ul>
          {!q.data.pages[0].items.length && (
            <p>{t("Nessuna notifica.", "No notifications.")}</p>
          )}
          {q.hasNextPage && (
            <Button onClick={() => void q.fetchNextPage()}>
              {t("Altre notifiche", "More notifications")}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
export function SocialSettings() {
  const t = useText(),
    q = useQuery({
      queryKey: ["social-settings"],
      queryFn: () => call("socialPreferences", {}),
    });
  return (
    <section className="personal-library">
      <h1 tabIndex={-1}>
        {t("Privacy e notifiche", "Privacy and notifications")}
      </h1>
      <SocialNav />
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <QueryError retry={() => void q.refetch()} />
      ) : (
        <PreferenceForm value={q.data} />
      )}
      <PushSettings />
    </section>
  );
}
function PreferenceForm({ value }: { value: Output<"socialPreferences"> }) {
  const t = useText(),
    a = useAction(t),
    [p, setP] = useState(value),
    [saved, setSaved] = useState(false),
    [recipients, setRecipients] = useState({
      activity: value.activity_users.join("\n"),
      statistics: value.statistics_users.join("\n"),
    });
  return (
    <form
      className="social-preferences"
      onSubmit={(e) => {
        e.preventDefault();
        void a.run(async () => {
          const updated = await call("socialPreferencesSave", {
            ...p,
            activity_users: recipients.activity
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean),
            statistics_users: recipients.statistics
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean),
          });
          setP(updated);
          setSaved(true);
          client.setQueryData(["social-settings"], updated);
        });
      }}
    >
      <h2>{t("Visibilità", "Visibility")}</h2>
      {(["activity", "statistics"] as const).map((scope) => (
        <fieldset key={scope}>
          <legend>
            {scope === "activity"
              ? t("Attività di lettura", "Reading activity")
              : t("Statistiche", "Statistics")}
          </legend>
          <Select
            label={t("Visibile a", "Visible to")}
            value={p[scope]}
            onChange={(e) => setP({ ...p, [scope]: e.target.value })}
          >
            <option value="private">{t("Solo me", "Only me")}</option>
            <option value="selected">
              {t("Utenti selezionati", "Selected users")}
            </option>
            <option value="instance">
              {t("Tutti gli utenti dell’istanza", "Everyone on this instance")}
            </option>
          </Select>
          {p[scope] === "selected" && (
            <label>
              {t("Nomi utente, uno per riga", "Usernames, one per line")}
              <textarea
                rows={3}
                value={recipients[scope]}
                onChange={(e) =>
                  setRecipients({ ...recipients, [scope]: e.target.value })
                }
              />
            </label>
          )}
        </fieldset>
      ))}
      <h2>{t("Notifiche", "Notifications")}</h2>
      {(
        [
          ["recommendations", "Ricevi consigli", "Receive recommendations"],
          [
            "updates",
            "Aggiornamenti delle sottoscrizioni",
            "Subscription updates",
          ],
          ["push", "Consenti notifiche push", "Allow push notifications"],
        ] as const
      ).map(([key, it, en]) => (
        <label className="check" key={key}>
          <input
            type="checkbox"
            checked={p[key]}
            onChange={(e) => setP({ ...p, [key]: e.target.checked })}
          />
          {t(it, en)}
        </label>
      ))}
      <Select
        label={t("Raggruppamento aggiornamenti", "Update grouping")}
        value={p.grouping}
        onChange={(e) =>
          setP({ ...p, grouping: Number(e.target.value) as 0 | 300 | 3600 })
        }
      >
        <option value={0}>{t("Singoli", "Individual")}</option>
        <option value={300}>{t("5 minuti", "5 minutes")}</option>
        <option value={3600}>{t("Un’ora", "One hour")}</option>
      </Select>
      <Button disabled={a.busy}>
        {t("Salva preferenze", "Save preferences")}
      </Button>
      {a.error && <Notice error>{a.error}</Notice>}
      {saved && (
        <Notice>{t("Preferenze salvate.", "Preferences saved.")}</Notice>
      )}
    </form>
  );
}
function PushSettings() {
  const t = useText(),
    a = useAction(t),
    q = useQuery({
      queryKey: ["push-devices"],
      queryFn: () => call("pushDevices", {}),
    }),
    [denied, setDenied] = useState(false);
  const supported =
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;
  return (
    <section>
      <h2>{t("Dispositivi push", "Push devices")}</h2>
      {supported ? (
        <Button
          disabled={a.busy || !q.data}
          onClick={() =>
            void a.run(async () => {
              const permission = await Notification.requestPermission();
              if (permission !== "granted") {
                setDenied(true);
                return;
              }
              setDenied(false);
              const registration =
                await navigator.serviceWorker.register("/push-worker.js");
              await navigator.serviceWorker.ready;
              const bytes = Uint8Array.from(
                atob(q.data!.publicKey.replace(/-/g, "+").replace(/_/g, "/")),
                (c) => c.charCodeAt(0),
              );
              const sub =
                (await registration.pushManager.getSubscription()) ??
                (await registration.pushManager.subscribe({
                  userVisibleOnly: true,
                  applicationServerKey: bytes,
                }));
              const data = sub.toJSON();
              await call("pushRegister", {
                name: navigator.platform || "Browser",
                endpoint: sub.endpoint,
                keys: { p256dh: data.keys!.p256dh, auth: data.keys!.auth },
              });
              await q.refetch();
            })
          }
        >
          {t("Attiva su questo dispositivo", "Enable on this device")}
        </Button>
      ) : (
        <p>
          {t(
            "Questo browser non supporta Web Push.",
            "This browser does not support Web Push.",
          )}
        </p>
      )}
      {denied && (
        <Notice>
          {t(
            "Consenti le notifiche nelle impostazioni del browser.",
            "Allow notifications in your browser settings.",
          )}
        </Notice>
      )}
      {a.error && <Notice error>{a.error}</Notice>}
      {q.isPending ? (
        <Loading />
      ) : q.isError ? (
        <QueryError retry={() => void q.refetch()} />
      ) : (
        <ul className="library-entries">
          {q.data.devices.map((d) => (
            <li key={d.id}>
              {d.name}
              {d.current
                ? " · " + t("sessione corrente", "current session")
                : ""}
              {d.last_error && (
                <p>
                  {d.last_error === "retry_pending"
                    ? t(
                        "Consegna in attesa di un nuovo tentativo",
                        "Delivery will be retried",
                      )
                    : t(
                        "Consegna non riuscita. Riattiva il dispositivo.",
                        "Delivery failed. Re-enable this device.",
                      )}
                </p>
              )}
              <Button
                disabled={a.busy}
                onClick={() =>
                  void a.run(async () => {
                    await call("pushRevoke", { id: d.id });
                    if (d.current && supported) {
                      const r = await navigator.serviceWorker.getRegistration();
                      await (
                        await r?.pushManager.getSubscription()
                      )?.unsubscribe();
                    }
                    await q.refetch();
                  })
                }
              >
                {t("Revoca", "Revoke")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
