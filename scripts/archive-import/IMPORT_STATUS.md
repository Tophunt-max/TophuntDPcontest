# TopHunt Blog Import & Update — Status & Continuation Guide

> **Last updated:** 2026-08-15 04:05 UTC
> **Purpose:** Yeh file batati hai ki blog import/update me ab tak kya hua, kya baaki hai,
> aur baaki kaam **kaise continue karna hai bina kisi post ko dobara update kiye**.
> (Data source: Wayback Machine → Cloudflare Worker → **D1** + **R2**.)

---

## 1. TL;DR — Abhi ki state (live D1)

| Metric | Value |
|--------|------:|
| **Published blog posts (live)** | **4,493** |
| Import log — `imported` | 3,631 |
| Import log — `updated` | 860 |
| Import log — `failed` | 277 |
| Import log — `duplicate` | 9 |
| Import log — `pending` | **0** ✅ |

### Sabse zaroori: kaam kitna baaki hai
| Kaam | Count | Karna hai? |
|------|------:|-----------|
| **Not-yet-updated, missing images** (`status='imported'` AND `images_missing>0`) | **113 posts (215 images)** | Optional — value kam (neeche §7) |
| Already `updated` | 860 | ❌ **Dubara mat karo** |
| `imported` + complete (no missing images) | 3,518 | ❌ Haath mat lagao |
| `failed` | 277 | Mostly unrecoverable (§8) |

---

## 2. Original goal — ✅ COMPLETE

Goal tha: **"pending" blog posts import karna.**
- Shuru me: **731 pending**
- Ab: **0 pending**
- **~530 naye posts** import hokar live ho gaye (published 3,963 → 4,493).

Yeh kaam **poora ho chuka hai.** Neeche jo bacha hai woh sirf ek optional
"missing-images recovery" pass hai (jo mostly kaam nahi karta — §7).

---

## 3. Is session me kya-kya hua

1. **Parser bug fix** — `node-html-parser` ad-heavy (GeneratePress-theme) captures ka
   DOM tree tod deta tha jab `.entry-content` ke andar `<script>` ads hote the → har aisa
   post `"no content element"` se fail hota tha. Raw-HTML se content-container nikaal ke
   re-parse karne wala fallback add kiya. **Isi se ~530 posts recover hue.**
   → PR: **https://github.com/Tophunt-max/TophuntDPcontest/pull/9**

2. **`--urls-file` mode add kiya** importer me — kisi bhi explicit URL list ko target
   karke import/update karne ke liye (CDX crawl bypass). Detail §6.

3. **Saara pending import kiya** (731 → 0).

4. **Missing-images update pass** shuru kiya (860 posts `updated`) — par pata chala ki
   **zyaadatar missing images Wayback pe dead (404) hain**, isliye recover nahi hoti (§7).

5. **`ADMIN_PROXY_SECRET` rotate kiya** (Cloudflare Worker secret). Value chat me di gayi thi.
   Agar kho jaye → §5 me naya set karne ka command hai.

---

## 4. GOLDEN RULE — dobara update se kaise bachein

> **Sirf `status = 'imported'` wale rows process karo. `'updated'` ko kabhi mat chhuo.**

Kyunki jaise hi koi post process hota hai, uska import-log status `imported` → `updated`
ho jaata hai. Toh agar hamesha "remaining list" **`status='imported'`** filter se banai jaye,
toh already-updated posts apne aap exclude ho jaate hain. **Koi post dobara update nahi hoga.**

**Kabhi bhi mat karo:**
- `--fresh` flag (sab kuch reprocess karta hai)
- Poori `blog_import_log` ki list feed karna
- `status='updated'` wale URLs feed karna

---

## 5. Prerequisites (chalane se pehle)

Environment variables (importer ke liye):

```bash
export WORKER_URL="https://api.tophunt.in"
export ADMIN_PROXY_SECRET="<secret — chat me diya gaya tha>"
export ARCHIVE_DOMAIN="tophunt.in"
```

Cloudflare API (D1 status queries ke liye — read-only checks):

```bash
export CLOUDFLARE_ACCOUNT_ID="8357be8f9dba5721b6b726faff763f0f"
export CLOUDFLARE_API_TOKEN="<cloudflare api token>"
# D1 database id: 932ccd0f-190a-46df-bdf6-685926f524ff  (name: tophunt-db)
```

**Agar `ADMIN_PROXY_SECRET` kho jaye** — sandbox me `CLOUDFLARE_API_TOKEN` set ho toh
naya secret set kar sakte ho (live admin panel Firebase-login se chalta hai, is se break
nahi hota — sirf CLI scripts ko naya value chahiye):

```bash
cd apps/worker
NEW=$(python3 -c "import secrets; print('thp_'+secrets.token_urlsafe(40))")
printf '%s' "$NEW" | npx wrangler secret put ADMIN_PROXY_SECRET
echo "New secret: $NEW"
```

Install (ek baar):
```bash
cd scripts/archive-import && npm install
```

---

## 6. Baaki update kaise continue karein (exact steps)

### Step A — remaining list banao (D1 se, safe filter)
```bash
ACCT="$CLOUDFLARE_ACCOUNT_ID"; DB="932ccd0f-190a-46df-bdf6-685926f524ff"
curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCT/d1/database/$DB/query" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  --data '{"sql":"SELECT url FROM blog_import_log WHERE status=\"imported\" AND images_missing>0 ORDER BY url"}' \
  | python3 -c "import sys,json; urls=[r['url'] for r in json.load(sys.stdin)['result'][0]['results']]; open('remaining.txt','w').write('\n'.join(urls)+'\n'); print('remaining:',len(urls))"
```
> Yeh `remaining.txt` me sirf **not-yet-updated** posts daalega. Har run ke baad yeh query
> dobara chalao — list apne aap chhoti hoti jaayegi (kyunki processed posts `updated` ban jaate hain).

### Step B — importer chalao (chunks me)
```bash
cd scripts/archive-import
node import.mjs --urls-file=./remaining.txt --limit=120 --concurrency=3 --batch=15 --delay=150
```
- `--limit=N` → ek baar me kitne (safe chunk ~100–150).
- Process hone par posts `imported` → `updated` ho jaate hain → **dobara nahi honge**.
- Interrupt ho jaye? Step A dobara chalao, phir Step B. Fully resumable.

### Step C — verify (§9 queries)

> ⚠️ Note: yeh runs **D1 me likhte hain** (safe). Public blog page pe change dikhne me
> thodi der lag sakti hai (KV cache — §10).

---

## 7. Missing images — kyun recover nahi hoti (padho pehle)

Update pass ka maksad tha missing images R2 pe laana. **Par recovery ~7% hi hai.** Wajah:
- Real uploaded images (jaise `wp-content/uploads/2025/02/Tophunt.jpg`) → Wayback pe **200**, recover ho jaati hain ✅
- Plugin-generated thumbnails (`wp-content/uploads/thumbs_dir/...`) aur external CDN images
  → Wayback pe **404** (kabhi archive hui hi nahi) → **permanently dead** ❌

Aur bura: re-processing kabhi-kabhi aisa snapshot chun leta hai jisme aur **zyada dead image
refs** hote hain, isliye `images_missing` ka number **badh** bhi sakta hai.

**Iska matlab:** baaki 113 posts update karne se bhi bahut kam (~10–20) images aayengi.
**Value low hai.** Agar chalao to sirf isliye ki posts "updated" mark ho jayein — content
already sahi hai.

---

## 8. `failed` (277) — kyun fail hue

| Kism | Count | Recoverable? |
|------|------:|--------------|
| Junk URLs (`%C2%BB`, `…` jaise breadcrumb artifacts — real posts hi nahi) | 129 | ❌ Kabhi nahi |
| Real URLs jinke Wayback pe sirf khaali/broken outage-era captures hain | 148 | ❌ Mostly nahi |

Yeh genuinely unimportable hain — inhe chhod dena theek hai.

---

## 9. Status kabhi bhi check karne ke queries

```bash
ACCT="$CLOUDFLARE_ACCOUNT_ID"; DB="932ccd0f-190a-46df-bdf6-685926f524ff"
Q() { curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCT/d1/database/$DB/query" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  --data "{\"sql\":\"$1\"}" | python3 -c "import sys,json;print(json.load(sys.stdin)['result'][0]['results'])"; }

Q "SELECT status, COUNT(*) n FROM blog_import_log GROUP BY status ORDER BY n DESC"
Q "SELECT COUNT(*) n FROM blog_posts WHERE status='published'"
Q "SELECT COUNT(*) posts, SUM(images_missing) imgs FROM blog_import_log WHERE status='imported' AND images_missing>0"
```

---

## 10. KV daily limit (yaad rakho)

15 Aug 2026 ko Cloudflare ne alert bheja: **Workers KV free-tier daily `put` limit (1000)
cross ho gaya** (bulk import/update ki wajah se).
- **KV writes (put) `429` de rahe hain, reset: 2026-08-16 00:00 UTC.**
- Sirf KV **writes** affected — **reads chalu hain**. Blog import/update (D1) **kaam karta hai**.
- Side-effect: KV cache refresh nahi hota → naye posts public list pe thodi der baad dikhte hain.
- OTP-login (KV put par depend) us window me fail ho sakta hai — yeh blog se **alag** issue hai.
- Chahein to **Workers Paid ($5/mo)** le lo → limit bahut badi + turant restore.

---

## 11. Data model — `blog_import_log` statuses

| status | matlab |
|--------|--------|
| `imported` | Naya import hua (abhi tak update pass me nahi gaya) |
| `updated` | Re-process/update ho chuka — **dobara mat karo** |
| `failed` | Parse/fetch fail (§8) |
| `duplicate` | Content-hash dedup se skip |
| `pending` | Discover hua par process nahi (abhi **0**) |

Useful columns: `url`, `status`, `error`, `images_total`, `images_missing`, `updated_at` (epoch ms).

---

## 12. Quick reference — importer flags

| Flag | Kaam |
|------|------|
| `--urls-file=<path>` | Di gayi URL list ko process karo (CDX crawl bypass) |
| `--limit=N` / `--offset=N` | List ka window (chunking ke liye) |
| `--concurrency=N` | Parallel fetches (3 rakho; archive.org throttle karta hai) |
| `--batch=N` | Ek DB import call me kitne posts (default 20) |
| `--delay=ms` | Har fetch ke beech delay (default 300) |
| `--dry-run` | Sirf parse; kuch likhta/upload nahi karta |
| `--retry-failed` | Sirf `failed` URLs dobara try karo |
| ⚠️ `--fresh` | **Mat use karo** — sab reprocess karta hai (double-update) |
