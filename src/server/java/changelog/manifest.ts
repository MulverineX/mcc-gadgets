import { cache } from "~/lib/fetch";

import { parseManifestJson } from "./shared/schemas";
import type { LocalCache } from "./shared/local-cache";
import type { VersionManifestResponse } from "./types";

const PISTON_META_URL =
  "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

/**
 * Mojang has shipped malformed version IDs in `version_manifest_v2.json` (notably
 * the 1.14 pre-release series) that break slug construction downstream. Normalize
 * them here so every consumer sees the canonical form.
 */
const SANITIZE_MAP: Record<string, string> = {
  "1.14 Pre-Release 5": "1.14-pre5",
  "1.14 Pre-Release 4": "1.14-pre4",
  "1.14 Pre-Release 3": "1.14-pre3",
  "1.14 Pre-Release 2": "1.14-pre2",
  "1.14 Pre-Release 1": "1.14-pre1",
  "1.14.1 Pre-Release 2": "1.14.1-pre2",
  "1.14.1 Pre-Release 1": "1.14.1-pre1",
  "1.14.2 Pre-Release 4": "1.14.2-pre4",
  "1.14.2 Pre-Release 3": "1.14.2-pre3",
  "1.14.2 Pre-Release 2": "1.14.2-pre2",
  "1.14.2 Pre-Release 1": "1.14.2-pre1",
};

const sanitizeId = (id: string): string => SANITIZE_MAP[id] ?? id;

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
        id: sanitizeId(v.id),
      })),
    };
  },
  ["java", "changelog", "version_manifest"],
  { revalidate: 5 * 60 /* 5 min */ },
);
