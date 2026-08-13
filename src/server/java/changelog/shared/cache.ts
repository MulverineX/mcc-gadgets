import { getCache } from "@vercel/functions";

/**
 * Per-version `shortText` runtime cache (PLAN §Sidebar Hover Details).
 *
 * Key: `shorttext:<version>` (e.g. `shorttext:1.20.4`).
 * Value: the generated ~280-char teaser string.
 * TTL: 1 year — runtime cache is regional and LRU-evicted, but the total
 * dataset is small (~280 KB across ~1000 versions) so eviction is unlikely.
 * Tag: `shorttext` for bulk invalidation.
 */
const runtimeCache = getCache({ namespace: "java-changelog" });

const SHORT_TEXT_TTL_SECONDS = 31_536_000; // 1 year

function shortTextKey(version: string): string {
  return `shorttext:${version}`;
}

export async function getShortText(version: string): Promise<string | null> {
  const value = await runtimeCache.get(shortTextKey(version));
  return typeof value === "string" ? value : null;
}

export async function setShortText(version: string, text: string): Promise<void> {
  await runtimeCache.set(shortTextKey(version), text, {
    ttl: SHORT_TEXT_TTL_SECONDS,
    tags: ["shorttext"],
  });
}

export async function expireAllShortTexts(): Promise<void> {
  await runtimeCache.expireTag("shorttext");
}

/**
 * Per-version sitemap `lastmod` tracking, used by the invalidation hook
 * (PLAN §Caching Strategy) to detect when a sitemap-backed article was
 * updated upstream. Stored alongside shortText in the same runtime cache
 * under its own tag.
 */
const LASTMOD_TTL_SECONDS = 7 * 24 * 60 * 60; // 1 week — long enough for a couple of cached-handler cycles.

function lastmodKey(version: string): string {
  return `lastmod:${version}`;
}

export async function getLastmod(version: string): Promise<string | null> {
  const value = await runtimeCache.get(lastmodKey(version));
  return typeof value === "string" ? value : null;
}

export async function setLastmod(
  version: string,
  lastmod: string,
): Promise<void> {
  await runtimeCache.set(lastmodKey(version), lastmod, {
    ttl: LASTMOD_TTL_SECONDS,
    tags: ["lastmod"],
  });
}

export async function expireAllLastmods(): Promise<void> {
  await runtimeCache.expireTag("lastmod");
}

/**
 * Visit tracking — the bulk endpoint only fills in URLs / images / shortText
 * for versions users have actually loaded. Versions never visited appear in
 * the manifest listing as stubs (version id, type, publishedAt, rawHtmlUrl —
 * everything else null). This keeps the API from proactively collecting
 * data for every Minecraft version that ever shipped.
 *
 * Stored as a single JSON-serialized Set under `visited:all` so we don't
 * need to scan keys. TTL 90 days is plenty for the visit pattern to survive
 * across cold caches; the user's recent activity is what the sidebar shows.
 */
const VISITED_TTL_SECONDS = 90 * 24 * 60 * 60;
const VISITED_KEY = "visited:all";

export async function getVisitedVersions(): Promise<Set<string>> {
  const raw = await runtimeCache.get(VISITED_KEY);
  if (typeof raw !== "string" || raw.length === 0) return new Set();
  try {
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

export async function markVersionVisited(version: string): Promise<void> {
  const visited = await getVisitedVersions();
  if (visited.has(version)) return;
  visited.add(version);
  await runtimeCache.set(VISITED_KEY, JSON.stringify([...visited]), {
    ttl: VISITED_TTL_SECONDS,
    tags: ["visited"],
  });
}

export async function expireAllVisited(): Promise<void> {
  await runtimeCache.expireTag("visited");
}

/**
 * Cached per-version metadata that's expensive to recompute (sitemap lookup,
 * launchercontent fetch, sitemap `lastmod`). Populated by `fetchParsedVersion`
 * on every successful visit; read by `loadCachedVersions` so the bulk
 * endpoint doesn't redo the resolver + launchercontent work for every
 * visited version on every request.
 *
 * TTL matches the visit set (90 days) — both are revoked together if a
 * version needs to be re-resolved manually.
 */
const CACHED_ENTRY_TTL_SECONDS = 90 * 24 * 60 * 60;
const CACHED_ENTRY_KEY = (version: string) => `cachedEntry:${version}`;

export interface CachedEntryCache {
  url: string | null;
  source: "sitemap" | "hardcoded" | "wayback" | "none";
  image: string | null;
  shortText: string | null;
  lastmod: string | null;
}

export async function getCachedEntry(
  version: string,
): Promise<CachedEntryCache | null> {
  const raw = await runtimeCache.get(CACHED_ENTRY_KEY(version));
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    return JSON.parse(raw) as CachedEntryCache;
  } catch {
    return null;
  }
}

export async function setCachedEntry(
  version: string,
  entry: CachedEntryCache,
): Promise<void> {
  await runtimeCache.set(CACHED_ENTRY_KEY(version), JSON.stringify(entry), {
    ttl: CACHED_ENTRY_TTL_SECONDS,
    tags: ["cachedEntry"],
  });
}

export async function expireAllCachedEntries(): Promise<void> {
  await runtimeCache.expireTag("cachedEntry");
}