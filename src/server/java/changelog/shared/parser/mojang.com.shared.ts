import { splitMojangByVersionLegacy } from "./mojang.com.old";
import { splitMojangByVersionNewer } from "./mojang.com.wordpress";
import { type Element, isComment } from "./types";
import { containerChildren } from "./utils";
import type { SectionRange } from "./utils";

export function hasWordPressMoreMarker(container: Element): boolean {
  for (const child of containerChildren(container)) {
    if (
      isComment(child) &&
      /^\s*more\s*$/i.test((child as { data: string }).data)
    ) {
      return true;
    }
  }
  return false;
}

export function splitMojangByVersion(
  container: Element,
  targetVersion: string,
): SectionRange[] {
  if (hasWordPressMoreMarker(container)) {
    return splitMojangByVersionNewer(container);
  }
  return splitMojangByVersionLegacy(container, targetVersion);
}
