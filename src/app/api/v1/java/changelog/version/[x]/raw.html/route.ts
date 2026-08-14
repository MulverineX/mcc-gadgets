import { fetchRawHtml } from "~/server/java/changelog/raw";
import { cacheControl, CDN_CACHE } from "~/server/java/changelog/shared/cdn";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ x: string }> },
): Promise<Response> {
  const { x } = await params;
  const result = await fetchRawHtml(x);

  if (!result) {
    return new Response("Not found", {
      status: 404,
      headers: { "Cache-Control": cacheControl(CDN_CACHE.versionMiss) },
    });
  }

  return new Response(result.body, {
    status: 200,
    headers: {
      "Content-Type": result.contentType,
      "Cache-Control": cacheControl(CDN_CACHE.versionHit),
    },
  });
}
