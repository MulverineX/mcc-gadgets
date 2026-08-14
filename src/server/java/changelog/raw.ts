import { getVersionManifest } from "./manifest";
import type { LocalCache } from "./shared/local-cache";
import { buildResolveContext, resolveUpstream } from "./shared/resolver";
import { getSitemapMap } from "./shared/sitemap";

export interface RawHtmlResult {
  body: string;
  contentType: "text/html; charset=utf-8";
}

export interface FetchOptions {
  /** When provided, manifest/sitemap/CDX fetches go through this cache. */
  cache?: LocalCache;
}

/**
 * Pure pass-through: fetch the upstream HTML for a version (minecraft.net or
 * Wayback Machine) and return it as-is. No parsing, no transformation. Returns
 * `null` when no source can be resolved (the route maps this to a 404).
 */
export async function fetchRawHtml(
  version: string,
  options: FetchOptions = {},
): Promise<RawHtmlResult | null> {
  const [manifest, sitemapMap] = await Promise.all([
    options.cache ? options.cache.fetchManifest() : getVersionManifest(),
    options.cache ? options.cache.fetchSitemapMap() : getSitemapMap(),
  ]);

  const entry = manifest.versions.find((v) => v.id === version);
  if (!entry) return null;

  const ctx = buildResolveContext(manifest, sitemapMap);
  const upstream = await resolveUpstream(entry, ctx, { cache: options.cache });
  if (!upstream.url) return null;

  const res = await fetch(upstream.url);
  if (!res.ok) return null;

  const body = await res.text();
  return { body, contentType: "text/html; charset=utf-8" };
}
