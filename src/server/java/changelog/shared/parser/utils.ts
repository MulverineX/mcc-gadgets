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
  const m =
    /^(\d+)\.(\d+)(?:\.(\d+))?(?:\s+(pre-release|release-candidate|snapshot)\s*(\d+)?)?$/i.exec(
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
  const normalized = normalizeVersion(version);
  const hit = ranges.find(
    (r) => r.version !== "" && normalizeVersion(r.version) === normalized,
  );
  if (hit) return hit;
  return ranges.find((r) => r.version === "") ?? ranges[0]!;
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
  }

  for (const ul of bugListUls) {
    const header = findPrecedingBugListHeader(ul);
    if (header) detach(header);
    detach(ul);
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
