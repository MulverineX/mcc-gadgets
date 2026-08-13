# MCC-Gadgets Version & Changelog API

## Context

Replacing the `launchercontent.mojang.com` API with a faster alternative. The challenge: launchercontent is slow to update (30+ minutes, sometimes several hours). 1.12 articles are on minecraft.net but not in launchercontent. Legacy versions (pre-1.12) never had their changelog articles migrated to minecraft.net — they existed only on mojang.com. We use the Wayback Machine to retrieve them.

### Terminology

**Major release**: A base version release (e.g., 1.13, 1.14, 1.15) as opposed to a patch release (1.13.1, 1.13.2) or pre-release/snapshot.

## Data Sources

| Source | URL | Coverage |
|---|---|---|
| version_manifest_v2.json | `https://piston-meta.mojang.com/mc/game/version_manifest_v2.json` | All versions |
| launchercontent | `https://launchercontent.mojang.com/v2/javaPatchNotes.json` | 1.13+ releases |
| sitemap | `https://www.minecraft.net/sitemap.xml` | 1.12+ snapshots/pre-releases/patches |
| Wayback Machine CDX | `https://web.archive.org/cdx/search/cdx` | 1.11 and below |

### Coverage Boundaries

| Source | Coverage | Notes |
|---|---|---|
| `sitemap.xml` (minecraft.net) | **1.12+ all patch releases, pre-releases, snapshots** | All versions discoverable or hardcoded |
| Wayback Machine/mojang.com | **1.11 and below** | Valid until **September 2019** cutoff |

### Hardcoded Exceptions

Only these versions have non-discoverable URLs:

| Version | Slug | Source |
|---|---|---|
| **1.11** | `seek-out-the-exploration-update-111-on-pc-mac-now` | mojang.com |
| **1.12** | `world-color-released` | minecraft.net |
| **1.13** | `update-aquatic-out-java` | minecraft.net |
| **1.14** | `village---pillage-out-java-` | minecraft.net |
| **1.15** | `buzzy-bees-out-now-in-java` | minecraft.net |
| **1.16** | `nether-update-java` | minecraft.net |
| **1.17** | `caves---cliffs--part-i-out-today-java` | minecraft.net |
| **1.18** | `caves---cliffs--part-ii-out-today-java` | minecraft.net |
| **1.19** | `the-wild-update-out-today-java` | minecraft.net |
| **1.20** | `trails-tales-update-out-today-java` | minecraft.net |

All other legacy releases (1.9, 1.10) are discoverable via sitemap.

```
Timeline:
2011 ──────────────────────────────► 2019 ────► now
         Wayback (1.11-)        sitemap (1.12+)
```

## Sitemap Handling (minecraft.net)

The sitemap at `https://www.minecraft.net/sitemap.xml` covers all 1.12+ articles on minecraft.net — including all snapshots and pre-releases.

### URL Structure

minecraft.net article URLs follow different patterns depending on content type:

**Snapshots** (week notation):
```
https://www.minecraft.net/en-us/article/minecraft-snapshot-{XXwYY{suffix}}
Example: https://www.minecraft.net/en-us/article/minecraft-snapshot-18w22c
Discovery: All week-notation snapshot URLs follow this pattern — filter sitemap by `minecraft-snapshot-XXwYY`
  1. Try `minecraft-snapshot-18w22c` (exact match)
  2. Try N-1: `minecraft-snapshot-18w22b` (if 18w22c content is on the 18w22b page)
  3. Try N-2: `minecraft-snapshot-18w22a` (if 18w22c content is on the 18w22a page)
  Last resort fallback (rare): try `snapshot-18w22c` (no `minecraft-` prefix) — only needed for old snapshots like `snapshot-16w50a`
```

**New-format snapshots** (all snapshots from 26.1-snapshot-1 onward, beginning December 16, 2025):
```
https://www.minecraft.net/en-us/article/minecraft-{YY}-{M}-snapshot-{n}
Example: https://www.minecraft.net/en-us/article/minecraft-26-1-snapshot-1
Example: https://www.minecraft.net/en-us/article/minecraft-26-2-snapshot-1
Note: YY = year (26 = 2026), M = quarter/season (1-4)
```

**Cascade logic for new-format snapshots:**
1. Try `minecraft-{YY}-{M}-snapshot-{n}` (e.g., `minecraft-26-1-snapshot-6`)
2. If response is **404** and the previous snapshot number (`n-1`) was released within the last 5 days (per version manifest), try `minecraft-{YY}-{M}-snapshot-{n-1}`
3. Repeat step 2, decrementing `n` until either:
   - A response returns **200** and the article contains the expected version content (validated via page title/heading detection), OR
   - The previous snapshot was released **more than 5 days ago** — stop cascade, the version does not exist yet or is not published
4. If response is **200** but does **not contain the expected version content** (e.g., page shows `snapshot-5` content instead of `snapshot-6`), skip this version — do not retry, the content will appear on the correct page when published. Poll again on next interval.

**Cascaded article splitting:**
When a cascade fetches `snapshot-{n-1}` and gets a 200, that article page may be a **merged page** containing content for multiple snapshots (e.g., snapshot-6 content on the snapshot-5 page). Detection: scan article for headings matching `/^(changes? in|technical changes? in|fixed bugs? in)\s*(.+)/i`, normalize each captured version string to lowercase with whitespace collapsed (e.g., "Changes in 26.1-Snapshot-6" → "26.1 snapshot 6"), deduplicate. If more than one unique version remains after deduplication, the page is merged. Split by scanning for these headings and extracting only the section matching the target version (e.g., "Changes in 26.1-snapshot-6"). Discard content from other snapshot sections on the same page. Sort sections numerically by version before assigning.

Note: Unlike old-format snapshots, there is no cascade to week-notation URLs. If a new-format snapshot returns 404, the cascade only decrements the sequential number within the new format. If the previous snapshot is older than 5 days, the version simply does not exist yet. Cascade stops at snapshot-1 — snapshot-0 and negative snapshot numbers do not exist.

**Pre-releases:**
```
https://www.minecraft.net/en-us/article/minecraft-{major}-{minor}-pre-release-{n}
Example: https://www.minecraft.net/en-us/article/minecraft-1-19-3-pre-release-2
Discovery:
  1. Try exact: `minecraft-1-19-3-pre-release-2`
  2. Try N-1: `minecraft-1-19-3-pre-release-1` (if pre-release-2 content is on the N-1 page)
  3. Try bare: `minecraft-1-19-3-pre-release` — shared-page: may have latest content
```

**Release candidates:**
```
https://www.minecraft.net/en-us/article/minecraft-{major}-{minor}-release-candidate-{n}
Example: https://www.minecraft.net/en-us/article/minecraft-26-1-2-release-candidate-2
Discovery: Same pattern as pre-releases
  1. Try exact: `minecraft-26-1-2-release-candidate-2`
  2. Try N-1: `minecraft-26-1-2-release-candidate-1` (if rc-2 content is on the N-1 page)
  3. Try bare: `minecraft-26-1-2-release-candidate` — shared-page: may have latest content
```

**Patch releases:**
```
https://www.minecraft.net/en-us/article/minecraft-java-edition-{major}-{minor}-{patch}
Example: https://www.minecraft.net/en-us/article/minecraft-java-edition-1-20-4
Discovery:
  1. Try exact: `minecraft-java-edition-{major}-{minor}-{patch}`
  2. If not found, try progressively earlier patches (e.g., for 1.20.4: 1.20.3 → 1.20.2 → 1.20.1 → etc.)
Note: Patch release articles can contain multiple patch versions on a single page — split by scanning for "Changes in X.Y.Z" headings
```

### URL Inconsistencies

The sitemap has inconsistent URL formatting that must be handled:

1. **Two snapshot URL formats** — Old: week notation (`minecraft-snapshot-18w22a`). New: sequential (`minecraft-26-1-snapshot-1`). Both exist in the sitemap.

2. **Some URLs use hyphens between major/minor, others don't** — `minecraft-1-16-pre-release-1` vs `minecraft-112-pre-release-3`

3. **Shared pages for pre-releases** — Multiple pre-release numbers link to the same article URL (e.g., `minecraft-112-pre-release-6` serves content for `minecraft-112-pre-release-7`). The page contains multiple "Changes in 1.12 pre-release N" sections. Always validate via page title or heading.

**Merged article fallback:** When we are certain an article page is merged (contains multiple version sections) but cannot programmatically resolve the content split (e.g., article content is broken or missing section markers), fall back to showing the entire article content rather than failing silently. The version entry should still be exposed — users can submit edits to fix the content. Example: `minecraft-112-pre-release-2` article contains broken content for `1.12-pre1`, which was merged backwards and doesn't mention pre1 at all.

**Sidebar exposure for 404 versions:** Some versions in the manifest have no article URL (404 from all sources). These should still appear in the version select sidebar so users know the version exists. When a user visits that version's page, they can submit content to fill the gap.

Known cases where article content is inaccessible:
- `1.13.2-pre1` and `1.13.2-pre2` — these pre-releases were published on minecraft.net but the `1.13.2` release article overwritten their content. No separate pre-release article exists.
- `19w03a`, `19w03b`, `19w03c` — the `19w03a` article was taken down and contained content for all three a/b/c snapshots. No article content is accessible for any of these versions.
- `19w11a` and `19w11b` — only `minecraft-snapshot-19w11` exists (no letter suffix). Both versions share that page.
- `19w14a` and `19w14b` — only `minecraft-snapshot-19w14a0` exists. Both versions share that page.

**April fools snapshots** — these versions don't follow normal naming and are mapped to their blog/article slugs:
- `24w14potato` → `poisonous-potato-update`
- `25w14craftmine` → `the-craftmine-update`
- `26w14a` → `the-herdcraft-update`
- `22w13oneblockatatime` → `mojang-studios-release-new-astonishing-update`
- `20w14infinite` → `every-update-imaginable-coming-minecraft`
- `23w13a_or_b` → `vote-update`

4. **Non-consecutive pre-release gaps are common** — A single page may have pre1, pre2, pre6 with pre3-pre5 missing. Always validate via page title.

7. **Shared pages for patch releases** — Both minecraft.net and mojang.com can serve multiple patch versions on a single article page. Example: the mojang.com 1.10.1 article contains both "Issues fixed in version 1.10.2:" and "Issues fixed in version 1.10.1:" sections. Detection: scan for multiple version headings, deduplicate by normalized version, split if >1. Sorting: numerically by version (1.10.1 before 1.10.2).

5. **Shared pages for old-format snapshots** — Same URL inconsistency applies: `snapshot-16w50a` served all 16w50 snapshots (a, b, etc.) on a single page. Example: `minecraft-snapshot-18w22a` serves all 18w22a/b/c/d variants on one page, but only `18w22a` is in the sitemap.

6. **Shared pages for release candidates** — Same issue as pre-releases: multiple RC versions may be served on a single URL.

### Sitemap → Article Fetch Flow

1. Fetch and parse `https://www.minecraft.net/sitemap.xml`
2. Filter for URLs containing `/en-us/article/`
3. Match URL patterns against target version:
   - Snapshots: match `minecraft-snapshot-XXwYY{suffix}` → extract week notation
   - Pre-releases: match `minecraft-{M}-{m}-pre-release-{N}` → exact match
4. Fetch article HTML at URL + `.json` suffix for full content
5. Validate article title matches expected version (critical for shared pages)

### Fetching Article Content

Article content requires a separate fetch. The URL structure:
```
https://www.minecraft.net/en-us/article/{slug}.json
```
Returns HTML content in `content` field.

## Wayback Machine Approach

### Why Not Just Use Sitemap for Everything?

The sitemap only covers minecraft.net articles, which didn't exist pre-1.14. Legacy versions (1.1 through 1.13) had their changelogs on mojang.com, which now redirects to minecraft.net — those articles are only recoverable via Wayback Machine.

### CDX API Query Pattern

One efficient request per version:

```
GET https://web.archive.org/cdx/search/cdx
  ?url={url-pattern}
  &from={YYYYMMDD}
  &to=20190901
  &filter=statuscode:200
  &sort=reverse
  &limit=1
  &fl=timestamp,original
```

- `from` = earliest possible date (derived from legacy mapping week/year)
- `to` = **20190901** (cutoff: captures after Sept 2019 redirect to minecraft.net)
- `filter=statuscode:200` = only successful captures
- `sort=reverse` + `limit=1` = latest good capture only
- `fl` = only return timestamp and original URL

### URL Patterns for mojang.com

**Snapshots:**
```
https://www.mojang.com/{year}/{month}/minecraft-snapshot-{XXwYY{suffix}}
Example: https://www.mojang.com/2016/05/minecraft-snapshot-16w20a/
CDX: url=mojang.com/2016/05/minecraft-snapshot-16w20a
Cascading fallback:
  1. Try specific: `minecraft-snapshot-16w20a` (with sort/limit=1)
  2. Try wildcard: `minecraft-snapshot-16w20*` (sort only)
```

**Pre-releases:**
```
https://www.mojang.com/{year}/{month}/minecraft-{major}{minor}-pre-release-{n}
Example: https://www.mojang.com/2016/06/minecraft-110-pre-release-1/
Note: NO hyphen between major and minor (110, not 1-10)
CDX: url=mojang.com/2016/06/minecraft-110-pre-release-1
Fallback: Some pre-releases are captured under "pre-release" without a number (e.g., `minecraft-110-pre-release`)
  1. Try specific: `minecraft-110-pre-release-1` (with sort/limit=1)
  2. Try wildcard: `minecraft-110-pre-release-*` (sort only)
  3. Try bare: `minecraft-110-pre-release` (no number, sort only)
```

**Releases:**
```
https://www.mojang.com/{year}/{month}/minecraft-{major}{minor}-*
Example: https://www.mojang.com/2016/06/minecraft-110-an-update-of-fire-and-ice/
Note: NO hyphen between major and minor (110, not 1-10)
CDX: url=mojang.com/2016/06/minecraft-110-*
Filter: exclude URLs containing 'pre-release', 'snapshot', 'release-candidate'
Filter: exclude purely numeric suffixes like '1101', '1102' (patch versions)
Note: CDX cannot use sort/limit for release wildcards — use unsorted
```

**Patch releases:**
```
https://www.mojang.com/{year}/{month}/minecraft-{major}{minor}{patch}
Example: https://www.mojang.com/2016/06/minecraft-1103/
Note: NO hyphens at all — just major, minor, and patch concatenated (1103 = 1.10.3)
CDX: url=mojang.com/{year}/{month}/minecraft-1103
Discovery:
  1. Try specific: `minecraft-1103` (with sort/limit=1)
  2. If not found, try progressively earlier patches: `minecraft-1102` → `minecraft-1101` → etc.
  3. The earliest patch article found may contain sections for later patches (e.g., `minecraft-1102` article contains both 1.10.2 and 1.10.3 sections) — split by scanning for "Issues fixed in version X.Y.Z:" headings
```

### Constructing Wayback URLs

From CDX response:
```
timestamp: 20190719040822
original:  https://www.mojang.com/2016/05/minecraft-snapshot-16w20a/
Wayback URL: https://web.archive.org/web/20190719040822/https://www.mojang.com/2016/05/minecraft-snapshot-16w20a/
```

### Article HTML Structure

The archived pages have clean, consistent structure:
- Title: `<h1 class="post-title">Minecraft 1.10 Pre-Release 1</h1>`
- Date: `<p class="post-meta">Posted on Jun 2, 2016 by Searge</p>`
- Content: `<article class="single-post post-content">...</article>`
- Hero image: `<div class="post-header__image"><img src="...">` from `media.mojang.com/blog-image/`

Bug entries: `<li>[Bug <a href="...">MC-XXXX</a>] - description</li>`

Parse with cheerio:
```typescript
const title = $('h1.post-title').text();
const meta = $('p.post-meta').text(); // strip "Posted on" / "by"
const content = $('article.post-content').html();
const heroImage = $('div.post-header__image img').attr('src');
```

### Article HTML Structure (minecraft.net)

The minecraft.net article pages contain:
- Title: in `<meta property="og:title">`
- Hero image: in `<meta property="og:image">` — URL like `/content/dam/minecraftnet/archive/{hash}-{version}-title.png`
- Content: fetched via `https://www.minecraft.net/en-us/article/{slug}.json`

Parse with cheerio:
```typescript
const title = $('meta[property="og:title"]').attr("content");
const heroImage = $('meta[property="og:image"]').attr("content");
// heroImage is relative, prepend https://www.minecraft.net
const imageUrl = heroImage ? 'https://www.minecraft.net' + heroImage : null;
```

## Month/Year from Week Number

From legacy mapping (weekStart, weekEnd, year), derive month for URL construction:
```typescript
// ISO week 20 of 2016 → May 2016
// ISO week 24 of 2016 → June 2016
const getMonthFromWeek = (year: number, week: number): number => {
  const jan4 = new Date(year, 0, 4); // Jan 4 is always in week 1
  const weekStart = new Date(jan4.getTime() + (week - 1) * 7 * 24 * 60 * 60 * 1000);
  return weekStart.getMonth() + 1; // 1-indexed
};
```

## Version Cycle Resolution

Some versions (pre-releases, RCs, legacy snapshots) have multiple article URLs per version due to Mojang's page-update pattern. The CDX query may return a URL that later contains content for a different sub-version. Always validate by:
1. Checking page title against expected version ID
2. Looking for "Pre-Release N" or "Snapshot XXwYYa" in title

## Implementation

### Files

- `scripts/legacy-version-mapping.ts` — week/year ranges for legacy versions (existing)
- `scripts/fetch-legacy-articles.ts` — new: batch fetch articles via CDX + Wayback
- `src/server/java/changelog.ts` — new: main data fetching module
- `src/app/api/changelog/route.ts` — new: API endpoint

### API Response Shape

```typescript
interface ChangelogArticle {
  version: string;        // "16w20a"
  type: "snapshot" | "pre-release" | "release";
  title: string;          // "Minecraft snapshot 16w20a"
  url: string | null;    // Wayback URL or null if not found
  publishedAt: string;    // "2016-05-18" (from releaseTime, not page date)
  content: string | null; // parsed HTML or null if not fetched
  image: string | null;   // hero image URL
  shortText: string | null; // first ~280 chars, initialized from launchercontent shortText on first load
  source: "wayback" | "launchercontent" | "sitemap"; // if article later appears in sitemap, update source to "sitemap"
}
```

### Sidebar Previews

The MCC Gadgets sidebar needs truncated article content and images.

**Launchercontent source** — each entry already provides:
- `image.url` — relative URL, e.g. `/v2/images/26.2snapshot3540x540.jpg`
- `shortText` — pre-truncated preview text (~280 chars)

**Image URL**: prepend `https://launchercontent.mojang.com/` to `image.url`

**shortText strategy**:
1. For launchercontent: use `shortText` directly (already ~280 chars)
2. For other sources: `shortText` is null — populated after someone visits the version page

### Cache TTLs

- **Version manifest**: 5 minutes
- **CDX query results**: permanent (URLs don't change)
- **Article content**: 3 hours with stale-while-revalidate

### Fallback Chain

1. Check if version is in sitemap → use minecraft.net URL
3. Check if version is in launchercontent → use that
4. Check if version is in legacy mapping (1.11 and older, including 1.11.x) → use CDX/Wayback
5. If not found anywhere → return `{ url: null, content: null }`

**URL construction from version manifest:**
- New-format snapshots: `minecraft-{YY}-{M}-snapshot-{n}` where YY/M come from the version's release date and n is the snapshot number in sequence
- Pre-releases: `minecraft-{major}-{minor}-pre-release-{n}`
- Release candidates: `minecraft-{major}-{minor}-release-candidate-{n}`
- Patch releases: `minecraft-java-edition-{major}-{minor}-{patch}`
- Always validate via page title/heading after fetching — shared pages are common

### Finding Patch Version Content on Merged Article Pages

When a patch version (e.g., 1.10.2) is served on a different version's article page (e.g., the 1.10.1 article), standard lookup methods won't find it directly. Since 1.10.x falls in the legacy range (pre-sitemap, pre-launchercontent), it is located via CDX/Wayback — but the Wayback URL for 1.10.2 may point to the same article page that also contains 1.10.1 content.

**Resolution strategy:**
1. Version `X.Y.Z` is looked up via CDX → returns a Wayback URL for the article
2. Fetch the article HTML and scan for "Issues fixed in version X.Y.Z:" (mojang) or "Changes in X.Y.Z" (minecraft.net)
3. If found alongside other version sections, split the article into per-version sections
4. The `url` field reflects the actual article URL the content was found on, not the version-specific URL

This handles the case where mojang.com article slugs are not derivable from version IDs for patch versions (e.g., the 1.10.1 article slug matches 1.10.1 but not 1.10.2 — the 1.10.2 content is found on the 1.10.1 article page).

## Test URLs

Verify Wayback Machine access:
```bash
# Snapshot (try specific first, then wildcard if not found)
curl "https://web.archive.org/cdx/search/cdx?url=mojang.com/2016/05/minecraft-snapshot-16w20a&from=20160501&to=20190901&filter=statuscode:200&sort=reverse&limit=1&fl=timestamp,original"
# If empty, try wildcard:
curl "https://web.archive.org/cdx/search/cdx?url=mojang.com/2016/05/minecraft-snapshot-16w20*&from=20160501&to=20190901&filter=statuscode:200&sort=reverse&fl=timestamp,original"

# Pre-release (try specific first, then wildcard, then bare)
curl "https://web.archive.org/cdx/search/cdx?url=mojang.com/2016/06/minecraft-110-pre-release-1&from=20160601&to=20190901&filter=statuscode:200&sort=reverse&limit=1&fl=timestamp,original"
# If empty, try wildcard:
curl "https://web.archive.org/cdx/search/cdx?url=mojang.com/2016/06/minecraft-110-pre-release-*&from=20160601&to=20190901&filter=statuscode:200&sort=reverse&fl=timestamp,original"
# If still empty, try bare (no number):
curl "https://web.archive.org/cdx/search/cdx?url=mojang.com/2016/06/minecraft-110-pre-release&from=20160601&to=20190901&filter=statuscode:200&sort=reverse&fl=timestamp,original"

# Release
curl "https://web.archive.org/cdx/search/cdx?url=mojang.com/2016/06/minecraft-110-*&from=20160601&to=20190901&filter=statuscode:200&fl=timestamp,original"

# Patch release (try specific first, then progressively earlier patches)
curl "https://web.archive.org/cdx/search/cdx?url=mojang.com/2016/06/minecraft-1103&from=20160601&to=20190901&filter=statuscode:200&sort=reverse&limit=1&fl=timestamp,original"
# If empty, try earlier patches: 1102, 1101, etc.
```

Sample archived article:
- https://web.archive.org/web/20190719040822/https://www.mojang.com/2016/05/minecraft-snapshot-16w20a/
