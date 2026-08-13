import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, renameSync, unlinkSync, readdirSync } from "fs";
import { readdir } from "node:fs/promises";
import * as prettier from "prettier";
import { join } from "path";
import * as htmlparser2 from "htmlparser2";

import { loadCachedVersions } from "../src/server/java/changelog/cached";
import { loadJsonVersions } from "../src/server/java/changelog/json";
import { fetchParsedVersion } from "../src/server/java/changelog/parsed";
import { loadRssFeed } from "../src/server/java/changelog/rss";
import { LocalCache } from "../src/server/java/changelog/shared/local-cache";
import {
  deserializeAst,
} from "../src/server/java/changelog/shared/parser";
import {
  buildResolveContext,
  resolveVersion,
  versionToCandidates,
} from "../src/server/java/changelog/shared/resolver";
import { humanReadableTitle } from "../src/server/java/changelog/shared/title";
import type { VersionManifestEntry } from "../src/server/java/changelog/types";

/**
 * End-to-end changelog test suite.
 *
 * Fixture layout under `.temp/test-articles/`:
 *   manifest.json              — cached piston-meta manifest
 *   sitemap.json               — cached minecraft.net sitemap entries
 *   cdx/<hash>.txt             — cached CDX responses (full)
 *   cdx/<hash>.empty.txt       — cached empty CDX responses
 *   cdx-audit.log              — append-only log of every CDX URL attempted
 *   <snapshotName>.html        — cached article HTML
 *   <snapshotName>.html.source — "minecraft.net" | "mojang"
 *   snapshots/<name>.json      — committed parser snapshots
 *
 * The corpus test drives `fetchParsedVersion(version, { cache })` against
 * the fixtures above; no network fetches happen once `.temp/test-articles/`
 * is populated. Regenerate snapshots via `UPDATE_SNAPSHOTS=1 bun test`.
 */

const CACHE_DIR = join(process.cwd(), ".temp", "test-articles");
const SNAPSHOTS_DIR = join(process.cwd(), "tests", "__snapshots__");

interface CorpusEntry {
  version: string;
  /** Filename slug for the cached HTML + JSON snapshot. */
  snapshotName: string;
}

const CORPUS: CorpusEntry[] = [
  { version: "14w05a", snapshotName: "snapshot-14w05a" },
  { version: "14w05b", snapshotName: "snapshot-14w05b" },
  { version: "14w33a", snapshotName: "snapshot-14w33a" },
  { version: "14w33b", snapshotName: "snapshot-14w33b" },
  { version: "14w33c", snapshotName: "snapshot-14w33c" },
  { version: "16w20a", snapshotName: "snapshot-16w20a" },
  { version: "1.10", snapshotName: "1-10" },
  { version: "1.10.1", snapshotName: "1-10-1" },
  { version: "1.10.2", snapshotName: "1-10-2" },
  { version: "1.11", snapshotName: "1-11" },
  { version: "17w06a", snapshotName: "snapshot-17w06a" },
  { version: "1.12-pre6", snapshotName: "1-12-pre-release-6" },
  { version: "20w14infinite", snapshotName: "snapshot-20w14infinite" },
  { version: "21w08a", snapshotName: "snapshot-21w08a"},
  { version: "21w08b", snapshotName: "snapshot-21w08b"},
  { version: "1.19.1-pre3", snapshotName: "1-19-1-pre-release-3" },
  { version: "22w16a", snapshotName: "snapshot-22w16a"},
  // TODO: Bugged, grabbing prose from the A snapshot and missing the "We've now released snapshot 22w16b to fix a crash."
  // { version: "22w16b", snapshotName: "snapshot-22w16b"},
  { version: "26.1-snapshot-1", snapshotName: "26-1-snapshot-1" },
  { version: "26.2-snapshot-3", snapshotName: "26-2-snapshot-3" },
];

/* -------------------------------------------------------------------------- */
/*  Pure-function tests (no fixtures required)                                */
/* -------------------------------------------------------------------------- */

describe("versionToCandidates", () => {
  test("old-format snapshot", () => {
    // exact letter + bare fallback only — decrement + letterless base are
    // handled by cascadeSlug when the sitemap miss fires.
    expect(versionToCandidates("18w22c")).toMatchSnapshot();
  });

  test("new-format snapshot", () => {
    expect(versionToCandidates("26.1-snapshot-1")).toEqual([
      "minecraft-26-1-snapshot-1",
      "minecraft-26-1-snapshot",
    ]);
  });

  test("pre-release", () => {
    expect(versionToCandidates("1.19.3-pre-release-3")).toEqual([
      "minecraft-1193-pre-release-3",
      "minecraft-1193-pre-release",
      "minecraft-1-19-3-pre-release-3",
      "minecraft-1-19-3-pre-release",
    ]);
  });

  test("patch release", () => {
    expect(versionToCandidates("1.20.4")).toContain("minecraft-java-edition-1-20-4");
  });

  test("base release", () => {
    expect(versionToCandidates("1.21")).toEqual(["minecraft-java-edition-1-21"]);
  });
});

describe("humanReadableTitle", () => {
  test("base release", () => {
    expect(humanReadableTitle("1.10")).toBe("Minecraft 1.10");
  });
  test("patch release", () => {
    expect(humanReadableTitle("1.10.2")).toBe("Minecraft 1.10.2");
    expect(humanReadableTitle("1.10.1")).toBe("Minecraft 1.10.1");
  });
  test("pre-release", () => {
    expect(humanReadableTitle("1.12-pre6")).toBe("Minecraft 1.12 Pre-Release 6");
  });
  test("old snapshot", () => {
    expect(humanReadableTitle("17w06a")).toBe("Minecraft Snapshot 17w06a");
  });
  test("new snapshot", () => {
    expect(humanReadableTitle("26.2-snapshot-3")).toBe(
      "Minecraft 26.2 Snapshot 3",
    );
  });
  test("release candidate", () => {
    expect(humanReadableTitle("1.16-rc1")).toBe(
      "Minecraft 1.16 Release Candidate 1",
    );
  });
});

/* -------------------------------------------------------------------------- */
/*  resolveVersion against the real manifest + sitemap                       */
/* -------------------------------------------------------------------------- */

describe("resolveVersion — real manifest + sitemap", () => {
  const cache = new LocalCache(CACHE_DIR, SNAPSHOTS_DIR);
  let manifestEntries: Map<string, VersionManifestEntry>;
  let resolveCtx: ReturnType<typeof buildResolveContext>;

  beforeAll(async () => {
    cache.ensureDirs();
    const [manifest, sitemapMap] = await Promise.all([
      cache.fetchManifest(),
      cache.fetchSitemapMap(),
    ]);
    manifestEntries = new Map(manifest.versions.map((v) => [v.id, v]));
    resolveCtx = buildResolveContext(manifest, sitemapMap);
  });

  function entry(id: string): VersionManifestEntry {
    const e = manifestEntries.get(id);
    if (!e) throw new Error(`manifest missing ${id} — fixture out of date`);
    return e;
  }

  test("1.12 falls back to hardcoded slug", () => {
    const result = resolveVersion(entry("1.12"), resolveCtx);
    expect(result.url).toBe(
      "https://www.minecraft.net/en-us/article/world-color-released",
    );
    expect(result.source).toBe("hardcoded");
  });

  test("april-fools 23w13a_or_b routes to vote-update", () => {
    const result = resolveVersion(entry("23w13a_or_b"), resolveCtx);
    expect(result.slug).toBe("vote-update");
  });

  test("known inaccessible 19w03a returns null URL", () => {
    const result = resolveVersion(entry("19w03a"), resolveCtx);
    expect(result.url).toBeNull();
    expect(result.source).toBe("none");
  });
});

/* -------------------------------------------------------------------------- */
/*  Parser end-to-end with article corpus                                     */
/* -------------------------------------------------------------------------- */

describe("changelog_parser — corpus", () => {
  const cache = new LocalCache(CACHE_DIR, SNAPSHOTS_DIR);

  beforeAll(async () => {
    cache.ensureDirs();
    // Prune CDX cache `.empty.txt` entries that no audit log references.
    // Skip when no audit log exists — first-run setups have no source to
    // protect, so any prune could only delete live cache that's actively
    // serving queries. Real `.txt` captures are kept unconditionally.
    const backups = (await readdir(cache.cacheDir)).filter((f) =>
      /^cdx-audit\.\d+\.log$/.test(f),
    );
    const auditLogs = [
      ...(existsSync(join(cache.cacheDir, "cdx-audit.log"))
        ? ["cdx-audit.log"]
        : []),
      ...backups,
    ];
    if (auditLogs.length > 0) {
      await pruneStaleEmptyCdxEntries(cache.cacheDir, auditLogs);
    }

    // Rotate the previous audit log so it isn't lost on clear, then dedup
    // the resulting set of timestamped backups (drop newer duplicates of
    // older ones). Order matters: rotate first so the freshly-moved file
    // is included in the next run's dedup pass.
    const auditPath = join(cache.cacheDir, "cdx-audit.log");
    if (existsSync(auditPath)) {
      const backupPath = join(cache.cacheDir, `cdx-audit.${Date.now()}.log`);
      try {
        renameSync(auditPath, backupPath);
      } catch {}
    }
    await pruneAuditBackups(join(cache.cacheDir), null);
    // Clear so each test run starts fresh. Use a shell `rm` (which silently
    // no-ops on missing files) instead of `Bun.file().delete()` which throws
    // ENOENT on first run.
    await Bun.$`rm -f ${auditPath}`.quiet();
  });

  // After tests run, prune timestamped backups. We keep at most ONE backup
  // (the most recent one whose fingerprint differs from any older backup —
  // a "diff" snapshot of past state). All other backups are dropped, so
  // 2 identical runs leave only the live log, while a diff run leaves one
  // backup + the live log.
  afterAll(async () => {
    const before = (await readdir(cache.cacheDir)).filter((f) =>
      /^cdx-audit\.\d+\.log$/.test(f),
    );
    console.log(`[afterAll] before prune: ${before.join(",") || "(none)"}`);
    await pruneAuditBackupsKeepLatest(cache.cacheDir);
    const after = (await readdir(cache.cacheDir)).filter((f) =>
      /^cdx-audit\.\d+\.log$/.test(f),
    );
    console.log(`[afterAll] after prune: ${after.join(",") || "(none)"}`);
  });

  for (const entry of CORPUS) {
    test(`parseArticle(${entry.version})`, async () => {
      const t0 = performance.now();

      // Run the same resolver the API does — sitemap → launchercontent → Wayback
      // fallback for legacy versions. `htmlSnapshot` points the HTML fetch at
      // the on-disk fixture (and persists it on miss). `cdxFetch` falls back
      // to the network for legacy CDX queries and persists responses.
      // 5-minute budget: legacy CDX lookups can do 12 sequential Wayback
      // queries at ~15s each on first run; subsequent runs hit the cache.
      const result = await fetchParsedVersion(entry.version, {
        cache,
        htmlSnapshot: entry.snapshotName,
        cdxFetch: cache.cdxFetcher(),
      });
      if (!result) {
        console.warn(`[skip] ${entry.version}: unresolved`);
        return;
      }
      const response = result;

      const existing = cache.readSnapshot<typeof response>(entry.snapshotName);
      if (process.env.UPDATE_SNAPSHOTS === "1" || !existing) {
        cache.writeSnapshot(entry.snapshotName, response);
        console.log(
          `[${entry.version}] wrote snapshot. TOTAL: ${(performance.now() - t0).toFixed(0)}ms`,
        );
        return;
      }

      try {
        expect(response).toEqual(existing);
        console.log(
          `[${entry.version}] snapshot match. TOTAL: ${(performance.now() - t0).toFixed(0)}ms`,
        );
      } catch (e) {
        console.log(
          `[${entry.version}] snapshot MISMATCH. TOTAL: ${(performance.now() - t0).toFixed(0)}ms`,
        );
        throw e;
      }
    }, 5 * 60_000);
  }

  /** Render every corpus body's AST back to HTML, dump to one inspection file. */
  test("export rendered bodies to __rendered.html", async () => {
    const snapshots: Array<{
      version: string;
      heroImage: string | null;
      body: { nodes: unknown[] };
      targetRelease: string | null;
      publishedAt: number | null;
      bugList: { id: string; title: string }[];
      sourceURL: string;
    }> = [];
    for (const entry of CORPUS) {
      const snapshot = cache.readSnapshot<{
        version: string;
        heroImage: string | null;
        body: { nodes: unknown[] };
        targetRelease: string | null;
        publishedAt: number | null;
        bugList: { id: string; title: string }[];
        sourceURL: string;
      }>(entry.snapshotName);
      if (
        !snapshot ||
        (snapshot.body.nodes.length === 0 && snapshot.bugList.length === 0)
      )
        continue;
      snapshots.push(snapshot);
    }
    snapshots.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
    const sections = snapshots.map((snapshot) => {
      const html = deserializeAst(snapshot.body as Parameters<typeof deserializeAst>[0])
        .map((root) => htmlparser2.DomUtils.getOuterHTML(root))
        .join("\n");
      const hero = snapshot.heroImage
        ? `<img class="hero" src="${escapeHtml(snapshot.heroImage)}" alt="">`
        : "";
      const targetLine =
        snapshot.targetRelease && snapshot.targetRelease !== snapshot.version
          ? `Target Version: <code>${escapeHtml(snapshot.targetRelease)}</code>`
          : "";
      const meta =
        `<p class="meta">` +
        (targetLine ? targetLine + " · " : "") +
        (snapshot.publishedAt
          ? `Released <time class="released" data-unix="${snapshot.publishedAt}"></time>`
          : "") +
        `</p>`;
      // TODO: This revealed that the URL resolution broke again, it was hidden by the cached html, we need to fix the 1.10.1/1.10.2 article resolution
      const source = `<p class="source-url">Source: <a href="${snapshot.sourceURL}">${snapshot.sourceURL}</a></p>`
      const bugList = snapshot.bugList?.length
        ? `<h3>Fixed Bugs</h3><ul>${snapshot.bugList
            .map((b) => `<li><a href="https://mojira.dev/${escapeHtml(b.id)}"><code>${escapeHtml(b.id)}</code></a> — ${escapeHtml(b.title)}</li>`)
            .join("")}</ul>`
        : "";
      return `<section>${hero}<h1>${escapeHtml(humanReadableTitle(snapshot.version))}</h1>${meta}${source}${html}${bugList}</section>`;
    });
    const style = `<style>
:root {
  --bg: #1a1a1a;
  --fg: #e6e6e6;
  --muted: #888;
  --border: #333;
  --code-bg: #2a2a2a;
  --link: #8ab4f8;
}
body {
  font-family: "Noto Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  line-height: 1.5;
  background: var(--bg);
  color: var(--fg);
}
a { color: var(--link); }
code { background: var(--code-bg); padding: 0.1em 0.3em; border-radius: 3px; }
img.hero { display: block; max-width: 100%; height: auto; margin: 0 auto 2rem; }
section { margin-bottom: 6rem; padding-bottom: 2rem; border-bottom: 1px solid var(--border); }
section > h1 { margin-top: 0; }
@media (prefers-color-scheme: light) {
  :root {
    --bg: #fff;
    --fg: #222;
    --muted: #666;
    --border: #ccc;
    --code-bg: #f4f4f4;
    --link: #1a73e8;
  }
}
</style>`;
    const script = `<script>
for (const el of document.querySelectorAll("time.released")) {
  const unix = Number(el.dataset.unix);
  if (!unix) continue;
  const d = new Date(unix * 1000);
  el.setAttribute("datetime", d.toISOString());
  el.textContent = new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeStyle: "long" }).format(d);
}
</script>`;
    const doc = `<!doctype html><html><head><meta charset="utf-8"><title>corpus rendered</title>${style}</head><body>${sections.join("\n")}${script}</body></html>`;
    const formatted = await prettier.format(doc, { parser: "html" });
    await Bun.write(join(cache.snapshotsDir, "__rendered.html"), formatted);
  });
});

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Drop redundant cdx-audit backups. Two backups are equivalent if their
 * timestamp-stripped content matches. Within an equivalence class, keep the
 * oldest (smaller msec) and delete newer duplicates.
 *
 * Also drops any backup whose fingerprint matches the supplied `liveLogText`
 * (the current state, captured after tests run). Captured AFTER rotation so
 * it reflects what tests just wrote, not the previous state.
 */
async function pruneAuditBackups(
  cacheDir: string,
  liveLogText: string | null,
): Promise<void> {
  const allFiles = await readdir(cacheDir);
  const backups = allFiles.filter((f) => /^cdx-audit\.\d+\.log$/.test(f));
  if (backups.length === 0) return;

  type Fingerprint = string;
  const fingerprintFor = (text: string): string =>
    text
      .split("\n")
      .map((line) => line.replace(/^\[\d{4}-\d{2}-\d{2}T[\d:.Z]+\]\s+/, ""))
      .filter((line) => line.length > 0)
      .sort()
      .join("\n");

  const re = /cdx-audit\.(\d+)\.log$/;
  // Dedup identical backups, keep oldest.
  const seen = new Map<Fingerprint, string>(); // fingerprint -> oldest file
  for (const f of backups) {
    try {
      const fp = fingerprintFor(readFileSync(join(cacheDir, f), "utf-8"));
      const existing = seen.get(fp);
      if (existing) {
        const exMsec = Number(re.exec(existing)![1]);
        const fMsec = Number(re.exec(f)![1]);
        const drop = exMsec < fMsec ? f : existing;
        const keep = drop === existing ? f : existing;
        seen.set(fp, keep);
        try {
          unlinkSync(join(cacheDir, drop));
        } catch {}
      } else {
        seen.set(fp, f);
      }
    } catch {
      // skip unreadable
    }
  }
  // Drop any backup whose fingerprint matches the supplied `liveLogText`
  // (the current state). Backups with a different fingerprint represent
  // historical states (e.g. a prior code revision) and are kept as evidence.
  if (liveLogText !== null) {
    const liveFp = fingerprintFor(liveLogText);
    console.log(`[prune] live fp length: ${liveFp.length}, sample: ${JSON.stringify(liveFp.slice(0, 80))}`);
    for (const [fp, f] of seen) {
      console.log(`[prune] backup ${f} fp length: ${fp.length}, sample: ${JSON.stringify(fp.slice(0, 80))}, match: ${fp === liveFp}`);
      if (fp === liveFp) {
        try {
          unlinkSync(join(cacheDir, f));
        } catch {}
        seen.delete(fp);
      }
    }
  }
}

/**
 * Drop timestamped cdx-audit backups. A backup is kept only if its query set
 * (CDX hashes it references) contains entries the current CDX cache doesn't
 * already have — i.e. it captured a query that has since been removed from
 * the resolver (a real diff from the current state). Two identical runs
 * collapse to just the live log; a diff run leaves one backup + the live
 * log.
 */
async function pruneAuditBackupsKeepLatest(cacheDir: string): Promise<void> {
  const allFiles = await readdir(cacheDir);
  const backups = allFiles
    .filter((f) => /^cdx-audit\.\d+\.log$/.test(f))
    .sort();
  if (backups.length === 0) return;

  // Current cache hash set: union of all .txt and .empty.txt file names.
  // (A backup's queries are "new" if any hash it references is absent
  // from the current cache.)
  const cacheHashes = new Set<string>();
  for (const f of readdirSync(join(cacheDir, "cdx")) ?? []) {
    const m = /^(.+?)\.(empty\.txt|txt)$/.exec(f);
    if (m?.[1]) cacheHashes.add(m[1]);
  }

  for (const f of backups) {
    let backupHashes: Set<string>;
    try {
      const text = readFileSync(join(cacheDir, f), "utf-8");
      backupHashes = new Set(
        [...text.matchAll(/[0-9a-f]{32}/g)].map((m) => m[0]),
      );
    } catch {
      continue;
    }
    // Keep only if the backup has a query NOT in the current cache (real
    // diff). If every backup hash is already in the cache, drop it.
    let hasUnique = false;
    for (const h of backupHashes) {
      if (!cacheHashes.has(h)) {
        hasUnique = true;
        break;
      }
    }
    if (!hasUnique) {
      try {
        unlinkSync(join(cacheDir, f));
      } catch {}
    }
  }
}

/**
 * Drop CDX cache `.empty.txt` entries that no audit log references. Real
 * `.txt` captures are kept unconditionally.
 *
 * Caller passes in the list of audit log filenames (live + backups). Each
 * line in an audit log has the form `[<isoTimestamp>] <hash> <url>`. We
 * collect every 32-char hash from every log into a "referenced" set. Any
 * `.empty.txt` whose hash isn't in the referenced set is stale (the query
 * no longer fires) and safe to delete.
 *
 * `legacyMapping` and the resolver's query logic are deliberately NOT
 * imported — the audit log itself is the source of truth. The skip-when-
 * no-log guard in `beforeAll` ensures we never run this against an empty
 * source.
 */
async function pruneStaleEmptyCdxEntries(
  cacheDir: string,
  auditLogs: string[],
): Promise<{ kept: number; deleted: number }> {
  const referencedHashes = new Set<string>();
  const re = /^\[\d{4}-\d{2}-\d{2}T[\d:.Z]+\]\s+([0-9a-f]{32})\s/;
  for (const log of auditLogs) {
    try {
      const text = readFileSync(join(cacheDir, log), "utf-8");
      for (const line of text.split("\n")) {
        const m = re.exec(line);
        if (m?.[1]) referencedHashes.add(m[1]);
      }
    } catch {
      // unreadable; skip
    }
  }

  const cdxDir = join(cacheDir, "cdx");
  let kept = 0;
  let deleted = 0;
  for (const f of readdirSync(cdxDir)) {
    const m = /^(.+?)\.(empty\.txt|txt)$/.exec(f);
    if (!m) continue;
    const hash = m[1]!;
    const kind = m[2]!;
    if (kind === "txt") {
      kept++;
      continue;
    }
    if (referencedHashes.has(hash)) {
      kept++;
    } else {
      try {
        await Bun.$`rm -f ${join(cdxDir, f)}`.quiet();
        deleted++;
      } catch {
        // already gone
      }
    }
  }
  return { kept, deleted };
}

/* -------------------------------------------------------------------------- */
/*  Integration: fetchParsedVersion wires LocalCache through the full stack   */
/* -------------------------------------------------------------------------- */

describe("fetchParsedVersion — LocalCache integration", () => {
  const cache = new LocalCache(CACHE_DIR, SNAPSHOTS_DIR);

  beforeAll(() => {
    cache.ensureDirs();
  });

  test("1.10 (mojang source) resolves via Wayback and parses", async () => {
    const result = await fetchParsedVersion("1.10", { cache, htmlSnapshot: "1-10" });
    expect(result).not.toBeNull();
    expect(result!.source).toBe("mojang");
    expect(result!.title).toBe("Minecraft 1.10");
  }, 60_000);

  test("snapshot-17w06a (minecraft.net source) parses directly", async () => {
    const result = await fetchParsedVersion("17w06a", {
      cache,
      htmlSnapshot: "snapshot-17w06a",
    });
    expect(result).not.toBeNull();
    expect(result!.source).toBe("minecraft.net");
    expect(result!.title).toBe("Minecraft Snapshot 17w06a");
  }, 60_000);
});

/* -------------------------------------------------------------------------- */
/*  Bulk endpoints — versions/cached, versions/json, versions/rss            */
/* -------------------------------------------------------------------------- */

describe("bulk endpoints — LocalCache integration", () => {
  const cache = new LocalCache(CACHE_DIR, SNAPSHOTS_DIR);

  beforeAll(() => {
    cache.ensureDirs();
  });

  test("loadCachedVersions returns stubs for unvisited versions", async () => {
    const t0 = performance.now();
    const data = await loadCachedVersions({ cache });
    const elapsed = (performance.now() - t0).toFixed(0);
    console.log(`[test] loadCachedVersions (no visits) took ${elapsed}ms`);
    expect(data.entries.length).toBeGreaterThan(100);
    // No visited set → every entry is a stub with manifest-level info only.
    const sample = data.entries.find((e) => e.version === "1.12");
    expect(sample).toBeDefined();
    expect(sample!.url).toBeNull();
    expect(sample!.source).toBe("none");
    expect(sample!.image).toBeNull();
    expect(sample!.shortText).toBeNull();
    expect(sample!.lastmod).toBeNull();
    expect(sample!.publishedAt).toBeTruthy();
    expect(sample!.rawHtmlUrl).toContain("/raw.html");
  }, 60_000);

  test("loadCachedVersions fills in real data only for visited versions", async () => {
    const t0 = performance.now();
    // Pretend a user has loaded 1.12 and 26.2-snapshot-3 — the bulk endpoint
    // should resolve real data for those and stub the rest.
    const visited = new Set(["1.12", "26.2-snapshot-3"]);
    const data = await loadCachedVersions({ cache, visited });
    const elapsed = (performance.now() - t0).toFixed(0);
    console.log(`[test] loadCachedVersions (2 visits) took ${elapsed}ms`);

    const visited112 = data.entries.find((e) => e.version === "1.12");
    expect(visited112).toBeDefined();
    expect(visited112!.url).toBe(
      "https://www.minecraft.net/en-us/article/world-color-released",
    );
    // Sitemap has the 1.12 entry, so this resolves as "sitemap" not the
    // hardcoded fallback. The hardcoded path only fires when the sitemap
    // actually misses the slug.
    expect(visited112!.source).toBe("sitemap");

    const visitedSnap = data.entries.find((e) => e.version === "26.2-snapshot-3");
    expect(visitedSnap).toBeDefined();
    expect(visitedSnap!.url).toBe(
      "https://www.minecraft.net/en-us/article/minecraft-26-2-snapshot-3",
    );
    expect(visitedSnap!.source).toBe("sitemap");

    // A never-visited version stays a stub.
    const unvisited = data.entries.find((e) => e.version === "1.10");
    expect(unvisited).toBeDefined();
    expect(unvisited!.url).toBeNull();
    expect(unvisited!.source).toBe("none");
  }, 60_000);

  test("loadJsonVersions exposes shape + populates per-version title", async () => {
    const t0 = performance.now();
    const visited = new Set(["1.10", "1.10.1"]);
    const data = await loadJsonVersions({ cache, visited });
    const elapsed = (performance.now() - t0).toFixed(0);
    console.log(`[test] loadJsonVersions took ${elapsed}ms`);
    expect(data.entries.length).toBeGreaterThan(100);
    const sample = data.entries.find((e) => e.version === "1.10");
    expect(sample).toBeDefined();
    expect(sample!.title).toBe("Minecraft 1.10");
    expect(sample!.body).toBeNull();
    expect(sample!.publishedAt).toBeTruthy();
  }, 60_000);

  test("getRssFeed emits <pubDate> for every item", async () => {
    const t0 = performance.now();
    const xml = await loadRssFeed({ cache });
    const elapsed = (performance.now() - t0).toFixed(0);
    console.log(`[test] getRssFeed took ${elapsed}ms`);
    expect(xml).toContain("<rss");
    const items = xml.match(/<item>[\s\S]*?<\/item>/g) ?? [];
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]).toContain("<pubDate>");
    expect(items[0]).toMatch(/<pubDate>[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4}/);
  }, 60_000);
});
