import {
  setShortText,
  markVersionVisited,
  setCachedEntry,
  type CachedEntryCache,
} from "./shared/cache";
import {
  absolutizeImageUrl,
  parseArticle,
  type ParsedArticle,
} from "./shared/parser";
import {
  buildResolveContext,
  resolveUpstream,
} from "./shared/resolver";
import { getSitemapMap } from "./shared/sitemap";
import { getVersionManifest } from "./manifest";
import { humanReadableTitle } from "./shared/title";
import type { LocalCache } from "./shared/local-cache";
import { getLauncherEntry } from "./shared/launcher";
import { targetReleaseOf } from "./data/legacy-mapping";
import { toUnixSeconds } from "./shared/time";

/**
 * Final per-version API response: a parsed article + a derived title.
 * Mirrors the shape captured by `tests/__snapshots__/<name>.json`.
 */
export interface VersionResponse extends ParsedArticle {
  title: string;
  targetRelease: string | null;
  /** Manifest release timestamp in Unix seconds. Null when the version isn't in the manifest. */
  publishedAt: number | null;
  sourceURL: string;
}

/**
 * Options bag accepted by every fetcher in this module. Production callers
 * omit it; tests pass `{ cache: new LocalCache(...) }` for fixture-backed
 * fetches. Mirrors the React/Next.js pattern of an options object on a
 * fetch call (`{ next: { revalidate, tags } }`).
 */
export interface FetchOptions {
  /** When provided, manifest/sitemap/CDX/HTML fetches go through this cache. */
  cache?: LocalCache;
  /**
   * Snapshot name used to look up the article HTML in the LocalCache fixture.
   * Production omits this; tests pass the same name used by their corpus
   * (e.g. `"1-10"` for version `1.10`). Without it, the HTML is fetched from
   * the network even when a cache is in play.
   */
  htmlSnapshot?: string;
  /**
   * Override the CDX fetcher outright. Takes precedence over `cache`.
   * Production omits it; tests pass a cache-aware fetcher so legacy
   * resolution can fall back to the network and persist responses.
   */
  cdxFetch?: (url: string) => Promise<string | null>;
}

interface Resolution {
  url: string;
  source: "minecraft.net" | "mojang";
  lastmod: string | null;
  releaseTime: string | null;
}

/**
 * Fetch + parse a version's article. Returns `null` when no source can be
 * resolved (route maps to 404). On success, returns the parsed article with
 * an absolute hero image and a derived `title`, and writes `shortText` to
 * the runtime cache for sidebar hover.
 *
 * The whole-version fetches are bundled inside `getJsonVersions` (which is
 * itself cached by the shared `cache()` wrapper, revalidating every minute),
 * so iterating every manifest entry in `versions/json` triggers at most one
 * upstream HTML fetch per version per minute.
 */
export async function fetchParsedVersion(
  version: string,
  options: FetchOptions = {},
): Promise<VersionResponse | null> {
  const resolution = await resolveUpstreamForVersion(version, options);
  if (!resolution) return null;

  let html: string | null = null;
  let source: "minecraft.net" | "mojang" = resolution.source;

  if (options.cache && options.htmlSnapshot) {
    const cached = options.cache.readArticleHtml(options.htmlSnapshot);
    if (cached) {
      html = cached.html;
      source = cached.source;
    }
  }

  if (html === null) {
    // Test path: cache + htmlSnapshot both provided. Persist the fetched HTML
    // so the next run hits the disk fixture instead of the network.
    if (options.cache && options.htmlSnapshot) {
      const fetched = await options.cache.fetchArticleHtml(
        options.htmlSnapshot,
        resolution.url,
        source,
      );
      if (!fetched) return null;
      html = fetched.html;
      source = fetched.source;
    } else {
      const res = await fetch(resolution.url);
      if (!res.ok) return null;
      html = await res.text();
    }
  }

  const parsed = parseArticle(html, source, version);
  const heroImage = absolutizeImageUrl(parsed.heroImage);

  // Sidebar hover override — runtime-cached shortText wins over launchercontent
  // per PLAN §Sidebar Hover Details. Skipped when a LocalCache is in play
  // (test runs shouldn't pollute the runtime cache).
  if (!options.cache) {
    // Pull launchercontent so the cached entry can carry image + shortText.
    // Errors are swallowed — launchercontent is optional enrichment.
    const launcherEntry = await getLauncherEntry(version).catch(() => undefined);
    const cachedEntry: CachedEntryCache = {
      url: resolution.url,
      source: resolution.source === "mojang" ? "wayback" : "sitemap",
      image: launcherEntry?.image.url ?? null,
      shortText: parsed.shortText ?? launcherEntry?.shortText ?? null,
      lastmod: resolution.lastmod,
    };
    await Promise.all([
      markVersionVisited(version),
      setCachedEntry(version, cachedEntry),
    ]);
    if (parsed.shortText) {
      setShortText(version, parsed.shortText).catch((e) => {
        console.warn(`shortText cache write failed for ${version}: ${String(e)}`);
      });
    }
  }

  return {
    ...parsed,
    heroImage,
    title: humanReadableTitle(version),
    targetRelease: targetReleaseOf(version),
    publishedAt: toUnixSeconds(resolution.releaseTime),
    sourceURL: resolution.url,
  };
}

/**
 * Look up a version's article URL using the shared resolver + Wayback fallback.
 * Lives in this file (not the shared module) because it depends on the
 * runtime's fetchers; the options bag carries a `LocalCache` for tests.
 */
async function resolveUpstreamForVersion(
  version: string,
  options: FetchOptions,
): Promise<Resolution | null> {
  const [manifest, sitemapMap] = await Promise.all([
    options.cache ? options.cache.fetchManifest() : getVersionManifest(),
    options.cache ? options.cache.fetchSitemapMap() : getSitemapMap(),
  ]);

  const entry = manifest.versions.find((v) => v.id === version);
  if (!entry) return null;

  const ctx = buildResolveContext(manifest, sitemapMap);
  const upstream = await resolveUpstream(entry, ctx, {
    cache: options.cache,
    cdxFetch: options.cdxFetch,
  });
  if (!upstream.url) return null;
  return {
    url: upstream.url,
    source: upstream.source === "wayback" ? "mojang" : "minecraft.net",
    lastmod: upstream.lastmod,
    releaseTime: entry.releaseTime,
  };
}
