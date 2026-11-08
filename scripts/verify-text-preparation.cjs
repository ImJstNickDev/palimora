// Differential preparation on a separate schema and synthetic, writable packs.
const assert = require("node:assert/strict"),
  fs = require("node:fs/promises");
const { randomUUID, createHash } = require("node:crypto"),
  { Pool } = require("pg");
const url = new URL(process.env.DATABASE_URL);
if (!url.pathname.endsWith("_test")) throw Error("Test DB required");
const admin = new Pool({ connectionString: url.toString() });
const schema = "test_text_" + randomUUID().replaceAll("-", "");
url.searchParams.set("options", "-c search_path=" + schema);
process.env.DATABASE_URL = url.toString();
process.env.ARCHIVE_ROOT = "/results/" + schema;
const { pool, migrate, transaction } = require("../apps/api/dist/db");
const archive = require("../apps/api/dist/archive"),
  catalog = require("../apps/api/dist/catalog");
const search = require("../apps/api/dist/catalog-search"),
  old = require("../apps/api/p2a-dist/catalog-search");
const oldCatalog = require("../apps/api/p2a-dist/catalog");
const {
  loadTextInputs,
  selectTextGroup,
} = require("../apps/api/dist/catalog-text-preparation");
const { claimText } = require("../apps/api/dist/catalog-text-bulk");
const bib = require("../apps/api/dist/catalog-bibliography");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const report = {};
const expectedDocs = new Map();
const testIndex = "palimora-" + schema;
search.SEARCH_INDEX = testIndex;
search.SEARCH_WRITE_ALIAS = testIndex + "-write";
(async () => {
  await admin.query("CREATE SCHEMA " + schema);
  await migrate();
  const batch = randomUUID(),
    source = {
      id: randomUUID(),
      path: "text-preparation-fixture",
      fingerprint: "v1",
    };
  await pool.query(
    "INSERT INTO ingest_batches(id,state) VALUES($1,'running')",
    [batch],
  );
  await pool.query(
    "INSERT INTO ingest_sources(id,batch_id,path,fingerprint,state) VALUES($1,$2,$3,$4,'valid')",
    [source.id, batch, source.path, source.fingerprint],
  );
  const chapter = Buffer.from("<p>Shared α story</p>"),
    note = Buffer.from("<aside>Shared note</aside>");
  let cursor = 0;
  for (let w = 0; w < 5; w++)
    for (let v = 0; v < (w === 0 ? 2 : 1); v++) {
      const large = w === 4;
      const workNote =
        w === 3
          ? Buffer.from("<aside>" + "shared ".repeat(1400000) + "</aside>")
          : note;
      const first = large
        ? Buffer.from("<p>" + "large ".repeat(3 * 1024 * 1024) + "</p>")
        : chapter;
      const raw = Buffer.concat([
        first.subarray(0, 3),
        workNote,
        first.subarray(3),
      ]);
      const record = {
        external_id: String(100000 + w),
        source_entry: "work-" + w + "-" + v,
        state: "valid",
        observed_at: `2026-01-0${v + 1}T00:00:00Z`,
        metadata:
          w === 2
            ? {}
            : {
                title: ["Fixture " + w + " version " + v],
                creators: ["Author"],
                language: ["English"],
                fandom: ["F1", "F2"],
                relationships: ["R1", "R2"],
              },
        chapters: [
          {
            name: "one",
            notes: [{ name: "chapter-note", offset: 3 }],
            source_html_sha256: sha(raw),
          },
          {
            name: "two",
            notes: [{ name: "chapter-note", offset: 3 }],
            source_html_sha256: sha(
              Buffer.from(
                "<p>" + workNote.toString() + "Second " + w + " " + v + "</p>",
              ),
            ),
          },
        ],
        objects: [
          { name: "one", kind: "chapter_html", data: first.toString("base64") },
          {
            name: "two",
            kind: "chapter_html",
            data: Buffer.from("<p>Second " + w + " " + v + "</p>").toString(
              "base64",
            ),
          },
          {
            name: "chapter-note",
            kind: "notes_html",
            data: workNote.toString("base64"),
          },
          {
            name: "preface",
            kind: "notes_html",
            data: Buffer.from("<p>Shared preface</p>").toString("base64"),
          },
        ],
      };
      await archive.ingestRecords(
        source,
        [{ record, locator: String(++cursor), parser: "text-fixture", cursor }],
        { authoritative: true },
      );
    }
  await catalog.projectCatalog(32, 32);
  const rows = (
    await pool.query("SELECT * FROM catalog_documents ORDER BY work_id")
  ).rows;
  const first = rows.find((r) =>
    r.metadata.title?.[0]?.startsWith("Fixture 0"),
  );
  const alias = rows.find((r) =>
    r.metadata.title?.[0]?.startsWith("Fixture 1"),
  );
  await pool.query(
    "INSERT INTO archive_identity_links(work_id,canonical_work_id) VALUES($1,$2)",
    [alias.work_id, first.work_id],
  );
  await transaction(async (db) => {
    const tags = {};
    for (const [kind, names] of [
      ["fandom", ["F1", "F2", "Parent", "Unrelated", "Ancestor"]],
      ["relationships", ["R1", "R2", "Pair", "Other", "CanonicalPair"]],
    ])
      for (const name of names)
        tags[name] = (
          await bib.ensureTag(db, {
            kind,
            name,
            id: "source-" + name,
            canonical: true,
          })
        ).id;
    await db.query(
      "INSERT INTO catalog_tag_edges VALUES($1,$3,'meta'),($2,$3,'synonym'),($4,$6,'synonym'),($5,$6,'synonym')",
      [tags.F1, tags.F2, tags.Parent, tags.R1, tags.R2, tags.Pair],
    );
    await db.query(
      "INSERT INTO catalog_tag_edges VALUES($1,$2,'meta'),($3,$4,'synonym')",
      [tags.Parent, tags.Ancestor, tags.Pair, tags.CanonicalPair],
    );
    for (const row of rows) {
      if (row.work_id === rows.find((r) => !r.metadata.title)?.work_id)
        continue;
      const separate = row.metadata.title?.[0]?.startsWith("Fixture 3");
      const names = separate
        ? ["F1", "Unrelated", "R1", "Other"]
        : ["F1", "F2", "R1", "R2"];
      if (separate)
        await db.query(
          "UPDATE catalog_documents SET metadata=metadata||$2::jsonb WHERE work_id=$1",
          [
            row.work_id,
            JSON.stringify({
              fandom: ["F1", "Unrelated"],
              relationships: ["R1", "Other"],
            }),
          ],
        );
      if (row.work_id === alias.work_id)
        await db.query(
          "UPDATE catalog_documents SET metadata=metadata||$2::jsonb WHERE work_id=$1",
          [row.work_id, JSON.stringify({ crossover: true, otp: false })],
        );
      await db.query("DELETE FROM catalog_work_tags WHERE work_id=$1", [
        row.work_id,
      ]);
      const evidence = names.map((name) => ({
        id: tags[name],
        name,
        kind: ["F1", "F2", "Unrelated"].includes(name)
          ? "fandom"
          : "relationships",
        source_id: "source-" + name,
      }));
      await db.query(
        "UPDATE catalog_documents SET bibliography=jsonb_set(bibliography,'{tags}',$2::jsonb) WHERE work_id=$1",
        [row.work_id, JSON.stringify(evidence)],
      );
      for (const t of evidence)
        await db.query(
          "INSERT INTO catalog_work_tags(work_id,tag_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
          [row.work_id, t.id],
        );
    }
  });
  const current = (
    await pool.query("SELECT * FROM catalog_documents ORDER BY work_id")
  ).rows;
  const reads = [];
  const readMany = archive.store.readMany.bind(archive.store);
  archive.store.readMany = async (records, ...args) => {
    reads.push(records.map((r) => ({ hash: r.hash, size: r.size })));
    return readMany(records, ...args);
  };
  await transaction(async (db) => {
    await db.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
    );
    const inputs = await loadTextInputs(db, current);
    const batchReads = reads.flat().map((r) => r.hash);
    for (const row of current) {
      const actual = await search.prepareTextDocument(
        db,
        row,
        inputs.get(row.work_id),
      );
      const expected = await old.prepareTextDocument(db, row);
      assert.deepEqual(actual, expected);
      expectedDocs.set(row.work_id, JSON.parse(JSON.stringify(expected)));
      if (row.metadata.fandom?.length > 1) {
        const separate =
          row.metadata.title?.[0]?.startsWith("Fixture 3") ||
          row.work_id === alias.work_id;
        assert.equal(actual.crossover, separate);
        assert.equal(actual.otp, !separate);
      }
    }
    // Shared chapter and note objects occur only once within a bounded window.
    assert.ok(
      batchReads.filter((h) => h === sha(chapter)).length < current.length,
    );
    assert.ok(
      batchReads.filter((h) => h === sha(note)).length < current.length,
    );
    const bad = new Map();
    for (const row of current) {
      const { manifest } = await catalog.loadSnapshot(
        db,
        row.work_id,
        row.snapshot_id,
      );
      bad.set(row.work_id, manifest);
    }
    const changed = structuredClone(bad.get(current[0].work_id));
    changed.chapters[0].hash = "0".repeat(64);
    bad.set(current[0].work_id, changed);
    const missing = await loadTextInputs(db, current, bad);
    assert.ok(missing.get(current[0].work_id) instanceof Error);
    for (const row of current.slice(1))
      assert.ok(!(missing.get(row.work_id) instanceof Error));
  });
  archive.store.readMany = readMany;
  report.multichapter_shared_notes_incomplete_metadata_alias_graph_crossover_otp = true;
  report.missing_object_isolated = true;
  // The reader and historical views use the same reconstruction contract.
  await transaction(async (db) => {
    for (const snap of (
      await db.query("SELECT id,work_id FROM archive_snapshots ORDER BY id")
    ).rows) {
      assert.deepEqual(
        await catalog.catalogOperation(db, "readerWork", {
          id: snap.work_id,
          snapshot: snap.id,
        }),
        await oldCatalog.catalogOperation(db, "readerWork", {
          id: snap.work_id,
          snapshot: snap.id,
        }),
      );
      assert.deepEqual(
        await catalog.catalogOperation(db, "readerContent", {
          id: snap.work_id,
          snapshot: snap.id,
        }),
        await oldCatalog.catalogOperation(db, "readerContent", {
          id: snap.work_id,
          snapshot: snap.id,
        }),
      );
    }
  });
  report.historical_reader_equivalence = true;
  // A genuinely corrupted native frame is isolated from the remaining works.
  const target = current.find((r) =>
    r.metadata.title?.[0]?.startsWith("Fixture 3"),
  );
  const m = await transaction(
    async (db) =>
      (await catalog.loadSnapshot(db, target.work_id, target.snapshot_id))
        .manifest,
  );
  const loc = (
    await pool.query("SELECT * FROM archive_objects WHERE hash=$1", [
      m.chapters[1].hash,
    ])
  ).rows[0];
  const file = await fs.open(
    process.env.ARCHIVE_ROOT + "/packs/" + loc.pack,
    "r+",
  );
  const at = Number(loc.byte_offset) + Number(loc.length) - 1;
  const original = Buffer.alloc(1);
  await file.read(original, 0, 1, at);
  await file.write(Buffer.from([original[0] ^ 255]), 0, 1, at);
  try {
    await transaction(async (db) => {
      const input = await loadTextInputs(db, current);
      assert.ok(input.get(target.work_id) instanceof Error);
      for (const row of current.filter((r) => r.work_id !== target.work_id))
        assert.ok(!(input.get(row.work_id) instanceof Error));
    });
  } finally {
    await file.write(original, 0, 1, at);
    await file.close();
  }
  report.corrupt_object_isolated = true;
  await pool.query(
    "INSERT INTO catalog_text_pending(work_id) SELECT work_id FROM catalog_documents ON CONFLICT(work_id) DO UPDATE SET work_id=excluded.work_id",
  );
  const claims = await claimText(16);
  await transaction(async (db) => {
    await db.query(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY",
    );
    const priority = (claim) => {
      const title =
        current.find((r) => r.work_id === claim.work_id).metadata.title?.[0] ??
        "";
      return title.startsWith("Fixture 3")
        ? 0
        : title.startsWith("Fixture 4")
          ? 2
          : 1;
    };
    const remaining = [...claims].sort((a, b) => priority(a) - priority(b));
    let groups = 0;
    while (remaining.length) {
      const group = await selectTextGroup(db, remaining);
      assert.ok(group.consumed > 0);
      if (
        group.rows.some((r) =>
          /^Fixture [34]/.test(r.metadata.title?.[0] ?? ""),
        )
      )
        assert.equal(group.rows.length, 1);
      remaining.splice(0, group.consumed);
      groups++;
    }
    assert.ok(groups >= 2);
  });
  report.large_work_isolated_by_byte_budget = true;
  report.shared_note_occurrences_counted_in_reconstruction_budget = true;
  const bad = current.find((r) =>
    r.metadata.title?.[0]?.startsWith("Fixture 3"),
  );
  await pool.query(
    "UPDATE catalog_documents SET bibliography=jsonb_set(bibliography,'{filterTags}','{}'::jsonb) WHERE work_id=$1",
    [bad.work_id],
  );
  await pool.query("UPDATE catalog_text_pending SET work_id=work_id");
  await assert.rejects(() =>
    require("../apps/api/dist/catalog-text-bulk").projectText(16),
  );
  const pending = (
    await pool.query("SELECT work_id,error FROM catalog_text_pending")
  ).rows;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].work_id, bad.work_id);
  assert.equal(pending[0].error, "DOCUMENT_PREPARATION_FAILED");
  await pool.query(
    "UPDATE catalog_documents SET bibliography=$2 WHERE work_id=$1",
    [bad.work_id, bad.bibliography],
  );
  await pool.query("UPDATE catalog_text_pending SET work_id=work_id");
  assert.equal(
    await require("../apps/api/dist/catalog-text-bulk").projectText(16),
    1,
  );
  const found = await search.searchRequest("/" + testIndex + "/_mget", {
    ids: current.map((r) => r.work_id),
  });
  for (const document of found.docs)
    assert.deepEqual(document._source, expectedDocs.get(document._id));
  report.sql_failure_isolated_and_retried_with_real_publication = true;

  await fs.writeFile(
    "/results/preparation-fixtures.json",
    JSON.stringify(report, null, 2),
  );
  console.log(report);
})()
  .finally(async () => {
    await search
      .searchRequest("/" + testIndex, undefined, "DELETE", true)
      .catch(() => {});
    await pool.end();
    await require("../apps/api/p2a-dist/db").pool.end();
    await admin.query("DROP SCHEMA " + schema + " CASCADE");
    await admin.end();
  })
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
