import { revalidatePath } from "next/cache";

import { cache as unstableCache } from "~/lib/fetch";

import { targetReleaseOf } from "./data/legacy-mapping";
import { getVersionManifest } from "./manifest";
import {
  getCachedEntry,
  getLastmod,
  getShortText,
  getVisitedVersions,
  setLastmod,
} from "./shared/cache";
import { getLauncherEntry } from "./shared/launcher";
import type { LocalCache } from "./shared/local-cache";
import {
  buildResolveContext,
  type ResolveContext,
  resolveUpstream,
  resolveVersion,
} from "./shared/resolver";
import { getSitemapMap } from "./shared/sitemap";
import { toUnixSeconds } from "./shared/time";
import type {
  CachedEntry,
  CachedResponse,
  VersionManifestEntry,
} from "./types";

const RAW_HTML_PATH_PREFIX = "/api/v1/java/changelog/version";

export interface CachedVersionsOptions {
  /** When provided, manifest + sitemap + CDX fetches go through this cache. */
  cache?: LocalCache;
  /**
   * Pre-populated visited set. Bypasses the runtime cache lookup. Production
   * omits this and reads `getVisitedVersions()` instead. Tests pass a fake
   * to exercise the stub-vs-full branch without touching the production
   * visit set.
   */
  visited?: Set<string>;
}

/**
 * Production cached-endpoint fetcher. Tests pass `{ cache }` to swap the
 * manifest/sitemap/CDX fetchers for disk-backed fixtures; both paths run
 * the same resolver + launcher/shortText enrichment pipeline below.
 */
export const getCachedVersions = unstableCache(
  async (_options: CachedVersionsOptions = {}): Promise<CachedResponse> => {
    return loadCachedVersions(_options);
  },
  ["java", "changelog", "cached"],
  { revalidate: 3 * 60 * 60 /* 3 hr */ },
);

/**
 * Unwrapped body of `getCachedVersions` — testable with `{ cache }` without
 * going through the Next.js `unstable_cache` key serialization.
 *
 * Iterates every manifest entry but only fills in real data (URL, image,
 * shortText, lastmod) for versions users have actually visited. Other
 * entries appear as stubs with only manifest-level info (id, type,
 * publishedAt). This stops the API from proactively collecting data for
 * every Minecraft version that ever shipped.
 */
export async function loadCachedVersions(
  options: CachedVersionsOptions = {},
): Promise<CachedResponse> {
  const [manifest, sitemapMap] = await Promise.all([
    options.cache ? options.cache.fetchManifest() : getVersionManifest(),
    getSitemapMap({ cache: options.cache }),
  ]);

  const ctx: ResolveContext = buildResolveContext(manifest, sitemapMap);
  const visited =
    options.visited ??
    (options.cache ? new Set<string>() : await getVisitedVersions());

  const entries: CachedEntry[] = [];
  for (const version of manifest.versions) {
    if (visited.has(version.id)) {
      // For visited versions, prefer the cached entry written by
      // `fetchParsedVersion` on the user's visit. Falls back to a fresh
      // resolution if the cache entry is missing (e.g. cache TTL expired
      // but the visit set persisted).
      const cached = options.cache ? null : await getCachedEntry(version.id);
      if (cached) {
        entries.push({
          ...stubEntry(version),
          url: cached.url,
          image: cached.image,
          shortText: cached.shortText,
          source: cached.source === "hardcoded" ? "sitemap" : cached.source,
          lastmod: toUnixSeconds(cached.lastmod),
        });
      } else {
        entries.push(await resolveCachedEntry(version, ctx, options));
      }
    } else {
      entries.push(stubEntry(version));
    }
  }

  return { entries };
}

function stubEntry(version: VersionManifestEntry): CachedEntry {
  return {
    version: version.id,
    type: version.type,
    targetRelease: targetReleaseOf(version.id),
    url: null,
    rawHtmlUrl: `${RAW_HTML_PATH_PREFIX}/${encodeURIComponent(version.id)}/raw.html`,
    image: null,
    shortText: null,
    source: "none",
    lastmod: null,
    publishedAt: toUnixSeconds(version.releaseTime) ?? 0,
  };
}

async function resolveCachedEntry(
  entry: VersionManifestEntry,
  ctx: ResolveContext,
  options: CachedVersionsOptions,
): Promise<CachedEntry> {
  // Plan §Source Selection: sitemap first, then launchercontent (image + text
  // only — URL still comes from sitemap), then legacy (Wayback), else null.
  // Pass `options.cache` through so legacy versions resolve via the disk
  // fixture instead of the production CDX fetcher.
  const upstream = await resolveUpstream(entry, ctx, { cache: options.cache });
  const url: string | null = upstream.url;
  const source: CachedEntry["source"] =
    upstream.source === "hardcoded" ? "sitemap" : upstream.source;
  // Build a minimal resolved view for lastmod — re-run resolveVersion when
  // we got a sitemap hit so we have its lastmod value.
  const lastmod =
    url && source === "sitemap" ? resolveVersion(entry, ctx).lastmod : null;

  // Image + launchercontent shortText. URL source doesn't have to be
  // launchercontent — image/shortText come from launchercontent regardless of
  // URL source. Skipped in offline mode because the launchercontent fetcher
  // uses Next.js `unstable_cache`, which requires a request context.
  const launcherEntry = options.cache
    ? undefined
    : await getLauncherEntry(entry.id).catch(() => undefined);

  // Runtime-cached shortText (set by version/{x} on first parse) wins over
  // launchercontent per PLAN §Sidebar Hover Details. Skipped in offline mode
  // because the Vercel runtime cache requires a request context that the test
  // environment doesn't provide.
  const runtimeShortText = options.cache
    ? null
    : await getShortText(entry.id).catch(() => null);

  // Invalidation hook (PLAN §Caching Strategy / Rule 4): when the sitemap
  // shows a newer `lastmod` than what we previously stored, force-revalidate
  // the matching per-version routes so stale-while-revalidate kicks in.
  // Skipped in offline mode (LocalCache) because `revalidatePath` requires a
  // Next.js static-generation store that's only present during real requests.
  if (lastmod && source === "sitemap" && !options.cache) {
    await invalidateIfStale(entry.id, lastmod).catch((e) => {
      console.warn(`invalidation check failed for ${entry.id}: ${String(e)}`);
    });
  }

  return {
    version: entry.id,
    type: entry.type,
    targetRelease: targetReleaseOf(entry.id),
    url,
    rawHtmlUrl: `${RAW_HTML_PATH_PREFIX}/${encodeURIComponent(entry.id)}/raw.html`,
    image: launcherEntry?.image.url ?? null,
    shortText: runtimeShortText ?? launcherEntry?.shortText ?? null,
    source,
    lastmod: toUnixSeconds(lastmod),
    publishedAt: toUnixSeconds(entry.releaseTime) ?? 0,
  };
}

/**
 * Compare the sitemap's current `lastmod` for a version's article against the
 * previously-stored value. When the sitemap reports a newer timestamp, force
 * revalidation of both the parsed and raw routes for that version. Per PLAN:
 * the hook only fires for sitemap-backed versions — legacy (Wayback) entries
 * are exempt because the Wayback archive is immutable.
 */
async function invalidateIfStale(
  version: string,
  currentLastmod: string,
): Promise<void> {
  const previous = await getLastmod(version);
  if (previous && currentLastmod <= previous) return;

  revalidatePath(`/api/v1/java/changelog/version/${version}`);
  revalidatePath(`/api/v1/java/changelog/version/${version}/raw.html`);
  await setLastmod(version, currentLastmod);
}
