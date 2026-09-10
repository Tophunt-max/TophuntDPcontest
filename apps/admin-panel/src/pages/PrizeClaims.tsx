/**
 * Physical prize fulfilment queue.
 *
 * Settlement creates one claim per product-prize win; this page is where a human
 * turns that record into a parcel. The lifecycle is
 * `unclaimed → submitted → approved → shipped → delivered`, with `cancelled`
 * reachable from any non-terminal state, and the Worker enforces every transition —
 * the buttons here only decide what is worth offering.
 *
 * ---------------------------------------------------------------------------
 * Why the address is not in the table
 * ---------------------------------------------------------------------------
 * The list endpoint deliberately returns a MASKED one-line summary and no address
 * columns at all. Putting a home address in the table means every operator who
 * opens the queue — and every screenshot of it — carries the addresses of everyone
 * who ever won something, none of which is needed to see what still has to ship.
 *
 * The full address lives behind "Open" on a single claim, which is the moment
 * somebody is actually packing a parcel. That read is audit-logged by the Worker,
 * so the modal says so out loud.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  PRIZE_CLAIM_TRANSITIONS,
  type PrizeClaim,
  type PrizeClaimStatus,
  type PrizeClaimStatusPayload,
} from "@/lib/api";
import { Table } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { StatCard } from "@/components/ui/StatCard";
import { PageHeader, fmtDateTime, fmtNumber, exportCsv } from "@/lib/format";
import { useConfirm } from "@/components/ConfirmDialog";
import { toast } from "@/lib/toast";
import { SegTabs, UserCell, ActionBtn } from "@/components/finance/bits";
import {
  AlertCircle,
  Check,
  ClipboardCopy,
  Download,
  Eye,
  Gift,
  Hourglass,
  Package,
  PackageCheck,
  Truck,
  X,
} from "lucide-react";

const TABS = [
  { key: "submitted", label: "To approve" },
  { key: "approved", label: "To ship" },
  { key: "shipped", label: "In transit" },
  { key: "unclaimed", label: "Awaiting address" },
  { key: "delivered", label: "Delivered" },
  { key: "cancelled", label: "Cancelled" },
  { key: "", label: "All" },
];

/** The Worker's own maximum for this endpoint. */
const CLAIM_PAGE_LIMIT = 500;

/** Operator-facing wording. The raw status is a state name, not an instruction. */
const STATUS_LABELS: Record<PrizeClaimStatus, string> = {
  unclaimed: "Awaiting address",
  submitted: "Address submitted",
  approved: "Approved",
  shipped: "Shipped",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

const STATUS_VARIANTS: Record<PrizeClaimStatus, string> = {
  unclaimed: "warning",
  submitted: "pending",
  approved: "info",
  shipped: "primary",
  delivered: "success",
  cancelled: "danger",
};

/** The button that moves a claim forward, per current state. */
const ADVANCE: Partial<Record<PrizeClaimStatus, { to: PrizeClaimStatus; label: string; icon: typeof Check }>> = {
  submitted: { to: "approved", label: "Approve", icon: Check },
  approved: { to: "shipped", label: "Ship", icon: Truck },
  shipped: { to: "delivered", label: "Delivered", icon: PackageCheck },
};

export default function PrizeClaims() {
  const qc = useQueryClient();
  const { confirm } = useConfirm();
  const [tab, setTab] = useState("submitted");
  const [openId, setOpenId] = useState<string | null>(null);
  const [shipFor, setShipFor] = useState<PrizeClaim | null>(null);
  const [courier, setCourier] = useState("");
  const [tracking, setTracking] = useState("");
  const [cancelFor, setCancelFor] = useState<PrizeClaim | null>(null);
  const [cancelReason, setCancelReason] = useState("");

  /**
   * The Worker caps this list (default 100, max 500) and there is no cursor. Ask for
   * the maximum, and detect the cap being hit so the page can say so.
   *
   * Silence would be worse here than on other queues: rows come back newest-first,
   * so the ones that fall off the end are the ones that have been waiting LONGEST —
   * the exact opposite of what a fulfilment queue is for. The sidebar badge counts
   * the whole table, so an operator would otherwise just see two numbers disagree.
   */
  const { data = [], isLoading, isError, error } = useQuery({
    queryKey: ["prize-claims", tab],
    queryFn: () =>
      api.prizeClaims({ status: (tab || undefined) as PrizeClaimStatus | undefined, limit: CLAIM_PAGE_LIMIT }),
  });
  const truncated = data.length >= CLAIM_PAGE_LIMIT;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["prize-claims"] });
    // The sidebar badge counts everything not yet delivered or cancelled.
    qc.invalidateQueries({ queryKey: ["overview"] });
  };

  const stats = useMemo(() => {
    const value = data.reduce((sum, claim) => sum + (Number(claim.productValue) || 0), 0);
    return {
      count: data.length,
      value,
      awaitingAddress: data.filter((claim) => claim.status === "unclaimed").length,
      toAction: data.filter((claim) => claim.status === "submitted" || claim.status === "approved").length,
    };
  }, [data]);

  const statusMut = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: PrizeClaimStatusPayload }) =>
      api.updatePrizeClaimStatus(id, payload),
    onSuccess: (result) => {
      toast.success(`Claim marked ${STATUS_LABELS[result.status].toLowerCase()}`);
      setShipFor(null);
      setCancelFor(null);
      invalidate();
      // The open packing screen must not keep showing the status it had before.
      if (openId) qc.invalidateQueries({ queryKey: ["prize-claim", openId] });
    },
    // The Worker's message is the useful one here: it distinguishes an illegal
    // transition from another operator having moved the claim first.
    onError: (e: any) => toast.error(e?.message || "Could not update this claim."),
  });

  const advance = async (claim: PrizeClaim) => {
    const step = ADVANCE[claim.status];
    if (!step) return;
    if (step.to === "shipped") {
      setShipFor(claim);
      setCourier("");
      setTracking("");
      return;
    }
    const approved = await confirm(
      step.to === "approved"
        ? {
            title: "Approve this address?",
            description: `Confirm the delivery address for ${claim.productTitle} and move it to packing. The winner is notified.`,
            confirmLabel: "Approve address",
          }
        : {
            title: "Mark as delivered?",
            description: `Confirm ${claim.productTitle} reached ${claim.fullName || claim.username || "the winner"}. This is final and cannot be undone.`,
            confirmLabel: "Mark delivered",
          },
    );
    if (approved) statusMut.mutate({ id: claim.id, payload: { status: step.to } });
  };

  return (
    <div>
      <PageHeader
        title="Prize Claims"
        subtitle="Physical prizes won in contests — approve the address, ship, and confirm delivery"
        action={
          <button
            onClick={() =>
              // Deliberately no address column, not even the masked summary: a CSV
              // outlives the screen it came from and gets mailed around. Everything
              // needed to reconcile a shipment is here; the address is not.
              exportCsv(`prize-claims-${Date.now()}.csv`, data, [
                "id",
                "matchId",
                "contestId",
                "uid",
                "username",
                "status",
                "productTitle",
                "productValue",
                "courier",
                "trackingNumber",
                "createdAt",
                "submittedAt",
                "shippedAt",
                "deliveredAt",
              ])
            }
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-secondary text-sm font-medium hover:bg-secondary/70 transition-colors"
          >
            <Download size={15} /> Export CSV
          </button>
        }
      />

      {/* Every figure below is derived from the rows currently listed, so the labels
          say "in this view" rather than implying a total across the whole table. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard icon={Gift} label={`Claims (${tab ? STATUS_LABELS[tab as PrizeClaimStatus].toLowerCase() : "all"})`} value={fmtNumber(stats.count)} gradient="gradient-purple" />
        <StatCard icon={Package} label="Needs an operator (this view)" value={fmtNumber(stats.toAction)} gradient="gradient-blue" />
        <StatCard icon={Hourglass} label="Awaiting address (this view)" value={fmtNumber(stats.awaitingAddress)} gradient="gradient-orange" />
        <StatCard icon={Truck} label="Declared value (this view)" value={`₹${fmtNumber(stats.value)}`} gradient="gradient-green" />
      </div>

      <SegTabs tab={tab} setTab={setTab} tabs={TABS} />

      {truncated && (
        <div className="mb-4 flex gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <span>
            Showing the {fmtNumber(CLAIM_PAGE_LIMIT)} most recent claims — there are more. Filter by status to reach the
            rest; the oldest waiting claims are the ones cut off here.
          </span>
        </div>
      )}

      {isError ? (
        <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-8 text-center">
          <AlertCircle className="mx-auto mb-3 size-8 text-destructive" />
          <h3 className="font-semibold text-foreground">Could not load prize claims</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {error instanceof Error ? error.message : "Please check your connection and try again."}
          </p>
        </div>
      ) : (
        <Table
          loading={isLoading}
          data={data}
          keyFn={(claim) => claim.id}
          empty="No prize claims here"
          columns={[
            {
              key: "winner",
              header: "Winner",
              render: (claim) => (
                <UserCell name={claim.fullName || claim.username || claim.uid} sub={claim.username ? `@${claim.username}` : claim.uid} />
              ),
            },
            {
              key: "prize",
              header: "Prize",
              render: (claim) => (
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-9 h-9 rounded-lg border border-border bg-secondary overflow-hidden flex items-center justify-center flex-shrink-0">
                    {claim.productImageUrl ? (
                      <img src={claim.productImageUrl} alt="" className="w-full h-full object-cover" />
                    ) : (
                      <Package size={14} className="text-muted-foreground" />
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="font-medium text-foreground truncate max-w-48">{claim.productTitle}</p>
                    {Number(claim.productValue) > 0 && (
                      <p className="text-xs text-muted-foreground">₹{fmtNumber(claim.productValue)}</p>
                    )}
                  </div>
                </div>
              ),
            },
            {
              key: "status",
              header: "Status",
              render: (claim) => <Badge variant={STATUS_VARIANTS[claim.status]}>{STATUS_LABELS[claim.status]}</Badge>,
            },
            {
              key: "delivery",
              header: "Deliver to",
              render: (claim) =>
                claim.deliverySummary ? (
                  <span className="text-xs text-muted-foreground">{claim.deliverySummary}</span>
                ) : (
                  <span className="text-xs text-amber-600 font-medium">
                    {claim.hasAddress ? "Address on file" : "Winner has not given an address"}
                  </span>
                ),
            },
            {
              key: "tracking",
              header: "Tracking",
              render: (claim) =>
                claim.trackingNumber ? (
                  <div className="text-xs whitespace-nowrap">
                    <p className="font-medium text-foreground">{claim.courier}</p>
                    <p className="text-muted-foreground font-mono">{claim.trackingNumber}</p>
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                ),
            },
            {
              key: "won",
              header: "Won",
              render: (claim) => <span className="text-muted-foreground whitespace-nowrap">{fmtDateTime(claim.createdAt)}</span>,
            },
            {
              key: "actions",
              header: "",
              className: "text-right",
              render: (claim) => {
                const step = ADVANCE[claim.status];
                const canCancel = PRIZE_CLAIM_TRANSITIONS[claim.status].includes("cancelled");
                return (
                  <div className="flex items-center justify-end gap-1.5">
                    <ActionBtn tone="blue" title="Open the packing screen" onClick={() => setOpenId(claim.id)}>
                      <Eye size={14} /> Open
                    </ActionBtn>
                    {step && (
                      <ActionBtn tone="green" title={step.label} onClick={() => void advance(claim)}>
                        <step.icon size={14} /> {step.label}
                      </ActionBtn>
                    )}
                    {canCancel && (
                      <ActionBtn
                        tone="red"
                        title="Cancel this claim"
                        onClick={() => {
                          setCancelFor(claim);
                          setCancelReason("");
                        }}
                      >
                        <X size={14} /> Cancel
                      </ActionBtn>
                    )}
                  </div>
                );
              },
            },
          ]}
        />
      )}

      {openId && (
        <ClaimDetailModal
          id={openId}
          onClose={() => setOpenId(null)}
          onShip={(claim) => {
            setShipFor(claim);
            setCourier("");
            setTracking("");
          }}
          onCancel={(claim) => {
            setCancelFor(claim);
            setCancelReason("");
          }}
          onAdvance={(claim) => void advance(claim)}
        />
      )}

      {/* Shipping needs the courier and the tracking number, because "shipped" is a
          status the winner can see and those two are the only things that make it
          actionable for them. The Worker refuses the transition without both. */}
      <Modal open={!!shipFor} onClose={() => setShipFor(null)} title="Mark as shipped">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!shipFor) return;
            statusMut.mutate({
              id: shipFor.id,
              payload: { status: "shipped", courier: courier.trim(), trackingNumber: tracking.trim() },
            });
          }}
        >
          <p className="text-sm text-muted-foreground mb-4">
            Shipping <span className="font-semibold text-foreground">{shipFor?.productTitle}</span> to{" "}
            <span className="font-medium text-foreground">{shipFor?.fullName || shipFor?.username || "the winner"}</span>. Both
            fields are sent to them in a notification.
          </p>
          <label className="block text-sm font-medium mb-1.5" htmlFor="prize-courier">Courier</label>
          <input
            id="prize-courier"
            autoFocus
            required
            minLength={2}
            maxLength={80}
            value={courier}
            onChange={(e) => setCourier(e.target.value)}
            placeholder="e.g. Delhivery"
            className="w-full px-3 py-2 rounded-xl bg-secondary border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
          <label className="block text-sm font-medium mb-1.5 mt-4" htmlFor="prize-tracking">Tracking number</label>
          <input
            id="prize-tracking"
            required
            minLength={4}
            maxLength={120}
            value={tracking}
            onChange={(e) => setTracking(e.target.value)}
            placeholder="e.g. 1234567890123"
            className="w-full px-3 py-2 rounded-xl bg-secondary border border-border text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
          <div className="flex justify-end gap-2 mt-5">
            <button
              type="button"
              onClick={() => setShipFor(null)}
              className="px-4 py-2 rounded-xl bg-secondary text-sm font-medium hover:bg-secondary/70 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={statusMut.isPending || courier.trim().length < 2 || tracking.trim().length < 4}
              className="px-4 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-50 transition-opacity"
            >
              Confirm shipped
            </button>
          </div>
        </form>
      </Modal>

      {/* Cancelling takes a prize away from somebody who won it, so the reason is
          required — it is sent to the winner verbatim and is the only record of why. */}
      <Modal open={!!cancelFor} onClose={() => setCancelFor(null)} title="Cancel this prize claim">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!cancelFor) return;
            statusMut.mutate({ id: cancelFor.id, payload: { status: "cancelled", adminNote: cancelReason.trim() } });
          }}
        >
          <p className="text-sm text-muted-foreground mb-4">
            Cancelling the claim for <span className="font-semibold text-foreground">{cancelFor?.productTitle}</span> won by{" "}
            <span className="font-medium text-foreground">{cancelFor?.fullName || cancelFor?.username || "this user"}</span>.
            This is final.
          </p>
          <label className="block text-sm font-medium mb-1.5" htmlFor="prize-cancel-reason">Reason</label>
          <textarea
            id="prize-cancel-reason"
            autoFocus
            required
            minLength={4}
            maxLength={500}
            rows={3}
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            placeholder="e.g. Out of stock — winner agreed to a coin refund instead"
            className="w-full px-3 py-2 rounded-xl bg-secondary border border-border text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
          <p className="text-xs text-muted-foreground mt-2">
            The winner is shown this reason in their notification and on their prize. {cancelReason.trim().length}/500
          </p>
          <div className="flex justify-end gap-2 mt-5">
            <button
              type="button"
              onClick={() => setCancelFor(null)}
              className="px-4 py-2 rounded-xl bg-secondary text-sm font-medium hover:bg-secondary/70 transition-colors"
            >
              Keep claim
            </button>
            <button
              type="submit"
              disabled={statusMut.isPending || cancelReason.trim().length < 4}
              className="px-4 py-2 rounded-xl bg-destructive text-white text-sm font-semibold disabled:opacity-50 transition-opacity"
            >
              Cancel claim
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

/**
 * The packing screen: one claim, with the full delivery address.
 *
 * Fetched only when opened, because the Worker audit-logs this read. That is
 * surfaced in the modal rather than left implicit — an operator should know that
 * looking at somebody's home address is recorded.
 */
function ClaimDetailModal({
  id,
  onClose,
  onShip,
  onCancel,
  onAdvance,
}: {
  id: string;
  onClose: () => void;
  onShip: (claim: PrizeClaim) => void;
  onCancel: (claim: PrizeClaim) => void;
  onAdvance: (claim: PrizeClaim) => void;
}) {
  const { data: claim, isLoading, isError, error } = useQuery({
    queryKey: ["prize-claim", id],
    queryFn: () => api.prizeClaim(id),
  });

  const copyAddress = async () => {
    if (!claim?.addressBlock) return;
    try {
      await navigator.clipboard.writeText(claim.addressBlock);
      toast.success("Address copied");
    } catch {
      toast.error("Could not copy — select the address and copy it manually.");
    }
  };

  const step = claim ? ADVANCE[claim.status] : undefined;
  const canCancel = claim ? PRIZE_CLAIM_TRANSITIONS[claim.status].includes("cancelled") : false;

  return (
    <Modal open onClose={onClose} title="Prize claim" width="max-w-2xl">
      {isLoading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      ) : isError || !claim ? (
        <div className="py-8 text-center">
          <AlertCircle className="mx-auto mb-3 size-7 text-destructive" />
          <p className="text-sm text-muted-foreground">
            {error instanceof Error ? error.message : "Could not load this claim."}
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          <div className="flex gap-4">
            <div className="w-20 h-20 rounded-xl border border-border bg-secondary overflow-hidden flex items-center justify-center flex-shrink-0">
              {claim.productImageUrl ? (
                <img src={claim.productImageUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                <Package size={20} className="text-muted-foreground" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-3">
                <p className="font-bold text-foreground">{claim.productTitle}</p>
                <Badge variant={STATUS_VARIANTS[claim.status]}>{STATUS_LABELS[claim.status]}</Badge>
              </div>
              {Number(claim.productValue) > 0 && (
                <p className="text-xs text-muted-foreground mt-0.5">Declared value ₹{fmtNumber(claim.productValue)}</p>
              )}
              <p className="text-xs text-muted-foreground mt-1">
                Won by <span className="font-medium text-foreground">{claim.fullName || claim.username || claim.uid}</span>
                {claim.username && <span className="font-mono"> @{claim.username}</span>}
              </p>
              <p className="text-xs text-muted-foreground font-mono mt-0.5">match {claim.matchId}</p>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between gap-3 mb-1.5">
              <p className="text-sm font-semibold">Delivery address</p>
              {claim.addressBlock && (
                <button
                  type="button"
                  onClick={() => void copyAddress()}
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
                >
                  <ClipboardCopy size={13} /> Copy
                </button>
              )}
            </div>
            {claim.addressBlock ? (
              <>
                <pre className="whitespace-pre-wrap rounded-xl bg-secondary border border-border p-3 text-sm text-foreground font-sans">
                  {claim.addressBlock}
                </pre>
                {claim.notes && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">Winner's note:</span> {claim.notes}
                  </p>
                )}
                <p className="mt-2 text-xs text-muted-foreground">
                  Opening this address is recorded in the audit log. The winner can still correct it until you approve the
                  claim.
                </p>
              </>
            ) : (
              <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 flex gap-2">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                <span>
                  The winner has not submitted a delivery address yet. Nothing can be shipped until they do — they were
                  notified when they won.
                </span>
              </div>
            )}
          </div>

          {claim.trackingNumber && (
            <div>
              <p className="text-sm font-semibold mb-1.5">Shipment</p>
              <div className="rounded-xl bg-secondary border border-border p-3 text-sm">
                <span className="font-medium">{claim.courier}</span>
                <span className="mx-2 text-muted-foreground">·</span>
                <span className="font-mono text-xs">{claim.trackingNumber}</span>
              </div>
            </div>
          )}

          {claim.status === "cancelled" && claim.adminNote && (
            <div>
              <p className="text-sm font-semibold mb-1.5">Cancellation reason</p>
              <p className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-foreground">
                {claim.adminNote}
              </p>
            </div>
          )}

          <div>
            <p className="text-sm font-semibold mb-2">Timeline</p>
            <ul className="space-y-1.5 text-xs">
              <TimelineRow label="Won" at={claim.createdAt} />
              <TimelineRow label="Address submitted" at={claim.submittedAt} />
              <TimelineRow label="Address approved" at={claim.approvedAt} />
              <TimelineRow label="Shipped" at={claim.shippedAt} />
              <TimelineRow label="Delivered" at={claim.deliveredAt} />
              <TimelineRow label="Cancelled" at={claim.cancelledAt} />
            </ul>
          </div>

          <div className="flex justify-end gap-2 pt-1 border-t border-border">
            <button
              type="button"
              onClick={onClose}
              className="mt-4 px-4 py-2 rounded-xl bg-secondary text-sm font-medium hover:bg-secondary/70 transition-colors"
            >
              Close
            </button>
            {canCancel && (
              <button
                type="button"
                onClick={() => onCancel(claim)}
                className="mt-4 px-4 py-2 rounded-xl bg-red-50 text-red-700 text-sm font-semibold hover:bg-red-100 transition-colors"
              >
                Cancel claim
              </button>
            )}
            {step && (
              <button
                type="button"
                onClick={() => (step.to === "shipped" ? onShip(claim) : onAdvance(claim))}
                className="mt-4 px-4 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-semibold transition-opacity hover:opacity-90"
              >
                {step.label}
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

/** One timeline entry. Renders nothing when the step has not happened. */
function TimelineRow({ label, at }: { label: string; at: number | null | undefined }) {
  if (!at) return null;
  return (
    <li className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-foreground font-medium whitespace-nowrap">{fmtDateTime(at)}</span>
    </li>
  );
}
