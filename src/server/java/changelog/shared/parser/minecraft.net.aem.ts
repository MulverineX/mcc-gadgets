import { type Element, isTag, isText } from "./types";
import {
  compareVersionTuple,
  containerChildren,
  detach,
  lastListEnd,
  parseVersionTuple,
  type SectionRange,
  startSection,
  trimEmptyEdgesInPlace,
  trimmedTextOf,
} from "./utils";

/**
 * Return every <p> in the container that sits before the first heading —
 * the page-level intro. Tracks "Update:" notes separately so they don't
 * get misattributed to the OLDEST version (they belong to the section
 * they precede, prepended by the splitter).
 *
 * Multi-paragraph intros are common (lead-in + sign-off); only returning
 * the first <p> silently drops the rest.
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
 * True if `<p>` is a Mojang-style "Update:" follow-up note that points at
 * a sibling-section version rather than the page-level intro. Two shapes:
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
  // Stripped form: gate on "(we|i|...) (are|now|have) (on|released|...)" so
  // genuine intro prose like "We're now confident enough in the stability"
  // (1.14-pre1 intro) doesn't match — "confident" isn't "on [pre-release X]".
  return /^(we|i|we've|i've)\s+(are|now|have)\s+(now\s+)?(released|on|rolling|shipping|publishing)\b/i.test(
    text,
  );
}

/**
 * Strip the bold "Update:" + any leading ": " from a `<p>` so the prose
 * left behind reads as a normal sentence ("We're now on pre-release 5").
 */
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
  let followUpSkip = new Set<number>();

  function sliceRange(start: number, end: number): Element[] {
    const out: Element[] = [];
    const skip = start === 0 ? followUpSkip : new Set<number>();
    for (let i = start; i < end; i++) {
      if (skip.has(i)) continue;
      out.push(sectionChildren[i]!);
    }
    return out;
  }

  // `prevSectionEnd` is the index where the last pushed section ended. The
  // next section's `sectionStart` picks up there so content BETWEEN sibling
  // headings (e.g. "New Features in 22w16a" wedged between "Fixed Bugs in
  // 22w16b" and "Changes in 22w16a") isn't dropped.
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
  let changesInCount = 0;
  for (let i = 0; i < sectionChildren.length; i++) {
    const text = trimmedTextOf(sectionChildren[i]!);
    if (/^changes? in\s+\S/i.test(text)) {
      if (firstChangesInIdx === -1) firstChangesInIdx = i;
      changesInCount++;
    }
    if (firstFixedBugsIdx === -1 && /^fixed bugs? in\s+\S/i.test(text)) {
      firstFixedBugsIdx = i;
    }
  }
  const followUpNotePattern =
    firstFixedBugsIdx !== -1 &&
    firstChangesInIdx !== -1 &&
    firstFixedBugsIdx < firstChangesInIdx;
  // Multi-version page (multiple "Changes in X" headings) → the page-level
  // intro is owned by the OLDEST version (prepended by `parseArticle` via
  // `findIntroProse`). The first section's `sectionStart` is set to the
  // heading's own idx so it doesn't inherit the intro. Single-version pages
  // keep `sectionStart = 0` so the intro stays inside the only section.
  const isMultiVersion = changesInCount > 1;

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
      i <
        (firstChangesInIdx === -1 ? sectionChildren.length : firstChangesInIdx);
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
    /** Pre-`sectionStart` Update: paragraphs that belong to this section. */
    prepended?: Element[];
  } | null = null;

  for (let i = 0; i < sectionChildren.length; i++) {
    const child = sectionChildren[i]!;
    const text = trimmedTextOf(child);
    const headingMatch =
      /^(changes? in|technical changes? in|fixed bugs? in)\s*(.*)$/i.exec(text);
    const plainMatch = headingMatch
      ? null
      : /^(changes?|technical changes?)$/i.exec(text);

    if (!headingMatch && !plainMatch) continue;

    let versionStr: string;
    if (headingMatch) {
      versionStr = headingMatch[2]!.trim();
      if (versionStr === "" || /^technical/i.test(headingMatch[1]!)) {
        current ??= startSection(version, child, i);
        continue;
      }
      // Leave versionStr as the heading text ("1.14 PRE-RELEASE 5"). An
      // older transform stripped the digit and rewrote the keyword here,
      // producing "1.14-pre-release" — no version id matches that. `pickRange`
      // now normalizes via `parseVersionTuple`, which accepts both forms.
    } else {
      versionStr = version;
    }

    if (/^changes? in\b/i.test(headingMatch?.[1] ?? "")) {
      if (current) {
        const end = current.followUp ? followUpBugUlIdx + 1 : i;
        const sliced = sliceRange(current.sectionStart, end);
        const pushed = {
          ...current,
          children: current.prepended
            ? [...current.prepended, ...sliced]
            : sliced,
        };
        prevSectionEnd = end;
        ranges.push(pushed);
      }
      // FIRST "Changes in" heading on a multi-version page: sectionStart
      // is the heading's own idx (not 0) so the page-level intro isn't
      // inherited by the newest version. The intro is owned by the oldest
      // version and is prepended later by `parseArticle` via
      // `findIntroProse`. Single-version pages keep sectionStart = 0
      // (the intro belongs to the only section).
      //
      // A bold "Update:" note (e.g. "<p><b>Update:</b> We're now on
      // pre-release 5 ...") often sits between the intro and the first
      // heading. It belongs to THIS version, not the oldest — so we
      // prepend it to the first section's children with the bold marker
      // stripped. The note can span multiple `<p>`s; we collect all of
      // them as long as they're Update: notes.
      const isFirstSection: boolean = current === null;
      const prepended: Element[] = [];
      if (isFirstSection && isMultiVersion) {
        for (let j = i - 1; j >= 0; j--) {
          const prev = sectionChildren[j]!;
          if (prev.tagName === "h2" || prev.tagName === "h3") break;
          if (prev.tagName !== "p") continue;
          if (!isUpdateNote(prev)) break;
          prepended.unshift(prev);
        }
        for (const p of prepended) stripUpdateLeadIn(p);
      }
      const firstSectionStart = isMultiVersion ? i : prevSectionEnd;
      current = {
        ...startSection(
          versionStr,
          child,
          isFirstSection ? firstSectionStart : prevSectionEnd,
        ),
        ...(prepended.length > 0 ? { prepended } : {}),
      };
    } else {
      if (!current && /^fixed bugs? in\b/i.test(headingMatch?.[1] ?? "")) {
        // Single-section release (e.g. 1.20.6): intro + fixed bugs + bug ul
        // + footer. No "Changes in X" ever appears. Start at idx 0 so the
        // intro isn't dropped. If a follow-up Update: para exists, start
        // there instead and strip its bold marker.
        const sectionStart =
          followUpStartIdx !== -1
            ? followUpStartIdx
            : firstChangesInIdx === -1
              ? 0
              : i;
        if (followUpStartIdx !== -1) {
          stripUpdateLeadIn(sectionChildren[sectionStart]!);
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
    const sliced = sliceRange(
      current.sectionStart,
      lastListEnd(
        sectionChildren,
        current.sectionStart,
        sectionChildren.length,
      ),
    );
    ranges.push({
      ...current,
      children: current.prepended ? [...current.prepended, ...sliced] : sliced,
    });
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
