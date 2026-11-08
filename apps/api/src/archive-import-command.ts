/** Corpus import into an empty catalogue. Operator command, not a web path. */
import { openChain, verify, objectBytes } from "@palimora/archive-format";
import { pool, migrate } from "./db";
import { archiveTransaction, preserve, readObject } from "./archive";
import { corpusTables } from "./archive-export";
export async function importCorpus(paths: string[]) {
  const chain = await openChain(paths);
  await verify(chain);
  const catalog = chain.manifest.catalog as any;
  if (
    chain.manifest.format !== "palimora-archive-v1" ||
    catalog?.schema !== "palimora-corpus-catalog-v1"
  )
    throw Error("CORPUS_FORMAT");
  if (
    JSON.stringify(Object.keys(catalog.tables).sort()) !==
    JSON.stringify([...corpusTables].sort())
  )
    throw Error("CORPUS_TABLES");
  await migrate();
  return archiveTransaction(async (db) => {
    const previous = (
      await db.query(
        "SELECT result FROM archive_import_receipts WHERE manifest_hash=$1",
        [chain.hash],
      )
    ).rows[0];
    if (previous) return previous.result;
    if ((await db.query("SELECT 1 FROM archive_work_heads LIMIT 1")).rowCount)
      throw Error("CORPUS_NOT_EMPTY");
    const migrations = (
      await db.query("SELECT name,hash FROM schema_migrations ORDER BY name")
    ).rows;
    if (JSON.stringify(migrations) !== JSON.stringify(catalog.migrations))
      throw Error("CORPUS_SCHEMA");
    const constraints = (
      await db.query(
        "SELECT c.conname,t.relname,c.condeferrable,c.condeferred FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid WHERE c.contype='f' AND t.relnamespace=current_schema()::regnamespace",
      )
    ).rows.filter((r) => corpusTables.includes(r.relname));
    for (const c of constraints)
      await db.query(
        `ALTER TABLE ${c.relname} ALTER CONSTRAINT "${c.conname}" DEFERRABLE INITIALLY DEFERRED`,
      );
    for (const t of corpusTables)
      await db.query(`ALTER TABLE ${t} DISABLE TRIGGER USER`);
    let first: string | undefined,
      objects = 0;
    for (const [hash, entry] of chain.objects)
      if (!["catalog_table", "work_index"].includes(entry.object.kind)) {
        await preserve(db, [
          { kind: entry.object.kind, bytes: await objectBytes(chain, hash) },
        ]);
        first ??= hash;
        objects++;
      }
    if (first) await readObject(db, first);
    for (const table of corpusTables)
      for (const segment of catalog.tables[table]) {
        const text = (await objectBytes(chain, segment)).toString();
        for (const row of text.split("\n").filter(Boolean))
          await db.query(
            `INSERT INTO ${table} OVERRIDING SYSTEM VALUE SELECT * FROM json_populate_record(NULL::${table},$1::json) ON CONFLICT DO NOTHING`,
            [row],
          );
      }
    await db.query("SET CONSTRAINTS ALL IMMEDIATE");
    for (const c of constraints)
      await db.query(
        `ALTER TABLE ${c.relname} ALTER CONSTRAINT "${c.conname}" ${c.condeferrable ? "DEFERRABLE" : "NOT DEFERRABLE"} INITIALLY ${c.condeferred ? "DEFERRED" : "IMMEDIATE"}`,
      );
    for (const table of corpusTables) {
      await db.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
      for (const c of (
        await db.query(
          "SELECT column_name,pg_get_serial_sequence($1,column_name) AS seq FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=$1",
          [table],
        )
      ).rows)
        if (c.seq) {
          const max = (
            await db.query(
              `SELECT coalesce(max("${c.column_name}"),0)::text AS n FROM ${table}`,
            )
          ).rows[0].n;
          await db.query(
            `ALTER SEQUENCE ${c.seq} RESTART WITH ${BigInt(max) + 1n}`,
          );
        }
    }
    await db.query(
      "INSERT INTO catalog_pending SELECT id FROM archive_work_heads ON CONFLICT DO NOTHING; INSERT INTO catalog_snapshot_pending SELECT id FROM archive_snapshot_data ON CONFLICT DO NOTHING; INSERT INTO catalog_text_pending SELECT id FROM archive_work_heads ON CONFLICT DO NOTHING",
    );
    const result = {
      objects,
      works: Number(
        (await db.query("SELECT count(*) FROM archive_work_heads")).rows[0]
          .count,
      ),
    };
    await db.query("INSERT INTO archive_import_receipts VALUES($1,$2)", [
      chain.hash,
      result,
    ]);
    return result;
  });
}
if (require.main === module)
  importCorpus(process.argv.slice(2))
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => {
      console.error("CORPUS_IMPORT_FAILED");
      process.exitCode = 1;
    })
    .finally(() => pool.end());
