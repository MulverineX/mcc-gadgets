import { getVersionManifest } from "~/server/java/changelog/manifest";
import { CDN_CACHE, cacheControl } from "~/server/java/changelog/shared/cdn";

export async function GET(): Promise<Response> {
  const manifest = await getVersionManifest();
  return Response.json(manifest, {
    headers: {
      "Cache-Control": cacheControl(CDN_CACHE.versionManifest),
    },
  });
}