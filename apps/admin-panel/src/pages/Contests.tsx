import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  PRODUCT_DESCRIPTION_MAX,
  PRODUCT_TITLE_MAX,
  PRODUCT_VALUE_MAX,
  type AdminContest,
  type ContestStatus,
  type ContestType,
  type ContestWritePayload,
  type PrizeType,
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
  Coins,
  Copy,
  Image as ImageIcon,
  Loader2,
  Package,
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

/**
 * The Worker stores the validity window as epoch milliseconds, but
 * `<input type="datetime-local">` speaks LOCAL wall-clock with no offset
 * ("2026-09-01T18:30"). These two convert between them.
 *
 * `msToLocalInput` is deliberately not `toISOString().slice(0, 16)`. That
 * renders the UTC instant, so an admin in IST would open a contest that ends at
 * 23:00 local, be shown 17:30, and — by saving a form they never edited — move
 * the deadline five and a half hours earlier.
 */
const pad2 = (value: number) => String(value).padStart(2, "0");

function msToLocalInput(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "";
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/**
 * "" means unbounded and maps to null. An unparseable value returns NaN rather
 * than null so `validate` can report "that is not a date" instead of silently
 * clearing the field the admin was trying to set.
 */
function localInputToMs(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Date() treats an offset-less date-time string as local time, which is
  // exactly what this input means.
  return new Date(trimmed).getTime();
}

/** Coarse "2d 4h" / "in 3h" style gap, for at-a-glance list context. */
function humanGap(ms: number): string {
  const totalMinutes = Math.floor(Math.abs(ms) / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

type DialogMode = "create" | "edit" | "duplicate";
type DialogState = { mode: DialogMode; contest?: AdminContest; draftForm?: ContestFormState } | null;
type StatusFilter = ContestStatus | "all";
type TypeFilter = ContestType | "all";

const statusLabels: Record<ContestStatus, string> = {
  live: "Live",
  upcoming: "Upcoming",
  paused: "Paused",
  ended: "Ended",
};

/**
 * A contest being written is worth surviving a reload the admin never asked for.
 *
 * On mobile, tapping "Choose image" hands control to the OS picker and pushes the
 * tab to the background; Android Chrome routinely discards a backgrounded tab
 * under memory pressure, and returning from the picker then reloads the page —
 * taking the in-memory dialog and every field the admin had typed with it. The
 * product image already survives (it uploads on pick, leaving only a URL string),
 * but the title, rules, prize and economy fields did not, so the admin came back
 * to a blank contests list and assumed the app had crashed.
 *
 * We snapshot the form to `sessionStorage` while it is dirty and reopen the dialog
 * with it after the reload. Only the serialisable form state is kept — the banner
 * `File` (held until Save) cannot be, so a banner picked-but-not-yet-saved must be
 * re-chosen, which the UI already prompts for. `sessionStorage` (not local) scopes
 * the draft to this tab and clears itself when the tab really closes.
 */
const CONTEST_DRAFT_KEY = "tophunt:contest-draft-v1";
/** A tab discarded mid-edit is resumed in seconds; an older draft is abandoned. */
const CONTEST_DRAFT_TTL_MS = 6 * 60 * 60 * 1000;

type ContestDraft = { mode: DialogMode; contestId: string | null; savedAt: number; form: ContestFormState };

function readContestDraft(): ContestDraft | null {
  try {
    const raw = sessionStorage.getItem(CONTEST_DRAFT_KEY);
    if (!raw) return null;
    const draft = JSON.parse(raw) as ContestDraft;
    if (!draft || typeof draft !== "object" || !draft.form || !draft.mode) return null;
    if (!Number.isFinite(draft.savedAt) || Date.now() - draft.savedAt > CONTEST_DRAFT_TTL_MS) {
      sessionStorage.removeItem(CONTEST_DRAFT_KEY);
      return null;
    }
    return draft;
  } catch {
    // Corrupt JSON or storage disabled (private mode): treat as no draft.
    return null;
  }
}

function writeContestDraft(draft: ContestDraft): void {
  // A lost draft is never worth throwing over (quota, private mode, etc.).
  try { sessionStorage.setItem(CONTEST_DRAFT_KEY, JSON.stringify(draft)); } catch { /* ignore */ }
}

function clearContestDraft(): void {
  try { sessionStorage.removeItem(CONTEST_DRAFT_KEY); } catch { /* ignore */ }
}

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

  // Reopen a draft left behind by a reload the admin did not ask for (see
  // CONTEST_DRAFT_KEY). Runs once: a `create` draft can reopen immediately, while
  // `edit`/`duplicate` wait for the list so the live contest row can be attached.
  const draftRestoredRef = useRef(false);
  useEffect(() => {
    if (draftRestoredRef.current) return;
    const draft = readContestDraft();
    if (!draft) {
      draftRestoredRef.current = true;
      return;
    }
    if (draft.mode === "create") {
      draftRestoredRef.current = true;
      setDialog({ mode: "create", draftForm: draft.form });
      toast.info("Restored your unsaved contest draft.");
      return;
    }
    // The edit/duplicate dialog needs the real contest for its baseline diff and
    // its live warnings, so hold off until the list has actually loaded.
    if (contestsQuery.isLoading) return;
    draftRestoredRef.current = true;
    const contest = contests.find((item) => item.id === draft.contestId);
    if (contest) {
      setDialog({ mode: draft.mode, contest, draftForm: draft.form });
      toast.info("Restored your unsaved contest draft.");
    } else {
      // The contest it referenced is gone (deleted, or another admin's tab).
      clearContestDraft();
    }
  }, [contests, contestsQuery.isLoading]);

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
              header: "Entry / Prize",
              // A product contest pays 0 coins, so rendering only the coin figure
              // showed "500 / 0" and read as a misconfigured contest.
              render: (contest) => (
                <div className="whitespace-nowrap text-sm">
                  <span className="font-medium">{fmtNumber(contest.totalEntryFee)}</span>
                  <span className="mx-1.5 text-muted-foreground">/</span>
                  {contest.prizeType === "product" ? (
                    <span className="inline-flex max-w-40 items-center gap-1 align-middle" title={contest.prizeProductTitle || "Product prize"}>
                      <Package className="size-3.5 shrink-0 text-violet-600" />
                      <span className="truncate text-xs font-medium">{contest.prizeProductTitle || "Product"}</span>
                    </span>
                  ) : (
                    <span>{fmtNumber(contest.rewardCoins)}</span>
                  )}
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
              key: "validity",
              header: "Validity",
              render: (contest) => {
                const nowMs = Date.now();
                const { startsAt, endsAt } = contest;
                if (startsAt === null && endsAt === null) {
                  return <span className="whitespace-nowrap text-xs text-muted-foreground">Always open</span>;
                }
                const notYetOpen = startsAt !== null && startsAt > nowMs;
                const expired = endsAt !== null && endsAt <= nowMs;
                return (
                  <div className="whitespace-nowrap text-xs">
                    {startsAt !== null && (
                      <p className={notYetOpen ? "font-medium text-amber-600" : "text-muted-foreground"}>
                        {notYetOpen ? `Opens in ${humanGap(startsAt - nowMs)}` : `From ${fmtDate(startsAt)}`}
                      </p>
                    )}
                    {endsAt !== null && (
                      <p className={expired ? "font-medium text-destructive" : "text-muted-foreground"}>
                        {expired ? `Expired ${humanGap(nowMs - endsAt)} ago` : `Ends in ${humanGap(endsAt - nowMs)}`}
                      </p>
                    )}
                    {/* The cron leaves a contest Live while it still has waiting
                        matches, so "expired but Live" is a real and temporary
                        state. Surfaced because it otherwise looks like a bug. */}
                    {expired && (statusOverrides[contest.id] ?? contest.status) === "live" && (
                      <p className="mt-0.5 text-muted-foreground">
                        {contest.waitingMatches > 0
                          ? `Closing after ${contest.waitingMatches} waiting`
                          : "Closing on next sweep"}
                      </p>
                    )}
                  </div>
                );
              },
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
          draftForm={dialog.draftForm}
          onClose={() => {
            // Every close path — Save, Cancel, discard — routes through here, so
            // clearing the draft in one place covers them all. A tab-discard
            // reload never reaches this, which is exactly why the draft survives.
            clearContestDraft();
            setDialog(null);
          }}
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
  /** datetime-local strings; "" means unbounded. */
  startsAt: string;
  endsAt: string;
  prizeType: PrizeType;
  prizeProductTitle: string;
  prizeProductImageUrl: string;
  prizeProductValue: string;
  prizeProductDescription: string;
};

type ContestFormErrors = Partial<Record<keyof ContestFormState | "banner" | "productImage", string>>;

function formFromContest(contest: AdminContest | undefined, mode: DialogMode): ContestFormState {
  const duplicate = mode === "duplicate";
  // A duplicate inherits the window, but never an already-lapsed one: the Worker
  // rejects creating a contest that is born expired, and silently carrying a
  // stale date over is how you get a confusing failure on Save.
  const inheritedEnd = contest?.endsAt ?? null;
  const staleWindow = duplicate && inheritedEnd !== null && inheritedEnd <= Date.now();
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
    startsAt: staleWindow ? "" : msToLocalInput(contest?.startsAt ?? null),
    endsAt: staleWindow ? "" : msToLocalInput(inheritedEnd),
    // A duplicate DOES inherit the product image URL. That is safe here where a
    // stale date is not: the R2 object is immutable and shared by reference, and
    // the Worker's delete refuses any image still attached to a contest, so two
    // contests pointing at one picture cannot leave either of them broken.
    prizeType: contest?.prizeType === "product" ? "product" : "coins",
    prizeProductTitle: contest?.prizeProductTitle || "",
    prizeProductImageUrl: contest?.prizeProductImageUrl || "",
    prizeProductValue: String(contest?.prizeProductValue ?? 0),
    prizeProductDescription: contest?.prizeProductDescription || "",
  };
}

function ContestDialog({
  mode,
  contest,
  draftForm,
  onClose,
  onDone,
}: {
  mode: DialogMode;
  contest?: AdminContest;
  /** A form snapshot restored after a reload; seeds the live state only. */
  draftForm?: ContestFormState;
  onClose: () => void;
  onDone: () => Promise<unknown>;
}) {
  // The baseline stays the clean contest values even when a draft is restored, so
  // the dirty check and the edit-time field diff still compare against what the
  // server actually has — the draft only pre-fills what the admin sees.
  const initialForm = useRef(formFromContest(contest, mode));
  const [form, setForm] = useState<ContestFormState>(draftForm ?? initialForm.current);
  const [errors, setErrors] = useState<ContestFormErrors>({});
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [productProgress, setProductProgress] = useState(0);
  const [uploadingProduct, setUploadingProduct] = useState(false);
  /**
   * Images uploaded by THIS dialog that are not yet referenced by a saved contest —
   * a banner or product image that was replaced, picked before switching prize type,
   * or picked and then cancelled. Cleaned up on close/save so a pick-then-cancel
   * never leaves an orphan object in R2.
   *
   * Refs, not state: they must survive the close handler without triggering a render,
   * and nothing displays them. The banner and product image now BOTH upload on pick
   * (see selectBanner / selectProductImage) — the banner used to hold a `File` until
   * Save, which did not survive the mobile tab-reload behind the file picker (the
   * "blank screen" report). Uploading on pick means the form only has to carry a URL
   * string, which the draft snapshot already persists.
   */
  const orphanBannerImages = useRef<string[]>([]);
  const orphanProductImages = useRef<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  /**
   * Discard confirmation is a LOCAL overlay inside this dialog, not the global
   * `useConfirm` (which is a second Radix modal). Stacking two Radix modals and then
   * unmounting this one as the other closed left the page blank/frozen on mobile —
   * the teardown of two overlapping focus-scopes + scroll-locks races. One modal
   * layer, one unmount, no race.
   */
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  const isEdit = mode === "edit";
  // Picking either image now changes `form` (the uploaded URL), so a plain form
  // comparison captures dirtiness — no separate File flag needed.
  const isDirty = JSON.stringify(form) !== JSON.stringify(initialForm.current);
  const isProduct = form.prizeType === "product";
  /** What the payload will actually carry — a product contest always pays 0 coins. */
  const effectiveRewardCoins = isProduct ? 0 : Number(form.rewardCoins);
  /**
   * The same three fields the Worker's PATCH guard treats as "the prize changed".
   * Value and description alone do not count there, so they do not count here — a
   * warning that fires on an edit the Worker allows is a warning admins learn to
   * ignore.
   */
  const prizeChanged =
    form.prizeType !== (contest?.prizeType === "product" ? "product" : "coins") ||
    (isProduct ? form.prizeProductTitle.trim() : "") !== (contest?.prizeProductTitle ?? "") ||
    (isProduct ? form.prizeProductImageUrl : "") !== (contest?.prizeProductImageUrl ?? "");

  // Snapshot the in-progress form so a reload the admin never asked for (a mobile
  // tab discarded behind the file picker) can restore it. Only while dirty, and
  // never mid-save: a save either clears the draft on success or, on failure,
  // leaves `saving` false and the still-dirty form re-persisted for a retry.
  useEffect(() => {
    if (saving || !isDirty) return;
    writeContestDraft({ mode, contestId: contest?.id ?? null, savedAt: Date.now(), form });
  }, [form, isDirty, saving, mode, contest]);

  const set = <K extends keyof ContestFormState>(key: K, value: ContestFormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
    setSubmitError(null);
  };

  /** Actually tear down: clean up orphan uploads, then unmount. */
  const performClose = async () => {
    setConfirmingDiscard(false);
    await discardOrphanImages(null, null);
    onClose();
  };

  const requestClose = () => {
    if (saving || confirmingDiscard) return;
    // An in-flight product upload is worth blocking on: closing mid-upload would
    // leave an object in R2 that the cleanup below has not been told about yet.
    if (uploadingProduct) {
      toast.info("Wait for the product image to finish uploading.");
      return;
    }
    // Unsaved work -> show the in-dialog confirmation (NOT a second modal). Clean
    // work -> close straight away.
    if (isDirty) {
      setConfirmingDiscard(true);
      return;
    }
    void performClose();
  };

  /**
   * Pick the contest banner and upload it IMMEDIATELY — the same robust flow the
   * product image uses. The banner used to be held as a `File` until Save, which did
   * not survive the page reload Android Chrome triggers when it evicts the tab behind
   * the file picker (the "blank screen" report, see #99). Uploading on pick means the
   * form only carries a URL string, which the draft snapshot already persists — so a
   * reload no longer loses the banner.
   */
  const selectBanner = async (file: File | undefined) => {
    if (!file) return;
    if (!BANNER_TYPES.includes(file.type)) {
      setErrors((current) => ({ ...current, banner: "Choose a JPEG, PNG, or WebP image." }));
      return;
    }
    if (file.size > MAX_BANNER_BYTES) {
      setErrors((current) => ({ ...current, banner: "Image must be 5 MB or smaller." }));
      return;
    }
    setErrors((current) => ({ ...current, banner: undefined }));
    setSubmitError(null);
    setUploadProgress(0);
    setUploading(true);
    try {
      const uploaded = await api.uploadContestBanner(file, setUploadProgress);
      orphanBannerImages.current.push(uploaded.publicUrl);
      set("bannerUrl", uploaded.publicUrl);
      toast.success("Banner uploaded");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Banner upload failed.";
      setErrors((current) => ({ ...current, banner: message }));
      toast.error(message);
    } finally {
      setUploading(false);
    }
  };

  const removeBanner = () => {
    set("bannerUrl", "");
    setUploadProgress(0);
  };

  /**
   * Pick a product image and upload it IMMEDIATELY — the same flow as the banner
   * (see selectBanner). Uploading on pick is what makes both images survive the
   * page reload Android Chrome triggers when it evicts the tab behind the file
   * picker: the form only has to carry a URL string, not a `File`, so the draft
   * snapshot restores it. No object URL is created either — the preview IS the
   * uploaded image — so there is no `blob:` handle to leak.
   *
   * Same pattern as the payment-QR upload on the Deposits page, and the same
   * trade-off: an image can exist in R2 before any contest references it.
   * `discardOrphanImages` covers Cancel and Save, but NOT a closed tab — and the
   * image categories have `retentionDays: null` with no background sweep, so a
   * genuinely abandoned upload persists. That is the cheaper of the two failures
   * (an invisible object costs almost nothing; losing the image an admin just
   * picked costs them the whole form), but it does want a server-side sweep
   * eventually.
   */
  const selectProductImage = async (file: File | undefined) => {
    if (!file) return;
    // Pre-checks against the Worker's own limits, so an oversized file is refused
    // here instead of after a 5 MB upload.
    if (!BANNER_TYPES.includes(file.type)) {
      setErrors((current) => ({ ...current, productImage: "Choose a JPEG, PNG, or WebP image." }));
      return;
    }
    if (file.size > MAX_BANNER_BYTES) {
      setErrors((current) => ({ ...current, productImage: "Image must be 5 MB or smaller." }));
      return;
    }

    setErrors((current) => ({ ...current, productImage: undefined }));
    setSubmitError(null);
    setProductProgress(0);
    setUploadingProduct(true);
    try {
      const uploaded = await api.uploadProductImage(file, setProductProgress);
      orphanProductImages.current.push(uploaded.publicUrl);
      set("prizeProductImageUrl", uploaded.publicUrl);
      toast.success("Product image uploaded");
    } catch (error) {
      // Surfaced next to the field AND as a toast. An upload that fails silently is
      // indistinguishable from one that is still running, and the admin's next move
      // would be to hit Save on a product prize with no image.
      const message = error instanceof Error ? error.message : "Product image upload failed.";
      setErrors((current) => ({ ...current, productImage: message }));
      toast.error(message);
    } finally {
      setUploadingProduct(false);
    }
  };

  const removeProductImage = () => {
    set("prizeProductImageUrl", "");
    setProductProgress(0);
  };

  /**
   * Delete any product image this dialog uploaded that no contest ended up
   * referencing — a replaced image, or one picked before the admin switched back to
   * Coins.
   *
   * Best-effort and silent: the Worker refuses to delete an image that IS attached to
   * a contest or a prize claim, so the worst case is a no-op, and a failed cleanup
   * must never block closing the dialog.
   */
  const discardOrphanImages = async (keepBanner: string | null, keepProduct: string | null) => {
    const staleBanners = orphanBannerImages.current.filter((url) => url && url !== keepBanner);
    const staleProducts = orphanProductImages.current.filter((url) => url && url !== keepProduct);
    orphanBannerImages.current = [];
    orphanProductImages.current = [];
    await Promise.all([
      ...staleBanners.map((url) => api.deleteContestBanner(url).catch(() => undefined)),
      ...staleProducts.map((url) => api.deleteProductImage(url).catch(() => undefined)),
    ]);
  };

  const validate = (): { errors: ContestFormErrors; payload: ContestWritePayload | null } => {
    const next: ContestFormErrors = {};
    const title = form.title.trim();
    if (!title) next.title = "Title is required.";
    else if (title.length > 160) next.title = "Title must be 160 characters or fewer.";
    if (form.description.length > 1000) next.description = "Description must be 1,000 characters or fewer.";
    if (form.rules.length > 5000) next.rules = "Rules must be 5,000 characters or fewer.";
    if (!form.bannerUrl && (!isEdit || form.status === "live")) {
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
    // A product contest pays no coins, so the coin field is not validated and not
    // read — the Worker forces it to 0 regardless, and validating a disabled field
    // would block a save on a number that is about to be discarded.
    const rewardCoins = isProduct ? 0 : integer("rewardCoins", "Reward coins", 0, 10_000_000);
    const voteDurationDays = integer("voteDurationDays", "Vote duration", 1, 30);
    const autoCancelHours = integer("autoCancelHours", "Waiting auto-cancel", 1, 168);
    const minVotes = integer("minVotes", "Minimum votes", 0, 1_000_000);

    // Product prize. These mirror the Worker's `assertProductPrize` so a bad prize
    // is caught before the banner and the product image are both uploaded.
    const productTitle = form.prizeProductTitle.trim();
    const productDescription = form.prizeProductDescription.trim();
    let productValue = 0;
    if (isProduct) {
      if (!productTitle) next.prizeProductTitle = "A product prize needs a product name.";
      else if (productTitle.length > PRODUCT_TITLE_MAX) {
        next.prizeProductTitle = `Product name must be ${fmtNumber(PRODUCT_TITLE_MAX)} characters or fewer.`;
      }
      // The image is required, not optional: it is the one field that makes a
      // physical prize believable, and it is shown on every card in the app.
      if (!form.prizeProductImageUrl) {
        next.productImage = "A product prize needs a product image.";
      }
      const raw = form.prizeProductValue.trim();
      productValue = raw === "" ? 0 : Number(raw);
      if (!Number.isInteger(productValue) || productValue < 0 || productValue > PRODUCT_VALUE_MAX) {
        next.prizeProductValue = `Product value must be a whole number from 0 to ${fmtNumber(PRODUCT_VALUE_MAX)}.`;
      }
      if (productDescription.length > PRODUCT_DESCRIPTION_MAX) {
        next.prizeProductDescription = `Product description must be ${fmtNumber(PRODUCT_DESCRIPTION_MAX)} characters or fewer.`;
      }
    }

    // Validity window. Empty is valid and means unbounded, so only a non-empty
    // value is ever checked. These mirror the Worker's own rules so the admin
    // gets the error next to the field instead of as a red banner after a
    // round-trip that may also have uploaded a banner.
    const startsAt = localInputToMs(form.startsAt);
    const endsAt = localInputToMs(form.endsAt);
    const timestamp = (key: "startsAt" | "endsAt", label: string, value: number | null) => {
      if (value === null) return;
      if (!Number.isFinite(value)) {
        next[key] = `${label} is not a valid date and time.`;
        return;
      }
      // The Worker rejects anything before 2001 as a seconds-vs-milliseconds
      // mistake, and no real contest is scheduled last century anyway.
      if (value < 1_000_000_000_000) next[key] = `${label} must be a date after 2001.`;
    };
    timestamp("startsAt", "Opens at", startsAt);
    timestamp("endsAt", "Closes at", endsAt);

    /**
     * A datetime-local input cannot express seconds, so a deadline set out of
     * band (a seed script, curl, the ISO alias) is truncated the moment the
     * dialog renders it. Re-parsing the truncated text would then diff as a
     * change and quietly pull the deadline up to 59s earlier on an edit that was
     * only meant to touch the title. If the field still displays the stored
     * value, send the stored value back unchanged.
     */
    const preserveUntouched = (key: 'startsAt' | 'endsAt', parsed: number | null): number | null => {
      const stored = contest?.[key] ?? null;
      if (stored === null) return parsed;
      return msToLocalInput(stored) === form[key] ? stored : parsed;
    };

    if (!next.startsAt && !next.endsAt) {
      if (startsAt !== null && endsAt !== null && endsAt <= startsAt) {
        next.endsAt = "Closing time must be after the opening time.";
      } else if (endsAt !== null && endsAt <= Date.now() && !isEdit) {
        // Only on create: ending a running contest early is a legitimate edit,
        // but a brand-new contest that is already expired would never appear in
        // the app at all.
        next.endsAt = "Closing time must be in the future.";
      }
    }

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
        startsAt: preserveUntouched('startsAt', startsAt),
        endsAt: preserveUntouched('endsAt', endsAt),
        prizeType: form.prizeType,
        // Cleared rather than carried when the prize is coins, so the payload says
        // what the contest is instead of leaving a previous product's name behind.
        // (The Worker nulls them too; sending them keeps the edit diff honest.)
        prizeProductTitle: isProduct ? productTitle : null,
        prizeProductImageUrl: isProduct ? form.prizeProductImageUrl || null : null,
        prizeProductValue: isProduct ? productValue : 0,
        prizeProductDescription: isProduct ? productDescription || null : null,
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
    try {
      // Both images already uploaded on pick, so `form.bannerUrl` /
      // `form.prizeProductImageUrl` are the final URLs — nothing to upload here.
      const payload = { ...result.payload };

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
          // The stored values, not the minute-truncated form text, so an
          // untouched window never shows up in the diff. Matches what
          // `preserveUntouched` puts in the payload.
          startsAt: contest.startsAt ?? localInputToMs(initial.startsAt),
          endsAt: contest.endsAt ?? localInputToMs(initial.endsAt),
          prizeType: initial.prizeType,
          prizeProductTitle: initial.prizeProductTitle.trim() || null,
          prizeProductImageUrl: initial.prizeProductImageUrl || null,
          prizeProductValue: Number(initial.prizeProductValue),
          prizeProductDescription: initial.prizeProductDescription.trim() || null,
        };
        const patch: Partial<ContestWritePayload> = {};
        for (const key of Object.keys(payload) as Array<keyof ContestWritePayload>) {
          if (payload[key] !== initialPayload[key]) (patch as Record<string, unknown>)[key] = payload[key];
        }
        /**
         * THE PRIZE IS SENT AS A WHOLE OR NOT AT ALL.
         *
         * A field-by-field diff is wrong for this one group, because the Worker does
         * not validate the prize field by field. `validateContestInput` treats
         * `prizeType: "product"` as "validate the product as a unit" and calls
         * `assertProductPrize` with whatever the body happens to contain — and an
         * absent key reads as `undefined`, which fails as a blank value. So a diff
         * carrying only the field that changed is exactly the payload it refuses:
         * renaming a product would 400 with "A product prize needs a product image."
         *
         * It also rejects any `prizeProduct*` field that arrives without `prizeType`
         * ("Include prizeType when changing product prize fields."), since it will
         * not guess whether a bare title means "rename the product" or "turn this
         * coin contest into a product one".
         *
         * Both rules are satisfied by the same move: if anything about the prize
         * changed, send all five keys.
         */
        const PRIZE_KEYS = [
          "prizeType",
          "prizeProductTitle",
          "prizeProductImageUrl",
          "prizeProductValue",
          "prizeProductDescription",
        ] as const;
        if (PRIZE_KEYS.some((key) => key in patch)) {
          for (const key of PRIZE_KEYS) (patch as Record<string, unknown>)[key] = payload[key];
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
      // The images the saved contest actually points at are kept; anything else this
      // dialog uploaded (a replaced banner/product image, or one picked before
      // switching prize type) is now unreferenced and removed.
      await discardOrphanImages(payload.bannerUrl, payload.prizeProductImageUrl);
      toast.success(isEdit ? "Contest updated" : mode === "duplicate" ? "Contest duplicated" : "Contest created");
      onClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save contest.";
      setSubmitError(message);
      toast.error(message);
      // Both images uploaded on pick and are tracked in the orphan refs, so a failed
      // save strands nothing: discardOrphanImages runs on close/cancel and removes any
      // image the eventually-saved contest does not reference.
    } finally {
      setUploading(false);
      setUploadingProduct(false);
      setSaving(false);
    }
  };

  const title = isEdit ? "Edit contest" : mode === "duplicate" ? "Duplicate contest" : "Create contest";

  return (
    <Dialog open onOpenChange={(open) => { if (!open) void requestClose(); }}>
      <DialogContent
        className="left-0 top-0 flex h-[100dvh] max-h-[100dvh] w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0 shadow-none duration-0 sm:left-[50%] sm:top-[50%] sm:h-auto sm:max-h-[92dvh] sm:w-[calc(100%-2rem)] sm:max-w-3xl sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-lg sm:border sm:shadow-lg sm:duration-200"
        // Never auto-dismiss on an OUTSIDE interaction. On mobile, returning from
        // the native file picker fires a focus/pointer-outside event that Radix
        // treats as "close the dialog" — which popped the "Discard unsaved changes?"
        // prompt (and, on the old build, a blank screen) on its own right after a
        // product-image upload. A form holding unsaved work must only close through
        // an explicit Cancel / ✕ / Escape, so the picker returning can never nuke it.
        // `onInteractOutside` covers BOTH pointer-outside and focus-outside; the old
        // handler only caught pointer-outside (and only while saving), which is why
        // the focus event from the picker slipped through.
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          if (!saving) requestClose();
        }}
      >
        {/* Discard confirmation — an overlay INSIDE this dialog, not a second modal. */}
        {confirmingDiscard && (
          <div
            className="absolute inset-0 z-20 flex items-center justify-center bg-black/50 p-6"
            role="alertdialog"
            aria-modal="true"
          >
            <div className="w-full max-w-sm rounded-2xl border border-border bg-background p-6 text-center shadow-xl">
              <h3 className="text-lg font-semibold text-foreground">Discard unsaved changes?</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                Your contest changes will be lost, and any product image you uploaded will be removed.
              </p>
              <div className="mt-5 flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => void performClose()}
                  className="w-full rounded-xl bg-destructive px-4 py-2.5 text-sm font-semibold text-destructive-foreground hover:bg-destructive/90"
                >
                  Discard changes
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDiscard(false)}
                  className="w-full rounded-xl border border-input px-4 py-2.5 text-sm font-medium hover:bg-accent"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

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
              <FormSectionTitle title="Contest banner" description="JPEG, PNG, or WebP · maximum 5 MB · uploads as soon as you pick it." />
              <ImageUploadField
                idPrefix="contest-banner"
                value={form.bannerUrl || null}
                uploading={uploading}
                progress={uploadProgress}
                error={errors.banner}
                disabled={saving}
                onPick={(file) => void selectBanner(file)}
                onRemove={removeBanner}
                aspectClass="aspect-[16/9]"
                previewGridClass="sm:grid-cols-[220px_minmax(0,1fr)]"
                placeholderIcon={ImageIcon}
                placeholderText="No banner selected"
                helpText="Uploads immediately, so it is not lost if your browser reloads. Shown on the contest card."
              />
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
              <FormSectionTitle
                title="Validity"
                description="When this contest is offered in the app. Leave a field empty for no limit. Times are in your own timezone."
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <DateTimeField
                  label="Opens at"
                  value={form.startsAt}
                  error={errors.startsAt}
                  disabled={saving}
                  hint="Empty = immediately"
                  onChange={(value) => set("startsAt", value)}
                  onClear={() => set("startsAt", "")}
                />
                <DateTimeField
                  label="Closes at"
                  value={form.endsAt}
                  error={errors.endsAt}
                  disabled={saving}
                  hint="Empty = never expires"
                  onChange={(value) => set("endsAt", value)}
                  onClear={() => set("endsAt", "")}
                  presets={[
                    { label: "+24h", hours: 24 },
                    { label: "+3d", hours: 72 },
                    { label: "+7d", hours: 168 },
                    { label: "+30d", hours: 720 },
                  ]}
                  onPreset={(hours) => set("endsAt", msToLocalInput(Date.now() + hours * 3_600_000))}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                A contest set to Live with a future opening time stays hidden until then — you do not have to flip the
                status by hand. Once the closing time passes it disappears from the app immediately and the status moves
                to Ended automatically.
              </p>
              {/* Users see a live countdown to this moment, so it is worth being
                  explicit that it is not the per-match voting timer below. */}
              {form.endsAt && !errors.endsAt && (
                <InlineNote>
                  Participants will see a countdown to {form.endsAt.replace("T", " ")}. This closes the contest itself —
                  the vote duration below still governs how long each individual battle runs.
                </InlineNote>
              )}
              {isEdit && contest && contest.endsAt !== null && contest.endsAt <= Date.now() && (
                <InlineWarning>
                  This contest has already passed its closing time, so the app is no longer offering it. Clear or extend
                  the closing time to bring it back.
                </InlineWarning>
              )}
            </section>

            <section className="space-y-4 border-t border-border pt-5">
              <FormSectionTitle
                title="Prize"
                description="A contest awards either coins or one physical product — never both."
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <PrizeTypeOption
                  selected={!isProduct}
                  disabled={saving}
                  icon={Coins}
                  title="Coins"
                  description="Credited to the winner's wallet on settlement. Capped by the entry-fee pot."
                  onSelect={() => set("prizeType", "coins")}
                />
                <PrizeTypeOption
                  selected={isProduct}
                  disabled={saving}
                  icon={Package}
                  title="Physical product"
                  description="The winner submits a delivery address and you ship it from the Prize Claims queue."
                  onSelect={() => set("prizeType", "product")}
                />
              </div>

              {isProduct && (
                <div className="space-y-4 rounded-xl border border-border bg-secondary/30 p-4">
                  <Field
                    label="Product name"
                    required
                    error={errors.prizeProductTitle}
                    hint={`${form.prizeProductTitle.length}/${PRODUCT_TITLE_MAX}`}
                  >
                    <Input
                      value={form.prizeProductTitle}
                      maxLength={PRODUCT_TITLE_MAX}
                      disabled={saving}
                      onChange={(event) => set("prizeProductTitle", event.target.value)}
                      placeholder="e.g. boAt Airdopes 141 Earbuds"
                      aria-invalid={!!errors.prizeProductTitle}
                    />
                  </Field>

                  <div>
                    <p className="mb-2 text-xs font-medium text-foreground">
                      Product image<span className="ml-0.5 text-destructive">*</span>
                    </p>
                    <ImageUploadField
                      idPrefix="contest-product-image"
                      value={form.prizeProductImageUrl || null}
                      uploading={uploadingProduct}
                      progress={productProgress}
                      error={errors.productImage}
                      disabled={saving}
                      onPick={(file) => void selectProductImage(file)}
                      onRemove={removeProductImage}
                      aspectClass="aspect-square"
                      previewGridClass="sm:grid-cols-[160px_minmax(0,1fr)]"
                      placeholderIcon={Package}
                      placeholderText="No product image"
                      helpText="Uploads as soon as you pick it, so it is not lost if your browser reloads. Shown on the contest card and to the winner awaiting delivery."
                    />
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <NumberField
                      label="Declared value (₹)"
                      value={form.prizeProductValue}
                      min={0}
                      max={PRODUCT_VALUE_MAX}
                      error={errors.prizeProductValue}
                      disabled={saving}
                      onChange={(value) => set("prizeProductValue", value)}
                    />
                    <Field
                      label="Product description"
                      error={errors.prizeProductDescription}
                      hint={`${form.prizeProductDescription.length}/${PRODUCT_DESCRIPTION_MAX}`}
                    >
                      <Textarea
                        value={form.prizeProductDescription}
                        maxLength={PRODUCT_DESCRIPTION_MAX}
                        disabled={saving}
                        onChange={(event) => set("prizeProductDescription", event.target.value)}
                        placeholder="Colour, variant, warranty — anything the winner should know"
                        className="min-h-20"
                      />
                    </Field>
                  </div>
                  <InlineNote>
                    The declared value is shown to users as what the prize is worth. It is never credited and never
                    spendable — a product contest pays 0 coins, and the entry fees it collects are what pay for the item.
                  </InlineNote>
                </div>
              )}

              {/* A prize change is refused outright while a battle is in flight,
                  because a pre-0042 match reads the template at settlement — so
                  this edit really can change what an already-running match pays. */}
              {isEdit && contest && contest.activeMatches > 0 && prizeChanged && (
                <InlineWarning>
                  The prize cannot change while {contest.activeMatches} matches are active. Those battles were started on
                  the current prize and must settle on it.
                </InlineWarning>
              )}
            </section>

            <section className="space-y-4 border-t border-border pt-5">
              <FormSectionTitle title="Economy and match policy" description="All values must be whole numbers within the supported limits." />
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                <NumberField label="Total entry fee" value={form.totalEntryFee} min={0} max={1_000_000} error={errors.totalEntryFee} disabled={saving} onChange={(value) => set("totalEntryFee", value)} />
                <NumberField
                  label="Reward coins"
                  value={isProduct ? "0" : form.rewardCoins}
                  min={0}
                  max={10_000_000}
                  error={errors.rewardCoins}
                  disabled={saving || isProduct}
                  onChange={(value) => set("rewardCoins", value)}
                />
                <NumberField label="Minimum votes" value={form.minVotes} min={0} max={1_000_000} error={errors.minVotes} disabled={saving} onChange={(value) => set("minVotes", value)} />
                <NumberField label="Vote duration (days)" value={form.voteDurationDays} min={1} max={30} error={errors.voteDurationDays} disabled={saving} onChange={(value) => set("voteDurationDays", value)} />
                <NumberField label="Waiting auto-cancel (hours)" value={form.autoCancelHours} min={1} max={168} error={errors.autoCancelHours} disabled={saving} onChange={(value) => set("autoCancelHours", value)} />
              </div>
              {isProduct && (
                <InlineNote>
                  Reward coins are fixed at 0 because this contest awards a product. Switch the prize back to Coins to set
                  a coin reward.
                </InlineNote>
              )}
              {isEdit && contest && contest.activeMatches > 0 && effectiveRewardCoins !== contest.rewardCoins && (
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

/**
 * One of the two prize kinds, as a card rather than a `<select>` option.
 *
 * The choice changes which fields the form even has and whether the coin reward is
 * paid at all, so it gets room to say what each option means. A two-line dropdown
 * is where "why is Reward coins greyed out?" comes from.
 */
function PrizeTypeOption({
  selected,
  disabled,
  icon: Icon,
  title,
  description,
  onSelect,
}: {
  selected: boolean;
  disabled: boolean;
  icon: typeof Coins;
  title: string;
  description: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={`flex gap-3 rounded-xl border p-3 text-left transition-colors disabled:opacity-60 ${
        selected ? "border-primary bg-primary/5 ring-1 ring-primary/30" : "border-border hover:bg-secondary/50"
      }`}
    >
      <span
        className={`mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg ${
          selected ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground"
        }`}
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-foreground">{title}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}

/**
 * The one image picker used for BOTH the contest banner and the product prize
 * image, so they behave and look identical. Upload-on-pick (the robust flow):
 * the file is uploaded the moment it is chosen, `onPick` gets nothing to hold,
 * and the parent stores only the returned URL — which survives the mobile
 * tab-reload behind the file picker that produced the old "blank screen".
 */
function ImageUploadField({
  idPrefix,
  value,
  uploading,
  progress,
  error,
  disabled,
  onPick,
  onRemove,
  aspectClass = "aspect-[16/9]",
  previewGridClass = "sm:grid-cols-[220px_minmax(0,1fr)]",
  placeholderIcon: PlaceholderIcon = ImageIcon,
  placeholderText = "No image selected",
  helpText,
}: {
  idPrefix: string;
  value: string | null;
  uploading: boolean;
  progress: number;
  error?: string;
  disabled?: boolean;
  onPick: (file: File | undefined) => void;
  onRemove: () => void;
  aspectClass?: string;
  previewGridClass?: string;
  placeholderIcon?: React.ComponentType<{ className?: string }>;
  placeholderText?: string;
  helpText?: string;
}) {
  const fileId = `${idPrefix}-file`;
  return (
    <div className={`grid gap-4 ${previewGridClass}`}>
      <div className={`flex ${aspectClass} items-center justify-center overflow-hidden rounded-xl border border-dashed border-border bg-secondary`}>
        {value ? (
          <img src={value} alt="Preview" className="h-full w-full object-cover" />
        ) : (
          <div className="text-center text-muted-foreground">
            <PlaceholderIcon className="mx-auto mb-2 size-7" />
            <span className="text-xs">{placeholderText}</span>
          </div>
        )}
      </div>
      <div className="flex flex-col justify-center gap-3">
        <input
          id={fileId}
          type="file"
          className="sr-only"
          accept="image/jpeg,image/png,image/webp"
          disabled={disabled || uploading}
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Reset BEFORE the (async) handler runs, so picking the same file twice
            // still fires a change event.
            event.target.value = "";
            onPick(file);
          }}
        />
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" disabled={disabled || uploading} asChild>
            <label htmlFor={fileId} className="cursor-pointer">
              {uploading ? <Loader2 className="animate-spin" /> : <Upload />}
              {uploading ? "Uploading…" : value ? "Replace image" : "Choose image"}
            </label>
          </Button>
          {value && !uploading && (
            <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onRemove} className="text-destructive">
              <X /> Remove
            </Button>
          )}
        </div>
        {helpText && <p className="text-xs text-muted-foreground">{helpText}</p>}
        {error && <p className="text-xs font-medium text-destructive">{error}</p>}
        {uploading && (
          <div className="space-y-1.5" aria-live="polite">
            <div className="flex justify-between text-xs text-muted-foreground"><span>Uploading…</span><span>{progress}%</span></div>
            <Progress value={progress} />
          </div>
        )}
      </div>
    </div>
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

function DateTimeField({
  label,
  value,
  hint,
  error,
  disabled,
  onChange,
  onClear,
  presets,
  onPreset,
}: {
  label: string;
  value: string;
  hint: string;
  error?: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onClear: () => void;
  presets?: { label: string; hours: number }[];
  onPreset?: (hours: number) => void;
}) {
  return (
    <Field label={label} error={error} hint={hint}>
      <div className="space-y-2">
        <div className="flex gap-2">
          <Input
            type="datetime-local"
            value={value}
            disabled={disabled}
            aria-invalid={!!error}
            onChange={(event) => onChange(event.target.value)}
          />
          {value && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={disabled}
              onClick={onClear}
              aria-label={`Clear ${label}`}
              title={`Clear ${label}`}
              className="shrink-0 text-muted-foreground"
            >
              <X />
            </Button>
          )}
        </div>
        {presets && onPreset && (
          <div className="flex flex-wrap gap-1.5">
            {presets.map((preset) => (
              <button
                key={preset.label}
                type="button"
                disabled={disabled}
                onClick={() => onPreset(preset.hours)}
                className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50"
              >
                {preset.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </Field>
  );
}

function InlineNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2 rounded-xl border border-border bg-secondary/50 p-3 text-xs text-muted-foreground">
      <Clock3 className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </div>
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
