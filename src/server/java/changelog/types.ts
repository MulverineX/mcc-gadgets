import type { z } from "zod";

import type {
  SitemapEntrySchema,
  SitemapSchema,
  VersionManifestEntrySchema,
  VersionManifestSchema,
} from "./shared/schemas";
import type { SerializedAST } from "./shared/parser";

export type VersionManifestResponse = z.infer<typeof VersionManifestSchema>;
export type VersionManifestEntry = z.infer<typeof VersionManifestEntrySchema>;

export type VersionType =
  | "snapshot"
  | "release"
  | "special"
  | "release-candidate"
  | "pre-release";

export type SitemapEntry = z.infer<typeof SitemapEntrySchema>;
export type SitemapData = z.infer<typeof SitemapSchema>;

export type ResolutionSource = "sitemap" | "hardcoded" | "none";

export interface ResolvedVersion {
  /** Minecract.net article URL, or null if the version has no sitemap-discoverable page. */
  url: string | null;
  /** Article slug (trailing path segment of the article URL). */
  slug: string | null;
  /** Sitemap lastmod timestamp, used by the invalidation hook. */
  lastmod: string | null;
  source: ResolutionSource;
}

export type CachedSource = "launchercontent" | "sitemap" | "wayback" | "none";

export interface CachedEntry {
  version: string;
  type: string;
  /**
   * Release this version was published for. `1.21.4-pre1` → `1.21.4`,
   * `23w13a` → `1.20`, `26.1-snapshot-1` → `26.1`. Releases map to
   * themselves. Null when the id doesn't map to a known release.
   */
  targetRelease: string | null;
  url: string | null;
  rawHtmlUrl: string;
  image: string | null;
  shortText: string | null;
  source: CachedSource;
  /** Sitemap lastmod in Unix seconds. Null when the version isn't sitemap-backed. */
  lastmod: number | null;
  /** Manifest release timestamp in Unix seconds. Carried through to RSS `<pubDate>`. */
  publishedAt: number;
}

export interface CachedResponse {
  entries: CachedEntry[];
}

export interface JsonEntry extends CachedEntry {
  title: string | null;
  body: SerializedAST | null;
}

export interface JsonResponse {
  entries: JsonEntry[];
}