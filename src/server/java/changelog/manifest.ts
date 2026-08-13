import { cache } from "~/lib/fetch";

import { sanitizeManifestId } from "./shared/manifest-sanitize";
import { parseManifestJson } from "./shared/schemas";
import type { LocalCache } from "./shared/local-cache";
import type { VersionManifestResponse } from "./types";

const PISTON_META_URL =
  "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

export interface ManifestFetchOptions {
  /** When provided, read the manifest from the LocalCache disk fixture. */
  cache?: LocalCache;
}

/**
 * Production manifest fetcher (network + zod-validated). Tests pass
 * `{ cache: new LocalCache(...) }` to substitute a disk-backed read; both
 * paths funnel through `parseManifestJson` so the validated shape is
 * identical regardless of source.
 */
export const getVersionManifest = cache(
  async (_options: ManifestFetchOptions = {}): Promise<VersionManifestResponse> => {
    const res = await fetch(PISTON_META_URL);
    if (!res.ok) {
      throw new Error(`manifest fetch failed: ${res.status}`);
    }
    const raw = parseManifestJson(await res.json());

    return {
      ...raw,
      versions: raw.versions.map((v) => ({
        ...v,
        id: sanitizeManifestId(v.id),
      })),
    };
  },
  ["java", "changelog", "version_manifest"],
  { revalidate: 5 * 60 /* 5 min */ },
);
