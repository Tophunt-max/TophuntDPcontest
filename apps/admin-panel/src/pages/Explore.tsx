import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { PageHeader } from "@/lib/format";
import { toast } from "@/lib/toast";
import { AlertTriangle, ArrowDown, ArrowUp, Eye, EyeOff, ImagePlus, Plus, Save, Trash2 } from "lucide-react";

/**
 * Explore page — what the app's Explore tab shows (appConfig.explore).
 *
 *  - Banners: the promo carousel. Image (uploaded here), optional title/subtitle,
 *    a link (an app path like /referral, or an https URL), on/off and a schedule.
 *  - Sections: which sections show, and in what order.
 *
 * The Worker validates everything again (lib/exploreConfig.ts) and only ever
 * sends the app banners that are enabled and inside their window.
 */

interface Banner {
  id: string;
  imageUrl: string;
  title: string;
  subtitle: string;
  link: string;
  enabled: boolean;
  startsAt: number | null;
  endsAt: number | null;
}
interface Section {
  key: string;
  enabled: boolean;
}

const SECTIONS: { key: string; label: string; hint: string }[] = [
  { key: "banners", label: "Promo banners", hint: "The carousel below." },
  { key: "quickActions", label: "Quick actions", hint: "Ranks, Photo/Video battle, Refer & Earn, Wallet." },
  { key: "trending", label: "Trending battles", hint: "Live battles with the most engagement." },
  { key: "endingSoon", label: "Ending soon", hint: "Live battles closing next — drives last-minute votes." },
  { key: "contests", label: "Start a battle", hint: "Live contest templates (hidden if Contests is off)." },
  { key: "openBattles", label: "Open battles", hint: "Battles waiting for a challenger (hidden if Contests is off)." },
  { key: "topCreators", label: "Top creators", hint: "Leaderboard preview (wins)." },
  { key: "people", label: "People you may know", hint: "Suggested accounts (excludes people already followed)." },
  { key: "grid", label: "Fresh battles grid", hint: "Infinite grid at the bottom." },
];
const LABEL = Object.fromEntries(SECTIONS.map((s) => [s.key, s.label]));

const QUICK_LINKS = ["/referral", "/explore/leaderboard", "/contest/photo", "/contest/video", "/wallet/store", "/blog"];

const field =
  "w-full px-3 py-2 rounded-xl border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring";
const label = "block text-[11px] font-semibold text-muted-foreground mb-1 uppercase tracking-wide";

const newId = () => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function normaliseSections(raw: any): Section[] {
  const out: Section[] = [];
  const seen = new Set<string>();
  for (const s of Array.isArray(raw) ? raw : []) {
    if (!LABEL[s?.key] || seen.has(s.key)) continue;
    seen.add(s.key);
    out.push({ key: s.key, enabled: s.enabled !== false });
  }
  for (const s of SECTIONS) if (!seen.has(s.key)) out.push({ key: s.key, enabled: true });
  return out;
}

const toLocal = (ms: number | null) => {
  if (!ms) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromLocal = (v: string) => (v ? new Date(v).getTime() : null);

function linkOk(link: string) {
  if (!link) return true;
  if (link.startsWith("/")) return !link.startsWith("//") && !/[\s\\]/.test(link);
  return /^https:\/\/[^\s]+$/i.test(link);
}

function bannerState(b: Banner, now: number): { text: string; tone: string } {
  if (!b.enabled) return { text: "Off", tone: "bg-slate-100 text-slate-600" };
  if (b.startsAt && b.startsAt > now) return { text: "Scheduled", tone: "bg-blue-100 text-blue-700" };
  if (b.endsAt && b.endsAt <= now) return { text: "Ended", tone: "bg-amber-100 text-amber-700" };
  return { text: "Live", tone: "bg-green-100 text-green-700" };
}

export default function ExplorePage() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["app-settings"], queryFn: api.appSettings });
  const [banners, setBanners] = useState<Banner[]>([]);
  const [sections, setSections] = useState<Section[]>(normaliseSections([]));
  const [dirty, setDirty] = useState(false);
  const [uploading, setUploading] = useState<number | null>(null);
  const [progress, setProgress] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadFor = useRef(0);

  useEffect(() => {
    if (!data || dirty) return;
    const ex = (data as any).explore || {};
    setBanners(
      (Array.isArray(ex.banners) ? ex.banners : []).map((b: any) => ({
        id: b.id || newId(),
        imageUrl: b.imageUrl || "",
        title: b.title || "",
        subtitle: b.subtitle || "",
        link: b.link || "",
        enabled: b.enabled !== false,
        startsAt: b.startsAt ?? null,
        endsAt: b.endsAt ?? null,
      })),
    );
    setSections(normaliseSections(ex.sections));
  }, [data, dirty]);

  const touch = () => setDirty(true);
  const update = (i: number, patch: Partial<Banner>) => {
    touch();
    setBanners((list) => list.map((b, j) => (j === i ? { ...b, ...patch } : b)));
  };
  const move = <T,>(list: T[], i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= list.length) return list;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  };

  const problems = useMemo(() => {
    const out: string[] = [];
    banners.forEach((b, i) => {
      const n = i + 1;
      if (!/^https:\/\//i.test(b.imageUrl)) out.push(`Banner ${n}: upload an image.`);
      if (!linkOk(b.link)) out.push(`Banner ${n}: link must be an app path like /referral or an https URL.`);
      if (b.title.length > 80 || b.subtitle.length > 80) out.push(`Banner ${n}: title/subtitle at most 80 characters.`);
      if (b.startsAt && b.endsAt && b.endsAt <= b.startsAt) out.push(`Banner ${n}: the end must be after the start.`);
    });
    if (banners.length > 10) out.push("At most 10 banners.");
    return out;
  }, [banners]);

  const saveMut = useMutation({
    mutationFn: () => api.saveAppSettings({ explore: { banners, sections } }),
    onSuccess: () => {
      toast.success("Explore page saved — live in the app within a minute.");
      setDirty(false);
      qc.invalidateQueries({ queryKey: ["app-settings"] });
    },
    onError: (e: any) => toast.error(e.message),
  });

  const pick = (i: number) => {
    uploadFor.current = i;
    fileRef.current?.click();
  };
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const i = uploadFor.current;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) return toast.error("Use a JPEG, PNG or WebP image.");
    if (file.size > 5 * 1024 * 1024) return toast.error("Image must be 5 MB or smaller.");
    setUploading(i);
    setProgress(0);
    try {
      const { publicUrl } = await api.uploadExploreBanner(file, setProgress);
      update(i, { imageUrl: publicUrl });
      toast.success("Image uploaded. Save to publish it.");
    } catch (e: any) {
      toast.error(e?.message || "Upload failed.");
    } finally {
      setUploading(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  if (isLoading) return <div className="text-sm text-muted-foreground py-10 text-center">Loading…</div>;
  const now = Date.now();

  return (
    <div>
      <PageHeader
        title="Explore Page"
        subtitle="Promo banners and the sections of the app's Explore tab"
        action={
          <button
            onClick={() => (problems.length ? toast.error(problems[0]) : saveMut.mutate())}
            disabled={!dirty || saveMut.isPending}
            className="flex items-center gap-2 gradient-purple text-white text-sm font-semibold px-4 py-2 rounded-xl shadow-lg disabled:opacity-50"
          >
            <Save size={15} /> {saveMut.isPending ? "Saving…" : "Save"}
          </button>
        }
      />
      <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
        {/* Banners */}
        <div className="xl:col-span-2 bg-card border border-border rounded-2xl p-5">
          <div className="flex items-center justify-between mb-1">
            <h3 className="font-bold text-foreground">Promo banners</h3>
            <button
              onClick={() => {
                touch();
                setBanners((l) => [...l, { id: newId(), imageUrl: "", title: "", subtitle: "", link: "", enabled: true, startsAt: null, endsAt: null }]);
              }}
              disabled={banners.length >= 10}
              className="flex items-center gap-1 text-xs font-semibold text-primary hover:underline disabled:opacity-40"
            >
              <Plus size={13} /> Add banner
            </button>
          </div>
          <p className="text-xs text-muted-foreground mb-4">Wide images work best (about 2.4 : 1, e.g. 1200×500). Up to 10; they rotate every 5 seconds.</p>

          {banners.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center border-2 border-dashed border-border rounded-xl">
              No banners. Add one to promote a contest, the referral program or a sale.
            </p>
          ) : (
            <div className="space-y-4">
              {banners.map((b, i) => {
                const st = bannerState(b, now);
                return (
                  <div key={b.id} className="border border-border rounded-xl p-3 flex flex-col md:flex-row gap-3">
                    <button
                      type="button"
                      onClick={() => pick(i)}
                      className="relative w-full md:w-60 aspect-[2.4/1] rounded-lg overflow-hidden bg-secondary flex items-center justify-center shrink-0"
                      title="Upload image"
                    >
                      {b.imageUrl ? (
                        <img src={b.imageUrl} alt="" className="absolute inset-0 w-full h-full object-cover" />
                      ) : (
                        <span className="flex flex-col items-center text-xs text-muted-foreground">
                          <ImagePlus size={20} /> Upload image
                        </span>
                      )}
                      {(b.title || b.subtitle) && b.imageUrl && (
                        <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-2 text-left">
                          <span className="block text-white text-xs font-bold truncate">{b.title}</span>
                          <span className="block text-white/80 text-[10px] truncate">{b.subtitle}</span>
                        </span>
                      )}
                      {uploading === i && (
                        <span className="absolute inset-0 bg-black/50 text-white text-xs flex items-center justify-center">{progress}%</span>
                      )}
                    </button>
                    <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div>
                        <label className={label}>Title</label>
                        <input className={field} maxLength={80} value={b.title} onChange={(e) => update(i, { title: e.target.value })} placeholder="Refer & earn 50 Diamond" />
                      </div>
                      <div>
                        <label className={label}>Subtitle</label>
                        <input className={field} maxLength={80} value={b.subtitle} onChange={(e) => update(i, { subtitle: e.target.value })} placeholder="Invite friends today" />
                      </div>
                      <div className="sm:col-span-2">
                        <label className={label}>Link (tap target)</label>
                        <input
                          className={`${field} ${linkOk(b.link) ? "" : "border-red-500"}`}
                          value={b.link}
                          onChange={(e) => update(i, { link: e.target.value.trim() })}
                          placeholder="/referral or https://…"
                          list="explore-links"
                        />
                      </div>
                      <div>
                        <label className={label}>Starts (optional)</label>
                        <input type="datetime-local" className={field} value={toLocal(b.startsAt)} onChange={(e) => update(i, { startsAt: fromLocal(e.target.value) })} />
                      </div>
                      <div>
                        <label className={label}>Ends (optional)</label>
                        <input type="datetime-local" className={field} value={toLocal(b.endsAt)} onChange={(e) => update(i, { endsAt: fromLocal(e.target.value) })} />
                      </div>
                    </div>
                    <div className="flex md:flex-col items-center gap-1.5 md:w-20">
                      <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${st.tone}`}>{st.text}</span>
                      <button title={b.enabled ? "Turn off" : "Turn on"} onClick={() => update(i, { enabled: !b.enabled })} className="p-1.5 rounded-lg hover:bg-secondary">
                        {b.enabled ? <Eye size={15} /> : <EyeOff size={15} />}
                      </button>
                      <button title="Move up" onClick={() => (touch(), setBanners((l) => move(l, i, -1)))} className="p-1.5 rounded-lg hover:bg-secondary">
                        <ArrowUp size={15} />
                      </button>
                      <button title="Move down" onClick={() => (touch(), setBanners((l) => move(l, i, 1)))} className="p-1.5 rounded-lg hover:bg-secondary">
                        <ArrowDown size={15} />
                      </button>
                      <button
                        title="Delete"
                        onClick={() => {
                          if (!window.confirm("Delete this banner?")) return;
                          touch();
                          setBanners((l) => l.filter((_, j) => j !== i));
                        }}
                        className="p-1.5 rounded-lg hover:bg-red-50 text-red-600"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <datalist id="explore-links">
            {QUICK_LINKS.map((l) => (
              <option key={l} value={l} />
            ))}
          </datalist>
          {problems.length > 0 && (
            <p className="text-xs text-red-600 mt-3 flex items-center gap-1.5">
              <AlertTriangle size={13} /> {problems[0]}
            </p>
          )}
        </div>

        {/* Sections */}
        <div className="bg-card border border-border rounded-2xl p-5">
          <h3 className="font-bold text-foreground mb-1">Sections</h3>
          <p className="text-xs text-muted-foreground mb-4">Order and visibility, top to bottom, as the app shows them.</p>
          <ol className="space-y-2">
            {sections.map((s, i) => (
              <li key={s.key} className={`flex items-center gap-2 border border-border rounded-xl px-3 py-2 ${s.enabled ? "" : "opacity-50"}`}>
                <span className="text-xs text-muted-foreground w-4">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-foreground truncate">{LABEL[s.key]}</p>
                  <p className="text-[11px] text-muted-foreground truncate">{SECTIONS.find((x) => x.key === s.key)?.hint}</p>
                </div>
                <button title="Move up" disabled={i === 0} onClick={() => (touch(), setSections((l) => move(l, i, -1)))} className="p-1 rounded hover:bg-secondary disabled:opacity-30">
                  <ArrowUp size={14} />
                </button>
                <button
                  title="Move down"
                  disabled={i === sections.length - 1}
                  onClick={() => (touch(), setSections((l) => move(l, i, 1)))}
                  className="p-1 rounded hover:bg-secondary disabled:opacity-30"
                >
                  <ArrowDown size={14} />
                </button>
                <input
                  type="checkbox"
                  className="accent-[hsl(var(--primary))] w-4 h-4"
                  checked={s.enabled}
                  title={s.enabled ? "Shown" : "Hidden"}
                  onChange={(e) => {
                    touch();
                    setSections((l) => l.map((x, j) => (j === i ? { ...x, enabled: e.target.checked } : x)));
                  }}
                />
              </li>
            ))}
          </ol>
          <button
            onClick={() => {
              touch();
              setSections(normaliseSections([]));
            }}
            className="text-xs font-semibold text-primary hover:underline mt-3"
          >
            Reset to default order
          </button>
        </div>
      </div>
    </div>
  );
}
