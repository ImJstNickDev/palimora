import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readAuthResponse } from "../apps/web/src/auth-response";

test("an older API auth response produces a version error rather than a post-login TypeError", () => {
  const original = {
    csrf: "test-only-csrf",
    user: {
      id: randomUUID(), username: "reader", email: null, role: "User",
      disabled: false, soft_deleted_at: null, created_at: new Date().toISOString(),
      preferences: { language: "it", theme: "auto", skin: "ink" }, totp_enabled: true,
    },
  };
  assert.throws(() => readAuthResponse(original), {message:"API_VERSION_MISMATCH"});
  const current = {...original, session:{id:randomUUID(),expires_at:new Date(Date.now()+86400000).toISOString()}};
  assert.deepEqual(readAuthResponse(current), current);
});
