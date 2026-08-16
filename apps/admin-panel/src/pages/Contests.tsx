import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type AdminContest,
  type ContestStatus,
  type ContestType,
  type ContestWritePayload,
} from "@/lib/api";
import { Table } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { StatCard } from "@/components/ui/StatCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PageHeader, fmtDate, fmtNumber } from "@/lib/format";
import { useConfirm } from "@/components/ConfirmDialog";
import { toast } from "@/lib/toast";
import {
  AlertCircle,
  Clock3,
  Copy,
  Image as ImageIcon,
  Loader2,
  Pencil,
  Plus,
  Radio,
  RefreshCw,
  Search,
  Swords,
  Trash2,
  Trophy,
  Upload,
  X,
} from "lucide-react";

const CONTEST_STATUSES: ContestStatus[] = ["live", "upcoming", "paused", "ended"];
const MAX_BANNER_BYTES = 5 * 1024 * 1024;
const BANNER_TYPES = ["image/jpeg", "image/png", "image/webp"];

type DialogMode = "create" | "edit" | "duplicate";
type DialogState = { mode: DialogMode; contest?: AdminContest } | null;
type StatusFilter = ContestStatus | "all";
type TypeFilter = ContestType | "all";

const statusLabels: Record<ContestStatus, string> = {
  live: "Live",
  upcoming: "Upcoming",
  paused: "Paused",
  ended: "Ended",
};

export default function Contests() {
  const qc = useQueryClient();
  const { confirm } = useConfirm();
  const [dialog, setDialog] = useState<DialogState>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [pendingStatusIds, setPendingStatusIds] = useState<Set<string>>(new Set());
  const [statusOverrides, setStatusOverrides] = useState<Record<string, ContestStatus>>({});
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(new Set());

  const contestsQuery = useQuery({ queryKey: ["contests"], queryFn: api.contests });
  const contests = contestsQuery.data ?? [];
  const invalidate = () => qc.invalidateQueries({ queryKey: ["contests"] });

  const stats = useMemo(
    () => ({
      total: contests.length,
      live: contests.filter((contest) => contest.status === "live").length,
      upcoming: contests.filter((contest) => contest.status === "upcoming").length,
      openMatches: contests.reduce(
        (sum, contest) => sum + Number(contest.waitingMatches || 0) + Number(contest.activeMatches || 0),
        0,
      ),
    }),
    [contests],
  );

  const filteredContests = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return contests.filter((contest) => {
      const effectiveStatus = statusOverrides[contest.id] ?? contest.status;
      const matchesSearch =
        !needle ||
        (contest.title || contest.name || "").toLowerCase().includes(needle) ||
        (contest.description || "").toLowerCase().includes(needle);
      return (
        matchesSearch &&
        (statusFilter === "all" || effectiveStatus === statusFilter) &&
        (typeFilter === "all" || contest.type === typeFilter)
      );
    });
  }, [contests, search, statusFilter, statusOverrides, typeFilter]);

  const updateStatus = async (contest: AdminContest, status: ContestStatus) => {
    if (status === (statusOverrides[contest.id] ?? contest.status)) return;
    if (contest.status === "live" && status !== "live" && contest.waitingMatches > 0) {
      toast.warning("Resolve or cancel waiting matches before moving this live contest.");
      return;
    }

    setPendingStatusIds((current) => new Set(current).add(contest.id));
    setStatusOverrides((current) => ({ ...current, [contest.id]: status }));
    try {
      await api.updateContest(contest.id, { status });
      await invalidate();
      toast.success("Contest status updated");
    } catch (error) {
      setStatusOverrides((current) => {
        const next = { ...current };
        delete next[contest.id];
        return next;
      });
      toast.error(error instanceof Error ? error.message : "Could not update contest status.");
    } finally {
      setPendingStatusIds((current) => {
        const next = new Set(current);
        next.delete(contest.id);
        return next;
      });
      setStatusOverrides((current) => {
        const next = { ...current };
        delete next[contest.id];
        return next;
      });
    }
  };

  const deleteReason = (contest: AdminContest): string | null => {
    if (contest.status === "live") return "Move this contest out of Live before deleting it.";
    if (contest.waitingMatches > 0 || contest.activeMatches > 0) {
      return "Contests with waiting or active matches cannot be deleted.";
    }
    return null;
  };

  const deleteContest = async (contest: AdminContest) => {
    const reason = deleteReason(contest);
    if (reason) {
      toast.warning(reason);
      return;
    }
    const approved = await confirm({
      title: "Delete contest?",
      description: `Delete “${contest.title || contest.name || "Untitled contest"}”? Its owned banner will also be removed when it is no longer used. This cannot be undone.`,
      confirmLabel: "Delete contest",
      variant: "destructive",
    });
    if (!approved) return;

    setPendingDeleteIds((current) => new Set(current).add(contest.id));
    try {
      await api.deleteContest(contest.id);
      await invalidate();
      toast.success("Contest deleted");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not delete contest.");
    } finally {
      setPendingDeleteIds((current) => {
        const next = new Set(current);
        next.delete(contest.id);
        return next;
      });
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Contests"
        subtitle="Create, publish, and safely manage photo and video contests"
        action={
          <Button
            onClick={() => setDialog({ mode: "create" })}
            className="gradient-purple border-0 text-white shadow-lg hover:opacity-95"
          >
            <Plus /> New Contest
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
        <StatCard icon={Trophy} label="Total contests" value={stats.total} gradient="bg-gradient-to-br from-violet-500 to-purple-700" />
        <StatCard icon={Radio} label="Live now" value={stats.live} gradient="bg-gradient-to-br from-emerald-500 to-green-700" />
        <StatCard icon={Clock3} label="Upcoming" value={stats.upcoming} gradient="bg-gradient-to-br from-amber-400 to-orange-600" />
        <StatCard icon={Swords} label="Open matches" value={stats.openMatches} gradient="bg-gradient-to-br from-cyan-500 to-blue-700" />
      </div>

      <div className="rounded-2xl border border-border bg-card p-4">
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_180px_180px]">
          <label className="relative block">
            <span className="sr-only">Search contests</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search title or description…"
              className="h-10 pl-9"
            />
          </label>
          <label>
            <span className="sr-only">Filter by status</span>
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="all">All statuses</option>
              {CONTEST_STATUSES.map((status) => <option key={status} value={status}>{statusLabels[status]}</option>)}
            </select>
          </label>
          <label>
            <span className="sr-only">Filter by type</span>
            <select
              value={typeFilter}
              onChange={(event) => setTypeFilter(event.target.value as TypeFilter)}
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            >
              <option value="all">All types</option>
              <option value="photo">Photo</option>
              <option value="video">Video</option>
            </select>
          </label>
        </div>
        {(search || statusFilter !== "all" || typeFilter !== "all") && (
          <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>{filteredContests.length} of {contests.length} contests</span>
            <button
              type="button"
              className="font-medium text-primary hover:underline"
              onClick={() => {
                setSearch("");
                setStatusFilter("all");
                setTypeFilter("all");
              }}
            >
              Clear filters
            </button>
          </div>
        )}
      </div>

      {contestsQuery.isError ? (
        <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-8 text-center">
          <AlertCircle className="mx-auto mb-3 size-8 text-destructive" />
          <h3 className="font-semibold text-foreground">Could not load contests</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {contestsQuery.error instanceof Error ? contestsQuery.error.message : "Please check your connection and try again."}
          </p>
          <Button variant="outline" className="mt-4" onClick={() => contestsQuery.refetch()} disabled={contestsQuery.isFetching}>
            <RefreshCw className={contestsQuery.isFetching ? "animate-spin" : ""} /> Retry
          </Button>
        </div>
      ) : (
        <Table
          loading={contestsQuery.isLoading}
          data={filteredContests}
          keyFn={(contest) => contest.id}
          empty={contests.length ? "No contests match these filters" : "No contests yet — create your first contest"}
          columns={[
            {
              key: "contest",
              header: "Contest",
              render: (contest) => (
                <div className="flex min-w-56 items-center gap-3">
                  <div className="flex h-12 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-secondary">
                    {contest.bannerUrl ? (
                      <img src={contest.bannerUrl} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <ImageIcon className="size-5 text-muted-foreground" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="max-w-64 truncate font-semibold text-foreground">{contest.title || contest.name || "Untitled"}</p>
                    <p className="max-w-64 truncate text-xs text-muted-foreground">{contest.description || "No description"}</p>
                  </div>
                </div>
              ),
            },
            {
              key: "type",
              header: "Type",
              render: (contest) => <Badge variant={contest.type === "video" ? "video" : "info"}>{contest.type}</Badge>,
            },
            {
              key: "status",
              header: "Status",
              render: (contest) => {
                const pending = pendingStatusIds.has(contest.id);
                return (
                  <div className="flex items-center gap-2">
                    <select
                      aria-label={`Status for ${contest.title || "contest"}`}
                      value={statusOverrides[contest.id] ?? contest.status}
                      disabled={pending}
                      onChange={(event) => void updateStatus(contest, event.target.value as ContestStatus)}
                      className="rounded-lg border border-border bg-card px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
                    >
                      {CONTEST_STATUSES.map((status) => <option key={status} value={status}>{statusLabels[status]}</option>)}
                    </select>
                    {pending && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
                  </div>
                );
              },
            },
            {
              key: "economy",
              header: "Entry / Reward",
              render: (contest) => (
                <div className="whitespace-nowrap text-sm">
                  <span className="font-medium">{fmtNumber(contest.totalEntryFee)}</span>
                  <span className="mx-1.5 text-muted-foreground">/</span>
                  <span>{fmtNumber(contest.rewardCoins)}</span>
                </div>
              ),
            },
            {
              key: "matches",
              header: "Matches",
              render: (contest) => (
                <div className="whitespace-nowrap text-xs">
                  <span className="font-semibold text-foreground">{fmtNumber(contest.totalMatches)}</span>
                  <span className="ml-1 text-muted-foreground">total</span>
                  {(contest.waitingMatches > 0 || contest.activeMatches > 0) && (
                    <p className="mt-0.5 text-muted-foreground">{contest.waitingMatches} waiting · {contest.activeMatches} active</p>
                  )}
                </div>
              ),
            },
            {
              key: "policy",
              header: "Timing",
              render: (contest) => (
                <div className="whitespace-nowrap text-xs text-muted-foreground">
                  <p>{contest.voteDurationDays}d voting</p>
                  <p>{contest.autoCancelHours}h wait limit</p>
                </div>
              ),
            },
            {
              key: "created",
              header: "Created",
              render: (contest) => <span className="whitespace-nowrap text-muted-foreground">{fmtDate(contest.createdAt)}</span>,
            },
            {
              key: "actions",
              header: "",
              className: "text-right",
              render: (contest) => {
                const reason = deleteReason(contest);
                const deleting = pendingDeleteIds.has(contest.id);
                return (
                  <div className="flex items-center justify-end gap-1">
                    <button
                      type="button"
                      title="Duplicate"
                      aria-label={`Duplicate ${contest.title || "contest"}`}
                      onClick={() => setDialog({ mode: "duplicate", contest })}
                      className="rounded-lg p-2 text-muted-foreground hover:bg-secondary hover:text-foreground"
                    >
                      <Copy className="size-4" />
                    </button>
                    <button
                      type="button"
                      title="Edit"
                      aria-label={`Edit ${contest.title || "contest"}`}
                      onClick={() => setDialog({ mode: "edit", contest })}
                      className="rounded-lg p-2 text-muted-foreground hover:bg-secondary hover:text-foreground"
                    >
                      <Pencil className="size-4" />
                    </button>
                    <button
                      type="button"
                      title={reason || "Delete"}
                      aria-label={`Delete ${contest.title || "contest"}`}
                      disabled={!!reason || deleting}
                      onClick={() => void deleteContest(contest)}
                      className="rounded-lg p-2 text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-35"
                    >
                      {deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                    </button>
                  </div>
                );
              },
            },
          ]}
        />
      )}

      {dialog && (
        <ContestDialog
          key={`${dialog.mode}-${dialog.contest?.id ?? "new"}`}
          mode={dialog.mode}
          contest={dialog.contest}
          onClose={() => setDialog(null)}
          onDone={invalidate}
        />
      )}
    </div>
  );
}

type ContestFormState = {
  title: string;
  description: string;
  rules: string;
  type: ContestType;
  status: ContestStatus;
  bannerUrl: string;
  totalEntryFee: string;
  rewardCoins: string;
  voteDurationDays: string;
  autoCancelHours: string;
  minVotes: string;
};

type ContestFormErrors = Partial<Record<keyof ContestFormState | "banner", string>>;

function formFromContest(contest: AdminContest | undefined, mode: DialogMode): ContestFormState {
  const duplicate = mode === "duplicate";
  return {
    title: contest ? `${contest.title || contest.name || "Untitled"}${duplicate ? " (copy)" : ""}` : "",
    description: contest?.description || "",
    rules: contest?.rules || "",
    type: contest?.type || "photo",
    status: duplicate ? "upcoming" : contest?.status || "upcoming",
    bannerUrl: contest?.bannerUrl || "",
    totalEntryFee: String(contest?.totalEntryFee ?? 0),
    rewardCoins: String(contest?.rewardCoins ?? 0),
    voteDurationDays: String(contest?.voteDurationDays ?? 1),
    autoCancelHours: String(contest?.autoCancelHours ?? 24),
    minVotes: String(contest?.minVotes ?? 0),
  };
}

function ContestDialog({
  mode,
  contest,
  onClose,
  onDone,
}: {
  mode: DialogMode;
  contest?: AdminContest;
  onClose: () => void;
  onDone: () => Promise<unknown>;
}) {
  const { confirm } = useConfirm();
  const initialForm = useRef(formFromContest(contest, mode));
  const [form, setForm] = useState<ContestFormState>(initialForm.current);
  const [errors, setErrors] = useState<ContestFormErrors>({});
  const [bannerFile, setBannerFile] = useState<File | null>(null);
  const [localPreview, setLocalPreview] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const isEdit = mode === "edit";
  const isDirty = JSON.stringify(form) !== JSON.stringify(initialForm.current) || bannerFile !== null;
  const bannerPreview = localPreview || form.bannerUrl || null;

  useEffect(() => () => {
    if (localPreview) URL.revokeObjectURL(localPreview);
  }, [localPreview]);

  const set = <K extends keyof ContestFormState>(key: K, value: ContestFormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
    setSubmitError(null);
  };

  const requestClose = async () => {
    if (saving) return;
    if (isDirty) {
      const discard = await confirm({
        title: "Discard unsaved changes?",
        description: "Your contest changes and selected local image will be lost.",
        confirmLabel: "Discard changes",
        variant: "destructive",
      });
      if (!discard) return;
    }
    onClose();
  };

  const selectBanner = (file: File | undefined) => {
    if (!file) return;
    if (!BANNER_TYPES.includes(file.type)) {
      setErrors((current) => ({ ...current, banner: "Choose a JPEG, PNG, or WebP image." }));
      return;
    }
    if (file.size > MAX_BANNER_BYTES) {
      setErrors((current) => ({ ...current, banner: "Image must be 5 MB or smaller." }));
      return;
    }
    setBannerFile(file);
    setLocalPreview(URL.createObjectURL(file));
    setErrors((current) => ({ ...current, banner: undefined }));
    setSubmitError(null);
    setUploadProgress(0);
  };

  const removeBanner = () => {
    setBannerFile(null);
    setLocalPreview(null);
    set("bannerUrl", "");
    setUploadProgress(0);
  };

  const validate = (): { errors: ContestFormErrors; payload: ContestWritePayload | null } => {
    const next: ContestFormErrors = {};
    const title = form.title.trim();
    if (!title) next.title = "Title is required.";
    else if (title.length > 160) next.title = "Title must be 160 characters or fewer.";
    if (form.description.length > 1000) next.description = "Description must be 1,000 characters or fewer.";
    if (form.rules.length > 5000) next.rules = "Rules must be 5,000 characters or fewer.";
    if (!bannerFile && !form.bannerUrl && (!isEdit || form.status === "live")) {
      next.banner = isEdit ? "A live contest must have a banner." : "A banner image is required.";
    }

    const integer = (key: keyof ContestFormState, label: string, min: number, max: number) => {
      const value = Number(form[key]);
      if (!form[key].trim() || !Number.isInteger(value) || value < min || value > max) {
        next[key] = `${label} must be a whole number from ${fmtNumber(min)} to ${fmtNumber(max)}.`;
      }
      return value;
    };

    const totalEntryFee = integer("totalEntryFee", "Entry fee", 0, 1_000_000);
    const rewardCoins = integer("rewardCoins", "Reward coins", 0, 10_000_000);
    const voteDurationDays = integer("voteDurationDays", "Vote duration", 1, 30);
    const autoCancelHours = integer("autoCancelHours", "Waiting auto-cancel", 1, 168);
    const minVotes = integer("minVotes", "Minimum votes", 0, 1_000_000);

    if (Object.values(next).some(Boolean)) return { errors: next, payload: null };
    return {
      errors: next,
      payload: {
        title,
        description: form.description.trim() || null,
        rules: form.rules.trim() || null,
        type: form.type,
        status: form.status,
        bannerUrl: form.bannerUrl || null,
        totalEntryFee,
        rewardCoins,
        voteDurationDays,
        autoCancelHours,
        minVotes,
      },
    };
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    const result = validate();
    setErrors(result.errors);
    if (!result.payload) return;

    setSaving(true);
    setSubmitError(null);
    let uploadedUrl: string | null = null;
    try {
      const payload = { ...result.payload };
      if (bannerFile) {
        setUploading(true);
        const uploaded = await api.uploadContestBanner(bannerFile, setUploadProgress);
        uploadedUrl = uploaded.publicUrl;
        payload.bannerUrl = uploaded.publicUrl;
        setUploading(false);
      }

      if (isEdit && contest) {
        // Send only fields this dialog actually changed. Besides reducing write
        // noise, this prevents a stale editor snapshot from restoring an old
        // banner after another admin has replaced it.
        const initial = initialForm.current;
        const initialPayload: ContestWritePayload = {
          title: initial.title.trim(),
          description: initial.description.trim() || null,
          rules: initial.rules.trim() || null,
          type: initial.type,
          status: initial.status,
          bannerUrl: initial.bannerUrl || null,
          totalEntryFee: Number(initial.totalEntryFee),
          rewardCoins: Number(initial.rewardCoins),
          voteDurationDays: Number(initial.voteDurationDays),
          autoCancelHours: Number(initial.autoCancelHours),
          minVotes: Number(initial.minVotes),
        };
        const patch: Partial<ContestWritePayload> = {};
        for (const key of Object.keys(payload) as Array<keyof ContestWritePayload>) {
          if (payload[key] !== initialPayload[key]) (patch as Record<string, unknown>)[key] = payload[key];
        }
        if (!Object.keys(patch).length) {
          toast.info("No contest changes to save");
          onClose();
          return;
        }
        await api.updateContest(contest.id, patch);
      } else {
        await api.createContest(payload);
      }

      await onDone();
      toast.success(isEdit ? "Contest updated" : mode === "duplicate" ? "Contest duplicated" : "Contest created");
      onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save contest.";
      setSubmitError(message);
      toast.error(message);
      if (uploadedUrl) {
        try {
          await api.deleteContestBanner(uploadedUrl);
        } catch {
          toast.warning("The contest was not saved and its temporary banner could not be removed automatically.");
        }
      }
    } finally {
      setUploading(false);
      setSaving(false);
    }
  };

  const title = isEdit ? "Edit contest" : mode === "duplicate" ? "Duplicate contest" : "Create contest";

  return (
    <Dialog open onOpenChange={(open) => { if (!open) void requestClose(); }}>
      <DialogContent
        className="left-0 top-0 flex h-[100dvh] max-h-[100dvh] w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0 shadow-none duration-0 sm:left-[50%] sm:top-[50%] sm:h-auto sm:max-h-[92dvh] sm:w-[calc(100%-2rem)] sm:max-w-3xl sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-lg sm:border sm:shadow-lg sm:duration-200"
        onEscapeKeyDown={(event) => { if (saving) event.preventDefault(); }}
        onPointerDownOutside={(event) => { if (saving) event.preventDefault(); }}
      >
        <DialogHeader className="shrink-0 border-b border-border px-5 pb-4 pr-12 pt-[max(1rem,env(safe-area-inset-top))] text-left sm:px-6 sm:py-4">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Upload a local JPEG, PNG, or WebP banner, then configure publishing, economy, and match rules.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="min-h-0 flex-1 space-y-6 overscroll-contain overflow-y-auto px-5 py-5 pb-8 [-webkit-overflow-scrolling:touch] sm:px-6">
            <section className="space-y-4">
              <FormSectionTitle title="Basics" description="How this contest appears to participants." />
              <Field label="Contest title" required error={errors.title} hint={`${form.title.length}/160`}>
                <Input
                  autoFocus
                  value={form.title}
                  maxLength={160}
                  disabled={saving}
                  onChange={(event) => set("title", event.target.value)}
                  placeholder="e.g. Best Monsoon Portrait"
                  aria-invalid={!!errors.title}
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Description" error={errors.description} hint={`${form.description.length}/1000`}>
                  <Textarea
                    value={form.description}
                    maxLength={1000}
                    disabled={saving}
                    onChange={(event) => set("description", event.target.value)}
                    placeholder="Short participant-facing summary"
                    className="min-h-24"
                  />
                </Field>
                <Field label="Rules" error={errors.rules} hint={`${form.rules.length}/5000`}>
                  <Textarea
                    value={form.rules}
                    maxLength={5000}
                    disabled={saving}
                    onChange={(event) => set("rules", event.target.value)}
                    placeholder="Eligibility, content, and judging rules"
                    className="min-h-24"
                  />
                </Field>
              </div>
            </section>

            <section className="space-y-4 border-t border-border pt-5">
              <FormSectionTitle title="Contest banner" description="Local image only · JPEG, PNG, or WebP · maximum 5 MB." />
              <div className="grid gap-4 sm:grid-cols-[220px_minmax(0,1fr)]">
                <div className="flex aspect-[16/9] items-center justify-center overflow-hidden rounded-xl border border-dashed border-border bg-secondary">
                  {bannerPreview ? (
                    <img src={bannerPreview} alt="Contest banner preview" className="h-full w-full object-cover" />
                  ) : (
                    <div className="text-center text-muted-foreground">
                      <ImageIcon className="mx-auto mb-2 size-7" />
                      <span className="text-xs">No banner selected</span>
                    </div>
                  )}
                </div>
                <div className="flex flex-col justify-center gap-3">
                  <input
                    id="contest-banner-file"
                    type="file"
                    className="sr-only"
                    accept="image/jpeg,image/png,image/webp"
                    disabled={saving}
                    onChange={(event) => {
                      selectBanner(event.target.files?.[0]);
                      event.target.value = "";
                    }}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="outline" disabled={saving} asChild>
                      <label htmlFor="contest-banner-file" className="cursor-pointer">
                        <Upload /> {bannerPreview ? "Replace image" : "Choose image"}
                      </label>
                    </Button>
                    {bannerPreview && (
                      <Button type="button" variant="ghost" disabled={saving} onClick={removeBanner} className="text-destructive">
                        <X /> Remove
                      </Button>
                    )}
                  </div>
                  {bannerFile && (
                    <p className="text-xs text-muted-foreground">
                      {bannerFile.name} · {(bannerFile.size / 1024 / 1024).toFixed(2)} MB · uploads when you save
                    </p>
                  )}
                  {errors.banner && <p className="text-xs font-medium text-destructive">{errors.banner}</p>}
                  {uploading && (
                    <div className="space-y-1.5" aria-live="polite">
                      <div className="flex justify-between text-xs text-muted-foreground"><span>Uploading banner…</span><span>{uploadProgress}%</span></div>
                      <Progress value={uploadProgress} />
                    </div>
                  )}
                </div>
              </div>
            </section>

            <section className="space-y-4 border-t border-border pt-5">
              <FormSectionTitle title="Publishing" description="New contests default to Upcoming so you can review them before launch." />
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Contest type" required>
                  <select
                    value={form.type}
                    disabled={saving}
                    onChange={(event) => set("type", event.target.value as ContestType)}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  >
                    <option value="photo">Photo</option>
                    <option value="video">Video</option>
                  </select>
                </Field>
                <Field label="Status" required>
                  <select
                    value={form.status}
                    disabled={saving}
                    onChange={(event) => set("status", event.target.value as ContestStatus)}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  >
                    {CONTEST_STATUSES.map((status) => <option key={status} value={status}>{statusLabels[status]}</option>)}
                  </select>
                </Field>
              </div>
              {isEdit && contest && contest.status === "live" && form.status !== "live" && contest.waitingMatches > 0 && (
                <InlineWarning>There are {contest.waitingMatches} waiting matches. The Worker will not allow this live contest to change status until they are resolved.</InlineWarning>
              )}
            </section>

            <section className="space-y-4 border-t border-border pt-5">
              <FormSectionTitle title="Economy and match policy" description="All values must be whole numbers within the supported limits." />
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <NumberField label="Total entry fee" value={form.totalEntryFee} min={0} max={1_000_000} error={errors.totalEntryFee} disabled={saving} onChange={(value) => set("totalEntryFee", value)} />
                <NumberField label="Reward coins" value={form.rewardCoins} min={0} max={10_000_000} error={errors.rewardCoins} disabled={saving} onChange={(value) => set("rewardCoins", value)} />
                <NumberField label="Minimum votes" value={form.minVotes} min={0} max={1_000_000} error={errors.minVotes} disabled={saving} onChange={(value) => set("minVotes", value)} />
                <NumberField label="Vote duration (days)" value={form.voteDurationDays} min={1} max={30} error={errors.voteDurationDays} disabled={saving} onChange={(value) => set("voteDurationDays", value)} />
                <NumberField label="Waiting auto-cancel (hours)" value={form.autoCancelHours} min={1} max={168} error={errors.autoCancelHours} disabled={saving} onChange={(value) => set("autoCancelHours", value)} />
              </div>
              {isEdit && contest && contest.activeMatches > 0 && Number(form.rewardCoins) !== contest.rewardCoins && (
                <InlineWarning>Reward coins cannot change while {contest.activeMatches} matches are active.</InlineWarning>
              )}
              {isEdit && contest && contest.waitingMatches > 0 && Number(form.voteDurationDays) !== contest.voteDurationDays && (
                <InlineWarning>Vote duration cannot change while {contest.waitingMatches} matches are waiting.</InlineWarning>
              )}
            </section>

            {submitError && (
              <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
                <p className="font-medium">Contest was not saved</p>
                <p className="mt-0.5 text-xs">{submitError} Fix the issue or retry Save.</p>
              </div>
            )}
          </div>

          <DialogFooter className="shrink-0 flex-row gap-2 border-t border-border bg-background px-5 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-6 sm:py-4">
            <Button type="button" variant="secondary" disabled={saving} onClick={() => void requestClose()} className="flex-1">Cancel</Button>
            <Button type="submit" disabled={saving} className="gradient-purple flex-1 border-0 text-white">
              {saving && <Loader2 className="animate-spin" />}
              {uploading ? `Uploading ${uploadProgress}%` : saving ? "Saving…" : isEdit ? "Save changes" : mode === "duplicate" ? "Create duplicate" : "Create contest"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function FormSectionTitle({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

function Field({
  label,
  required,
  error,
  hint,
  children,
}: {
  label: string;
  required?: boolean;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="flex items-center justify-between gap-3 text-xs font-medium text-foreground">
        <span>{label}{required && <span className="ml-0.5 text-destructive">*</span>}</span>
        {hint && <span className="font-normal text-muted-foreground">{hint}</span>}
      </span>
      {children}
      {error && <span className="block text-xs font-medium text-destructive">{error}</span>}
    </label>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  error,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  min: number;
  max: number;
  error?: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label} required error={error} hint={`${fmtNumber(min)}–${fmtNumber(max)}`}>
      <Input
        type="number"
        step={1}
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        aria-invalid={!!error}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

function InlineWarning({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </div>
  );
}
