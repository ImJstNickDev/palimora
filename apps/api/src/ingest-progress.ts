import { DB } from "./db";
export const progressKey = (cursor: number | string, detail: any = {}) =>
  `${cursor}:${detail.row ?? 0}`;
export async function commitProgress(db: DB, source: any, rows: any[]) {
  const current = (
    await db.query(
      "SELECT checkpoint,checkpoint_detail,fingerprint FROM ingest_sources WHERE id=$1 FOR NO KEY UPDATE",
      [source.id],
    )
  ).rows[0];
  if (!current || current.fingerprint !== source.fingerprint)
    throw Error("SOURCE_CHANGED");
  await db.query(
    `INSERT INTO ingest_progress
    SELECT $1,$2,* FROM unnest($3::text[],$4::text[],$5::bigint[],$6::jsonb[],$7::bigint[],$8::bigint[],$9::bigint[],$10::bigint[])
    ON CONFLICT(source_id,fingerprint,end_key) DO NOTHING`,
    [
      source.id,
      source.fingerprint,
      rows.map((r) => r.previous),
      rows.map((r) => progressKey(r.cursor, r.detail)),
      rows.map((r) => r.cursor),
      rows.map((r) => JSON.stringify(r.detail)),
      rows.map((r) => 1),
      rows.map((r) => r.duplicates),
      rows.map((r) => r.bytes),
      rows.map((r) => r.gaps),
    ],
  );
  await db.query(
    `WITH RECURSIVE chain AS (
    SELECT p.*,1 AS depth FROM ingest_progress p WHERE source_id=$1 AND fingerprint=$2 AND start_key=$3
    UNION ALL SELECT p.*,c.depth+1 FROM ingest_progress p JOIN chain c ON p.start_key=c.end_key
      WHERE p.source_id=$1 AND p.fingerprint=$2
  ), totals AS (SELECT sum(imported) AS imported,sum(duplicates) AS duplicates,sum(bytes) AS bytes,sum(gaps) AS gaps FROM chain),
  last AS (SELECT cursor,detail FROM chain ORDER BY depth DESC LIMIT 1),
  advanced AS (UPDATE ingest_sources s SET checkpoint=l.cursor,checkpoint_detail=l.detail,
    imported=s.imported+t.imported,duplicates=s.duplicates+t.duplicates,bytes=s.bytes+t.bytes,gaps=s.gaps+t.gaps
    FROM last l,totals t WHERE s.id=$1 RETURNING s.id)
  DELETE FROM ingest_progress p USING chain c,advanced a
    WHERE p.source_id=a.id AND p.fingerprint=$2 AND p.end_key=c.end_key`,
    [
      source.id,
      source.fingerprint,
      progressKey(current.checkpoint, current.checkpoint_detail),
    ],
  );
}
