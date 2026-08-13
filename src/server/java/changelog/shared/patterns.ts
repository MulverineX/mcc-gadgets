/**
 * Classify a minecraft.net article slug into a known pattern type.
 * Used by the sitemap parser and by tests; the runtime resolver does not
 * classify incoming slugs — it classifies manifest version IDs.
 */
export type SitemapPatternType =
  | "snapshot-old"
  | "snapshot-new"
  | "pre-release"
  | "release-candidate"
  | "patch"
  | "release"
  | "blog";

export function detectPattern(slug: string): SitemapPatternType {
  // New-format snapshot: minecraft-26-1-snapshot-1
  if (/^minecraft-\d+-\d+-snapshot-\d+$/.test(slug)) return "snapshot-new";
  // Old-format snapshot: minecraft-snapshot-18w22a
  if (/^minecraft-snapshot-\d+w\d+[a-z]?$/.test(slug)) return "snapshot-old";
  // Typo'd snapshot slug in sitemap
  if (slug === "minecraft-snapshot-19w14a0") return "snapshot-old";
  // Missing minecraft- prefix in sitemap
  if (slug === "snapshot-16w50a") return "snapshot-old";
  // Combat snapshot is blog content
  if (slug === "experimental-java-edition-combat-snapshot-v5") return "blog";
  // Pre-release: multiple formats (concatenated 112, hyphenated 1-14-2, java-edition prefix, bare)
  if (/^minecraft-\d+-pre-release(-\d+)?$/.test(slug)) return "pre-release";
  if (/^minecraft-\d+(?:-\d+)*-pre-release(-\d+)?$/.test(slug))
    return "pre-release";
  if (/^minecraft-java-edition-\d+-pre-release(-\d+)?$/.test(slug))
    return "pre-release";
  if (/^minecraft-java-edition-\d{3,}-pre-release(-\d+)?$/.test(slug))
    return "pre-release";
  // Bedrock-only update articles are blog content
  // Release candidate: bare or numbered, hyphenated or concatenated
  if (/^minecraft-\d+-\d+(-\d+)?-release-candidate(-\d+)?$/.test(slug))
    return "release-candidate";
  // Patch: java-edition with 3 parts, java with -released suffix, double-hyphen typo
  if (/^minecraft-java(?:-edition)?-\d+-\d+-\d+(-released)?$/.test(slug))
    return "patch";
  if (/^minecraft--java-edition-\d+-\d+-\d+(-released)?$/.test(slug))
    return "patch";
  if (/^minecraft-java(?:-edition)?-\d{4,}$/.test(slug)) return "patch";
  // Concatenated patch with -released
  if (/^minecraft-\d{4,}-released$/.test(slug)) return "patch";
  // Base release: hyphenated 2-part, single part, java-edition 2-part
  if (/^minecraft-\d+-\d+$/.test(slug)) return "release";
  if (/^minecraft-\d+$/.test(slug)) return "release";
  if (/^minecraft-java-edition-\d+-\d+$/.test(slug)) return "release";
  // Hardcoded release slugs from PLAN
  if (slug === "world-color-released") return "release";
  return "blog";
}