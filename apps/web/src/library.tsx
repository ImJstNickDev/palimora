import { SocialNav, Follow, Recommend } from "./social";
import { states } from "./reading";
import { AddToCollection } from "./collections";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Button, Field, Modal, Notice } from "@palimora/ui";
import type { Output } from "@palimora/contracts";
import { call, ApiFailure } from "./api";
import { client, useText, useAction, Loading, QueryError } from "./shared";
import "./library.css";

type Entry = Output<"libraryWork">;
async function refreshLibrary(id: string) {
  await Promise.all([
    client.invalidateQueries({ queryKey: ["library"] }),
    client.invalidateQueries({ queryKey: ["library-work", id] }),
  ]);
}
export function Library() {
  const t = useText();
  const [params, setParams] = useSearchParams();
  const kind =
    params.get("kind") === "later"
      ? "later"
      : params.get("kind") === "history"
        ? "history"
        : "bookmarks";
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
      <h1 tabIndex={-1}>{t("Biblioteca personale", "Personal library")}</h1>
      <SocialNav />
      <nav className="library-tabs" aria-label={t("Biblioteca", "Library")}>
        {(
          [
            ["bookmarks", "Bookmark", "Bookmarks"],
            ["later", "Da leggere più tardi", "Marked for Later"],
            ["history", "Cronologia", "History"],
          ] as const
        ).map(([key, it, en]) => (
          <Link
            key={key}
            aria-current={kind === key ? "page" : undefined}
            to={"/library?kind=" + key}
          >
            {t(it, en)}
          </Link>
        ))}
      </nav>
      <form
        key={kind + q + tag}
        className="library-filter"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const next = new URLSearchParams({ kind });
          for (const k of ["q", "tag"]) {
            const v = String(f.get(k) ?? "").trim();
            if (v) next.set(k, v);
          }
          setParams(next);
        }}
      >
        <Field
          label={t("Titolo o note", "Title or notes")}
          name="q"
          defaultValue={q}
          maxLength={200}
        />
        {kind === "bookmarks" && (
          <Field
            label={t("Tag personale", "Personal tag")}
            name="tag"
            defaultValue={tag}
            maxLength={100}
          />
        )}
        <Button type="submit">{t("Filtra", "Filter")}</Button>
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
    <li>
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
        <p>
          <time dateTime={entry.last_viewed}>
            {new Date(entry.last_viewed).toLocaleString(t("it", "en"))}
          </time>
        </p>
      )}
      {entry.progress && (
        <p>
          {stateLabel ? t(stateLabel[1], stateLabel[2]) : entry.progress.state}{" "}
          · {Math.round(entry.progress.percent)}%
        </p>
      )}
      <LibraryControls entry={entry} />
      {history && (
        <Button
          disabled={action.busy}
          onClick={() =>
            void action.run(async () => {
              await call("libraryForget", { id: entry.work_id });
              await refreshLibrary(entry.work_id);
            })
          }
        >
          {t("Rimuovi dalla cronologia", "Remove from history")}
        </Button>
      )}
      {action.error && <Notice error>{action.error}</Notice>}
    </li>
  );
}
export function ReaderLibrary({ id }: { id: string }) {
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
      <Follow kind="work" target={id} />
      <LibraryControls key={id} entry={data.data} />
    </>
  );
}
function LibraryControls({ entry }: { entry: Entry }) {
  const t = useText(),
    action = useAction(t),
    [edit, setEdit] = useState(false);
  return (
    <div className="library-controls">
      <AddToCollection work={entry.work_id} />
      <Recommend work={entry.work_id} />
      <Button onClick={() => setEdit(true)}>
        {entry.bookmark
          ? t("Modifica bookmark", "Edit bookmark")
          : t("Crea bookmark", "Bookmark")}
      </Button>
      <Button
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
        {entry.later
          ? t("Rimuovi da più tardi", "Unmark for Later")
          : t("Leggi più tardi", "Mark for Later")}
      </Button>
      {entry.bookmark?.recommended && (
        <span>{t("Consigliata", "Recommended")}</span>
      )}
      {action.error && <Notice error>{action.error}</Notice>}
      <Modal
        open={edit}
        onClose={() => setEdit(false)}
        title={t("Bookmark", "Bookmark")}
        closeLabel={t("Chiudi", "Close")}
      >
        {edit && <BookmarkEditor entry={entry} onDone={() => setEdit(false)} />}
      </Modal>
    </div>
  );
}
function BookmarkEditor({
  entry,
  onDone,
}: {
  entry: Entry;
  onDone: () => void;
}) {
  const t = useText(),
    action = useAction(t),
    [conflict, setConflict] = useState(false);
  const [notes, setNotes] = useState(entry.bookmark?.notes ?? ""),
    [tags, setTags] = useState(entry.bookmark?.tags.join("\n") ?? ""),
    [recommended, setRecommended] = useState(
      entry.bookmark?.recommended ?? false,
    );
  async function save(remove = false) {
    await action.run(async () => {
      try {
        await call("bookmarkSave", {
          id: entry.work_id,
          revision: entry.revision,
          bookmark: remove
            ? null
            : {
                notes,
                tags: tags
                  .split("\n")
                  .map((t) => t.trim())
                  .filter(Boolean),
                recommended,
                private: true,
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
      className="bookmark-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label>
        {t("Note personali", "Personal notes")}
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={10000}
          rows={6}
        />
      </label>
      <label>
        {t("Tag personali, uno per riga", "Personal tags, one per line")}
        <textarea
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          rows={3}
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
            "Il bookmark è cambiato su un altro dispositivo. Copia le note e riapri il modulo per caricare la versione aggiornata.",
            "This bookmark changed on another device. Copy your notes and reopen the form to load the latest version.",
          )}
        </Notice>
      ) : (
        action.error && <Notice error>{action.error}</Notice>
      )}
      <div className="library-controls">
        <Button type="submit" disabled={action.busy || conflict}>
          {t("Salva", "Save")}
        </Button>
        {entry.bookmark && (
          <Button
            type="button"
            tone="danger"
            disabled={action.busy || conflict}
            onClick={() => void save(true)}
          >
            {t("Elimina bookmark", "Delete bookmark")}
          </Button>
        )}
      </div>
    </form>
  );
}
