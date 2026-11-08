import { libraryDestinations } from "./library-routes";
import { IconButton } from "./library-ui";
import { ActionMenu } from "./action-menu";
import { Icon } from "./icons";
import { useOffline } from "./offline-ui";
import {
  useState,
  useId,
  useRef,
  useLayoutEffect,
  useEffect,
  type ReactNode,
} from "react";
import { Link, useSearchParams, useLocation } from "react-router-dom";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Button, Notice, Select } from "@palimora/ui";
import type { Input, Output } from "@palimora/contracts";
import { call } from "./api";
import {
  client,
  useText,
  useAction,
  Loading,
  QueryError,
  errorText,
} from "./shared";
import { states } from "./reading";
import "./library.css";
import { LibrarySearchField } from "./library-search";
export function LibraryHeading({
  title,
  actions,
}: {
  title: ReactNode;
  actions?: ReactNode;
}) {
  const t = useText();
  return (
    <>
      <div className="catalog-heading">
        <div>
          <p className="eyebrow">
            {t("Biblioteca personale", "Personal library")}
          </p>
          <h1 tabIndex={-1}>{title}</h1>
        </div>
        {actions && <div className="library-heading-actions">{actions}</div>}
      </div>
      <SocialNav />
    </>
  );
}
export function SocialNav() {
  const t = useText();
  const { offline } = useOffline();
  const location = useLocation();
  const list = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({
    overflow: false,
    start: true,
    end: true,
  });
  const measure = () => {
    const el = list.current;
    if (el)
      setEdges({
        overflow: el.scrollWidth > el.clientWidth + 1,
        start: el.scrollLeft < 2,
        end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 2,
      });
  };
  const revealCurrent = () => {
    const el = list.current,
      active = el?.querySelector<HTMLElement>('[aria-current="page"]');
    if (el && active) {
      const r = active.getBoundingClientRect(),
        container = el.getBoundingClientRect();
      if (r.left < container.left) el.scrollLeft += r.left - container.left;
      else if (r.right > container.right)
        el.scrollLeft += r.right - container.right;
    }
    measure();
  };
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const observer = new ResizeObserver(revealCurrent);
    observer.observe(el);
    revealCurrent();
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(revealCurrent, [location.pathname, offline, edges.overflow]);
  const scroll = (direction: number) =>
    list.current?.scrollBy({
      left: direction * list.current.clientWidth * 0.75,
    });
  return (
    <nav
      className="personal-navigation"
      aria-label={t("Biblioteca personale", "Personal library")}
    >
      {edges.overflow && (
        <IconButton
          label={t("Sezioni precedenti", "Previous sections")}
          icon="back"
          disabled={edges.start}
          onClick={() => scroll(-1)}
        />
      )}
      <div className="personal-tab-list" ref={list} onScroll={measure}>
        {libraryDestinations
          .filter(([to]) => !offline || to === "/library/offline")
          .map(([to, it, en]) => {
            const active =
              location.pathname === to ||
              (to !== "/library" && location.pathname.startsWith(to + "/"));
            return (
              <Link
                key={to}
                to={to}
                className={active ? "active" : undefined}
                aria-current={active ? "page" : undefined}
              >
                {t(it, en)}
              </Link>
            );
          })}
      </div>
      {edges.overflow && (
        <IconButton
          label={t("Altre sezioni", "More sections")}
          icon="next"
          disabled={edges.end}
          onClick={() => scroll(1)}
        />
      )}
    </nav>
  );
}

export function Follow({
  kind,
  target,
  compact = false,
}: {
  kind: Input<"subscriptionSave">["kind"];
  target: string;
  compact?: boolean;
}) {
  const t = useText(),
    action = useAction(t),
    group = useId();
  const [saved, setSaved] = useState(false),
    [pendingMode, setPendingMode] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["subscription", kind, target],
    queryFn: () => call("subscriptionStatus", { kind, target }),
  });
  if (q.isPending) return null;
  if (q.isError) return <QueryError retry={() => void q.refetch()} />;
  const options = [
    {
      value: "",
      label: t("Non seguire", "Not following"),
      hint: t(
        "Nessuna notifica per questa sottoscrizione",
        "No notifications for this subscription",
      ),
    },
    {
      value: "chapters",
      label: t("Nuove opere e capitoli", "New works and chapters"),
      hint: t(
        "Ricevi gli aggiornamenti sui nuovi contenuti",
        "Get updates when new content is added",
      ),
    },
    {
      value: "changes",
      label: t("Anche modifiche al testo", "Include text changes"),
      hint: t(
        "Includi le revisioni dei contenuti esistenti",
        "Also include revisions to existing content",
      ),
    },
  ] as const;
  return (
    <ActionMenu
      label={t("Sottoscrizione", "Subscription")}
      icon="bell"
      compact={compact}
      active={!!q.data.mode}
    >
      {() => (
        <div className="subscription-menu">
          <fieldset
            className="action-menu-options"
            aria-label={t("Aggiornamenti da ricevere", "Updates to receive")}
            disabled={action.busy}
          >
            {options.map((option) => (
              <label key={option.value} className="action-menu-option">
                <input
                  type="radio"
                  name={group}
                  value={option.value}
                  checked={(pendingMode ?? q.data.mode ?? "") === option.value}
                  onChange={() =>
                    void action.run(async () => {
                      setSaved(false);
                      setPendingMode(option.value);
                      try {
                        await call("subscriptionSave", {
                          kind,
                          target,
                          mode: option.value || null,
                        });
                        await q.refetch();
                        await client.invalidateQueries({
                          queryKey: ["subscriptions"],
                        });
                        setSaved(true);
                      } finally {
                        setPendingMode(null);
                      }
                    })
                  }
                />
                <span>
                  <span>{option.label}</span>
                  <small>{option.hint}</small>
                </span>
                <Icon name="check" />
              </label>
            ))}
          </fieldset>
          {action.busy ? (
            <p className="action-menu-feedback" role="status">
              {t("Salvataggio…", "Saving…")}
            </p>
          ) : (
            saved && (
              <p className="action-menu-feedback" role="status">
                {t("Preferenza salvata", "Preference saved")}
              </p>
            )
          )}
          {action.error && <Notice error>{action.error}</Notice>}
        </div>
      )}
    </ActionMenu>
  );
}
export function Recommend({
  work,
  compact = false,
}: {
  work: string;
  compact?: boolean;
}) {
  const t = useText();
  return (
    <ActionMenu
      label={t("Consiglia", "Recommend")}
      title={t("Consiglia opera", "Recommend work")}
      icon="share"
      compact={compact}
    >
      {(close) => <RecommendationEditor work={work} onDone={close} />}
    </ActionMenu>
  );
}
function RecommendationEditor({
  work,
  onDone,
}: {
  work: string;
  onDone: () => void;
}) {
  const t = useText();
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<
    Map<
      string,
      {
        requestId: string;
        sent?: boolean;
        error?: string;
      }
    >
  >(() => new Map());
  const recipients = useInfiniteQuery({
    queryKey: ["recommendation-recipients", search.trim()],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      call("recommendationRecipients", {
        q: search.trim(),
        cursor: pageParam,
      }),
    getNextPageParam: (page) => page.next ?? undefined,
  });
  const chosen = [...selected.keys()];
  const pending = chosen.filter((name) => !selected.get(name)!.sent);
  const sent = chosen.length - pending.length;
  const failed = pending.some((name) => selected.get(name)!.error);
  // Keep selections visible even when filtering or loading another page.
  const names = [
    ...new Set([
      ...chosen,
      ...(recipients.data?.pages.flatMap((page) =>
        page.items.map((u) => u.username),
      ) ?? []),
    ]),
  ];
  async function send() {
    if (busy || !pending.length) return;
    setBusy(true);
    try {
      for (const username of pending) {
        setSelected((old) =>
          new Map(old).set(username, {
            ...old.get(username)!,
            error: undefined,
          }),
        );
        try {
          await call("recommendWork", {
            work,
            requestId: selected.get(username)!.requestId,
            username,
          });
          setSelected((old) =>
            new Map(old).set(username, { ...old.get(username)!, sent: true }),
          );
        } catch (e) {
          setSelected((old) =>
            new Map(old).set(username, {
              ...old.get(username)!,
              error: errorText(e, t),
            }),
          );
        }
      }
    } finally {
      setBusy(false);
    }
  }
  if (sent > 0 && pending.length === 0 && !busy)
    return (
      <div className="action-menu-form">
        <div className="action-menu-success" role="status">
          <Icon name="check" />
          <span>{t("Consiglio inviato.", "Recommendation sent.")}</span>
        </div>
        <p className="action-menu-hint">{chosen.join(", ")}</p>
        <div className="action-menu-form-actions">
          <Button autoFocus onClick={onDone}>
            {t("Fatto", "Done")}
          </Button>
        </div>
      </div>
    );
  return (
    <form
      className="recommendation-picker"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <div className="recommendation-search">
        <LibrarySearchField
          label={t("Cerca utenti", "Search users")}
          value={search}
          maxLength={100}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <fieldset
        className="action-menu-options recommendation-recipients"
        disabled={busy}
      >
        <legend className="sr-only">{t("Destinatari", "Recipients")}</legend>
        {names.map((username) => (
          <label key={username} className="action-menu-option">
            <input
              type="checkbox"
              checked={selected.has(username)}
              disabled={selected.get(username)?.sent}
              onChange={(e) => {
                const checked = e.target.checked;
                setSelected((old) => {
                  const next = new Map(old);
                  if (checked)
                    next.set(username, { requestId: crypto.randomUUID() });
                  else next.delete(username);
                  return next;
                });
              }}
            />
            <span>
              <span>{username}</span>
              {selected.get(username)?.sent && (
                <small>{t("Inviato", "Sent")}</small>
              )}
              {selected.get(username)?.error && (
                <small className="recipient-error">
                  {selected.get(username)?.error}
                </small>
              )}
            </span>
            <Icon name="check" />
          </label>
        ))}
        {recipients.isPending && <Loading />}
        {recipients.isError && (
          <QueryError retry={() => void recipients.refetch()} />
        )}
        {recipients.isSuccess && !names.length && (
          <p className="action-menu-empty">
            {search.trim()
              ? t("Nessun utente trovato.", "No users found.")
              : t(
                  "Nessun destinatario disponibile.",
                  "No recipients available.",
                )}
          </p>
        )}
        {recipients.hasNextPage && (
          <Button
            type="button"
            disabled={recipients.isFetchingNextPage}
            onClick={() => void recipients.fetchNextPage()}
          >
            {t("Mostra altri", "Show more")}
          </Button>
        )}
      </fieldset>
      <div className="recommendation-footer">
        <p className="action-menu-hint" role="status">
          {busy
            ? t("Invio…", "Sending…")
            : sent > 0
              ? t(
                  `${sent} ${sent === 1 ? "inviato" : "inviati"} · ${pending.length} da inviare`,
                  `${sent} sent · ${pending.length} remaining`,
                )
              : pending.length > 0
                ? t(
                    `${pending.length} ${pending.length === 1 ? "selezionato" : "selezionati"}`,
                    `${pending.length} selected`,
                  )
                : t("Seleziona i destinatari", "Select recipients")}
        </p>
        <Button type="submit" tone="primary" disabled={busy || !pending.length}>
          {failed ? t("Riprova", "Retry") : t("Invia", "Send")}
        </Button>
      </div>
    </form>
  );
}

export function Statistics() {
  const t = useText();
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    if (params.has("username")) {
      const next = new URLSearchParams(params);
      next.delete("username");
      setParams(next, { replace: true });
    }
  }, [params, setParams]);
  return (
    <section className="personal-library">
      <LibraryHeading
        title={t("Statistiche di lettura", "Reading statistics")}
      />
      <StatisticsContent />
    </section>
  );
}
export function StatisticsContent({ userId }: { userId?: string }) {
  const t = useText();
  const q = useQuery({
    queryKey: userId ? ["admin-user-statistics", userId] : ["statistics"],
    queryFn: () =>
      userId
        ? call("userStatistics", { id: userId })
        : call("personalStatistics", {}),
  });
  if (q.isPending) return <Loading />;
  if (q.isError) return <QueryError retry={() => void q.refetch()} />;
  return (
    <div className="statistics-content">
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
            new Date(q.data.measured_since).toLocaleDateString(t("it", "en"))}
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
      {q.data.timeline.length > 0 && (
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
      )}
      {!q.data.timeline.length && (
        <p>
          {t("Nessun completamento registrato.", "No completions recorded.")}
        </p>
      )}
    </div>
  );
}

export function Activity() {
  const t = useText();
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    if (params.has("username")) {
      const next = new URLSearchParams(params);
      next.delete("username");
      setParams(next, { replace: true });
    }
  }, [params, setParams]);
  const q = useInfiniteQuery({
    queryKey: ["activity"],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => call("personalActivity", { cursor: pageParam }),
    getNextPageParam: (p) => p.next ?? undefined,
  });
  return (
    <section className="personal-library">
      <LibraryHeading
        title={<>{t("Attività di lettura", "Reading activity")}</>}
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
                    <h2>
                      <Link to={"/works/" + w.id}>{w.title}</Link>
                    </h2>
                    <p className="library-entry-meta">
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
      <LibraryHeading title={<>{t("Sottoscrizioni", "Subscriptions")}</>} />
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
                <li key={s.kind + s.target} className="library-row">
                  <h2>
                    <Link
                      to={
                        s.kind === "work"
                          ? "/works/" + s.target
                          : "/bibliography/" + s.kind + "/" + s.target
                      }
                    >
                      {s.name}
                    </Link>
                  </h2>
                  <Follow kind={s.kind} target={s.target} compact />
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
    [params, setParams] = useSearchParams();
  const [unread, setUnread] = useState(params.get("unread") === "true");
  useEffect(() => setUnread(params.get("unread") === "true"), [params]);
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
      <LibraryHeading
        title={
          <>
            {t("Notifiche", "Notifications")}
            {q.data ? " · " + q.data.pages[0].unread : ""}
          </>
        }
      />
      <label className="check">
        <input
          type="checkbox"
          checked={unread}
          onChange={(e) => {
            const checked = e.target.checked;
            setUnread(checked);
            setParams(checked ? { unread: "true" } : {});
          }}
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
                <li
                  key={n.id}
                  className={
                    n.read_at
                      ? "notification-entry"
                      : "notification-entry unread"
                  }
                >
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
                    <IconButton
                      icon={n.read_at ? "mail" : "check"}
                      label={
                        n.read_at
                          ? t("Segna non letta", "Mark unread")
                          : t("Segna letta", "Mark read")
                      }
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
                    />
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
      <LibraryHeading
        title={<>{t("Privacy e notifiche", "Privacy and notifications")}</>}
      />
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
          });
          setP(updated);
          setSaved(true);
          client.setQueryData(["social-settings"], updated);
        });
      }}
    >
      <h2>{t("Visibilità", "Visibility")}</h2>
      {(["activity"] as const).map((scope) => (
        <fieldset key={scope}>
          <legend>{t("Attività di lettura", "Reading activity")}</legend>
          <Select
            label={t("Visibile a", "Visible to")}
            value={p[scope]}
            onChange={(e) =>
              setP({ ...p, [scope]: e.target.value as typeof p.activity })
            }
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
