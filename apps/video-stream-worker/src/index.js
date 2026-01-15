export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const key = url.pathname.slice(1);

    // 1. Handle Preflight (CORS) - Mandatory for mobile apps
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "Range, Content-Type, Authorization",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405 });
    }

    // 2. Cloudflare Cache API
    const cache = caches.default;
    let cachedResponse = await cache.match(request);
    if (cachedResponse && !request.headers.get("Range")) {
      return cachedResponse;
    }

    // 3. Get Metadata from R2
    const object = await env.VIDEO_BUCKET.head(key);
    if (!object) {
      return new Response("Not Found", { 
        status: 404,
        headers: { "Access-Control-Allow-Origin": "*" } 
      });
    }

    // 4. Handle HTTP Range Requests (Essential for iOS Video)
    const range = request.headers.get("Range");
    let response;

    if (range && (key.endsWith(".mp4") || key.endsWith(".ts") || key.endsWith(".mov"))) {
      const fullSize = object.size;
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fullSize - 1;

      if (isNaN(start) || start >= fullSize || end >= fullSize) {
        return new Response("Range Not Satisfiable", {
          status: 416,
          headers: { 
            "Content-Range": `bytes */${fullSize}`,
            "Access-Control-Allow-Origin": "*"
          }
        });
      }

      const chunk = await env.VIDEO_BUCKET.get(key, {
        range: { offset: start, length: end - start + 1 },
      });

      response = new Response(chunk.body, {
        status: 206,
        headers: {
          "Accept-Ranges": "bytes",
          "Content-Range": `bytes ${start}-${end}/${fullSize}`,
          "Content-Type": object.httpMetadata?.contentType || "video/mp4",
          "Content-Length": (end - start + 1).toString(),
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    } else {
      // 5. Standard serving
      const getObject = await env.VIDEO_BUCKET.get(key);
      if (!getObject) return new Response("Not Found", { status: 404, headers: { "Access-Control-Allow-Origin": "*" } });

      const headers = new Headers();
      getObject.writeHttpMetadata(headers);
      headers.set("etag", getObject.httpEtag);
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Cache-Control", "public, max-age=31536000, immutable");

      if (key.endsWith(".m3u8")) {
        headers.set("Content-Type", "application/x-mpegURL");
      }

      response = new Response(getObject.body, { headers });
    }

    // Cache the response if it's a full request
    if (!range && request.method === "GET") {
      ctx.waitUntil(cache.put(request, response.clone()));
    }

    return response;
  },
};
