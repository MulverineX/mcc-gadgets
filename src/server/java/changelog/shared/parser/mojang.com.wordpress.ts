import { type Element, isTag, htmlparser2 } from "./types";
import {
  compareVersionTuple,
  containerChildren,
  lastListEnd,
  normalizeVersion,
  parseVersionTuple,
  textOf,
  trimmedTextOf,
  type SectionRange,
} from "./utils";

const MOJANG_HEADING_RE = /^issues? fixed in version (.+):/i;

export function splitMojangByVersionNewer(container: Element): SectionRange[] {
  const children = containerChildren(container);
  const ranges: SectionRange[] = [];
  let firstSectionIdx = -1;

  for (let i = 0; i < children.length; i++) {
    if (MOJANG_HEADING_RE.test(trimmedTextOf(children[i]!))) {
      firstSectionIdx = i;
      break;
    }
  }

  if (firstSectionIdx === -1) return [];

  const preambleChildren = children.slice(0, firstSectionIdx);
  let updateParaIdx = -1;
  for (let i = 0; i < preambleChildren.length; i++) {
    const child = preambleChildren[i]!;
    if (
      isTag(child) &&
      child.tagName === "p" &&
      child.children.length === 1 &&
      isTag(child.children[0]!) &&
      child.children[0]!.tagName === "strong" &&
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
    const match = MOJANG_HEADING_RE.exec(trimmedTextOf(children[i]!));
    if (match) {
      sectionMatches.push({
        idx: i,
        version: match[1]!,
        heading: htmlparser2.DomUtils.getOuterHTML(children[i]!),
      });
    }
  }

  const oldestVersion = sectionMatches
    .map((m) => m.version)
    .sort((a, b) =>
      compareVersionTuple(parseVersionTuple(a), parseVersionTuple(b)),
    )[0]!;
  const newestVersion = sectionMatches
    .map((m) => m.version)
    .sort((a, b) =>
      compareVersionTuple(parseVersionTuple(b), parseVersionTuple(a)),
    )[0]!;

  for (let s = 0; s < sectionMatches.length; s++) {
    const m = sectionMatches[s]!;
    const nextStart =
      s + 1 < sectionMatches.length ? sectionMatches[s + 1]!.idx : children.length;
    const pre: Element[] = [];
    if (normalizeVersion(m.version) === normalizeVersion(oldestVersion)) pre.push(...preamble);
    if (normalizeVersion(m.version) === normalizeVersion(newestVersion)) pre.push(...updatePara);
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
