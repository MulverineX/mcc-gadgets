import { fetchParsedVersion } from "~/server/java/changelog/parsed";
import { CDN_CACHE, cacheControl } from "~/server/java/changelog/shared/cdn";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ x: string }> },
): Promise<Response> {
  const { x } = await params;
  const parsed = await fetchParsedVersion(x);

  if (!parsed) {
    return new Response(JSON.stringify({ error: "Version not found" }), {
      status: 404,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": cacheControl(CDN_CACHE.versionMiss),
      },
    });
  }

  return Response.json(parsed, {
    headers: {
      "Cache-Control": cacheControl(CDN_CACHE.versionHit),
    },
  });
}