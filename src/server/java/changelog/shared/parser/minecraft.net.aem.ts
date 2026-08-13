import { type Element, isTag, isText } from "./types";
import {
  compareVersionTuple,
  containerChildren,
  detach,
  lastListEnd,
  parseVersionTuple,
  startSection,
  trimEmptyEdgesInPlace,
  trimmedTextOf,
  type SectionRange,
} from "./utils";

function stripUpdateLeadIn(p: Element): void {
  while (p.children && p.children.length > 0) {
    const first = p.children[0]!;
    if (isText(first)) {
      const trimmed = (first.data ?? "").replace(/^[\s:]+/, "");
      if (trimmed === "") {
        detach(first as unknown as Element);
        continue;
      }
      if (trimmed !== first.data) first.data = trimmed;
      break;
    }
    if (isTag(first) && first.tagName === "b") {
      detach(first as unknown as Element);
      continue;
    }
    break;
  }
  trimEmptyEdgesInPlace((p.children ?? []) as Element[]);
}

export function splitMinecraftNetByVersion(
  container: Element,
  version: string,
): SectionRange[] {
  const children = containerChildren(container);
  let followUpSkip: Set<number> = new Set();

  function sliceRange(start: number, end: number): Element[] {
    const out: Element[] = [];
    const skip = start === 0 ? followUpSkip : new Set<number>();
    for (let i = start; i < end; i++) {
      if (skip.has(i)) continue;
      out.push(sectionChildren[i]!);
    }
    return out;
  }

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

  const followUpSkipIndices = new Set<number>();
  let followUpBugUlIdx = -1;
  let followUpStartIdx = -1;
  if (followUpNotePattern) {
    for (let i = 0; i < firstFixedBugsIdx; i++) {
      const text = trimmedTextOf(sectionChildren[i]!);
      if (!/^update:/i.test(text)) continue;
      followUpSkipIndices.add(i);
      if (followUpStartIdx === -1) followUpStartIdx = i;
      if (text.toLowerCase().includes(version.toLowerCase())) {
        followUpStartIdx = i;
      }
    }
    followUpSkipIndices.add(firstFixedBugsIdx);
    for (
      let i = firstFixedBugsIdx + 1;
      i < sectionChildren.length &&
      i < (firstChangesInIdx === -1 ? sectionChildren.length : firstChangesInIdx);
      i++
    ) {
      followUpSkipIndices.add(i);
      const sib = sectionChildren[i]!;
      if (sib.tagName === "ul") {
        followUpBugUlIdx = i;
        break;
      }
    }
    followUpSkip = followUpSkipIndices;
  }

  const ranges: SectionRange[] = [];
  let current: {
    version: string;
    rawTitle: string;
    sectionStart: number;
    followUp?: boolean;
  } | null = null;

  for (let i = 0; i < sectionChildren.length; i++) {
    const child = sectionChildren[i]!;
    const text = trimmedTextOf(child);
    if (process.env.DEBUG_PICK) {
      console.log(`  [${i}] ${child.tagName}: ${text}`);
    }
    const headingMatch =
      /^(changes? in|technical changes? in|fixed bugs? in)\s*(.*)$/i.exec(text);
    const plainMatch = headingMatch
      ? null
      : /^(changes?|technical changes?)$/i.exec(text);

    if (!headingMatch && !plainMatch) continue;

    if (process.env.DEBUG_PICK && /21w08/.test(version)) {
      console.log(
        `  [heading] idx=${i} text=${JSON.stringify(text)} match=${headingMatch ? JSON.stringify(headingMatch[1]) : "plain"} ver=${headingMatch ? JSON.stringify(headingMatch[2]) : ""}`,
      );
    }
    let versionStr: string;
    if (headingMatch) {
      versionStr = headingMatch[2]!.trim();
      if (versionStr === "" || /^technical/i.test(headingMatch[1]!)) {
        current ??= startSection(version, child, i);
        continue;
      }
      versionStr = versionStr
        .replace(
          /\s+(pre-?release|release-?candidate|snapshot)\s*/i,
          (_, t: string) => {
            const norm = t.toLowerCase().replace(/\s+/g, "");
            return `-${norm === "prerelease" ? "pre" : norm === "releasecandidate" ? "rc" : norm}`;
          },
        )
        .replace(/(\d+)$/, "");
    } else {
      versionStr = version;
    }

    if (/^changes? in\b/i.test(headingMatch?.[1] ?? "")) {
      if (current) {
        ranges.push({
          ...current,
          children: current.followUp
            ? sliceRange(current.sectionStart, followUpBugUlIdx + 1)
            : sliceRange(current.sectionStart, i),
        });
      }
      const sectionStart = followUpNotePattern ? 0 : i;
      current = startSection(versionStr, child, sectionStart);
    } else {
      if (!current && /^fixed bugs? in\b/i.test(headingMatch?.[1] ?? "")) {
        const sectionStart = followUpStartIdx !== -1 ? followUpStartIdx : i;
        if (followUpStartIdx !== -1) {
          stripUpdateLeadIn(sectionChildren[sectionStart]! as Element);
        }
        current = {
          ...startSection(versionStr, child, sectionStart),
          followUp: true,
        };
      } else {
        current ??= startSection(versionStr, child, i);
      }
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
    console.log(
      `  [minecraft-net] current=${current?.version} ranges=${JSON.stringify(ranges.map((r) => ({ v: r.version, c: r.children.length })))}`,
    );
  }

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
    compareVersionTuple(
      parseVersionTuple(b.version),
      parseVersionTuple(a.version),
    ),
  );
  return ranges;
}
