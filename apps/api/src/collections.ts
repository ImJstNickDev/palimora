import { DB } from "./db";
import { fail } from "./security";
import { ensureLibrarySaved } from "./library";
export async function collectionAccess(
  db: DB,
  id: string,
  user: string,
  write = false,
  owner = false,
) {
  const c = (
    await db.query(
      `SELECT c.*,CASE WHEN c.owner_id=$2 THEN 'Owner' ELSE m.role END AS role,
 (c.owner_id=$2 OR coalesce(m.accepted,false)) AS accepted FROM library_collections c LEFT JOIN library_members m ON m.collection_id=c.id AND m.user_id=$2 WHERE c.id=$1 AND NOT c.deleted FOR UPDATE OF c`,
      [id, user],
    )
  ).rows[0];
  if (!c || !c.accepted) fail("NOT_FOUND", 404);
  if ((owner && c.role !== "Owner") || (write && c.role === "Viewer"))
    fail("FORBIDDEN", 403);
  return c;
}
export async function collectionOperation(
  db: DB,
  op: string,
  x: any,
  user: string,
) {
  await db.query("SELECT set_config('palimora.user',$1,true)", [user]);
  if (op === "collectionList") {
    const rows = (
      await db.query(
        `SELECT c.id,c.name,c.description,c.revision,CASE WHEN owner_id=$1 THEN 'Owner' ELSE m.role END AS role,(owner_id=$1 OR m.accepted) AS accepted,
         coalesce((owner_id=$1 OR m.accepted) AND EXISTS(SELECT 1 FROM library_collection_works cw WHERE cw.collection_id=c.id AND cw.work_id=$4),false) AS contains_work
         FROM library_collections c LEFT JOIN library_members m ON m.collection_id=c.id AND m.user_id=$1 WHERE NOT c.deleted AND (owner_id=$1 OR m.user_id=$1) AND ($2::uuid IS NULL OR c.id>$2) AND c.name ILIKE '%'||$3||'%' ORDER BY c.id LIMIT 51`,
        [user, x.cursor ?? null, x.q ?? "", x.work ?? null],
      )
    ).rows;
    return {
      items: rows.slice(0, 50),
      next: rows.length > 50 ? rows[49].id : null,
    };
  }
  if (op === "collectionCreate") {
    await db.query(
      "INSERT INTO library_collections(id,owner_id,name,description) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [x.id, user, x.name, x.description],
    );
    await collectionAccess(db, x.id, user, false, true);
    return { ok: true };
  }
  if (op === "collectionRespond") {
    const c = (
      await db.query(
        "SELECT * FROM library_collections WHERE id=$1 AND NOT deleted FOR UPDATE",
        [x.id],
      )
    ).rows[0];
    if (!c) fail("NOT_FOUND", 404);
    if (c.owner_id === user) fail("FORBIDDEN", 403);
    if (x.accept)
      await db.query(
        "UPDATE library_members SET accepted=true WHERE collection_id=$1 AND user_id=$2",
        [x.id, user],
      );
    else
      await db.query(
        "DELETE FROM library_members WHERE collection_id=$1 AND user_id=$2",
        [x.id, user],
      );
    return { ok: true };
  }
  const c = await collectionAccess(
    db,
    x.id,
    user,
    ["collectionWork", "collectionUpdate"].includes(op),
    op === "collectionMember" || (op === "collectionUpdate" && x.deleted),
  );
  if (op === "collectionDetail") {
    const members = (
      await db.query(
        `SELECT u.id AS user_id,u.username,m.role,m.accepted FROM library_members m JOIN users u ON u.id=m.user_id WHERE m.collection_id=$1 UNION ALL SELECT id,username,'Owner',true FROM users WHERE id=$2 ORDER BY username`,
        [x.id, c.owner_id],
      )
    ).rows;
    const works = (
      await db.query(
        `SELECT w.id,coalesce(nullif(d.title,''),nullif(w.title,''),w.external_id,w.id::text) AS title FROM library_collection_works i JOIN archive_work_heads w ON w.id=i.work_id LEFT JOIN catalog_documents d ON d.work_id=w.id WHERE collection_id=$1 AND ($2::uuid IS NULL OR w.id>$2) ORDER BY w.id LIMIT 51`,
        [x.id, x.cursor ?? null],
      )
    ).rows;
    return {
      collection: c,
      members,
      works: works.slice(0, 50),
      next: works.length > 50 ? works[49].id : null,
    };
  }
  if (op === "collectionUpdate") {
    if (c.revision !== x.revision) fail("CONFLICT", 409);
    await db.query(
      "UPDATE library_collections SET name=$2,description=$3,deleted=$4,revision=revision+1 WHERE id=$1",
      [x.id, x.name, x.description, x.deleted],
    );
  }
  if (op === "collectionMember") {
    const member = (
      await db.query(
        "SELECT id FROM users WHERE lower(username)=lower($1) AND NOT disabled AND soft_deleted_at IS NULL",
        [x.username],
      )
    ).rows[0];
    if (!member) fail("NOT_FOUND", 404);
    if (member.id === c.owner_id) fail("FORBIDDEN", 403);
    if (x.role)
      await db.query(
        "INSERT INTO library_members(collection_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT(collection_id,user_id) DO UPDATE SET role=excluded.role",
        [x.id, member.id, x.role],
      );
    else
      await db.query(
        "DELETE FROM library_members WHERE collection_id=$1 AND user_id=$2",
        [x.id, member.id],
      );
  }
  if (op === "collectionWork") {
    if (
      !(
        await db.query("SELECT 1 FROM archive_work_heads WHERE id=$1", [x.work])
      ).rowCount
    )
      fail("NOT_FOUND", 404);
    if (x.remove)
      await db.query(
        "DELETE FROM library_collection_works WHERE collection_id=$1 AND work_id=$2",
        [x.id, x.work],
      );
    else {
      await db.query(
        "INSERT INTO library_collection_works VALUES($1,$2) ON CONFLICT DO NOTHING",
        [x.id, x.work],
      );
      await ensureLibrarySaved(db, user, x.work);
    }
  }
  return { ok: true };
}
