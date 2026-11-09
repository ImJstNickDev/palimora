// Compare the complete canonical indexing input; OpenSearch excludes text from _source.
const fs = require("node:fs"),
  { createHash } = require("node:crypto");
if (new URL(process.env.DATABASE_URL).pathname !== "/palimora_release_test")
  throw Error("Private fixture required");
const { pool } = require("../apps/api/dist/db");
const { loadTextInputs } = require("../apps/api/dist/catalog-text-preparation");
const { prepareTextDocument } = require("../apps/api/dist/catalog-search");
(async () => {
  const rows = (
    await pool.query(
      "SELECT d.*,coalesce(w.external_id,'provisional:'||w.provisional_key) external_id FROM catalog_documents d JOIN archive_works w ON w.id=d.work_id ORDER BY external_id",
    )
  ).rows;
  const digest = createHash("sha256");
  let raw = 0;
  for (let i = 0; i < rows.length; i += 8) {
    const part = rows.slice(i, i + 8),
      inputs = await loadTextInputs(pool, part);
    for (const row of part) {
      const doc = await prepareTextDocument(pool, row, inputs.get(row.work_id));
      const bytes = Buffer.from(JSON.stringify([row.external_id, doc.text]));
      raw += bytes.length;
      digest.update(bytes);
      digest.update("\n");
    }
  }
  fs.writeFileSync(
    "/results/canonical-search-text.json",
    JSON.stringify(
      {
        documents: rows.length,
        bytes: raw,
        sha256: digest.digest("hex"),
        source: "shared indexing preparation from verified canonical objects",
      },
      null,
      2,
    ),
  );
})()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
