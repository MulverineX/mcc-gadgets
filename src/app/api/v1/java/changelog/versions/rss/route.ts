import { getRssFeed } from "~/server/java/changelog/rss";
import { CDN_CACHE, cacheControl } from "~/server/java/changelog/shared/cdn";

export async function GET(): Promise<Response> {
  const xml = await getRssFeed();
  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": cacheControl(CDN_CACHE.rss),
    },
  });
}