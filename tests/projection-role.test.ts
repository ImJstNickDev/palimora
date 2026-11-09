import { test } from "node:test";
import assert from "node:assert/strict";
import { projectionMode } from "../apps/api/src/projection-mode";

test("projection mode accepts only explicit inline or isolated roles", () => {
  assert.equal(projectionMode("inline"), "inline");
  assert.equal(projectionMode("isolated"), "isolated");
  for (const value of ["", "false", "worker", "INLINE"])
    assert.throws(() => projectionMode(value), /PROJECTION_MODE/);
});
