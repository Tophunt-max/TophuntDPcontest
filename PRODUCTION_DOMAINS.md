# Production Domain Migration Checklist

Yeh file batati hai ki jab production custom domains banao, to **kahan-kahan** URL/domain
change karne padenge — code, config, Cloudflare dashboard, Firebase console — sab ek jagah.

> **Aaj ki state (2026-08-24):** sab kuch Cloudflare ke default `*.workers.dev` /
> `*.pages.dev` domains par chal raha hai. Koi custom domain abhi connect **nahi** hua.
> Media bhi abhi Worker se proxy ho raha hai (`<worker>/media`), R2 custom domain se nahi.

---

## 1. Domain plan (decided)

| Role | Abhi (current) | Production (target) |
|------|----------------|---------------------|
| **User web app** (Expo web) | `https://tophuntdpcontest-89t.pages.dev` | **`https://tophunt.in`** (apex — koi `app.` prefix nahi) |
| **Admin panel** | `https://tophunt-admin-panel.pages.dev` | **`https://admin.tophunt.in`** |
| **Backend API** (Worker) | `https://tophunt-api.weadown-in.workers.dev` | **`https://api.tophunt.in`** |
| **Media / R2 public** | `https://tophunt-api.weadown-in.workers.dev/media` | **`https://media.tophunt.in`** |
| **Email "from"** | `no-reply@tophuntdpcontest.com` | **`no-reply@tophunt.in`** |
| **Firebase auth domain** | `tophuntdpcontest.firebaseapp.com` | same (custom optional) |

Do baatein dhyan me rakhiye:

- **User app apex par hai** (`tophunt.in`, `app.tophunt.in` nahi). Cloudflare Pages apex
  domain support karta hai (CNAME flattening automatic hai jab zone Cloudflare par ho).
- **SEO layer already `tophunt.in` maan kar likha gaya hai** —
  `apps/expo/seo/worker.js:28` ka `DEFAULT_SITE_ORIGIN` pehle se `https://tophunt.in` hai,
  aur blog canonical policy bhi isi ko "this site" maanti hai. Yahan kuch badalna nahi.

---

## 2. Code / config changes (git me commit hoti hain)

### A) Backend API URL → `api.tophunt.in`
`https://tophunt-api.weadown-in.workers.dev` ko har jagah replace karo:

| File | Line | Kya hai |
|------|------|---------|
| `apps/expo/.env` | `EXPO_PUBLIC_API_URL=` | Local build runtime — **git-ignored**, alag se update karo |
| `apps/expo/.env.example` | 2 | Reference |
| `apps/expo/eas.json` | 15, 22 | Mobile build profiles (preview + production) |
| `apps/expo/src/services/api.ts` | 17 | `FALLBACK_API_URL` (env na mile to yahi) |
| `apps/expo/seo/worker.js` | 27 | `DEFAULT_API_BASE` — SEO worker sitemap/meta API se laata hai |
| `apps/admin-panel/.env.production` | 6 | `VITE_API_URL` |
| `apps/admin-panel/.env.example` | 5 | Reference |
| `apps/admin-panel/vite.config.ts` | 10 | `WORKER_URL` fallback (dev proxy + `define` dono isi se) |
| `apps/admin-panel/scripts/README.md` | 12 | CLI example (minor) |
| `apps/admin-panel/scripts/lib/worker.mjs` | 6 | Comment (minor) |

### B) Media public base → `media.tophunt.in`
| File | Line | Abhi | Production |
|------|------|------|-----------|
| `apps/worker/wrangler.toml` | **102** | `https://tophunt-api.weadown-in.workers.dev/media` | `https://media.tophunt.in` |
| `apps/worker/wrangler.toml` | **116** | `MEDIA_TRANSFORMATIONS = "false"` | `"true"` |

Media migration alag se poora likha hai — **§9 padhna zaroori hai**, usme ek code fix hai
jo DNS switch se **pehle** jaana chahiye.

### C) CORS allowed origins
| File | Line | Abhi | Production |
|------|------|------|-----------|
| `apps/worker/wrangler.toml` | **138** | `https://tophuntdpcontest-89t.pages.dev,https://tophunt-admin-panel.pages.dev,https://app.tophuntdpcontest.com,https://admin.tophuntdpcontest.com` | `https://tophunt.in,https://admin.tophunt.in` |

> Abhi jo `tophuntdpcontest.com` origins pade hain wo is plan me **galat** hain — hata dena.
> Cutover ke dauran temporarily purane `*.pages.dev` origins bhi rakh sakte ho, phir hata do.
> Exact-origin match hai, wildcard nahi. Native builds Origin header bhejte hi nahi, to iska
> asar sirf web + admin par hota hai.

### D) Email "from"
| File | Line | Kya hai |
|------|------|---------|
| `apps/worker/src/lib/email.ts` | 23 | Fallback `TopHunt <no-reply@tophuntdpcontest.com>` → `no-reply@tophunt.in`, ya `EMAIL_FROM` secret set karo |

`tophunt.in` par email bhejne ke liye SPF/DKIM records bhi chahiye honge.

### E) Admin panel deploy target (agar Pages project rename karo)
| File | Kya hai |
|------|---------|
| `apps/admin-panel/package.json` | `deploy` script → `--project-name tophunt-admin-panel` |

> **Note:** `.github/workflows/web-production.yml` **exist nahi karta** — repo me sirf
> `ci.yml` hai (typecheck + tests + build, deploy nahi). Web deploy abhi manual hai (§6).

---

## 3. Cloudflare dashboard (DNS + custom domains)

Pehle `tophunt.in` zone Cloudflare par add + nameservers point karo.

### A) User web app → `tophunt.in` (apex)
- Pages project `tophuntdpcontest` → **Custom domains → Set up a custom domain** → `tophunt.in`
- Apex ke liye Cloudflare khud CNAME flattening kar deta hai.
- `www.tophunt.in` ka redirect chahiye to ek Redirect Rule bana lo.

### B) Admin panel → `admin.tophunt.in`
- Pages project `tophunt-admin-panel` → **Custom domains** → `admin.tophunt.in`

### C) Worker API → `api.tophunt.in`
- Worker `tophunt-api` → **Settings → Domains & Routes → Add Custom Domain** → `api.tophunt.in`
- Ya `wrangler.toml` me:
  ```toml
  routes = [{ pattern = "api.tophunt.in", custom_domain = true }]
  ```

### D) R2 bucket → `media.tophunt.in`
- R2 → bucket `tophunt-media` → **Settings → Public access → Custom Domains** → `media.tophunt.in`
- Ye **§9 ke saath** karo, akela nahi.

### E) Transformations (image resizing) — media domain ke baad
- Zone `tophunt.in` → **Speed → Optimization → Transformations** → enable
- ⚠️ Apne plan ka quota/pricing dashboard me confirm karo — free monthly limit ke baad
  per-transformation billing hota hai.

---

## 4. Firebase console

- **Authentication → Settings → Authorized domains** me add karo:
  - `tophunt.in`
  - `admin.tophunt.in`
- Warna in domains par login/OTP block ho jaayega.
- `authDomain` same reh sakta hai.

---

## 5. Chhoti consistency fix (abhi bhi kar sakte ho)

- **Storage bucket mismatch:** `apps/admin-panel/.env.example:11` me
  `tophuntdpcontest.appspot.com` hai, `.env.production:11` me
  `tophuntdpcontest.firebasestorage.app`. Dono ko `firebasestorage.app` karo.

---

## 6. Change ke baad rebuild + redeploy

```bash
# Worker (API URL / CORS / media var change hone par)
cd apps/worker
npx wrangler deploy

# Admin panel
cd apps/admin-panel
npm run build && npx wrangler pages deploy dist --project-name tophunt-admin-panel --branch main

# Expo web  (IMPORTANT: `npm run build`, bare `expo export` NAHI — warna
# dist/_worker.js install nahi hoga aur SEO edge layer deploy nahi hogi, §8)
cd apps/expo
npm run build
npx wrangler pages deploy dist --project-name tophuntdpcontest --branch main

# Expo mobile (eas.json env change hone par)
cd apps/expo
npx eas update --branch production
```

**Order matters:** Worker pehle (naya API domain live ho), phir clients.

---

## 7. Quick summary

**4 custom domains:**

1. `tophunt.in` → Expo web (user app, apex)
2. `admin.tophunt.in` → Admin panel
3. `api.tophunt.in` → Worker
4. `media.tophunt.in` → R2 media bucket

Har ek: (a) code/config me URL update, (b) Cloudflare me custom domain connect,
(c) rebuild + redeploy. `tophunt.in` + `admin.tophunt.in` ko Firebase authorized
domains me bhi daalo.

---

## 8. Blog SEO — Cloudflare Pages edge Worker

Blog ka SEO **edge par** handle hota hai. User web app client-side Expo SPA hai
(`app.json` → `web.output = "single"`), to crawler ko default me khaali HTML shell milta
tha. Fix: Pages **"advanced mode" `_worker.js`** jo blog URLs ka HTML head rewrite karta
hai + `sitemap.xml` / `robots.txt` serve karta hai.

| File | Kaam |
|------|------|
| `apps/expo/seo/worker.js` | Per-post `<title>`, meta description, canonical, Open Graph, Twitter Card, JSON-LD `Article`, `<noscript>` content. Plus `/robots.txt` aur dynamic `/sitemap.xml`. |
| `apps/expo/scripts/build-seo-worker.mjs` | Export ke baad `seo/worker.js` → `dist/_worker.js` copy. |
| `apps/expo/package.json` | `build` = `expo export -p web && node scripts/build-seo-worker.mjs` |
| `apps/expo/src/lib/webSeo.ts` | Client-side title/meta update (web-only) |

- **Hamesha `npm run build`** — bare `expo export` se `_worker.js` install nahi hoga.
- Advanced mode me `_redirects` ignore hota hai — SPA fallback Worker khud karta hai.

### Pages env vars (Production)
| Var | Default | Kab set karo |
|-----|---------|--------------|
| `SEO_SITE_ORIGIN` | `https://tophunt.in` | Already sahi — chhod do |
| `SEO_API_BASE` | `https://tophunt-api.weadown-in.workers.dev` | **`https://api.tophunt.in`** karo (ya `seo/worker.js:27` me default badlo) |

### Deploy ke baad — Google Search Console (one-time)
1. `https://tophunt.in` property add + verify (DNS TXT ya HTML tag).
2. **Sitemaps** → `https://tophunt.in/sitemap.xml` submit.
3. Kuch important posts ka **URL Inspection → Request indexing**.
4. Verify: `robots.txt` khule aur sitemap line dikhe; `sitemap.xml` me saare post URLs;
   `view-source:` me sahi `<title>` + `description` + `og:*` + JSON-LD;
   [Rich Results Test](https://search.google.com/test/rich-results) Article pass kare.

### Canonical policy
Imported posts ka `canonicalUrl` = original tophunt.in permalink. Worker: canonical isi
site par ho to usi ko rakhta hai, warna current path par self-canonical. Isse `/blog/<slug>`
aur root `/<slug>` ka duplicate content resolve ho jaata hai.

---

## 9. Media migration (R2) — ise dhyan se padho

Ye section baaki sab se alag hai kyunki **isme ek code fix DNS se pehle chahiye**, warna
R2 me chup-chaap orphaned objects jama honge.

### Abhi kya ho raha hai
Commit `98888b7` ne jaan-boojh kar media ko Worker proxy par daala tha
("no custom domain needed"), taaki bina domain ke deploy ho sake:

```toml
R2_PUBLIC_BASE_URL = "https://tophunt-api.weadown-in.workers.dev/media"
```

Iski teen keematein hain (details: `D1_R2_LOAD_AUDIT.md` §9-11):
1. **Har image ek Worker invocation** hai. Edge cache R2 ops bachata hai, Worker requests nahi.
2. **Thumbnails full-size originals hain.** `MEDIA_TRANSFORMATIONS` `.workers.dev` par enable
   hi nahi ho sakta (`lib/media.ts:47-57`: zone root chahiye, path prefix nahi chalega), to
   `thumbUrl()` / `optimizedUrl()` original URL return karte hain.
3. **Video edge cache bypass karta hai.** `BUNNY_CDN_HOSTNAME=""` hai to video R2 se aata
   hai, aur `index.ts:152` ranged requests ko cache se bahar rakhta hai (sahi hi hai — 206
   ko full-URL key par store karna cache poison karega). Players hamesha Range use karte
   hain → **har seek ek uncached R2 GET**.

### ⚠️ Step 1 — Code fix, DNS se PEHLE

Media URLs D1 me **absolute** store hote hain (`lib/r2.ts:113-117`), to domain badalne par
purane rows purana host rakhenge. Wo **khulte rahenge** (Worker `/media/*` route rahega),
par **delete tootega**:

```ts
// lib/r2.ts:158-170  deleteByPublicUrl
let key = publicUrl.startsWith(base)
  ? publicUrl.slice(base.length + 1)                 // naya host → sahi key
  : new URL(publicUrl).pathname.replace(/^\//, "");  // purana host → "media/stories/..." ← GALAT
```

Purani URL par key `media/stories/images/x.jpg` banegi, asli key `stories/images/x.jpg` hai
→ delete miss → orphaned R2 objects. Aur `contestBannerKeyFromPublicUrl` (`lib/r2.ts:124-146`)
strict host compare karta hai → **purane banners kabhi delete nahi honge**.

**Fix:** ek `R2_LEGACY_BASE_URLS` var add karo aur `deleteByPublicUrl` +
`contestBannerKeyFromPublicUrl` dono base accept karein.

### Step 2 — R2 custom domain
§3D. `media.tophunt.in` → bucket `tophunt-media`.

### Step 3 — Config
```toml
R2_PUBLIC_BASE_URL  = "https://media.tophunt.in"
R2_LEGACY_BASE_URLS = "https://tophunt-api.weadown-in.workers.dev/media"
MEDIA_TRANSFORMATIONS = "true"
```
`https://media.tophunt.in` `transformationsAvailable()` ki teeno condition pass karta hai:
`.workers.dev` nahi, path prefix nahi, var `"true"`.

> **`/media/*` route kabhi mat hataana** — purane rows usi par depend karte hain.

### Step 4 — Backfill (purane URLs naye domain par)
Iske bina purana media Worker-proxied rahega aur Transformations nahi milega.

**Plain columns:**

| Table | Column |
|---|---|
| `users` | `profile_image_url` |
| `contests` | `banner_url` |
| `posts` | `media_url` |
| `stories` | `avatar_url`, `media_url` |
| `highlights` | `cover_image_url` |
| `notifications` | `image` |
| `blog_posts` | `cover_image_url` |
| `deposits` | `screenshot_url` |
| `videos` | `thumbnail_url`, `playback_url`, `mp4_url`, `r2_source_url` |
| `scheduled_notifications` | `image` |
| `broadcast_jobs` | `image` |

**JSON ke andar (miss karna aasan hai):**

| Table / row | Kahan |
|---|---|
| `contest_matches` | `user_a` / `user_b` JSON — **feed ka saara media yahin hai** |
| `chats` | `users_data` → `[{ photoURL }]` |
| `settings` (`id='appConfig'`) | `paymentGateway.qrImageUrl` — payment QR |

JSON walon me bhi URL literal text hai, to SQLite `replace()` chalega. Ek idempotent
migration me kar sakte ho.

### Step 5 — Transformations enable
§3E.

### Step 6 — Verify
```bash
# naya domain khulta hai?
curl -I https://media.tophunt.in/<koi-existing-key>

# thumb ab resized variant hai? (cdn-cgi path dikhna chahiye, original nahi)
curl -s "https://api.tophunt.in/read/users/<uid>" | grep -o 'profileImageUrlThumb[^,]*'
```

**Client release ki zaroorat nahi** — `lib/media.ts` isi liye aise likha gaya hai ki var
flip karne se variants live ho jaayen.

### Video ka poora fix
Custom domain se ranged requests CDN par chale jaayenge. Par R2 se video hataana behtar
hai — Bunny Stream cutover `MEDIA_MIGRATION_PLAN.md` me planned hai
(`BUNNY_CDN_HOSTNAME` + secrets set karne par enable ho jaata hai).

---

## 10. Cutover checklist

- [ ] `tophunt.in` zone Cloudflare par, nameservers pointed
- [ ] §9 Step 1 ka code fix merge (legacy base support)
- [ ] `api.tophunt.in` → Worker custom domain
- [ ] `media.tophunt.in` → R2 custom domain
- [ ] `wrangler.toml`: API/media/CORS vars + `MEDIA_TRANSFORMATIONS="true"`
- [ ] Worker deploy
- [ ] §9 Step 4 backfill migration chalao (JSON columns bhi)
- [ ] Zone par Transformations enable
- [ ] `tophunt.in` → Pages custom domain (apex)
- [ ] `admin.tophunt.in` → Pages custom domain
- [ ] Client configs (`eas.json`, `api.ts:17`, `seo/worker.js:27`, admin `.env.production`)
- [ ] Firebase authorized domains: `tophunt.in`, `admin.tophunt.in`
- [ ] Admin + Expo web rebuild & deploy, `eas update`
- [ ] Email: `EMAIL_FROM` secret + SPF/DKIM for `tophunt.in`
- [ ] Search Console: property, sitemap, indexing (§8)
- [ ] Purane `*.pages.dev` origins `ALLOWED_ORIGINS` se hatao
