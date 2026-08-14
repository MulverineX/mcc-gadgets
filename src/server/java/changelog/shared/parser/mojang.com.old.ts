import { type Element, htmlparser2 } from "./types";
import {
  containerChildren,
  hasBugListItems,
  isEdgeTrimmable,
  type SectionRange,
  textOf,
  trimmedTextOf,
  wrapperChildren,
} from "./utils";

const MOJANG_SNAPSHOT_PATTERN = /(\d{2}w\d{2}[a-z]?)/i;

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

function findMojangLegacyFooterEnd(container: Element): Element[] {
  const children = containerChildren(container);
  for (let i = 0; i < children.length; i++) {
    const text = trimmedTextOf(children[i]!);
    if (!text) continue;
    if (isMojangLegacyFooterStart(text)) return children.slice(0, i);
  }
  return children;
}

export { findMojangLegacyFooterEnd };

function isMojangFollowUpNote(p: Element): boolean {
  const raw = textOf(p);
  if (/^update:/i.test(raw)) return true;
  const lower = raw.toLowerCase();
  if (/\bhas been released\b/.test(lower)) return true;
  if (/\b(is |are )?now available\b/.test(lower)) return true;
  if (/\bto fix the following\b/.test(lower)) return true;
  return false;
}

function hasEmphasizedLeadIn(p: Element): boolean {
  const kids = wrapperChildren(p);
  if (kids.length === 0) return false;
  if (kids[0]!.tagName === "strong") return true;
  return kids.length === 1 && kids[0]!.tagName === "strong";
}

export function splitMojangByVersionLegacy(
  container: Element,
  _targetVersion: string,
): SectionRange[] {
  const all = findMojangLegacyFooterEnd(container);

  if (all.length === 0) return [];

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

  if (intros.length === 0) return [];

  const introSpans: { intro: Intro; start: number; end: number }[] = [];
  for (let i = 0; i < intros.length; i++) {
    const intro = intros[i]!;
    let start: number;
    let end: number;
    if (intro.isFollowUp) {
      let scan = intro.idx + 1;
      while (scan < all.length && isEdgeTrimmable(all[scan]!)) scan++;
      const ulCandidate = all[scan];
      if (
        ulCandidate?.tagName === "ul" &&
        hasBugListItems(ulCandidate)
      ) {
        start = scan;
        end = scan + 1;
      } else {
        start = intro.idx;
        end = intro.idx + 1;
      }
    } else {
      start = intro.idx;
      end = i + 1 < intros.length ? intros[i + 1]!.idx : all.length;
    }
    introSpans.push({ intro, start, end });
  }

  const covered = new Set<number>();
  for (const span of introSpans) {
    for (let i = span.start; i < span.end; i++) covered.add(i);
    if (span.intro.isFollowUp) covered.add(span.intro.idx);
  }

  const mainChildren = all.filter((_, i) => !covered.has(i));
  const ranges: SectionRange[] = [];
  if (mainChildren.length > 0) {
    ranges.push({
      version: "",
      rawTitle: "",
      children: mainChildren,
    });
  }

  for (const span of introSpans) {
    ranges.push({
      version: span.intro.version,
      rawTitle: htmlparser2.DomUtils.getOuterHTML(all[span.start]!),
      children: all.slice(span.start, span.end),
    });
  }

  return ranges;
}
