import {
  DomElement,
  ElementType,
  type ChildNode,
  type Element,
  isComment,
  isTag,
  isText,
  htmlparser2,
} from "./types";
import type { BugRef } from "./types";

export const MOJIRA_LINK_PATTERN = /bugs\.mojang\.com\/browse\/(MC-\d+)/;
export const SECTION_HEADING_PATTERN =
  /^(changes? in|technical changes? in|fixed bugs?|issues? fixed in)\b/i;
export const SHORT_TEXT_LIMIT = 280;

export function findFirst(
  predicate: (el: Element) => boolean,
  dom: Element,
): Element | null {
  const hits = htmlparser2.DomUtils.findAll(
    predicate,
    dom,
  );
  return (hits[0] as Element | undefined) ?? null;
}

export function textOf(el: Element): string {
  return htmlparser2.DomUtils.textContent(el);
}

export function trimmedTextOf(el: Element): string {
  return textOf(el).trim();
}

export function detach(child: Element): void {
  const parent = child.parent as { children?: unknown[] } | null;
  if (!parent || !Array.isArray(parent.children)) return;
  parent.children = parent.children.filter((c) => c !== child);
  (child as { parent: Element | null }).parent = null;
}

export function containerChildren(container: Element): Element[] {
  return (container.children ?? []) as Element[];
}

export function wrapperChildren(wrapper: Element): Element[] {
  return ((wrapper.children ?? []) as unknown[]).filter(
    (c): c is Element =>
      typeof (c as { tagName?: string }).tagName === "string",
  );
}

export function documentCreateDiv(className: string): Element {
  return new DomElement(
    "div",
    { class: className },
    [],
    ElementType.Tag,
  ) as unknown as Element;
}

export function isEdgeTrimmable(node: ChildNode): boolean {
  if (isComment(node)) return true;
  if (isText(node)) return /^\s*$/.test(node.data);
  return false;
}

export function trimEmptyEdgesInPlace(children: Element[]): void {
  const isEmpty = (el: Element): boolean =>
    textOf(el).replace(/&nbsp;/g, " ").replace(/&#xa0;/g, " ").trim() === "";

  let start = 0;
  while (start < children.length && isEmpty(children[start]!)) start++;
  let end = children.length;
  while (end > start && isEmpty(children[end - 1]!)) end--;

  if (start === 0 && end === children.length) return;

  const removed = children.slice(0, start).concat(children.slice(end));
  for (const child of removed) detach(child);
}

export function trimRootEdges(nodes: ChildNode[]): ChildNode[] {
  let start = 0;
  let end = nodes.length;
  while (start < end && isEdgeTrimmable(nodes[start]!)) start++;
  while (end > start && isEdgeTrimmable(nodes[end - 1]!)) end--;
  return nodes.slice(start, end);
}

export function normalizeVersion(version: string): string {
  return version.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Parse a heading version into a heterogeneous tuple
 * (major, minor, patch, preReleaseKind, preReleaseNumber). Comparing these
 * tuples sorts snapshot articles correctly even when pre-release kinds
 * differ (`"1.21.4 pre-release 2"` vs `"1.21.4 release-candidate 1"`).
 * For headings without a pre-release suffix (e.g. `"1.10"`, `"1.10.1"`)
 * the trailing two slots default to `""` and `0`.
 */
export function parseVersionTuple(v: string): (number | string)[] {
  // Accepts both the heading format ("1.14 PRE-RELEASE 5") and the manifest
  // id format ("1.14-pre5"). Snapshot ids always have a digit (`26.1-snapshot-3`);
  // pre-release ids may or may not (`1.14-pre1` vs hypothetical `1.14-pre-1`).
  const m =
    /^(\d+)\.(\d+)(?:\.(\d+))?(?:[- ](?:(pre-?release|pre|rc|release-?candidate)(?:[- ]?(\d+))?|snapshot(?:[- ](\d+))?))?$/i.exec(
      v,
    );
  if (!m) return [0, 0, 0, "", 0];
  const rawKind = m[4] ? m[4].toLowerCase().replace(/[-\s]+/g, "") : "";
  const normKind =
    rawKind === "prerelease" || rawKind === "pre"
      ? "pre-release"
      : rawKind === "rc" || rawKind === "releasecandidate"
        ? "release-candidate"
        : "";
  // Snapshot branch puts the digit in m[6]; pre-release/rc branches put it in m[5].
  const digit = m[4] ? Number(m[5] ?? "0") : Number(m[6] ?? "0");
  return [
    Number(m[1]),
    Number(m[2]),
    Number(m[3] ?? "0"),
    normKind,
    digit,
  ];
}

export function compareVersionTuple(
  a: (number | string)[],
  b: (number | string)[],
): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return 0;
}

export function lastListEnd(
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

export function startSection(
  versionStr: string,
  child: Element,
  sectionStart: number,
): { version: string; rawTitle: string; sectionStart: number } {
  return {
    version: versionStr,
    rawTitle: htmlparser2.DomUtils.getOuterHTML(child),
    sectionStart,
  };
}

export interface SectionRange {
  version: string;
  rawTitle: string;
  children: Element[];
}

export function pickRange(
  ranges: SectionRange[],
  version: string,
): SectionRange | null {
  if (ranges.length === 0) return null;
  const target = parseVersionTuple(version);
  const normalized = normalizeVersion(version);
  // When the target is parseable, prefer tuple comparison — handles
  // "1.14 PRE-RELEASE 5" vs "1.14-pre5" mismatches between heading and id
  // formats. Skip the tuple pass when the target is the default tuple
  // (unparseable id like "14w05a"): in that case every range also parses
  // to the default and the tuple check would falsely match anything.
  const targetIsParseable = !(
    target[0] === 0 &&
    target[1] === 0 &&
    target[2] === 0 &&
    target[3] === "" &&
    target[4] === 0
  );
  if (targetIsParseable) {
    const tupleMatch = ranges.find((r) => {
      if (r.version === "") return false;
      const t = parseVersionTuple(r.version);
      return (
        t[0] === target[0] &&
        t[1] === target[1] &&
        t[2] === target[2] &&
        t[3] === target[3] &&
        t[4] === target[4]
      );
    });
    if (tupleMatch) return tupleMatch;
  }
  const literalMatch = ranges.find(
    (r) => r.version !== "" && normalizeVersion(r.version) === normalized,
  );
  if (literalMatch) return literalMatch;
  return ranges.find((r) => r.version === "") ?? ranges[0]!;
}

/**
 * Find the range with the smallest version tuple — the chronologically
 * earliest version on a merged article page. Used to decide which range
 * owns the page-level intro prose.
 *
 * Ranges without a version (version === "") are skipped — they came from
 * plain "Changes" / "New Features" headings and don't participate in the
 * version comparison. For unparseable ids (e.g. legacy snapshots like
 * "14w05a" whose tuple is the default), falls back to literal string
 * comparison so the alphabet still orders them correctly.
 */
export function findOldestRange(ranges: SectionRange[]): SectionRange | null {
  if (ranges.length === 0) return null;
  let oldest: SectionRange | null = null;
  for (const r of ranges) {
    if (r.version === "") continue;
    if (oldest === null) {
      oldest = r;
      continue;
    }
    const aTuple = parseVersionTuple(r.version);
    const bTuple = parseVersionTuple(oldest.version);
    const cmp = compareVersionTuple(aTuple, bTuple);
    if (cmp < 0) {
      oldest = r;
    } else if (cmp === 0 && normalizeVersion(r.version) < normalizeVersion(oldest.version)) {
      // Tuples tied (both default for unparseable ids) — fall back to
      // alphabetical comparison so "21w08a" sorts before "21w08b".
      oldest = r;
    }
  }
  return oldest ?? ranges[0]!;
}

export function findMojiraId(root: Element): `MC-${number}` | null {
  for (const a of collectAllByTag(root, "a")) {
    const m = MOJIRA_LINK_PATTERN.exec(a.attribs?.href ?? "");
    if (m?.[1]) return m[1] as `MC-${number}`;
  }
  return null;
}

export function extractBugId(li: Element): `MC-${number}` | null {
  return findMojiraId(li);
}

export function collectAllByTag(root: Element, name: string): Element[] {
  const out: Element[] = [];
  const stack: Element[] = [root];
  while (stack.length) {
    const el = stack.pop()!;
    if (el.tagName === name) out.push(el);
    for (const c of (el.children ?? []) as Element[]) stack.push(c);
  }
  return out;
}

export function extractBugTitle(li: Element): string {
  const raw = trimmedTextOf(li);
  // Strip "Fixed bug MC-XXX -" / "[Bug MC-XXX]" / bare "MC-XXX" prefix.
  const m = /^(?:\[\s*)?(?:[Ff]ixed\s+)?(?:[Bb]ug\s+)?MC-\d+\s*\]?\s*[-–—:\s ]*/.exec(
    raw,
  );
  const stripped = m ? raw.slice(m[0].length) : raw;
  return stripped.replace(/^[-–—:]\s*/, "").trim();
}

export function hasBugListItems(ul: Element): boolean {
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

export function collectUlsInRoots(roots: Element[]): Element[] {
  const out: Element[] = [];
  const stack = [...roots];
  while (stack.length) {
    const el = stack.pop()!;
    if (el.tagName === "ul") out.push(el);
    for (const c of (el.children ?? []) as Element[]) stack.push(c);
  }
  return out;
}

export function isBugListSectionHeader(text: string): boolean {
  return /^bugs?\s+(?:fixed\s+(?:in\s+\S+)?|fixed\s+bugs?)\s*:?\s*$/i.test(
    text,
  ) || /^(?:fixed\s+bugs?|issues?\s+fixed)\s*:?\s*$/i.test(text);
}

export function findPrecedingBugListHeader(ul: Element): Element | null {
  const parent = ul.parent as { children?: unknown[] } | null;
  if (!parent || !Array.isArray(parent.children)) return null;
  const siblings = parent.children as Element[];
  const idx = siblings.indexOf(ul);
  for (let i = idx - 1; i >= 0; i--) {
    const sib = siblings[i]!;
    if (isText(sib)) continue;
    if (!isTag(sib) || sib.tagName !== "p") return null;
    return isBugListSectionHeader(trimmedTextOf(sib as Element))
      ? (sib as Element)
      : null;
  }
  return null;
}

export function buildBodyElement(range: SectionRange): BugRef[] {
  const sectionChildren = range.children;

  for (const child of [...sectionChildren]) {
    if (SECTION_HEADING_PATTERN.test(trimmedTextOf(child))) {
      detach(child);
    }
  }

  trimEmptyEdgesInPlace(sectionChildren);

  const bugList: BugRef[] = [];
  const bugListUls: Element[] = [];
  for (const ul of collectUlsInRoots(sectionChildren)) {
    // Find the last bug li BEFORE we start detaching — once bug lis are
    // detached, findMojiraId won't find them anymore and we can't tell
    // where "after the bugs" starts. Anything past this index (text
    // nodes, <li>s) gets dropped after the bug extraction loop.
    const lastBugLiIdx = (() => {
      const kids = (ul.children ?? []) as Element[];
      let lastIdx = -1;
      for (let i = kids.length - 1; i >= 0; i--) {
        const c = kids[i]!;
        if (isTag(c) && c.tagName === "li") {
          const id = findMojiraId(c);
          if (process.env.DEBUG_BUGLIST === "1" && id) {
            console.error(
              `[buglist] ul child idx=${i} tag=${c.tagName} bugId=${id} text=${textOf(c).slice(0, 50)}`,
            );
          }
          if (id !== null) lastIdx = i;
        }
      }
      return lastIdx;
    })();

    const lis = (ul.children ?? []).filter(
      (c) => isTag(c) && c.tagName === "li",
    ) as Element[];
    const bugLis = lis.filter((li) => findMojiraId(li) !== null);
    if (bugLis.length > 0) bugListUls.push(ul);
    for (const li of bugLis) {
      const id = extractBugId(li);
      if (!id) continue;
      bugList.push({ id, title: extractBugTitle(li) });
      detach(li);
    }
    for (const li of [...(ul.children ?? [])] as Element[]) {
      if (
        li.tagName === "li" &&
        textOf(li).replace(/&nbsp;/g, " ").replace(/&#xa0;/g, " ").trim() === ""
      ) {
        detach(li);
      }
    }
    // Drop any <li> that lived AFTER the last bug li. Those are typically
    // meta closings ("And many more that weren't on the bug tracker...",
    // "Added some new bugs!", "Added some new covfefe!"), not article
    // content. Lis BEFORE the last bug stay — they may be real content
    // like "Optimized recipe book & ..." in a 1.12-pre6 changes ul.
    if (lastBugLiIdx !== -1) {
      const kids = (ul.children ?? []) as Element[];
      if (process.env.DEBUG_BUGLIST === "1") {
        console.error(
          `[buglist] lastBugLiIdx=${lastBugLiIdx} ulChildrenAfterDetach=${kids.length}`,
        );
        for (let i = 0; i < kids.length; i++) {
          const c = kids[i]!;
          console.error(
            `[buglist]   post[${i}] tag=${isTag(c) ? c.tagName : "text"} text=${textOf(c as Element).slice(0, 60)}`,
          );
        }
      }
      for (let i = kids.length - 1; i > lastBugLiIdx; i--) {
        const c = kids[i]!;
        if (isTag(c) && c.tagName === "li") detach(c);
      }
    }
  }

  for (const ul of bugListUls) {
    const afterTrim = (ul.children ?? []).filter(
      (c) => isTag(c) && c.tagName === "li",
    ) as Element[];
    // The header lives in the original DOM tree (its parent.children),
    // not in sectionChildren — sectionChildren is a filtered slice of
    // mainChildren that aliases the same elements. detach() updates the
    // original parent but leaves the alias list unchanged, so we must also
    // splice header / ul out of sectionChildren explicitly.
    const drop = (node: Element) => {
      detach(node);
      const idx = sectionChildren.indexOf(node);
      if (idx !== -1) sectionChildren.splice(idx, 1);
    };
    if (afterTrim.length === 0) {
      // Every <li> was a bug entry — drop the whole ul + its header.
      const header = findPrecedingBugListHeader(ul);
      if (header) drop(header as Element);
      drop(ul as Element);
    } else {
      // Keep the ul (still has real content lis) but drop the heading —
      // it described the bug list we just stripped out.
      const header = findPrecedingBugListHeader(ul);
      if (header) drop(header as Element);
    }
  }

  for (const ul of [...sectionChildren]) {
    if (
      ul.tagName === "ul" &&
      wrapperChildren(ul).filter((c) => c.tagName === "li").length === 0
    ) {
      detach(ul);
    }
  }

  for (const child of [...sectionChildren]) {
    if (
      child.tagName === "p" &&
      /^please report any and all bugs\b/i.test(trimmedTextOf(child))
    ) {
      detach(child);
    }
  }

  return bugList;
}

export function joinListItems(list: Element): string {
  const items: string[] = [];
  for (const li of (list.children ?? []) as Element[]) {
    if (li.tagName !== "li") continue;
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
    let label = directText.join(" ").trim();
    if (!label) {
      label = htmlparser2.DomUtils.textContent(li)
        .replace(/\s+/g, " ")
        .trim();
    }
    if (!label) continue;
    if (nestedListText) {
      const endsWithSep = /[:,.]$/.test(label);
      const sep = endsWithSep ? " " : ": ";
      label = `${label}${sep}${nestedListText}`;
    }
    items.push(label);
  }
  return items.join(", ");
}

export function makeShortTextFromChildren(children: Element[]): string {
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
