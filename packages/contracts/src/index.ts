import { z } from "zod";
export const Role = z.enum(["Owner", "Admin", "User"]);
export const Preferences = z.object({
  language: z.enum(["it", "en"]),
  theme: z.enum(["auto", "light", "dark"]),
  skin: z.enum(["ink", "forest"]),
});
export const User = z.object({
  id: z.uuid(),
  username: z.string(),
  email: z.string().nullable(),
  role: Role,
  disabled: z.boolean(),
  soft_deleted_at: z.string().nullable(),
  created_at: z.string(),
  preferences: Preferences,
  totp_enabled: z.boolean(),
});
export type User = z.infer<typeof User>;
export const Session = z.object({
  id: z.uuid(),
  device: z.string(),
  ip: z.string(),
  created_at: z.string(),
  last_seen_at: z.string(),
  expires_at: z.string(),
  current: z.boolean(),
});
export const Invite = z.object({
  id: z.uuid(),
  email: z.string().nullable(),
  expires_at: z.string(),
  max_uses: z.number(),
  uses: z.number(),
  revoked_at: z.string().nullable(),
  created_at: z.string(),
});
const empty = z.object({}),
  ok = z.object({ ok: z.literal(true) }),
  id = z.object({ id: z.uuid() });
const password = z.string().min(12).max(128),
  username = z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{2,31}$/),
  email = z.union([z.email().max(254), z.literal("")]).optional();
const credentials = z.object({ username, password, email });
const proof = z.object({
  password: z.string().min(1).max(128),
  code: z.string().max(100).optional(),
});
const login = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(128),
  code: z.string().max(100).optional(),
});
const auth = z.object({ user: User, csrf: z.string() });
const page = z.object({
  q: z.string().max(100).optional(),
  cursor: z.string().max(100).optional(),
});
const token = z.string().min(32).max(128);
const json = z.record(z.string(), z.unknown());
function endpoint<I extends z.ZodType, O extends z.ZodType>(
  method: "get" | "post" | "patch" | "delete",
  path: string,
  input: I,
  output: O,
  access: "public" | "user" | "admin" | "owner" = "user",
) {
  return { method, path, input, output, access };
}
const batch = z.object({
  id: z.uuid(),
  state: z.enum([
    "pending",
    "scanning",
    "running",
    "parser_blocked",
    "paused",
    "completed",
    "completed_with_gaps",
    "failed_global",
  ]),
  created_at: z.string(),
  updated_at: z.string(),
  error: json.nullable(),
  reprocess: z.boolean(),
  selection: z.array(z.string()),
  metadata_scope: z.array(z.string()),
  reconcile_batch_id: z.uuid().nullable(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
  generation: z.number(),
});
const source = z.object({
  id: z.uuid(),
  path: z.string(),
  state: z.string(),
  checkpoint: z.string(),
  checkpoint_detail: json,
  index_progress: z.string().nullable().optional(),
  fingerprint: z.string(),
  parser: z.string(),
  total: z.string().nullable(),
  bytes: z.string(),
  duplicates: z.string(),
  attempts: z.number(),
  next_retry_at: z.string().nullable(),
  imported: z.string(),
  gaps: z.string(),
  error: json.nullable(),
});
const work = z.object({
  id: z.uuid(),
  external_id: z.string().nullable(),
  metadata: json,
  current_snapshot_id: z.uuid().nullable(),
  head_reason: z.string(),
  canonical_work_id: z.string().nullable().optional(),
});
export const api = {
  archiveDownload: endpoint(
    "get",
    "/admin/archive/blobs/:hash",
    z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/) }),
    z.object({ hash: z.string() }),
    "admin",
  ),
  archiveInventory: endpoint(
    "get",
    "/admin/ingest/inventory/files",
    empty,
    z.object({
      items: z.array(
        z.object({
          path: z.string(),
          size: z.string(),
          state: z.string(),
          updated_at: z.string(),
        }),
      ),
    }),
    "admin",
  ),
  ingestReport: endpoint(
    "get",
    "/admin/ingest/:id/report",
    id.extend({
      path: z.string().max(1000).optional(),
      cursor: z
        .string()
        .regex(/^[0-9]+$/)
        .optional(),
    }),
    z.object({
      summary: z.object({
        sources: z.number(),
        records: z.string(),
        bytes: z.string(),
        duplicates: z.string(),
        gaps: z.string(),
        checkpoints: z.string(),
        total: z.string().nullable(),
        state: batch.shape.state,
        started_at: z.string().nullable(),
        finished_at: z.string().nullable(),
        content: z.array(z.object({ state: z.string(), count: z.number() })),
        works: z.array(z.object({ state: z.string(), count: z.number() })),
        sources_by_state: z.array(
          z.object({ state: z.string(), count: z.number() }),
        ),
        elapsed_seconds: z.number(),
        records_per_second: z.number(),
        eta_seconds: z.number().nullable(),
      }),
      issues: z.array(
        z.object({
          id: z.string(),
          path: z.string(),
          fingerprint: z.string(),
          locator: z.string(),
          code: z.string(),
          detail: json,
        }),
      ),
      next: z.string().nullable(),
    }),
    "admin",
  ),
  archiveConflicts: endpoint(
    "get",
    "/admin/archive/works/:id/conflicts",
    id.extend({
      cursor: z.uuid().optional(),
      evidenceCursor: z
        .string()
        .regex(/^[0-9]+$/)
        .optional(),
    }),
    z.object({
      items: z.array(
        z.object({ id: z.uuid(), kind: z.string(), detail: json }),
      ),
      evidence: z.array(json),
      next: z.string().nullable(),
      nextEvidence: z.string().nullable(),
    }),
    "admin",
  ),
  archiveResolve: endpoint(
    "post",
    "/admin/archive/works/:id/resolve",
    id.extend({
      requestId: z.uuid(),
      kind: z.enum(["head", "metadata", "identity", "external_id", "unlink"]),
      target: z.string().max(100),
      field: z.string().max(100).optional(),
      source: z.string().max(1000).optional(),
      locator: z.string().max(2000).optional(),
      reason: z.string().trim().min(3).max(1000),
    }),
    ok,
    "admin",
  ),
  archiveMaintenance: endpoint(
    "post",
    "/admin/archive/maintenance",
    z.object({ requestId: z.uuid(), kind: z.enum(["compact", "collect"]) }),
    ok,
    "admin",
  ),
  archiveStorage: endpoint(
    "get",
    "/admin/archive/storage",
    empty,
    z.object({
      dev_reset_available: z.boolean().default(false),
      objects: z.string(),
      bytes: z.string(),
      packed_bytes: z.string(),
      available_bytes: z.number().nullable(),
      total_bytes: z.number().nullable(),
      packs: z.string(),
      reserve_bytes: z.number(),
      kinds: z.array(
        z.object({
          kind: z.string(),
          objects: z.string(),
          bytes: z.string(),
          packed_bytes: z.string(),
        }),
      ),
      jobs: z.array(
        z.object({
          id: z.uuid(),
          kind: z.string(),
          state: z.string(),
          result: json.nullable(),
          created_at: z.string(),
        }),
      ),
    }),
    "admin",
  ),
  archiveDevReset: endpoint(
    "post",
    "/admin/archive/dev-reset",
    z.object({ requestId: z.uuid(), confirmation: z.literal("RESET") }),
    ok,
    "owner",
  ),

  ingestBatches: endpoint(
    "get",
    "/admin/ingest",
    page.extend({
      cursor: z.uuid().optional(),
      filter: z.enum(["all", "active", "attention", "finished"]).default("all"),
    }),
    z.object({
      items: z.array(
        batch.extend({
          sources: z.number(),
          processed: z.string(),
          gaps: z.string(),
          done_sources: z.number(),
        }),
      ),
      next: z.string().nullable(),
    }),
    "admin",
  ),
  ingestCreate: endpoint(
    "post",
    "/admin/ingest",
    z.object({
      requestId: z.uuid(),
      reprocess: z.boolean(),
      reconcileBatchId: z.uuid().optional(),
      selection: z
        .array(z.string().regex(/^[^/\\]+\.(zip|sqlite3|part)$/))
        .max(1000)
        .default([]),
      metadataScope: z
        .array(z.string().regex(/^[a-zA-Z0-9_]+$/))
        .max(1000)
        .default([]),
    }),
    batch,
    "admin",
  ),
  ingestDetail: endpoint(
    "get",
    "/admin/ingest/:id",
    id,
    z.object({ batch, sources: z.array(source) }),
    "admin",
  ),
  ingestControl: endpoint(
    "post",
    "/admin/ingest/:id/control",
    id.extend({ action: z.enum(["pause", "resume"]) }),
    ok,
    "admin",
  ),
  archiveWorks: endpoint(
    "get",
    "/admin/archive/works",
    page.extend({
      cursor: z.uuid().optional(),
      filter: z.enum(["all", "current", "missing", "conflicts"]).default("all"),
    }),
    z.object({
      items: z.array(
        work.extend({ snapshots: z.number(), conflicts: z.number() }),
      ),
      next: z.string().nullable(),
    }),
    "admin",
  ),
  archiveWork: endpoint(
    "get",
    "/admin/archive/works/:id",
    id.extend({ cursor: z.uuid().optional() }),
    z.object({
      work,
      snapshots: z.array(
        z.object({
          id: z.uuid(),
          work_id: z.uuid(),
          manifest_hash: z.string(),
          state: z.string(),
          imported_at: z.string(),
          ordering_uncertain: z.boolean(),
        }),
      ),
      next: z.string().nullable(),
    }),
    "admin",
  ),
  archiveSnapshot: endpoint(
    "get",
    "/admin/archive/snapshots/:id",
    id,
    z.object({ manifest: json }),
    "admin",
  ),
  archiveObject: endpoint(
    "get",
    "/admin/archive/objects/:hash",
    z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/) }),
    z.object({
      base64: z.string().nullable(),
      kind: z.string(),
      size: z.string(),
      truncated: z.boolean(),
    }),
    "admin",
  ),

  status: endpoint(
    "get",
    "/auth/status",
    empty,
    z.object({
      state: z.enum(["uninitialized", "active"]),
      name: z.string().nullable(),
    }),
    "public",
  ),
  setup: endpoint(
    "post",
    "/auth/setup",
    credentials.extend({
      name: z.string().trim().min(1).max(80),
      preferences: Preferences,
    }),
    auth,
    "public",
  ),
  login: endpoint("post", "/auth/login", login, auth, "public"),
  register: endpoint(
    "post",
    "/auth/register",
    credentials.extend({ token, preferences: Preferences }),
    auth,
    "public",
  ),
  inviteInfo: endpoint(
    "post",
    "/auth/invite",
    z.object({ token }),
    z.object({ email: z.string().nullable() }),
    "public",
  ),
  me: endpoint("get", "/me", empty, auth),
  logout: endpoint("post", "/auth/logout", empty, ok),
  deleteAccount: endpoint("delete", "/me", proof, ok),
  profile: endpoint(
    "patch",
    "/me",
    z.object({ email, preferences: Preferences }),
    User,
  ),
  password: endpoint(
    "post",
    "/me/password",
    proof.extend({ newPassword: password }),
    ok,
  ),
  sessions: endpoint("get", "/me/sessions", empty, z.array(Session)),
  revokeSession: endpoint("delete", "/me/sessions/:id", id, ok),
  revokeOthers: endpoint("post", "/me/sessions/revoke-others", empty, ok),
  totpStart: endpoint(
    "post",
    "/me/totp/start",
    proof,
    z.object({ secret: z.string(), uri: z.string() }),
  ),
  totpVerify: endpoint(
    "post",
    "/me/totp/verify",
    z.object({ code: z.string().regex(/^[0-9]{6}$/) }),
    z.object({ codes: z.array(z.string()) }),
  ),
  totpEnable: endpoint(
    "post",
    "/me/totp/enable",
    z.object({ backupCodesSaved: z.literal(true) }),
    ok,
  ),
  totpDisable: endpoint("post", "/me/totp/disable", proof, ok),
  recovery: endpoint(
    "post",
    "/me/recovery",
    proof,
    z.object({ codes: z.array(z.string()) }),
  ),
  passkeys: endpoint(
    "get",
    "/me/passkeys",
    empty,
    z.array(
      z.object({ id: z.string(), name: z.string(), created_at: z.string() }),
    ),
  ),
  passkeyStart: endpoint("post", "/me/passkeys/options", proof, json),
  passkeyFinish: endpoint(
    "post",
    "/me/passkeys",
    z.object({ name: z.string().trim().min(1).max(80), response: json }),
    ok,
  ),
  passkeyDelete: endpoint(
    "delete",
    "/me/passkeys/:id",
    proof.extend({ id: z.string().max(2048) }),
    ok,
  ),
  passkeyLoginStart: endpoint(
    "post",
    "/auth/passkey/options",
    empty,
    json,
    "public",
  ),
  passkeyLoginFinish: endpoint(
    "post",
    "/auth/passkey/verify",
    z.object({ response: json }),
    auth,
    "public",
  ),
  users: endpoint(
    "get",
    "/admin/users",
    page,
    z.object({ items: z.array(User), next: z.string().nullable() }),
    "admin",
  ),
  userUpdate: endpoint(
    "patch",
    "/admin/users/:id",
    id.extend({
      disabled: z.boolean().optional(),
      deleted: z.boolean().optional(),
      role: z.enum(["Admin", "User"]).optional(),
    }),
    User,
    "admin",
  ),
  userSessions: endpoint(
    "get",
    "/admin/users/:id/sessions",
    id,
    z.array(Session),
    "admin",
  ),
  userRevoke: endpoint("post", "/admin/users/:id/revoke", id, ok, "admin"),
  userReset: endpoint(
    "post",
    "/admin/users/:id/reset",
    id
      .merge(proof)
      .extend({ newPassword: password, resetFactors: z.boolean() }),
    ok,
    "admin",
  ),
  invites: endpoint(
    "get",
    "/invites",
    page,
    z.object({ items: z.array(Invite), next: z.string().nullable() }),
    "owner",
  ),
  inviteCreate: endpoint(
    "post",
    "/invites",
    z.object({
      email,
      days: z.number().int().min(1).max(30),
      maxUses: z.number().int().min(1).max(100),
      requestId: z.uuid(),
    }),
    z.object({ invite: Invite, token: z.string().nullable() }),
    "owner",
  ),
  inviteRevoke: endpoint("delete", "/invites/:id", id, ok, "owner"),
} as const;
export type Operation = keyof typeof api;
export type Input<K extends Operation> = z.input<(typeof api)[K]["input"]>;
export type Output<K extends Operation> = z.output<(typeof api)[K]["output"]>;
export const ErrorCode = z.enum([
  "INVALID_INPUT",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "CSRF",
  "CONFLICT",
  "SETUP_CLOSED",
  "INVITE_INVALID",
  "CREDENTIALS_INVALID",
  "SECOND_FACTOR_REQUIRED",
  "SECOND_FACTOR_INVALID",
  "RATE_LIMITED",
  "NOT_FOUND",
  "INTERNAL",
  "PASSKEY_INVALID",
  "CHALLENGE_EXPIRED",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;
export const ApiError = z.object({ code: ErrorCode, requestId: z.string() });
export function openapi() {
  const paths: Record<string, unknown> = {};
  for (const [name, e] of Object.entries(api)) {
    const path = "/api/v1" + e.path.replace(/:([a-zA-Z]+)/g, "{$1}");
    const schema = z.toJSONSchema(e.input);
    const pathNames = [...e.path.matchAll(/:(\w+)/g)].map((m) => m[1]);
    const bodySchema = {
      ...schema,
      properties: { ...schema.properties },
      required: schema.required?.filter((key) => !pathNames.includes(key)),
    };
    for (const key of pathNames) delete bodySchema.properties[key];
    const entry = {
      operationId: name,
      security: e.access === "public" ? [] : [{ session: [] }],
      ...(e.method === "get"
        ? {
            parameters: Object.entries((schema as any).properties ?? {}).map(
              ([key, value]) => ({
                name: key,
                in: e.path.includes(":" + key) ? "path" : "query",
                required: e.path.includes(":" + key),
                schema: value,
              }),
            ),
          }
        : {
            requestBody: {
              required: true,
              content: { "application/json": { schema: bodySchema } },
            },
            parameters: [
              ...pathNames.map((name) => ({
                name,
                in: "path",
                required: true,
                schema: { type: "string" },
              })),
              {
                name: "Origin",
                in: "header",
                required: true,
                schema: { type: "string" },
              },
              ...(e.access === "public"
                ? []
                : [
                    {
                      name: "X-CSRF-Token",
                      in: "header",
                      required: true,
                      schema: { type: "string" },
                    },
                  ]),
            ],
          }),
      responses: {
        200: {
          description: "Success",
          content:
            name === "archiveDownload"
              ? {
                  "application/octet-stream": {
                    schema: { type: "string", format: "binary" },
                  },
                }
              : { "application/json": { schema: z.toJSONSchema(e.output) } },
        },
        default: {
          description: "Error",
          content: { "application/json": { schema: z.toJSONSchema(ApiError) } },
        },
      },
    };
    paths[path] = { ...(paths[path] as object), [e.method]: entry };
  }
  return {
    openapi: "3.1.0",
    info: { title: "Palimora", version: "1.0.0" },
    paths,
    components: {
      securitySchemes: {
        session: { type: "apiKey", in: "cookie", name: "palimora_session" },
      },
    },
  };
}
