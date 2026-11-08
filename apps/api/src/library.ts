import { type Input } from "@palimora/contracts";
import { type DB } from "./db";
import { fail } from "./security";

const projection = `w.id AS work_id, coalesce(nullif(c.title,''),nullif(w.title,''),w.external_id,w.id::text) AS title,
 CASE WHEN b.user_id IS NOT NULL AND NOT b.deleted THEN
 jsonb_build_object('notes',b.notes,'tags',b.tags,'recommended',b.recommended,'private',b.private) END AS bookmark,
 coalesce(b.revision,0) AS revision,coalesce(r.later,false) AS later,r.last_viewed, CASE WHEN p.user_id IS NOT NULL THEN jsonb_build_object('state',p.state,'percent',p.percent) END AS progress`;
const joins = `FROM archive_work_heads w LEFT JOIN catalog_documents c ON c.work_id=w.id
 LEFT JOIN library_bookmarks b ON b.work_id=w.id AND b.user_id=$1
 LEFT JOIN library_readings r ON r.work_id=w.id AND r.user_id=$1 LEFT JOIN library_progress p ON p.work_id=w.id AND p.user_id=$1`;
/** Save without overwriting personal details or advancing an existing revision. */
export async function ensureLibrarySaved(db: DB, user: string, work: string) {
  await db.query(
    `INSERT INTO library_bookmarks(user_id,work_id,revision) VALUES($1,$2,1)
     ON CONFLICT(user_id,work_id) DO UPDATE SET deleted=false,
       revision=library_bookmarks.revision+1,updated_at=now()
     WHERE library_bookmarks.deleted`,
    [user, work],
  );
}
export async function recordReading(db: DB, user: string, work: string) {
  await db.query(
    `INSERT INTO library_readings(user_id,work_id,last_viewed) VALUES($1,$2,now())
    ON CONFLICT(user_id,work_id) DO UPDATE SET last_viewed=now()`,
    [user, work],
  );
}
export async function libraryOperation(
  db: DB,
  op: string,
  input: unknown,
  user: string,
) {
  if (op === "libraryList") {
    const x = input as Input<"libraryList">;
    const rows = (
      await db.query(
        `SELECT ${projection} ${joins}
      WHERE (CASE $2 WHEN 'bookmarks' THEN b.user_id IS NOT NULL AND NOT b.deleted
        WHEN 'later' THEN r.later ELSE r.last_viewed IS NOT NULL END)
      AND ($3::uuid IS NULL OR w.id>$3)
      AND ($4::text IS NULL OR position(lower($4) in lower(coalesce(nullif(c.title,''),w.title,'')||' '||coalesce(b.notes,'')))>0)
      AND ($5::text IS NULL OR $5=ANY(b.tags)) ORDER BY w.id LIMIT 51`,
        [user, x.kind, x.cursor ?? null, x.q || null, x.tag || null],
      )
    ).rows;
    return {
      items: rows.slice(0, 50),
      next: rows.length > 50 ? rows[49].work_id : null,
    };
  }
  const x = input as Input<"bookmarkSave"> & Input<"libraryLater">;
  const work = (
    await db.query(
      "SELECT id FROM archive_work_heads WHERE id=$1 FOR KEY SHARE",
      [x.id],
    )
  ).rows[0];
  if (!work) fail("NOT_FOUND", 404);
  if (op === "librarySave") await ensureLibrarySaved(db, user, x.id);
  if (op === "bookmarkSave") {
    // Tombstones retain the revision so stale clients cannot resurrect a deletion.
    await db.query(
      `INSERT INTO library_bookmarks(user_id,work_id,deleted) VALUES($1,$2,true) ON CONFLICT DO NOTHING`,
      [user, x.id],
    );
    const current = (
      await db.query(
        "SELECT * FROM library_bookmarks WHERE user_id=$1 AND work_id=$2 FOR UPDATE",
        [user, x.id],
      )
    ).rows[0];
    if (current.revision !== x.revision) fail("CONFLICT", 409);
    const b = x.bookmark;
    await db.query(
      `UPDATE library_bookmarks SET notes=$3,tags=$4,recommended=$5,private=$6,deleted=$7,revision=revision+1,updated_at=now()
      WHERE user_id=$1 AND work_id=$2`,
      [
        user,
        x.id,
        b?.notes ?? "",
        [...new Set(b?.tags ?? [])],
        b?.recommended ?? false,
        b?.private ?? true,
        !b,
      ],
    );
  }
  if (op === "libraryLater") {
    await db.query(
      `INSERT INTO library_readings(user_id,work_id,later) VALUES($1,$2,$3)
      ON CONFLICT(user_id,work_id) DO UPDATE SET later=excluded.later`,
      [user, x.id, x.later],
    );
    return { ok: true };
  }
  if (op === "libraryForget") {
    await db.query(
      "UPDATE library_readings SET last_viewed=NULL WHERE user_id=$1 AND work_id=$2",
      [user, x.id],
    );
    return { ok: true };
  }
  return (
    await db.query(`SELECT ${projection} ${joins} WHERE w.id=$2`, [user, x.id])
  ).rows[0];
}
