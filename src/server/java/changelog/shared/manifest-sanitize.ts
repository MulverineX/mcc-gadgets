/**
 * Mojang has shipped malformed version IDs in `version_manifest_v2.json` (notably
 * the 1.14 pre-release series) that break slug construction downstream. Normalize
 * them here so every consumer — the runtime manifest fetcher AND the test fixture
 * loader (`LocalCache.fetchManifest`) — sees the canonical form.
 *
 * Kept in `shared/` to avoid a circular dep: `local-cache.ts` can't import from
 * `manifest.ts` because `manifest.ts` type-imports `LocalCache` for its
 * `ManifestFetchOptions` shape.
 */
export const MANIFEST_SANITIZE_MAP: Record<string, string> = {
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

export const sanitizeManifestId = (id: string): string =>
  MANIFEST_SANITIZE_MAP[id] ?? id;
