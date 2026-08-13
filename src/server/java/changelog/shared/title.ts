/**
 * Convert a manifest version id into a human-readable display title. Used by
 * the `version/{x}` route handler and tests to populate the `title` field
 * of the API response.
 *
 * The parser does NOT emit a title — this is a pure derivation from the
 * version id, no DOM involved.
 */
export function humanReadableTitle(version: string): string {
  // Patch release: 1.20.4 / 1.10.2 / 1.16.2
  const patch = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (patch) {
    return `Minecraft ${patch[1]}.${patch[2]}.${patch[3]}`;
  }

  // Base release: 1.20 / 1.10 / 1.21
  const base = /^(\d+)\.(\d+)$/.exec(version);
  if (base) {
    return `Minecraft ${base[1]}.${base[2]}`;
  }

  // Old-format snapshot: 17w06a / 18w22c
  const oldSnap = /^(\d+w\d+[a-z]?)$/.exec(version);
  if (oldSnap) {
    return `Minecraft Snapshot ${oldSnap[1]}`;
  }

  // New-format snapshot: 26.2-snapshot-3
  const newSnap = /^(\d+)\.(\d+)-snapshot-(\d+)$/.exec(version);
  if (newSnap) {
    return `Minecraft ${newSnap[1]}.${newSnap[2]} Snapshot ${newSnap[3]}`;
  }

  // Pre-release: 1.12-pre6 / 1.19.3-pre-release-3 / 1.12-pre-release
  const pre = /^(\d+\.\d+(?:\.\d+)?)-pre(?:-release)?-?(\d+)?$/.exec(version);
  if (pre) {
    const num = pre[2] ?? "1";
    return `Minecraft ${pre[1]} Pre-Release ${num}`;
  }

  // Release candidate: 1.16-rc1 / 26.1-rc-1
  const rc = /^(\d+\.\d+(?:\.\d+)?)-rc-?(\d+)?$/.exec(version);
  if (rc) {
    const num = rc[2] ?? "1";
    return `Minecraft ${rc[1]} Release Candidate ${num}`;
  }

  // Fallback — pass the id through verbatim.
  return `Minecraft ${version}`;
}