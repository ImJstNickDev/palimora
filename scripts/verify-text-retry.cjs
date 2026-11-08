// Extra durable-ACK barrier probe, using a real accepted write and real flush.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { pool } = require("../apps/api/dist/db");
const { projectText } = require("../apps/api/dist/catalog-text-bulk");
const {
  searchRequest,
  SEARCH_INDEX,
} = require("../apps/api/dist/catalog-search");
async function verify() {
  if (!new URL(process.env.DATABASE_URL).pathname.endsWith("_test"))
    throw Error("Test DB required");
  assert.equal(
    (await pool.query("SELECT count(*)::int n FROM catalog_text_pending"))
      .rows[0].n,
    0,
  );
  const id = (
    await pool.query(
      "SELECT work_id FROM catalog_documents ORDER BY work_id LIMIT 1",
    )
  ).rows[0].work_id;
  const before = (
    await searchRequest("/" + SEARCH_INDEX + "/_doc/" + id, undefined, "GET")
  )._source;
  await pool.query("INSERT INTO catalog_text_pending(work_id) VALUES($1)", [
    id,
  ]);
  const original = global.fetch;
  let flushes = 0;
  try {
    global.fetch = async (...args) => {
      const response = await original(...args);
      if (String(args[0]).endsWith("/_bulk")) {
        await response.arrayBuffer();
        throw Error("Lost response");
      }
      return response;
    };
    await assert.rejects(() => projectText(1));
    await pool.query(
      "UPDATE catalog_text_pending SET retry_at=now() WHERE work_id=$1",
      [id],
    );
    global.fetch = async (...args) =>
      String(args[0]).includes("/_flush")
        ? new Response("{}", { status: 503 })
        : original(...args);
    await assert.rejects(() => projectText(1));
    assert.equal(
      (
        await pool.query(
          "SELECT error FROM catalog_text_pending WHERE work_id=$1",
          [id],
        )
      ).rows[0].error,
      "BULK_DURABILITY_UNCERTAIN",
    );
    await pool.query(
      "UPDATE catalog_text_pending SET retry_at=now() WHERE work_id=$1",
      [id],
    );
    global.fetch = async (...args) => {
      if (String(args[0]).includes("/_flush")) flushes++;
      return original(...args);
    };
    assert.equal(await projectText(1), 1);
    assert.equal(flushes, 1);
    assert.deepEqual(
      (
        await searchRequest(
          "/" + SEARCH_INDEX + "/_doc/" + id,
          undefined,
          "GET",
        )
      )._source,
      before,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT (SELECT count(*) FROM catalog_pending)+(SELECT count(*) FROM catalog_snapshot_pending)+(SELECT count(*) FROM catalog_graph_pending)+(SELECT count(*) FROM catalog_text_pending) n",
        )
      ).rows[0].n,
      "0",
    );
    return {
      failed_flush_preserves_queue: true,
      confirmed_flush_before_ack: true,
      source_unchanged: true,
      all_projection_queues_drained: true,
    };
  } finally {
    global.fetch = original;
  }
}
module.exports = { verify };
if (require.main === module)
  verify()
    .then(async (report) => {
      fs.writeFileSync(
        "/results/retry-durability.json",
        JSON.stringify(report, null, 2),
      );
      await pool.end();
    })
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
