import * as htmlparser2 from "htmlparser2";

import { cache as unstableCache } from "~/lib/fetch";

import type { LocalCache } from "./shared/local-cache";
import { deserializeAst, type SerializedAST } from "./shared/parser";
import { loadJsonVersions } from "./json";

export interface RssOptions {
  /** When provided, every underlying fetcher goes through this cache. */
  cache?: LocalCache;
  /** Pre-populated visited set; passed through to `loadJsonVersions`. */
  visited?: Set<string>;
}

/**
 * `versions/rss` — wraps `versions/json` as an RSS 2.0 feed (PLAN §versions/rss).
 * Each entry exposes title, link, pubDate, description, and an image
 * enclosure when the source provided one.
 */
export const getRssFeed = unstableCache(
  async (_options: RssOptions = {}): Promise<string> => {
    return loadRssFeed(_options);
  },
  ["java", "changelog", "rss"],
  { revalidate: 60 /* 1 min */ },
);

/** Unwrapped body of `getRssFeed` — testable with `{ cache }` without going through the Next.js `unstable_cache` key serialization. */
export async function loadRssFeed(
  options: RssOptions = {},
): Promise<string> {
  const json = await loadJsonVersions(options);
  return renderRss(json.entries);
}

function renderRss(
  entries: Array<{
    title: string | null;
    body: SerializedAST | null;
    url: string | null;
    image: string | null;
    shortText: string | null;
    version: string;
    publishedAt: number;
  }>,
): string {
  const items = entries
    .map((e) => renderItem({ ...e, title: e.title ?? e.version }))
    .join("\n");

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<rss version="2.0">`,
    `  <channel>`,
    `    <title>Minecraft Java Edition — Patch Notes</title>`,
    `    <link>https://www.minecraft.net/en-us/article</link>`,
    `    <description>Changelog feed for Minecraft Java Edition releases.</description>`,
    items,
    `  </channel>`,
    `</rss>`,
  ].join("\n");
}

function renderItem(entry: {
  title: string;
  body: SerializedAST | null;
  shortText: string | null;
  url: string | null;
  image: string | null;
  version: string;
  publishedAt: number;
}): string {
  const description = entry.shortText ?? stripHtml(astToHtml(entry.body)).substring(0, 280);
  const link = entry.url ?? `https://www.minecraft.net/en-us/article`;
  return [
    `    <item>`,
    `      <title>${escapeXml(entry.title)}</title>`,
    `      <link>${escapeXml(link)}</link>`,
    `      <guid isPermaLink="false">${escapeXml(entry.version)}</guid>`,
    `      <pubDate>${escapeXml(toRfc822(entry.publishedAt))}</pubDate>`,
    `      <description>${escapeXml(description)}</description>`,
    entry.image
      ? `      <enclosure url="${escapeXml(entry.image)}" type="image/png" />`
      : "",
    `    </item>`,
  ]
    .filter(Boolean)
    .join("\n");
}

function toRfc822(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toUTCString();
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** Reconstruct HTML from a serialized AST fragment. Returns "" for null/empty. */
function astToHtml(ast: SerializedAST | null): string {
  if (!ast || ast.nodes.length === 0) return "";
  return deserializeAst(ast)
    .map((root) => htmlparser2.DomUtils.getOuterHTML(root))
    .join("");
}
