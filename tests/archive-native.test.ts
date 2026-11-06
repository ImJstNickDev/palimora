import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Pool } from "pg";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { canonical, sha } from "../apps/api/src/pack";
import {
  compileManifest,
  prepareDocuments,
  documentHashes,
  prepareCopy,
} from "../apps/api/src/archive-native";
import {
  stageRows,
  stageTable,
  catalogPrelude,
  timestampMicros,
} from "../apps/api/src/archive-bulk";

import { readPayloads, readParseCache } from "../apps/api/src/archive-catalog";

test("native canonical documents preserve ECMAScript bytes and hashes", async () => {
  const values: any[] = [
    null,
    true,
    false,
    0,
    -0,
    1e-7,
    1e21,
    Number.MIN_VALUE,
    Number.MAX_VALUE,
    "à 🐈 \ud800 \udfff\n\t\u0000",
    [],
    {},
    JSON.parse(
      '{"__proto__":{"constructor":"safe"},"4294967295":1,"02":2,"2":3,"10":4,"0":5,"4294967294":6,"𐀀":7,"￿":8}',
    ),
    { z: undefined, a: [undefined, null, { z: 2, a: '\\"' }] },
  ];
  // Deterministic permutations, numeric keys and Unicode order across nesting.
  for (let i = 0; i < 100; i++)
    values.push(
      Object.fromEntries(
        Array.from({ length: 20 }, (_, n) => [
          String((n * 17 + i) % 23),
          { é: i * 1e-9, "😀": [n, "x\n"], a: n },
        ]).reverse(),
      ),
    );
  const docs = await prepareDocuments(values),
    hashes = await documentHashes(values);
  for (let i = 0; i < values.length; i++) {
    assert.deepEqual(docs[i].bytes, canonical(values[i]));
    assert.equal(docs[i].hash, sha(canonical(values[i])));
    assert.equal(hashes[i], docs[i].hash);
  }
  const manifest = {
    schema: "palimora-canonical-v1",
    metadata: values[values.length - 1],
    chapters: [],
    state: "valid",
  };
  const [metadata, compiled] = compileManifest(manifest);
  assert.deepEqual(
    metadata.bytes,
    canonical({ schema: "palimora-metadata-v1", metadata: manifest.metadata }),
  );
  assert.deepEqual(
    compiled.bytes,
    canonical({ ...manifest, metadata_hash: sha(metadata.bytes) }),
  );
  assert.equal(compiled.hash, sha(compiled.bytes));
  assert.throws(
    () => prepareDocuments([{ nested: Infinity }]),
    /CANONICAL_NUMBER/,
  );
  const native = require("../apps/api/native/build/codec.node");
  for (const value of [
    '[{"x":',
    "[01]",
    '["\\q"]',
    '["\u0001"]',
    "[true] trailing",
  ])
    await assert.rejects(native.prepare(Buffer.from(value), 1), /CATALOG_/);
  await assert.rejects(
    native.prepare(Buffer.from("[".repeat(260) + "0" + "]".repeat(260)), 1),
    /DEPTH/,
  );
});

test(
  "binary COPY preserves typed values and populated metadata migration preserves evidence",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    assert.match(new URL(process.env.TEST_DATABASE_URL!).pathname, /test/);
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const db = await pool.connect(),
      schema = "test_native_" + randomUUID().replaceAll("-", "");
    try {
      await db.query(`CREATE SCHEMA ${schema}; SET search_path=${schema}`);
      await db.query(
        "CREATE TEMP TABLE binary_values(id uuid,body jsonb,n integer,b bigint,t timestamptz,s text,optional text)",
      );
      const date = "1999-12-31T23:59:59.123456Z",
        id = randomUUID();
      const [bytes] = await prepareCopy([
        {
          columns: [
            ["id", "uuid"],
            ["body", "jsonb"],
            ["n", "integer"],
            ["b", "bigint"],
            ["t", "timestamptz"],
            ["s", "text"],
            ["optional", "text"],
          ],
          rows: [
            {
              id,
              body: { text: 'quote" newline\n 🐈', null: null },
              n: -2147483648,
              b: "9223372036854775807",
              t: timestampMicros(date),
              s: "\\N\t\n",
              optional: null,
            },
          ],
        },
      ]);
      const { from } = require("pg-copy-streams");
      await pipeline(
        Readable.from([bytes]),
        db.query(from("COPY binary_values FROM STDIN (FORMAT binary)")) as any,
      );
      const row = (
        await db.query(
          "SELECT *,to_char(t AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS exact FROM binary_values",
        )
      ).rows[0];
      assert.equal(row.id, id);
      assert.equal(row.n, -2147483648);
      assert.equal(row.b, "9223372036854775807");
      assert.equal(row.exact, date);
      assert.equal(row.s, "\\N\t\n");
      assert.equal(row.optional, null);
      assert.deepEqual(row.body, { text: 'quote" newline\n 🐈', null: null });
      assert.equal(timestampMicros("2000-01-01T01:00:00.000001+01:00"), "1");
      assert.throws(() => timestampMicros("invalid"), /COPY_TIMESTAMP/);
      assert.throws(
        () => timestampMicros("2023-02-29T00:00:00Z"),
        /COPY_TIMESTAMP/,
      );
      const [jsonNull] = await prepareCopy([
        { columns: [["body", "jsonb_value"]], rows: [{ body: null }, {}] },
      ]);
      await pipeline(
        Readable.from([jsonNull]),
        db.query(
          from("COPY binary_values(body) FROM STDIN (FORMAT binary)"),
        ) as any,
      );
      assert.equal(
        (
          await db.query(
            "SELECT count(*) FROM binary_values WHERE body='null'::jsonb",
          )
        ).rows[0].count,
        "1",
      );
      assert.equal(
        (
          await db.query(
            "SELECT count(*) FROM binary_values WHERE body IS NULL",
          )
        ).rows[0].count,
        "1",
      );
      await assert.rejects(
        prepareCopy([{ columns: [["x", "uuid"]], rows: [{ x: "bad" }] }]),
        /COPY_UUID/,
      );
      const migrations = "apps/api/migrations";
      for (const file of readdirSync(migrations)
        .filter((f) => f.endsWith(".sql") && f < "019")
        .sort())
        await db.query(readFileSync(migrations + "/" + file, "utf8"));
      const work = randomUUID(),
        observation = randomUUID(),
        metadata = { title: ["Preserved"], extra: null };
      await db.query("INSERT INTO archive_works(id,metadata) VALUES($1,$2)", [
        work,
        metadata,
      ]);
      await db.query(
        "INSERT INTO archive_observations VALUES($1,$2,'old.zip','entry','parser','fp',$3)",
        [
          observation,
          work,
          {
            title: { id: "9007199254740993", value: metadata.title },
            extra: { id: "9007199254740994", value: null },
          },
        ],
      );
      await db.query(
        "INSERT INTO archive_evidence_refs VALUES($1,'old.zip','entry',$2)",
        [
          work,
          {
            title: { observation, confidence: "document" },
            extra: { observation, confidence: "document" },
          },
        ],
      );
      for (const [i, evidence] of [
        { metadata, source_hash: "source" },
        { metadata: null },
        {},
      ].entries()) {
        await db.query(
          "INSERT INTO archive_records VALUES('old.zip','fp',$1,'parser','hash',$2,null,$3)",
          [String(i), work, evidence],
        );
        await db.query(
          "INSERT INTO archive_parse_cache VALUES($1,'parser',$2)",
          [String(i), { ...evidence, objects: [] }],
        );
      }
      const names = [
        "archive_works",
        "archive_observations",
        "archive_records",
        "archive_parse_cache",
        "archive_field_evidence",
        "archive_evidence_observations",
      ];
      const before = new Map<string, any[]>();
      for (const name of names)
        before.set(
          name,
          (
            await db.query(
              `SELECT to_jsonb(t) AS value FROM ${name} t ORDER BY to_jsonb(t)::text`,
            )
          ).rows,
        );
      await db.query("BEGIN");
      await db.query(
        readFileSync(migrations + "/019_shared_metadata.sql", "utf8"),
      );
      await db.query("COMMIT");
      for (const name of names)
        assert.deepEqual(
          (
            await db.query(
              `SELECT to_jsonb(t) AS value FROM ${name} t ORDER BY to_jsonb(t)::text`,
            )
          ).rows,
          before.get(name),
          name,
        );
      assert.equal(
        (await db.query("SELECT count(*) FROM archive_payloads")).rows[0].count,
        "3",
      );
      await assert.rejects(
        db.query("UPDATE archive_payloads SET value='{}'"),
        /immutable/,
      );
      assert.equal(
        (
          await db.query(
            "SELECT metadata_hash=payload_hash AS shared FROM archive_work_heads,archive_observation_data",
          )
        ).rows[0].shared,
        true,
      );
      await assert.rejects(
        db.query(readFileSync(migrations + "/020_compact_catalog.sql", "utf8")),
        /COMPACT_CATALOG_REQUIRES_EMPTY_ARCHIVE/,
      );
      assert.equal(
        (await db.query("SELECT count(*) FROM archive_works")).rows[0].count,
        "1",
      );
    } finally {
      await db.query("ROLLBACK");
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      db.release();
      await pool.end();
    }
  },
);

test(
  "compact catalog preserves dictionaries, binary hashes and complete parser cache",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    assert.match(new URL(process.env.TEST_DATABASE_URL!).pathname, /test/);
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const db = await pool.connect(),
      schema = "test_compact_" + randomUUID().replaceAll("-", "");
    try {
      await db.query(`CREATE SCHEMA ${schema}; SET search_path=${schema}`);
      for (const file of readdirSync("apps/api/migrations")
        .filter((f) => f.endsWith(".sql"))
        .sort())
        await db.query(readFileSync("apps/api/migrations/" + file, "utf8"));
      const values = Array.from({ length: 128 }, (_, i) => ({
        title: ["Titolo 🐈 " + i, "Secondo"],
        summary: "A story with preserved metadata. ".repeat(80),
        extra: null,
        id: "9007199254740993",
        rank: i,
      }));
      const cache = values.map((metadata, i) => ({
        source_hash: sha(String(i)),
        parser: "test-v1",
        record: { metadata, objects: [], state: "valid", custom: "kept" },
      }));
      cache.push({
        source_hash: sha("null"),
        parser: "test-v1",
        record: { metadata: null, objects: [], state: "valid", custom: "null" },
      } as any);
      cache.push({
        source_hash: sha("missing"),
        parser: "test-v1",
        record: { objects: [], state: "valid", custom: "missing" },
      } as any);
      await db.query("BEGIN");
      await stageRows(db, { cache });
      await db.query(catalogPrelude().join(";"));
      await db.query(
        `INSERT INTO archive_cache_data SELECT decode(r.source_hash,'hex'),parser.id,p.hash,r.hash,r.codec::smallint,r.dictionary_id,r.raw_size,r.data FROM ${stageTable("cache")} r LEFT JOIN ${stageTable("payloads")} p ON p.id=r.metadata_key JOIN archive_parsers parser ON parser.name=r.parser`,
      );
      await db.query("COMMIT");
      const hashes = values.map((v) => Buffer.from(sha(canonical(v)), "hex"));
      const decoded = await readPayloads(db, hashes);
      values.forEach((v, i) =>
        assert.deepEqual(decoded.get(hashes[i].toString("hex")), v),
      );
      const records = await readParseCache(
        db,
        "test-v1",
        cache.map((r) => r.source_hash),
      );
      for (const row of records)
        assert.deepEqual(
          row.record,
          cache.find((r) => r.source_hash === row.source_hash)!.record,
        );
      assert.equal(records.length, cache.length);
      assert.equal(
        (
          await readParseCache(
            db,
            "test-v2",
            cache.map((r) => r.source_hash),
          )
        ).length,
        0,
      );
      assert.equal(
        (
          await db.query(
            "SELECT count(*) FROM archive_dictionaries WHERE family='metadata'",
          )
        ).rows[0].count,
        "1",
      );
      assert.ok(
        Number(
          (
            await db.query(
              "SELECT sum(octet_length(data)) < sum(raw_size)/2 AS compact FROM archive_payloads",
            )
          ).rows[0].compact,
        ),
      );
      await assert.rejects(
        db.query("UPDATE archive_dictionaries SET data=data"),
        /immutable/,
      );
      await assert.rejects(
        db.query("UPDATE archive_parsers SET name=name"),
        /immutable/,
      );
      await assert.rejects(
        db.query("UPDATE archive_payloads SET data=data"),
        /immutable/,
      );
      const corrupt = Buffer.from(sha("corrupt"), "hex");
      await db.query("INSERT INTO archive_payloads VALUES($1,1,NULL,7,$2)", [
        corrupt,
        Buffer.from("broken"),
      ]);
      await assert.rejects(readPayloads(db, [corrupt]));
      await assert.rejects(
        prepareCopy([{ columns: [["x", "bytea"]], rows: [{ x: "odd" }] }]),
        /COPY_BYTEA/,
      );
      // The bounded runtime trainer must not leak its dictionary into ordinary packs.
      const native = require("../apps/api/native/build/codec.node"),
        input = Buffer.from("ordinary pack frame".repeat(100));
      const [packed] = await native.batch([input], 3, false);
      assert.deepEqual(
        (await native.batch([packed], [input.length], true))[0],
        input,
      );
    } finally {
      await db.query("ROLLBACK");
      await db.query(`DROP SCHEMA ${schema} CASCADE`);
      db.release();
      await pool.end();
    }
  },
);
