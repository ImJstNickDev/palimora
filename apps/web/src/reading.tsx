import { useOffline } from "./offline-ui";
import { pendingOperations } from "./offline";
import { useReadingTime } from "./reading-time";
import { useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { Button, Modal, Notice, Select } from "@palimora/ui";
import type { Input, Output } from "@palimora/contracts";
import { call, ApiFailure } from "./api";
import { client, useText, useAction, Loading, QueryError } from "./shared";
type Anchor = Input<"readingSave">["anchor"];
type State = Input<"readingSave">["state"];
export const states = [
  ["to_read", "Da leggere", "To read"],
  ["reading", "In lettura", "Reading"],
  ["completed", "Completato", "Completed"],
  ["paused", "In pausa", "Paused"],
  ["abandoned", "Abbandonato", "Abandoned"],
] as const;
function frameDocument() {
  return document.querySelector<HTMLIFrameElement>(".reader-frame")
    ?.contentDocument;
}
function anchorAt(snapshot: string, range: Range): Anchor | null {
  const element =
    range.startContainer.nodeType === 1
      ? (range.startContainer as Element)
      : range.startContainer.parentElement;
  const section = element?.closest("section.chapter");
  if (!section) return null;
  const before = range.cloneRange();
  before.selectNodeContents(section);
  before.setEnd(range.startContainer, range.startOffset);
  const offset = before.toString().length,
    text = section.textContent ?? "",
    quote = range.toString() || text.slice(offset, offset + 80);
  if (
    !quote ||
    quote.length > 4000 ||
    text.slice(offset, offset + quote.length) !== quote
  )
    return null;
  return {
    snapshot,
    chapter: section.id.slice(8),
    offset,
    quote,
    prefix: text.slice(Math.max(0, offset - 32), offset),
    suffix: text.slice(offset + quote.length, offset + quote.length + 32),
  };
}
function capture(snapshot: string, selection = false): Anchor | null {
  const doc = frameDocument();
  if (!doc) return null;
  if (selection) {
    const s = doc.getSelection();
    return s?.rangeCount && !s.isCollapsed
      ? anchorAt(snapshot, s.getRangeAt(0))
      : null;
  }
  const frame = doc.defaultView?.frameElement as HTMLIFrameElement | null;
  if (!frame) return null;
  const box = frame.getBoundingClientRect(),
    y = Math.max(
      8,
      Math.min(
        doc.documentElement.clientHeight - 8,
        Math.max(0, -box.top) + 80,
      ),
    );
  const caret = (
    doc as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    }
  ).caretRangeFromPoint?.(
    Math.min(doc.documentElement.clientWidth / 2, 200),
    y,
  );
  if (caret) {
    const anchor = anchorAt(snapshot, caret);
    if (anchor) return anchor;
  }
  for (const section of doc.querySelectorAll("section.chapter")) {
    if (section.getBoundingClientRect().bottom + box.top < 0) continue;
    const walker = doc.createTreeWalker(section, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (!node.textContent?.trim()) continue;
      const range = doc.createRange();
      range.selectNodeContents(node);
      if (range.getBoundingClientRect().bottom + box.top < 0) continue;
      range.collapse(true);
      return anchorAt(snapshot, range);
    }
  }
  return null;
}
export function scrollToAnchor(anchor: Anchor) {
  const doc = frameDocument(),
    section = doc?.getElementById("chapter-" + anchor.chapter);
  if (!doc || !section) return false;
  const walker = doc.createTreeWalker(section, NodeFilter.SHOW_TEXT);
  let offset = anchor.offset,
    node: Node | null;
  while ((node = walker.nextNode())) {
    if (offset <= (node.textContent?.length ?? 0)) {
      const range = doc.createRange();
      range.setStart(node, offset);
      range.collapse(true);
      const frame = doc.defaultView!.frameElement as HTMLElement;
      const y = range.getBoundingClientRect().top;
      if (
        frame.classList.contains("reader-frame") &&
        frame.closest(".immersive")
      )
        doc.defaultView!.scrollBy(0, y - 70);
      else {
        window.scrollBy(0, frame.getBoundingClientRect().top + y - 70);
      }
      return true;
    }
    offset -= node.textContent?.length ?? 0;
  }
  return false;
}
export function ReadingTools({
  id,
  snapshot,
}: {
  id: string;
  snapshot: string;
}) {
  useReadingTime(id);
  useOffline();
  const pendingQueue = useQuery({
    queryKey: ["offline-queue"],
    queryFn: pendingOperations,
  });
  const t = useText(),
    action = useAction(t),
    [params, setParams] = useSearchParams();
  const progress = useQuery({
    queryKey: ["reading", id, snapshot],
    queryFn: () => call("readingProgress", { id, snapshot }),
  });
  const notes = useInfiniteQuery({
    queryKey: ["annotations", id, snapshot],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      call("annotationList", { id, snapshot, cursor: pageParam }),
    getNextPageParam: (p) => p.next ?? undefined,
  });
  const [selection, setSelection] = useState<Anchor | null>(null),
    [edit, setEdit] = useState<
      Output<"annotationList">["items"][number] | "new" | null
    >(null),
    [pending, setPending] = useState<Anchor | null>(null),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  const mounted = useRef(true),
    pendingState = useRef<State>("reading");
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const current = useRef(progress.data),
    busy = useRef(false),
    conflicted = useRef(false),
    last = useRef(""),
    desired = useRef<Anchor | null>(null);
  current.current = progress.data;
  async function save(anchor: Anchor, state: State, force = false) {
    if (busy.current || (!force && conflicted.current)) return;
    pendingState.current = state;
    busy.current = true;
    setSaving(true);
    try {
      const revision = force
        ? (await call("readingProgress", { id, snapshot })).revision
        : (current.current?.revision ?? 0);
      const result = await call(
        "readingSave",
        { id, revision, anchor, state },
        { keepalive: true },
      );
      current.current = result;
      if (mounted.current)
        client.setQueryData(["reading", id, snapshot], result);
      conflicted.current = false;
      setPending(null);
      setError("");
    } catch (e) {
      desired.current = anchor;
      conflicted.current = true;
      setPending(anchor);
      setError(
        e instanceof ApiFailure && e.code === "CONFLICT"
          ? t(
              "La posizione è cambiata su un altro dispositivo.",
              "Your position changed on another device.",
            )
          : t(
              "Posizione non salvata. Riprova.",
              "Position was not saved. Retry.",
            ),
      );
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    last.current = "";
    conflicted.current = false;
    setPending(null);
    setSelection(null);
    let stable = 0;
    const timer = window.setInterval(() => {
      const selected = capture(snapshot, true);
      if (selected)
        setSelection((old) =>
          JSON.stringify(old) === JSON.stringify(selected) ? old : selected,
        );
      if (document.visibilityState !== "visible" || !current.current) return;
      const a = capture(snapshot);
      if (!a) return;
      const key = a.chapter + ":" + a.offset;
      if (!last.current) {
        last.current = key;
        return;
      }
      if (key !== last.current) {
        last.current = key;
        desired.current = a;
        stable = 0;
      } else if (
        desired.current &&
        ++stable >= 3 &&
        !conflicted.current &&
        !busy.current
      ) {
        const next = desired.current;
        desired.current = null;
        void saveRef.current(
          next,
          current.current.state === "to_read"
            ? "reading"
            : current.current.state,
        );
      }
    }, 600);
    const flush = () => {
      if (
        desired.current &&
        current.current &&
        !busy.current &&
        !conflicted.current
      ) {
        const anchor = desired.current;
        desired.current = null;
        void saveRef.current(
          anchor,
          current.current.state === "to_read"
            ? "reading"
            : current.current.state,
        );
      }
    };
    const hidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      clearInterval(timer);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", hidden);
      flush();
    };
  }, [id, snapshot]);
  function resume(anchor: Anchor) {
    if (!scrollToAnchor(anchor)) {
      const next = new URLSearchParams(params);
      next.set("chapter", anchor.chapter);
      setParams(next);
      const timer = setInterval(() => {
        if (scrollToAnchor(anchor)) clearInterval(timer);
      }, 200);
      setTimeout(() => clearInterval(timer), 5000);
    }
  }
  if (progress.isPending) return <Loading />;
  if (progress.isError)
    return <QueryError retry={() => void progress.refetch()} />;
  const p = progress.data;
  return (
    <section
      className="reading-tools"
      aria-label={t("Lettura e annotazioni", "Reading and annotations")}
    >
      <div className="library-controls">
        <Select
          label={t("Stato di lettura", "Reading state")}
          value={p.state}
          disabled={saving}
          onChange={(e) => {
            const a = capture(snapshot) ?? p.aligned.anchor;
            if (a) void save(a, e.target.value as State);
          }}
        >
          {states.map(([value, it, en]) => (
            <option key={value} value={value}>
              {t(it, en)}
            </option>
          ))}
        </Select>
        <span>
          {Math.round(p.percent)}% ·{" "}
          {saving
            ? t("Salvataggio…", "Saving…")
            : pendingQueue.data?.some((q) => q.input.id === id)
              ? t("Salvato sul dispositivo", "Saved on this device")
              : p.revision
                ? t("Salvato", "Saved")
                : ""}
        </span>
        {p.aligned.anchor && (
          <Button onClick={() => resume(p.aligned.anchor!)}>
            {t("Riprendi lettura", "Resume reading")}
          </Button>
        )}
        {p.anchor && p.aligned.status === "unresolved" && (
          <>
            <span>
              {t(
                "Posizione originale conservata; passaggio non riallineato.",
                "Original position preserved; passage could not be aligned.",
              )}
            </span>
            <a
              href={
                "/works/" +
                id +
                "?snapshot=" +
                p.anchor.snapshot +
                "&chapter=" +
                p.anchor.chapter
              }
            >
              {t("Versione originale", "Original version")}
            </a>
          </>
        )}
        <Button disabled={!selection} onClick={() => setEdit("new")}>
          {t("Annota selezione", "Annotate selection")}
        </Button>
      </div>
      {pendingQueue.data?.some((q) => q.input.id === id && q.error) && (
        <Notice error>
          <Link to="/offline">
            {t(
              "Risolvi le modifiche offline in conflitto",
              "Resolve conflicting offline changes",
            )}
          </Link>
        </Notice>
      )}
      {error && <Notice error>{error}</Notice>}
      {pending && (
        <div className="library-controls">
          <Button
            onClick={() => void save(pending, pendingState.current, true)}
            disabled={saving}
          >
            {t("Usa questa posizione", "Use this position")}
          </Button>
          <Button
            onClick={() =>
              void action.run(async () => {
                const latest = await progress.refetch();
                if (latest.data) {
                  conflicted.current = false;
                  desired.current = null;
                  setPending(null);
                  setError("");
                  if (latest.data.aligned.anchor)
                    resume(latest.data.aligned.anchor);
                }
              })
            }
          >
            {t("Usa posizione salvata", "Use saved position")}
          </Button>
        </div>
      )}
      <details>
        <summary>{t("Annotazioni", "Annotations")}</summary>
        {notes.isPending ? (
          <Loading />
        ) : notes.isError ? (
          <QueryError retry={() => void notes.refetch()} />
        ) : (
          <>
            <ul className="library-entries">
              {notes.data.pages
                .flatMap((p) => p.items)
                .map((a) => (
                  <li key={a.id}>
                    <blockquote>{a.anchor.quote}</blockquote>
                    <p className="bookmark-notes">{a.body}</p>
                    <small>
                      {a.username} ·{" "}
                      {a.collection_id
                        ? t("Condivisa", "Shared")
                        : t("Privata", "Private")}
                    </small>
                    <div className="library-controls">
                      {a.aligned.anchor ? (
                        <Button onClick={() => resume(a.aligned.anchor!)}>
                          {t("Vai al passaggio", "Go to passage")}
                        </Button>
                      ) : (
                        <span>
                          {t(
                            "Passaggio non riallineato",
                            "Passage not aligned",
                          )}
                        </span>
                      )}
                      <a
                        href={
                          "/works/" +
                          id +
                          "?snapshot=" +
                          a.anchor.snapshot +
                          "&chapter=" +
                          a.anchor.chapter
                        }
                      >
                        {t("Versione originale", "Original version")}
                      </a>
                      {a.editable && (
                        <Button onClick={() => setEdit(a)}>
                          {t("Modifica", "Edit")}
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
            </ul>
            {!notes.data.pages[0].items.length && (
              <p>
                {t(
                  "Nessuna annotazione. Seleziona un passaggio nel testo.",
                  "No annotations. Select a passage in the text.",
                )}
              </p>
            )}
            {notes.hasNextPage && (
              <Button onClick={() => void notes.fetchNextPage()}>
                {t("Altre annotazioni", "More annotations")}
              </Button>
            )}
          </>
        )}
      </details>
      <Modal
        open={!!edit}
        onClose={() => setEdit(null)}
        title={t("Annotazione", "Annotation")}
        closeLabel={t("Chiudi", "Close")}
      >
        {edit && (
          <AnnotationEditor
            id={id}
            anchor={edit === "new" ? selection! : edit.anchor}
            existing={edit === "new" ? undefined : edit}
            onDone={async () => {
              setEdit(null);
              await client.invalidateQueries({ queryKey: ["annotations", id] });
            }}
          />
        )}
      </Modal>
      {action.error && <Notice error>{action.error}</Notice>}
    </section>
  );
}
function AnnotationEditor({
  id,
  anchor,
  existing,
  onDone,
}: {
  id: string;
  anchor: Anchor;
  existing?: Output<"annotationList">["items"][number];
  onDone: () => Promise<void>;
}) {
  const t = useText(),
    action = useAction(t),
    [body, setBody] = useState(existing?.body ?? ""),
    [collection, setCollection] = useState(existing?.collection_id ?? ""),
    [annotationId] = useState(() => existing?.id ?? crypto.randomUUID());
  const collections = useInfiniteQuery({
    queryKey: ["collections"],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => call("collectionList", { cursor: pageParam }),
    getNextPageParam: (p) => p.next ?? undefined,
  });
  const save = (deleted = false) =>
    void action.run(async () => {
      await call("annotationSave", {
        id,
        annotation_id: annotationId,
        revision: existing?.revision ?? 0,
        anchor,
        body,
        collection_id: collection || null,
        deleted,
      });
      await onDone();
    });
  return (
    <form
      className="bookmark-editor"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <blockquote>{anchor.quote}</blockquote>
      <label>
        {t("Nota", "Note")}
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          required
          maxLength={10000}
          rows={5}
        />
      </label>
      <Select
        label={t("Visibilità", "Visibility")}
        value={collection}
        onChange={(e) => setCollection(e.target.value)}
      >
        <option value="">{t("Privata", "Private")}</option>
        {existing?.collection_id &&
          !collections.data?.pages.some((p) =>
            p.items.some((c) => c.id === existing.collection_id),
          ) && (
            <option value={existing.collection_id}>
              {t("Condivisione esistente", "Existing sharing")}
            </option>
          )}
        {collections.data?.pages
          .flatMap((p) => p.items)
          .filter((c) => c.accepted && c.role !== "Viewer")
          .map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
      </Select>
      {collections.hasNextPage && (
        <Button type="button" onClick={() => void collections.fetchNextPage()}>
          {t("Altre collezioni", "More collections")}
        </Button>
      )}
      {collections.isError && (
        <QueryError retry={() => void collections.refetch()} />
      )}
      <div className="library-controls">
        <Button disabled={action.busy}>{t("Salva", "Save")}</Button>
        {existing && (
          <Button
            type="button"
            tone="danger"
            disabled={action.busy}
            onClick={() => save(true)}
          >
            {t("Elimina", "Delete")}
          </Button>
        )}
      </div>
      {action.error && <Notice error>{action.error}</Notice>}
    </form>
  );
}
