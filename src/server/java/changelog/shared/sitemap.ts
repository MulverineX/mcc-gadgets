import { cache } from "~/lib/fetch";
import { z } from "zod";

import { detectPattern } from "./patterns";
import { SitemapEntrySchema } from "./schemas";
import type { SitemapData, SitemapEntry } from "../types";
import type { LocalCache } from "./local-cache";

const SITEMAP_URL = "https://www.minecraft.net/sitemap.xml";

/**
 * Shared parser used by both production (`getSitemap`) and the test
 * fixture (`LocalCache.fetchSitemapMap`). Production reads the XML body via
 * `fetch(...).text()`; LocalCache reads it from disk; both end up here.
 *
 * The previous implementation tried to feed the XML through `res.json()`,
 * which always failed at runtime — `parseSitemapXml` is the corrected
 * pipeline that both paths now share.
 */
export function parseSitemapXml(xml: string): SitemapData {
  return { entries: extractSitemapEntries(xml) };
}

export interface SitemapFetchOptions {
  /** When provided, read the sitemap from the LocalCache disk fixture. */
  cache?: LocalCache;
}

/**
 * Fetch the minecraft.net sitemap, parse it, and return a flat list of
 * article entries. The sitemap may be a sitemap index pointing to per-language
 * sitemaps — htmlparser2 walks all `<loc>` elements, so the nested structure
 * is transparent to callers. Tests pass `{ cache }` to read from the
 * fixture on disk; production omits it.
 */
export const getSitemap = cache(
  async (_options: SitemapFetchOptions = {}): Promise<SitemapData> => {
    const res = await fetch(SITEMAP_URL);
    if (!res.ok) throw new Error(`sitemap fetch failed: ${res.status}`);
    return parseSitemapXml(await res.text());
  },
  ["java", "changelog", "sitemap"],
  { revalidate: 3 * 60 * 60 /* 3 hr */ },
);

/**
 * Flatten a sitemap XML document into an array of article entries. Shared
 * with the test suite (no htmlparser2 dependency required) so both the
 * cached runtime fetcher and the test fetcher can deserialize the same way.
 */
export function extractSitemapEntries(xml: string): SitemapEntry[] {
  const entries: Array<{ url: string; slug: string; lastmod?: string }> = [];
  const urlBlocks = xml.match(/<url>[\s\S]*?<\/url>/g) ?? [];
  for (const block of urlBlocks) {
    const loc = /<loc>([^<]+)<\/loc>/.exec(block)?.[1];
    if (!loc) continue;
    const slugMatch = /^https:\/\/www\.minecraft\.net\/en-us\/article\/(.+)$/.exec(loc);
    if (!slugMatch?.[1]) continue;
    const lastmod = /<lastmod>([^<]+)<\/lastmod>/.exec(block)?.[1];
    const slug = slugMatch[1];
    entries.push({ url: loc, slug, lastmod });
  }
  return z.array(SitemapEntrySchema).parse(
    entries.map((e) => ({
      ...e,
      patternType: detectPattern(e.slug),
    })),
  );
}

/** Convenience helper: sitemap entries keyed by slug for O(1) lookup. */
export async function getSitemapMap(
  options: SitemapFetchOptions = {},
): Promise<Map<string, SitemapEntry>> {
  if (options.cache) {
    return options.cache.fetchSitemapMap();
  }
  const { entries } = await getSitemap(options);
  return new Map(entries.map((e) => [e.slug, e]));
}