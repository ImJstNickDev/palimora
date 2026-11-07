import { z } from "zod";
const sourceId = z.string().min(1).max(500);
const name = z.string().min(1).max(1000);
const sourceURL = z.url().refine((v) => {
  const u = new URL(v);
  return (
    u.protocol === "https:" &&
    u.hostname === "archiveofourown.org" &&
    !u.username &&
    !u.password
  );
});
export const TagKind = z.enum([
  "fandom",
  "rating",
  "warnings",
  "category",
  "characters",
  "relationships",
  "freeform",
  "unclassified",
  "media",
]);
export const SourceTag = z.object({
  id: sourceId.optional(),
  name,
  kind: TagKind,
  canonical: z.boolean().nullable().optional(),
  synonym_of: sourceId.nullable().optional(),
  meta_tags: z.array(sourceId).optional(),
  parents: z.array(sourceId).optional(),
});
export const SourceEntity = z.object({
  id: sourceId.optional(),
  name,
  url: sourceURL.optional(),
  description: z.string().optional(),
  notes: z.string().optional(),
  introduction: z.string().optional(),
  faq: z.string().optional(),
  rules: z.string().optional(),
  statistics: z
    .object({
      words: z.number().int().nonnegative().optional(),
      works: z.number().int().nonnegative().optional(),
      bookmarks: z.number().int().nonnegative().optional(),
    })
    .optional(),
  created: z.string().optional(),
  updated: z.string().optional(),
  complete: z.boolean().optional(),
  parent_id: sourceId.optional(),
  owner_id: sourceId.optional(),
  position: z.number().nonnegative().optional(),
  creators: z.array(sourceId).optional(),
  closed: z.boolean().optional(),
  moderated: z.boolean().optional(),
  anonymous: z.boolean().optional(),
  unrevealed: z.boolean().optional(),
});
export const SourceComment = z.object({
  id: sourceId,
  parent_id: sourceId.nullable().optional(),
  chapter_id: sourceId.nullable().optional(),
  author: name.nullable().optional(),
  guest: z.boolean().optional(),
  author_url: sourceURL.optional(),
  posted_at: z.string().nullable().optional(),
  html: z.string(),
  deleted: z.boolean().optional(),
});
export const SourceKudos = z.object({
  users: z.array(z.object({ name, url: sourceURL.optional() })).optional(),
  guests: z.number().int().nonnegative().nullable().optional(),
  observed_at: z.string().optional(),
});
export const SourceBibliography = z
  .object({
    schema: z.literal("palimora-ao3-v1"),
    tags: z.array(SourceTag).optional(),
    authors: z.array(SourceEntity).optional(),
    pseuds: z.array(SourceEntity).optional(),
    series: z.array(SourceEntity).optional(),
    collections: z.array(SourceEntity).optional(),
    relations: z
      .array(
        z.object({
          type: z.enum([
            "inspired_by",
            "inspiration",
            "translation_of",
            "translation",
            "related",
          ]),
          work_id: z.string().regex(/^\d+$/),
          label: z.string().optional(),
        }),
      )
      .optional(),
    comments: z.array(SourceComment).optional(),
    kudos: SourceKudos.optional(),
    statistics: z
      .object({
        words: z.number().int().nonnegative().optional(),
        hits: z.number().int().nonnegative().optional(),
        kudos: z.number().int().nonnegative().optional(),
        comments: z.number().int().nonnegative().optional(),
        bookmarks: z.number().int().nonnegative().optional(),
        observed_at: z.string().optional(),
      })
      .optional(),
    availability: z
      .enum([
        "available",
        "deleted",
        "hidden_or_restricted",
        "temporarily_unavailable",
        "unknown",
      ])
      .optional(),
    complete: z.boolean().optional(),
    expected_chapters: z.number().int().positive().nullable().optional(),
    published: z.string().optional(),
    updated: z.string().optional(),
    anonymous: z.boolean().optional(),
    unrevealed: z.boolean().optional(),
    restricted: z.boolean().optional(),
    crossover: z.boolean().optional(),
    otp: z.boolean().optional(),
    nonfiction: z.boolean().optional(),
    work_types: z.array(z.enum(["Text", "Audio", "Video", "Art"])).optional(),
    work_skin_id: sourceId.optional(),
    posted: z.boolean().optional(),
    hidden_by_admin: z.boolean().optional(),
    imported_from_url: z.url().optional(),
    media: z
      .array(z.object({ url: z.string(), object: z.string() }))
      .optional(),
  })
  .superRefine((source, ctx) => {
    const comments = source.comments ?? [],
      map = new Map(comments.map((c) => [c.id, c]));
    if (map.size !== comments.length)
      ctx.addIssue({
        code: "custom",
        message: "Duplicate source comment identity",
        path: ["comments"],
      });
    for (const c of comments) {
      const seen = new Set<string>();
      let next: typeof c | undefined = c;
      while (next) {
        if (seen.has(next.id)) {
          ctx.addIssue({
            code: "custom",
            message: "Source comment cycle",
            path: ["comments"],
          });
          break;
        }
        seen.add(next.id);
        next = next.parent_id ? map.get(next.parent_id) : undefined;
      }
    }
  });
export type SourceBibliography = z.infer<typeof SourceBibliography>;

const catalogId = z.string().regex(/^[a-f0-9]{64}$/);
export const CatalogTag = SourceTag.extend({
  id: catalogId,
  source_id: z.string().nullable(),
  canonical: z.boolean().nullable(),
});
export const CatalogEntity = SourceEntity.extend({
  id: catalogId,
  kind: z.enum(["author", "pseud", "series", "collection"]),
  source_id: z.string().nullable(),
  owner: catalogId.optional(),
});
export const CatalogBibliography = z.object({
  tags: z.array(CatalogTag),
  entities: z.array(CatalogEntity),
  relations: z.array(
    z.object({
      type: z.enum([
        "inspired_by",
        "inspiration",
        "translation_of",
        "translation",
        "related",
      ]),
      work_id: z.string(),
      label: z.string().optional(),
      local_id: z.uuid().nullable().optional(),
    }),
  ),
});
