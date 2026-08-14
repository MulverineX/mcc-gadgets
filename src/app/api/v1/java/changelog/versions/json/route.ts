import { getJsonVersions } from "~/server/java/changelog/json";
import { cacheControl, CDN_CACHE } from "~/server/java/changelog/shared/cdn";

export async function GET(): Promise<Response> {
  const data = await getJsonVersions();
  return Response.json(data, {
    headers: {
      "Cache-Control": cacheControl(CDN_CACHE.json),
    },
  });
}
