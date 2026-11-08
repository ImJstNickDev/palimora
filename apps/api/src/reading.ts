import { alignAnchor, readingPercent } from "@palimora/contracts";
export { alignAnchor } from "@palimora/contracts";
import { createHash } from "node:crypto";
import { Parser } from "htmlparser2";
import { type z } from "zod";
import { TextAnchor } from "@palimora/contracts";
import { DB } from "./db";
import { catalogOperation, loadSnapshot } from "./catalog";
import { collectionAccess, collectionOperation } from "./collections";
import { recordReading } from "./library";
import { fail } from "./security";
type Anchor = z.infer<typeof TextAnchor>;
export function chapterTexts(document: string) {
  const chapters = new Map<string, string>();
  let chapter: string | null = null,
    depth = 0;
  new Parser({
    onopentag(name, attrs) {
      if (chapter) depth++;
      else if (name === "section" && attrs.id?.startsWith("chapter-")) {
        chapter = attrs.id.slice(8);
        depth = 1;
        chapters.set(chapter, "");
      }
    },
    ontext(text) {
      if (chapter) chapters.set(chapter, chapters.get(chapter)! + text);
    },
    onclosetag() {
      if (chapter && --depth === 0) chapter = null;
    },
  }).end(document);
  return chapters;
}
async function textVersion(db: DB, id: string, snapshot?: string) {
  const selected = await loadSnapshot(db, id, snapshot);
  if (!selected.manifest)
    return { snapshot: null, texts: new Map<string, string>() };
  const rendered = await catalogOperation(db, "readerContent", {
    id,
    snapshot: selected.snapshot,
    skin: "off",
    theme: "light",
    font: "serif",
    size: 19,
  });
  return {
    snapshot: selected.snapshot as string,
    texts: chapterTexts(rendered.document),
  };
}
async function validateAnchor(db: DB, id: string, anchor: Anchor) {
  const v = await textVersion(db, id, anchor.snapshot),
    text = v.texts.get(anchor.chapter);
  if (!text || alignAnchor(anchor, v.texts, anchor.snapshot).status !== "exact")
    fail("INVALID_INPUT", 400);
  return (
    readingPercent(
      [...v.texts].map(([chapter, text]) => ({ chapter, length: text.length })),
      anchor,
    ) ?? 0
  );
}
async function resultProgress(
  db: DB,
  id: string,
  user: string,
  snapshot?: string,
) {
  const p = (
    await db.query(
      "SELECT * FROM library_progress WHERE user_id=$1 AND work_id=$2",
      [user, id],
    )
  ).rows[0] ?? { revision: 0, state: "to_read", anchor: null, percent: 0 };
  const v = await textVersion(db, id, snapshot);
  const aligned: {
    anchor: Anchor | null;
    status: "exact" | "moved" | "unresolved";
  } =
    p.anchor && v.snapshot
      ? alignAnchor(p.anchor, v.texts, v.snapshot)
      : { anchor: null, status: "unresolved" as const };
  if (p.anchor && !aligned.anchor && v.snapshot) {
    const text = v.texts.get(p.anchor.chapter);
    if (text?.length)
      aligned.anchor = {
        snapshot: v.snapshot,
        chapter: p.anchor.chapter,
        offset: 0,
        quote: text.slice(0, 80),
        prefix: "",
        suffix: text.slice(80, 112),
      };
  }
  return {
    ...p,
    aligned,
    chapter_lengths: [...v.texts].map(([chapter, text]) => ({
      chapter,
      length: text.length,
    })),
  };
}
export async function readingOperation(
  db: DB,
  op: string,
  x: any,
  user: string,
): Promise<any> {
  if (x.requestId && (op === "readingSave" || op === "annotationSave")) {
    const { requestId, ...input } = x;
    const hash = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      user + requestId,
    ]);
    const receipt = (
      await db.query(
        "SELECT * FROM library_mutation_receipts WHERE user_id=$1 AND request_id=$2",
        [user, requestId],
      )
    ).rows[0];
    if (receipt) {
      if (receipt.operation !== op || receipt.input_hash !== hash)
        fail("CONFLICT", 409);
      return receipt.result;
    }
    const result = await readingOperation(db, op, input, user);
    await db.query(
      "INSERT INTO library_mutation_receipts(user_id,request_id,operation,input_hash,result) VALUES($1,$2,$3,$4,$5)",
      [user, requestId, op, hash, result],
    );
    return result;
  }
  if (op === "readingProgress")
    return resultProgress(db, x.id, user, x.snapshot);
  if (op === "readingSave") {
    const percent = await validateAnchor(db, x.id, x.anchor);
    await db.query(
      "INSERT INTO library_progress(user_id,work_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [user, x.id],
    );
    const p = (
      await db.query(
        "SELECT revision FROM library_progress WHERE user_id=$1 AND work_id=$2 FOR UPDATE",
        [user, x.id],
      )
    ).rows[0];
    if (p.revision !== x.revision) fail("CONFLICT", 409);
    await db.query(
      "UPDATE library_progress SET revision=revision+1,state=$3,anchor=$4,percent=$5 WHERE user_id=$1 AND work_id=$2",
      [user, x.id, x.state, x.anchor, x.state === "completed" ? 100 : percent],
    );
    await db.query(
      "INSERT INTO library_progress_versions(user_id,work_id,revision,state,anchor,percent) SELECT user_id,work_id,revision,state,anchor,percent FROM library_progress WHERE user_id=$1 AND work_id=$2",
      [user, x.id],
    );
    await recordReading(db, user, x.id);
    return resultProgress(db, x.id, user, x.anchor.snapshot);
  }
  if (op === "annotationList") {
    const v = await textVersion(db, x.id, x.snapshot);
    const rows = (
      await db.query(
        `SELECT a.*,u.username FROM library_annotations a JOIN users u ON u.id=a.user_id WHERE a.work_id=$1 AND NOT a.deleted AND ($3::uuid IS NULL OR a.id>$3) AND (a.user_id=$2 OR EXISTS(SELECT 1 FROM library_collections c LEFT JOIN library_members m ON m.collection_id=c.id AND m.user_id=$2 WHERE c.id=a.collection_id AND NOT c.deleted AND (c.owner_id=$2 OR m.accepted))) ORDER BY a.id LIMIT 51`,
        [x.id, user, x.cursor ?? null],
      )
    ).rows;
    return {
      items: rows.slice(0, 50).map((a) => ({
        ...a,
        editable: a.user_id === user,
        aligned: v.snapshot
          ? alignAnchor(a.anchor, v.texts, v.snapshot)
          : { anchor: null, status: "unresolved" },
      })),
      next: rows.length > 50 ? rows[49].id : null,
    };
  }
  if (op === "annotationSave") {
    await validateAnchor(db, x.id, x.anchor);
    const previous = (
      await db.query(
        "SELECT * FROM library_annotations WHERE id=$1 FOR UPDATE",
        [x.annotation_id],
      )
    ).rows[0];
    if (previous && (previous.user_id !== user || previous.work_id !== x.id))
      fail("FORBIDDEN", 403);
    if ((previous?.revision ?? 0) !== x.revision) fail("CONFLICT", 409);
    if (x.collection_id && !x.deleted) {
      await collectionAccess(db, x.collection_id, user, true);
      if (!x.deleted)
        await collectionOperation(
          db,
          "collectionWork",
          { id: x.collection_id, work: x.id, remove: false },
          user,
        );
    }
    if (previous)
      await db.query(
        "UPDATE library_annotations SET body=$2,anchor=$3,collection_id=$4,deleted=$5,revision=revision+1 WHERE id=$1",
        [x.annotation_id, x.body, x.anchor, x.collection_id, x.deleted],
      );
    else
      await db.query(
        "INSERT INTO library_annotations(id,user_id,work_id,body,anchor,collection_id,deleted) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          x.annotation_id,
          user,
          x.id,
          x.body,
          x.anchor,
          x.collection_id,
          x.deleted,
        ],
      );
    await db.query(
      "INSERT INTO library_annotation_versions(id,revision,anchor,body,collection_id,deleted) SELECT id,revision,anchor,body,collection_id,deleted FROM library_annotations WHERE id=$1",
      [x.annotation_id],
    );
    return { ok: true };
  }
  fail("NOT_FOUND", 404);
}
