# Production Domain Migration Checklist

Yeh file batati hai ki jab production custom domains banao, to **kahan-kahan** URL/domain
change karne padenge — code, config, Cloudflare dashboard, Firebase console — sab ek jagah.

> Aaj ki state: sab kuch Cloudflare ke default `*.workers.dev` / `*.pages.dev` domains par
> chal raha hai. Media custom domain (`media.tophuntdpcontest.com`) config me likha hai par
> abhi tak DNS/R2 par connect nahi hua.

---

## 1. Domain plan (pehle yeh decide + fill karo)

Neeche apne actual production domains bhar do. Baaki poori file inhi ko refer karti hai.

| Role | Abhi (current) | Production (yahan bharo) |
|------|----------------|--------------------------|
| **Backend API** (Worker) | `https://tophunt-api.weadown-in.workers.dev` | `https://api.tophuntdpcontest.com` |
| **User web app** (Expo web) | `https://tophuntdpcontest-89t.pages.dev` | `https://app.tophuntdpcontest.com` |
| **Admin panel** | `https://tophunt-admin-panel.pages.dev` | `https://admin.tophuntdpcontest.com` |
| **Media / R2 public** | `https://media.tophuntdpcontest.com` (not live yet) | `https://media.tophuntdpcontest.com` |
| **Email "from"** | `no-reply@tophuntdpcontest.com` | `no-reply@tophuntdpcontest.com` |
| **Firebase auth domain** | `tophuntdpcontest.firebaseapp.com` | (usually same; optional custom) |

> Neeche `<API_DOMAIN>`, `<APP_DOMAIN>`, `<ADMIN_DOMAIN>`, `<MEDIA_DOMAIN>` in placeholders ko
> upar wale production values se replace samajhna.

---

## 2. Code / config changes (git me commit hoti hain)

### A) Backend API URL — `<API_DOMAIN>`
Yeh sabse zyada jagah use hota hai. Har file me current value
`https://tophunt-api.weadown-in.workers.dev` ko `<API_DOMAIN>` se badlo:

| File | Line | Kya hai |
|------|------|---------|
| `apps/expo/.env` | `EXPO_PUBLIC_API_URL=...` | User app runtime (local build) — **git-ignored**, alag se update karna |
| `apps/expo/.env.example` | 2 | Reference example |
| `apps/expo/eas.json` | 15, 22 | Mobile build profiles (preview + production) ka env |
| `apps/expo/src/services/api.ts` | 13 | Fallback URL (env na mile to yahi use hota hai) |
| `apps/admin-panel/.env.production` | 6 | Admin panel production build |
| `apps/admin-panel/.env.example` | 5 | Reference example |
| `apps/admin-panel/vite.config.ts` | 10 | `WORKER_URL` fallback |
| `apps/admin-panel/vite.config.ts` | 22 | `define` ke through bundle me inject hota hai |
| `apps/admin-panel/scripts/README.md` | 12 | CLI scripts ka example (minor) |
| `apps/admin-panel/scripts/lib/worker.mjs` | 6 | Comment (minor) |

### B) Media public base — `<MEDIA_DOMAIN>`
| File | Line | Kya hai |
|------|------|---------|
| `apps/worker/wrangler.toml` | 81 | `R2_PUBLIC_BASE_URL = "https://media.tophuntdpcontest.com"` |

> Note: yeh already custom domain hai. Sirf **Cloudflare R2 par connect** karna baaki hai (section 3D).
> Agar abhi bina custom domain ke chahiye, to temporary `https://<bucket>.r2.dev` URL laga sakte ho.

### C) CORS allowed origins — `<APP_DOMAIN>`, `<ADMIN_DOMAIN>`
| File | Line | Abhi | Production |
|------|------|------|-----------|
| `apps/worker/wrangler.toml` | 82 | `ALLOWED_ORIGINS = "*"` | `ALLOWED_ORIGINS = "https://<APP_DOMAIN>,https://<ADMIN_DOMAIN>"` |

> Prod me `*` se hata kar sirf apne web + admin origins allow karo (security).

### D) Email "from" address (tab jab email/#3 setup karo)
| File | Line | Kya hai |
|------|------|---------|
| `apps/worker/src/lib/email.ts` | 23 | Fallback `TopHunt <no-reply@tophuntdpcontest.com>` — ya `EMAIL_FROM` secret set karo |

### E) Admin panel deploy target (agar Pages project rename karo)
| File | Line | Kya hai |
|------|------|---------|
| `apps/admin-panel/package.json` | `deploy` script | `--project-name tophunt-admin-panel` |

### F) Expo web deploy target (CI)
| File | Line | Kya hai |
|------|------|---------|
| `.github/workflows/web-production.yml` | 44 | `projectName: tophuntdpcontest` (Cloudflare Pages project) |

---

## 3. Cloudflare dashboard (DNS + custom domains) — code me nahi, dashboard me

### A) Worker custom domain → `<API_DOMAIN>`
- Worker `tophunt-api` → **Settings → Domains & Routes → Add Custom Domain** → `api.tophuntdpcontest.com`.
- Ya `apps/worker/wrangler.toml` me add karo:
  ```toml
  routes = [
    { pattern = "api.tophuntdpcontest.com", custom_domain = true }
  ]
  ```
- DNS: Cloudflare khud CNAME/record bana dega (agar domain Cloudflare par hai).

### B) Expo web (Pages project `tophuntdpcontest`) → `<APP_DOMAIN>`
- Pages project `tophuntdpcontest` → **Custom domains → Set up a custom domain** → `app.tophuntdpcontest.com`.

### C) Admin panel (Pages project `tophunt-admin-panel`) → `<ADMIN_DOMAIN>`
- Pages project `tophunt-admin-panel` → **Custom domains** → `admin.tophuntdpcontest.com`.

### D) R2 bucket `tophunt-media` → `<MEDIA_DOMAIN>`
- R2 → bucket `tophunt-media` → **Settings → Public access → Custom Domains** → `media.tophuntdpcontest.com`.
- Iske bina uploaded media ke public URLs khulenge nahi.

---

## 4. Firebase console (auth ke liye zaroori)

- **Authentication → Settings → Authorized domains** me production web domains add karo:
  - `app.tophuntdpcontest.com`
  - `admin.tophuntdpcontest.com`
- Warna in domains par login/OTP block ho sakta hai.
- `authDomain` (`tophuntdpcontest.firebaseapp.com`) usually same rehta hai — change karna optional hai.

---

## 5. Chhoti consistency fix (abhi bhi kar sakte ho)

- **Storage bucket mismatch:** `apps/admin-panel/.env.example:11` me `tophuntdpcontest.appspot.com` hai,
  jabki `.env.production:11` me `tophuntdpcontest.firebasestorage.app`. Dono ko same (firebasestorage.app) karo.

---

## 6. Change ke baad rebuild + redeploy

```bash
# Worker (API URL/CORS/media var change hone par)
cd apps/worker
npx wrangler deploy

# Admin panel
cd apps/admin-panel
npm run build && npx wrangler pages deploy dist --project-name tophunt-admin-panel --branch main

# Expo web
cd apps/expo
npx expo export --platform web
npx wrangler pages deploy dist --project-name tophuntdpcontest --branch main

# Expo mobile (OTA update, eas.json env change hone par)
cd apps/expo
npx eas update --branch production
```

---

## 7. Quick summary — kitne "domain" hain

Total **4 custom domains** banane/point karne padenge + Firebase authorized domains:

1. `api.tophuntdpcontest.com` → Worker (backend)
2. `app.tophuntdpcontest.com` → Expo web (user app)
3. `admin.tophuntdpcontest.com` → Admin panel
4. `media.tophuntdpcontest.com` → R2 media bucket

Har ek ke liye: (a) code/config me URL update, (b) Cloudflare me custom domain connect,
(c) rebuild + redeploy. API + app + admin domains ko Firebase authorized domains me bhi daalo.
