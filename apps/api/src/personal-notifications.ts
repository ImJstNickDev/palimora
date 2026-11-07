import { DB, transaction } from "./db";
import { loadSnapshot } from "./catalog";
export async function createNotification(
  db: DB,
  user: string,
  kind: "update" | "recommendation",
  work: string,
  source: string | null,
  grouping: number,
) {
  const bucket = grouping
    ? Math.floor(Date.now() / 1000 / grouping)
    : (
        await db.query(
          "SELECT -nextval('personal_notification_bucket') AS bucket",
        )
      ).rows[0].bucket;
  const n = (
    await db.query(
      kind === "update"
        ? `INSERT INTO personal_notifications(user_id,kind,work_id,source_id,bucket) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id,work_id,bucket) WHERE kind='update' DO UPDATE SET versions=personal_notifications.versions+1,updated_at=clock_timestamp(),read_at=NULL RETURNING *`
        : `INSERT INTO personal_notifications(user_id,kind,work_id,source_id,bucket) VALUES($1,$2,$3,$4,$5) ON CONFLICT(source_id) WHERE kind='recommendation' DO NOTHING RETURNING *`,
      [user, kind, work, source, bucket],
    )
  ).rows[0];
  if (!n) return;
  await db.query(
    `INSERT INTO push_deliveries(notification_id,device_id,generation,next_at) SELECT $1,d.id,$2,clock_timestamp()+($3||' seconds')::interval FROM push_devices d JOIN personal_settings p ON p.user_id=d.user_id AND p.push WHERE d.user_id=$4 ON CONFLICT(notification_id,device_id) DO UPDATE SET generation=excluded.generation,failed=false,attempts=0,next_at=least(push_deliveries.next_at,excluded.next_at)`,
    [n.id, n.versions, String(grouping), user],
  );
}
export function contentChange(before: any, after: any) {
  const old = new Map(
    (before?.chapters ?? []).map((c: any) => [c.chapter_id, c.hash]),
  );
  const chapters = after?.chapters ?? [];
  return {
    chapters: chapters.some((c: any) => !old.has(c.chapter_id)),
    changes:
      chapters.length !== old.size ||
      chapters.some((c: any) => old.get(c.chapter_id) !== c.hash),
  };
}
export async function processPersonalEvents() {
  await transaction(async (db) => {
    if (
      !(await db.query("SELECT pg_try_advisory_xact_lock(70210431) AS locked"))
        .rows[0].locked
    )
      return;
    const events = (
      await db.query(
        `SELECT e.*,v.bibliography FROM archive_outbox e JOIN catalog_snapshot_views v ON v.snapshot_id=(e.payload->>'snapshot_id')::uuid WHERE e.event='work.snapshot.published' AND e.producer_xid IS NOT NULL AND NOT EXISTS(SELECT 1 FROM personal_event_receipts p WHERE p.event_id=e.id) ORDER BY e.id LIMIT 20`,
      )
    ).rows;
    for (const event of events) {
      const { work_id: work, snapshot_id: snapshot } = event.payload;
      const previous = (
        await db.query(
          `SELECT payload->>'snapshot_id' AS snapshot FROM archive_outbox WHERE event='work.snapshot.published' AND payload->>'work_id'=$1 AND id<$2 ORDER BY id DESC LIMIT 1`,
          [work, event.id],
        )
      ).rows[0];
      const after = await loadSnapshot(db, work, snapshot),
        before = previous
          ? await loadSnapshot(db, work, previous.snapshot)
          : null;
      const change = contentChange(before?.manifest, after.manifest);
      const targets = (event.bibliography.entities ?? [])
        .filter((e: any) => ["author", "series"].includes(e.kind))
        .map((e: any) => e.id);
      const users = (
        await db.query(
          `SELECT s.user_id,bool_or(s.mode='changes') AS changes,coalesce(p.grouping,300) AS grouping FROM personal_subscriptions s JOIN users u ON u.id=s.user_id AND NOT u.disabled AND u.soft_deleted_at IS NULL LEFT JOIN personal_settings p ON p.user_id=s.user_id WHERE NOT pg_visible_in_snapshot($3::xid8,s.start_snapshot) AND coalesce(p.updates,true) AND ((s.kind='work' AND s.target=$1) OR (s.kind IN ('author','series') AND s.target=ANY($2::text[]))) GROUP BY s.user_id,p.grouping`,
          [work, targets, event.producer_xid],
        )
      ).rows;
      for (const user of users) {
        if (!(change.chapters || (user.changes && change.changes))) continue;
        const inserted = await db.query(
          "INSERT INTO personal_notification_versions VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING snapshot_id",
          [user.user_id, work, snapshot],
        );
        if (inserted.rowCount)
          await createNotification(
            db,
            user.user_id,
            "update",
            work,
            null,
            user.grouping,
          );
      }
      await db.query("INSERT INTO personal_event_receipts VALUES($1)", [
        event.id,
      ]);
    }
  });
}
