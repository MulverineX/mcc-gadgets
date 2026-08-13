import { getCache } from "@vercel/functions";

/**
 * Production CDX (Wayback) fetcher. Cache is per-URL, 24h TTL — Wayback
 * captures are immutable so we never need to revalidate. Tag `cdx` lets us
 * blow away the entire CDX cache in one shot if needed.
 */
const runtimeCache = getCache({ namespace: "java-changelog" });

const CDX_TTL_SECONDS = 24 * 60 * 60;

function cdxKey(url: string): string {
  return `cdx:${url}`;
}

/**
 * Cached CDX fetcher for production. Reads through to the Wayback CDX API
 * and persists responses in the Vercel runtime cache. Used by
 * `resolveUpstream` as the default `cdxFetch` implementation.
 *
 * Returns `null` when the response is non-OK, the body is empty, or the
 * underlying fetch throws. Empty responses are still cached so we don't
 * retry a known-empty URL for 24h.
 */
export async function fetchCdx(url: string): Promise<string | null> {
  const cached = await runtimeCache.get(cdxKey(url));
  if (typeof cached === "string") return cached;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const text = await res.text();
    await runtimeCache.set(cdxKey(url), text, {
      ttl: CDX_TTL_SECONDS,
      tags: ["cdx"],
    });
    return text;
  } catch {
    return null;
  }
}

export async function expireAllCdx(): Promise<void> {
  await runtimeCache.expireTag("cdx");
}
