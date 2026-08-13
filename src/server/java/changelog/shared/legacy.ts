import { isLegacyVersion, legacyWindowsFor, majorMinorOf } from "../data/legacy-mapping";

/** Cutoff for Wayback captures. After this date, `mojang.com` redirected to `minecraft.net`. */
const WAYBACK_CUTOFF = "20190901";

const CDX_BASE = "https://web.archive.org/cdx/search/cdx";
const WAYBACK_BASE = "https://web.archive.org/web";

export interface LegacyCapture {
  /** The Wayback URL to fetch the article HTML from. */
  url: string;
  /** The original mojang.com URL (for debugging / response metadata). */
  original: string;
  /** Wayback capture timestamp (YYYYMMDDHHMMSS). */
  timestamp: string;
  /** The mojang slug the capture is expected to serve (for shared-page detection). */
  matchedSlug: string;
}

const HARDCODED_LEGACY_SLUGS: Record<
  string,
  { slug: string; year: number; month: number }
> = {
  "1.11": {
    slug: "seek-out-the-exploration-update-111-on-pc-mac-now",
    year: 2016,
    month: 11,
  },
};

/**
 * Map an ISO 8601 week number to the (1-indexed) month containing its Monday.
 * Per PLAN §Month from ISO Week.
 *
 * We walk back from Jan 4 (always in ISO week 1) to the Monday of week 1,
 * then add (week - 1) * 7 days. Using the Monday (not the Thursday per
 * PLAN's literal algorithm) avoids probing the wrong month for boundary
 * weeks like week 5 of 2014 (Monday Jan 27, Thursday Feb 1).
 */
export function getMonthFromWeek(year: number, week: number): number {
  const jan4 = new Date(year, 0, 4);
  const jan4Day = jan4.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const offsetToMonday = jan4Day === 0 ? -6 : 1 - jan4Day;
  const week1Monday = new Date(
    jan4.getTime() + offsetToMonday * 24 * 60 * 60 * 1000,
  );
  const weekStart = new Date(
    week1Monday.getTime() + (week - 1) * 7 * 24 * 60 * 60 * 1000,
  );
  return weekStart.getMonth() + 1;
}

/**
 * Parse a CDX response body into `[timestamp, original]` rows.
 * CDX `fl=timestamp,original` returns space-separated rows (NOT tabs).
 */
export function parseCdxRows(text: string): Array<[string, string]> {
  return text
    .split("\n")
    .map((line) => line.split(" ", 2) as [string, string] | [string])
    .filter((parts): parts is [string, string] => parts.length === 2);
}

/**
 * A `<url>` in a Wayback CDX response is a base-release article when it
 * sits under `mojang.com/<year>/<month>/minecraft-{mm}-{title}/` and the
 * slug doesn't end in a known pre-release / snapshot / RC / numeric-patch
 * suffix.
 */
export function isBaseReleaseUrl(url: string, majorMinor: string): boolean {
  const cleaned = url
    .replace(/\?.*$/, "")
    .replace(/\/$/, "")
    .split("/")
    .pop() ?? "";
  const prefix = `minecraft-${majorMinor}-`;
  if (!cleaned.startsWith(prefix)) return false;
  if (/-(pre-release|snapshot|release-candidate)\b/.test(cleaned)) return false;
  const tail = cleaned.slice(prefix.length);
  if (/^\d+$/.test(tail)) return false;
  return true;
}

/**
 * Resolve a legacy version (1.11 and below) to a Wayback Machine capture
 * URL. The caller supplies a `cdxFetch` so production code can use the
 * Vercel runtime cache and the test suite can use a disk-backed fetcher.
 *
 * Patch release cascade: `minecraft-{mm}{p}` first, decrement patch
 * (1102 → 1101 → 110), then bare base slug. Base release wildcard scan
 * looks for non-pre-release / non-snapshot / non-RC captures.
 */
export async function resolveLegacyWaybackUrlRaw(
  version: string,
  cdxFetch: (url: string) => Promise<string | null>,
): Promise<LegacyCapture | null> {
  const mm = majorMinorOf(version);
  if (!mm) return null;
  // Modern versions live on minecraft.net — no point querying the Wayback
  // archive of mojang.com for them. Skipping avoids wasted CDX round-trips
  // per pre-release when the sitemap has no hit.
  if (!isLegacyVersion(mm)) return null;
  const windows = legacyWindowsFor(version);
  if (!windows) return null;

  const hardcoded = HARDCODED_LEGACY_SLUGS[version];
  if (hardcoded) {
    const capture = await captureForSlug(hardcoded.year, hardcoded.month, hardcoded.slug, cdxFetch);
    return capture ? { ...capture, matchedSlug: hardcoded.slug } : null;
  }

  // Patch release cascade.
  const patchMatch = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (patchMatch) {
    const [, major, minor, patch] = patchMatch;
    if (major && minor && patch) {
      const patchNum = Number(patch);
      const baseSlug = `minecraft-${major}${minor}`;
      const attempts: string[] = [];
      for (let n = patchNum; n >= 1; n--) {
        attempts.push(`minecraft-${major}${minor}${n}`);
      }
      attempts.push(baseSlug);
      // Trust the legacy mapping — derive month from window start week,
      // Per-slug probe: each slug has its own release month (the slug's
      // own window's weekEnd). The first slug (matching the version's exact
      // patch) additionally probes the start month when the window crosses
      // a month boundary — that's where pre-releases can ship.
      for (const [i, slug] of attempts.entries()) {
        // `slug` is the article slug (e.g. `minecraft-1101`); `legacyWindowsFor`
        // expects a manifest version id (e.g. `1.10.1`). Translate before lookup,
        // otherwise the cascade skips every patch and falls through to the
        // base-release wildcard scan, which returns the wrong article for
        // any version whose base release has its own page (e.g. 1.10.1
        // resolving to `minecraft-110-an-update-of-fire-and-ice`).
        const prefix = `minecraft-${major}${minor}`;
        const slugVersion =
          slug === prefix ? `${major}.${minor}` : `${major}.${minor}.${slug.slice(prefix.length)}`;
        const slugWindows = legacyWindowsFor(slugVersion);
        const sw = slugWindows?.[0];
        if (!sw) continue;
        const releaseMonth = getMonthFromWeek(sw.year, sw.weekEnd);
        const capture = await captureForSlug(sw.year, releaseMonth, slug, cdxFetch);
        if (capture) return { ...capture, matchedSlug: slug };
        if (i === 0) {
          // First slug (the exact-patch cascade): also probe the start month
          // when the window crosses a month boundary. Pre-releases may ship
          // there; the release itself only lands on the end-month side.
          const startMonth = getMonthFromWeek(sw.year, sw.weekStart);
          if (startMonth !== releaseMonth) {
            const startCapture = await captureForSlug(sw.year, startMonth, slug, cdxFetch);
            if (startCapture) return { ...startCapture, matchedSlug: slug };
          }
        }
      }
    }
  }

  // Legacy week snapshot: 14w05a -> minecraft-snapshot-14w05a. 14w33c
  // tries the exact letter, then decrements (14w33b, 14w33a) since Mojang
  // often merged later letters into the earlier sibling's article.
  // Derive the probe month from the snapshot's own week (parsed from the id),
  // not from the major.minor window — windows can span months and the
  // snapshot's release week is what determines the article date.
  const snapMatch = /^\d{2}w(\d{1,2})([a-z]?)$/i.exec(version);
  if (snapMatch) {
    const base = version.slice(0, -snapMatch[2]!.length);
    const letter = snapMatch[2]!.toLowerCase();
    const year = windows[0]!.year;
    const snapWeek = Number(snapMatch[1]);
    const slugs: string[] = [];
    if (letter) {
      let cur = letter.charCodeAt(0);
      while (cur >= "a".charCodeAt(0)) {
        slugs.push(`minecraft-snapshot-${base}${String.fromCharCode(cur)}`);
        cur--;
      }
    } else {
      slugs.push(`minecraft-snapshot-${version}`);
    }
    const month = getMonthFromWeek(year, snapWeek);
    for (const slug of slugs) {
      const capture = await captureForSlug(year, month, slug, cdxFetch);
      if (capture) return { ...capture, matchedSlug: slug };
    }
  }

  // Base release.
  const majorMinor = mm.replace(".", "");
  const slug = `minecraft-${majorMinor}`;
  const windowsFlat = flattenYearMonthWindows(windows, 12);
  for (const { year, month } of windowsFlat) {
    const text = await cdxFetch(
      `${CDX_BASE}?url=mojang.com/${year}/${pad2(month)}/${slug}-*&to=${WAYBACK_CUTOFF}&filter=statuscode:200&fl=timestamp,original`,
    );
    if (text === null) continue;
    const rows = parseCdxRows(text);
    if (rows.length === 0) continue;
    const matches = rows.filter(([, url]) => isBaseReleaseUrl(url, majorMinor));
    if (matches.length === 0) continue;
    matches.sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0));
    const head = matches[0];
    if (!head) continue;
    const [ts, original] = head;
    return {
      url: `${WAYBACK_BASE}/${ts}/${original.replace(/^https?:\/\//, "")}`,
      original,
      timestamp: ts,
      matchedSlug: slug,
    };
  }
  return null;
}

async function captureForSlug(
  year: number,
  month: number,
  slug: string,
  cdxFetch: (url: string) => Promise<string | null>,
): Promise<Omit<LegacyCapture, "matchedSlug"> | null> {
  const monthStr = pad2(month);
  const text = await cdxFetch(
    `${CDX_BASE}?url=mojang.com/${year}/${monthStr}/${slug}&to=${WAYBACK_CUTOFF}&filter=statuscode:200&fl=timestamp,original&sort=reverse&limit=1`,
  );
  if (text === null) return null;
  const row = text.trim().split("\n")[0]?.split(" ", 2) ?? [];
  const [ts, original] = row as [string, string] | [];
  if (!ts || !original) return null;
  return {
    url: `${WAYBACK_BASE}/${ts}/${original.replace(/^https?:\/\//, "")}`,
    original,
    timestamp: ts,
  };
}

function flattenYearMonthWindows(
  windows: ReadonlyArray<{ year: number; weekStart: number; weekEnd: number }>,
  monthsPerWindow: number,
): Array<{ year: number; month: number }> {
  const flat: Array<{ year: number; month: number }> = [];
  for (const w of windows) {
    const startMonth = getMonthFromWeek(w.year, w.weekStart);
    for (let dm = 0; dm < monthsPerWindow; dm++) {
      const month = ((startMonth - 1 + dm) % 12) + 1;
      const year = w.year + Math.floor((startMonth - 1 + dm) / 12);
      flat.push({ year, month });
    }
  }
  return flat;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}
