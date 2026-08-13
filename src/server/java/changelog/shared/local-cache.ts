import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";

import { parseManifestJson } from "./schemas";
import { extractSitemapEntries } from "./sitemap";
import type { SitemapEntry, VersionManifestResponse } from "../types";

const MANIFEST_URL =
  "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const SITEMAP_URL = "https://www.minecraft.net/sitemap.xml";

/**
 * On-disk fixture cache for tests.
 *
 * Owns the layout under `cacheDir`:
 *   manifest.json              — cached piston-meta manifest
 *   sitemap.json               — cached sitemap entries
 *   cdx/<hash>.txt             — cached CDX responses (full)
 *   cdx/<hash>.empty.txt       — cached empty CDX responses
 *   cdx-audit.log              — append-only log of every CDX URL attempted
 *   <name>.html                — cached article HTML
 *   <name>.html.source         — "minecraft.net" | "mojang"
 *
 * Snapshots live at `snapshotsDir` (defaults to `<cacheDir>/snapshots`).
 * Tests typically point this at `tests/__snapshots__/` so snapshots are
 * committed alongside the test source while the article HTML corpus stays
 * gitignored under `.temp/`.
 *
 * Each fetch helper follows the same pattern: read the cached file if it
 * exists, otherwise hit the network and write the response to disk. Callers
 * pass a `LocalCache` instance into the API fetcher options; production code
 * that doesn't pass one runs through the real `fetch`.
 */
export class LocalCache {
  readonly cacheDir: string;
  readonly cdxDir: string;
  readonly auditLog: string;
  readonly snapshotsDir: string;

  constructor(cacheDir: string, snapshotsDir?: string) {
    this.cacheDir = cacheDir;
    this.cdxDir = join(cacheDir, "cdx");
    this.auditLog = join(cacheDir, "cdx-audit.log");
    this.snapshotsDir = snapshotsDir ?? join(cacheDir, "snapshots");
  }

  /** Ensure all on-disk directories exist. Safe to call repeatedly. */
  ensureDirs(): void {
    mkdirSync(this.cacheDir, { recursive: true });
    mkdirSync(this.cdxDir, { recursive: true });
    mkdirSync(this.snapshotsDir, { recursive: true });
  }

  async fetchManifest(): Promise<VersionManifestResponse> {
    const file = join(this.cacheDir, "manifest.json");
    if (existsSync(file)) {
      return parseManifestJson(JSON.parse(readFileSync(file, "utf-8")));
    }
    const res = await fetch(MANIFEST_URL);
    if (!res.ok) throw new Error(`manifest fetch failed: ${res.status}`);
    const data = parseManifestJson(await res.json());
    writeFileSync(file, JSON.stringify(data));
    return data;
  }

  async fetchSitemapMap(): Promise<Map<string, SitemapEntry>> {
    const file = join(this.cacheDir, "sitemap.json");
    type Entry = { url: string; slug: string; lastmod?: string };
    let entries: Entry[];
    if (existsSync(file)) {
      entries = JSON.parse(readFileSync(file, "utf-8")) as Entry[];
    } else {
      const res = await fetch(SITEMAP_URL);
      if (!res.ok) throw new Error(`sitemap fetch failed: ${res.status}`);
      const xml = await res.text();
      entries = extractSitemapEntries(xml).map((e) => ({
        url: e.url,
        slug: e.slug,
        lastmod: e.lastmod ?? undefined,
      }));
      writeFileSync(file, JSON.stringify(entries));
    }
    return new Map(
      entries.map((e) => [
        e.slug,
        { url: e.url, slug: e.slug, patternType: "release", lastmod: e.lastmod },
      ]),
    );
  }

  /** Drop-in `(url) => string | null` for `resolveUpstream`'s `cdxFetch`.
   *  Network-fallback enabled: cache miss → fetch from web.archive.org and
   *  persist for next run. Tests use this; production callers can pass
   *  `cdxFetch` explicitly to skip the network. */
  cdxFetcher(): (url: string) => Promise<string | null> {
    return async (url: string) => this.fetchCdxOnline(url);
  }

  async fetchCdxOnline(cdxUrl: string): Promise<string | null> {
    const cached = await this.fetchCdx(cdxUrl);
    if (cached !== null) return cached === "" ? "" : cached;
    try {
      const t0 = performance.now();
      appendFileSync(
        this.auditLog,
        `  → network fetch START at ${new Date().toISOString()}\n`,
      );
      const res = await fetch(cdxUrl, { signal: AbortSignal.timeout(5 * 60_000) });
      const ms = Math.round(performance.now() - t0);
      const text = await res.text();
      appendFileSync(
        this.auditLog,
        `  → network response: ${res.status} (${ms}ms, ${text.length} bytes)\n`,
      );
      if (!res.ok) return null;
      const hash = createHash("sha256").update(cdxUrl).digest("hex").slice(0, 32);
      if (text.length === 0) {
        writeFileSync(join(this.cdxDir, `${hash}.empty.txt`), "");
      } else {
        writeFileSync(join(this.cdxDir, `${hash}.txt`), text);
        appendFileSync(this.auditLog, `  → body: ${text.replace(/\s+/g, " ").trim().slice(0, 120)}\n`);
      }
      return text;
    } catch (e) {
      appendFileSync(this.auditLog, `  → network ERROR: ${String(e)}\n`);
      return null;
    }
  }

  async fetchCdx(cdxUrl: string): Promise<string | null> {
    const hash = createHash("sha256").update(cdxUrl).digest("hex").slice(0, 32);
    const fullFile = join(this.cdxDir, `${hash}.txt`);
    const emptyFile = join(this.cdxDir, `${hash}.empty.txt`);
    appendFileSync(
      this.auditLog,
      `[${new Date().toISOString()}] ${hash}  ${cdxUrl}\n`,
    );
    if (existsSync(fullFile)) {
      appendFileSync(this.auditLog, `  → cache HIT (full)\n`);
      return readFileSync(fullFile, "utf-8");
    }
    if (existsSync(emptyFile)) {
      appendFileSync(this.auditLog, `  → cache HIT (empty)\n`);
      return "";
    }
    // Offline mode: never hit the network. Production's `fetchCdx` (in
    // `cdx-fetch.ts`) handles network + Vercel runtime cache. Anything not
    // pre-populated on disk resolves to `null` so the resolver can move on.
    appendFileSync(this.auditLog, `  → cache MISS (offline)\n`);
    return null;
  }

  /** Read a previously-cached article HTML doc, or null if none on disk. */
  readArticleHtml(
    snapshotName: string,
  ): { html: string; source: "minecraft.net" | "mojang" } | null {
    const htmlFile = join(this.cacheDir, `${snapshotName}.html`);
    if (!existsSync(htmlFile)) return null;
    return {
      html: readFileSync(htmlFile, "utf-8"),
      source: this.readSource(snapshotName),
    };
  }

  /** Fetch an article's HTML and persist it to disk for later `readArticleHtml`. */
  async fetchArticleHtml(
    snapshotName: string,
    url: string,
    defaultSource: "minecraft.net" | "mojang" = "minecraft.net",
  ): Promise<{ html: string; source: "minecraft.net" | "mojang" } | null> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return null;
      const html = await res.text();
      writeFileSync(join(this.cacheDir, `${snapshotName}.html`), html);
      this.writeSource(snapshotName, defaultSource);
      return { html, source: defaultSource };
    } catch {
      return null;
    }
  }

  /** Read a previously-stored source marker (`<name>.html.source`). Defaults to "minecraft.net". */
  readSource(snapshotName: string): "minecraft.net" | "mojang" {
    const metaFile = join(this.cacheDir, `${snapshotName}.html.source`);
    if (!existsSync(metaFile)) return "minecraft.net";
    return readFileSync(metaFile, "utf-8") as "minecraft.net" | "mojang";
  }

  /** Persist the source marker after a fresh fetch. */
  writeSource(
    snapshotName: string,
    source: "minecraft.net" | "mojang",
  ): void {
    writeFileSync(
      join(this.cacheDir, `${snapshotName}.html.source`),
      source,
    );
  }

  /** Read a committed parser snapshot (or null if missing). */
  readSnapshot<T>(snapshotName: string): T | null {
    const file = join(this.snapshotsDir, `${snapshotName}.json`);
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, "utf-8")) as T;
  }

  /** Write (or overwrite) a parser snapshot. */
  writeSnapshot<T>(snapshotName: string, data: T): void {
    writeFileSync(
      join(this.snapshotsDir, `${snapshotName}.json`),
      JSON.stringify(data, null, 2),
    );
  }
}
