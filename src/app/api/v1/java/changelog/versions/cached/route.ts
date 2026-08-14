import { getCachedVersions } from "~/server/java/changelog/cached";
import { cacheControl, CDN_CACHE } from "~/server/java/changelog/shared/cdn";

export async function GET(): Promise<Response> {
  const data = await getCachedVersions();
  return Response.json(data, {
    headers: {
      "Cache-Control": cacheControl(CDN_CACHE.cached),
    },
  });
}
