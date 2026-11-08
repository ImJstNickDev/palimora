import { IconButton } from "./library-ui";
import { Icon } from "./icons";
import { states } from "./reading";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Button, Modal, Notice } from "@palimora/ui";
import { transport, settleWrites } from "./api";
import { client, useAction, useText, Feedback } from "./shared";
import { LibraryHeading } from "./social";
import {
  listOffline,
  pendingOperations,
  downloadWork,
  removeOffline,
  clearCopies,
  checkUpdates,
  syncOffline,
  resolvePending,
  isDisconnected,
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
  const mib = bytes >= 1024 * 1024;
  return (
    new Intl.NumberFormat(document.documentElement.lang, {
      maximumFractionDigits: 1,
    }).format(bytes / (mib ? 1024 * 1024 : 1024)) + (mib ? " MiB" : " KiB")
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
  const saved = copies.data?.find(
    (w) => w.id === id && w.snapshot === snapshot,
  );
  useEffect(() => () => controller?.abort(), [controller]);
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
function Conflict({ item }: { item: Pending }) {
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
    enabled: open,
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
  return (
    <li>
      <strong>
        {item.operation === "readingSave"
          ? t("Progresso", "Progress")
          : t("Annotazione", "Annotation")}
      </strong>
      {" · "}
      <Link
        to={`/works/${item.input.id}?local=1&snapshot=${item.input.anchor.snapshot}`}
      >
        {t("Apri opera", "Open work")}
      </Link>
      <p>
        {item.error === "CONFLICT"
          ? t("Modifica concorrente", "Concurrent change")
          : t(
              "Permessi o contenuti cambiati",
              "Permissions or content changed",
            )}
      </p>
      <Button onClick={() => setOpen(true)}>{t("Risolvi", "Resolve")}</Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t("Confronta modifiche", "Compare changes")}
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
    action = useAction(t);
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
  const [remove, setRemove] = useState<OfflineWork | "all" | null>(null),
    [updating, setUpdating] = useState<OfflineWork | null>(null),
    [progress, setProgress] = useState<[number, number] | null>(null),
    [controller, setController] = useState<AbortController | null>(null);
  useEffect(() => () => controller?.abort(), [controller]);
  const refresh = async () => {
    await syncOffline(transport);
    await checkUpdates(transport);
  };
  useEffect(() => {
    if (!offline) void refresh().catch(() => {});
  }, [offline]);
  return (
    <section className="personal-library">
      <LibraryHeading
        title={<>{t("Lettura offline", "Offline reading")}</>}
        actions={
          <div className="library-controls">
            {availableInstall() && (
              <Button onClick={() => void action.run(installApp)}>
                {t("Installa Palimora", "Install Palimora")}
              </Button>
            )}
            <IconButton
              icon="refresh"
              label={t("Sincronizza", "Sync")}
              disabled={offline || action.busy}
              onClick={() => void action.run(refresh)}
            />
            {!!copies.data?.length && (
              <IconButton
                icon="trash"
                label={t("Rimuovi tutte le copie", "Remove all copies")}
                onClick={() => setRemove("all")}
              />
            )}
          </div>
        }
      />
      {!availableInstall() &&
        !matchMedia("(display-mode: standalone)").matches && (
          <details>
            <summary>
              {t("Installa sul dispositivo", "Install on device")}
            </summary>
            <p>
              {t(
                "Nel menu del browser scegli Installa applicazione oppure Aggiungi alla schermata Home.",
                "In your browser menu choose Install app or Add to Home Screen.",
              )}
            </p>
          </details>
        )}
      <p className="offline-storage">
        {t("Copie locali", "Local copies")}:{" "}
        {size(copies.data?.reduce((n, w) => n + w.bytes, 0) ?? 0)}
        {space.data?.estimate?.quota
          ? ` · ${t("Disponibile", "Available")}: ${size(Math.max(0, space.data.estimate.quota - (space.data.estimate.usage ?? 0)))}`
          : ""}
        {space.data?.persistent
          ? ` · ${t("Spazio persistente", "Persistent storage")}`
          : ""}
      </p>
      {space.data && !space.data.persistent && navigator.storage?.persist && (
        <Button
          onClick={() =>
            void action.run(async () => {
              const yes = await navigator.storage.persist();
              await space.refetch();
              action.setDone(
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
          {t("Richiedi spazio persistente", "Request persistent storage")}
        </Button>
      )}
      {!!queue.data?.length && (
        <section aria-label={t("Sincronizzazione", "Synchronization")}>
          <p role="status">
            {queue.data.length} {t("modifiche in attesa", "pending changes")}
          </p>
          <ul className="library-entries">
            {queue.data
              .filter((q) => q.error)
              .map((q) => {
                const latest = queue
                  .data!.filter(
                    (p) =>
                      p.operation === q.operation &&
                      (p.input.annotation_id ?? p.input.id) ===
                        (q.input.annotation_id ?? q.input.id),
                  )
                  .at(-1)!;
                return (
                  <Conflict key={q.key} item={{ ...latest, error: q.error }} />
                );
              })}
          </ul>
        </section>
      )}
      <Feedback action={action} />
      {updating && (
        <p role="status">
          {updating.title}{" "}
          <progress
            aria-label={t("Download offline", "Offline download")}
            value={progress?.[0] ?? 0}
            max={progress?.[1] ?? 4}
          />
          <Button onClick={() => controller?.abort()}>
            {t("Annulla", "Cancel")}
          </Button>
        </p>
      )}
      {copies.isError && (
        <Notice error>
          {t(
            "Archivio locale non disponibile in questo browser.",
            "Local storage is unavailable in this browser.",
          )}
        </Notice>
      )}
      {copies.data?.length === 0 && (
        <p>
          {t(
            "Nessuna opera salvata su questo dispositivo.",
            "No works saved on this device.",
          )}
        </p>
      )}
      <ul className="library-entries">
        {copies.data?.map((w) => (
          <li key={w.key} className="offline-entry">
            <h2>
              <Link
                className="offline-title"
                to={`/works/${w.id}?local=1&snapshot=${w.snapshot}`}
              >
                {w.title}
              </Link>
            </h2>
            <p className="library-entry-meta">
              {t("Salvata", "Saved")}{" "}
              {new Date(w.saved).toLocaleString(t("it", "en"))} ·{" "}
              {size(w.bytes)} · {w.snapshot.slice(0, 8)}
            </p>
            <div className="library-controls">
              {w.latest &&
                w.latest !== w.snapshot &&
                !copies.data?.some(
                  (copy) => copy.id === w.id && copy.snapshot === w.latest,
                ) && (
                  <Button
                    disabled={offline || !!updating}
                    onClick={() =>
                      void action.run(async () => {
                        const c = new AbortController();
                        setController(c);
                        setUpdating(w);
                        try {
                          await downloadWork(
                            w.id,
                            w.latest!,
                            transport,
                            (d, n) => setProgress([d, n]),
                            c.signal,
                          );
                        } finally {
                          setController(null);
                          setUpdating(null);
                          setProgress(null);
                        }
                      })
                    }
                  >
                    {t("Scarica nuova versione", "Download new version")}
                  </Button>
                )}
              <IconButton
                icon="trash"
                label={t("Rimuovi copia", "Remove copy")}
                disabled={!!updating}
                onClick={() => setRemove(w)}
              />
              {!offline && (
                <Link to={`/works/${w.id}`}>
                  {t("Versione corrente", "Current version")}
                </Link>
              )}
            </div>
          </li>
        ))}
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
            : t("Rimuovere questa copia offline?", "Remove this offline copy?")}
        </p>
        <Button
          tone="danger"
          disabled={action.busy}
          onClick={() =>
            void action.run(async () => {
              if (remove === "all") await clearCopies();
              else if (remove) await removeOffline(remove.key);
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
