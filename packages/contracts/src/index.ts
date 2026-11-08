export { alignAnchor } from "./reading-anchor";
import {
  CatalogBibliography,
  SourceComment,
  SourceKudos,
  SourceBibliography,
} from "./bibliography";
export {
  SourceBibliography,
  SourceTag,
  SourceEntity,
  SourceComment,
  SourceKudos,
  TagKind,
} from "./bibliography";
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
const impersonation = z
  .object({
    actor_id: z.uuid(),
    actor_username: z.string(),
    expires_at: z.string(),
  })
  .nullable()
  .optional();
const auth = z.object({
  impersonation,
  user: User,
  csrf: z.string(),
  session: z.object({ id: z.uuid(), expires_at: z.string() }),
});
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
const readerSelection = id.extend({ snapshot: z.uuid().optional() });
export const Bookmark = z.object({
  notes: z.string().max(10000),
  tags: z.array(z.string().trim().min(1).max(100)).max(50),
  recommended: z.boolean(),
  private: z.boolean(),
});
export const ReadingState = z.enum([
  "to_read",
  "reading",
  "completed",
  "paused",
  "abandoned",
]);
const libraryEntry = z.object({
  work_id: z.uuid(),
  title: z.string(),
  bookmark: Bookmark.nullable(),
  revision: z.number().int(),
  later: z.boolean(),
  last_viewed: z.string().nullable(),
  progress: z.object({ state: ReadingState, percent: z.number() }).nullable(),
});
const collection = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string(),
  revision: z.number().int(),
  role: z.enum(["Owner", "Editor", "Viewer"]),
  accepted: z.boolean(),
  contains_work: z.boolean().optional(),
});
const collectionFields = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(4000),
});

export const TextAnchor = z.object({
  snapshot: z.uuid(),
  chapter: z.uuid(),
  offset: z.number().int().nonnegative(),
  quote: z.string().min(1).max(4000),
  prefix: z.string().max(32),
  suffix: z.string().max(32),
});
const alignment = z.object({
  anchor: TextAnchor.nullable(),
  status: z.enum(["exact", "moved", "unresolved"]),
});
const progress = z.object({
  revision: z.number().int(),
  state: ReadingState,
  anchor: TextAnchor.nullable(),
  percent: z.number(),
  chapter_lengths: z
    .array(
      z.object({ chapter: z.uuid(), length: z.number().int().nonnegative() }),
    )
    .optional(),
  aligned: alignment,
});
const annotation = z.object({
  id: z.uuid(),
  user_id: z.uuid(),
  username: z.string(),
  body: z.string(),
  revision: z.number().int(),
  collection_id: z.uuid().nullable(),
  anchor: TextAnchor,
  aligned: alignment,
  editable: z.boolean(),
});
const audience = z.enum(["private", "selected", "instance"]);
export const SocialPreferences = z.object({
  revision: z.number().int().nonnegative(),
  activity: audience,
  activity_users: z.array(z.string().min(1).max(100)).max(100),
  recommendations: z.boolean(),
  updates: z.boolean(),
  push: z.boolean(),
  grouping: z.union([z.literal(0), z.literal(300), z.literal(3600)]),
});
const subscriptionTarget = z.object({
  kind: z.enum(["work", "author", "series"]),
  target: z.string().min(1).max(64),
});
const statisticsResult = z.object({
  works: z.number(),
  completed: z.number(),
  words: z.number().nullable(),
  unknown_words: z.number(),
  seconds: z.number(),
  measured_since: z.string(),
  fandoms: z.array(z.object({ name: z.string(), works: z.number() })),
  timeline: z.array(z.object({ day: z.string(), completed: z.number() })),
});
const backupKind = z.enum(["full", "platform", "export"]);
const backupRun = z.object({
  id: z.uuid(),
  kind: z.enum(["full", "platform", "export", "verify", "restore", "delete"]),
  destination: z.string(),
  state: z.enum([
    "pending",
    "running",
    "pause_requested",
    "paused",
    "cancel_requested",
    "cancelled",
    "completed",
    "failed",
    "deleted",
  ]),
  source_id: z.uuid().nullable(),
  base_id: z.uuid().nullable(),
  restore_target: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  verified_at: z.string().nullable(),
  progress: json,
  result: json,
  error: z.string().nullable(),
});
const operationsFamily = z.enum([
  "ingest",
  "sync",
  "media",
  "index",
  "backup",
  "admin",
]);
const operationIdentity = z.object({
  family: operationsFamily,
  id: z.string().min(1).max(64),
});
const operationsJob = z.object({
  family: operationsFamily,
  id: z.string(),
  kind: z.string(),
  state: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  priority: z.number().nullable(),
  error: z.string().nullable(),
  progress: json,
  actions: z.array(z.enum(["pause", "resume", "retry"])),
  url: z.string(),
});
export const IntegrityJob = z.object({
  id: z.uuid(),
  kind: z.enum(["scrub", "repair"]),
  state: z.enum([
    "pending",
    "running",
    "pause_requested",
    "paused",
    "completed",
    "failed",
  ]),
  progress: json,
  result: json.nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  started_at: z.string().nullable(),
  finished_at: z.string().nullable(),
});
const integrityIssueState = z.enum(["open", "repaired", "unrecoverable"]);
export const IntegrityIssue = z.object({
  id: z.uuid(),
  job_id: z.uuid(),
  identity: z.string(),
  object_hash: z.string().nullable(),
  pack: z.string().nullable(),
  code: z.string(),
  state: integrityIssueState,
  detail: json,
  repair_job_id: z.uuid().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  repairable: z.boolean(),
});
export const AuditEvent = z.object({
  id: z.string(),
  actor_id: z.uuid().nullable(),
  actor: z.string().nullable(),
  effective_user_id: z.uuid().nullable(),
  effective_user: z.string().nullable(),
  session_id: z.uuid().nullable(),
  ip: z.string(),
  action: z.string(),
  target: z.string().nullable(),
  details: json,
  outcome: z.enum(["success", "failure"]),
  created_at: z.string(),
  request_id: z.uuid(),
});
export const api = {
  maintenanceSet: endpoint(
    "post",
    "/admin/maintenance",
    z.object({
      mode: z.enum(["normal", "maintenance_light", "maintenance_full"]),
      confirmation: z.literal(true),
    }),
    ok,
    "admin",
  ),
  integrityStatus: endpoint(
    "get",
    "/admin/integrity",
    z.object({ job: z.uuid().optional() }),
    z.object({
      jobs: z.array(IntegrityJob),
      schedule: z.object({
        enabled: z.boolean(),
        every_days: z.number().int(),
        next_at: z.string(),
      }),
    }),
    "admin",
  ),
  integrityIssues: endpoint(
    "get",
    "/admin/integrity/issues",
    z.object({ job: z.uuid(), cursor: z.uuid().optional() }),
    z.object({ items: z.array(IntegrityIssue), next: z.uuid().nullable() }),
    "admin",
  ),
  integrityStart: endpoint(
    "post",
    "/admin/integrity/scrub",
    z.object({ requestId: z.uuid() }),
    id,
    "admin",
  ),
  integrityControl: endpoint(
    "post",
    "/admin/integrity/control",
    id.extend({ action: z.enum(["pause", "resume"]) }),
    ok,
    "admin",
  ),
  integritySchedule: endpoint(
    "post",
    "/admin/integrity/schedule",
    z.object({
      enabled: z.boolean(),
      every_days: z.number().int().min(1).max(365),
    }),
    ok,
    "admin",
  ),
  integrityRepair: endpoint(
    "post",
    "/admin/integrity/repair",
    z.object({
      requestId: z.uuid(),
      issue: z.uuid(),
      backup: z.uuid(),
      confirmation: z.literal(true),
    }),
    id,
    "owner",
  ),
  auditList: endpoint(
    "get",
    "/admin/audit",
    z.object({
      cursor: z
        .string()
        .regex(/^[0-9]+$/)
        .optional(),
      actor: z.uuid().optional(),
      target: z.string().max(200).optional(),
      action: z.string().max(100).optional(),
      outcome: z.enum(["success", "failure"]).optional(),
    }),
    z.object({ items: z.array(AuditEvent), next: z.string().nullable() }),
    "admin",
  ),
  impersonationStart: endpoint(
    "post",
    "/admin/impersonation",
    id.extend({ confirmation: z.literal(true) }),
    auth,
    "admin",
  ),
  impersonationStop: endpoint(
    "post",
    "/me/impersonation/stop",
    empty,
    auth,
    "user",
  ),

  operationsOverview: endpoint(
    "get",
    "/admin/operations",
    empty,
    z.object({
      layout: z.array(z.string()),
      status: z.array(
        z.object({ name: z.string(), checked_at: z.string(), value: json }),
      ),
    }),
    "admin",
  ),
  operationsLayout: endpoint(
    "post",
    "/admin/operations/layout",
    z.object({
      sections: z
        .array(z.enum(["activity", "containers", "performance", "storage"]))
        .min(1)
        .max(4),
    }),
    ok,
    "admin",
  ),
  operationsMetrics: endpoint(
    "get",
    "/admin/operations/metrics",
    z.object({
      range: z.enum(["hour", "day", "week", "month"]).default("hour"),
      series: z.string().max(100).optional(),
    }),
    z.object({
      step: z.number(),
      points: z.array(
        z.object({
          bucket: z.string(),
          series: z.string(),
          metric: z.string(),
          average: z.number(),
          peak: z.number(),
          last: z.number(),
        }),
      ),
      http: z.array(
        z.object({
          bucket: z.string(),
          kind: z.string(),
          requests: z.number(),
          errors: z.number(),
          mean_ms: z.number().nullable(),
          p95_ms: z.number().nullable(),
          p95_overflow: z.boolean(),
          max_ms: z.number(),
        }),
      ),
    }),
    "admin",
  ),
  operationsJobs: endpoint(
    "get",
    "/admin/operations/jobs",
    z.object({
      family: operationsFamily.or(z.literal("all")).default("all"),
      state: z.enum(["all", "active", "attention"]).default("all"),
      cursor: z.string().max(512).optional(),
      id: z.string().max(64).optional(),
    }),
    z.object({ items: z.array(operationsJob), next: z.string().nullable() }),
    "admin",
  ),
  operationsHistory: endpoint(
    "get",
    "/admin/operations/jobs/history",
    operationIdentity,
    z.object({
      items: z.array(
        z.object({
          id: z.string(),
          started_at: z.string(),
          finished_at: z.string().nullable(),
          state: z.string(),
          detail: json,
        }),
      ),
    }),
    "admin",
  ),
  operationsControl: endpoint(
    "post",
    "/admin/operations/jobs/control",
    operationIdentity.extend({
      action: z.enum(["pause", "resume", "retry"]),
      requestId: z.uuid(),
    }),
    ok,
    "admin",
  ),
  backupStatus: endpoint(
    "get",
    "/admin/backups",
    z.object({ cursor: z.uuid().optional() }),
    z.object({
      runs: z.array(backupRun),
      next: z.uuid().nullable(),
      destinations: z.array(
        z.object({
          name: z.string(),
          label: z.string(),
          enabled: z.boolean(),
          health: json,
          checked_at: z.string().nullable(),
        }),
      ),
      schedules: z.array(
        z.object({
          id: z.uuid(),
          kind: backupKind,
          destination: z.string(),
          enabled: z.boolean(),
          every_hours: z.number(),
          keep: z.number(),
          next_at: z.string(),
        }),
      ),
    }),
    "admin",
  ),
  backupCreate: endpoint(
    "post",
    "/admin/backups",
    z.object({
      requestId: z.uuid(),
      kind: backupKind,
      destination: z.string().min(1).max(64),
      base: z.uuid().optional(),
    }),
    ok,
    "admin",
  ),
  backupDetail: endpoint("get", "/admin/backups/:id", id, backupRun, "admin"),
  backupControl: endpoint(
    "post",
    "/admin/backups/:id/control",
    id.extend({
      action: z.enum(["pause", "resume", "cancel", "verify", "delete"]),
      requestId: z.uuid(),
      confirmation: z.string().max(100).optional(),
    }),
    ok,
    "admin",
  ),
  backupDestination: endpoint(
    "post",
    "/admin/backups/destinations/settings",
    z.object({
      name: z.string().max(64),
      label: z.string().trim().min(1).max(100),
      enabled: z.boolean(),
    }),
    ok,
    "admin",
  ),
  backupSchedule: endpoint(
    "post",
    "/admin/backups/schedules/settings",
    z.object({
      id: z.uuid(),
      kind: backupKind,
      destination: z.string().max(64),
      enabled: z.boolean(),
      every_hours: z.number().int().min(1).max(8760),
      keep: z.number().int().min(1).max(1000),
    }),
    ok,
    "admin",
  ),
  backupRestorePreview: endpoint(
    "get",
    "/admin/backups/:id/restore",
    id,
    z.object({
      hash: z.string(),
      kind: z.string(),
      targets: z.array(
        z.object({
          name: z.string(),
          label: z.string(),
          ready: z.boolean(),
          error: z.string().nullable(),
        }),
      ),
    }),
    "owner",
  ),
  backupRestore: endpoint(
    "post",
    "/admin/backups/:id/restore",
    id.extend({
      requestId: z.uuid(),
      target: z.string().max(64),
      confirmation: z.string().max(100),
    }),
    ok,
    "owner",
  ),
  backupFile: endpoint(
    "get",
    "/admin/backups/:id/files/:file",
    id.extend({
      file: z
        .string()
        .regex(/^(manifest\.json|manifest\.sha256|volume-[0-9]{6,}\.pmarc)$/),
    }),
    z.object({ id: z.uuid(), file: z.string() }),
    "admin",
  ),

  socialPreferences: endpoint("get", "/me/social", empty, SocialPreferences),
  socialPreferencesSave: endpoint(
    "post",
    "/me/social",
    SocialPreferences,
    SocialPreferences,
  ),
  personalStatistics: endpoint(
    "get",
    "/library/statistics",
    z.object({}).strict(),
    statisticsResult,
  ),
  personalActivity: endpoint(
    "get",
    "/library/activity",
    z.object({
      username: z.string().max(100).optional(),
      cursor: z.uuid().optional(),
    }),
    z.object({
      items: z.array(
        z.object({
          id: z.uuid(),
          title: z.string(),
          state: ReadingState,
          percent: z.number(),
        }),
      ),
      next: z.uuid().nullable(),
    }),
  ),
  readingHeartbeat: endpoint(
    "post",
    "/reading-time/:id",
    id.extend({ requestId: z.uuid(), active: z.boolean().default(true) }),
    ok,
  ),
  recommendationRecipients: endpoint(
    "get",
    "/recommendations/recipients",
    z.object({
      q: z.string().max(100).default(""),
      cursor: z.string().max(100).optional(),
    }),
    z.object({
      items: z.array(z.object({ username: z.string() })),
      next: z.string().nullable(),
    }),
  ),
  recommendWork: endpoint(
    "post",
    "/recommendations",
    z.object({
      requestId: z.uuid(),
      work: z.uuid(),
      username: z.string().min(1).max(100),
      note: z.string().max(2000).default(""),
    }),
    ok,
  ),
  subscriptionStatus: endpoint(
    "get",
    "/subscriptions/status",
    subscriptionTarget,
    z.object({ mode: z.enum(["chapters", "changes"]).nullable() }),
  ),
  subscriptionSave: endpoint(
    "post",
    "/subscriptions",
    subscriptionTarget.extend({
      mode: z.enum(["chapters", "changes"]).nullable(),
    }),
    ok,
  ),
  subscriptions: endpoint(
    "get",
    "/subscriptions",
    page,
    z.object({
      items: z.array(
        subscriptionTarget.extend({
          name: z.string(),
          mode: z.enum(["chapters", "changes"]),
        }),
      ),
      next: z.string().nullable(),
    }),
  ),
  notifications: endpoint(
    "get",
    "/notifications",
    z.object({
      cursor: z.uuid().optional(),
      unread: z.enum(["true", "false"]).default("false"),
    }),
    z.object({
      items: z.array(
        z.object({
          id: z.uuid(),
          kind: z.enum(["update", "recommendation"]),
          work_id: z.uuid(),
          title: z.string(),
          versions: z.number(),
          read_at: z.string().nullable(),
          updated_at: z.string(),
          sender: z.string().nullable(),
          note: z.string().nullable(),
        }),
      ),
      next: z.uuid().nullable(),
      unread: z.number(),
    }),
  ),
  notificationsReadAll: endpoint("post", "/notifications/read-all", empty, ok),
  notificationRead: endpoint(
    "post",
    "/notifications/:id",
    id.extend({ read: z.boolean() }),
    ok,
  ),
  pushDevices: endpoint(
    "get",
    "/me/push",
    empty,
    z.object({
      publicKey: z.string(),
      devices: z.array(
        z.object({
          id: z.uuid(),
          name: z.string(),
          current: z.boolean(),
          last_error: z.string().nullable(),
        }),
      ),
    }),
  ),
  pushRegister: endpoint(
    "post",
    "/me/push",
    z.object({
      name: z.string().trim().min(1).max(100),
      endpoint: z.url().max(4096),
      keys: z.object({
        p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
        auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
      }),
    }),
    ok,
  ),
  pushRevoke: endpoint("post", "/me/push/:id/revoke", id, ok),

  readingProgress: endpoint(
    "get",
    "/reading-progress/:id",
    readerSelection,
    progress,
  ),
  readingSave: endpoint(
    "post",
    "/reading-progress/:id",
    id.extend({
      requestId: z.uuid().optional(),
      revision: z.number().int().nonnegative(),
      anchor: TextAnchor,
      state: ReadingState,
    }),
    progress,
  ),
  annotationList: endpoint(
    "get",
    "/annotations/:id",
    readerSelection.extend({ cursor: z.uuid().optional() }),
    z.object({ items: z.array(annotation), next: z.uuid().nullable() }),
  ),
  annotationSave: endpoint(
    "post",
    "/annotations/:id",
    id.extend({
      requestId: z.uuid().optional(),
      annotation_id: z.uuid(),
      revision: z.number().int().nonnegative(),
      anchor: TextAnchor,
      body: z.string().trim().min(1).max(10000),
      collection_id: z.uuid().nullable(),
      deleted: z.boolean(),
    }),
    ok,
  ),

  collectionList: endpoint(
    "get",
    "/collections",
    page.extend({ work: z.uuid().optional() }),
    z.object({ items: z.array(collection), next: z.uuid().nullable() }),
  ),
  collectionCreate: endpoint(
    "post",
    "/collections",
    collectionFields.extend({ id: z.uuid() }),
    ok,
  ),
  collectionDetail: endpoint(
    "get",
    "/collections/:id",
    id.extend({ cursor: z.uuid().optional() }),
    z.object({
      collection,
      members: z.array(
        z.object({
          user_id: z.uuid(),
          username: z.string(),
          role: z.enum(["Owner", "Editor", "Viewer"]),
          accepted: z.boolean(),
        }),
      ),
      works: z.array(z.object({ id: z.uuid(), title: z.string() })),
      next: z.uuid().nullable(),
    }),
  ),
  collectionUpdate: endpoint(
    "post",
    "/collections/:id",
    collectionFields.extend({
      id: z.uuid(),
      revision: z.number().int(),
      deleted: z.boolean(),
    }),
    ok,
  ),
  collectionCandidates: endpoint(
    "get",
    "/collections/:id/candidates",
    id.extend({
      q: z.string().max(100).optional(),
      cursor: z.string().max(100).optional(),
    }),
    z.object({
      items: z.array(z.object({ username: z.string() })),
      next: z.string().nullable(),
    }),
  ),
  collectionMember: endpoint(
    "post",
    "/collections/:id/members",
    id.extend({
      username: z.string().min(1).max(100),
      role: z.enum(["Editor", "Viewer"]).nullable(),
    }),
    ok,
  ),
  collectionRespond: endpoint(
    "post",
    "/collections/:id/respond",
    id.extend({ accept: z.boolean() }),
    ok,
  ),
  collectionWork: endpoint(
    "post",
    "/collections/:id/works",
    id.extend({ work: z.uuid(), remove: z.boolean() }),
    ok,
  ),

  libraryList: endpoint(
    "get",
    "/library",
    z.object({
      kind: z.enum(["bookmarks", "later", "history"]).default("bookmarks"),
      q: z.string().max(200).optional(),
      tag: z.string().max(100).optional(),
      cursor: z.uuid().optional(),
    }),
    z.object({ items: z.array(libraryEntry), next: z.uuid().nullable() }),
  ),
  libraryWork: endpoint("get", "/library/works/:id", id, libraryEntry),
  librarySave: endpoint("post", "/library/works/:id/save", id, libraryEntry),
  bookmarkSave: endpoint(
    "post",
    "/bookmarks/:id",
    id.extend({
      bookmark: Bookmark.nullable(),
      revision: z.number().int().nonnegative(),
    }),
    libraryEntry,
  ),
  libraryLater: endpoint(
    "post",
    "/library/works/:id/later",
    id.extend({ later: z.boolean() }),
    ok,
  ),
  libraryForget: endpoint("post", "/library/works/:id/forget", id, ok),

  catalogWorks: endpoint(
    "get",
    "/works",
    z.object({
      entity: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      tag: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      include: z.string().max(3000).optional(),
      unclassified: z.string().max(500).optional(),
      media: z.string().max(500).optional(),
      category: z.string().max(500).optional(),
      crossover: z.enum(["true", "false"]).optional(),
      singleChapter: z.enum(["true"]).optional(),
      restricted: z.enum(["true", "false"]).optional(),
      availability: z.enum(["all", "deleted"]).optional(),
      words: z.string().max(100).optional(),
      hits: z.string().max(100).optional(),
      kudos: z.string().max(100).optional(),
      comments: z.string().max(100).optional(),
      bookmarks: z.string().max(100).optional(),
      dateFrom: z.iso.date().optional(),
      dateTo: z.iso.date().optional(),
      updatedWithin: z.string().max(100).optional(),
      fulltext: z.string().max(500).optional(),
      q: z.string().max(500).optional(),
      title: z.string().max(500).optional(),
      creators: z.string().max(500).optional(),
      fandom: z.string().max(500).optional(),
      rating: z.string().max(500).optional(),
      warnings: z.string().max(500).optional(),
      relationships: z.string().max(500).optional(),
      characters: z.string().max(500).optional(),
      freeform: z.string().max(500).optional(),
      language: z.string().max(3000).optional(),
      series: z.string().max(500).optional(),
      collections: z.string().max(500).optional(),
      exclude: z.string().max(3000).optional(),
      wordsFrom: z.coerce.number().int().nonnegative().optional(),
      wordsTo: z.coerce.number().int().nonnegative().optional(),
      complete: z.string().max(100).optional(),
      sort: z
        .enum([
          "relevance",
          "creators",
          "archived",
          "series",
          "title",
          "published",
          "updated",
          "words",
          "kudos",
          "comments",
          "hits",
          "bookmarks",
        ])
        .optional(),
      direction: z.enum(["asc", "desc"]).optional(),
      cursor: z.string().max(16384).optional(),
    }),
    z.object({
      items: z.array(
        z.object({
          id: z.uuid(),
          snapshot_id: z.uuid().nullable(),
          metadata: json,
          bibliography: CatalogBibliography,
        }),
      ),
      next: z.string().nullable(),
      total: z.number(),
      indexing: z.boolean(),
      facets: z.record(
        z.string(),
        z.array(z.object({ name: z.string(), count: z.number() })),
      ),
    }),
  ),
  bibliographyPage: endpoint(
    "get",
    "/bibliography/:kind/:id",
    z.object({
      kind: z.enum(["tag", "author", "pseud", "series", "collection"]),
      id: z.string().regex(/^[a-f0-9]{64}$/),
    }),
    z.object({ item: json, relations: z.array(json) }),
  ),
  catalogBrowse: endpoint(
    "get",
    "/browse",
    z.object({
      kind: z.enum([
        "language",
        "fandom",
        "rating",
        "warnings",
        "category",
        "pseuds",
        "unclassified",
        "media",
        "creators",
        "relationships",
        "characters",
        "freeform",
        "series",
        "collections",
      ]),
      q: z.string().max(500).optional(),
      cursor: z.string().max(500).optional(),
    }),
    z.object({
      items: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          works: z.number(),
          page_kind: z.string(),
          canonical: z.boolean().nullable().optional(),
        }),
      ),
      next: z.string().nullable(),
    }),
  ),
  ao3Media: endpoint(
    "get",
    "/admin/ao3/media",
    z.object({
      cursor: z.uuid().optional(),
      q: z.string().max(200).default(""),
    }),
    z.object({
      items: z.array(
        z.object({
          id: z.uuid(),
          url: z.string(),
          error: z.string(),
          failed_at: z.string().nullable(),
          attempts: z.number(),
          has_local_copy: z.boolean(),
          work_count: z.number(),
          works: z.array(z.object({ id: z.uuid(), title: z.string() })),
          upload_state: z.enum(["receiving", "queued"]).nullable(),
        }),
      ),
      next: z.string().nullable(),
    }),
    "admin",
  ),
  ao3UploadStart: endpoint(
    "post",
    "/admin/ao3/uploads",
    id.extend({
      url: z.url(),
      size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      mime: z.string().max(200),
    }),
    z.object({ received: z.number() }),
    "admin",
  ),
  ao3UploadChunk: endpoint(
    "post",
    "/admin/ao3/uploads/:id/chunk",
    id.extend({
      offset: z.number().int().nonnegative(),
      data: z.string().max(700000),
    }),
    ok,
    "admin",
  ),
  ao3UploadFinish: endpoint(
    "post",
    "/admin/ao3/uploads/:id/finish",
    id,
    ok,
    "admin",
  ),
  ao3Jobs: endpoint(
    "get",
    "/admin/ao3/jobs",
    z.object({
      kind: z
        .enum(["all", "work", "discovery", "backfill", "entity", "media"])
        .default("all"),
      q: z.string().max(200).default(""),
      cursor: z.uuid().optional(),
      job: z.uuid().optional(),
      state: z
        .enum(["all", "pending", "running", "retry", "idle", "blocked"])
        .default("all"),
    }),
    z.object({
      control: z.object({
        auth_state: z.string(),
        priorities: z.record(z.string(), z.number()),
        spacing_ms: z.number(),
        seed_complete: z.boolean(),
      }),
      jobs: z.array(
        z.object({
          id: z.uuid(),
          kind: z.string(),
          target: z.string(),
          state: z.string(),
          priority: z.number(),
          title: z.string().nullable(),
          work_id: z.uuid().nullable(),
          execution: z.enum([
            "deleted",
            "paused",
            "stopping",
            "running",
            "waiting_service",
            "scheduled",
            "ready",
          ]),
          eligible_at: z.string().nullable(),
          due_at: z.string(),
          started_at: z.string().nullable(),
          checked_at: z.string().nullable(),
          attempts: z.number(),
          error: z.string().nullable(),
          availability: z.string(),
          checkpoint: json,
        }),
      ),
      media_unrecoverable: z.number(),
      counts: z.array(z.object({ state: z.string(), count: z.number() })),
      runs: z.array(
        z.object({
          id: z.string(),
          job_id: z.uuid(),
          kind: z.string(),
          target: z.string(),
          started_at: z.string(),
          finished_at: z.string().nullable(),
          outcome: z.string(),
          detail: json,
        }),
      ),
      next: z.string().nullable(),
    }),
    "admin",
  ),
  ao3Manual: endpoint(
    "post",
    "/admin/ao3/manual",
    z.object({
      kind: z.enum(["discovery", "backfill", "work", "entity", "media"]),
      target: z.string().max(2000),
      priority: z.number().int().min(1).max(100).default(10),
    }),
    ok,
    "admin",
  ),
  ao3JobControl: endpoint(
    "post",
    "/admin/ao3/jobs/:id",
    id.extend({ action: z.enum(["pause", "resume"]) }),
    ok,
    "admin",
  ),
  ao3Account: endpoint(
    "post",
    "/admin/ao3/account",
    z.discriminatedUnion("remove", [
      z.object({ remove: z.literal(true) }),
      z.object({
        remove: z.literal(false),
        username: z.string().min(1).max(200),
        password: z.string().min(1).max(500),
      }),
    ]),
    ok,
    "admin",
  ),
  ao3Priorities: endpoint(
    "post",
    "/admin/ao3/priorities",
    z.object({
      priorities: z.object({
        discovery: z.number().int().min(1).max(100),
        work: z.number().int().min(1).max(100),
        entity: z.number().int().min(1).max(100),
        media: z.number().int().min(1).max(100),
        backfill: z.number().int().min(1).max(100),
      }),
    }),
    ok,
    "admin",
  ),
  ao3Status: endpoint(
    "get",
    "/admin/ao3",
    empty,
    z.object({
      control: z.object({
        mode: z.enum(["auto", "force_online", "force_offline"]),
        paused: z.boolean(),
        observed_state: z.enum([
          "online",
          "maintenance",
          "rate_limited",
          "blocked",
          "unreachable",
          "unknown",
        ]),
        checked_at: z.string().nullable(),
        next_probe_at: z.string(),
        probe_eligible_at: z.string().nullable(),
        cooldown_until: z.string().nullable(),
        failures: z.number(),
        eligible: z.boolean(),
        gate: z.string().nullable(),
      }),
      history: z.array(
        z.object({
          id: z.string(),
          started_at: z.string(),
          finished_at: z.string(),
          state: z.string(),
          http_status: z.number().nullable(),
          retry_at: z.string().nullable(),
          duration_ms: z.number(),
        }),
      ),
      watching: z.number(),
    }),
    "admin",
  ),
  ao3Control: endpoint(
    "post",
    "/admin/ao3/control",
    z.object({
      mode: z.enum(["auto", "force_online", "force_offline"]),
      paused: z.boolean(),
    }),
    ok,
    "admin",
  ),
  readerOpen: endpoint("post", "/works/:id/open", id, ok),
  readerWork: endpoint(
    "get",
    "/works/:id",
    readerSelection.extend({ cursor: z.uuid().optional() }),
    z.object({
      work: work.omit({ metadata: true }),
      manifest: z
        .object({
          schema: z.string(),
          state: z.string(),
          chapters: z.array(
            z.object({
              chapter_id: z.uuid(),
              title: z.string().optional(),
              scope: z.string().optional(),
            }),
          ),
        })
        .nullable(),
      metadata: json,
      bibliography: CatalogBibliography,
      snapshot: z.uuid().nullable(),
      versions: z.array(
        z.object({
          id: z.uuid(),
          state: z.string(),
          imported_at: z.string(),
          ordering_uncertain: z.boolean(),
        }),
      ),
      next: z.string().nullable(),
    }),
  ),
  readerInteractions: endpoint(
    "get",
    "/works/:id/interactions",
    readerSelection.extend({
      parent: z.string().max(500).optional(),
      cursor: z
        .string()
        .regex(/^\d{1,12}$/)
        .optional(),
      kudosCursor: z
        .string()
        .regex(/^\d{1,12}$/)
        .optional(),
    }),
    z.object({
      available: z.boolean(),
      commentsCoverage: z.enum(["unknown", "partial", "complete"]),
      kudosCoverage: z.enum(["unknown", "partial", "complete"]),
      comments: z.array(
        SourceComment.extend({ children: z.number().int().nonnegative() }),
      ),
      next: z.string().nullable(),
      kudos: SourceKudos.nullable(),
      nextKudos: z.string().nullable(),
      statistics: SourceBibliography.shape.statistics.unwrap().nullable(),
    }),
  ),
  readerDownload: endpoint(
    "get",
    "/works/:id/download",
    readerSelection.extend({ format: z.enum(["html", "epub", "pdf"]) }),
    z.object({ mime: z.string() }),
  ),
  readerMedia: endpoint(
    "get",
    "/works/:id/media/:hash",
    readerSelection.extend({
      hash: z.string().regex(/^[a-f0-9]{64}$/),
      download: z.enum(["true"]).optional(),
    }),
    json,
  ),
  readerContent: endpoint(
    "get",
    "/works/:id/read",
    readerSelection.extend({
      chapter: z.uuid().optional(),
      skin: z.enum(["on", "off"]).default("off"),
      theme: z.enum(["light", "dark"]).optional(),
      font: z.enum(["serif", "sans"]).optional(),
      size: z.coerce.number().int().min(14).max(28).optional(),
    }),
    z.object({ document: z.string() }),
  ),
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
      maintenance_mode: z
        .enum(["normal", "maintenance_light", "maintenance_full"])
        .default("normal"),
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
  userDetail: endpoint("get", "/admin/users/:id", id, User, "admin"),
  userStatistics: endpoint(
    "get",
    "/admin/users/:id/statistics",
    id,
    statisticsResult,
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
  "MAINTENANCE",
  "IMPERSONATION_RESTRICTED",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "CSRF",
  "CONFLICT",
  "RESET_REFERENCED_DATA",
  "SETUP_CLOSED",
  "INVITE_INVALID",
  "CREDENTIALS_INVALID",
  "SECOND_FACTOR_REQUIRED",
  "SECOND_FACTOR_INVALID",
  "RATE_LIMITED",
  "NOT_FOUND",
  "INTERNAL",
  "SEARCH_UNAVAILABLE",
  "SEARCH_QUERY_INVALID",
  "SEARCH_CURSOR_EXPIRED",
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
            name === "readerDownload" || name === "readerMedia"
              ? Object.fromEntries(
                  (name === "readerDownload"
                    ? ["text/html", "application/epub+zip", "application/pdf"]
                    : [
                        "image/png",
                        "image/jpeg",
                        "image/gif",
                        "image/webp",
                        "image/svg+xml",
                        "audio/mpeg",
                        "audio/mp4",
                        "audio/ogg",
                        "audio/wav",
                        "audio/webm",
                        "video/mp4",
                        "video/webm",
                        "video/ogg",
                        "font/woff",
                        "font/woff2",
                        "font/ttf",
                        "font/otf",
                        "text/vtt",
                        "application/pdf",
                        "application/octet-stream",
                      ]
                  ).map((mime) => [
                    mime,
                    { schema: { type: "string", format: "binary" } },
                  ]),
                )
              : name === "archiveDownload" || name === "backupFile"
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

/** Same text-offset percentage for the server, local queue and live reader. */
export function readingPercent(
  chapters: readonly { chapter: string; length: number }[],
  anchor: { chapter: string; offset: number },
): number | null {
  let before = 0,
    total = 0,
    found = false;
  for (const c of chapters) {
    if (c.chapter === anchor.chapter) {
      before = total + Math.min(c.length, anchor.offset);
      found = true;
    }
    total += c.length;
  }
  return found && total
    ? Math.max(0, Math.min(100, (before / total) * 100))
    : null;
}
