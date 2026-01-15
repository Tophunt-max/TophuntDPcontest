/**
 * Cloudflare Worker – Unified Upload (upload.tophunt.in)
 * This worker is responsible for uploading files only.
 * Viewing/Streaming is handled by stream.tophunt.in
 */

const ALLOWED_ORIGINS = "*";
// We use the streaming domain for returning media URLs
const PUBLIC_DOMAIN = "https://stream.tophunt.in";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": ALLOWED_ORIGINS,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Accept, userId, type, size, chatId, Authorization",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // --- NEW: CALLS API PROXY ---
    if (url.pathname.startsWith("/calls/")) {
      return handleCallsProxy(request, env);
    }

    // 2. UPLOAD ROUTES (POST ONLY)
    if (request.method === "POST") {
      if (url.pathname === "/upload") {
        return handleGeneralUpload(request, env);
      }
      if (url.pathname === "/upload-status") {
        return handleStatusUpload(request, env);
      }
      // --- NEW: CHAT MEDIA UPLOAD ---
      if (url.pathname === "/upload-message-media") {
        return handleMessageMediaUpload(request, env);
      }
    }

    // 3. Fallback for GET
    if (request.method === "GET") {
      const key = url.pathname.slice(1);
      if (!key) return new Response("Not Found", { status: 404 });

      const object = await env.MEDIA_BUCKET.get(key);
      if (!object) return new Response("Not Found", { status: 404 });

      return new Response(object.body, {
        headers: {
          "Content-Type": object.httpMetadata?.contentType || "application/octet-stream",
          "Cache-Control": "public, max-age=31536000, immutable",
          "Access-Control-Allow-Origin": ALLOWED_ORIGINS,
          "X-Worker-Source": "upload-worker-fallback"
        },
      });
    }

    return new Response("Method Not Allowed", { status: 405 });
  },
};

// ======================================================
// NEW: CHAT MEDIA UPLOAD (Voice Notes / Video Messages)
// ======================================================
async function handleMessageMediaUpload(request, env) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    const userId = formData.get("userId");
    const chatId = formData.get("chatId");
    const type = formData.get("type"); // voice_note | video_message | image

    if (!file || !userId || !chatId || !type) {
      return json({ success: false, error: "Missing required fields" }, 400);
    }

    const uuid = crypto.randomUUID();
    let extension = "bin";
    if (type === "voice_note") extension = "m4a";
    else if (type === "video_message") extension = "mp4";
    else if (type === "image") extension = "jpg";

    const key = `messages/${chatId}/${userId}/${uuid}.${extension}`;

    await env.MEDIA_BUCKET.put(key, file.stream(), {
      httpMetadata: {
        contentType: file.type || "application/octet-stream",
        cacheControl: "public, max-age=31536000, immutable",
      },
      customMetadata: { userId, chatId, type },
    });

    return json({ success: true, url: `${PUBLIC_DOMAIN}/${key}`, key });
  } catch (err) {
    return json({ success: false, error: err.message }, 500);
  }
}

// ======================================================
// NEW: CALLS PROXY (WebRTC Signaling)
// ======================================================
async function handleCallsProxy(request, env) {
  const url = new URL(request.url);
  const appId = env.CLOUDFLARE_CALLS_APP_ID;
  const apiToken = env.CLOUDFLARE_CALLS_TOKEN;

  if (!appId || !apiToken) {
    return json({ success: false, error: "Cloudflare Calls not configured in Worker" }, 500);
  }

  const subPath = url.pathname.replace("/calls/", "");
  const cloudflareApiUrl = `https://rtc.cloudflare.com/v1/apps/${appId}/${subPath}`;

  const response = await fetch(cloudflareApiUrl, {
    method: request.method,
    headers: {
      "Authorization": `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: request.method !== "GET" ? await request.text() : null,
  });

  const data = await response.json();
  return json(data, response.status);
}

// ======================================================
// GENERAL IMAGE UPLOAD (DP / PROFILE / ETC) - PRESERVED
// ======================================================
async function handleGeneralUpload(request, env) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    const userId = formData.get("userId");
    const type = formData.get("type") || "general"; 
    const size = formData.get("size") || "original";

    if (!file || !userId) {
      return json({ success: false, error: "Missing file or userId" }, 400);
    }

    let key;
    const extension = file.name ? file.name.split('.').pop() : (file.type ? file.type.split('/')[1] : 'jpg');
    
    if (userId === "admin") {
      const uuid = crypto.randomUUID();
      key = `admin/${type}/${uuid}.${extension}`;
    } else {
      key = `${type}/${userId}/${size}.jpg`;
    }

    await env.MEDIA_BUCKET.put(key, file.stream(), {
      httpMetadata: {
        contentType: file.type || "image/jpeg",
        cacheControl: "public, max-age=31536000, immutable",
      },
    });

    return json({ success: true, key, url: `${PUBLIC_DOMAIN}/${key}` });
  } catch (err) {
    return json({ success: false, error: err.message }, 500);
  }
}

// ======================================================
// UNIFIED STORY UPLOAD - PRESERVED
// ======================================================
async function handleStatusUpload(request, env) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    const userId = formData.get("userId");
    const type = formData.get("type"); 

    if (!file || !userId) {
      return json({ success: false, error: "Missing required fields" }, 400);
    }

    const isPhoto = type === "status_photo" || file.type.startsWith('image/');
    const maxSize = isPhoto ? 10 * 1024 * 1024 : 30 * 1024 * 1024;

    if (file.size > maxSize) {
      return json({ success: false, error: `File too large` }, 400);
    }

    const uuid = crypto.randomUUID();
    const extension = isPhoto ? "webp" : "mp4";
    const objectKey = `stories/${userId}/${uuid}.${extension}`;

    await env.MEDIA_BUCKET.put(objectKey, file.stream(), {
      httpMetadata: {
        contentType: file.type || (isPhoto ? "image/webp" : "video/mp4"),
        cacheControl: "public, max-age=31536000, immutable",
      },
    });

    return json({
      success: true,
      statusId: uuid,
      mediaUrl: `${PUBLIC_DOMAIN}/${objectKey}`,
      type: isPhoto ? "photo" : "video",
      objectKey,
    });
  } catch (err) {
    return json({ success: false, error: err.message }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS,
    },
  });
}
