/**
 * Legacy version → ISO-week release-window mapping.
 *
 * Versions `1.11` and below were published on `mojang.com` (now redirected to
 * minecraft.net since September 2019). Article URLs for those releases live in
 * the Wayback Machine. The window here lets us narrow a CDX query to the
 * release year+month without hitting the full Wayback corpus.
 *
 * Keys are full version ids: `1.X` covers the base release (with its wide
 * pre-release / snapshot window) and `1.X.Y` covers an individual patch
 * (tight 1-week window). Use `legacyWindowsFor(id)` to resolve either form.
 *
 * The week-to-month derivation that consumes this table lives in
 * `shared/legacy.ts`.
 */
export interface LegacyWindow {
  year: number;
  weekStart: number;
  weekEnd: number;
}

export type LegacyMapping = Record<string, LegacyWindow[]>;

export const legacyMapping: LegacyMapping = {
  "1.1": [
    { year: 2011, weekStart: 47, weekEnd: 50 },
    { year: 2012, weekStart: 1, weekEnd: 1 },
  ],
  "1.2": [{ year: 2012, weekStart: 3, weekEnd: 8 }],
  "1.3": [{ year: 2012, weekStart: 15, weekEnd: 29 }],
  "1.4": [{ year: 2012, weekStart: 32, weekEnd: 50 }],
  "1.5": [{ year: 2013, weekStart: 1, weekEnd: 12 }],
  "1.6": [{ year: 2013, weekStart: 16, weekEnd: 26 }],
  "1.7": [{ year: 2013, weekStart: 36, weekEnd: 49 }],
  "1.8": [{ year: 2014, weekStart: 2, weekEnd: 34 }],
  "1.9": [
    { year: 2015, weekStart: 31, weekEnd: 52 },
    { year: 2016, weekStart: 1, weekEnd: 15 },
  ],
  "1.10": [{ year: 2016, weekStart: 20, weekEnd: 21 }],
  "1.11": [{ year: 2016, weekStart: 32, weekEnd: 50 }],
  "1.12": [{ year: 2017, weekStart: 6, weekEnd: 31 }],
  "1.13": [
    { year: 2017, weekStart: 43, weekEnd: 52 },
    { year: 2018, weekStart: 1, weekEnd: 33 },
  ],
  "1.14": [
    { year: 2018, weekStart: 43, weekEnd: 52 },
    { year: 2019, weekStart: 1, weekEnd: 14 },
  ],
  "1.15": [{ year: 2019, weekStart: 34, weekEnd: 46 }],
  "1.16": [{ year: 2020, weekStart: 6, weekEnd: 30 }],
  "1.17": [
    { year: 2020, weekStart: 45, weekEnd: 52 },
    { year: 2021, weekStart: 1, weekEnd: 20 },
  ],
  "1.18": [
    { year: 2021, weekStart: 37, weekEnd: 44 },
    { year: 2022, weekStart: 3, weekEnd: 7 },
  ],
  "1.19": [
    { year: 2022, weekStart: 11, weekEnd: 52 },
    { year: 2023, weekStart: 1, weekEnd: 7 },
  ],
  "1.20": [
    { year: 2023, weekStart: 12, weekEnd: 52 },
    { year: 2024, weekStart: 1, weekEnd: 14 },
  ],
  "1.21": [
    { year: 2024, weekStart: 18, weekEnd: 52 },
    { year: 2025, weekStart: 1, weekEnd: 46 },
  ],

  // Patch releases — windows derived from version_manifest_v2.json (lower
  // bound = earliest pre-release week, upper bound = release week). Cross-year
  // windows split into multiple entries.
  "1.2.5": [{ year: 2012, weekStart: 13, weekEnd: 13 }],
  "1.3.2": [{ year: 2012, weekStart: 33, weekEnd: 33 }],
  "1.4.7": [{ year: 2012, weekStart: 52, weekEnd: 52 }], // release week 2 of 2013
  "1.5.2": [{ year: 2013, weekStart: 17, weekEnd: 17 }],
  "1.6.4": [{ year: 2013, weekStart: 38, weekEnd: 38 }],
  "1.7.4": [{ year: 2013, weekStart: 50, weekEnd: 50 }],
  "1.7.5": [{ year: 2014, weekStart: 9, weekEnd: 9 }],
  "1.7.6": [{ year: 2014, weekStart: 10, weekEnd: 10 }], // pre-releases at w10
  "1.7.8": [{ year: 2014, weekStart: 15, weekEnd: 15 }],
  "1.7.10": [{ year: 2014, weekStart: 20, weekEnd: 20 }], // pre at w20
  "1.8.1": [{ year: 2014, weekStart: 42, weekEnd: 42 }], // pre at w42
  "1.8.2": [
    { year: 2014, weekStart: 51, weekEnd: 51 }, // pre at w51 (Dec 2014)
    { year: 2015, weekStart: 8, weekEnd: 8 }, // release at w8 (Feb 2015)
  ],
  "1.8.4": [{ year: 2015, weekStart: 16, weekEnd: 16 }],
  "1.8.5": [{ year: 2015, weekStart: 21, weekEnd: 21 }],
  "1.8.6": [{ year: 2015, weekStart: 22, weekEnd: 22 }],
  "1.8.8": [{ year: 2015, weekStart: 31, weekEnd: 31 }],
  "1.8.9": [{ year: 2015, weekStart: 49, weekEnd: 49 }],
  "1.9.1": [{ year: 2016, weekStart: 10, weekEnd: 10 }], // pre at w10
  "1.9.2": [{ year: 2016, weekStart: 13, weekEnd: 13 }],
  "1.9.3": [{ year: 2016, weekStart: 16, weekEnd: 16 }], // pre at w16
  "1.9.4": [{ year: 2016, weekStart: 19, weekEnd: 19 }],
  "1.10.1": [{ year: 2016, weekStart: 25, weekEnd: 25 }],
  "1.10.2": [{ year: 2016, weekStart: 25, weekEnd: 25 }],
  "1.11.1": [{ year: 2016, weekStart: 51, weekEnd: 51 }],
  "1.11.2": [{ year: 2016, weekStart: 51, weekEnd: 51 }],
};

/**
 * Resolve windows for a legacy version id. Exact-id match (e.g. `1.10.1`) wins;
 * falls back to the base `major.minor` for snapshots / pre-releases that share
 * the base release's window.
 */
export function legacyWindowsFor(versionId: string): LegacyWindow[] | null {
  if (legacyMapping[versionId]) return legacyMapping[versionId];
  const mm = majorMinorOf(versionId);
  if (mm && legacyMapping[mm]) return legacyMapping[mm];
  return null;
}

/** True for versions whose articles live in the Wayback Machine archive of mojang.com. */
export function isLegacyVersion(majorMinor: string): boolean {
  // 1.11 and below only — 1.12+ is minecraft.net.
  return (
    legacyMapping[majorMinor] !== undefined &&
    compareMinor(majorMinor, "1.11") <= 0
  );
}

function compareMinor(a: string, b: string): number {
  const [aMaj, aMin] = a.split(".").map(Number);
  const [bMaj, bMin] = b.split(".").map(Number);
  if (aMaj !== bMaj) return aMaj! - bMaj!;
  return aMin! - bMin!;
}

/**
 * Extract the `major.minor` prefix from a manifest version id.
 * `1.11.1` -> `1.11`
 * `1.11` -> `1.11`
 * `1.11-pre1` -> `1.11`
 * `1.9.3-pre1` -> `1.9.3` (patch pre-release — common pre-1.11)
 * `18w22a` -> `1.13` (legacy snapshot, looked up by ISO week)
 */
export function majorMinorOf(id: string): string | null {
  // Patch: 1.11.1
  const patchMatch = /^(\d+\.\d+)\.\d+$/.exec(id);
  if (patchMatch) return patchMatch[1] ?? null;
  // Base release: 1.11
  const baseMatch = /^(\d+\.\d+)$/.exec(id);
  if (baseMatch) return baseMatch[1] ?? null;
  // Pre-release / RC: 1.11-pre1, 1.9.3-pre1
  const preMatch = /^(\d+\.\d+(?:\.\d+)?)-(?:pre|rc)/.exec(id);
  if (preMatch) return preMatch[1] ?? null;
  // Legacy snapshot: <YY>w<WW>[letter] — look up via ISO-week window.
  const snapMatch = /^(\d{2})w(\d{1,2})[a-z]?$/i.exec(id);
  if (snapMatch) {
    const yy = Number(snapMatch[1]);
    const week = Number(snapMatch[2]);
    const year = yy < 50 ? 2000 + yy : 1900 + yy;
    return findReleaseInWeek(year, week);
  }
  return null;
}

/**
 * The release version this entry was published for. Returns null when the id
 * doesn't map to a known release (e.g. a future snapshot naming we haven't
 * catalogued yet).
 *
 * - `1.21.4-pre1`    -> `1.21.4`     (legacy pre-release suffix)
 * - `1.21.4-rc1`     -> `1.21.4`     (legacy RC suffix)
 * - `26.2-pre-1`     -> `26.2`       (post-1.21 pre-release: hyphen before N)
 * - `26.2-rc-1`      -> `26.2`       (post-1.21 RC: hyphen before N)
 * - `26.1-snapshot-1` -> `26.1`      (post-1.21 snapshot)
 * - `23w13a`         -> `1.20`       (legacy snapshot, looked up by ISO week)
 * - `1.21.4`         -> `1.21.4`     (release maps to itself)
 * - `garbage`        -> null
 */
export function targetReleaseOf(id: string): string | null {
  // Pre-release / RC suffix (handles both `1.21.4-pre1` and `26.2-pre-1`).
  const preMatch = /^(.+)-(?:pre|rc)-?\d+$/.exec(id);
  if (preMatch) return preMatch[1] ?? null;

  // Post-1.21 naming: <major>.<minor>-snapshot-<N>.
  const modernMatch = /^(\d+\.\d+)-snapshot-\d+$/.exec(id);
  if (modernMatch) return modernMatch[1] ?? null;

  // Legacy snapshot: <YY>w<WW>[letter].
  const legacyMatch = /^(\d{2})w(\d{1,2})[a-z]$/i.exec(id);
  if (legacyMatch) {
    const yy = Number(legacyMatch[1]);
    const week = Number(legacyMatch[2]);
    const year = yy < 50 ? 2000 + yy : 1900 + yy;
    return findReleaseInWeek(year, week);
  }

  // Base or patch release (e.g. `1.21`, `1.21.4`): the version IS its target.
  if (/^\d+\.\d+/.test(id)) return id;

  return null;
}

function findReleaseInWeek(year: number, week: number): string | null {
  for (const [majorMinor, windows] of Object.entries(legacyMapping)) {
    for (const w of windows) {
      if (w.year === year && week >= w.weekStart && week <= w.weekEnd) {
        return majorMinor;
      }
    }
  }
  return null;
}
