import * as htmlparser2 from "htmlparser2";
import {
  Comment as DomComment,
  Element as DomElement,
  Text as DomText,
  isComment,
  isTag,
  isText,
  type ChildNode,
} from "domhandler";
import { ElementType } from "domelementtype";

// `htmlparser2` types its element union loosely; this alias mirrors what the
// existing diagnostic script uses so the parser logic ports 1:1.
type Element = NonNullable<
  Parameters<NonNullable<ConstructorParameters<typeof htmlparser2.DomHandler>[2]>>[0]
>;

const MINECRAFT_NET_BASE = "https://www.minecraft.net";

export interface ParsedArticleSection {
  version: string;
  rawTitle: string;
}

export interface BugRef {
  id: `MC-${number}`;
  title: string;
}

export interface ParsedArticle {
  version: string;
  heroImage: string | null;
  source: "minecraft.net" | "mojang";
  body: SerializedAST;
  bugList: BugRef[];
  merged: boolean;
  shortText: string;
}

/**
 * Cyclic-graph JSON encoding of a DOM fragment. The `nodes` array is in
 * preorder DFS, so `nodes[i].children` are always indexes `> i` and
 * `nodes[i].parent.$ref` always points to an index `< i` (or `null` for roots).
 * Lossless — `deserializeAst(serializeAst(children))` round-trips.
 */
export type ASTRef = { $ref: number };

export interface ASTElement {
  type: "element";
  tag: string;
  kind: "tag" | "script" | "style";
  attrs: Record<string, string>;
  children: number[];
  parent: ASTRef | null;
  prev: ASTRef | null;
  next: ASTRef | null;
}

export interface ASTText {
  type: "text";
  data: string;
  parent: ASTRef | null;
  prev: ASTRef | null;
  next: ASTRef | null;
}

export interface ASTComment {
  type: "comment";
  data: string;
  parent: ASTRef | null;
  prev: ASTRef | null;
  next: ASTRef | null;
}

export type ASTNode = ASTElement | ASTText | ASTComment;

export interface SerializedAST {
  nodes: ASTNode[];
}

const SHORT_TEXT_LIMIT = 280;
const MOJIRA_LINK_PATTERN = /bugs\.mojang\.com\/browse\/(MC-\d+)/;
const SECTION_HEADING_PATTERN =
  /^(changes? in|technical changes? in|fixed bugs?|issues? fixed in)\b/i;

/**
 * Parse an article HTML body and return a `ParsedArticle`. The entire pipeline
 * operates on a single parsed DOM: section picking, heading removal, edge
 * trim, bug extraction, and bug-list truncation all happen via DOM mutation.
 * The only serialization happens once, at the end, when producing the final
 * body string.
 */
export function parseArticle(
  html: string,
  source: "mojang" | "minecraft.net",
  version: string,
): ParsedArticle {
  const root = htmlparser2.parseDocument(html) as unknown as Element;

  // Pick the article container + hero image up front; they live outside the
  // editable region so they're separate from the body DOM. mojang wraps the
  // article in `<article class="...post-content">`, but some pages also
  // have a `<div class="post-content">` for the header — prefer `<article>`.
  const container =
    source === "mojang"
      ? findFirst(
          (el) =>
            el.tagName === "article" &&
            (el.attribs?.class ?? "").includes("post-content"),
          root,
        ) ??
        findFirst(
          (el) =>
            el.tagName === "div" &&
            (el.attribs?.class ?? "").includes("post-content") &&
            // Skip the header div (only one `<p class="post-meta">` child).
            (el.children ?? []).filter(
              (c) => (c as { tagName?: string }).tagName === "p",
            ).length > 1,
          root,
        )
      : findArticleBodyContainer(root);
  const heroImage =
    source === "mojang"
      ? (() => {
          const div = findFirst(
            (el) => el.attribs?.class === "post-header__image",
            root,
          );
          const img = div?.children?.find(
            (c) => (c as Element).tagName === "img",
          ) as Element | undefined;
          // Older mojang.com snapshots (14w05a era) embed the hero image as
          // the first paragraph of the article body — typically wrapped in an
          // `<a>` linking back to the same `media.mojang.com` URL. The empty
          // `<div class="post-header__image">` shell is present but unused.
          if (img?.attribs?.src) return img.attribs.src;
          return findFirstHeroInBody(container ?? root);
        })()
      : (() => {
          const og = findFirst(
            (el) => el.tagName === "meta" && el.attribs?.property === "og:image",
            root,
          );
          return og?.attribs?.content ?? null;
        })();

  if (!container) {
    return {
      version,
      heroImage,
      source,
      body: { nodes: [] },
      bugList: [],
      merged: false,
      shortText: "",
    };
  }

  // Identify section ranges. minecraft.net split also gets the target version
  // so it can return the right single section for snapshots. The mojang
  // branch splits by snapshot version: older mojang.com pages (e.g. 14w05a,
  // 14w33c) re-edit previous snapshot articles when shipping a hotfix, so
  // a single page can describe multiple snapshots. We extract every
  // snapshot version mentioned and pick the range matching `version`.
  const rawRanges = source === "mojang"
    ? splitMojangByVersion(container, version)
    : splitMinecraftNetByVersion(container, version);

  // Single-version articles (no section markers found) fall back to a
  // synthetic section covering the whole article. The newer mojang.com
  // layout (16w20a, 1.10, etc.) doesn't use "Issues fixed in version X:"
  // dividers and lands here — it still has the same footer boilerplate
  // (launcher instructions, server jar, bug-tracker link, signoff) that
  // needs stripping before we package the body.
  const ranges = rawRanges.length === 0
    ? [
        {
          version,
          rawTitle: "",
          children:
            source === "mojang"
              ? findMojangLegacyFooterEnd(container)
              : containerChildren(container),
        } satisfies SectionRange,
      ]
    : rawRanges;

  // Pick the range matching `version` (or fall back to the first range).
  const matched = pickRange(ranges, version);
  if (process.env.DEBUG_PICK) {
    console.log(`[DEBUG ${version}] ranges=${ranges.map(r => r.version).join(",")} matched=${matched?.version} children=${matched?.children.length}`);
  }

  // Mutate the section's children in place: strip heading, edge empties,
  // and bug-list items. The final serialize emits the surviving children
  // directly. Text nodes are skipped — they're whitespace between elements
  // and not part of the article body.
  const bugList: BugRef[] = matched
    ? buildBodyElement(matched)
    : [];
  const survivors = matched
    ? matched.children.filter((c) => {
        if (c.parent === null) return false;
        // Drop empty `<ul>`s left over from splitting pure-bug lists.
        if (
          c.tagName === "ul" &&
          ((c.children ?? []).filter(
            (cc) => (cc as { tagName?: string }).tagName === "li",
          ).length) === 0
        ) {
          return false;
        }
        return true;
      })
    : [];
  normalizeArticleMedia(survivors);
  const body = serializeAst(trimRootEdges(survivors));
  const shortText = makeShortTextFromChildren(survivors);

  return {
    version,
    heroImage,
    source,
    body,
    bugList,
    merged: ranges.length > 1,
    shortText,
  };
}

/**
 * Extract the MC-XXXX id from a bug `<li>`. Walks every descendant `<a>`
 * (not just direct children) — the 14w05a article wraps some bug entries
 * in a `<table><tr><td>…</td><td>…</td></tr></table>` layout, where the
 * mojira link lives inside the nested `<td>`. Returns the first match.
 */
function extractBugId(li: Element): `MC-${number}` | null {
  return findMojiraId(li);
}

/** First descendant `<a>` whose `href` matches the mojira pattern. */
function findMojiraId(root: Element): `MC-${number}` | null {
  for (const a of collectAllByTag(root, "a")) {
    const m = MOJIRA_LINK_PATTERN.exec(a.attribs?.href ?? "");
    if (m?.[1]) return m[1] as `MC-${number}`;
  }
  return null;
}

/** Recursively collect every element with `tagName === name` reachable from `root`. */
function collectAllByTag(root: Element, name: string): Element[] {
  const out: Element[] = [];
  const stack: Element[] = [root];
  while (stack.length) {
    const el = stack.pop()!;
    if (el.tagName === name) out.push(el);
    for (const c of (el.children ?? []) as Element[]) stack.push(c);
  }
  return out;
}

/**
 * Find the smallest ancestor of `root` that contains BOTH a
 * `MC_Link_Style_RichText` element and an `article-media` element, then
 * collect every `MC_Link_Style_RichText` and `article-media` descendant
 * of that ancestor in document order and flatten each one's children
 * into a synthetic container. minecraft.net changelog articles split
 * the body into multiple RichText divs AND a separate `article-media`
 * block for embedded figures — and interleave them with anything else
 * that lives between them in the source. Concatenating only the two
 * known kinds (and missing what's between) drops content; flattening the
 * union of both kinds in source order keeps it all.
 */
function findArticleBodyContainer(root: Element): Element | null {
  // Find every `<div class="article-grid-a ...">` wrapper on the page
  // (including the sidebar ones), in document order. The article body
  // sits inside a contiguous run of these — specifically, the slice
  // from the FIRST grid that contains an `article-text` child to the
  // LAST grid that contains one. Sidebar grids live outside this slice.
  // `article-media` divs that appear interleaved between article-text
  // grids are picked up automatically as siblings of those grids.
  const articleGridHits = htmlparser2.DomUtils.findAll(
    (el) => {
      const cls = (el as Element).attribs?.class ?? "";
      return cls.split(" ").includes("article-grid-a");
    },
    root as unknown as Parameters<typeof htmlparser2.DomUtils.findAll>[1],
  ) as unknown as Element[];
  if (articleGridHits.length === 0) return null;

  // Bounding slice indices: first and last grid whose DESCENDANTS
  // include an `article-text`. Anything between them is article body.
  // The article-text div sits nested inside `<section>` →
  // `<div.MC_articleGridA>` → `<div.MC_articleGridA_container>` →
  // `article-text`, so a direct-children check would miss it. Walk
  // descendants to find it.
  function gridHasArticleText(g: Element): boolean {
    const stack: Element[] = [...((g.children ?? []) as Element[])];
    while (stack.length) {
      const el = stack.pop()!;
      const cls = (el.attribs?.class ?? "").split(" ");
      if (cls.includes("article-text")) return true;
      for (const c of (el.children ?? []) as Element[]) stack.push(c);
    }
    return false;
  }
  const firstContentIdx = articleGridHits.findIndex(gridHasArticleText);
  if (firstContentIdx === -1) return null;
  let lastContentIdx = firstContentIdx;
  for (let i = firstContentIdx + 1; i < articleGridHits.length; i++) {
    if (gridHasArticleText(articleGridHits[i]!)) lastContentIdx = i;
  }
  const contentGrids = articleGridHits.slice(
    firstContentIdx,
    lastContentIdx + 1,
  );

  // Class names that mark purely structural wrapper divs Mojang uses to
  // build up the article layout — they carry no article content of
  // their own, only nest other elements. Skip them in the output but
  // descend into their children so the real article content
  // (article-text, article-media, RichText, pictures, etc.) still
  // surfaces in document order.
  const STRUCTURAL_CLASS_PREFIXES = [
    "MC_Bg_Inherit",
    "MC_Theme_Vanilla",
    "MC_articleHeroA",
    "MC_articleGridA",
    "article-section",
    "article-grid-a",
  ];
  const isStructuralWrapper = (el: Element): boolean => {
    const cls = (el as Element).attribs?.class ?? "";
    if (!cls) return false;
    const classes = cls.split(" ");
    return STRUCTURAL_CLASS_PREFIXES.some((p) =>
      classes.some((c) => c === p || c.startsWith(p + "-") || c.startsWith(p + "_")),
    );
  };

  // Class names that mark divs whose only purpose is to wrap content —
// unwrap them entirely so the children surface at the level their
// parent occupies. `MC_Link_Style_RichText` and `article-text` are
// explicitly listed here so the prose and headings sit at the body's
// top level instead of nested two layers deep. `article-media` is
// deliberately NOT listed — images and their wrappers are kept intact.
const UNWRAP_CLASSES = new Set<string>([
  "MC_Link_Style_RichText",
  "article-text",
]);

  const isUnwrap = (el: Element): boolean => {
    const cls = (el as Element).attribs?.class ?? "";
    if (!cls) return false;
    return cls.split(" ").some((c) => UNWRAP_CLASSES.has(c));
  };

  // Walk through every content grid, descending through structural
  // wrappers, and collect the non-structural descendants in document
  // order. Keeps article-text/article-media/RichText/images, drops
  // the wrapper shells. Unwrap classes get replaced by their children
  // so the body isn't nested two layers deep.
  const collected: Element[] = [];
  function collect(el: Element): void {
    if (isStructuralWrapper(el) || isUnwrap(el)) {
      for (const c of (el.children ?? []) as Element[]) collect(c);
      return;
    }
    collected.push(el);
  }
  for (const g of contentGrids) {
    for (const c of (g.children ?? []) as Element[]) collect(c);
  }
  if (collected.length === 0) return null;

  // Use the deepest structural-wrapper descendant of the first content
  // grid as the shell — it's guaranteed not to appear in `collected`
  // (we descended through structural wrappers without including them)
  // so mutating its .children won't create a cycle.
  const firstGrid = contentGrids[0]!;
  function firstStructuralDescendant(g: Element): Element | null {
    for (const c of (g.children ?? []) as Element[]) {
      if (isStructuralWrapper(c)) return c;
    }
    return null;
  }
  const shell = firstStructuralDescendant(firstGrid) ?? firstGrid;
  (shell as { children?: Element[] }).children = collected;
  return shell;
}

/**
 * Extract the human-readable title from a bug `<li>`. The `<li>` looks like:
 *   `[Bug <a>MC-XXX</a>] - Title here`
 * The title is the text after the `<a>`, with the leading `] - ` (or ` - `)
 * stripped and the rest trimmed.
 */
function extractBugTitle(li: Element): string {
  // textContent auto-decodes all HTML entities (&nbsp;, &#xa0;, &#x2019;, …)
  // so the manual replacements from earlier parser versions aren't needed.
  const raw = trimmedTextOf(li);
  // Strip the leading "Fixed bug MC-XXX -" (minecraft.net), "[Bug MC-XXX]"
  // (mojang with marker), or bare "MC-XXX" (mojang without marker) so only
  // the descriptive title remains. The separator after the id can be `-`,
  // `–`, `—`, `:`, NBSP (\xa0), or a regular space.
  const m = /^(?:\[\s*)?(?:[Ff]ixed\s+)?(?:[Bb]ug\s+)?MC-\d+\s*\]?\s*[-–—:\s ]*/.exec(
    raw,
  );
  const stripped = m ? raw.slice(m[0].length) : raw;
  return stripped.replace(/^[-–—:]\s*/, "").trim();
}

// ---------------------------------------------------------------------------
// Section identification — runs on the live DOM, mutates nothing.
// ---------------------------------------------------------------------------

/**
 * Describes a section by the actual child array it spans. Holding a
 * reference to the array slice (not just indices) avoids index-shift bugs
 * when earlier sections have detached elements.
 */
interface SectionRange {
  version: string;
  rawTitle: string;
  children: Element[];
}

/**
 * Find the index just past the last `<ul>`/`<ol>` in `children[fromIdx..endIdx)`.
 * Bounded to the range — won't search past the next section divider.
 */
function lastListEnd(
  children: Element[],
  fromIdx: number,
  endIdx: number,
): number {
  for (let i = endIdx - 1; i >= fromIdx; i--) {
    const tag = children[i]!.tagName;
    if (tag === "ul" || tag === "ol") return i + 1;
  }
  return endIdx;
}

function pickRange(ranges: SectionRange[], version: string): SectionRange | null {
  if (ranges.length === 0) return null;
  const normalized = normalizeVersion(version);
  // Prefer an explicit intro range (non-empty version). The legacy mojang
  // dispatcher emits a sentinel main range with version `""` for content
  // not attributed to any intros — matching against it would let the
  // sentinel shadow the more specific intro range.
  const hit = ranges.find(
    (r) => r.version !== "" && normalizeVersion(r.version) === normalized,
  );
  if (hit) return hit;
  // Fall back to the main range, then to the first range overall.
  return (
    ranges.find((r) => r.version === "") ?? ranges[0]!
  );
}

/**
 * Split a minecraft.net article into version sections. minecraft.net articles
 * come in two flavors:
 *   - Pre-release articles: per-version "Changes in X / Fixed bugs in X"
 *     headings delimit sections.
 *   - Snapshot articles: a single big "Changes" + "Technical Changes" +
 *     "Fixed bugs in X" section terminated by a footer like "Get the
 *     Snapshot" / "Get the pre-release" / "Get the Release".
 *
 * We return the section that contains the target version's content (or the
 * full article for single-section snapshots), and strip the footer in all
 * cases.
 */
function splitMinecraftNetByVersion(
  container: Element,
  version: string,
): SectionRange[] {
  const children = containerChildren(container);
  // Captured by the closure below; populated when the follow-up-note
  // pattern fires so the X-range slice can drop the meta-note block.
  let followUpSkip: Set<number> = new Set();

  function sliceRange(start: number, end: number): Element[] {
    const out: Element[] = [];
    // Follow-up skip only applies to the X (anchored) section — the Y
    // range (Fixed bugs in Y + its bug ul) needs those indices intact to
    // feed bugList.
    const skip = start === 0 ? followUpSkip : new Set<number>();
    for (let i = start; i < end; i++) {
      if (skip.has(i)) continue;
      out.push(sectionChildren[i]!);
    }
    return out;
  }

  // Find the footer terminator. minecraft.net articles end with a `<h2>`
  // "Get the X" block (snapshot/pre-release/release/update), or with a
  // recognizable footer paragraph: "Please report …", "To get snapshots …",
  // "Cross-platform server jar …", "Report bugs …", "Want to give feedback …".
  // Everything from the first match onward is discarded.
  let footerIdx = children.length;
  for (let i = 0; i < children.length; i++) {
    const text = trimmedTextOf(children[i]!);
    if (
      /^(get the (snapshot|pre-release|release|update))/i.test(text) ||
      /^(please report|to (get|install)|cross-platform server|report bugs|want to give feedback)/i.test(
        text,
      )
    ) {
      footerIdx = i;
      break;
    }
  }

  const sectionChildren = children.slice(0, footerIdx);

  // Detect the "follow-up note" pattern: the article's first section
  // divider is a "Fixed bugs in Y" header (a hotfix prepended to the
  // original snapshot's article), with the main "Changes in X" section
  // appearing later. When this fires, the intro paragraphs above the
  // "Fixed bugs" header describe the original snapshot X — they sit above
  // the follow-up and need to belong to X's section, not be dropped.
  let firstChangesInIdx = -1;
  let firstFixedBugsIdx = -1;
  for (let i = 0; i < sectionChildren.length; i++) {
    const text = trimmedTextOf(sectionChildren[i]!);
    if (firstChangesInIdx === -1 && /^changes? in\s+\S/i.test(text)) {
      firstChangesInIdx = i;
    }
    if (firstFixedBugsIdx === -1 && /^fixed bugs? in\s+\S/i.test(text)) {
      firstFixedBugsIdx = i;
    }
  }
  const followUpNotePattern =
    firstFixedBugsIdx !== -1 &&
    (firstChangesInIdx === -1 || firstFixedBugsIdx < firstChangesInIdx);

  // For the follow-up pattern, build an "index set to drop" that covers
  // the meta-note block preceding the original snapshot's "Changes in X"
  // section: the `<p><strong>Update:</strong> …</p>` paragraph (when
  // present), the "Fixed bugs in Y" header, and its trailing bug `<ul>`.
  // The main X range absorbs intro paragraphs (idx 0..firstFixedBugsIdx)
  // but skips this meta block, which belongs to Y's follow-up data.
  const followUpSkipIndices = new Set<number>();
  if (followUpNotePattern) {
    // Find the "Update:" lead paragraph, if present.
    for (let i = 0; i < firstFixedBugsIdx; i++) {
      const text = trimmedTextOf(sectionChildren[i]!);
      if (/^update:/i.test(text)) followUpSkipIndices.add(i);
    }
    // The "Fixed bugs in Y" header itself.
    followUpSkipIndices.add(firstFixedBugsIdx);
    // The whitespace text + bug `<ul>` immediately after the header.
    for (
      let i = firstFixedBugsIdx + 1;
      i < sectionChildren.length &&
      i < (firstChangesInIdx === -1 ? sectionChildren.length : firstChangesInIdx);
      i++
    ) {
      followUpSkipIndices.add(i);
      const sib = sectionChildren[i]!;
      if (sib.tagName === "ul") break;
    }
    followUpSkip = followUpSkipIndices;
  }

  // Per-version sections: "Changes in X / Fixed bugs in X" headings with
  // version strings. Each section starts at such a heading and runs until
  // the next one.
  const ranges: SectionRange[] = [];
  let current: { version: string; rawTitle: string; sectionStart: number } | null = null;

  for (let i = 0; i < sectionChildren.length; i++) {
    const child = sectionChildren[i]!;
    const text = trimmedTextOf(child);
    if (process.env.DEBUG_PICK) {
      console.log(`  [${i}] ${child.tagName}: ${text}`);
    }
    // Recognized section dividers:
    //   "Changes in X" / "Technical Changes in X" — pre-release articles
    //   "Fixed bugs in X" — both styles
    //   "Changes" / "Technical Changes" — snapshot articles (single section)
    //   "Fixed bugs in 26.1 Snapshot 1" — snapshot articles (with version)
    const headingMatch =
      /^(changes? in|technical changes? in|fixed bugs? in)\s*(.*)$/i.exec(text);
    const plainMatch = headingMatch
      ? null
      : /^(changes?|technical changes?)$/i.exec(text);

    if (!headingMatch && !plainMatch) continue;

    if (process.env.DEBUG_PICK && /21w08/.test(version)) {
      console.log(`  [heading] idx=${i} text=${JSON.stringify(text)} match=${headingMatch ? JSON.stringify(headingMatch[1]) : "plain"} ver=${headingMatch ? JSON.stringify(headingMatch[2]) : ""}`);
    }
    let versionStr: string;
    if (headingMatch) {
      versionStr = headingMatch[2]!.trim();
      // "Changes in X" without a version ("Changes in") — treat as plain.
      if (versionStr === "" || /^technical/i.test(headingMatch[1]!)) {
        current ??= startSection(version, child, i);
        continue;
      }
      // Normalize the heading form ("1.20.4 Pre-Release 2") to the id
      // form ("1.20.4-pre2") so `parseMinecraftNetVersion` compares them
      // identically. Drops the pre-release number from the sort tuple —
      // acceptable: pre-release cascade ordering is rare within a single
      // merged page, and section matching still uses string equality.
      versionStr = versionStr
        .replace(/\s+(pre-?release|release-?candidate|snapshot)\s*/i, (_, t: string) => {
          const norm = t.toLowerCase().replace(/\s+/g, "");
          return `-${norm === "prerelease" ? "pre" : norm === "releasecandidate" ? "rc" : norm}`;
        })
        .replace(/(\d+)$/, ""); // strip trailing pre-release number
    } else {
      // Plain "Changes" / "Technical Changes" — belongs to the current
      // target version.
      versionStr = version;
    }

    if (/^changes? in\b/i.test(headingMatch?.[1] ?? "")) {
      if (current) {
        ranges.push({
          ...current,
          children: sliceRange(current.sectionStart, i),
        });
      }
      // For the follow-up-note pattern, anchor the first "Changes in X"
      // section at idx 0 so the intro paragraphs (which actually describe
      // X) get captured along with the section's prose. The earlier
      // "Fixed bugs in Y" heading has already been pushed as a follow-up
      // range, so re-anchoring here is safe.
      const sectionStart = followUpNotePattern ? 0 : i;
      current = startSection(versionStr, child, sectionStart);
    } else {
      // "Fixed bugs in X" or plain "Technical Changes" — always part of
      // the current section. The target version may not string-match the
      // heading's "X" (e.g. "26.1-snapshot-1" vs "26.1 Snapshot 1"), but
      // they're the same release. Just absorb the heading without opening
      // a new section.
      current ??= startSection(versionStr, child, i);
    }
  }

  if (current) {
    ranges.push({
      ...current,
      children: sliceRange(
        current.sectionStart,
        lastListEnd(sectionChildren, current.sectionStart, sectionChildren.length),
      ),
    });
  }
  if (process.env.DEBUG_PICK && /21w08/.test(version)) {
    console.log(`  [minecraft-net] current=${current?.version} ranges=${JSON.stringify(ranges.map(r => ({v: r.version, c: r.children.length})))}`);
  }

  // Snapshot articles have no per-version headings — return the entire
  // (footer-trimmed) article as a single section.
  if (ranges.length === 0) {
    return [
      {
        version,
        rawTitle: "",
        children: sectionChildren,
      },
    ];
  }

  ranges.sort((a, b) =>
    compareVersionTuple(parseMinecraftNetVersion(b.version), parseMinecraftNetVersion(a.version)),
  );
  return ranges;
}

/**
 * Dispatch between the newer mojang.com layout (~16w20a+) and the legacy
 * layout (~14w05a / 14w33c era). The newer layout was built on WordPress
 * and inserts a `<!--more-->` comment in the article body to delimit the
 * excerpt. The legacy layout predates that template and has no such
 * marker — instead it re-edits the previous snapshot's article when
 * shipping a hotfix, so a single page can describe multiple snapshots
 * with no formal dividers, just `<p>` intros that mention specific
 * snapshot versions.
 */
function splitMojangByVersion(container: Element, targetVersion: string): SectionRange[] {
  if (hasWordPressMoreMarker(container)) {
    return splitMojangByVersionNewer(container);
  }
  return splitMojangByVersionLegacy(container, targetVersion);
}

/**
 * True if the article contains a `<!--more-->` WordPress excerpt marker.
 * Stable across every newer mojang.com page (16w20a, 1.10, 1.10.1, 1.10.2,
 * 1.11) and absent from every legacy page (14w05a, 14w33c).
 */
function hasWordPressMoreMarker(container: Element): boolean {
  for (const child of containerChildren(container)) {
    if (isComment(child) && /^\s*more\s*$/i.test((child as any).data)) return true;
  }
  return false;
}

/**
 * Newer mojang.com layout (~16w20a+). Sections delimited by "Issues fixed
 * in version X:" markers; preamble + update paragraphs attach by version
 * age (oldest / newest). Behavior preserved from the original
 * `splitMojangByVersion`.
 */
function splitMojangByVersionNewer(container: Element): SectionRange[] {
  const children = containerChildren(container);
  const ranges: SectionRange[] = [];
  let firstSectionIdx = -1;

  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    const text = trimmedTextOf(child);
    if (/^issues? fixed in version /i.test(text)) {
      firstSectionIdx = i;
      break;
    }
  }

  if (firstSectionIdx === -1) return [];

  // Per PLAN §Split (Mojang): the children before `firstSectionIdx` are
  // the preamble. The first `<p>` with a single `<strong>` child starting
  // with "Update:" is the Update paragraph — it goes on the LAST section.
  // Everything else is general preamble that goes on the OLDEST section.
  const preambleChildren = children.slice(0, firstSectionIdx);
  let updateParaIdx = -1;
  for (let i = 0; i < preambleChildren.length; i++) {
    const child = preambleChildren[i]!;
    const kids = wrapperChildren(child);
    if (
      child.tagName === "p" &&
      kids.length === 1 &&
      kids[0]!.tagName === "strong" &&
      /^update:/i.test(textOf(child))
    ) {
      updateParaIdx = i;
      break;
    }
  }
  const updatePara =
    updateParaIdx >= 0 ? [preambleChildren[updateParaIdx]!] : [];
  const preamble =
    updateParaIdx >= 0
      ? preambleChildren.filter((_, i) => i !== updateParaIdx)
      : preambleChildren;

  const sectionMatches: Array<{ idx: number; version: string; heading: string }> = [];
  for (let i = firstSectionIdx; i < children.length; i++) {
    const child = children[i]!;
    const text = trimmedTextOf(child);
    const match = /^issues? fixed in version (.+):/i.exec(text);
    if (match) {
      sectionMatches.push({
        idx: i,
        version: match[1]!,
        heading: htmlparser2.DomUtils.getOuterHTML(child),
      });
    }
  }

  // sectionMatches are in HTML (DOM) order; their idx values give the actual
  // child slice bounds. Preamble / Update paragraphs attach to the first /
  // last section by VERSION order (oldest / newest), not HTML order.
  const oldestVersion = sectionMatches
    .map((m) => m.version)
    .sort((a, b) => compareVersionTuple(parseMojangVersion(a), parseMojangVersion(b)))[0]!;
  const newestVersion = sectionMatches
    .map((m) => m.version)
    .sort((a, b) => compareVersionTuple(parseMojangVersion(b), parseMojangVersion(a)))[0]!;

  for (let s = 0; s < sectionMatches.length; s++) {
    const m = sectionMatches[s]!;
    const nextStart =
      s + 1 < sectionMatches.length ? sectionMatches[s + 1]!.idx : children.length;
    const pre: Element[] = [];
    if (m.version === oldestVersion) pre.push(...preamble);
    if (m.version === newestVersion) pre.push(...updatePara);
    ranges[s] = {
      version: m.version,
      rawTitle: m.heading,
      children: [
        ...pre,
        ...children.slice(m.idx, lastListEnd(children, m.idx, nextStart)),
      ],
    };
  }

  return ranges;
}

/**
 * Snapshot version pattern used by mojang.com pre-2015 articles: `14w05b`,
 * `1w47a`, etc. Loosely anchors on `\b` to avoid grabbing class names like
 * `post-meta`.
 */
const MOJANG_SNAPSHOT_PATTERN = /(\d{2}w\d{2}[a-z]?)/i;

/**
 * Legacy mojang.com layout (~14w05a / 14w33c era). Mojang re-edited the
 * previous snapshot's article when shipping a hotfix — so a single page
 * describes multiple snapshots with no formal dividers, just `<p>` intros
 * that mention specific snapshot versions.
 *
 * Strategy: scan every `<p>` for a snapshot-version reference. Classify
 * each intro as either a "section header" (declarative blurb for the main
 * content) or a "follow-up note" (release/availability language pointing
 * at a newer hotfix). Follow-up blocks consist of the intro paragraph plus
 * any immediately-trailing `<ul>` of bug links — they're attributed to the
 * version they mention. The remaining content is the main article, which
 * has no explicit version reference in the page itself and is attributed
 * to `targetVersion`.
 */
function splitMojangByVersionLegacy(
  container: Element,
  targetVersion: string,
): SectionRange[] {
  const all = findMojangLegacyFooterEnd(container);

  if (all.length === 0) return [];

  // Step 1: identify every intro paragraph that mentions a snapshot version.
  // A paragraph only counts as an intro if it has an early `<strong>` child
  // — that's how Mojang marked section headers in this layout. Otherwise
  // body paragraphs that merely mention a version in passing (e.g. the
  // "Cross-platform server jar: ...14w05b/..." paragraph that links to
  // the hotfix's server jar) would also match and falsely split the page.
  type Intro = { idx: number; version: string; isFollowUp: boolean };
  const intros: Intro[] = [];
  for (let i = 0; i < all.length; i++) {
    const child = all[i]!;
    if (child.tagName !== "p") continue;
    if (!hasEmphasizedLeadIn(child)) continue;
    const m = MOJANG_SNAPSHOT_PATTERN.exec(textOf(child));
    if (!m) continue;
    intros.push({
      idx: i,
      version: m[1]!.toLowerCase(),
      isFollowUp: isMojangFollowUpNote(child),
    });
  }

  // No version markers anywhere — caller falls back to a synthetic whole-
  // container range attributed to `targetVersion`.
  if (intros.length === 0) return [];

  // Step 2: compute the per-intro section span.

  // Step 2: compute the per-intro section span.
  //   - Follow-up intro: the intro paragraph plus any immediately-trailing
  //     `<ul>` of bug entries (skipping whitespace text nodes between
  //     them). The follow-up block is a "prepended note" — the rest of
  //     the page below it belongs to whoever wrote the original article.
  //   - Declarative intro: a "section header" that introduces the next
  //     version's content. It extends until the next intro paragraph
  //     (whichever kind that is).
  const introSpans: { intro: Intro; start: number; end: number }[] = [];
  for (let i = 0; i < intros.length; i++) {
    const intro = intros[i]!;
    let start: number;
    let end: number;
    if (intro.isFollowUp) {
      // Follow-up note: span only the trailing bug `<ul>`. The intro
      // paragraph itself ("Update: …", "… is now available …") is a
      // meta-note about the hotfix, not article prose — it doesn't
      // belong in the body for that version.
      let scan = intro.idx + 1;
      while (scan < all.length && isEdgeTrimmable(all[scan]!)) scan++;
      const ulCandidate = all[scan];
      if (ulCandidate && ulCandidate.tagName === "ul" && hasBugListItems(ulCandidate)) {
        start = scan;
        end = scan + 1;
      } else {
        start = intro.idx;
        end = intro.idx + 1;
      }
    } else {
      // Declarative intro: extend from the intro itself until the next
      // intro (or end of page). The intro paragraph IS the article's
      // first prose line for its version (e.g. 14w33c's "fixes the holes
      // in the world"), so it stays in.
      start = intro.idx;
      end = i + 1 < intros.length ? intros[i + 1]!.idx : all.length;
    }
    introSpans.push({ intro, start, end });
  }

  // Step 3: collect "covered" indices — everything inside an intro's span,
  // PLUS every follow-up intro's own paragraph. Follow-up intros carry
  // meta-notes like "Update: 14w05b has been released…" — those paragraphs
  // don't belong in any body (their data ends up in the bug `<ul>` via
  // buildBodyElement), so they're stripped from the main range too.
  const covered = new Set<number>();
  for (const span of introSpans) {
    for (let i = span.start; i < span.end; i++) covered.add(i);
    if (span.intro.isFollowUp) covered.add(span.intro.idx);
  }

  // Step 4: build the main range — everything not claimed by an intro.
  // This is the article body that has no explicit version marker in its
  // own paragraph (e.g. 14w05a's "One day this piece of text…" content,
  // which is the original article body buried below the 14w05b follow-up
  // note). When `targetVersion` doesn't match any intro, pickRange falls
  // back to this range. Version is set to the empty string as a "sentinel"
  // so `pickRange` doesn't match it when an explicit intro range also
  // matches (otherwise 14w33c's main range would shadow the 14w33c
  // declarative-intro section because both carry "14w33c" as version).
  const mainChildren = all.filter((_, i) => !covered.has(i));
  const ranges: SectionRange[] = [];
  if (mainChildren.length > 0) {
    ranges.push({
      version: "",
      rawTitle: "",
      children: mainChildren,
    });
  }

  // Step 5: emit one range per intro, attributed to its mentioned version.
  // When `targetVersion` matches an intro, this range wins (e.g. 14w33c
  // target → its one-line "fixes the holes in the world" declarative
  // intro becomes the entire body).
  for (const span of introSpans) {
    ranges.push({
      version: span.intro.version,
      rawTitle: htmlparser2.DomUtils.getOuterHTML(all[span.start]!),
      children: all.slice(span.start, span.end),
    });
  }

  return ranges;
}

/**
 * True if `p` reads like a "follow-up snapshot" intro. These are paragraphs
 * Mojang prepended when they re-released a hotfix on top of an existing
 * snapshot article. Two patterns seen in the wild:
 *   - `<strong>Update:</strong> Snapshot 14w05b has been released to fix the following:`
 *   - `<strong>The 14w33b snapshot is now available and fixed the following issues:</strong>`
 * Declarative blurbs ("The 14w33c snapshot fixes the holes in the world.")
 * are NOT follow-ups — they describe the page's main content.
 */
function isMojangFollowUpNote(p: Element): boolean {
  const raw = textOf(p);
  if (/^update:/i.test(raw)) return true;
  const lower = raw.toLowerCase();
  if (/\bhas been released\b/.test(lower)) return true;
  if (/\b(is |are )?now available\b/.test(lower)) return true;
  if (/\bto fix the following\b/.test(lower)) return true;
  return false;
}

/**
 * True if `p` has a `<strong>` lead-in. Used to distinguish section-header
 * paragraphs (which Mojang emphasized with `<strong>`) from body paragraphs
 * that happen to mention a snapshot version in passing — e.g. the
 * "Cross-platform server jar: <a>…14w05b/server/…</a>" paragraph that
 * includes the version name inside a URL.
 */
function hasEmphasizedLeadIn(p: Element): boolean {
  const kids = wrapperChildren(p);
  if (kids.length === 0) return false;
  if (kids[0]!.tagName === "strong") return true;
  // Some intros wrap the entire text in a single `<strong>` (14w33c style).
  return kids.length === 1 && kids[0]!.tagName === "strong";
}

/**
 * Truncate the legacy mojang.com container at the first footer paragraph.
 * Mojang's snapshot articles ended with a fixed footer block — a "please
 * Truncate the legacy mojang.com container at the first footer paragraph.
 * Mojang's snapshot articles ended with a fixed footer block — the
 * launcher/profile instructions, the cross-platform server jar link, the
 * bug-tracker link, and the "// The Minecraft and Minecraft Realms teams"
 * signoff. None of that is article prose, so the body builder shouldn't
 * carry it forward. ("Please report any and all bugs…" is treated as
 * article prose, not footer — it sits inside the article between the
 * snapshot's content and its own "Bugs fixed in this snapshot:" list.)
 *
 * Returns the children array sliced at the footer terminator. If no
 * footer paragraph is found, returns the whole container unchanged.
 */
function findMojangLegacyFooterEnd(container: Element): Element[] {
  const children = containerChildren(container);
  for (let i = 0; i < children.length; i++) {
    const text = trimmedTextOf(children[i]!);
    if (!text) continue;
    if (isMojangLegacyFooterStart(text)) return children.slice(0, i);
  }
  return children;
}

const MOJANG_LEGACY_FOOTER_PATTERNS: readonly RegExp[] = [
  /^get the (snapshot|pre-release|release|update)\b/i,
  /^to (get|install) snapshots\b/i,
  /^cross-platform server jar\b/i,
  /^report bugs here\b/i,
  /^want to give feedback\b/i,
  /^\/\/ the minecraft and minecraft realms teams\b/i,
];

function isMojangLegacyFooterStart(text: string): boolean {
  return MOJANG_LEGACY_FOOTER_PATTERNS.some((re) => re.test(text));
}

/**
 * True if `ul` looks like a bug-fix list (at least one `<li>` whose `<a>`
 * links to `bugs.mojang.com/browse/MC-…`). Checks the anchor's `href`,
 * not its text content, since the displayed label is just the bug id.
 */
function hasBugListItems(ul: Element): boolean {
  if (ul.tagName !== "ul") return false;
  return wrapperChildren(ul).some((li) => {
    if (li.tagName !== "li") return false;
    for (const a of wrapperChildren(li)) {
      if (a.tagName === "a" && MOJIRA_LINK_PATTERN.test(a.attribs?.href ?? "")) {
        return true;
      }
    }
    return false;
  });
}

// ---------------------------------------------------------------------------
// Body construction — single DOM walk, all transforms in-place.
// ---------------------------------------------------------------------------

/**
 * Build the body DOM for a section. Mutates the source container's children
 * in place to strip section heading, leading/trailing empties, and bug-list
 * items. Returns the captured bug IDs in source order so the caller can
 * populate `bugList` without re-walking the DOM.
 */
function buildBodyElement(range: SectionRange): BugRef[] {
  const sectionChildren = range.children;

  // Strip every section heading — both the one at the start of the section
  // (the "Issues fixed in version X" divider) and any sub-divider like
  // "Issues fixed in version Y" that appears later in the section.
  for (const child of [...sectionChildren]) {
    if (SECTION_HEADING_PATTERN.test(trimmedTextOf(child))) {
      detach(child);
    }
  }

  // Trim leading + trailing empty elements from the section's child array.
  trimEmptyEdgesInPlace(sectionChildren);

  // Split bug `<li>` entries out of every `<ul>` reachable from the
// section's children. Non-bug items stay in the DOM; bug IDs are
// collected as they're removed. Bug `<ul>`s that lose all their bug
// entries are dropped entirely below — their IDs are already captured,
// and any remaining non-bug `<li>`s (e.g. 14w05a's "And many more that
// weren't on the bug tracker…") are non-prose trailing remarks that
// shouldn't reach the body.
const bugList: BugRef[] = [];
const bugListUls: Element[] = [];
// Walk the section's child tree directly. Children are still attached to
// the original DOM, so we walk by descent (not via `getElementsByTagName`
// on a wrapper root) to avoid escaping into adjacent sections.
for (const ul of collectUlsInRoots(sectionChildren)) {
  const lis = (ul.children ?? []).filter(
    (c) => (c as { tagName?: string }).tagName === "li",
  );
  // A `<li>` counts as a bug entry if it contains any descendant `<a>`
  // linking to mojira. This catches the standard "[Bug <a>MC-…</a>] - …"
  // layout AND the older 14w05a layout that wraps each entry in a
  // `<table><tr><td>…</td></tr></table>` (mojira link lives in the nested
  // `<td>`).
  const bugLis = lis.filter((li) => findMojiraId(li as unknown as Element) !== null);
  if (bugLis.length > 0) bugListUls.push(ul as unknown as Element);
  for (const li of bugLis) {
    // htmlparser2's element types are too narrow for our `getElementBy*
    // style calls; cast to the standard DOM `Element` here so the rest of
    // this function can treat `li` as a real element node.
    const liEl = li as unknown as Element;
    const id = extractBugId(liEl);
    if (!id) continue;
    bugList.push({ id, title: extractBugTitle(liEl) });
    detach(liEl);
  }
  // Detach empty `<li>`s (only whitespace text). This preserves the
  // inter-element text nodes around surviving `<li>`s so source
  // formatting (newlines, indentation) survives serialization.
  for (const li of [...(ul.children ?? [])] as Element[]) {
    if (
      li.tagName === "li" &&
      textOf(li).replace(/&nbsp;/g, " ").replace(/&#xa0;/g, " ").trim() === ""
    ) {
      detach(li);
    }
  }
}

// Drop every `<ul>` that contributed bug entries — both the shell and any
// remaining non-bug `<li>`s. Their data is captured in `bugList` and the
// trailing prose ("And many more…", etc.) is article boilerplate, not
// content.
for (const ul of bugListUls) {
  const header = findPrecedingBugListHeader(ul);
  if (header) detach(header);
  detach(ul);
}

// Additionally drop any `<ul>` that became empty without contributing bugs
// (e.g. a list of empty `<li>`s that the previous loop trimmed down to
// nothing). Same rationale: leaving it adds no information.
for (const ul of [...sectionChildren]) {
  if (
    ul.tagName === "ul" &&
    wrapperChildren(ul as unknown as Element).filter((c) => c.tagName === "li")
      .length === 0
  ) {
    detach(ul as unknown as Element);
  }
}

// Strip remaining orphaned bug-list call-to-action paragraphs. "Please
// report any and all bugs…" sits adjacent to the bug list (either right
// before or right after) and is pure boilerplate — strip it wherever it
// appears in the body.
for (const child of [...sectionChildren]) {
  if (
    child.tagName === "p" &&
    /^please report any and all bugs\b/i.test(trimmedTextOf(child as Element))
  ) {
    detach(child as Element);
  }
}

return bugList;
}

/**
 * Walk back through `ul`'s siblings and return the nearest preceding
 * `<p>` that looks like a bug-list section header. Returns `null` when
 * no such paragraph exists (header already removed, header has unusual
 * markup, or `ul` isn't actually a bug list).
 */
function findPrecedingBugListHeader(ul: Element): Element | null {
  const parent = ul.parent as { children?: unknown[] } | null;
  if (!parent || !Array.isArray(parent.children)) return null;
  const siblings = parent.children as Element[];
  const idx = siblings.indexOf(ul);
  for (let i = idx - 1; i >= 0; i--) {
    const sib = siblings[i]! as Element;
    if ((sib as { type?: string }).type === "text") continue;
    if ((sib as Element).tagName !== "p") return null;
    return isBugListSectionHeader(trimmedTextOf(sib as Element))
      ? (sib as Element)
      : null;
  }
  return null;
}

/**
 * True if `text` looks like a paragraph that introduces a bug list ("Bugs
 * fixed:", "Bugs fixed in this snapshot:", etc.). These headers are
 * orphans once their `<ul>` is extracted into `bugList`, so they're
 * stripped alongside the now-empty list.
 */
function isBugListSectionHeader(text: string): boolean {
  // Catches "Bugs fixed:", "Bugs fixed in this snapshot:", "Bugs fixed
  // in 16w20a:", "Issues fixed:", "Fixed bugs:". Trailing colon is
  // optional; whitespace around the colon is allowed.
  return /^bugs?\s+(?:fixed\s+(?:in\s+\S+)?|fixed\s+bugs?)\s*:?\s*$/i.test(
    text,
  ) || /^(?:fixed\s+bugs?|issues?\s+fixed)\s*:?\s*$/i.test(text);
}

/**
 * Recursively collect every `<ul>` reachable from any root in `roots`.
 * Bounded to the supplied root list — does not escape into the rest of
 * the document via shared parent pointers.
 */
function collectUlsInRoots(roots: Element[]): Element[] {
  const out: Element[] = [];
  const stack = [...roots];
  while (stack.length) {
    const el = stack.pop()!;
    if (el.tagName === "ul") out.push(el);
    for (const c of (el.children ?? []) as Element[]) stack.push(c);
  }
  return out;
}

function detach(child: Element): void {
  const parent = child.parent as { children?: unknown[] } | null;
  if (!parent || !Array.isArray(parent.children)) return;
  parent.children = parent.children.filter((c) => c !== child);
  (child as { parent: Element | null }).parent = null;
}

function containerChildren(container: Element): Element[] {
  return (container.children ?? []) as Element[];
}

function wrapperChildren(wrapper: Element): Element[] {
  return ((wrapper.children ?? []) as unknown[]).filter(
    (c): c is Element =>
      typeof (c as { tagName?: string }).tagName === "string",
  );
}

function trimEmptyEdgesInPlace(children: Element[]): void {
  const isEmpty = (el: Element): boolean =>
    textOf(el)
      .replace(/&nbsp;/g, " ")
      .replace(/&#xa0;/g, " ")
      .trim() === "";

  let start = 0;
  while (start < children.length && isEmpty(children[start]!)) start++;
  let end = children.length;
  while (end > start && isEmpty(children[end - 1]!)) end--;

  if (start === 0 && end === children.length) return;

  // Detach leading + trailing empty children.
  const removed = children.slice(0, start).concat(children.slice(end));
  for (const child of removed) detach(child);
}

function makeShortTextFromChildren(children: Element[]): string {
  // Top-level children are joined with a space; `<ul>`/`<ol>` children
  // are joined with `, ` between their `<li>`s. Nested lists are recursed
  // into so a `<li>` containing its own `<ul>` reads as "X: Y, Z" rather
  // than concatenating both into one block.
  const parts: string[] = [];
  for (const child of children) {
    if (child.tagName === "ul" || child.tagName === "ol") {
      const items = joinListItems(child);
      if (items) parts.push(items);
    } else {
      const t = htmlparser2.DomUtils.textContent(child)
        .replace(/\s+/g, " ")
        .trim();
      if (t) parts.push(t);
    }
  }

  const text = parts.join(" ");
  if (text.length <= SHORT_TEXT_LIMIT) return text;
  const cut = text.substring(0, SHORT_TEXT_LIMIT);
  const lastSpace = cut.lastIndexOf(" ");
  const truncated =
    lastSpace > SHORT_TEXT_LIMIT / 2 ? cut.substring(0, lastSpace) : cut;
  return truncated.replace(/^[\s.,!?;:]+/, "").trim();
}

/**
 * Render an `<ul>`/`<ol>` as a comma-separated string of its `<li>`s.
 * Each `<li>` is its visible text (whitespace-collapsed) plus, if it
 * contains a nested list, a colon-prefixed sub-list. Empty `<li>`s are
 * dropped.
 */
function joinListItems(list: Element): string {
  const items: string[] = [];
  for (const li of (list.children ?? []) as Element[]) {
    if (li.tagName !== "li") continue;
    // Pull out any direct-text descendants (excluding nested lists).
    const directText: string[] = [];
    let nestedListText: string | null = null;
    for (const c of (li.children ?? []) as Element[]) {
      if (c.tagName === "ul" || c.tagName === "ol") {
        nestedListText = joinListItems(c);
      } else {
        const t = htmlparser2.DomUtils.textContent(c).replace(/\s+/g, " ").trim();
        if (t) directText.push(t);
      }
    }
    // If textContent picks up everything (including nested), prefer the
    // structured split: direct prose + colon + nested sub-list.
    let label = directText.join(" ").trim();
    if (!label) {
      label = htmlparser2.DomUtils.textContent(li)
        .replace(/\s+/g, " ")
        .trim();
    }
    if (!label) continue;
    if (nestedListText) {
      // Avoid stacking separators when the label already ends with one.
      const endsWithSep = /[:,.]$/.test(label);
      const sep = endsWithSep ? " " : ": ";
      label = `${label}${sep}${nestedListText}`;
    }
    items.push(label);
  }
  return items.join(", ");
}

// ---------------------------------------------------------------------------
// DOM access helpers + version comparators
// ---------------------------------------------------------------------------

function findFirst(
  predicate: (el: Element) => boolean,
  dom: Element,
): Element | null {
  const hits = htmlparser2.DomUtils.findAll(
    predicate as Parameters<typeof htmlparser2.DomUtils.findAll>[0],
    dom as unknown as Parameters<typeof htmlparser2.DomUtils.findAll>[1],
  );
  return (hits[0] as Element | undefined) ?? null;
}

function textOf(el: Element): string {
  return htmlparser2.DomUtils.textContent(el);
}

function trimmedTextOf(el: Element): string {
  return textOf(el).trim();
}

/** Normalize a version string for loose comparison: lowercase, collapse whitespace, trim. */
function normalizeVersion(version: string): string {
  return version.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Build a new current-section record. The deprecated `getOuterHTML` call is intentional. */
function startSection(versionStr: string, child: Element, sectionStart: number): {
  version: string;
  rawTitle: string;
  sectionStart: number;
} {
  return {
    version: versionStr,
    rawTitle: htmlparser2.DomUtils.getOuterHTML(child),
    sectionStart,
  };
}

/** True if a root node contributes nothing visible (whitespace text or comment). */
function isEdgeTrimmable(node: ChildNode): boolean {
  if (isComment(node)) return true;
  if (isText(node)) return /^\s*$/.test(node.data);
  return false;
}

function normalizeArticleMedia(nodes: ChildNode[]): void {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i] as unknown as Element;
    if (!node || node.tagName !== "div") continue;
    const classes = (node.attribs?.class ?? "").split(" ");
    if (!classes.includes("article-media")) continue;

    const imgs = htmlparser2.DomUtils.findAll(
      (el) => el.tagName === "img",
      node as unknown as Parameters<typeof htmlparser2.DomUtils.findAll>[1],
    ) as unknown as Element[];
    const imageEl = imgs[0] ?? null;

    let imageLinksTo: undefined | string = undefined;
    //console.log(imageEl?.parentNode?.parentNode?.type)
    if (
      imageEl?.parentNode?.parentNode?.type === "tag" 
      && imageEl.parentNode.parentNode.tagName === "a"
    ) {
      imageLinksTo = imageEl.parentNode.parentNode.attributes.find((attr) => attr.name === "href")?.value;

      if (typeof imageLinksTo === "string" && imageLinksTo.startsWith("https://youtu")) {
        const youtubeLink = new URL(imageLinksTo)

        // This doesn't work in the __rendered.html either because of something missing in the <head> or because its not actually from a webserver
        // or because the host isnt https, but I tested the element on mcc-gadgets.com and it worked fine.
        // TODO: Add wrapper to this so the user sees the thumbnail mojang chose for the article and when they click the video should start
        nodes[i] = new DomElement(
          "iframe",
          {
            id: 'ytplayer',
            width: "640",
            height: "360",
            frameborder: "0",
            src: `https://www.youtube.com/embed/${
              youtubeLink.hostname === 'youtu.be' ? youtubeLink.pathname.slice(1) : youtubeLink.searchParams.get('v')
            }`,
            allow: "compute-pressure",
            referrerpolicy: "strict-origin-when-cross-origin"
          },
          [],
          ElementType.Tag,
        ) as unknown as Element;
        continue;
      }
    }

    let subtitleEl: Element | null = null;
    const stack: Element[] = [...((node.children ?? []) as Element[])];
    while (stack.length) {
      const el = stack.pop()!;
      if ((el.attribs?.class ?? "").split(" ").includes("MC_Link_Style_RichText")) {
        subtitleEl = el;
        break;
      }
      for (const c of (el.children ?? []) as Element[]) stack.push(c);
    }

    // Absolutize the src on the img (same rule as the hero image).
    if (imageEl?.attribs?.src) {
      const abs = absolutizeImageUrl(imageEl.attribs.src);
      if (abs !== null) imageEl.attribs.src = abs;
    }

    if (subtitleEl) {
      // Build a captioned-image wrapper with the img and the
      // subtitle's children (unwrapped from the RichText div).
      const wrap = documentCreateDiv("captioned-image");
      if (imageEl) (wrap.children ?? []).push(imageEl);
      for (const c of (subtitleEl.children ?? []) as Element[]) {
        (wrap.children ?? []).push(c);
      }
      nodes[i] = wrap;
    } else if (imageEl) {
      // Bare img — replace the article-media div with the img directly.
      nodes[i] = imageEl;
    }
  }
}

/** Minimal DOM element factory — uses domhandler's Element class so the
 *  serializer recognizes the result and writes it as `<div>` rather than
 *  `undefined`. */
function documentCreateDiv(className: string): Element {
  return new DomElement(
    "div",
    { class: className },
    [],
    ElementType.Tag,
  ) as unknown as Element;
}

function trimRootEdges(nodes: ChildNode[]): ChildNode[] {
  let start = 0;
  let end = nodes.length;
  while (start < end && isEdgeTrimmable(nodes[start]!)) start++;
  while (end > start && isEdgeTrimmable(nodes[end - 1]!)) end--;
  return nodes.slice(start, end);
}

function parseMojangVersion(v: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(v);
  if (!m) return [0, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? "0")];
}

function parseMinecraftNetVersion(v: string): (number | string)[] {
  const m =
    /^(\d+)\.(\d+)(?:\.(\d+))?\s+(pre-release|release-candidate|snapshot)?\s*(\d+)?$/i.exec(
      v,
    );
  if (!m) return [0, 0, 0, "", 0];
  return [
    Number(m[1]),
    Number(m[2]),
    Number(m[3] ?? "0"),
    (m[4] ?? "").toLowerCase(),
    Number(m[5] ?? "0"),
  ];
}

function compareVersionTuple(
  a: (number | string)[],
  b: (number | string)[],
): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return 0;
}

/** Absolute-prefix a hero image URL when it's relative to minecraft.net. */
export function absolutizeImageUrl(url: string | null): string | null {
  if (!url) return null;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  if (url.startsWith("/")) return `${MINECRAFT_NET_BASE}${url}`;
  return `${MINECRAFT_NET_BASE}/${url}`;
}

/**
 * Fallback hero image lookup for older mojang.com snapshots. The
 * `<div class="post-header__image">` shell is empty on these pages; the
 * actual image is the first `<img>` in the article body whose enclosing
 * `<a>` (or whose own `src`) points at `media.mojang.com`. That signals
 * the snapshot's hero asset (e.g. `14w05a.png`, `14w33a.png`) as opposed
 * to social icons / site chrome.
 */
function findFirstHeroInBody(root: Element): string | null {
  const imgs = htmlparser2.DomUtils.findAll(
    (el) => el.tagName === "img",
    root as unknown as Parameters<typeof htmlparser2.DomUtils.findAll>[1],
  ) as unknown as Element[];
  for (const img of imgs) {
    const src = img.attribs?.src;
    if (!src) continue;
    if (!src.includes("media.mojang.com")) continue;
    return src;
  }
  return null;
}

/**
 * Serialize a DOM fragment (a list of root `ChildNode`s) into the lossless
 * `$ref`-indexed JSON shape consumed by `deserializeAst`. Preorder DFS so
 * `nodes[i].children` always indexes nodes serialized after `i`, and
 * `nodes[i].parent.$ref` indexes a node serialized before `i`.
 */
export function serializeAst(roots: ChildNode[]): SerializedAST {
  const nodes: ASTNode[] = [];
  const rootIndexes: number[] = [];

  function visit(node: ChildNode, parentIdx: number | null): void {
    const idx = nodes.length;
    const parent: ASTRef | null = parentIdx === null ? null : { $ref: parentIdx };
    if (isText(node)) {
      nodes.push({ type: "text", data: node.data, parent, prev: null, next: null });
      return;
    }
    if (isComment(node)) {
      nodes.push({ type: "comment", data: node.data, parent, prev: null, next: null });
      return;
    }
    if (isTag(node)) {
      const children: number[] = [];
      const t = node.type as string;
      let kind: "tag" | "script" | "style";
      if (t === "script") kind = "script";
      else if (t === "style") kind = "style";
      else kind = "tag";
      nodes.push({
        type: "element",
        tag: node.tagName,
        kind,
        attrs: { ...node.attribs },
        children,
        parent,
        prev: null,
        next: null,
      });
      for (const child of node.children) {
        const childIdx = nodes.length;
        visit(child, idx);
        children.push(childIdx);
      }
      return;
    }
  }

  function wireSiblings(indexes: number[]): void {
    for (let i = 0; i < indexes.length; i++) {
      const idx = indexes[i]!;
      const prev: ASTRef | null = i > 0 ? { $ref: indexes[i - 1]! } : null;
      const next: ASTRef | null = i < indexes.length - 1 ? { $ref: indexes[i + 1]! } : null;
      nodes[idx] = { ...nodes[idx]!, prev, next };
    }
  }

  for (const root of roots) {
    rootIndexes.push(nodes.length);
    visit(root, null);
  }
  wireSiblings(rootIndexes);
  for (const n of nodes) {
    if (n.type === "element" && n.children.length > 0) {
      wireSiblings(n.children);
    }
  }

  return { nodes };
}

/**
 * Reconstruct a list of domhandler root `Element`s from `SerializedAST`. The
 * returned nodes carry `parent` / `children` links wired up by the
 * `NodeWithChildren` setter, so `htmlparser2.DomUtils.getOuterHTML` (or any
 * other domutils renderer) prints them back as the original HTML.
 */
export function deserializeAst(serialized: SerializedAST): DomElement[] {
  const { nodes } = serialized;
  const domNodes: ChildNode[] = nodes.map((n) => {
    if (n.type === "text") return new DomText(n.data);
    if (n.type === "comment") return new DomComment(n.data);
    const type = n.kind === "script" ? ElementType.Script
              : n.kind === "style" ? ElementType.Style
              : ElementType.Tag;
    return new DomElement(n.tag, { ...n.attrs }, [], type);
  });
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    if (n.type === "element") {
      const elem = domNodes[i] as DomElement;
      for (const childIdx of n.children) {
        elem.children.push(domNodes[childIdx]!);
      }
    }
  }
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    const domNode = domNodes[i]!;
    domNode.prev = n.prev ? domNodes[n.prev.$ref]! : null;
    domNode.next = n.next ? domNodes[n.next.$ref]! : null;
  }
  const roots: DomElement[] = [];
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i]!.parent === null) roots.push(domNodes[i] as DomElement);
  }
  return roots;
}