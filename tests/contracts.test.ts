import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { api, openapi } from "@palimora/contracts";
test("Compose isolates every service except gateway; persistence is exclusively explicit bind mounts", () => {
  const compose = parse(readFileSync("infra/compose.yaml", "utf8"));
  assert.equal(compose.networks.app.internal, true);
  assert.equal(compose.networks.frontend.external, true);
  assert.equal(compose.volumes, undefined);
  for (const [name, value] of Object.entries(compose.services) as [
    string,
    any,
  ][]) {
    assert.equal(value.ports, undefined, name);
    assert.equal(value.network_mode, undefined);
    if (name !== "gateway")
      assert(
        !Object.keys(value.networks).includes("frontend") &&
          !Object.values(value.networks).includes("frontend"),
      );
    for (const mount of value.volumes ?? []) {
      assert.equal(mount.type, "bind");
      if (name === "metrics-proxy" && mount.target === "/var/run/docker.sock") {
        assert.equal(mount.source, "/var/run/docker.sock");
        assert.equal(mount.read_only, true);
        assert.deepEqual(value.networks, ["metrics"]);
      } else {
        assert(mount.source.startsWith(".") || mount.source.startsWith("$"));
        assert(!mount.target.includes("docker.sock"));
      }
      if (mount.target.includes("/dumps")) assert.equal(mount.read_only, true);
    }
  }
  assert.equal(compose.networks.metrics.internal, true);
  assert.deepEqual(compose.services.collector.networks, ["metrics", "app"]);
  assert(!compose.services.api.networks.includes("metrics"));
});
test("OpenAPI is generated for every runtime operation with success and error schemas", () => {
  const schema = openapi();
  const operations = Object.values(schema.paths).flatMap((p: any) =>
    Object.values(p),
  );
  assert.equal(operations.length, Object.keys(api).length);
  for (const op of operations as any[]) {
    const content = op.responses["200"].content;
    assert(Object.keys(content).length > 0);
    for (const representation of Object.values(content) as any[])
      assert(representation.schema);
    assert(op.responses.default);
  }
});
test("Contracts reject unsafe account data and invitation bounds", () => {
  assert(
    !api.setup.input.safeParse({ username: "bad/name", password: "short" })
      .success,
  );
  assert(!api.inviteCreate.input.safeParse({ days: 0, maxUses: 1000 }).success);
  assert(
    !api.userUpdate.input.safeParse({ id: crypto.randomUUID(), role: "Owner" })
      .success,
  );
});
