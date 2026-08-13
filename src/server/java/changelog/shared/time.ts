/**
 * Convert an ISO 8601 timestamp (or any string `Date.parse` accepts, including
 * the `YYYY-MM-DD` form sitemap `lastmod` uses) to a Unix timestamp in
 * integer seconds. Returns null for nullish input or unparseable strings.
 */
export function toUnixSeconds(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 1000);
}
