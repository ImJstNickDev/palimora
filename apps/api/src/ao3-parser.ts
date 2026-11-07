import { cssMediaURLs } from "./ao3-media-urls";
import { SourceBibliography } from "@palimora/contracts";
import {
  dom,
  all,
  first,
  attr,
  has,
  clean,
  raw,
  links,
  HNode,
} from "./ao3-html";
import { SyncError } from "./ao3-errors";
import { sha, canonical } from "./pack";
const base = "https://archiveofourown.org";
const dd = (root: HNode, key: string) =>
  first(root, (n) => n.name === "dd" && has(n, key));
const number = (n: HNode | undefined) => {
  const s = clean(n).replaceAll(",", "");
  return /^\d+$/.test(s) ? Number(s) : undefined;
};
export function listing(html: string) {
  const root = dom(html);
  const container = first(
    root,
    (n) => ["ol", "ul"].includes(n.name ?? "") && has(n, "work"),
  );
  const empty = /0 Works|No results found|No works found/i.test(clean(root));
  if (!container && !empty) throw new SyncError("AO3_LIST_STRUCTURE");
  const ids = container
    ? all(container, (n) => /^work_\d+$/.test(attr(n, "id"))).map((n) =>
        attr(n, "id").slice(5),
      )
    : [];
  if (container && !ids.length && !empty)
    throw new SyncError("AO3_LIST_EMPTY_UNVERIFIED");
  const next = links(root).find(
    (n) => attr(n, "rel") === "next" || has(n, "next"),
  );
  const nextPage = next
    ? new URL(attr(next, "href"), base).searchParams.get("page")
    : null;
  return {
    ids: [...new Set(ids)],
    nextPage: nextPage ? Number(nextPage) : null,
  };
}
export function workAvailability(status: number, html: string): string {
  const root = dom(html),
    body = clean(root);
  if (status === 200 && first(root, (n) => attr(n, "id") === "chapters"))
    return "available";
  if (status === 410) return "deleted";
  // AO3's generic 404 cannot prove deletion (unposted/restricted identities exist).
  if (/This work (?:has been|was) deleted/i.test(body)) return "deleted";
  if (
    status === 401 ||
    status === 403 ||
    /only available to registered users|part of an ongoing challenge|mystery work|hidden by.*administrator|log in to (?:view|access)/i.test(
      body,
    )
  )
    return "hidden_or_restricted";
  if (status !== 200) return "temporarily_unavailable";
  return first(root, (n) => attr(n, "id") === "chapters")
    ? "available"
    : "unknown";
}
export function parseWork(id: string, html: string) {
  const root = dom(html),
    skin = first(root, (n) => attr(n, "id") === "workskin"),
    chapters = first(root, (n) => attr(n, "id") === "chapters");
  const meta = first(
    root,
    (n) => n.name === "dl" && has(n, "work") && has(n, "meta"),
  );
  if (!skin || !chapters || !meta) throw new SyncError("AO3_WORK_STRUCTURE");
  const title = first(skin, (n) => n.name === "h2" && has(n, "title"));
  if (!clean(title)) throw new SyncError("AO3_WORK_TITLE");
  const chapterCount = clean(dd(meta, "chapters")).match(
    /^(\d+)\s*\/\s*(\d+|\?)$/,
  );
  if (!chapterCount) throw new SyncError("AO3_CHAPTER_COUNT");
  const count = Number(chapterCount[1]);
  let chapterNodes = all(chapters, (n) => /^chapter-\d+$/.test(attr(n, "id")));
  if (!chapterNodes.length && count === 1) chapterNodes = [chapters];
  if (count < 1 || chapterNodes.length !== count)
    throw new SyncError("AO3_INCOMPLETE_CHAPTERS");
  const objects: any[] = [],
    add = (name: string, kind: string, value: string) => {
      objects.push({ name, kind, data: Buffer.from(value).toString("base64") });
      return name;
    };
  const records = chapterNodes.map((node, i) => {
    const article = first(
      node,
      (n) =>
        has(n, "userstuff") && (attr(n, "role") === "article" || count === 1),
    );
    if (!article) throw new SyncError("AO3_CHAPTER_BODY");
    const heading = first(node, (n) => n.name === "h3" && has(n, "title"));
    const source = links(node)
      .map((n) => attr(n, "href"))
      .find((h) =>
        new RegExp("^/works/" + id + "/chapters/\\d+(?:$|[?#])").test(h),
      );
    if (count > 1 && !source) throw new SyncError("AO3_CHAPTER_IDENTITY");
    // Preserve chapter notes and wrappers byte-for-byte, independently of other chapters.
    return {
      name: add(
        "chapter-" + (i + 1) + ".html",
        "chapter_html",
        raw(html, node),
      ),
      title: clean(heading) || clean(title),
      source_url: source ? new URL(source, base).href : base + "/works/" + id,
      scope: "chapter",
    };
  });
  const preface = first(skin, (n) => has(n, "preface") && !has(n, "chapter"));
  if (preface)
    for (const n of all(preface, (n) => has(n, "notes")))
      add("work-notes.html", "notes_html", raw(html, n));
  for (const [i, n] of all(
    root,
    (n) => n.name === "style" && attr(n, "type") !== "text/less",
  ).entries())
    add(
      "skin-" + i + ".css",
      "css",
      n.children?.map((n) => n.data ?? "").join("") ?? "",
    );
  const tags: any[] = [];
  for (const [css, kind] of Object.entries({
    fandom: "fandom",
    rating: "rating",
    warning: "warnings",
    category: "category",
    character: "characters",
    relationship: "relationships",
    freeform: "freeform",
  })) {
    const field = dd(meta, css);
    if (field)
      for (const a of links(field))
        if (has(a, "tag"))
          tags.push({
            id: "name:" + clean(a),
            name: clean(a),
            kind,
            canonical: null,
          });
  }
  const byline = first(skin, (n) => has(n, "byline"));
  const authors: any[] = [],
    pseuds: any[] = [];
  for (const a of byline ? links(byline) : []) {
    const m = attr(a, "href").match(
      /^\/users\/([^/]+)(?:\/pseuds\/([^/?#]+))?/,
    );
    if (!m) continue;
    const name = decodeURIComponent(m[1]);
    if (!authors.some((x) => x.id === name))
      authors.push({ id: name, name, url: base + "/users/" + m[1] });
    if (m[2])
      pseuds.push({
        id: name + "/" + decodeURIComponent(m[2]),
        name: clean(a),
        owner_id: name,
        url: new URL(attr(a, "href"), base).href,
      });
  }
  const series: any[] = [];
  const seriesField = dd(meta, "series");
  for (const a of seriesField ? links(seriesField) : []) {
    const m = attr(a, "href").match(/^\/series\/(\d+)$/);
    if (m) {
      const position = clean(a.parent).match(/Part\s+(\d+)/i);
      series.push({
        id: m[1],
        name: clean(a),
        url: base + "/series/" + m[1],
        ...(position ? { position: Number(position[1]) } : {}),
      });
    }
  }
  const statistics: any = {};
  for (const key of ["words", "hits", "kudos", "comments", "bookmarks"]) {
    const v = number(dd(meta, key));
    if (v !== undefined) statistics[key] = v;
  }
  const summary = first(preface ?? skin, (n) => has(n, "summary"));
  const summaryBody = summary && first(summary, (n) => has(n, "userstuff"));
  const source: any = {
    schema: "palimora-ao3-v1",
    tags,
    authors,
    pseuds,
    series,
    statistics,
    availability: "available",
    complete: chapterCount[2] !== "?" && count === Number(chapterCount[2]),
    expected_chapters: chapterCount[2] === "?" ? null : Number(chapterCount[2]),
    published: clean(dd(meta, "published")),
    updated: clean(dd(meta, "status")) || clean(dd(meta, "published")),
  };
  const kudosNode = first(root, (n) => attr(n, "id") === "kudos");
  if (kudosNode) {
    const users = links(kudosNode)
      .filter((n) => /^\/users\//.test(attr(n, "href")))
      .map((n) => ({
        name: clean(n),
        url: new URL(attr(n, "href"), base).href,
      }));
    const guests = clean(kudosNode).match(/([\d,]+) guests?/);
    source.kudos = {
      users,
      ...(guests ? { guests: Number(guests[1].replaceAll(",", "")) } : {}),
    };
  }
  source.comments = parseComments(html).comments;
  source.comments_coverage =
    statistics.comments === 0
      ? "complete"
      : source.comments.length
        ? "partial"
        : "unknown";
  source.kudos_coverage = kudosNode
    ? first(kudosNode, (n) => attr(n, "id") === "kudos_more_link")
      ? "partial"
      : "complete"
    : "unknown";
  source.relations = [];
  const afterword = first(skin, (n) => has(n, "afterword"));
  if (afterword) {
    const endnotes = first(afterword, (n) => has(n, "notes"));
    if (endnotes) {
      const last: any = records.at(-1)!;
      const object = objects.find((o) => o.name === last.name);
      last.notes = [
        {
          name: add("work-endnotes.html", "notes_html", raw(html, endnotes)),
          offset: Buffer.from(object.data, "base64").length,
        },
      ];
    }
  }
  for (const a of [
    ...(afterword ? links(afterword) : []),
    ...(preface ? links(preface) : []),
  ]) {
    const m = attr(a, "href").match(/^\/works\/(\d+)$/);
    if (m && m[1] !== id)
      source.relations.push({
        type: /translation of/i.test(clean(a.parent))
          ? "translation_of"
          : /inspired by/i.test(clean(a.parent))
            ? "inspired_by"
            : "related",
        work_id: m[1],
        label: clean(a),
      });
  }
  const urls = new Set<string>();
  for (const node of all(skin, (n) => !!n.name))
    for (const key of [
      "src",
      "poster",
      ...(node.name === "a" ? ["href"] : []),
    ]) {
      const value = attr(node, key);
      if (!value || value.startsWith("#")) continue;
      try {
        const u = new URL(value, base);
        if (
          /^https?:$/.test(u.protocol) &&
          u.hostname !== "archiveofourown.org"
        )
          urls.add(u.href);
      } catch {}
    }
  for (const node of all(skin, (n) => !!attr(n, "srcset")))
    for (const candidate of attr(node, "srcset").split(",")) {
      try {
        const url = new URL(candidate.trim().split(/\s+/)[0], base);
        if (
          /^https?:$/.test(url.protocol) &&
          url.hostname !== "archiveofourown.org"
        )
          urls.add(url.href);
      } catch {}
    }
  for (const object of objects.filter((o) => o.kind === "css"))
    for (const url of cssMediaURLs(
      Buffer.from(object.data, "base64").toString(),
      base,
    ))
      if (new URL(url).hostname !== "archiveofourown.org") urls.add(url);
  SourceBibliography.parse(source);
  const metadata = {
    title: [clean(title)],
    creators: authors.length ? authors.map((a) => a.name) : [clean(byline)],
    language: [clean(dd(meta, "language"))],
    summary: summaryBody ? raw(html, summaryBody) : "",
    chapter_count: count,
    words: statistics.words,
    ao3: source,
  };
  return {
    external_id: id,
    metadata,
    chapters: records,
    objects,
    state: "valid",
    media_urls: [...urls],
    source_hash: sha(canonical({ metadata, chapters: records, objects })),
    observed_at: new Date().toISOString(),
  };
}
export function parseComments(html: string) {
  const root = dom(html),
    comments: any[] = [];
  for (const node of all(root, (n) => /^comment_\d+$/.test(attr(n, "id")))) {
    const body = first(node, (n) => has(n, "userstuff"));
    const deleted =
      has(node, "deleted") ||
      /This comment has been deleted|Previous comment deleted/.test(
        clean(node),
      );
    if (!body && !deleted) continue;
    const author = first(
      node,
      (n) => n.name === "a" && /^\/users\//.test(attr(n, "href")),
    );
    let parent = node.parent;
    while (parent && !/^comment_\d+$/.test(attr(parent, "id")))
      parent = parent.parent;
    const time = first(node, (n) => n.name === "time" || has(n, "datetime"));
    const parentLink = links(node).find(
      (n) => clean(n) === "Parent" && /^\/comments\/\d+$/.test(attr(n, "href")),
    );
    const chapterLink = links(node).find((n) =>
      /\/chapters\/\d+/.test(attr(n, "href")),
    );
    const heading = first(node, (n) => has(n, "byline"));
    const guestName = heading?.children
      ?.filter((n) => n.type === "text")
      .map((n) => n.data ?? "")
      .join("")
      .trim();
    comments.push({
      id: attr(node, "id").slice(8),
      parent_id: parentLink
        ? attr(parentLink, "href").split("/").at(-1)
        : parent
          ? attr(parent, "id").slice(8)
          : null,
      author: clean(author) || guestName || null,
      guest: !author,
      chapter_id: chapterLink
        ? attr(chapterLink, "href").match(/\/chapters\/(\d+)/)?.[1]
        : null,
      ...(author
        ? { author_url: new URL(attr(author, "href"), base).href }
        : {}),
      posted_at: time ? attr(time, "datetime") || clean(time) : null,
      html: body ? raw(html, body) : "",
      deleted,
    });
  }
  const next = links(root).find(
    (n) => attr(n, "rel") === "next" && attr(n, "href").includes("page="),
  );
  return {
    comments: [...new Map(comments.map((c) => [c.id, c])).values()],
    next: next ? attr(next, "href") : null,
    threads: [
      ...new Set(
        links(root)
          .filter(
            (n) =>
              /^\/comments\/\d+$/.test(attr(n, "href")) &&
              /more comments in this thread/i.test(clean(n)),
          )
          .map((n) => attr(n, "href")),
      ),
    ],
  };
}
