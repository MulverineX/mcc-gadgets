/**
 * Vercel CDN cache header values per PLAN.current.md §Caching Strategy.
 * Applied as `s-maxage` and `stale-while-revalidate` on route responses.
 */
export const CDN_CACHE = {
  versionManifest: { sMaxAge: 300, staleWhileRevalidate: 60 },
  cached: { sMaxAge: 10_800, staleWhileRevalidate: 3_600 },
  json: { sMaxAge: 60, staleWhileRevalidate: 60 },
  rss: { sMaxAge: 60, staleWhileRevalidate: 60 },
  versionHit: { sMaxAge: 31_536_000, staleWhileRevalidate: 86_400 },
  versionMiss: { sMaxAge: 60, staleWhileRevalidate: 0 },
} as const;

/** Build a `Cache-Control` header value from a `{ sMaxAge, staleWhileRevalidate }` pair. */
export function cacheControl({
  sMaxAge,
  staleWhileRevalidate,
}: {
  sMaxAge: number;
  staleWhileRevalidate: number;
}): string {
  const parts = [`s-maxage=${sMaxAge}`];
  if (staleWhileRevalidate > 0) {
    parts.push(`stale-while-revalidate=${staleWhileRevalidate}`);
  }
  return parts.join(", ");
}