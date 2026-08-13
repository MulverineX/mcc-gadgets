`https://mcc-gadgets.com/api/v1/java/changelog/versions/rss` (invalidates every minute)

`https://mcc-gadgets.com/api/v1/java/changelog/versions/json` (invalidates every minute)

`https://mcc-gadgets.com/api/v1/java/changelog/versions/cached` (invalidates every three hours)

`https://mcc-gadgets.com/api/v1/java/changelog/versions/version_manifest` (invalidates every 5 minutes)

`https://mcc-gadgets.com/api/v1/java/changelog/versions/language_masters` (invalidates every minute)

`https://mcc-gadgets.com/api/v1/java/changelog/version/x/raw.html` (indefinite cache unless invalidated externally, 1 minute cache if it gets a 404)

The `language_masters` endpoint will only be called by the `/version/x/raw.html` endpoint if the `version_manifest` endpoint has the version listed

The `versions/json` endpoint will only call the `/version/x/raw.html` endpoint if the `/versions/cached` does not contain a version that is listed at the `version_manifest` endpoint

The `/versions/cached` endpoint will use the launcher content API to get image URLs and short text, and will use the sitemap route and heuristics to get all of the article URLs

The RSS endpoint will just use the `/versions/json` endpoint

`/versions/cached` will invalidate the cache of an html route if the minecraft.net sitemap contains a recent update timestamp and the html route `age` is older



Resources:
- https://vercel.com/docs/cdn-cache
- https://vercel.com/docs/caching/runtime-cache