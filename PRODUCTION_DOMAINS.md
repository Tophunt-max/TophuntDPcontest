# Production Domains — cutover runbook

**Code side ab ho gaya hai.** Ye file batati hai (a) code me kya-kya badla, aur
(b) Cloudflare / Firebase / app-store side par kya karna **baaki** hai. Jo cheezein
sirf dashboard se hoti hain, wo yahan checklist me hain — kyunki unhe koi deploy
verify nahi kar sakta.

> **Isse pehle ye file ek plan thi ("kya-kya badalna padega").** Ab wo saara code
> change merge ho chuka hai, to ye ek **runbook** hai. Purane "abhi kahan hai"
> table ko jaan-boojh kar hataya gaya hai: repo me do jagah "current state" likha
> ho to ek purani ho jaati hai, aur galat wali par bharosa kar liya jaata hai.

---

## 1. Domain plan (final)

| Role | Production domain | Kaun serve karta hai |
|------|-------------------|----------------------|
| **User web app** (Expo web) | `https://tophunt.in` (apex) | Cloudflare Pages `tophuntdpcontest` |
| **Admin panel** | `https://admin.tophunt.in` | Cloudflare Pages `tophunt-admin-panel` |
| **Backend API** (Worker) | `https://api.tophunt.in` | Worker `tophunt-api` |
| **Media / R2 public** | `https://media.tophunt.in` | R2 bucket `tophunt-media` |
| **Email "from"** | `no-reply@tophunt.in` | Resend / Brevo |

Do baatein jo aage har jagah maayne rakhti hain:

- **User app apex par hai** — `app.tophunt.in` naam ka koi host **nahi** hai.
  App links / deep links se `app.tophunt.in` hata diya gaya hai; agar wo kahin
  wapas dikhe to wo galti hai.
- **Media ab R2 ke apne domain se aata hai, Worker se nahi.** Isse per-image
  Worker invocation khatam, video ki ranged requests CDN par, aur Transformations
  possible ho jaate hain. Worker ka `/media/*` route **phir bhi rehta hai** —
  kyunki purane D1 rows aur pehle se shipped mobile builds usi par hain.

---

## 2. Code me kya ho chuka hai (reference)

### Worker — `apps/worker/wrangler.toml`
| Setting | Value | Note |
|---|---|---|
| `routes` | `[{ pattern = "api.tophunt.in", custom_domain = true }]` | Cloudflare hi DNS + cert banata hai |
| `routes` (staging) | `[]` | **zaroori** — `routes` inheritable key hai; iske bina `--env staging` deploy production hostname hijack kar leta |
| `workers_dev` | enabled (default) | legacy `/media` urls isi host par hain |
| `R2_PUBLIC_BASE_URL` | `https://media.tophunt.in` | |
| `R2_LEGACY_BASE_URLS` | purana `<worker>/media` base | delete path ke liye, §5 |
| `MEDIA_TRANSFORMATIONS` | `"false"` | **jaan-boojh kar** — §6 |
| `ALLOWED_ORIGINS` | `tophunt.in`, `www.tophunt.in`, `admin.tophunt.in` | purane `*.pages.dev` origins hata diye |

### Clients
| File | Change |
|---|---|
| `apps/expo/eas.json` | teeno profiles me `EXPO_PUBLIC_API_URL` + `EXPO_PUBLIC_SHARE_ORIGIN` |
| `apps/expo/src/services/api.ts` | `FALLBACK_API_URL = https://api.tophunt.in` |
| `apps/expo/seo/worker.js` | `DEFAULT_API_BASE = https://api.tophunt.in` (+ security headers, §4) |
| `apps/expo/app.json` | `app.tophunt.in` hataya (applinks + Android intent filter) |
| `apps/admin-panel/.env.production` | `VITE_API_URL = https://api.tophunt.in` |
| `apps/admin-panel/vite.config.ts` | fallback bhi wahi |
| dono `public/_headers` | CSP me exact hosts, `*.workers.dev` wildcard gaya, `wss://api.tophunt.in` aaya |

`EXPO_PUBLIC_SHARE_ORIGIN` naya hai aur **native builds ke liye zaroori** hai. Web
par `window.location.origin` use hota hai, par native me browser location nahi
hota — pehle fallback API origin tha, jo ab `https://api.tophunt.in/battle/<id>`
banata (wo host JSON deta hai, app nahi). Pehle api aur web ek hi host par the, to
ye fallback theek lagta tha.

---

## 3. Cutover order — isi kram me karo

Kram ki wajah hai: har step ka client tabhi switch hota hai jab uska server side
pehle se live ho.

1. **Zone**: `tophunt.in` Cloudflare par add karo, registrar par nameservers point karo.
2. **`api.tophunt.in`** — Worker `tophunt-api` → Settings → Domains & Routes → Add
   Custom Domain. (`wrangler.toml` me already hai, to pehla `wrangler deploy` bhi
   ise bana dega. Zone pehle exist karna chahiye, warna deploy "Could not find
   zone" se fail hoga.)
3. **`media.tophunt.in`** — R2 → bucket `tophunt-media` → Settings → Public access
   → Custom Domains.
4. **Worker deploy** — `cd apps/worker && npx wrangler deploy`
   Uske baad `GET https://api.tophunt.in/health/deep` 200 dena chahiye.
5. **Media verify** — `curl -I https://media.tophunt.in/<koi-existing-key>` → 200.
   Ye §5 ke backfill se **pehle** hona zaroori hai.
6. **Media backfill** — §5.
7. **Transformations enable + flag flip** — §6.
8. **`tophunt.in`** (apex) — Pages project `tophuntdpcontest` → Custom domains.
   `www.tophunt.in` ke liye ek Redirect Rule → apex.
9. **`admin.tophunt.in`** — Pages project `tophunt-admin-panel` → Custom domains.
10. **Firebase** → Authentication → Settings → Authorized domains me `tophunt.in`
    aur `admin.tophunt.in` add karo. Iske bina in hosts par login/OTP block ho
    jaayega — aur error Firebase se aata hai, Worker tak request pahunchti bhi nahi.
11. **Clients rebuild + deploy** — §7.
12. **Email domain** — §8.
13. **Deep links** — §9. (Ye app-store release ke saath jaata hai.)
14. **Search Console** — §10.

---

## 4. Web app ke security headers — ek zaroori baat

Expo web Pages **advanced mode** me chalta hai (`dist/_worker.js`). Cloudflare
`_headers` ko **static asset responses** par lagata hai, aur advanced mode me HTML
document ek Function-generated response hota hai — to `public/_headers` ka CSP /
HSTS / framing **document tak pahunchta hi nahi tha**. Ye chup-chaap fail hone
wali cheez hai: file maujood hai, deploy green hai, bas header nahi aata.

Isliye document policy ab `apps/expo/seo/worker.js` me hai
(`CONTENT_SECURITY_POLICY` + `withSecurityHeaders`), aur wahi actually browser tak
jaati hai. `public/_headers` static assets ke liye bana hua hai.

Dono copies same rehni chahiye — `scripts/build-seo-worker.mjs` drift par **build
fail** kar deta hai, to ek jagah badalke doosri bhoolna deploy nahi ho paayega.

Verify (cutover ke baad):
```bash
curl -sI https://tophunt.in/ | grep -i "content-security-policy\|strict-transport"
```

---

## 5. Media backfill (R2 domain par purane urls laana)

Media urls D1 me **absolute** store hote hain, to domain badalne se purane rows
apne aap nahi badalte.

**Iske bina kya hoga:** purana media chalta rahega (Worker `/media/*` route se),
par har request ek Worker invocation rahegi aur uska koi resized variant nahi
milega. To ye correctness ka issue nahi, cost + performance ka hai.

**Delete ka issue already fix hai:** `R2_LEGACY_BASE_URLS` ki wajah se
`deleteByPublicUrl`, `contestBannerKeyFromPublicUrl` aur `vsImageKeyFromPublicUrl`
dono hosts ko pehchante hain. Pehle purane host ke banners **kabhi delete nahi
hote the** aur story media ka delete galat key par jaata tha — dono silently.

```bash
cd apps/worker

# 1. Domain sach me bytes de raha hai? (backfill se PEHLE — ye gate hai)
curl -I https://media.tophunt.in/<koi-existing-key>

# 2. Kitna badlega (read-only)
npx wrangler d1 execute tophunt-db --remote --file=scripts/media-domain-report.sql

# 3. Backfill
npx wrangler d1 execute tophunt-db --remote --file=scripts/media-domain-backfill.sql

# 4. Sab counts 0 hone chahiye
npx wrangler d1 execute tophunt-db --remote --file=scripts/media-domain-report.sql
```

Script 24 columns cover karta hai — plain url columns **aur** JSON blobs
(`contest_matches.user_a/user_b` = feed ka saara media, `chats.users_data`,
`settings.data` ka payment QR) **aur** `blog_posts.content` ka embedded HTML.
Idempotent hai; rollback ke liye D1 Time Travel (`wrangler d1 time-travel`).

Ye migration folder me **nahi** hai jaan-boojh kar: `migrations/*.sql` runtime par
auto-apply hote hain, aur ye rewrite tabhi sahi hai jab domain live ho. Migration
banate to deploy ke saath chal jaata — aur domain ready na ho to poore product ka
media ek dead host par point kar deta.

---

## 6. Transformations (image resizing)

`MEDIA_TRANSFORMATIONS` abhi `"false"` hai. Code ki dono condition ab poori hoti
hain (`media.tophunt.in` real zone host hai, path prefix nahi hai). Baaki sirf
dashboard hai:

1. Zone `tophunt.in` → Speed → Optimization → **Transformations** enable karo.
   (Free monthly allowance ke baad per-transformation billing hai — plan check kar lo.)
2. Backfill (§5) ho chuka ho.
3. `wrangler.toml` me `MEDIA_TRANSFORMATIONS = "true"` karo, `wrangler deploy`.

**Ulta kram mat karo.** Transformations disabled zone par `/cdn-cgi/image/...`
original par fall back nahi karta — error deta hai. Flag pehle `true` kiya to
product ke saare thumbnails, feed images aur avatars deploy ke saath hi tut
jaayenge. Client release ki zaroorat nahi — `lib/media.ts` isiliye aise likha hai.

Verify:
```bash
curl -s "https://api.tophunt.in/read/users/<uid>" | grep -o 'profileImageUrlThumb[^,]*'
# cdn-cgi/image wala url dikhna chahiye, original nahi
```

---

## 7. Rebuild + redeploy

```bash
# Worker (order me sabse pehle — §3 step 4)
cd apps/worker && npx wrangler deploy

# Admin panel
cd apps/admin-panel
npm run build && npx wrangler pages deploy dist --project-name tophunt-admin-panel --branch main

# Expo web — `npm run build` hi chalao, bare `expo export` NAHI:
# warna dist/_worker.js install nahi hoga, SEO edge layer deploy nahi hogi, aur
# document par security headers bhi nahi aayenge (§4).
cd apps/expo
npm run build
npx wrangler pages deploy dist --project-name tophuntdpcontest --branch main

# Expo mobile (eas.json env badla hai)
cd apps/expo && npx eas update --branch production
```

### Pages env vars (Production)
`apps/expo/seo/worker.js` ke defaults ab production values hain, to Pages par
**kuch set karna zaroori nahi**. Staging/preview Pages project par override karo,
warna uska sitemap aur canonical tags production origin advertise karenge:

| Var | Default | Staging par |
|-----|---------|-------------|
| `SEO_SITE_ORIGIN` | `https://tophunt.in` | preview host |
| `SEO_API_BASE` | `https://api.tophunt.in` | staging Worker |

---

## 8. Email

`lib/email.ts` ka fallback `TopHunt <no-reply@tophunt.in>` hai, aur From address
admin panel (Integrations) se bhi set ho sakta hai — deploy ki zaroorat nahi.

Bhejne ke liye `tophunt.in` par ye chahiye:
- provider (Resend/Brevo) me domain verify
- **SPF** record
- **DKIM** record
- (recommended) **DMARC** record

Iske bina mail bhejni "kaam karegi" par inbox me nahi, spam me jaayegi — aur ye OTP
aur withdrawal notifications hain.

---

## 9. Deep links / App Links — abhi **incomplete**

`app.json` me `tophunt.in` ke liye iOS `associatedDomains` aur Android
`intentFilters` (autoVerify) set hain. Par verification ke liye do file
`https://tophunt.in` par serve honi chahiye, aur wo repo me **nahi** hain:

| File | Kya chahiye |
|---|---|
| `apps/expo/public/.well-known/apple-app-site-association` | Apple Team ID + `in.tophunt.app` |
| `apps/expo/public/.well-known/assetlinks.json` | Android signing cert ka SHA-256 fingerprint |

Values kahan se milengi:
```bash
# Android — jo key se Play par sign hota hai (Play App Signing ka fingerprint lo,
# upload key ka nahi, warna verification production me fail hogi)
npx eas credentials    # → Android → keystore, ya Play Console → App integrity

# iOS Team ID
npx eas credentials    # → iOS → distribution certificate
```

Yahan placeholder file commit nahi ki gayi hai jaan-boojh kar: galat fingerprint
wali `assetlinks.json` bhi verification fail karti hai, par uske hone se aisa
lagta hai ki kaam ho gaya. **Tab tak link browser me khulega, app me nahi** — app
ka baaki kuch nahi tootega.

`public/` ki files `expo export` se `dist/` me chali jaati hain, aur SEO worker
non-HTML requests `env.ASSETS` par bhej deta hai — to file daalne ke baad kuch aur
karna nahi hai.

---

## 10. Search Console (one-time)

1. `https://tophunt.in` property add + verify (DNS TXT ya HTML tag).
2. **Sitemaps** → `https://tophunt.in/sitemap.xml` submit.
3. Kuch important posts ka **URL Inspection → Request indexing**.
4. Verify: `robots.txt` khule aur sitemap line dikhe; `sitemap.xml` me saare post
   URLs; `view-source:` me sahi `<title>` + `description` + `og:*` + JSON-LD;
   [Rich Results Test](https://search.google.com/test/rich-results) Article pass kare.

Blog SEO edge layer ka detail: [`.kiro/steering/blog.md`](.kiro/steering/blog.md).
Canonical policy: imported posts ka `canonicalUrl` original tophunt.in permalink
hota hai; worker canonical isi site par ho to usi ko rakhta hai, warna current
path par self-canonical — isse `/blog/<slug>` aur root `/<slug>` ka duplicate
content resolve ho jaata hai.

---

## 11. Cutover checklist

**Cloudflare**
- [ ] `tophunt.in` zone add, nameservers pointed
- [ ] `api.tophunt.in` → Worker `tophunt-api` custom domain
- [ ] `media.tophunt.in` → R2 bucket `tophunt-media` custom domain
- [ ] `tophunt.in` (apex) → Pages `tophuntdpcontest`
- [ ] `www.tophunt.in` → Redirect Rule to apex
- [ ] `admin.tophunt.in` → Pages `tophunt-admin-panel`
- [ ] Zone par Transformations enable (§6)

**Deploy**
- [ ] Worker deploy, `GET https://api.tophunt.in/health/deep` = 200
- [ ] `curl -I https://media.tophunt.in/<key>` = 200
- [ ] Media backfill chalao, report ke saare counts 0 (§5)
- [ ] `MEDIA_TRANSFORMATIONS = "true"` + redeploy (§6)
- [ ] Admin panel build + deploy
- [ ] Expo web `npm run build` + deploy
- [ ] `eas update --branch production`

**Baahar ke systems**
- [ ] Firebase authorized domains: `tophunt.in`, `admin.tophunt.in`
- [ ] Email: domain verify + SPF + DKIM (+ DMARC) on `tophunt.in` (§8)
- [ ] `.well-known/` app-link files (§9)
- [ ] Search Console: property, sitemap, indexing (§10)

**Verify**
- [ ] `curl -sI https://tophunt.in/ | grep -i content-security-policy` — CSP aa rahi hai
- [ ] Web app se login, ek vote, ek chat message — realtime chal raha hai
      (`wss://api.tophunt.in`, dev tools → Network → WS)
- [ ] `admin.tophunt.in` par login + ek deposit screenshot khulti hai
- [ ] Share sheet se battle link `https://tophunt.in/battle/<id>` banta hai
- [ ] Ek story delete karke R2 me object gaya ya nahi check karo (§5 delete path)
