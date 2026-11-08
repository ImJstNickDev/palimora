// Diagnostic pass only: synchronous JSON cost; never stores arguments/results.
const fs = require("node:fs");
const output = process.env.P0_JSON_PROFILE;
if (output) {
  if (
    !output.startsWith("/results/") ||
    !new URL(process.env.DATABASE_URL).pathname.endsWith("_test")
  )
    throw Error("Test only");
  const totals = {},
    serialize = JSON.stringify;
  for (const name of ["parse", "stringify"]) {
    const original = JSON[name];
    JSON[name] = function (...args) {
      const start = performance.now();
      let result;
      try {
        return (result = original.apply(this, args));
      } finally {
        const ms = performance.now() - start;
        const v = (totals[name] ??= { calls: 0, ms: 0, bytes: 0 });
        v.calls++;
        v.ms += ms;
        const data = name === "parse" ? args[0] : result;
        if (typeof data === "string") v.bytes += Buffer.byteLength(data);
      }
    };
  }
  process.on("exit", () => fs.writeFileSync(output, serialize(totals)));
}
