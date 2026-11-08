import { ActionMenu } from "./action-menu";
import { IconButton } from "./library-ui";
import { Icon } from "./icons";
import { states } from "./reading";
import { useContext, useEffect, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Button, Modal, Notice } from "@palimora/ui";
import { transport, settleWrites } from "./api";
import {
  Auth,
  client,
  useAction,
  useText,
  Feedback,
  errorText,
  Loading,
  QueryError,
} from "./shared";
import { LibraryHeading } from "./social";
import {
  listOffline,
  pendingOperations,
  downloadWork,
  clearCopies,
  checkUpdates,
  syncOffline,
  resolvePending,
  isDisconnected,
  isSyncingOffline,
  type Pending,
  type OfflineCopy as OfflineWork,
} from "./offline";
import {
  activateUpdate,
  availableInstall,
  availableUpdate,
  appReady,
  installApp,
} from "./pwa";
import "./offline.css";
let revision = 0;
const listeners = new Set<() => void>();
const update = () => {
  revision++;
  for (const listener of listeners) listener();
  for (const key of ["offline-list", "offline-queue", "offline-space"])
    void client.invalidateQueries({ queryKey: [key] });
};
window.addEventListener("offline-change", update);
window.addEventListener("pwa-change", update);
window.addEventListener("offline-sync", update);
export function useOffline() {
  const version = useSyncExternalStore(
    (callback) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
    () => revision,
  );
  return { offline: isDisconnected(), version };
}

function size(bytes: number) {
  const value = Math.max(0, Number.isFinite(bytes) ? bytes : 0);
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const unit =
    value > 0
      ? Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)))
      : 0;
  return (
    new Intl.NumberFormat(document.documentElement.lang, {
      maximumFractionDigits: 1,
    }).format(value / 1024 ** unit) +
    " " +
    units[unit]
  );
}
export function OfflineRuntime() {
  const t = useText(),
    { offline } = useOffline(),
    action = useAction(t);
  useEffect(() => {
    let busy = false;
    const run = async (updates = false) => {
      if (busy || !navigator.onLine) return;
      busy = true;
      try {
        await syncOffline(transport);
        if (updates) await checkUpdates(transport);
        for (const key of ["reading", "annotations", "library", "offline-list"])
          void client.invalidateQueries({ queryKey: [key] });
      } catch {
        /* The durable queue and its explicit retry remain available. */
      } finally {
        busy = false;
      }
    };
    const pending = async () => {
      try {
        if ((await pendingOperations()).length) await run();
      } catch {}
    };
    const online = () => void run(true);
    void run(true);
    window.addEventListener("online", online);
    const timer = window.setInterval(pending, 15000);
    return () => {
      window.removeEventListener("online", online);
      clearInterval(timer);
    };
  }, []);
  return (
    <>
      {(offline || availableUpdate()) && (
        <div className="offline-banner" role="status">
          {offline && (
            <Link to="/library/offline">
              {t("Offline · Opere salvate", "Offline · Saved works")}
            </Link>
          )}
          {availableUpdate() && (
            <Button
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  window.dispatchEvent(new Event("pagehide"));
                  await settleWrites();
                  activateUpdate();
                })
              }
            >
              {t("Aggiorna applicazione", "Update application")}
            </Button>
          )}
        </div>
      )}
      <Feedback action={action} />
    </>
  );
}
export function OfflineSave({
  id,
  snapshot,
  compact = false,
}: {
  id: string;
  snapshot: string;
  compact?: boolean;
}) {
  const t = useText(),
    { offline } = useOffline(),
    action = useAction(t);
  const [progress, setProgress] = useState<[number, number] | null>(null),
    [controller, setController] = useState<AbortController | null>(null);
  const copies = useQuery({
    queryKey: ["offline-list"],
    queryFn: listOffline,
  });
  const impersonating = useContext(Auth)?.impersonating;
  const saved = copies.data?.find(
    (w) => w.id === id && w.snapshot === snapshot,
  );
  useEffect(() => () => controller?.abort(), [controller]);
  if (impersonating) return null;
  return (
    <div className="library-controls offline-controls">
      {saved ? (
        <Link
          className={
            compact ? "button reader-icon-action saved-offline" : undefined
          }
          title={t("Copia offline", "Offline copy") + " · " + size(saved.bytes)}
          to={`/works/${id}?local=1&snapshot=${snapshot}`}
        >
          {compact && <Icon name="check" />}
          <span className={compact ? "sr-only" : undefined}>
            {t("Copia offline", "Offline copy")} · {size(saved.bytes)}
          </span>
        </Link>
      ) : (
        <Button
          className={compact ? "button reader-icon-action" : "button"}
          title={t("Salva offline", "Save offline")}
          disabled={offline || action.busy}
          onClick={() =>
            void action.run(async () => {
              await appReady();
              const c = new AbortController();
              setController(c);
              setProgress([0, 4]);
              try {
                await downloadWork(
                  id,
                  snapshot,
                  transport,
                  (done, total) => setProgress([done, total]),
                  c.signal,
                );
              } finally {
                setController(null);
                setProgress(null);
              }
            })
          }
        >
          {compact && <Icon name="download" />}
          <span className={compact ? "sr-only" : undefined}>
            {t("Salva offline", "Save offline")}
          </span>
        </Button>
      )}
      {progress && (
        <>
          <progress
            aria-label={t("Download offline", "Offline download")}
            value={progress[0]}
            max={progress[1]}
          />
          <span>
            {Math.floor(progress[0])}/{progress[1]}
          </span>
          <Button onClick={() => controller?.abort()}>
            {t("Annulla", "Cancel")}
          </Button>
        </>
      )}
      <Feedback action={action} />
    </div>
  );
}
function Conflict({
  item,
  title,
  local,
}: {
  item: Pending;
  title?: string;
  local: boolean;
}) {
  const { offline } = useOffline();
  const stateLabel = (value: string) => {
    const state = states.find((s) => s[0] === value);
    return state ? t(state[1], state[2]) : value;
  };
  const t = useText(),
    action = useAction(t),
    [open, setOpen] = useState(false),
    [privateCopy, setPrivateCopy] = useState(false);
  const remote = useQuery({
    queryKey: ["offline-conflict", item.key],
    enabled: open && !offline,
    queryFn: async () => {
      if (item.operation === "readingSave") {
        const p = await transport("readingProgress", { id: item.input.id });
        return `${stateLabel(p.state)} · ${Math.round(p.percent)}%`;
      }
      let cursor: string | undefined;
      do {
        const page = await transport("annotationList", {
          id: item.input.id,
          cursor,
        });
        const note = page.items.find((n) => n.id === item.input.annotation_id);
        if (note) return note.body;
        cursor = page.next ?? undefined;
      } while (cursor);
      return t(
        "Annotazione eliminata o non accessibile.",
        "Annotation deleted or unavailable.",
      );
    },
  });
  const work = useQuery({
    queryKey: ["offline-conflict-title", item.input.id],
    enabled: !title && !offline,
    queryFn: () => transport("readerWork", { id: item.input.id }),
  });
  const workTitle =
    title ??
    (work.data
      ? Array.isArray(work.data.metadata.title)
        ? work.data.metadata.title.join(" · ")
        : String(work.data.metadata.title ?? work.data.work.external_id ?? "")
      : undefined) ??
    t(
      "Opera non disponibile sul dispositivo",
      "Work unavailable on this device",
    );
  return (
    <li>
      <strong>
        {item.operation === "readingSave"
          ? t("Progresso", "Progress")
          : t("Annotazione", "Annotation")}
      </strong>
      {" · "}
      <Link
        to={
          local
            ? `/works/${item.input.id}?local=1&snapshot=${item.input.anchor.snapshot}`
            : `/works/${item.input.id}`
        }
        aria-disabled={(!local && offline) || undefined}
        onClick={(e) => {
          if (!local && offline) e.preventDefault();
        }}
      >
        {workTitle}
      </Link>
      <p>
        {item.error === "CONFLICT"
          ? t("Modifica concorrente", "Concurrent change")
          : t(
              "Permessi o contenuti cambiati",
              "Permissions or content changed",
            )}
      </p>
      <Button disabled={offline} onClick={() => setOpen(true)}>
        {t("Risolvi", "Resolve")}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t("Confronta modifiche", "Compare changes") + " · " + workTitle}
        closeLabel={t("Chiudi", "Close")}
      >
        <h3>{t("Su questo dispositivo", "On this device")}</h3>
        <p className="bookmark-notes">
          {item.input.body ?? stateLabel(item.input.state)}
        </p>
        <blockquote>{item.input.anchor.quote}</blockquote>
        <h3>{t("Sul server", "On the server")}</h3>
        <p className="bookmark-notes">
          {remote.isPending
            ? t("Caricamento…", "Loading…")
            : remote.isError
              ? t("Connessione non disponibile.", "Connection unavailable.")
              : remote.data}
        </p>
        {item.operation === "annotationSave" && (
          <label className="checkbox">
            <input
              type="checkbox"
              checked={privateCopy}
              onChange={(e) => setPrivateCopy(e.target.checked)}
            />
            {t(
              "Conserva come nuova annotazione privata",
              "Keep as a new private annotation",
            )}
          </label>
        )}
        <div className="library-controls">
          <Button
            disabled={action.busy || remote.isPending || remote.isError}
            onClick={() =>
              void action.run(async () => {
                await resolvePending(item, true, transport, privateCopy);
                setOpen(false);
              })
            }
          >
            {t("Mantieni modifica locale", "Keep local change")}
          </Button>
          <Button
            disabled={action.busy || remote.isPending || remote.isError}
            onClick={() =>
              void action.run(async () => {
                await resolvePending(item, false, transport);
                setOpen(false);
              })
            }
          >
            {t("Usa quella sul server", "Use server version")}
          </Button>
        </div>
        <Feedback action={action} />
      </Modal>
    </li>
  );
}
export function OfflineLibrary() {
  const t = useText(),
    { offline } = useOffline(),
    action = useAction(t),
    deviceAction = useAction(t);
  const supported =
    import.meta.env.PROD &&
    window.isSecureContext &&
    "serviceWorker" in navigator;
  const copies = useQuery({
    queryKey: ["offline-list"],
    queryFn: listOffline,
  });
  const queue = useQuery({
    queryKey: ["offline-queue"],
    queryFn: pendingOperations,
  });
  const space = useQuery({
    queryKey: ["offline-space"],
    queryFn: async () => ({
      estimate: await navigator.storage?.estimate(),
      persistent: await navigator.storage?.persisted?.(),
    }),
  });
  const [remove, setRemove] = useState<OfflineWork | "all" | null>(null);
  const [checking, setChecking] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const refresh = async () => {
    setChecking(true);
    setSyncError(null);
    try {
      await syncOffline(transport);
      if (!isDisconnected()) await checkUpdates(transport);
    } catch (e) {
      setSyncError(errorText(e, t));
    } finally {
      setChecking(false);
    }
  };
  useEffect(() => {
    if (!offline) void refresh();
  }, [offline]);
  const conflicts = new Map<string, Pending>();
  for (const q of queue.data ?? []) {
    const key = q.operation + ":" + (q.input.annotation_id ?? q.input.id);
    const previous = conflicts.get(key);
    if (q.error || previous)
      conflicts.set(key, { ...q, error: q.error ?? previous?.error });
  }
  const syncing = isSyncingOffline();
  const groups = new Map<string, OfflineWork[]>();
  for (const copy of copies.data ?? [])
    groups.set(copy.id, [...(groups.get(copy.id) ?? []), copy]);
  return (
    <section className="personal-library">
      <LibraryHeading
        title={<>{t("Lettura offline", "Offline reading")}</>}
        actions={
          <div className="library-controls">
            <IconButton
              icon="refresh"
              label={t("Sincronizza", "Sync")}
              disabled={offline || action.busy || syncing || checking}
              onClick={() => void refresh()}
            />
            <ActionMenu
              compact
              icon="settings"
              label={t("Gestisci dispositivo", "Manage device")}
            >
              {(close) => (
                <div className="offline-device-settings">
                  {supported && availableInstall() && (
                    <Button onClick={() => void deviceAction.run(installApp)}>
                      {t("Installa Palimora", "Install Palimora")}
                    </Button>
                  )}
                  {supported &&
                    !availableInstall() &&
                    !matchMedia("(display-mode: standalone)").matches && (
                      <details>
                        <summary>
                          {t("Installa sul dispositivo", "Install on device")}
                        </summary>
                        <p>
                          {t(
                            "Se il browser lo supporta, dal suo menu puoi installare Palimora o aggiungerla alla schermata Home. Le copie salvate si leggono anche dal browser.",
                            "If your browser supports it, install Palimora or add it to your Home Screen from its menu. Saved copies also work in the browser.",
                          )}
                        </p>
                      </details>
                    )}
                  <dl className="offline-storage-details">
                    <dt>{t("Copie salvate", "Saved copies")}</dt>
                    <dd>
                      {copies.isSuccess
                        ? size(copies.data.reduce((n, w) => n + w.bytes, 0))
                        : "—"}
                    </dd>
                    <dt>
                      {t(
                        "Spazio usato dal sito · stima",
                        "Site storage used · estimate",
                      )}
                    </dt>
                    <dd>
                      {space.data?.estimate?.usage !== undefined
                        ? size(space.data.estimate.usage)
                        : t("Non disponibile", "Unavailable")}
                    </dd>
                    <dt>
                      {t(
                        "Quota assegnata dal browser · stima",
                        "Browser storage quota · estimate",
                      )}
                    </dt>
                    <dd>
                      {space.data?.estimate?.quota !== undefined
                        ? size(space.data.estimate.quota)
                        : t("Non disponibile", "Unavailable")}
                    </dd>
                  </dl>
                  <p className="action-menu-hint">
                    {t(
                      "La quota del browser può cambiare e non indica lo spazio libero del dispositivo.",
                      "The browser quota can change and does not indicate free device storage.",
                    )}
                  </p>
                  {space.isPending && <Loading />}
                  {space.isError && (
                    <QueryError retry={() => void space.refetch()} />
                  )}
                  {space.data?.persistent === true && (
                    <p>
                      {t(
                        "Conservazione persistente attiva",
                        "Persistent storage enabled",
                      )}
                    </p>
                  )}
                  {space.data?.persistent === undefined && space.isSuccess && (
                    <p className="action-menu-hint">
                      {t(
                        "Questo browser non comunica lo stato di conservazione delle copie.",
                        "This browser does not report copy persistence status.",
                      )}
                    </p>
                  )}
                  {space.data &&
                    !space.data.persistent &&
                    navigator.storage?.persist && (
                      <Button
                        disabled={deviceAction.busy}
                        onClick={() =>
                          void deviceAction.run(async () => {
                            const yes = await navigator.storage.persist();
                            await space.refetch();
                            deviceAction.setDone(
                              yes
                                ? t(
                                    "Spazio persistente attivato.",
                                    "Persistent storage enabled.",
                                  )
                                : t(
                                    "Il browser può liberare le copie locali quando lo spazio scarseggia.",
                                    "The browser may remove local copies when storage is low.",
                                  ),
                            );
                          })
                        }
                      >
                        {t(
                          "Richiedi conservazione delle copie",
                          "Request persistent storage",
                        )}
                      </Button>
                    )}
                  {!!copies.data?.length && (
                    <button
                      className="action-menu-item"
                      disabled={action.busy}
                      onClick={() => {
                        close();
                        setRemove("all");
                      }}
                    >
                      <Icon name="trash" />
                      <span>
                        {t("Rimuovi tutte le copie", "Remove all copies")}
                      </span>
                    </button>
                  )}
                  <Feedback action={deviceAction} />
                </div>
              )}
            </ActionMenu>
          </div>
        }
      />
      {(syncing ||
        checking ||
        !!queue.data?.length ||
        queue.isError ||
        syncError) && (
        <section
          className="offline-sync-status"
          aria-label={t("Sincronizzazione", "Synchronization")}
        >
          <p role="status">
            {syncing
              ? t("Sincronizzazione in corso…", "Synchronizing…")
              : checking
                ? t("Controllo aggiornamenti…", "Checking for updates…")
                : queue.data?.length
                  ? `${queue.data.length} ${offline ? t("modifiche in attesa di connessione", "changes waiting for connection") : t("modifiche da sincronizzare", "changes waiting to sync")}`
                  : null}
          </p>
          {syncError && <Notice error>{syncError}</Notice>}
          {queue.isError && <QueryError retry={() => void queue.refetch()} />}
          {conflicts.size > 0 && (
            <>
              <p>
                {conflicts.size}{" "}
                {t("modifiche da risolvere", "changes to resolve")}
              </p>
              <ul className="library-entries">
                {[...conflicts.values()].map((item) => (
                  <Conflict
                    key={item.key}
                    item={item}
                    title={groups.get(item.input.id)?.[0].title}
                    local={
                      !!groups
                        .get(item.input.id)
                        ?.some((w) => w.snapshot === item.input.anchor.snapshot)
                    }
                  />
                ))}
              </ul>
            </>
          )}
        </section>
      )}
      <Feedback action={action} />
      {!supported && copies.data?.length === 0 && (
        <p className="offline-availability">
          {import.meta.env.DEV
            ? t(
                "Su questo indirizzo il salvataggio offline non è disponibile.",
                "Offline saving is not available at this address.",
              )
            : t(
                "Questo browser non supporta il salvataggio offline su questo indirizzo.",
                "This browser does not support offline saving at this address.",
              )}
        </p>
      )}
      {copies.isPending && <Loading />}
      {copies.isError && (
        <>
          <Notice error>
            {t(
              "Archivio locale non disponibile in questo browser.",
              "Local storage is unavailable in this browser.",
            )}
          </Notice>
          <Button onClick={() => void copies.refetch()}>
            {t("Riprova", "Retry")}
          </Button>
        </>
      )}
      {copies.isSuccess && copies.data.length === 0 && (
        <div className="offline-empty">
          <p>
            {t(
              "Nessuna opera salvata su questo dispositivo.",
              "No works saved on this device.",
            )}
          </p>
          {supported && (
            <p className="muted">
              {offline
                ? t(
                    "Connettiti per salvare nuove opere. Le copie sono disponibili solo sul dispositivo e nel browser in cui le hai scaricate.",
                    "Connect to save new works. Copies are only available on the device and browser where you downloaded them.",
                  )
                : t(
                    "Apri un’opera e scegli Salva offline per leggerla anche senza connessione.",
                    "Open a work and choose Save offline to read it without a connection.",
                  )}
            </p>
          )}
          {!offline && (
            <Link to="/library">
              {t("Vai alle opere salvate", "Go to saved works")}
            </Link>
          )}
        </div>
      )}
      <ul className="library-entries offline-works">
        {[...groups.values()].map((versions) => {
          const preferred =
            versions.find((w) => w.snapshot === w.latest) ?? versions[0];
          return (
            <li key={preferred.id} className="offline-entry">
              <h2>
                <Link
                  className="offline-title"
                  to={`/works/${preferred.id}?local=1&snapshot=${preferred.snapshot}`}
                >
                  {preferred.title}
                </Link>
              </h2>
              <IconButton
                icon="trash"
                label={t("Rimuovi dal dispositivo", "Remove from device")}
                disabled={action.busy}
                onClick={() => setRemove(preferred)}
              />
            </li>
          );
        })}
      </ul>
      <Modal
        open={!!remove}
        onClose={() => setRemove(null)}
        title={t("Rimuovi dal dispositivo", "Remove from device")}
        closeLabel={t("Chiudi", "Close")}
      >
        <p>
          {remove === "all"
            ? t(
                "Rimuovere tutte le opere salvate offline?",
                "Remove all offline works?",
              )
            : t(
                "Rimuovere quest’opera dal dispositivo? Tutte le sue copie offline verranno eliminate.",
                "Remove this work from the device? All its offline copies will be deleted.",
              )}
          {remove && remove !== "all" && (
            <strong className="offline-remove-target">{remove.title}</strong>
          )}
        </p>
        <Button
          tone="danger"
          disabled={action.busy}
          onClick={() =>
            void action.run(async () => {
              if (remove === "all") await clearCopies();
              else if (remove) await clearCopies(remove.id);
              setRemove(null);
            })
          }
        >
          {t("Rimuovi", "Remove")}
        </Button>
        <Feedback action={action} />
      </Modal>
    </section>
  );
}
