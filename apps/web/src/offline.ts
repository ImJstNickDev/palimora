import {
  alignAnchor,
  readingPercent,
  type Input,
  type Output,
  type Operation,
} from "@palimora/contracts";
import { ApiFailure } from "./api";
import { read, records, write, exclusive } from "./offline-store";
export type Transport = <K extends Operation>(
  name: K,
  input: Input<K>,
  options?: { keepalive?: boolean; signal?: AbortSignal },
) => Promise<Output<K>>;
type Identity = {
  partition: string;
  user: Output<"me">["user"];
  session: Output<"me">["session"];
};
export type OfflineWork = {
  key: string;
  partition: string;
  id: string;
  snapshot: string;
  title: string;
  saved: string;
  bytes: number;
  work: Output<"readerWork">;
  documents: Record<string, string>;
  assets: Record<string, string>;
  latest?: string;
};
export type OfflineCopy = Omit<OfflineWork, "documents">;
export type Pending = {
  key: string;
  partition: string;
  operation: "readingSave" | "annotationSave";
  input: any;
  sequence: number;
  error?: string;
};
let partition: string | undefined;
let stagingCleaned = false;
let disconnected = !navigator.onLine;
export const isDisconnected = () => disconnected;
const channel =
  typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel("palimora-personal")
    : null;
export function changed(reset = false) {
  window.dispatchEvent(new Event(reset ? "offline-reset" : "offline-change"));
  channel?.postMessage(reset ? "reset" : "change");
}
channel?.addEventListener("message", (e) => {
  if (e.data === "reset") {
    partition = undefined;
    releaseMedia();
  }
  window.dispatchEvent(
    new Event(e.data === "reset" ? "offline-reset" : "offline-change"),
  );
});
function connection(value: boolean) {
  if (disconnected !== value) {
    disconnected = value;
    window.dispatchEvent(new Event("offline-change"));
  }
}
window.addEventListener("offline", () => connection(true));
export async function identity(restore = false) {
  const i = await read<Identity>("identity");
  if (i && Date.parse(i.session.expires_at) <= Date.now()) {
    await clearOffline();
    throw new ApiFailure("UNAUTHENTICATED");
  }
  if (
    !i ||
    (!partition && !restore) ||
    (partition && partition !== i.partition)
  )
    throw new ApiFailure("UNAUTHENTICATED");
  return i;
}
export async function clearOffline(pendingLogout = false) {
  const hadIdentity = !!(await read("identity"));
  partition = undefined;
  releaseMedia();
  const status = await read("status");
  await write(
    [
      ["pendingLogout", pendingLogout || undefined],
      ["status", status],
      ["epoch", crypto.randomUUID()],
    ],
    undefined,
    true,
  );
  changed(hadIdentity);
}
async function rememberAuth(a: Output<"me">) {
  const next = a.user.id + ":" + a.session.id;
  const previous = await read<Identity>("identity");
  if (previous && previous.partition !== next) await clearOffline();
  partition = next;
  await write([
    [
      "identity",
      { partition: next, user: a.user, session: a.session } satisfies Identity,
    ],
  ]);
  if (!stagingCleaned) {
    stagingCleaned = true;
    await exclusive(async () => {
      const referenced = new Set(
        (await listOffline()).flatMap((w) => Object.values(w.assets)),
      );
      const stale = (await records("asset:")).filter(
        ([key]) =>
          !referenced.has(key) &&
          Number(key.split(":")[1]) < Date.now() - 86400000,
      );
      if (stale.length)
        await write(
          stale.map(([key]) => [key, undefined]),
          next,
        );
    });
  }
}
export async function listOffline() {
  const i = await identity();
  return (await records<OfflineCopy>("copy:"))
    .map(([, w]) => w)
    .filter((w) => w.partition === i.partition)
    .sort((a, b) => b.saved.localeCompare(a.saved));
}
export async function pendingOperations() {
  const i = await identity();
  return (await records<Pending>("queue:"))
    .map(([, q]) => q)
    .filter((q) => q.partition === i.partition)
    .sort((a, b) => a.sequence - b.sequence || a.key.localeCompare(b.key));
}
async function selected(id: string, snapshot?: string) {
  const copy = (await listOffline()).find(
    (w) => w.id === id && (!snapshot || w.snapshot === snapshot),
  );
  return copy ? read<OfflineWork>(copy.key) : undefined;
}
function texts(w: OfflineWork) {
  const doc = new DOMParser().parseFromString(
    w.documents["off:light"],
    "text/html",
  );
  return new Map(
    [...doc.querySelectorAll("section.chapter")].map((el) => [
      el.id.slice(8),
      el.textContent ?? "",
    ]),
  );
}
function alignedProgress(
  p: Output<"readingProgress">,
  w: OfflineWork,
): Output<"readingProgress"> {
  const map = texts(w);
  const aligned: Output<"readingProgress">["aligned"] = p.anchor
    ? alignAnchor(p.anchor, map, w.snapshot)
    : { anchor: null, status: "unresolved" as const };
  if (p.anchor && !aligned.anchor) {
    const text = map.get(p.anchor.chapter);
    if (text)
      aligned.anchor = {
        ...p.anchor,
        snapshot: w.snapshot,
        offset: 0,
        quote: text.slice(0, 80),
        prefix: "",
        suffix: text.slice(80, 112),
      };
  }
  return {
    ...p,
    aligned,
    chapter_lengths: [...map].map(([chapter, text]) => ({
      chapter,
      length: text.length,
    })),
  };
}
const objectURLs = new Map<string, string>();
export function releaseMedia() {
  for (const url of objectURLs.values()) URL.revokeObjectURL(url);
  objectURLs.clear();
}
async function render(w: OfflineWork, x: Input<"readerContent">) {
  let html = w.documents[(x.skin ?? "off") + ":" + (x.theme ?? "light")];
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (x.chapter) {
    const sections = [...doc.querySelectorAll("section.chapter")];
    if (!sections.some((s) => s.id === "chapter-" + x.chapter))
      throw new ApiFailure("NOT_FOUND");
    for (const s of sections) if (s.id !== "chapter-" + x.chapter) s.remove();
    const skin = doc.getElementById("workskin")!;
    for (const note of [...skin.children].filter((n) =>
      n.classList.contains("notes"),
    )) {
      const first =
        note.compareDocumentPosition(skin.querySelector("section")!) &
        Node.DOCUMENT_POSITION_FOLLOWING;
      if (
        (first && sections[0].id !== "chapter-" + x.chapter) ||
        (!first && sections.at(-1)!.id !== "chapter-" + x.chapter)
      )
        note.remove();
    }
  }
  const style = doc.createElement("style");
  style.textContent = `@layer palimora-reader { body{font-family:${x.font === "sans" ? "system-ui,sans-serif" : "Georgia,serif"}!important;font-size:${Math.max(14, Math.min(28, Number(x.size ?? 19)))}px!important} }`;
  doc.head.append(style);
  const csp = doc.querySelector('meta[http-equiv="Content-Security-Policy"]');
  csp?.setAttribute(
    "content",
    csp
      .getAttribute("content")!
      .replaceAll("'self' data:", "'self' data: blob:"),
  );
  html = "<!doctype html>" + doc.documentElement.outerHTML;
  for (const [path, key] of Object.entries(w.assets).sort(
    (a, b) => b[0].length - a[0].length,
  )) {
    let url = objectURLs.get(key);
    if (!url) {
      const blob = await read<Blob>(key);
      if (!blob) throw Error("OFFLINE_INCOMPLETE");
      url = URL.createObjectURL(blob);
      objectURLs.set(key, url);
    }
    html = html
      .replaceAll(path.replaceAll("&", "&amp;"), url)
      .replaceAll(path, url);
  }
  // Chapter links open the same pinned copy, never another version silently.
  html = html.replaceAll(
    `/works/${w.id}?snapshot=`,
    `/works/${w.id}?local=1&amp;snapshot=`,
  );
  await identity();
  return { document: html };
}
async function localRead(name: Operation, x: any): Promise<any> {
  const i = await identity();
  if (name === "status") return read("status");
  if (name === "me") return { user: i.user, session: i.session, csrf: "" };
  if (name === "collectionList") return { items: [], next: null };
  const w = await selected(x.id, x.snapshot);
  if (!w) throw Error("OFFLINE_UNAVAILABLE");
  if (name === "readerWork")
    return {
      ...w.work,
      versions: (await listOffline())
        .filter((v) => v.id === x.id)
        .flatMap((v) => v.work.versions.filter((s) => s.id === v.snapshot)),
      next: null,
    };
  if (name === "readerContent") return render(w, x);
  if (name === "readingProgress") {
    const p = await read<Output<"readingProgress">>("progress:" + x.id);
    if (!p) throw Error("OFFLINE_INCOMPLETE");
    return alignedProgress(p, w);
  }
  if (name === "annotationList") {
    const notes =
      (await read<Output<"annotationList">["items"]>("notes:" + x.id)) ?? [];
    return {
      items: notes.map((n) => ({
        ...n,
        aligned: alignAnchor(n.anchor, texts(w), w.snapshot),
      })),
      next: null,
    };
  }
  throw Error("OFFLINE_UNAVAILABLE");
}
async function enqueue(name: "readingSave" | "annotationSave", x: any) {
  return exclusive(async () => {
    const i = await identity(),
      w = await selected(
        x.id,
        name === "readingSave" ? x.anchor.snapshot : undefined,
      );
    if (!w) throw Error("OFFLINE_UNAVAILABLE");
    const key = "queue:" + x.requestId;
    const existing = await read<Pending>(key);
    if (existing)
      return name === "readingSave"
        ? localRead("readingProgress", {
            id: x.id,
            snapshot: x.anchor.snapshot,
          })
        : { ok: true };
    let result: any;
    const changes: Array<[string, unknown]> = [];
    if (name === "readingSave") {
      const p = await read<Output<"readingProgress">>("progress:" + x.id);
      if ((p?.revision ?? 0) !== x.revision) throw new ApiFailure("CONFLICT");
      const chapter_lengths = [...texts(w)].map(([chapter, text]) => ({
        chapter,
        length: text.length,
      }));
      result = {
        revision: x.revision + 1,
        state: x.state,
        anchor: x.anchor,
        chapter_lengths,
        percent:
          x.state === "completed"
            ? 100
            : (readingPercent(chapter_lengths, x.anchor) ?? 0),
        aligned: { anchor: x.anchor, status: "exact" },
      };
      changes.push(["progress:" + x.id, result]);
    } else {
      const notes =
        (await read<Output<"annotationList">["items"]>("notes:" + x.id)) ?? [];
      const previous = notes.find((n) => n.id === x.annotation_id);
      if (previous && !previous.editable) throw new ApiFailure("FORBIDDEN");
      if ((previous?.revision ?? 0) !== x.revision)
        throw new ApiFailure("CONFLICT");
      const next = notes.filter((n) => n.id !== x.annotation_id);
      if (!x.deleted)
        next.push({
          id: x.annotation_id,
          user_id: i.user.id,
          username: i.user.username,
          body: x.body,
          anchor: x.anchor,
          revision: x.revision + 1,
          collection_id: x.collection_id,
          editable: true,
          aligned: { anchor: x.anchor, status: "exact" },
        });
      changes.push(["notes:" + x.id, next]);
      result = { ok: true };
    }
    const sequence = ((await read<number>("queue-sequence")) ?? 0) + 1;
    changes.push(["queue-sequence", sequence]);
    changes.push([
      key,
      {
        key,
        partition: i.partition,
        operation: name,
        input: x,
        sequence,
      } satisfies Pending,
    ]);
    await write(changes, i.partition);
    changed();
    return result;
  });
}
async function cachePersonal(name: string, x: any, result: any) {
  if (!partition || !(await selected(x.id))) return;
  const queue = await pendingOperations();
  if (queue.some((q) => q.input.id === x.id)) return;
  if (name === "readingProgress" || name === "readingSave")
    await write([["progress:" + x.id, result]], partition);
  // Only the user's own annotations may be persisted; shared readers' ACLs can change.
  if (name === "annotationList" && !x.cursor && !result.next)
    await write(
      [["notes:" + x.id, result.items.filter((n: any) => n.editable)]],
      partition,
    );
}
function networkFailure(e: unknown) {
  return (
    e instanceof TypeError ||
    (e instanceof DOMException && e.name === "NetworkError")
  );
}
export async function offlineCall<K extends Operation>(
  name: K,
  input: Input<K>,
  send: Transport,
  options: { keepalive?: boolean; signal?: AbortSignal } = {},
): Promise<Output<K>> {
  let x: any = input;
  if (name === "readingSave" || name === "annotationSave")
    x = {
      ...input,
      requestId: (input as any).requestId ?? crypto.randomUUID(),
    };
  if (name === "logout") {
    let pending = true;
    try {
      await send(name, input, options);
      pending = false;
    } catch (e) {
      if (
        !networkFailure(e) &&
        !(e instanceof ApiFailure && e.code === "UNAUTHENTICATED")
      )
        throw e;
    } finally {
      await clearOffline(pending);
    }
    return { ok: true } as Output<K>;
  }
  const personal = ["readingProgress", "annotationList"].includes(name);
  const savedReader =
    ["readerWork", "readerContent"].includes(name) &&
    new URLSearchParams(location.search).get("local") === "1";
  if (
    partition &&
    (personal || name === "readingSave" || name === "annotationSave")
  ) {
    const queue = await pendingOperations();
    if (
      queue.some(
        (q) => q.input.id === x.id && (personal || q.operation === name),
      )
    ) {
      if (personal) return localRead(name, x);
      return enqueue(name as "readingSave" | "annotationSave", x);
    }
  }
  if (savedReader) return localRead(name, x);
  const epoch = await read("epoch");
  try {
    if (name === "me" && (await read("pendingLogout"))) {
      const old = await send("me", {});
      await send("logout", {});
      await clearOffline();
      void old;
      throw new ApiFailure("UNAUTHENTICATED");
    }
    const result = await send(name, x, options);
    connection(false);
    if (name === "status") await write([["status", result]]);
    if ("csrf" in (result as any)) {
      if (name === "me" && epoch !== (await read("epoch")))
        throw new ApiFailure("UNAUTHENTICATED");
      await rememberAuth(result as Output<"me">);
    }
    if (["password", "deleteAccount"].includes(name)) await clearOffline();
    if (personal || name === "readingSave")
      await cachePersonal(name, x, result);
    return result;
  } catch (e) {
    if (e instanceof ApiFailure && e.code === "UNAUTHENTICATED") {
      if (epoch === (await read("epoch"))) await clearOffline();
      throw e;
    }
    if (!networkFailure(e)) throw e;
    connection(true);
    if (name === "status") {
      const status = await read<Output<"status">>("status");
      if (status) return status as Output<K>;
    }
    if (name === "me") {
      const i = await identity(true);
      partition = i.partition;
    }
    if (name === "readingSave" || name === "annotationSave")
      return enqueue(name, x);
    if (
      [
        "me",
        "readerWork",
        "readerContent",
        "readingProgress",
        "annotationList",
        "collectionList",
      ].includes(name)
    )
      return localRead(name, x);
    throw e;
  }
}

export async function downloadWork(
  id: string,
  snapshot: string,
  send: Transport,
  progress: (done: number, total: number) => void,
  signal: AbortSignal,
) {
  const i = await identity(),
    current = await send("me", {});
  if (current.session.id !== i.session.id || current.user.id !== i.user.id)
    throw new ApiFailure("UNAUTHENTICATED");
  const work = await send("readerWork", { id, snapshot }, { signal });
  if (!work.manifest || !work.snapshot) throw Error("OFFLINE_UNAVAILABLE");
  const key = "work:" + id + ":" + snapshot,
    documents: Record<string, string> = {},
    assets: Record<string, string> = {};
  const assetPrefix = "asset:" + Date.now() + ":" + crypto.randomUUID() + ":";
  let bytes = 0,
    done = 0,
    total = 4;
  try {
    for (const skin of ["off", "on"] as const)
      for (const theme of ["light", "dark"] as const) {
        signal.throwIfAborted();
        const content = await send(
          "readerContent",
          { id, snapshot, skin, theme, font: "serif", size: 19 },
          { signal },
        );
        documents[skin + ":" + theme] = content.document;
        bytes += new Blob([content.document]).size;
        progress(++done, total);
      }
    const urls = new Set<string>();
    for (const html of Object.values(documents))
      for (const match of html.matchAll(
        /\/api\/v1\/works\/[a-f0-9-]+\/media\/[a-f0-9]{64}\?snapshot=[a-f0-9-]+(?:&(?:amp;)?download=true)?/g,
      ))
        urls.add(match[0].replaceAll("&amp;", "&"));
    total += urls.size;
    progress(done, total);
    const documentBytes = bytes;
    for (const url of urls) {
      signal.throwIfAborted();
      const response = await fetch(url, {
        credentials: "same-origin",
        cache: "no-store",
        signal,
      });
      if (!response.ok) throw Error("OFFLINE_MEDIA_UNAVAILABLE");
      const estimate = await navigator.storage?.estimate();
      const available = estimate?.quota
        ? estimate.quota - (estimate.usage ?? 0) - documentBytes
        : Infinity;
      const length = Number(response.headers.get("content-length")),
        reader = response.body?.getReader();
      let blob: Blob;
      if (reader) {
        const chunks: BlobPart[] = [];
        let received = 0;
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            received += chunk.value.byteLength;
            if (received > available)
              throw new DOMException("Quota exceeded", "QuotaExceededError");
            chunks.push(chunk.value);
            if (length > 0)
              progress(done + Math.min(0.99, received / length), total);
          }
        } catch (e) {
          await reader.cancel();
          throw e;
        }
        blob = new Blob(chunks, {
          type:
            response.headers.get("content-type") ?? "application/octet-stream",
        });
      } else blob = await response.blob();
      if (blob.size > available)
        throw new DOMException("Quota exceeded", "QuotaExceededError");
      bytes += blob.size;
      const assetKey = assetPrefix + done;
      await write([[assetKey, blob]], i.partition);
      assets[url] = assetKey;
      progress(++done, total);
    }
    const p = await send("readingProgress", { id, snapshot }, { signal });
    const notes: Output<"annotationList">["items"] = [];
    let cursor: string | undefined;
    do {
      signal.throwIfAborted();
      const page = await send(
        "annotationList",
        { id, snapshot, cursor },
        { signal },
      );
      notes.push(...page.items.filter((n) => n.editable));
      cursor = page.next ?? undefined;
    } while (cursor);
    const title = Array.isArray(work.metadata.title)
      ? work.metadata.title.join(" · ")
      : String(work.metadata.title ?? work.work.external_id ?? id);
    const w: OfflineWork = {
      key,
      partition: i.partition,
      id,
      snapshot,
      title,
      work,
      documents,
      assets,
      bytes,
      saved: new Date().toISOString(),
    };
    signal.throwIfAborted();
    await exclusive(async () => {
      const previous = await read<OfflineWork>(key),
        queue = await pendingOperations();
      const { documents: _documents, ...summary } = w;
      const changes: Array<[string, unknown]> = [
        [key, w],
        ["copy:" + id + ":" + snapshot, summary],
      ];
      if (!queue.some((q) => q.input.id === id))
        changes.push(["progress:" + id, p], ["notes:" + id, notes]);
      if (previous)
        changes.push(
          ...Object.values(previous.assets).map(
            (k) => [k, undefined] as [string, unknown],
          ),
        );
      await write(changes, i.partition);
    });
    changed();
  } catch (e) {
    await write((await records(assetPrefix)).map(([k]) => [k, undefined]));
    throw e;
  }
}
export async function removeOffline(key: string) {
  await exclusive(async () => {
    const i = await identity(),
      w = await read<OfflineWork>(key);
    if (!w || w.partition !== i.partition) return;
    if (
      (await pendingOperations()).some(
        (q) => q.input.anchor.snapshot === w.snapshot,
      )
    )
      throw Error("OFFLINE_PENDING");
    await write(
      [
        [key, undefined],
        ["copy:" + w.id + ":" + w.snapshot, undefined],
        ...Object.values(w.assets).map(
          (k) => [k, undefined] as [string, unknown],
        ),
      ],
      i.partition,
    );
    if (!(await listOffline()).some((copy) => copy.id === w.id))
      await write(
        [
          ["notes:" + w.id, undefined],
          ["progress:" + w.id, undefined],
        ],
        i.partition,
      );
    releaseMedia();
    changed();
  });
}
export async function clearCopies() {
  await exclusive(async () => {
    const i = await identity();
    if ((await pendingOperations()).length) throw Error("OFFLINE_PENDING");
    const changes: Array<[string, unknown]> = [];
    for (const w of await listOffline()) {
      changes.push(
        [w.key, undefined],
        ["copy:" + w.id + ":" + w.snapshot, undefined],
      );
      for (const key of Object.values(w.assets)) changes.push([key, undefined]);
    }
    for (const prefix of ["notes:", "progress:"])
      for (const [key] of await records(prefix)) changes.push([key, undefined]);
    await write(changes, i.partition);
    releaseMedia();
    changed();
  });
}

let syncing = false;
export async function syncOffline(send: Transport) {
  if (syncing || !navigator.onLine) return;
  syncing = true;
  try {
    const i = await identity(),
      me = await send("me", {});
    if (me.session.id !== i.session.id || me.user.id !== i.user.id) {
      await clearOffline();
      return;
    }
    connection(false);
    await exclusive(async () => {
      const blocked = new Set<string>();
      for (const q of await pendingOperations()) {
        const entity =
          q.operation + ":" + (q.input.annotation_id ?? q.input.id);
        if (q.error || blocked.has(entity)) {
          blocked.add(entity);
          continue;
        }
        try {
          await send(q.operation, q.input);
          await write([[q.key, undefined]], i.partition);
        } catch (e) {
          if (
            e instanceof ApiFailure &&
            ["CONFLICT", "FORBIDDEN", "NOT_FOUND", "INVALID_INPUT"].includes(
              e.code,
            )
          ) {
            await write([[q.key, { ...q, error: e.code }]], i.partition);
            blocked.add(entity);
          } else throw e;
        }
      }
      for (const id of new Set((await listOffline()).map((w) => w.id))) {
        if ((await pendingOperations()).some((q) => q.input.id === id))
          continue;
        const w = await selected(id);
        const p = await send("readingProgress", { id, snapshot: w!.snapshot });
        const items: Output<"annotationList">["items"] = [];
        let cursor: string | undefined;
        do {
          const page = await send("annotationList", {
            id,
            snapshot: w!.snapshot,
            cursor,
          });
          items.push(...page.items.filter((n) => n.editable));
          cursor = page.next ?? undefined;
        } while (cursor);
        await write(
          [
            ["progress:" + id, p],
            ["notes:" + id, items],
          ],
          i.partition,
        );
      }
    });
    changed();
  } catch (e) {
    if (e instanceof ApiFailure && e.code === "UNAUTHENTICATED")
      await clearOffline();
    else if (networkFailure(e)) connection(true);
    else throw e;
  } finally {
    syncing = false;
  }
}
export async function checkUpdates(send: Transport) {
  const i = await identity();
  for (const w of await listOffline()) {
    const latest = await send("readerWork", { id: w.id });
    await write(
      [
        [
          "copy:" + w.id + ":" + w.snapshot,
          { ...w, latest: latest.snapshot ?? undefined },
        ],
      ],
      i.partition,
    );
  }
  changed();
}
export async function resolvePending(
  q: Pending,
  keep: boolean,
  send: Transport,
  privateCopy = false,
) {
  await exclusive(async () => {
    const i = await identity();
    const queue = (await pendingOperations()).filter(
      (p) =>
        p.operation === q.operation &&
        (p.input.annotation_id ?? p.input.id) ===
          (q.input.annotation_id ?? q.input.id),
    );
    const last = queue.at(-1);
    if (!last) return;
    const changes: Array<[string, unknown]> = queue.map((p) => [
      p.key,
      undefined,
    ]);
    if (keep) {
      let revision: number;
      let input = { ...last.input };
      if (q.operation === "readingSave")
        revision = (await send("readingProgress", { id: q.input.id })).revision;
      else {
        let cursor: string | undefined,
          found: Output<"annotationList">["items"][number] | undefined;
        do {
          const page = await send("annotationList", { id: q.input.id, cursor });
          found = page.items.find((n) => n.id === q.input.annotation_id);
          cursor = page.next ?? undefined;
        } while (cursor && !found);
        revision = found?.revision ?? 0;
        if (!found || privateCopy) {
          revision = 0;
          input = {
            ...input,
            annotation_id: crypto.randomUUID(),
            collection_id: null,
          };
        }
      }
      input = { ...input, revision, requestId: crypto.randomUUID() };
      const key = "queue:" + input.requestId;
      const sequence = ((await read<number>("queue-sequence")) ?? 0) + 1;
      changes.push(["queue-sequence", sequence]);
      changes.push([key, { ...last, key, input, error: undefined, sequence }]);
      if (q.operation === "readingSave") {
        const p = await read<Output<"readingProgress">>(
          "progress:" + q.input.id,
        );
        if (p)
          changes.push([
            "progress:" + q.input.id,
            { ...p, revision: revision + 1 },
          ]);
      } else {
        const notes =
          (await read<Output<"annotationList">["items"]>(
            "notes:" + q.input.id,
          )) ?? [];
        changes.push([
          "notes:" + q.input.id,
          notes.map((n) =>
            n.id === q.input.annotation_id
              ? {
                  ...n,
                  id: input.annotation_id,
                  revision: revision + 1,
                  collection_id: input.collection_id,
                }
              : n,
          ),
        ]);
      }
    }
    await write(changes, i.partition);
  });
  await syncOffline(send);
  changed();
}
