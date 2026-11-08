import { randomUUID, createHash, createECDH } from "node:crypto";
import { DB } from "./db";
import { fail, seal } from "./security";
import { createNotification } from "./personal-notifications";
import { pushKeys, checkPushURL } from "./web-push";
export async function settings(db: DB, user: string) {
  await db.query(
    "INSERT INTO personal_settings(user_id) VALUES($1) ON CONFLICT DO NOTHING",
    [user],
  );
  return (
    await db.query("SELECT * FROM personal_settings WHERE user_id=$1", [user])
  ).rows[0];
}
async function preferences(db: DB, user: string) {
  const p = await settings(db, user);
  for (const key of ["activity_users"])
    p[key] = (
      await db.query(
        "SELECT username FROM users WHERE id=ANY($1::uuid[]) ORDER BY username",
        [p[key]],
      )
    ).rows.map((r) => r.username);
  // Legacy sharing settings remain stored, but are no longer exposed or applied.
  delete p.statistics;
  delete p.statistics_users;
  return p;
}
export async function sharedUser(
  db: DB,
  user: string,
  username: string | undefined,
  scope: "activity",
) {
  if (!username) return user;
  const target = (
    await db.query(
      "SELECT id FROM users WHERE lower(username)=lower($1) AND NOT disabled AND soft_deleted_at IS NULL",
      [username],
    )
  ).rows[0];
  if (!target) fail("NOT_FOUND", 404);
  if (target.id === user) return user;
  const p = (
    await db.query(
      `SELECT 1 FROM personal_settings WHERE user_id=$1 AND (${scope}='instance' OR (${scope}='selected' AND $2=ANY(${scope}_users)))`,
      [target.id, user],
    )
  ).rowCount;
  if (!p) fail("NOT_FOUND", 404);
  return target.id;
}
export async function statistics(db: DB, user: string) {
  const completed = `WITH done AS (SELECT DISTINCT ON(work_id) work_id,anchor,created_at FROM library_progress_versions WHERE user_id=$1 AND state='completed' ORDER BY work_id,revision)`;
  const totals = (
    await db.query(
      `${completed} SELECT count(*)::int AS completed, sum(CASE WHEN v.metadata->>'words' ~ '^[0-9]+$' THEN (v.metadata->>'words')::numeric END)::float8 AS words,count(*) FILTER(WHERE v.metadata->>'words' IS NULL OR NOT (v.metadata->>'words' ~ '^[0-9]+$'))::int AS unknown_words FROM done LEFT JOIN catalog_snapshot_views v ON v.snapshot_id=(anchor->>'snapshot')::uuid`,
      [user],
    )
  ).rows[0];
  const works = Number(
    (
      await db.query(
        "SELECT count(DISTINCT work_id) FROM library_progress_versions WHERE user_id=$1",
        [user],
      )
    ).rows[0].count,
  );
  const seconds = Number(
    (
      await db.query(
        "SELECT coalesce(sum(extract(epoch FROM upper(r)-lower(r))),0)::float8 AS seconds FROM (SELECT unnest(range_agg(span)) AS r FROM reading_intervals WHERE user_id=$1) t",
        [user],
      )
    ).rows[0].seconds,
  );
  const fandoms = (
    await db.query(
      `WITH read AS (SELECT DISTINCT work_id FROM library_progress_versions WHERE user_id=$1) SELECT t.name,count(DISTINCT r.work_id)::int AS works FROM read r JOIN catalog_work_tags wt ON wt.work_id=r.work_id JOIN catalog_tags t ON t.id=wt.tag_id AND t.kind='fandom' GROUP BY t.name ORDER BY works DESC,t.name LIMIT 20`,
      [user],
    )
  ).rows;
  const timeline = (
    await db.query(
      `${completed} SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD') AS day,count(*)::int AS completed FROM done GROUP BY day ORDER BY day`,
      [user],
    )
  ).rows;
  return {
    ...totals,
    words: totals.completed === 0 ? 0 : totals.words,
    works,
    seconds,
    measured_since: (await db.query("SELECT started_at FROM personal_runtime"))
      .rows[0].started_at,
    fandoms,
    timeline,
  };
}
export async function socialOperation(
  db: DB,
  op: string,
  x: any,
  user: string,
  session: string,
) {
  if (op === "socialPreferences") return preferences(db, user);
  if (op === "socialPreferencesSave") {
    const p = await settings(db, user);
    if (p.revision !== x.revision) fail("CONFLICT", 409);
    const recipients: Record<string, string[]> = {};
    for (const key of ["activity_users"]) {
      const names = [
        ...new Set<string>(x[key].map((n: string) => n.toLowerCase())),
      ];
      const rows = (
        await db.query(
          "SELECT id FROM users WHERE lower(username)=ANY($1::text[]) AND NOT disabled AND soft_deleted_at IS NULL",
          [names],
        )
      ).rows;
      if (rows.length !== names.length) fail("INVALID_INPUT", 400);
      recipients[key] = rows.map((r) => r.id);
    }
    await db.query(
      "UPDATE personal_settings SET activity=$2,activity_users=$3,recommendations=$4,updates=$5,push=$6,grouping=$7,revision=revision+1 WHERE user_id=$1",
      [
        user,
        x.activity,
        recipients.activity_users,
        x.recommendations,
        x.updates,
        x.push,
        x.grouping,
      ],
    );
    return preferences(db, user);
  }
  if (op === "personalStatistics") {
    if (x.username !== undefined) fail("INVALID_INPUT", 400);
    return statistics(db, user);
  }
  if (op === "personalActivity") {
    const target = await sharedUser(db, user, x.username, "activity");
    const rows = (
      await db.query(
        `SELECT p.work_id AS id,coalesce(nullif(c.title,''),nullif(w.title,''),w.id::text) AS title,p.state,p.percent FROM library_progress p JOIN archive_work_heads w ON w.id=p.work_id LEFT JOIN catalog_documents c ON c.work_id=w.id WHERE p.user_id=$1 AND ($2::uuid IS NULL OR p.work_id>$2) ORDER BY p.work_id LIMIT 51`,
        [target, x.cursor ?? null],
      )
    ).rows;
    return {
      items: rows.slice(0, 50),
      next: rows.length > 50 ? rows[49].id : null,
    };
  }
  if (op === "readingHeartbeat") {
    if (x.active === false) {
      await db.query("DELETE FROM reading_heartbeat WHERE session_id=$1", [
        session,
      ]);
      return { ok: true };
    }
    if (
      !(
        await db.query(
          "SELECT 1 FROM library_progress WHERE user_id=$1 AND work_id=$2",
          [user, x.id],
        )
      ).rowCount
    )
      return { ok: true };
    if (
      (
        await db.query("SELECT 1 FROM reading_intervals WHERE id=$1", [
          x.requestId,
        ])
      ).rowCount
    )
      return { ok: true };
    const old = (
      await db.query(
        "SELECT * FROM reading_heartbeat WHERE session_id=$1 FOR UPDATE",
        [session],
      )
    ).rows[0];
    if (old?.work_id === x.id)
      await db.query(
        `INSERT INTO reading_intervals(id,user_id,work_id,span) SELECT $1,$2,$3,tstzrange($4,clock_timestamp(),'[)') WHERE clock_timestamp()-$4::timestamptz BETWEEN interval '5 seconds' AND interval '25 seconds' ON CONFLICT DO NOTHING`,
        [x.requestId, user, x.id, old.last_at],
      );
    await db.query(
      "INSERT INTO reading_intervals(id,user_id,work_id,span) VALUES($1,$2,$3,'empty') ON CONFLICT DO NOTHING",
      [x.requestId, user, x.id],
    );
    await db.query(
      "INSERT INTO reading_heartbeat VALUES($1,$2,clock_timestamp()) ON CONFLICT(session_id) DO UPDATE SET work_id=excluded.work_id,last_at=excluded.last_at",
      [session, x.id],
    );
    return { ok: true };
  }
  if (op === "recommendationRecipients") {
    const rows = (
      await db.query(
        `SELECT u.username FROM users u LEFT JOIN personal_settings p ON p.user_id=u.id
         WHERE u.id<>$1 AND NOT u.disabled AND u.soft_deleted_at IS NULL
           AND coalesce(p.recommendations,true)
           AND strpos(lower(u.username),lower($2))>0
           AND ($3::text IS NULL OR lower(u.username)>lower($3))
         ORDER BY lower(u.username) LIMIT 51`,
        [user, x.q ?? "", x.cursor ?? null],
      )
    ).rows;
    return {
      items: rows.slice(0, 50),
      next: rows.length > 50 ? rows[49].username : null,
    };
  }
  if (op === "recommendWork") {
    const recipient = (
      await db.query(
        "SELECT id FROM users WHERE lower(username)=lower($1) AND NOT disabled AND soft_deleted_at IS NULL",
        [x.username],
      )
    ).rows[0];
    if (!recipient || recipient.id === user) fail("INVALID_INPUT", 400);
    const p = await settings(db, recipient.id);
    if (!p.recommendations) fail("FORBIDDEN", 403);
    if (
      !(
        await db.query("SELECT 1 FROM archive_work_heads WHERE id=$1", [x.work])
      ).rowCount
    )
      fail("NOT_FOUND", 404);
    const inserted = await db.query(
      "INSERT INTO personal_recommendations(id,sender_id,recipient_id,work_id,note) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id",
      [x.requestId, user, recipient.id, x.work, x.note],
    );
    if (inserted.rowCount)
      await createNotification(
        db,
        recipient.id,
        "recommendation",
        x.work,
        x.requestId,
        0,
      );
    return { ok: true };
  }
  if (op === "subscriptionStatus")
    return {
      mode:
        (
          await db.query(
            "SELECT mode FROM personal_subscriptions WHERE user_id=$1 AND kind=$2 AND target=$3",
            [user, x.kind, x.target],
          )
        ).rows[0]?.mode ?? null,
    };
  if (op === "subscriptionSave") {
    const valid =
      x.kind === "work"
        ? await db.query("SELECT 1 FROM archive_work_heads WHERE id::text=$1", [
            x.target,
          ])
        : await db.query(
            "SELECT 1 FROM catalog_entities WHERE id=$1 AND kind=$2",
            [x.target, x.kind],
          );
    if (!valid.rowCount) fail("NOT_FOUND", 404);
    if (x.mode)
      await db.query(
        "INSERT INTO personal_subscriptions(user_id,kind,target,mode) VALUES($1,$2,$3,$4) ON CONFLICT(user_id,kind,target) DO UPDATE SET mode=excluded.mode",
        [user, x.kind, x.target, x.mode],
      );
    else
      await db.query(
        "DELETE FROM personal_subscriptions WHERE user_id=$1 AND kind=$2 AND target=$3",
        [user, x.kind, x.target],
      );
    return { ok: true };
  }
  if (op === "subscriptions") {
    const rows = (
      await db.query(
        `SELECT s.kind,s.target,s.mode,coalesce(e.name,nullif(c.title,''),w.title,s.target) AS name FROM personal_subscriptions s LEFT JOIN archive_work_heads w ON w.id::text=s.target AND s.kind='work' LEFT JOIN catalog_documents c ON c.work_id=w.id LEFT JOIN catalog_entities e ON e.id=s.target AND e.kind=s.kind WHERE s.user_id=$1 AND ($2::text IS NULL OR s.kind||':'||s.target>$2) ORDER BY s.kind,s.target LIMIT 51`,
        [user, x.cursor ?? null],
      )
    ).rows;
    return {
      items: rows.slice(0, 50),
      next: rows.length > 50 ? rows[49].kind + ":" + rows[49].target : null,
    };
  }
  if (op === "notifications") {
    const rows = (
      await db.query(
        `SELECT n.*,coalesce(nullif(c.title,''),w.title,w.id::text) AS title,u.username AS sender,r.note FROM personal_notifications n JOIN archive_work_heads w ON w.id=n.work_id LEFT JOIN catalog_documents c ON c.work_id=w.id LEFT JOIN personal_recommendations r ON r.id=n.source_id AND r.recipient_id=$1 LEFT JOIN users u ON u.id=r.sender_id WHERE n.user_id=$1 AND ($2::uuid IS NULL OR (n.updated_at,n.id)<(SELECT updated_at,id FROM personal_notifications WHERE id=$2 AND user_id=$1)) AND ($3='false' OR n.read_at IS NULL) ORDER BY n.updated_at DESC,n.id DESC LIMIT 51`,
        [user, x.cursor ?? null, x.unread],
      )
    ).rows;
    return {
      items: rows.slice(0, 50),
      next: rows.length > 50 ? rows[49].id : null,
      unread: Number(
        (
          await db.query(
            "SELECT count(*) FROM personal_notifications WHERE user_id=$1 AND read_at IS NULL",
            [user],
          )
        ).rows[0].count,
      ),
    };
  }
  if (op === "notificationRead") {
    if (
      !(
        await db.query(
          "UPDATE personal_notifications SET read_at=CASE WHEN $3 THEN clock_timestamp() ELSE NULL END WHERE id=$1 AND user_id=$2 RETURNING id",
          [x.id, user, x.read],
        )
      ).rowCount
    )
      fail("NOT_FOUND", 404);
    return { ok: true };
  }
  if (op === "pushDevices") {
    const keys = await pushKeys(db);
    return {
      publicKey: keys.publicKey,
      devices: (
        await db.query(
          "SELECT id,name,session_id=$2 AS current,last_error FROM push_devices WHERE user_id=$1 ORDER BY created_at",
          [user, session],
        )
      ).rows,
    };
  }
  if (op === "pushRegister") {
    await db.query("SELECT pg_advisory_xact_lock(70210432)");
    try {
      const ecdh = createECDH("prime256v1");
      ecdh.generateKeys();
      ecdh.computeSecret(Buffer.from(x.keys.p256dh, "base64url"));
    } catch {
      fail("INVALID_INPUT", 400);
    }
    checkPushURL(x.endpoint);
    const hash = createHash("sha256").update(x.endpoint).digest("hex");
    await db.query(
      "DELETE FROM push_devices WHERE endpoint_hash=$1 AND (user_id<>$2 OR session_id<>$3)",
      [hash, user, session],
    );
    await db.query(
      "INSERT INTO push_devices(id,user_id,session_id,endpoint_hash,subscription,name) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(endpoint_hash) DO UPDATE SET subscription=excluded.subscription,name=excluded.name,last_error=NULL",
      [
        randomUUID(),
        user,
        session,
        hash,
        seal(JSON.stringify({ endpoint: x.endpoint, keys: x.keys })),
        x.name,
      ],
    );
    await db.query(
      "UPDATE push_deliveries SET failed=false,attempts=0,next_at=clock_timestamp() WHERE sent_generation<generation AND device_id IN(SELECT id FROM push_devices WHERE user_id=$1 AND endpoint_hash=$2)",
      [user, hash],
    );
    return { ok: true };
  }
  if (op === "pushRevoke") {
    await db.query("SELECT pg_advisory_xact_lock(70210432)");
    await db.query("DELETE FROM push_devices WHERE id=$1 AND user_id=$2", [
      x.id,
      user,
    ]);
    return { ok: true };
  }
  fail("NOT_FOUND", 404);
}
