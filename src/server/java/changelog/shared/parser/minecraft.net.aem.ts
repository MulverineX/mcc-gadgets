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

/**
 * Walk the container's children and return every <p> that sits before the
 * first heading. The intro prose on merged pre-release pages often spans
 * multiple paragraphs (e.g. the lead-in + a "Happy mining!" sign-off).
 * Returning just the first <p> would silently drop the rest and is exactly
 * the kind of bug that only shows up on certain pages.
 *
 * Skips empty <p>s (whitespace-only). Skips <p>s starting with "Update:" —
 * those are version-specific follow-up notes ("Update: we've now released
 * 21w08b to fix a crash") that belong to the section they precede, not to
 * the page-level intro. Stops at the first heading so we don't pull a <p>
 * from inside a "Changes in X" / "Fixed bugs in X" block.
 */
export function findIntroProse(container: Element): Element[] {
  const out: Element[] = [];
  for (const child of containerChildren(container)) {
    if (child.tagName === "h2" || child.tagName === "h3") break;
    if (child.tagName !== "p") continue;
    if (isUpdateNote(child)) continue;
    out.push(child);
  }
  return out;
}

/**
 * True if `<p>` is a Mojang-style "Update:" follow-up note ("Update: we've
 * now released 22w16b to fix a crash") that points at a sibling-section
 * version rather than the page-level intro. Two shapes to handle — the
 * splitter's `stripUpdateLeadIn` may have already removed the literal
 * "Update:" marker by the time we run:
 *
 *   <p><b>Update</b>: we've now released ...   (unstripped)
 *   <p>we've now released ...                (already stripped)
 *
 * Both belong to the section they precede, never to the page-level intro.
 */
function isUpdateNote(p: Element): boolean {
  const first = (p.children ?? [])[0] as Element | undefined;
  if (first && isTag(first) && first.tagName === "b") {
    if (/^update\b/i.test(trimmedTextOf(first))) return true;
  }
  const text = trimmedTextOf(p);
  if (/^update\s*:/i.test(text)) return true;
  // Stripped form: the splitter removes "Update:" but leaves the rest. Real
  // examples: "We've now released 22w16b ...", "We are now on pre-release 5",
  // "We're now on pre-release 5". Distinguish from prose: prose never
  // starts with these patterns. The "(now|are|have) (on|released|...)"
  // gate keeps us from false-matching "We're now confident enough ..."
  // (the actual 1.14-pre1 intro — note the "confident" follows, not
  // "released" / "on [pre-release X]").
  return /^(we|i|we've|i've)\s+(are|now|have)\s+(now\s+)?(released|on|rolling|shipping|publishing)\b/i.test(text);
}

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

  // Tracks the index where the previous section ended so the next section's
  // sectionStart can pick up exactly where the previous one left off. Without
  // this, "Changes in 22w16a" would start at its heading idx, missing any
  // sibling-section content that lives between sections (e.g. "New Features
  // in 22w16a" sits between "Fixed Bugs in 22w16b" and "Changes in 22w16a").
  let prevSectionEnd = 0;
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
    firstChangesInIdx !== -1 &&
    firstFixedBugsIdx < firstChangesInIdx;

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
      // Leave versionStr as the heading text ("1.14 PRE-RELEASE 5"). The old
      // transform here stripped the trailing digit and rewrote the keyword,
      // producing a string like "1.14-pre-release" that no version id could
      // ever match. `pickRange` now compares via `parseVersionTuple` which
      // accepts both heading and id formats.
    } else {
      versionStr = version;
    }

    if (/^changes? in\b/i.test(headingMatch?.[1] ?? "")) {
      if (current) {
        const end = current.followUp ? followUpBugUlIdx + 1 : i;
        const pushed = {
          ...current,
          children: sliceRange(current.sectionStart, end),
        };
        prevSectionEnd = end;
        ranges.push(pushed);
      }
      // New section picks up where the previous one left off. Without this,
      // content that sits BETWEEN sibling headings (e.g. "New Features in
      // 22w16a" between "Fixed Bugs in 22w16b" and "Changes in 22w16a")
      // gets dropped — the "Changes in" heading idx skips over it.
      current = startSection(versionStr, child, prevSectionEnd);
    } else {
      if (!current && /^fixed bugs? in\b/i.test(headingMatch?.[1] ?? "")) {
        // No Update para + no later "Changes in X" → single-section
        // release (e.g. 1.20.6: intro + fixed bugs + bug ul + footer).
        // Start at idx 0 so the intro prose isn't dropped.
        const sectionStart =
          followUpStartIdx !== -1
            ? followUpStartIdx
            : firstChangesInIdx === -1
              ? 0
              : i;
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
  if (process.env.DEBUG_PICK) {
    console.log(
      `  [minecraft-net] version=${version} current=${current?.version} ranges=${JSON.stringify(ranges.map((r) => ({ v: r.version, c: r.children.length })))}`,
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
