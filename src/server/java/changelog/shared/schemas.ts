import { z } from "zod";

const VERSION_TYPE_SCHEMA = z.union([
  z.enum(["snapshot", "release", "special", "release-candidate", "pre-release"]),
  z.string(),
]);

export const VersionManifestEntrySchema = z.object({
  id: z.string(),
  type: VERSION_TYPE_SCHEMA,
  url: z.string(),
  releaseTime: z.string(),
  sha1: z.string(),
  complianceLevel: z.number(),
});

export const VersionManifestSchema = z.object({
  versions: z.array(VersionManifestEntrySchema),
  latest: z.object({
    release: z.string(),
    snapshot: z.string(),
  }),
});

export const SitemapPatternTypeSchema = z.union([
  z.enum([
    "snapshot-old",
    "snapshot-new",
    "pre-release",
    "release-candidate",
    "patch",
    "release",
    "blog",
  ]),
  z.string(),
]);

export const SitemapEntrySchema = z.object({
  url: z.string(),
  slug: z.string(),
  patternType: SitemapPatternTypeSchema,
  lastmod: z.string().optional(),
});

export const SitemapSchema = z.object({
  parsedAt: z.string().optional(),
  entries: z.array(SitemapEntrySchema),
});

/**
 * Shared parser used by both production (`getVersionManifest`) and the test
 * fixture (`LocalCache.fetchManifest`). Production reads the JSON body via
 * `fetch(...).json()`; LocalCache reads it from disk; both end up here.
 */
export function parseManifestJson(body: unknown): z.infer<typeof VersionManifestSchema> {
  return VersionManifestSchema.parse(body);
}