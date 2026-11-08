import { createPortal } from "react-dom";
import { useOffline } from "./offline-ui";
import { pendingOperations } from "./offline";
import { useReadingTime } from "./reading-time";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { Button, Modal, Notice, Select } from "@palimora/ui";
import { readingPercent, type Input, type Output } from "@palimora/contracts";
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
export function capture(snapshot: string, selection = false): Anchor | null {
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
  const box = frame.getBoundingClientRect();
  const toolbar = document
    .querySelector(".reader-toolbar")
    ?.getBoundingClientRect();
  const top = frame.closest(".immersive")
    ? box.top
    : Math.max(0, toolbar?.bottom ?? 0);
  const bottom = Math.min(box.bottom, window.innerHeight);
  if (bottom <= top || box.top >= window.innerHeight) return null;
  const y = Math.max(0, top - box.top) + 16;
  const content = doc.getElementById("workskin")?.getBoundingClientRect();
  const x = content
    ? (Math.max(0, content.left) +
        Math.min(doc.documentElement.clientWidth, content.right)) /
      2
    : doc.documentElement.clientWidth / 2;
  const api = doc as Document & {
    caretPositionFromPoint?: (
      x: number,
      y: number,
    ) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  let caret = api.caretRangeFromPoint?.(x, y);
  if (!caret) {
    const position = api.caretPositionFromPoint?.(x, y);
    if (position) {
      caret = doc.createRange();
      caret.setStart(position.offsetNode, position.offset);
      caret.collapse(true);
    }
  }
  if (caret) {
    const rect = caret.getBoundingClientRect();
    const anchor = anchorAt(snapshot, caret);
    // Some engines return the start of a block for a point in its margins.
    if (anchor && rect.bottom >= y - 2 && rect.top <= y + 32) return anchor;
  }
  for (const section of doc.querySelectorAll("section.chapter")) {
    const bounds = section.getBoundingClientRect();
    if (bounds.bottom < y || bounds.top + box.top > bottom) continue;
    const walker = doc.createTreeWalker(section, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (!node.textContent?.trim()) continue;
      const range = doc.createRange();
      range.selectNodeContents(node);
      const bounds = range.getBoundingClientRect();
      if (!bounds.height || bounds.bottom < y || bounds.top + box.top > bottom)
        continue;
      // Find the visible line even when one text node spans a whole chapter.
      let low = 0,
        high = node.textContent.length;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        range.setEnd(node, mid + 1);
        if (range.getBoundingClientRect().bottom < y) low = mid + 1;
        else high = mid;
      }
      range.setStart(node, low);
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
        doc.defaultView!.scrollBy(0, y - 16);
      else {
        const toolbar = document
          .querySelector(".reader-toolbar")
          ?.getBoundingClientRect();
        window.scrollBy(
          0,
          frame.getBoundingClientRect().top +
            y -
            Math.max(0, toolbar?.height ?? 0) -
            16,
        );
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
  chapter,
  immersive,
  onPosition,
}: {
  onPosition: (chapter: string) => void;
  immersive: boolean;
  chapter?: string;
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
  const positionCallback = useRef(onPosition);
  positionCallback.current = onPosition;
  const chapterRef = useRef(chapter);
  const sampledChapter = useRef(chapter);
  chapterRef.current = chapter;
  const [livePercent, setLivePercent] = useState<number | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const panel = useRef<HTMLDetailsElement>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [entryHost, setEntryHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setEntryHost(document.getElementById("reader-start-actions"));
    setHost(document.getElementById("reader-tools-host"));
  }, [id, immersive]);
  const closePanel = () => {
    if (panel.current) {
      panel.current.open = false;
      panel.current
        .querySelector<HTMLElement>("summary")
        ?.focus({ preventScroll: true });
    }
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        e.key === "Escape" &&
        panel.current?.open &&
        !document.querySelector('[role="dialog"]')
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
        closePanel();
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, []);

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
  const [annotationSelection, setAnnotationSelection] = useState<Anchor | null>(
    null,
  );
  const [selectionPoint, setSelectionPoint] = useState<{
    left: number;
    top: number;
  } | null>(null);
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
  useEffect(() => {
    setSelection(null);
    const clear = () => setSelection(null);
    window.addEventListener("reading-frame-ready", clear);
    return () => window.removeEventListener("reading-frame-ready", clear);
  }, [id, snapshot, chapter]);
  useLayoutEffect(() => {
    let doc: Document | null = null;
    const measure = () => {
      const frame = document.querySelector<HTMLIFrameElement>(".reader-frame");
      const selection = frame?.contentDocument?.getSelection();
      const anchored = capture(snapshot, true);
      setSelection((old) =>
        JSON.stringify(old) === JSON.stringify(anchored) ? old : anchored,
      );
      if (!frame || !selection?.rangeCount || selection.isCollapsed) {
        setSelectionPoint(null);
        return;
      }
      const rect = selection.getRangeAt(0).getBoundingClientRect(),
        box = frame.getBoundingClientRect();
      const toolbar = document
        .querySelector(".reader-toolbar")
        ?.getBoundingClientRect();
      const top = Math.max(box.top, toolbar?.bottom ?? 0, 0);
      const bottom = Math.min(box.bottom, innerHeight - (immersive ? 64 : 8));
      if (rect.bottom + box.top < top || rect.top + box.top > bottom) {
        setSelectionPoint(null);
        return;
      }
      const left = Math.max(
        8,
        Math.min(innerWidth - 176, box.left + rect.left + rect.width / 2 - 80),
      );
      const above = box.top + rect.top - 52;
      setSelectionPoint({
        left,
        top:
          above >= top
            ? above
            : Math.min(bottom - 48, box.top + rect.bottom + 8),
      });
    };
    const bind = () => {
      doc?.removeEventListener("selectionchange", measure);
      doc?.removeEventListener("scroll", measure, true);
      doc = frameDocument() ?? null;
      doc?.addEventListener("selectionchange", measure);
      doc?.addEventListener("scroll", measure, true);
      measure();
    };
    bind();
    window.addEventListener("reading-frame-ready", bind);
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      doc?.removeEventListener("selectionchange", measure);
      doc?.removeEventListener("scroll", measure, true);
      window.removeEventListener("reading-frame-ready", bind);
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [immersive, snapshot]);
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
    let stable = 0,
      transitioning = false;
    const begin = () => {
      transitioning = true;
    };
    const end = () => {
      const anchor = capture(snapshot);
      last.current = anchor ? anchor.chapter + ":" + anchor.offset : "";
      stable = 0;
      transitioning = false;
      if (anchor) {
        positionCallback.current(anchor.chapter);
        if (sampledChapter.current !== chapterRef.current) {
          desired.current = anchor;
          const percent = readingPercent(
            current.current?.chapter_lengths ?? [],
            anchor,
          );
          if (percent !== null) setLivePercent(percent);
        }
        sampledChapter.current = chapterRef.current;
      }
    };
    window.addEventListener("reading-transition-start", begin);
    window.addEventListener("reading-transition-end", end);
    const timer = window.setInterval(() => {
      if (transitioning) return;
      const selected = capture(snapshot, true);
      setSelection((old) =>
        JSON.stringify(old) === JSON.stringify(selected) ? old : selected,
      );
      if (document.visibilityState !== "visible" || !current.current) return;
      const a = capture(snapshot);
      if (!a) return;
      positionCallback.current(a.chapter);
      const key = a.chapter + ":" + a.offset;
      if (!last.current) {
        last.current = key;
        return;
      }
      if (key !== last.current) {
        last.current = key;
        desired.current = a;
        const lengths =
          current.current.chapter_lengths ??
          (!chapterRef.current
            ? [
                ...(frameDocument()?.querySelectorAll("section.chapter") ?? []),
              ].map((el) => ({
                chapter: el.id.slice(8),
                length: el.textContent?.length ?? 0,
              }))
            : []);
        const percent = readingPercent(lengths, a);
        if (percent !== null) setLivePercent(percent);
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
      window.removeEventListener("reading-transition-start", begin);
      window.removeEventListener("reading-transition-end", end);
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
  if (!host) return null;
  if (progress.isPending) return createPortal(<Loading />, host);
  if (progress.isError)
    return createPortal(
      <QueryError retry={() => void progress.refetch()} />,
      host,
    );
  const p = progress.data;
  const pendingLocal = pendingQueue.data?.some((q) => q.input.id === id);
  const status = desired.current
    ? t("Da salvare", "Unsaved")
    : saving
      ? t("Salvataggio…", "Saving…")
      : pendingLocal
        ? t("Salvato sul dispositivo", "Saved on this device")
        : p.revision
          ? t("Salvato", "Saved")
          : "";
  const annotate = () => {
    setAnnotationSelection(selection);
    setEdit("new");
  };

  return createPortal(
    <div
      className="reading-tools"
      aria-label={t("Lettura e annotazioni", "Reading and annotations")}
    >
      {entryHost &&
        createPortal(
          <Button
            tone="primary"
            onClick={() => {
              if (p.aligned.anchor) resume(p.aligned.anchor);
              else {
                document
                  .getElementById("reading-start")
                  ?.scrollIntoView({ block: "start" });
                const doc = frameDocument();
                const first = doc?.querySelector<HTMLElement>(".chapter");
                if (first) {
                  first.tabIndex = -1;
                  first.focus({ preventScroll: true });
                }
              }
            }}
          >
            {p.aligned.anchor
              ? t("Riprendi lettura", "Resume reading")
              : t("Leggi", "Read")}
          </Button>,
          entryHost,
        )}
      <span className="reader-progress-status" role="status">
        {Math.round(livePercent ?? p.percent)}% {t("dell’opera", "of the work")}
        {status ? " · " + status : ""}
      </span>
      {selection && selectionPoint && !panelOpen && !edit && (
        <Button
          className="button reader-annotate-selection"
          style={selectionPoint}
          onPointerDown={(e) => e.preventDefault()}
          onClick={annotate}
        >
          {t("Annota selezione", "Annotate selection")}
        </Button>
      )}
      {pendingQueue.data?.some((q) => q.input.id === id && q.error) && (
        <Notice error>
          <Link to="/library/offline">
            {t(
              "Risolvi le modifiche offline in conflitto",
              "Resolve conflicting offline changes",
            )}
          </Link>
        </Notice>
      )}
      {error && <Notice error>{error}</Notice>}
      <details
        ref={panel}
        className="reading-panel"
        open={pending ? true : undefined}
        onToggle={(e) => setPanelOpen(e.currentTarget.open)}
      >
        <summary>
          <span>{t("Lettura e annotazioni", "Reading and annotations")}</span>
        </summary>
        <div
          className="reading-panel-content"
          role="region"
          aria-label={t("Strumenti di lettura", "Reading tools")}
        >
          <div className="reading-panel-heading">
            <h2>{t("Lettura e annotazioni", "Reading and annotations")}</h2>
            <Button
              onClick={closePanel}
              aria-label={t(
                "Chiudi strumenti di lettura",
                "Close reading tools",
              )}
            >
              ×
            </Button>
          </div>
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
            <Button disabled={!selection} onClick={annotate}>
              {t("Annota selezione", "Annotate selection")}
            </Button>
          </div>
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
          <section className="reader-notes-list">
            <h3>{t("Annotazioni", "Annotations")}</h3>
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
                            <Button
                              onClick={() => {
                                closePanel();
                                resume(a.aligned.anchor!);
                              }}
                            >
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
          </section>
        </div>
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
            anchor={edit === "new" ? annotationSelection! : edit.anchor}
            existing={edit === "new" ? undefined : edit}
            onCancel={() => setEdit(null)}
            onDone={async () => {
              setEdit(null);
              await client.invalidateQueries({ queryKey: ["annotations", id] });
            }}
          />
        )}
      </Modal>
      {action.error && <Notice error>{action.error}</Notice>}
    </div>,
    host,
  );
}
function AnnotationEditor({
  id,
  anchor,
  existing,
  onDone,
  onCancel,
}: {
  onCancel: () => void;
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
      className="annotation-editor"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div className="annotation-excerpt">
        <span>{t("Passaggio selezionato", "Selected passage")}</span>
        <blockquote>{anchor.quote}</blockquote>
      </div>
      <label>
        {t("Nota", "Note")}
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          required
          maxLength={10000}
          rows={6}
          autoFocus
          placeholder={t(
            "Scrivi la tua annotazione…",
            "Write your annotation…",
          )}
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
      <div className="annotation-editor-actions">
        <Button type="button" onClick={onCancel}>
          {t("Annulla", "Cancel")}
        </Button>
        <Button tone="primary" disabled={action.busy}>
          {t("Salva", "Save")}
        </Button>
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
