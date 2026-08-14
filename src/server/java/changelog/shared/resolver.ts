import type { SitemapEntry, VersionManifestEntry } from "../types";
import { fetchCdx } from "./cdx-fetch";
import { resolveLegacyWaybackUrlRaw } from "./legacy";
import type { LocalCache } from "./local-cache";

/**
 * The minecraft.net URL prefix for article pages. Article URLs are constructed
 * from a slug as `{MINECRAFT_NET_ARTICLE_BASE}/{slug}`.
 */
const MINECRAFT_NET_ARTICLE_BASE = "https://www.minecraft.net/en-us/article";

/**
 * April-fools version IDs map to non-standard article slugs that are discoverable
 * on minecraft.net but don't match the slug-derivation patterns. Catch them here
 * before any candidate generation.
 */
const APRIL_FOOLS_MAP: Record<string, string> = {
  "24w14potato": "poisonous-potato-update",
  "25w14craftmine": "the-craftmine-update",
  "26w14a": "the-herdcraft-update",
  "22w13oneblockatatime": "mojang-studios-release-new-astonishing-update",
  "20w14infinite": "every-update-imaginable-coming-minecraft",
  "23w13a_or_b": "vote-update",
};

/**
 * Article slugs that cover multiple versions (shared pages). Mapped explicitly
 * because the version-id → slug derivation doesn't produce these slugs.
 */
const SLUG_COVERS_MULTIPLE: Record<string, string[]> = {
  "minecraft-snapshot-17w16b": ["17w16b", "17w16a"],
  "minecraft-snapshot-18w20b": ["18w20b", "18w20a"],
  "minecraft-snapshot-18w48b": ["18w48b", "18w48a"],
  "minecraft-snapshot-19w14a0": ["19w14b", "19w14a"],
  "minecraft-snapshot-19w11": ["19w11b", "19w11a"],
  "minecraft-112-pre-release-2": ["1.12-pre2", "1.12-pre1"],
  "minecraft-snapshot-17w31a": ["17w31a", "1.12.1-pre1"],
  "minecraft-snapshot-18w33a": ["18w33a", "1.13.1-pre1", "1.13.1-pre2"],
  "minecraft-java-edition-1122-pre-release": ["1.12.2-pre2", "1.12.2-pre1"],
  "minecraft-1-16-2-pre-release-2": [
    "1.16.2-pre3",
    "1.16.2-pre2",
    "1.16.2-rc2",
    "1.16.2-rc1",
  ],
};

/**
 * Versions for which no fetchable article exists. The sidebar still shows them
 * per the "404 exposure" rule.
 */
const KNOWN_INACCESSIBLE = new Set([
  "1.13.2-pre1",
  "1.13.2-pre2",
  "19w03a",
  "19w03b",
  "19w03c",
]);

/**
 * Non-discoverable base-release slugs from PLAN §Hardcoded Exceptions.
 *
 * `1.11` lives on mojang.com (Wayback only) and is intentionally absent here —
 * it's resolved by the legacy handler, not by minecraft.net lookup.
 */
const HARDCODED_BASE_RELEASES: Record<string, string> = {
  "1.12": "world-color-released",
  "1.13": "update-aquatic-out-java",
  "1.14": "village---pillage-out-java-",
  "1.15": "buzzy-bees-out-now-in-java",
  "1.16": "nether-update-java",
  "1.17": "caves---cliffs--part-i-out-today-java",
  "1.18": "caves---cliffs--part-ii-out-today-java",
  "1.19": "the-wild-update-out-today-java",
  "1.20": "trails-tales-update-out-today-java",
};

export interface ResolveContext {
  /** Sitemap entries keyed by slug. */
  sitemap: Map<string, SitemapEntry>;
  /** All manifest entries keyed by version id (used for new-snapshot cascade time-gap check). */
  manifest: Map<string, VersionManifestEntry>;
}

/**
 * Build a `ResolveContext` from a parsed manifest and a sitemap map. Used
 * by `cached.ts` to wire `resolveVersion` into the runtime fetchers; the
 * parser snapshot suite reuses the same builder so production and tests
 * agree on how the lookup tables are assembled.
 */
export function buildResolveContext(
  manifest: { versions: VersionManifestEntry[] },
  sitemap: Map<string, SitemapEntry>,
): ResolveContext {
  return {
    sitemap,
    manifest: new Map(manifest.versions.map((v) => [v.id, v])),
  };
}

export interface ResolvedVersion {
  /** minecraft.net article URL, or null when no sitemap-discoverable page exists. */
  url: string | null;
  /** Slug (trailing path segment) when an article was found. */
  slug: string | null;
  /** Sitemap `lastmod` for the matched article, used by the invalidation hook. */
  lastmod: string | null;
  source: "sitemap" | "hardcoded" | "none";
}

export interface ResolvedUpstream {
  url: string | null;
  source: "sitemap" | "hardcoded" | "wayback" | "none";
  lastmod: string | null;
}

/**
 * Options bag passed through the fetch stack so tests can swap in a
 * `LocalCache` for fixture-backed fetches. Mirrors the React/Next.js
 * pattern of an options object on a fetch call — production omits it,
 * tests pass `{ cache: new LocalCache(...) }`.
 */
export interface ResolveOptions {
  /** When provided, the CDX fetcher is `cache.cdxFetcher()` (disk-backed). */
  cache?: LocalCache;
  /** Override the CDX fetcher outright. Takes precedence over `cache`. */
  cdxFetch?: (url: string) => Promise<string | null>;
}

/**
 * Resolve a version to its upstream article URL + source. Tries sitemap
 * first (cheap), then falls back to the Wayback Machine for legacy versions.
 * The optional `options.cache` lets tests inject a `LocalCache`; the
 * optional `options.cdxFetch` overrides the CDX fetcher outright. Production
 * callers omit both and use the cached `fetchCdx` from `cdx-fetch.ts`.
 */
export async function resolveUpstream(
  entry: VersionManifestEntry,
  ctx: ResolveContext,
  options: ResolveOptions = {},
): Promise<ResolvedUpstream> {
  const resolved = resolveVersion(entry, ctx);
  if (resolved.url) {
    return { url: resolved.url, source: resolved.source, lastmod: resolved.lastmod };
  }
  // Sitemap miss — try Wayback for legacy versions.
  const cdxFetch = options.cdxFetch ?? options.cache?.cdxFetcher() ?? fetchCdx;
  const capture = await resolveLegacyWaybackUrlRaw(entry.id, cdxFetch);
  if (capture) return { url: capture.url, source: "wayback", lastmod: null };
  return { url: null, source: "none", lastmod: null };
}

/**
 * Resolve a single version from the manifest to its minecraft.net article URL.
 * Pure: no network, no I/O. Returns `{ url: null, source: "none" }` when no
 * sitemap-discoverable article exists — legacy (Wayback) is handled separately.
 */
export function resolveVersion(
  entry: VersionManifestEntry,
  ctx: ResolveContext,
): ResolvedVersion {
  const { id } = entry;

  if (KNOWN_INACCESSIBLE.has(id)) {
    return { url: null, slug: null, lastmod: null, source: "none" };
  }

  // 1. Direct mappings (april-fools slugs, shared-page slugs)
  const directSlug = APRIL_FOOLS_MAP[id] ?? findSharedSlug(id);
  if (directSlug) {
    const sitemapEntry = ctx.sitemap.get(directSlug);
    if (sitemapEntry) {
      return {
        url: sitemapEntry.url,
        slug: directSlug,
        lastmod: sitemapEntry.lastmod ?? null,
        source: "sitemap",
      };
    }
  }

  // 2. Candidate match from id-pattern derivation
  for (const slug of versionToCandidates(id)) {
    const sitemapEntry = ctx.sitemap.get(slug);
    if (sitemapEntry) {
      return {
        url: sitemapEntry.url,
        slug,
        lastmod: sitemapEntry.lastmod ?? null,
        source: "sitemap",
      };
    }
  }

  // 3. Cascade: lower numbers / letters in same series
  const cascaded = cascadeSlug(id, entry, ctx);
  if (cascaded) {
    const sitemapEntry = ctx.sitemap.get(cascaded);
    if (sitemapEntry) {
      return {
        url: sitemapEntry.url,
        slug: cascaded,
        lastmod: sitemapEntry.lastmod ?? null,
        source: "sitemap",
      };
    }
  }

  // 4. Hardcoded non-discoverable minecraft.net base releases (1.12–1.20).
  //    These slugs may also appear in the sitemap; the sitemap path above will
  //    have caught that case. Only reached when the sitemap does NOT contain
  //    the slug.
  const hardcodedSlug = HARDCODED_BASE_RELEASES[id];
  if (hardcodedSlug) {
    return {
      url: `${MINECRAFT_NET_ARTICLE_BASE}/${hardcodedSlug}`,
      slug: hardcodedSlug,
      lastmod: null,
      source: "hardcoded",
    };
  }

  return { url: null, slug: null, lastmod: null, source: "none" };
}

function findSharedSlug(id: string): string | undefined {
  for (const [slug, versions] of Object.entries(SLUG_COVERS_MULTIPLE)) {
    if (versions.includes(id)) return slug;
  }
  return undefined;
}

/**
 * Derive ordered candidate slugs from a version id. Tries the most-specific
 * variant first, then the bare "shared page" variant, then hyphenated/old
 * patterns. The first candidate that resolves against the sitemap wins.
 */
export function versionToCandidates(id: string): string[] {
  const candidates: string[] = [];

  // Old-format snapshot: 18w22a -> minecraft-snapshot-18w22a. Decrement +
  // letterless base happen in the cascade below, not here — exact letter
  // first, then siblings, then bare-base last resort.
  const oldSnap = /^(\d+w\d+)([a-z]?)$/.exec(id);
  if (oldSnap) {
    const [, base, letter] = oldSnap;
    // Known sitemap typo: 19w14a/b/c share the 4-char-suffix URL "19w14a0".
    // Probe that URL first — the exact-letter slug never exists in the
    // sitemap for this family.
    if (base === "19w14" && (letter === "a" || letter === "b")) {
      candidates.push(`minecraft-snapshot-${base}a0`);
    }
    candidates.push(`minecraft-snapshot-${base}${letter ?? ""}`);
    if (letter) candidates.push(`snapshot-${base}${letter}`);
    return candidates;
  }

  // New-format snapshot: 26.1-snapshot-1 -> minecraft-26-1-snapshot-1
  const newSnap = /^(\d+)\.(\d+)-snapshot-(\d+)$/.exec(id);
  if (newSnap) {
    const [, major, minor, num] = newSnap;
    candidates.push(`minecraft-${major}-${minor}-snapshot-${num}`);
    candidates.push(`minecraft-${major}-${minor}-snapshot`);
    return candidates;
  }

  // Pre-release: 1.12-pre1 / 1.12-pre-release-1 / 26.1-pre-1 / 1.12-pre-release
  //              -> minecraft-112-pre-release-1, minecraft-1-12-pre-release-1, bare
  const pre = /^(\d+\.\d+(?:\.\d+)?)-pre(?:-release)?-?(\d+)?$/.exec(id);
  if (pre) {
    const version = pre[1];
    const num = pre[2] ?? "1";
    if (version) {
      const parts = version.split(".");
      const major = parts[0];
      const minor = parts[1];
      const patch = parts[2];
      if (parts.length === 2 && major && minor) {
        const concat = `${major}${minor}`;
        candidates.push(`minecraft-${concat}-pre-release-${num}`);
        candidates.push(`minecraft-${concat}-pre-release`);
        candidates.push(`minecraft-${major}-${minor}-pre-release-${num}`);
        candidates.push(`minecraft-${major}-${minor}-pre-release`);
      } else if (major && minor && patch) {
        const concat = `${major}${minor}${patch}`;
        candidates.push(`minecraft-${concat}-pre-release-${num}`);
        candidates.push(`minecraft-${concat}-pre-release`);
        candidates.push(`minecraft-${major}-${minor}-${patch}-pre-release-${num}`);
        candidates.push(`minecraft-${major}-${minor}-${patch}-pre-release`);
      }
    }
    return candidates;
  }

  // Release candidate: 1.16-rc1 / 1.16.4-rc1 / 26.1-rc-1 / 1.16-release-candidate
  const rc = /^(\d+\.\d+(?:\.\d+)?)-rc(?:-?(\d+))?$/.exec(id);
  if (rc) {
    const version = rc[1];
    const num = rc[2] ?? "1";
    if (version) {
      const parts = version.split(".");
      const major = parts[0];
      const minor = parts[1];
      const patch = parts[2];
      if (parts.length === 2 && major && minor) {
        candidates.push(`minecraft-${major}-${minor}-release-candidate-${num}`);
        candidates.push(`minecraft-${major}-${minor}-release-candidate`);
      } else if (major && minor && patch) {
        candidates.push(`minecraft-${major}-${minor}-${patch}-release-candidate-${num}`);
        candidates.push(`minecraft-${major}-${minor}-${patch}-release-candidate`);
      }
    }
    return candidates;
  }

  // Patch: 1.20.4
  const patchMatch = /^(\d+)\.(\d+)\.(\d+)$/.exec(id);
  if (patchMatch) {
    const [, major, minor, patch] = patchMatch;
    if (major && minor && patch) {
      const concat4 = `${major}${minor}${patch}`;
      candidates.push(`minecraft-java-edition-${major}-${minor}-${patch}`);
      candidates.push(`minecraft-java-${major}-${minor}-${patch}-released`);
      candidates.push(`minecraft-java-${major}-${minor}-${patch}`);
      candidates.push(`minecraft-java-edition-${concat4}`);
      candidates.push(`minecraft-${concat4}-released`);
      candidates.push(`minecraft--java-edition-${major}-${minor}-${patch}`);
    }
    return candidates;
  }

  // Base release: 1.21
  const baseMatch = /^(\d+)\.(\d+)$/.exec(id);
  if (baseMatch) {
    const [, major, minor] = baseMatch;
    if (major && minor) {
      candidates.push(`minecraft-java-edition-${major}-${minor}`);
    }
    return candidates;
  }

  return candidates;
}

/**
 * When the candidate list fails, fall back to lower-numbered siblings in the
 * same series. For new-format snapshots, stop cascading when the gap between
 * releases exceeds 5 days (heuristic: the article is unlikely to cover both).
 */
function cascadeSlug(
  id: string,
  entry: VersionManifestEntry,
  ctx: ResolveContext,
): string | null {
  // Pre-release / RC: cascade to lower numbered sibling. Number is captured
  // here rather than re-matched separately: ids like `1.12-pre7` have no
  // standalone `-N` at the end (the only `-` is before `pre`), so a tail
  // regex like `/-(\d+)$/` returns undefined and the cascade silently no-ops.
  const pre = /^(.+)-(pre|rc)(-?\d+)?$/.exec(id);
  if (pre) {
    const [, base, kind, numStr] = pre;
    if (base && kind && numStr) {
      const num = Number(numStr);
      for (let n = num - 1; n >= 1; n--) {
        const siblingId = `${base}-${kind}${n}`;
        const siblingCandidates = versionToCandidates(siblingId);
        for (const slug of siblingCandidates) {
          if (ctx.sitemap.has(slug)) return slug;
        }
      }
    }
    return null;
  }

  // New-format snapshot: cascade to lower number, stop if gap > 5 days
  const newSnap = /^(\d+)\.(\d+)-snapshot-(\d+)$/.exec(id);
  if (newSnap) {
    const [, major, minor, numStr] = newSnap;
    if (!major || !minor || !numStr) return null;
    const num = Number(numStr);
    const targetTime = new Date(entry.releaseTime).getTime();
    for (let n = num - 1; n >= 1; n--) {
      const siblingId = `${major}.${minor}-snapshot-${n}`;
      const sibling = ctx.manifest.get(siblingId);
      if (!sibling) break;
      const gapMs = targetTime - new Date(sibling.releaseTime).getTime();
      if (gapMs > 5 * 24 * 60 * 60 * 1000) break;
      const slug = `minecraft-${major}-${minor}-snapshot-${n}`;
      if (ctx.sitemap.has(slug)) return slug;
    }
    return null;
  }

  // Old-format snapshot: cascade to lower letter suffix, then letterless
  // base as a last resort. Probes both `minecraft-snapshot-{ww}{x}` and
  // `snapshot-{ww}{x}` (without the prefix) at each step — minecraft.net
  // can publish a shared article at `minecraft-snapshot-18w22` for some
  // families; mojang.com never does, so the legacy Wayback path queries
  // the letter-bearing slugs only.
  const oldSnap = /^(\d+w\d+)([a-z])$/.exec(id);
  if (oldSnap) {
    const [, base, letter] = oldSnap;
    if (!base || !letter) return null;
    const startCode = letter.charCodeAt(0);
    for (let i = startCode - 1; i >= "a".charCodeAt(0); i--) {
      const l = String.fromCharCode(i);
      const prefixed = `minecraft-snapshot-${base}${l}`;
      if (ctx.sitemap.has(prefixed)) return prefixed;
      const bare = `snapshot-${base}${l}`;
      if (ctx.sitemap.has(bare)) return bare;
    }
    // Last resort: letterless base.
    const basePrefixed = `minecraft-snapshot-${base}`;
    if (ctx.sitemap.has(basePrefixed)) return basePrefixed;
    const baseBare = `snapshot-${base}`;
    if (ctx.sitemap.has(baseBare)) return baseBare;
    return null;
  }

  return null;
}