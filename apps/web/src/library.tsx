import { IconButton } from "./library-ui";
import { ActionMenu } from "./action-menu";
import { Icon } from "./icons";
import { LibraryHeading, Follow, Recommend } from "./social";
import { states } from "./reading";
import { CollectionChoices } from "./collections";
import { useState, useRef, useLayoutEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Button, Notice } from "@palimora/ui";
import type { Output } from "@palimora/contracts";
import { call, ApiFailure } from "./api";
import { client, useText, useAction, Loading, QueryError } from "./shared";
import "./library.css";
import { LibrarySearchField } from "./library-search";

type Entry = Output<"libraryWork">;
async function refreshLibrary(id: string) {
  await Promise.all([
    client.invalidateQueries({ queryKey: ["library"] }),
    client.invalidateQueries({ queryKey: ["library-work", id] }),
  ]);
}
export function Library({
  kind = "bookmarks",
}: {
  kind?: "bookmarks" | "later" | "history";
}) {
  const t = useText();
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "",
    tag = params.get("tag") ?? "";
  const list = useInfiniteQuery({
    queryKey: ["library", kind, q, tag],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      call("libraryList", { kind, q, tag, cursor: pageParam }),
    getNextPageParam: (p) => p.next ?? undefined,
  });
  return (
    <section className="personal-library">
      <LibraryHeading
        title={
          kind === "history"
            ? t("Cronologia", "History")
            : kind === "later"
              ? t("Da leggere più tardi", "Marked for Later")
              : t("Opere salvate", "Saved works")
        }
      />
      <form
        key={kind + q + tag}
        className="catalog-searchbar personal-search"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const next = new URLSearchParams();
          for (const k of ["q", "tag"]) {
            const v = String(f.get(k) ?? "").trim();
            if (v) next.set(k, v);
          }
          setParams(next);
        }}
      >
        <LibrarySearchField
          label={t("Titolo o note", "Title or notes")}
          name="q"
          defaultValue={q}
          maxLength={200}
        />
        {kind === "bookmarks" && (
          <LibrarySearchField
            label={t("Tag personale", "Personal tag")}
            name="tag"
            defaultValue={tag}
            maxLength={100}
          />
        )}
        <IconButton
          type="submit"
          tone="primary"
          icon="search"
          label={t("Filtra", "Filter")}
        />
        {(q || tag) && (
          <Link
            className="button icon-button"
            to={kind === "bookmarks" ? "/library" : "/library/" + kind}
            aria-label={t("Azzera filtri", "Clear filters")}
            title={t("Azzera filtri", "Clear filters")}
          >
            <Icon name="close" />
          </Link>
        )}
      </form>
      {list.isPending ? (
        <Loading />
      ) : list.isError ? (
        <QueryError retry={() => void list.refetch()} />
      ) : (
        <>
          {!list.data.pages[0].items.length && (
            <p>
              {t("Nessuna opera in questo elenco.", "No works in this list.")}
            </p>
          )}
          <ul className="library-entries">
            {list.data.pages
              .flatMap((p) => p.items)
              .map((entry) => (
                <LibraryRow
                  key={entry.work_id}
                  entry={entry}
                  history={kind === "history"}
                />
              ))}
          </ul>
          {list.hasNextPage && (
            <Button
              disabled={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
            >
              {t("Altre opere", "More works")}
            </Button>
          )}
        </>
      )}
    </section>
  );
}
function LibraryRow({ entry, history }: { entry: Entry; history: boolean }) {
  const t = useText(),
    action = useAction(t);
  const stateLabel = states.find((s) => s[0] === entry.progress?.state);
  return (
    <li className="library-work-entry">
      <h2>
        <Link to={"/works/" + entry.work_id}>{entry.title}</Link>
      </h2>
      {entry.bookmark?.notes && (
        <p className="bookmark-notes">{entry.bookmark.notes}</p>
      )}
      {!!entry.bookmark?.tags.length && (
        <ul className="bookmark-tags">
          {entry.bookmark.tags.map((tag) => (
            <li key={tag}>
              <Link to={"/library?tag=" + encodeURIComponent(tag)}>{tag}</Link>
            </li>
          ))}
        </ul>
      )}
      {history && entry.last_viewed && (
        <p className="library-entry-meta">
          <time dateTime={entry.last_viewed}>
            {new Date(entry.last_viewed).toLocaleString(t("it", "en"))}
          </time>
        </p>
      )}
      {entry.progress && (
        <p className="library-entry-meta">
          {stateLabel ? t(stateLabel[1], stateLabel[2]) : entry.progress.state}{" "}
          · {Math.round(entry.progress.percent)}%
        </p>
      )}
      <div className="library-entry-actions">
        <LibraryControls entry={entry} compact />
        {history && (
          <IconButton
            icon="trash"
            label={t("Rimuovi dalla cronologia", "Remove from history")}
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await call("libraryForget", { id: entry.work_id });
                await refreshLibrary(entry.work_id);
              })
            }
          />
        )}
      </div>
      {action.error && <Notice error>{action.error}</Notice>}
    </li>
  );
}
export function ReaderLibrary({
  id,
  compact = false,
}: {
  id: string;
  compact?: boolean;
}) {
  const data = useQuery({
    queryKey: ["library-work", id],
    queryFn: () => call("libraryWork", { id }),
  });
  return data.isPending ? (
    <Loading />
  ) : data.isError ? (
    <QueryError retry={() => void data.refetch()} />
  ) : (
    <>
      <LibraryControls key={id} entry={data.data} compact={compact} />
      <Follow kind="work" target={id} compact={compact} />
    </>
  );
}
function LibraryControls({
  entry,
  compact = false,
}: {
  entry: Entry;
  compact?: boolean;
}) {
  const t = useText(),
    action = useAction(t);
  return (
    <div className="library-controls">
      <ActionMenu
        label={
          entry.bookmark
            ? t("Salvato in biblioteca", "Saved to library")
            : t("Salva in biblioteca", "Save to library")
        }
        title={t("La tua biblioteca", "Your library")}
        icon="bookmark"
        compact={compact}
        active={!!entry.bookmark}
      >
        {() => <SavedWorkMenu entry={entry} />}
      </ActionMenu>
      <Button
        className={compact ? "button reader-icon-action" : "button"}
        title={
          entry.later
            ? t("Rimuovi da più tardi", "Unmark for Later")
            : t("Leggi più tardi", "Mark for Later")
        }
        disabled={action.busy}
        aria-pressed={entry.later}
        onClick={() =>
          void action.run(async () => {
            await call("libraryLater", {
              id: entry.work_id,
              later: !entry.later,
            });
            await refreshLibrary(entry.work_id);
          })
        }
      >
        {compact && <Icon name="clock" />}
        <span className={compact ? "sr-only" : undefined}>
          {entry.later
            ? t("Rimuovi da più tardi", "Unmark for Later")
            : t("Leggi più tardi", "Mark for Later")}
        </span>
      </Button>
      <Recommend work={entry.work_id} compact={compact} />
      {entry.bookmark?.recommended && (
        <span>{t("Consigliata", "Recommended")}</span>
      )}
      {action.error && <Notice error>{action.error}</Notice>}
    </div>
  );
}
function SavedWorkMenu({ entry }: { entry: Entry }) {
  const t = useText(),
    action = useAction(t);
  const [view, setView] = useState<"main" | "details" | "remove">("main");
  const detailsTrigger = useRef<HTMLButtonElement>(null);
  const toggleTrigger = useRef<HTMLButtonElement>(null);
  const pendingFocus = useRef<"details" | "toggle" | null>(null);
  useLayoutEffect(() => {
    if (view !== "main" || action.busy || !pendingFocus.current) return;
    const target =
      pendingFocus.current === "toggle" ? toggleTrigger : detailsTrigger;
    if (target.current) {
      target.current.focus({ preventScroll: true });
      pendingFocus.current = null;
    }
  });
  function returnToMenu(target: "details" | "toggle" = "details") {
    pendingFocus.current = target;
    setView("main");
  }
  const [removeRevision, setRemoveRevision] = useState(entry.revision);
  async function removeSaved(revision: number) {
    await action.run(async () => {
      await call("bookmarkSave", {
        id: entry.work_id,
        revision,
        bookmark: null,
      });
      await refreshLibrary(entry.work_id);
      returnToMenu("toggle");
    });
  }
  if (view === "details")
    return <SavedWorkDetails entry={entry} onDone={() => returnToMenu()} />;
  if (view === "remove")
    return (
      <div className="action-menu-form">
        <p>
          {t(
            "Rimuovere l’opera dalla tua biblioteca?",
            "Remove this work from your library?",
          )}
        </p>
        <p className="action-menu-hint">
          {t(
            "Verranno rimossi anche note e tag personali. L’opera nelle collezioni, i progressi e le annotazioni restano disponibili.",
            "Personal notes and tags will also be removed. Collection entries, reading progress and annotations remain available.",
          )}
        </p>
        {action.error && <Notice error>{action.error}</Notice>}
        <div className="action-menu-form-actions">
          <Button autoFocus onClick={() => returnToMenu("toggle")}>
            {t("Annulla", "Cancel")}
          </Button>
          <Button
            tone="danger"
            disabled={action.busy}
            onClick={() => void removeSaved(removeRevision)}
          >
            {t("Rimuovi", "Remove")}
          </Button>
        </div>
      </div>
    );
  return (
    <>
      <button
        className="action-menu-item library-save-action"
        ref={toggleTrigger}
        aria-pressed={!!entry.bookmark}
        title={
          entry.bookmark
            ? t("Rimuovi dalla biblioteca", "Remove from library")
            : undefined
        }
        disabled={action.busy}
        onClick={() => {
          if (entry.bookmark) {
            if (
              entry.bookmark.notes ||
              entry.bookmark.tags.length ||
              entry.bookmark.recommended
            ) {
              setRemoveRevision(entry.revision);
              setView("remove");
            } else void removeSaved(entry.revision);
          } else
            void action.run(async () => {
              await call("librarySave", { id: entry.work_id });
              pendingFocus.current = "toggle";
              await refreshLibrary(entry.work_id);
            });
        }}
      >
        <Icon name="bookmark" filled={!!entry.bookmark} />
        <span>
          {entry.bookmark
            ? t("Salvato in biblioteca", "Saved to library")
            : t("Salva in biblioteca", "Save to library")}
        </span>
      </button>
      <p className="action-menu-section-label">
        {t("Organizza in collezioni", "Organize in collections")}
      </p>
      <CollectionChoices
        work={entry.work_id}
        onSaved={() => refreshLibrary(entry.work_id)}
      />
      {entry.bookmark && (
        <div className="saved-work-details-actions">
          <button
            className="action-menu-item"
            ref={detailsTrigger}
            onClick={() => setView("details")}
          >
            <Icon name="note" />
            <span>{t("Note e tag personali", "Personal notes and tags")}</span>
          </button>
        </div>
      )}
      {action.error && <Notice error>{action.error}</Notice>}
    </>
  );
}
function SavedWorkDetails({
  entry,
  onDone,
}: {
  entry: Entry;
  onDone: () => void;
}) {
  const t = useText(),
    action = useAction(t),
    [conflict, setConflict] = useState(false),
    [revision] = useState(entry.revision);
  const [notes, setNotes] = useState(entry.bookmark?.notes ?? ""),
    [tags, setTags] = useState(entry.bookmark?.tags.join("\n") ?? ""),
    [recommended, setRecommended] = useState(
      entry.bookmark?.recommended ?? false,
    );
  async function save() {
    await action.run(async () => {
      try {
        await call("bookmarkSave", {
          id: entry.work_id,
          revision,
          bookmark: {
            notes,
            tags: tags
              .split("\n")
              .map((t) => t.trim())
              .filter(Boolean),
            recommended,
            private: entry.bookmark?.private ?? true,
          },
        });
      } catch (e) {
        if (e instanceof ApiFailure && e.code === "CONFLICT") {
          setConflict(true);
          await refreshLibrary(entry.work_id);
        }
        throw e;
      }
      await refreshLibrary(entry.work_id);
      onDone();
    });
  }
  return (
    <form
      className="bookmark-editor action-menu-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <p className="action-menu-hint">
        {t("Privato · visibile solo a te", "Private · only visible to you")}
      </p>
      <label>
        {t("Note personali", "Personal notes")}
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={10000}
          rows={4}
          autoFocus
        />
      </label>
      <label>
        {t("Tag personali, uno per riga", "Personal tags, one per line")}
        <textarea
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          rows={2}
        />
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={recommended}
          onChange={(e) => setRecommended(e.target.checked)}
        />
        {t("Consigliata", "Recommended")}
      </label>
      {conflict ? (
        <Notice error>
          {t(
            "I dettagli sono cambiati su un altro dispositivo. Copia le note e riapri il modulo per caricare la versione aggiornata.",
            "These details changed on another device. Copy your notes and reopen the form to load the latest version.",
          )}
        </Notice>
      ) : (
        action.error && <Notice error>{action.error}</Notice>
      )}
      <div className="action-menu-form-actions">
        <Button type="button" onClick={onDone}>
          {t("Annulla", "Cancel")}
        </Button>
        <Button type="submit" tone="primary" disabled={action.busy || conflict}>
          {t("Salva", "Save")}
        </Button>
      </div>
    </form>
  );
}
