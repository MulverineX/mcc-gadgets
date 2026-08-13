# MCC-Gadgets Version & Changelog API — Refined Plan

## Context

Replace `launchercontent.mojang.com` with a faster, broader alternative. launchercontent is slow (30+ min to hours), missing 1.12 articles, and missing all pre-1.13 legacy changelogs. We layer four sources: `version_manifest_v2` (truth), `launchercontent` (image+shortText), `minecraft.net` sitemap (1.12+ articles), and Wayback Machine / `mojang.com` (1.11-).

This plan is driven by the public endpoint contract documented in `implementation_details.md`. All endpoint paths, cache TTLs, and call flows in this plan come from that file.

## Terminology

**Major release**: base version (1.13, 1.14). Distinguished from patch (1.13.1) and pre-release/snapshot.

**Slug**: trailing path of a minecraft.net article URL. Example: `minecraft-snapshot-18w22a`.

**Archived URL**: mojang.com article URL captured by Wayback Machine, retrievable via CDX.

## Endpoints (public contract)

All routes live under `/api/v1/java/changelog/`. Cache TTLs from `implementation_details.md`.

| Endpoint | Cache TTL | Purpose |
|---|---|---|
| `versions/version_manifest` | 5 min | All versions from `version_manifest_v2.json` |
| `versions/cached` | 3 hr | Version → article URL + image + shortText |
| `versions/json` | 1 min | Merged version list with full article bodies |
| `versions/rss` | 1 min | RSS feed wrapping `json` |
| `version/{x}/raw.html` | indefinite (1 min on 404) | Raw HTML pass-through from upstream (minecraft.net or Wayback) |
| `version/{x}` | indefinite (1 min on 404) | Parsed JSON result for a specific version |

## Call Flow

Description of the dependency graph between endpoints:

- `versions/cached` reads from three upstream sources: `version_manifest`, the parsed sitemap, and the launchercontent API.
- `versions/json` reads from `versions/cached` for any version that has an entry there. For versions listed in `version_manifest` but missing from `cached`, `json` calls `version/{x}` (the parsed JSON endpoint) to fetch the article body and merges the result.
- `versions/rss` wraps `versions/json` and applies no additional logic — it serializes the same data as RSS 2.0.
- `version/{x}/raw.html` is a pure pass-through: it fetches the upstream HTML from `minecraft.net` or the Wayback Machine and returns it as-is. No parsing, no transformation. Useful for debug and for clients that want unprocessed HTML.
- `version/{x}` is the parsed equivalent: it fetches the same upstream HTML, parses it, and returns a JSON object with the extracted title, hero image, and content. See "Article Parsing" below.

### Rules (from implementation_details.md)

1. `versions/json` only calls `/version/x` when `versions/cached` does not contain a version listed in `version_manifest`.
2. `versions/cached` source of truth for URLs: launchercontent API + sitemap + heuristics. launchercontent provides image URLs and shortText; sitemap + heuristics provide article URLs.
3. `versions/cached` invalidates the `version/x/raw.html` and `version/x` cache when minecraft.net sitemap shows a newer `lastmod` for the matching article and the route's `age` is older. Both routes share cache behavior.
4. `versions/rss` wraps `versions/json` (no separate logic).

## Data Sources

| Source | URL | Coverage |
|---|---|---|
| `version_manifest_v2.json` | `https://piston-meta.mojang.com/mc/game/version_manifest_v2.json` | All versions |
| `launchercontent` | `https://launchercontent.mojang.com/v2/javaPatchNotes.json` | 1.13+ releases |
| `minecraft.net` sitemap | `https://www.minecraft.net/sitemap.xml` | 1.12+ snapshots/pre-releases/patches |
| Wayback CDX | `https://web.archive.org/cdx/search/cdx` | 1.11 and below |

### Coverage Boundaries

Data sources cover different time segments of the version history:

- From 2011 up to September 2019, the only source for changelog articles is the Wayback Machine archive of `mojang.com`. This covers versions 1.11 and below. After September 2019, `mojang.com` redirected to `minecraft.net`, so captures from that point onward are not usable.
- From 2017 onward (1.12+), articles live on `minecraft.net` and appear in the sitemap. The sitemap covers snapshots, pre-releases, release candidates, and patch releases.
- From 2018 onward (1.13+), the launchercontent API also provides data: hero images and a pre-truncated shortText field. launchercontent does not cover 1.12 or earlier.
- The 1.11 boundary is a hardcoded exception: its URL is not discoverable via any of the above sources and must be looked up in the hardcoded exceptions table.

## Version → URL Resolution

### Source Selection (per version)

```
1. version_manifest → version id, type, release time
2. If sitemap has matching slug → minecraft.net URL
3. Else if launchercontent has entry → launchercontent URL (image + shortText)
4. Else if legacy mapping (1.11 and below) → CDX → Wayback URL
5. Else → url: null (still appear in sidebar per "404 exposure" rule)
```

### Hardcoded Exceptions

Only these versions have non-discoverable URLs:

| Version | Slug | Source |
|---|---|---|
| 1.11 | `seek-out-the-exploration-update-111-on-pc-mac-now` | mojang.com (hardcoded) |
| 1.12 | `world-color-released` | minecraft.net |
| 1.13 | `update-aquatic-out-java` | minecraft.net |
| 1.14 | `village---pillage-out-java-` | minecraft.net |
| 1.15 | `buzzy-bees-out-now-in-java` | minecraft.net |
| 1.16 | `nether-update-java` | minecraft.net |
| 1.17 | `caves---cliffs--part-i-out-today-java` | minecraft.net |
| 1.18 | `caves---cliffs--part-ii-out-today-java` | minecraft.net |
| 1.19 | `the-wild-update-out-today-java` | minecraft.net |
| 1.20 | `trails-tales-update-out-today-java` | minecraft.net |

All other legacy releases (1.9, 1.10) are discovered via the Wayback Machine archive of `mojang.com`, using the release URL pattern `mojang.com/{year}/{month}/minecraft-{major}{minor}-*` filtered against pre-release, snapshot, release-candidate, and numeric patch suffixes.

### Slug Construction (minecraft.net)

Old-format snapshots (week notation):
```
minecraft-snapshot-{XXwYY{suffix}}     e.g. minecraft-snapshot-18w22c
```
Cascade: try exact, then N-1, N-2 (letter suffix). Last resort: `snapshot-18w50a` (no `minecraft-` prefix).

New-format snapshots (26.1-snapshot-1+, from 2025-12-16):
```
minecraft-{YY}-{M}-snapshot-{n}        e.g. minecraft-26-1-snapshot-1
```
Cascade: try exact, then N-1 down to 1. Stop if previous snapshot was released >5 days ago (per manifest). If 200 but content does not match target version, skip — don't retry.

Pre-releases:
```
minecraft-{major}-{minor}-pre-release-{n}
                                       e.g. minecraft-1-19-3-pre-release-2
minecraft-{major}{minor}-pre-release-{n}    (no hyphen, older)
                                       e.g. minecraft-112-pre-release-3
```
Cascade: exact → N-1 → bare `pre-release` (shared page).

Release candidates: same pattern as pre-releases.

Patch releases:
```
minecraft-java-edition-{major}-{minor}-{patch}
                                       e.g. minecraft-java-edition-1-20-4
```
Cascade: exact → progressively earlier patches. Page may contain multiple versions — split by "Changes in X.Y.Z" headings.

### Patch Release Cascade (CDX)

For legacy patch versions (1.11 and below), article URLs are not in the sitemap. Resolution uses the Wayback Machine CDX API with a cascading fallback:

1. Try the specific patch slug first: `url=mojang.com/{year}/{month}/minecraft-{major}{minor}{patch}` with `sort=reverse&limit=1&filter=statuscode:200&fl=timestamp,original`. Example: `minecraft-1103` for 1.10.3.
2. If the CDX result is empty, decrement the patch number and try again: `minecraft-1102`, then `minecraft-1101`. After `minecraft-1101`, try the base release slug `minecraft-110` exactly once. Stop at this point regardless of result — do not try `minecraft-1100` or any other variants.
3. The earliest patch article that resolves may contain content for multiple sub-versions on a single page. For example, the `minecraft-1101` article (1.10.1) contains both "Issues fixed in version 1.10.1:" and "Issues fixed in version 1.10.2:" sections.
4. Once the article HTML is fetched, scan for headings matching `/(?:issues? fixed in version|changes? in|fixed bugs? in|technical changes? in)\s+(.+)/i`, normalize each captured version string to lowercase with whitespace collapsed, and deduplicate. If more than one unique version remains, the page is merged.
5. Extract only the section matching the target version. Sort sections numerically by version before assignment. The `url` field returned in the API response reflects the actual article URL where the content was found (e.g., 1.10.2's url points to the 1.10.1 article), not the version-specific URL.
6. If the merged page cannot be split programmatically (broken section markers, missing headings), expose the entire article content as a fallback. Users can submit edits to fix the content.

### April Fools Mappings

| Version | Slug |
|---|---|
| `24w14potato` | `poisonous-potato-update` |
| `25w14craftmine` | `the-craftmine-update` |
| `26w14a` | `the-herdcraft-update` |
| `22w13oneblockatatime` | `mojang-studios-release-new-astonishing-update` |
| `20w14infinite` | `every-update-imaginable-coming-minecraft` |
| `23w13a_or_b` | `vote-update` |

### Known Inaccessible Content

These versions have no fetchable article (return null, still appear in sidebar):

- `1.13.2-pre1`, `1.13.2-pre2` — 1.13.2 release article overwrote pre-release content.
- `19w03a`, `19w03b`, `19w03c` — `minecraft-snapshot-19w03a` taken down; no replacement.
- `19w11a`, `19w11b` — share `minecraft-snapshot-19w11` (no letter suffix).
- `19w14a`, `19w14b` — share `minecraft-snapshot-19w14a0`.

### Merged Article Detection

A page is merged when it contains >1 unique version. Detection: scan for headings matching `/^(changes?|fixed bugs?|technical changes?)\s*in\s*(.+)/i`, normalize (lowercase, collapse whitespace), dedupe. Split: extract only the section matching the target version. Sort sections numerically by version before assignment.

Fallback: if a merged page cannot be split programmatically, expose the entire article content. Users can submit edits.

## Article Fetching

### minecraft.net

- Article page: `https://www.minecraft.net/en-us/article/{slug}`
- Article JSON: `https://www.minecraft.net/en-us/article/{slug}.json` (field: `content`)
- Title: `meta[property="og:title"]`
- Hero image: `meta[property="og:image"]` (relative, prepend `https://www.minecraft.net`)

### mojang.com (Wayback, 1.11-)

CDX API:
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

URL patterns:

Snapshots (mojang):
```
https://www.mojang.com/{year}/{month}/minecraft-snapshot-{XXwYY{suffix}}
CDX: url=mojang.com/{year}/{month}/minecraft-snapshot-16w20a
Cascade: specific → wildcard (minecraft-snapshot-16w20*)
```

Pre-releases (mojang):
```
https://www.mojang.com/{year}/{month}/minecraft-{major}{minor}-pre-release-{n}
CDX: url=mojang.com/{year}/{month}/minecraft-110-pre-release-1
Cascade: specific → wildcard → bare (minecraft-110-pre-release)
```

Releases (mojang):
```
https://www.mojang.com/{year}/{month}/minecraft-{major}{minor}-*
CDX: url=mojang.com/{year}/{month}/minecraft-110-*
No sort/limit (CDX can't apply to release wildcards).
Filter: exclude pre-release, snapshot, release-candidate, numeric patches.
```

Patch releases (mojang):
```
https://www.mojang.com/{year}/{month}/minecraft-{major}{minor}{patch}
CDX: url=mojang.com/{year}/{month}/minecraft-1103
Cascade: 1103 → 1102 → 1101 → 110 (base release). Stop at base.
```

Wayback URL construction:
```
https://web.archive.org/web/{timestamp}/{original}
```

Archived page structure (mojang):
- Title: `h1.post-title`
- Meta: `p.post-meta`
- Content: `article.post-content`
- Hero image: `div.post-header__image img` (from `media.mojang.com/blog-image/`)

Bug entries: `li` with `[Bug <a href="...">MC-XXXX</a>] - description`.

### Month from ISO Week

```typescript
const getMonthFromWeek = (year: number, week: number): number => {
  const jan4 = new Date(year, 0, 4);
  const weekStart = new Date(jan4.getTime() + (week - 1) * 7 * 24 * 60 * 60 * 1000);
  return weekStart.getMonth() + 1;
};
```

### Validation

Always validate page title/heading against expected version. Shared pages are common (one URL serves multiple sub-versions). On mismatch: try cascade to lower sub-version number or earlier patch.

## Article Parsing

The runtime article parser is a port of `scripts/parse-articles.ts` into `src/server/java/changelog/shared/parser.ts`. The script is the authoritative reference: it works and has been validated against every observed edge case. The spec below documents every detail so the port is faithful.

### Source Detection

At runtime, the source is not inferred from the HTML — it is determined by which fetcher path produced the HTML. The `version/{x}` handler knows whether it fetched from `minecraft.net` (sitemap-resolved URL) or from the Wayback Machine (legacy URL). The parser receives the source as a parameter:

```typescript
parseArticle(html: string, source: "mojang" | "minecraft.net"): ParsedArticle
```

The string-sniffing `detectSource()` helper from `scripts/parse-articles.ts` is a leftover from the script's disk-reading mode and is not used in the runtime port.

### DOM Parser

Use `htmlparser2` (not cheerio). The script already depends on it, and htmlparser2's DOM structure is what the existing parser logic is written against. Parse once per article and cache the DOM — multiple operations (title, hero, content, split) reuse the same tree.

### Mojang Parsing

For Wayback-wrapped mojang.com articles:

- **Title**: `h1.post-title` — first `<h1>` whose `class` attribute is exactly `"post-title"`. Read text content.
- **Hero image**: `div.post-header__image > img` — first `<div>` with class exactly `"post-header__image"`, then find its child `<img>`, read `src` attribute.
- **Content**: `article.post-content` — first `<article>` whose `class` attribute contains `"post-content"`. Read inner HTML.

The hero image `src` is an absolute URL on `media.mojang.com/blog-image/...` — no URL rewriting needed.

### Minecraft.net Parsing

For minecraft.net articles:

- **Title**: `meta[property="og:title"]` — first `<meta>` with `property` attribute exactly `"og:title"`. Read `content` attribute.
- **Hero image**: `meta[property="og:image"]` — first `<meta>` with `property` attribute exactly `"og:image"`. Read `content` attribute. **This is a relative URL** — must be prefixed with `https://www.minecraft.net` before being returned.
- **Rich text container**: `div.MC_Link_Style_RichText` — first `<div>` with class exactly `"MC_Link_Style_RichText"`. This is the parent element whose children are the article body.
- **Article sections**: `div.article-section` — all `<div>` elements whose `class` attribute is exactly `"article-section"`. These are top-level content blocks.

For content extraction, each `article-section` is processed with the `flattenElement` rules below. There are two cases:

**Single article-section** (most articles): iterate children. Skip `<div>` with class exactly `"MC_articleGridA_sectionRef"`. For `<div>` with class exactly `"MC_articleGridA_mediaBlock"`, flatten its grandchildren (skip the mediaBlock wrapper). Otherwise, `flattenElement` the child.

**Multiple article-sections**: iterate sections. For the first section, strip all `MC_articleGridA_sectionRef` children. For subsequent sections, keep the top-level sectionRef (render its outerHTML) but strip nested ones via `flattenElement`.

### `flattenElement` Rules

```typescript
function flattenElement(el: Element): string {
  const cls = el.attribs?.class;
  // Recursively flatten content containers
  if (cls === "article-text" || cls === "MC_articleGridA_mediaBlock" || cls === "MC_Link_Style_RichText") {
    let out = "";
    for (const child of getChildren(el)) {
      out += flattenElement(child);
    }
    return out;
  }
  // Strip sectionRefs nested inside content containers
  if (cls === "MC_articleGridA_sectionRef") {
    return "";
  }
  // Strip empty <p> tags inside content containers
  if (el.tagName === "p" && textContent(el).trim() === "") {
    return "";
  }
  // Output this element
  return getOuterHTML(el);
}
```

Three behaviors: recursive unwrap for content containers, strip nested sectionRefs, strip empty paragraphs. Everything else passes through as outerHTML.

### Merged Detection (Mojang)

Scan all text-node children of the article post-content for `^issues? fixed in version (.+):` (case-insensitive). Extract the captured version string. If more than one unique version is found, the page is merged.

### Merged Detection (Minecraft.net)

Scan all children of the rich text container. Match `(changes? in|technical changes? in|fixed bugs? in)\s*(.+)` (case-insensitive). Extract the captured version. Normalize: lowercase, collapse whitespace to single spaces, trim. Dedupe by normalized version. If more than one unique version remains, the page is merged.

### Split (Mojang)

1. Find first child whose text matches `^issues? fixed in version /i`. All children before this index are the preamble.
2. Capture the "Update paragraph" if present: first non-text element that is a `<p>` with exactly one `<strong>` child whose text starts with `^update:/i`. Save it (added to the last section later).
3. Find all section headings: children matching `^issues? fixed in version (.+):/i`. Record index, version, and outerHTML.
4. For each section, content spans from its heading to just before the next section's heading (or end).
5. Sort sections numerically by version: parse `^(\d+)\.(\d+)(?:\.(\d+))?$` and compare `(major, minor, patch)` tuples.
6. Prepend preamble to the OLDEST section (first after sort).
7. Move the Update paragraph to the LAST section (prepend it).
8. Truncate at last bug list (see below).

### Split (Minecraft.net)

1. Find first child whose text matches `^(changes? in|technical changes? in|fixed bugs? in) /i`. All children before this index are the preamble.
2. Capture the "Edit paragraph" if present: first `<p>` whose children include a `<b>` with text exactly `"Edit:"`. Clone the element with `structuredClone` (handles circular refs), remove the `<b>Edit:</b>` child from the clone, strip leading/trailing whitespace and `&#xa0;` entities, strip leading `&#xa0;` after the opening tag. The Edit paragraph is appended to the newest section.
3. Build preamble HTML excluding the Edit paragraph.
4. Walk all children. For each match:
   - `changes? in` starts a new section. Save the current section (if any), then start a new one with the captured version.
   - `technical changes? in` and `fixed bugs? in` do NOT start a new section unless the captured version differs from the current section's version (normalized: lowercase + collapsed whitespace). If the version differs, save current and start new.
5. After the loop, push the final section.
6. Sort sections by version: parse `^(\d+)\.(\d+)(?:\.(\d+))?\s+(pre-release|release-candidate|snapshot|pre-release)?\s*(\d+)?$` and compare `(major, minor, patch, type, num)` tuples. Type is lowercased.
7. Prepend preamble (without Edit) to the OLDEST section (first after sort).
8. Append the Edit paragraph to the NEWEST section (last after sort).
9. Truncate each section at last bug list (see below).

### Truncation at Last Bug List

After splitting (and before returning), every section is truncated so content ends at the last `<ul>` containing mojira bug links. This is shared behavior between mojang and minecraft.net.

```typescript
function findLastBugListUlEnd(ulElements: Element[], content: string): number {
  let lastBugUlEnd = -1;
  for (const ul of ulElements) {
    const lis = getChildren(ul);
    let hasMojangLink = false;
    for (const li of lis) {
      const liChildren = getChildren(li);
      if (!liChildren) continue;
      for (const child of liChildren) {
        if (child.tagName === "a" && child.attribs?.href?.includes("bugs.mojang.com/browse/MC-")) {
          hasMojangLink = true;
          break;
        }
      }
      if (hasMojangLink) break;
    }
    if (hasMojangLink) {
      const ulHtml = getOuterHTML(ul);
      const ulIndex = content.indexOf(ulHtml);
      if (ulIndex !== -1) {
        const ulEnd = content.indexOf("</ul>", ulIndex) + 5;
        if (ulEnd > lastBugUlEnd) lastBugUlEnd = ulEnd;
      }
    }
  }
  return lastBugUlEnd;
}
```

For each section, parse its content, find all `<ul>` elements, find the last one with at least one mojira link, and truncate content to include that `<ul>`'s closing tag. Sections without bug lists keep their full content.

### Title and Hero for Split Articles

When an article is split into multiple versions, the title and hero from the original page are shared across all sections. The first version in the sorted list uses the original title; alternatively, the heading captured during split (e.g., "Changes in 1.20.4") is used per-section. The implementation must decide which. Current `parse-articles.ts` writes section content only — it does not produce per-section title/hero. The runtime port should produce per-section records with the section's heading as the title and the original page's hero as the image.

### Fallback for Unsplitable Merged Pages

When a merged page cannot be split programmatically (no heading match, broken HTML, etc.), the entire raw content is returned as a single section. The `url` field reflects the actual page URL where the content was found, not the version-specific URL. This is the documented fallback in "Merged Article Detection" above.

### shortText Generation

For sidebar hover population: after parsing the article body, generate a shortText by stripping HTML tags, normalizing whitespace, and truncating to approximately 280 characters. Strip leading/trailing punctuation. Preserve sentence boundaries where possible (cut at last `. `, `! `, or `? ` before the 280-char limit). The generated shortText is stored in runtime cache via `getCache()` (see Sidebar Hover Details).

### Wiring

`parseArticle` is called from exactly one place:

1. **`src/server/java/changelog/parsed.ts`** — the `version/{x}` route handler. Flow:
   1. Resolve the version to a source URL via `shared/resolver.ts` (sitemap → launchercontent → legacy).
   2. Determine `source` from the resolver result: URLs from `minecraft.net` → `"minecraft.net"`; URLs from Wayback Machine → `"mojang"`.
   3. Fetch the HTML (minecraft.net via `fetch`, Wayback via `fetch` on the constructed `https://web.archive.org/web/{timestamp}/{original}` URL).
   4. Call `parseArticle(html, source)` from `shared/parser.ts`.
   5. Extract the bug list from the parsed body using the same `<ul>`/`<li>`/`<a>` traversal as `parse-articles.ts`.
   6. Return the parsed JSON record (title, heroImage, body, bugList, source, merged, sections).
   7. Generate shortText from the parsed body and store it via `getCache().set(version, shortText, { ttl: 31536000, tags: ['shorttext'] })`. The `cached` handler reads this on subsequent requests.

`raw.html` (`src/server/java/changelog/raw.ts`) does NOT call `parseArticle`. It is a pure pass-through: fetch the upstream HTML, return as-is with `Content-Type: text/html`. The same resolver and the same upstream fetch are used by both routes — only the output differs (raw bytes vs parsed JSON).

`cached.ts` reads stored shortText via `getCache().get(version)` and merges it into the response. It never calls `parseArticle` directly.

The `json` handler does not call `parseArticle` — it reads from `cached` and forwards data. The `rss` handler does not touch articles.

### Snapshot Tests

The parser is validated against a corpus of real-world articles. The test pipeline:

1. **Fetch phase** — for each article in the test corpus, call the same code path the `version/{x}/raw.html` endpoint uses: resolve the version via `shared/resolver.ts`, determine the source URL (minecraft.net or Wayback), fetch the HTML. Write the response to a gitignored cache folder (e.g., `.temp/test-articles/<version>.html`). If the cache file already exists, skip the fetch — the goal is reproducibility, not freshness.
2. **Parse phase** — call `parseArticle(html, source)` from `shared/parser.ts` on each cached file. Serialize the `ParsedVersionResponse` (including `sections`, `bugList`, `merged`) to JSON.
3. **Snapshot phase** — write the JSON to a snapshot file in `tests/changelog_parser/__snapshots__/<version>.json`. On test re-run, compare the current output against the stored snapshot. Any diff is a regression.

The corpus covers all parser edge cases observed in production:

- New-format snapshots (`26-2-snapshot-3`, `minecraft-26-1`)
- Old-format snapshots (`snapshot-17w06a`, `snapshot-16w20a`)
- Pre-releases with minecraft.net merging (`1.12-pre-release-6`, `1.19.1-pre-release-3`)
- Mojang-merged patch releases (`1.10.1` and `1.10.2` on the same page)
- Single-version mojang articles (`1.10`, `1.11`)
- Articles with the Edit paragraph and Update paragraph features

The test runner is `bun test` (or whichever test runner is adopted; the project doesn't currently have one specified). The gitignored cache folder is added to `.gitignore` to avoid committing fetched HTML. The snapshot files are committed — they represent the expected output and change only when the parser intentionally changes.

When the parser is intentionally changed, run the test with `--update-snapshots` to regenerate the snapshot files. Review the diff before committing.

## Response Shape

### `versions/version_manifest`

```typescript
interface VersionManifestResponse {
  versions: Array<{
    id: string;
    type: "snapshot" | "release" | "special" | "release-candidate" | "pre-release";
    releaseTime: string; // ISO 8601
    url: string;
    sha1: string;
    complianceLevel: number;
  }>;
  latest: { release: string; snapshot: string };
}
```

Source: `version_manifest_v2.json` from piston-meta. Sanitize via existing `scripts/sanitize-version-manifest.ts`.

### `versions/cached`

```typescript
interface CachedEntry {
  version: string;
  type: string;
  url: string | null;          // minecraft.net OR mojang.com (we'll prefix with Wayback when serving)
  rawHtmlUrl: string;          // /api/v1/java/changelog/version/{x}/raw.html
  image: string | null;        // launchercontent URL (prepended) or null
  shortText: string | null;    // ~280 chars from launchercontent; null until visited
  source: "launchercontent" | "sitemap" | "wayback" | "none";
  lastmod: string | null;      // sitemap lastmod for invalidation
}
```

### `versions/json`

```typescript
interface JsonEntry extends CachedEntry {
  title: string | null;
  body: string | null;         // parsed article HTML
  publishedAt: string | null;  // from releaseTime, not page date
}
```

Strategy: serve from `cached`; for missing versions, forward to `version/{x}` (which the caller fetches and merges).

### `versions/rss`

Standard RSS 2.0 wrapper. Each entry: title, link, pubDate, description, enclosure (image).

### `version/{x}/raw.html`

Pure pass-through. The handler fetches the upstream HTML (minecraft.net or Wayback) and returns it as a `text/html` response with no parsing, no transformation, no language lookup. Useful for debug and for clients that want unprocessed HTML.

Response: the raw HTML bytes from upstream, with `Content-Type: text/html; charset=utf-8`. No JSON wrapper.

Returns 404 when no article exists. Cache: indefinite on 200, 1 minute on 404 (per implementation_details.md).

### `version/{x}`

The parsed JSON equivalent. The handler fetches the same upstream HTML, parses it, and returns a structured JSON object. No HTML is constructed — the parser extracts relevant pieces from the source DOM and returns them as-is.

```typescript
interface ParsedVersionResponse {
  version: string;
  title: string;
  heroImage: string | null;
  source: "minecraft.net" | "mojang";
  body: string;   // extracted HTML from the article content node(s)
  bugList: Array<`MC-${number}`>;  // mojira IDs parsed from the body
  sections?: Array<{
    version: string;
    rawTitle: string;
    body: string;
  }>;
  merged: boolean;
}
```

Field semantics:

- `title`: extracted via source-specific selector (minecraft.net: `og:title` meta; mojang: `h1.post-title`).
- `heroImage`: extracted via source-specific selector. minecraft.net returns a relative URL — prepended with `https://www.minecraft.net` before returning. mojang returns an absolute URL on `media.mojang.com`.
- `body`: extracted as the outerHTML of the relevant article content nodes. For single-version articles (non-merged), this is the article-section content. For merged articles, this is the outerHTML of the heading-matching section (see "Split"). The parser does NOT reconstruct HTML from individual text/image nodes — it extracts the source HTML from the relevant DOM nodes.
- `bugList`: MC-XXXX IDs extracted from `bugs.mojang.com/browse/MC-XXXX` links in the body. Deduplicated, preserving first-seen order. Used for sidebar links and bug tracking. Extraction logic is identical to `parse-articles.ts`: find all `<ul>` elements, check each `<li>` for an `<a>` whose `href` contains `bugs.mojang.com/browse/MC-`, collect the trailing MC-XXXX segment from each unique link.
- `sections`: present only when `merged` is true. Each section corresponds to one version's content within the merged article. The `body` of the merged article as a whole is also returned (the first section's content) for convenience.
- `merged`: true if the article contains content for more than one version.

Returns 404 when no article exists. Cache: indefinite on 200, 1 minute on 404 (mirrors `raw.html`).

## Caching Strategy

Vercel CDN cache headers. Per [Vercel docs](https://vercel.com/docs/cdn-cache):

| Endpoint | `s-maxage` | `stale-while-revalidate` |
|---|---|---|
| `version_manifest` | 300 (5 min) | 60 |
| `cached` | 10800 (3 hr) | 3600 |
| `json` | 60 (1 min) | 60 |
| `rss` | 60 (1 min) | 60 |
| `raw.html` (200) | 31536000 (1 yr) | 86400 |
| `raw.html` (404) | 60 (1 min) | 0 |
| `version/{x}` (200) | 31536000 (1 yr) | 86400 |
| `version/{x}` (404) | 60 (1 min) | 0 |

External invalidation hook (for `cached` to invalidate both per-version routes): when sitemap `lastmod` > cached `version/{x}` age, the `cached` handler calls `revalidatePath('/api/v1/java/changelog/version/{x}')` and `revalidatePath('/api/v1/java/changelog/version/{x}/raw.html')` from `next/cache`. The next request to either path serves stale content while revalidating in the background (stale-while-revalidate). Note: `revalidatePath` is a Next.js API, not from the Vercel CDN-cache or runtime-cache docs listed in `implementation_details.md`. It is kept because the sitemap-driven invalidation behavior is mandated by `implementation_details.md`, and the Vercel docs do not expose a path-based CDN purge API that satisfies it.

This hook operates only on sitemap-backed versions. Legacy versions (1.11 and below) sourced from the Wayback Machine are not present in the minecraft.net sitemap and therefore never appear in the `lastmod` comparison. Their cache entries are never invalidated by this hook. Wayback captures are immutable: the CDX query returns the same `timestamp` and `original` URL for the same `url-pattern` indefinitely, so there is no upstream signal that would justify invalidating them. The 1-year `s-maxage` on both routes is a safety net for sitemapped versions; for legacy versions it is effectively infinite.

## Sidebar Hover Details

The version selector sidebar shows a hover preview for each version. The preview uses two fields from the `cached` response: `image` and `shortText`. The human-readable release title (e.g., "Minecraft 1.20.4", "Minecraft Snapshot 18w22a") is always rendered.

### Rendering Rules

- When `image` is set: render the hero image. When `image` is null: render nothing, use the default background color for the element type.
- When `shortText` is set: render the description. When `shortText` is null: render nothing.
- The version title is always rendered, regardless of which fields are populated.

There is no placeholder image and no "loading" state. The hover renders whatever is present at that moment.

### Per-Source Initial State

| Source | `url` | `image` (before any visit) | `shortText` (before any visit) |
|---|---|---|---|
| launchercontent (1.13+) | set | set | set |
| sitemap-only (1.12, sitemapped snapshots not in launchercontent) | set | null | null |
| Wayback (1.11 and below) | set | null | null |
| none (no source found) | null | null | null |

For sitemap-only and Wayback versions, the sidebar hover shows only the title with no image and no description. Versions with no source at all (URL null) still appear in the sidebar per the "404 exposure" rule and show only the title.

### shortText Population After Visit

When a user visits a version's page (the `version/{x}` route is invoked), the server generates a `shortText` from the article's full content: HTML stripped, trimmed to ~280 characters. The generated shortText is stored and returned in subsequent `cached` responses for that version. If a `shortText` already existed from launchercontent, the generated one replaces it. This replaces the launchercontent shortText unconditionally — the generated one wins once a visit has occurred.

This applies to all article sources, including Wayback. A visit to a legacy version's page populates its shortText for all subsequent sidebar hovers across all users.

### Implementation

The `shortText` storage uses Vercel's runtime cache via `getCache()` from `@vercel/functions` (the API documented in `implementation_details.md`'s resources section). The store is keyed by version id and looked up on every `cached` response.

Key: the version id (e.g., `1.20.4`, `18w22a`, `1.11`).
Value: the generated shortText (~280 chars).
TTL: effectively infinite for our use case — a long TTL (e.g., 1 year) is set, and runtime cache persists across deployments. The cache is regional and LRU-evicted under storage pressure, but the total data size is small (~280 chars × ~1000 versions ≈ 280 KB), well under any realistic eviction threshold. If a shortText is ever evicted, the next visit regenerates it.
Tag: `shorttext` (single tag covering all entries). Bulk invalidation is not needed today, but the tag allows future use of `expireTag('shorttext')` if a regeneration sweep is required.

The `version/{x}` handler calls `cache.set(key, shortText, { ttl: 31536000, tags: ['shorttext'] })` after generating the shortText. The `cached` handler calls `cache.get(key)` for each version and merges the result into the response. Cache misses (no stored shortText) are silently skipped — the field remains null in the response.

## Files

The existing scripts under `scripts/` are diagnostic tools used during development to validate slug resolution and article parsing. They are kept for now but will be replaced by code in `src/server/java/changelog/` once the runtime handlers are built. Specifically:

- `scripts/legacy-version-mapping.ts` → data table imported by `src/server/java/changelog/shared/resolver.ts` and `shared/legacy.ts`. The constants stay in `scripts/` (or move to a `src/server/java/changelog/data/` folder) but the week-to-month derivation logic is implemented in `shared/legacy.ts`.
- `scripts/sanitize-version-manifest.ts` → absorbed into `src/server/java/changelog/manifest.ts` as an inline normalization step on the fetched piston-meta response.
- `scripts/parse-sitemap.ts` → absorbed into `src/server/java/changelog/shared/resolver.ts`. The slug pattern classifiers move there as exported functions.
- `scripts/map-versions-to-slugs.ts` → absorbed into `src/server/java/changelog/shared/resolver.ts`. The cascade logic, hardcoded multi-slug mapping, and slug-to-version reverse lookup all live here.
- `scripts/verify-slugs.ts` → replaced by unit tests in `tests/changelog_resolver.test.ts`. The known-good and known-bad version sets become fixtures.
- `scripts/parse-articles.ts` → absorbed into `src/server/java/changelog/shared/parser.ts`. The minecraft.net + mojang parsers and merged-section splitting logic move there as exported functions.
- `scripts/fetch-legacy-articles.ts` → replaced by the runtime `cached` handler invoking `shared/legacy.ts` on cache miss. No separate batch script needed.

### New server modules

```
src/server/java/changelog/
├── manifest.ts          # version_manifest handler + raw piston-meta fetch + inline sanitization
├── cached.ts            # cached handler (launchercontent + sitemap + legacy)
├── raw.ts               # raw.html handler (pure pass-through, no parsing)
├── parsed.ts            # version/{x} handler (calls parseArticle, returns JSON)
├── json.ts              # json handler (cached + parsed fallback)
├── rss.ts               # rss handler (wraps json)
├── shared/
│   ├── resolver.ts      # version → URL (sitemap + cascade + hardcoded + April Fools)
│   ├── legacy.ts        # CDX + Wayback for 1.11-
│   ├── launcher.ts      # launchercontent normalization
│   ├── parser.ts        # article HTML parsing (minecraft.net + mojang)
│   ├── cache.ts         # cache headers, invalidation tags
│   └── (no tests here — see tests/ at root)
└── types.ts             # shared types
```

### New API routes

```
src/app/api/v1/java/changelog/
├── versions/
│   ├── version_manifest/route.ts
│   ├── cached/route.ts
│   ├── json/route.ts
│   ├── rss/route.ts
└── version/
    └── [x]/
        ├── raw.html/route.ts
        └── route.ts
```

## Cache Data Flow

At request time, each endpoint consumes these files plus live network fetches:

- `versions/version_manifest`: reads `version-manifest-sanitized.json` directly. Result is cached for 5 minutes at the CDN.
- `versions/cached`: merges three sources — the parsed sitemap entries, the launchercontent API response, and the legacy articles JSON — into a per-version record. Result is cached for 3 hours at the CDN.
- `versions/json`: reads `versions/cached` and fills in missing article bodies by calling `version/{x}` only for versions that appear in `version_manifest` but not in `cached`. Result is cached for 1 minute at the CDN.
- `versions/rss`: serializes `versions/json` as RSS 2.0. Result is cached for 1 minute at the CDN.
- `version/{x}/raw.html`: fetches the article HTML from `minecraft.net` (sitemapped versions) or from the Wayback Machine (legacy versions) and returns it as-is. No parsing. Result is cached indefinitely on 200 responses, and for 1 minute on 404 responses.
- `version/{x}`: fetches the same upstream HTML as `raw.html`, parses it, and returns a JSON object. Generates shortText and stores it in runtime cache. Result is cached indefinitely on 200 responses, and for 1 minute on 404 responses.

## Implementation Order

1. **`src/server/java/changelog/manifest.ts`** + route — read manifest, serve. Piston-meta fetch + 5 min cache.
2. **`src/server/java/changelog/shared/resolver.ts`** — extract version→slug from `version-to-slug-mapping.json`, cascade logic. Pure function, no network.
3. **`src/server/java/changelog/shared/legacy.ts`** — CDX query + Wayback URL construction. Unit-testable.
4. **`src/server/java/changelog/shared/launcher.ts`** — fetch+normalize launchercontent. Image URL prepend, shortText extraction.
5. **`src/server/java/changelog/shared/parser.ts`** — port of `parse-articles.ts` into a synchronous function. Takes `(html, source)` and returns a `ParsedVersionResponse`. Handles title, hero, body extraction, merged section splitting, bug list extraction. No HTML construction — extracts outerHTML of relevant DOM nodes only.
6. **`src/server/java/changelog/cached.ts`** + route — merge above, 3 hr cache.
7. **`src/server/java/changelog/raw.ts`** + route — pure pass-through: fetch upstream HTML (minecraft.net or Wayback), return as-is. No parsing. Indefinite cache, 1 min on 404.
8. **`src/server/java/changelog/parsed.ts`** + route — fetch upstream HTML, call `parseArticle` from `shared/parser.ts`, return JSON. Generate shortText and store in runtime cache. Indefinite cache, 1 min on 404.
9. **`src/server/java/changelog/json.ts`** + route — cached + parsed fallback.
10. **`src/server/java/changelog/rss.ts`** + route — wrap json.
11. **Invalidation hook** — when sitemap `lastmod` updates, force revalidate matching `version/{x}` and `version/{x}/raw.html` paths.
