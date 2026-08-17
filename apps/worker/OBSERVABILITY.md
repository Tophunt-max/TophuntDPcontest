# Observability & Error Tracking (Worker)

Ye guide batati hai ke `tophunt-api` worker me errors kaise track karein.

Worker me **pehle se** structured logging hai:
- Har request par ek JSON log line (requestId, method, path, status, ms)
- Har unhandled error par ek JSON error log (requestId, path, message, stack)
- Har response par ek `X-Request-Id` header (correlation ke liye)

Iske upar, **optional Sentry-compatible error forwarding** add kiya gaya hai
(`src/lib/observability.ts`). Ye tabhi active hota hai jab `SENTRY_DSN` set ho —
warna **no-op** rehta hai (kuch nahi tootta).

> **Important:** `SENTRY_DSN` set na karein to bhi app theek chalti hai. Errors
> tab bhi Cloudflare ke built-in **Workers Logs** me dikhte rahenge.

---

## Option A — Cloudflare Workers Logs (0 setup, free) ✅

Kuch karne ki zaroorat nahi. Errors + request logs yahan dekhein:

**Dashboard → Workers & Pages → `tophunt-api` → Logs**

- Real-time errors + requests (JSON structured)
- Free tier ke andar; koi DSN/secret nahi chahiye
- Zyada retention/search chahiye to Logpush se **Axiom** ya **Better Stack**
  (dono ka generous free tier hai) connect kar sakte hain.

Agar sirf itna kaafi hai to neeche kuch karne ki zaroorat nahi.

---

## Option B — GlitchTip (open-source, "free Sentry") ⭐ recommended

GlitchTip **Sentry-compatible** hai — DSN bilkul Sentry jaisa. Hamara code
`SENTRY_DSN` ke saath **as-is** kaam karega (koi code change nahi).

1. Account banayein:
   - **Free hosted:** https://glitchtip.com  → naya organization + project
   - **Ya self-host (100% free):** Docker se apne server par
2. Project → **Settings → Client Keys (DSN)** → DSN copy karein
   (`https://<key>@app.glitchtip.com/<projectId>` jaisा)
3. Neeche **"Secret set karna"** wale steps follow karein.

---

## Option C — Sentry free tier

Sentry ka **Developer plan free** hai (~5,000 errors/month, 1 user, ~30 din
retention; credit card nahi chahiye).

1. https://sentry.io par signup → naya project → platform **Node.js**
2. Project → **Settings → Client Keys (DSN)** → DSN copy karein
3. Neeche wale steps follow karein.

---

## Secret set karna (`SENTRY_DSN`)

> B ya C me se jo bhi DSN mila, use isi tarah set karein. GlitchTip aur Sentry
> dono ka DSN isi `SENTRY_DSN` me jaata hai (format same hai).

### Method 1 — CLI (recommended)

```bash
cd apps/worker

# (ek baar) Cloudflare login
npx wrangler login

# DSN set karo — command chalao, phir DSN paste karke Enter
npx wrangler secret put SENTRY_DSN
```

Ye **live worker par turant** apply hota hai (alag deploy ki zaroorat nahi).

### Method 2 — Cloudflare Dashboard (no CLI)

1. https://dash.cloudflare.com → **Workers & Pages → `tophunt-api`**
2. **Settings → Variables and Secrets**
3. **Add variable** → type **Secret (Encrypt)**
4. Name: `SENTRY_DSN`, Value: apna DSN → **Save / Deploy**

### (Optional) Environment tag

`SENTRY_ENVIRONMENT` sensitive nahi hai, isliye ise `wrangler.toml` ke `[vars]`
me daal sakte hain (secret ki zaroorat nahi):

```toml
[vars]
SENTRY_ENVIRONMENT = "production"
```

Default `production` hai agar set na karein.

---

## Local development

`apps/worker/.dev.vars` me daalein (ye gitignored hoti hai):

```
SENTRY_DSN=https://<key>@app.glitchtip.com/<projectId>
SENTRY_ENVIRONMENT=development
```

Phir `npx wrangler dev` — local errors bhi forward honge.

---

## Verify

1. Secret set karne ke baad koi endpoint jaan-boojh kar error karvayein.
2. Sentry/GlitchTip project me event dikhega — tags ke saath:
   - `requestId` (Cloudflare logs ke `X-Request-Id` se match karega)
   - `path`, `method`
3. Ya Cloudflare **Workers → Logs** me `level: "error"` wali line dekhein.

---

## Kaise kaam karta hai (quick)

- `src/index.ts` → `app.onError(...)` har unhandled error par:
  1. Ek structured JSON error log likhta hai (hamesha)
  2. `captureError(env, err, { requestId, path, method })` ko
     `c.executionCtx.waitUntil(...)` me call karta hai
- `src/lib/observability.ts` → `SENTRY_DSN` parse karke Sentry ke **envelope
  HTTP API** par event POST karta hai — **koi SDK/dependency nahi**.
- **Fail-open:** DSN galat/absent ho ya network fail ho, kabhi throw nahi karta
  aur response ko slow nahi karta.

Config: `SENTRY_DSN`, `SENTRY_ENVIRONMENT` — dono `src/types.ts` ke `Env` me
optional hain.
