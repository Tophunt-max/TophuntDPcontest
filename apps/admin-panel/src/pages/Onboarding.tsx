import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ImagePlus, Plus, RotateCcw, Save, Smartphone, Trash2, X } from "lucide-react";
import { api } from "@/lib/api";
import { PageHeader } from "@/lib/format";
import { toast } from "@/lib/toast";

/**
 * The app's first-launch intro (onboarding), managed here.
 *
 * Who sees it (decided in the app, apps/expo/src/lib/onboarding.ts): a NEW guest,
 * once, when they open TopHunt directly (the app icon, or tophunt.in itself).
 * Never a signed-in user, never someone who arrived through a shared link
 * (battle, profile, blog…).
 *
 * Saved into appConfig as `onboarding` (the slides) and `onboardingEnabled`.
 * With no custom slides the app shows its built-in five. The Worker validates
 * everything on save (lib/onboardingConfig.ts): limits below must match it.
 */

const MAX_SLIDES = 6;
const TITLE_MAX = 60;
const DESCRIPTION_MAX = 200;

interface Slide {
  title: string;
  description: string;
  imageUrl: string;
}

/** Same text as the app's built-in intro (apps/expo/app/onboarding/index.tsx). */
const BUILT_IN: Slide[] = [
  { title: "Photo & video battles", description: "Two entries go head to head. Watch live battles from creators all over India.", imageUrl: "" },
  { title: "You decide the winner", description: "Vote for your favourite, like, comment and follow the creators you love.", imageUrl: "" },
  { title: "Enter and win", description: "Join a contest with your best photo or video and win coins and prizes.", imageUrl: "" },
  { title: "Follow creators & Stories", description: "Follow the people you like and catch their Stories and new battles first.", imageUrl: "" },
  { title: "Rewards every day", description: "Claim daily rewards, invite friends and grow your coin wallet.", imageUrl: "" },
];

const field =
  "w-full px-3 py-2.5 rounded-xl border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring";
const label = "block text-xs font-semibold text-muted-foreground mb-1.5 uppercase tracking-wide";

function same(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

export default function Onboarding() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["app-settings"], queryFn: api.appSettings });
  const [enabled, setEnabled] = useState(true);
  const [slides, setSlides] = useState<Slide[]>([]);
  const [selected, setSelected] = useState(0);
  const [uploading, setUploading] = useState<number | null>(null);
  const [progress, setProgress] = useState(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploadFor = useRef<number>(0);

  const savedEnabled = (data as any)?.onboardingEnabled !== false;
  const savedSlides: Slide[] = Array.isArray((data as any)?.onboarding)
    ? (data as any).onboarding.map((s: any) => ({
        title: String(s?.title ?? ""),
        description: String(s?.description ?? ""),
        imageUrl: String(s?.imageUrl ?? ""),
      }))
    : [];

  useEffect(() => {
    if (!data) return;
    setEnabled(savedEnabled);
    setSlides(savedSlides);
    setSelected(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const dirty = !!data && (enabled !== savedEnabled || !same(slides, savedSlides));

  const saveMut = useMutation({
    // Only these two keys: the Worker merges, so nothing else in App config moves.
    mutationFn: () => api.saveAppSettings({ onboardingEnabled: enabled, onboarding: slides }),
    onSuccess: () => {
      toast.success("Onboarding saved. New users see it within about 2 minutes.");
      qc.invalidateQueries({ queryKey: ["app-settings"] });
    },
    onError: (e: any) => toast.error(e?.message || "Could not save onboarding."),
  });

  const update = (i: number, patch: Partial<Slide>) =>
    setSlides((list) => list.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  const move = (i: number, dir: -1 | 1) =>
    setSlides((list) => {
      const j = i + dir;
      if (j < 0 || j >= list.length) return list;
      const next = [...list];
      [next[i], next[j]] = [next[j], next[i]];
      setSelected(j);
      return next;
    });
  const remove = (i: number) => {
    setSlides((list) => list.filter((_, idx) => idx !== i));
    setSelected((s) => Math.max(0, Math.min(s, slides.length - 2)));
  };
  const add = () => {
    if (slides.length >= MAX_SLIDES) return;
    setSlides((list) => [...list, { title: "", description: "", imageUrl: "" }]);
    setSelected(slides.length);
  };

  const pickImage = (i: number) => {
    uploadFor.current = i;
    fileRef.current?.click();
  };
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const i = uploadFor.current;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      toast.error("Use a JPEG, PNG or WebP image.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error("Image must be 5 MB or smaller.");
      return;
    }
    setUploading(i);
    setProgress(0);
    try {
      const { publicUrl } = await api.uploadOnboardingImage(file, setProgress);
      update(i, { imageUrl: publicUrl });
      toast.success("Image uploaded. Save to publish it.");
    } catch (e: any) {
      toast.error(e?.message || "Upload failed.");
    } finally {
      setUploading(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const problems = slides
    .map((s, i) => (!s.title.trim() ? `Slide ${i + 1} needs a title.` : null))
    .filter(Boolean) as string[];

  if (isLoading) return <div className="text-sm text-muted-foreground py-10 text-center">Loading…</div>;

  const usingBuiltIn = slides.length === 0;
  const previewSlides = usingBuiltIn ? BUILT_IN : slides;
  const preview = previewSlides[Math.min(selected, previewSlides.length - 1)] ?? BUILT_IN[0];

  return (
    <div>
      <PageHeader
        title="Onboarding"
        subtitle="The intro a new user sees once when they open TopHunt directly — never from a shared link, never when signed in."
        action={
          <button
            onClick={() => saveMut.mutate()}
            disabled={!dirty || saveMut.isPending || problems.length > 0}
            className="flex items-center gap-2 gradient-purple text-white text-sm font-semibold px-4 py-2 rounded-xl shadow-lg disabled:opacity-50"
          >
            <Save size={15} /> {saveMut.isPending ? "Saving…" : "Save"}
          </button>
        }
      />

      <input
        ref={fileRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => onFile(e.target.files?.[0])}
      />

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-5">
        <div className="space-y-5">
          {/* Switch */}
          <div className="bg-card border border-border rounded-2xl p-5">
            <label className="flex items-start justify-between gap-4 cursor-pointer">
              <span>
                <span className="text-sm font-semibold text-foreground">Show onboarding to new users</span>
                <span className="block text-xs text-muted-foreground mt-0.5">
                  Off: new users go straight to the Home feed. People who already saw it are not affected either way.
                </span>
              </span>
              <span className="relative shrink-0 mt-0.5">
                <input type="checkbox" className="sr-only peer" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
                <span className={`block w-10 h-6 rounded-full transition-colors ${enabled ? "bg-primary" : "bg-secondary border border-border"}`} />
                <span className={`absolute top-1 left-1 w-4 h-4 rounded-full bg-white shadow transition-transform ${enabled ? "translate-x-4" : ""}`} />
              </span>
            </label>
          </div>

          {/* Slides */}
          <div className="bg-card border border-border rounded-2xl p-5">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <div>
                <h3 className="font-bold text-foreground leading-tight">Slides</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {usingBuiltIn
                    ? "Using the app's built-in 5 slides. Load them to edit, or add your own."
                    : `${slides.length} of ${MAX_SLIDES}. A slide with no image uses the app's built-in picture for that position.`}
                </p>
              </div>
              <div className="flex gap-2">
                {usingBuiltIn ? (
                  <button
                    onClick={() => {
                      setSlides(BUILT_IN.map((s) => ({ ...s })));
                      setSelected(0);
                    }}
                    className="flex items-center gap-1.5 text-sm font-semibold px-3 py-2 rounded-xl border border-border hover:bg-secondary"
                  >
                    <Plus size={14} /> Load built-in slides
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      if (window.confirm("Remove your custom slides and go back to the app's built-in intro?")) {
                        setSlides([]);
                        setSelected(0);
                      }
                    }}
                    className="flex items-center gap-1.5 text-sm font-semibold px-3 py-2 rounded-xl border border-border hover:bg-secondary"
                  >
                    <RotateCcw size={14} /> Use built-in
                  </button>
                )}
                <button
                  onClick={add}
                  disabled={slides.length >= MAX_SLIDES}
                  className="flex items-center gap-1.5 text-sm font-semibold px-3 py-2 rounded-xl border border-border hover:bg-secondary disabled:opacity-50"
                >
                  <Plus size={14} /> Add slide
                </button>
              </div>
            </div>

            <div className="space-y-3">
              {slides.map((s, i) => (
                <div
                  key={i}
                  onClick={() => setSelected(i)}
                  className={`rounded-xl border p-4 ${selected === i ? "border-primary ring-1 ring-primary" : "border-border"}`}
                >
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-xs font-bold text-muted-foreground">SLIDE {i + 1}</span>
                    <div className="flex gap-1">
                      <IconBtn title="Move up" onClick={() => move(i, -1)} disabled={i === 0}><ArrowUp size={14} /></IconBtn>
                      <IconBtn title="Move down" onClick={() => move(i, 1)} disabled={i === slides.length - 1}><ArrowDown size={14} /></IconBtn>
                      <IconBtn title="Delete slide" onClick={() => remove(i)}><Trash2 size={14} /></IconBtn>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-[120px_1fr] gap-4">
                    <div>
                      <div className="w-[120px] h-[120px] rounded-xl bg-secondary border border-border overflow-hidden flex items-center justify-center relative">
                        {s.imageUrl ? (
                          <>
                            <img src={s.imageUrl} alt="" className="w-full h-full object-contain" />
                            <button
                              title="Remove image (use built-in)"
                              onClick={(e) => {
                                e.stopPropagation();
                                update(i, { imageUrl: "" });
                              }}
                              className="absolute top-1 right-1 bg-black/60 text-white rounded-full p-1"
                            >
                              <X size={12} />
                            </button>
                          </>
                        ) : (
                          <span className="text-[11px] text-muted-foreground text-center px-2">Built-in picture</span>
                        )}
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          pickImage(i);
                        }}
                        disabled={uploading !== null}
                        className="mt-2 w-[120px] flex items-center justify-center gap-1.5 text-xs font-semibold px-2 py-1.5 rounded-lg border border-border hover:bg-secondary disabled:opacity-50"
                      >
                        <ImagePlus size={13} /> {uploading === i ? `${Math.round(progress)}%` : s.imageUrl ? "Replace" : "Upload"}
                      </button>
                    </div>
                    <div className="space-y-3">
                      <div>
                        <label className={label}>Title</label>
                        <input
                          className={field}
                          value={s.title}
                          maxLength={TITLE_MAX}
                          placeholder="e.g. Photo & video battles"
                          onChange={(e) => update(i, { title: e.target.value })}
                        />
                        <p className="text-[11px] text-muted-foreground mt-1 text-right">{s.title.length}/{TITLE_MAX}</p>
                      </div>
                      <div>
                        <label className={label}>Description</label>
                        <textarea
                          className={`${field} min-h-[72px]`}
                          value={s.description}
                          maxLength={DESCRIPTION_MAX}
                          placeholder="One or two short sentences."
                          onChange={(e) => update(i, { description: e.target.value })}
                        />
                        <p className="text-[11px] text-muted-foreground mt-1 text-right">{s.description.length}/{DESCRIPTION_MAX}</p>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {problems.length > 0 && (
              <ul className="mt-4 text-xs text-red-600 space-y-1">
                {problems.map((p) => <li key={p}>{p}</li>)}
              </ul>
            )}
            <p className="text-[11px] text-muted-foreground mt-4">
              Images: square works best (e.g. 1080×1080), JPEG/PNG/WebP, up to 5 MB, transparent PNG looks best on dark mode.
              Keep titles short; the app shows them large.
            </p>
          </div>
        </div>

        {/* Preview */}
        <div className="bg-card border border-border rounded-2xl p-5 h-fit xl:sticky xl:top-4">
          <div className="flex items-center gap-2 mb-3">
            <Smartphone size={15} />
            <h3 className="font-bold text-sm">Preview</h3>
            {!enabled && <span className="text-[11px] text-red-600 font-semibold ml-auto">Off — not shown</span>}
          </div>
          <div className="mx-auto w-[260px] h-[500px] rounded-[32px] border-4 border-foreground/80 bg-white text-[#212121] flex flex-col overflow-hidden">
            <div className="flex-1 flex flex-col items-center justify-center px-5 text-center">
              <div className="w-[150px] h-[150px] rounded-2xl bg-[#FEF1F3] flex items-center justify-center overflow-hidden mb-4">
                {preview.imageUrl ? (
                  <img src={preview.imageUrl} alt="" className="w-full h-full object-contain" />
                ) : (
                  <span className="text-[11px] text-[#FF4D67] px-3">Built-in picture</span>
                )}
              </div>
              <div className="font-bold text-lg leading-tight">{preview.title || "Title"}</div>
              <div className="text-xs text-[#616161] mt-2 leading-relaxed">{preview.description}</div>
            </div>
            <div className="px-5 pb-6">
              <div className="flex justify-center gap-1 mb-4">
                {previewSlides.map((_, i) => (
                  <span
                    key={i}
                    className={`h-1.5 rounded-full ${i === Math.min(selected, previewSlides.length - 1) ? "w-5 bg-[#FF4D67]" : "w-1.5 bg-[#E0E0E0]"}`}
                  />
                ))}
              </div>
              <div className="h-10 rounded-full bg-[#FF4D67] text-white text-sm font-bold flex items-center justify-center">
                {selected >= previewSlides.length - 1 ? "Get Started" : "Next"}
              </div>
              <div className="h-10 mt-2 rounded-full bg-[#FEF1F3] text-[#FF4D67] text-sm font-bold flex items-center justify-center">Skip</div>
              <div className="text-[11px] text-center text-[#616161] mt-2">
                Already have an account? <span className="text-[#FF4D67] font-bold">Log in</span>
              </div>
            </div>
          </div>
          <div className="flex justify-center gap-2 mt-3">
            <IconBtn title="Previous slide" onClick={() => setSelected((s) => Math.max(0, s - 1))}><ArrowUp size={14} className="-rotate-90" /></IconBtn>
            <IconBtn title="Next slide" onClick={() => setSelected((s) => Math.min(previewSlides.length - 1, s + 1))}><ArrowDown size={14} className="-rotate-90" /></IconBtn>
          </div>
        </div>
      </div>
    </div>
  );
}

function IconBtn({
  children,
  onClick,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title: string;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="p-1.5 rounded-lg border border-border hover:bg-secondary disabled:opacity-40"
    >
      {children}
    </button>
  );
}
