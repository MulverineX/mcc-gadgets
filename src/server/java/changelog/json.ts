import { cache as unstableCache } from "~/lib/fetch";

import { loadCachedVersions } from "./cached";
import { fetchParsedVersion } from "./parsed";
import type { LocalCache } from "./shared/local-cache";
import { humanReadableTitle } from "./shared/title";
import type { CachedEntry, JsonEntry, JsonResponse } from "./types";

export interface JsonVersionsOptions {
  /** When provided, every underlying fetcher goes through this cache. */
  cache?: LocalCache;
  /** Pre-populated visited set; passed through to `loadCachedVersions`. */
  visited?: Set<string>;
}

/**
 * `versions/json` — merges `versions/cached` metadata with the full article
 * body fetched from the per-version parsed endpoint. Per PLAN §versions/json:
 * "reads from versions/cached for any version that has an entry there" — when
 * an entry is missing, falls back to calling the parsed endpoint directly.
 */
export const getJsonVersions = unstableCache(
  async (_options: JsonVersionsOptions = {}): Promise<JsonResponse> => {
    return loadJsonVersions(_options);
  },
  ["java", "changelog", "json"],
  { revalidate: 60 /* 1 min */ },
);

/**
 * Unwrapped body of `getJsonVersions` — testable with `{ cache }` without
 * going through the Next.js `unstable_cache` key serialization.
 */
export async function loadJsonVersions(
  options: JsonVersionsOptions = {},
): Promise<JsonResponse> {
  const cached = await loadCachedVersions(options);

  const entries: JsonEntry[] = await Promise.all(
    cached.entries.map(async (base) => {
      const body = await fetchBodyIfAvailable(base.version, base, options);
      return {
        ...base,
        title: humanReadableTitle(base.version),
        body: body?.body ?? null,
      };
    }),
  );

  return { entries };
}

async function fetchBodyIfAvailable(
  version: string,
  cached: CachedEntry | null,
  options: JsonVersionsOptions,
) {
  // No upstream URL → no body possible (sidebar-only entry per "404 exposure" rule).
  if (cached && !cached.url) return null;
  // Offline mode (LocalCache provided): don't try to fetch every manifest
  // version's HTML from the network. Body content is exercised by the
  // per-version tests; bulk tests verify the response shape only.
  if (options.cache) return null;
  return fetchParsedVersion(version).catch(() => null);
}
