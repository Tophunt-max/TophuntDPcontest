import { ReactNode, useState, useEffect, useRef } from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { api } from "@/lib/api";
import { fmtDateTime } from "@/lib/format";
import {
  LayoutDashboard,
  BarChart3,
  Users,
  ShieldCheck,
  Trophy,
  Swords,
  Crown,
  Receipt,
  Banknote,
  ArrowDownToLine,
  Coins,
  Image,
  Clapperboard,
  MessageCircle,
  Flag,
  MessageSquare,
  ShieldBan,
  ShieldAlert,
  Bell,
  Gift,
  SlidersHorizontal,
  Settings,
  FileText,
  ScrollText,
  LogOut,
  Menu,
  X,
  ChevronRight,
} from "lucide-react";

/** Short beep via Web Audio API — no asset needed. */
function playPing() {
  try {
    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1174, ctx.currentTime + 0.1);
    gain.gain.setValueAtTime(0.001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.36);
    osc.onended = () => ctx.close().catch(() => {});
  } catch {
    /* audio not allowed / unsupported — ignore */
  }
}

const nav = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, section: "main" },
  { href: "/analytics", label: "Analytics", icon: BarChart3, section: "main" },
  { href: "/users", label: "Users", icon: Users, section: "main" },
  { href: "/admins", label: "Admins & Roles", icon: ShieldCheck, section: "main" },
  { href: "/contests", label: "Contests", icon: Trophy, section: "contests" },
  { href: "/matches", label: "Matches", icon: Swords, section: "contests" },
  { href: "/leaderboard", label: "Leaderboard", icon: Crown, section: "contests" },
  { href: "/transactions", label: "Transactions", icon: Receipt, section: "finance" },
  { href: "/deposits", label: "Deposits", icon: ArrowDownToLine, section: "finance", badgeKey: "pendingDeposits" },
  { href: "/withdrawals", label: "Withdrawals", icon: Banknote, section: "finance", badgeKey: "pendingWithdrawals" },
  { href: "/coin-packages", label: "Coin Packages", icon: Coins, section: "finance" },
  { href: "/posts", label: "Posts", icon: Image, section: "content" },
  { href: "/stories", label: "Stories", icon: Clapperboard, section: "content" },
  { href: "/comments", label: "Comments", icon: MessageCircle, section: "content" },
  { href: "/blog", label: "Blog", icon: FileText, section: "content" },
  { href: "/reports", label: "Reports", icon: Flag, section: "moderation" },
  { href: "/support", label: "Support Tickets", icon: MessageSquare, section: "moderation" },
  { href: "/moderation", label: "Moderation", icon: ShieldBan, section: "moderation" },
  { href: "/audit-log", label: "Audit & Security", icon: ShieldAlert, section: "moderation" },
  { href: "/logs", label: "Error Logs", icon: ScrollText, section: "moderation" },
  { href: "/notifications", label: "Notifications", icon: Bell, section: "engagement" },
  { href: "/rewards", label: "Rewards & Gamification", icon: Gift, section: "system" },
  { href: "/app-control", label: "App Control", icon: SlidersHorizontal, section: "system" },
  { href: "/app-settings", label: "App Settings", icon: Settings, section: "system" },
];

const sections: Record<string, string> = {
  main: "OVERVIEW",
  contests: "CONTESTS",
  finance: "FINANCE",
  content: "CONTENT",
  moderation: "MODERATION",
  engagement: "ENGAGEMENT",
  system: "SYSTEM",
};

function NavItem({ href, label, icon: Icon, active, onClick, badge }: any) {
  const hasBadge = typeof badge === "number" && badge > 0;
  return (
    <Link href={href} onClick={onClick}>
      <div
        className={`flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all duration-150 cursor-pointer group ${
          active
            ? "bg-white/10 text-white shadow-sm"
            : "text-white/50 hover:bg-white/5 hover:text-white/80"
        }`}
      >
        <div
          className={`relative p-1.5 rounded-lg transition-colors ${
            active ? "bg-violet-500" : "group-hover:bg-white/10"
          }`}
        >
          <Icon size={15} className={active ? "text-white" : ""} />
        </div>
        <span className="text-sm font-medium">{label}</span>
        {hasBadge ? (
          <span className="ml-auto min-w-[20px] h-5 px-1.5 rounded-full bg-red-500 text-white text-[11px] font-bold flex items-center justify-center">
            {badge > 99 ? "99+" : badge}
          </span>
        ) : (
          active && <ChevronRight size={14} className="ml-auto text-white/60" />
        )}
      </div>
    </Link>
  );
}

function Sidebar({ onClose }: { onClose?: () => void }) {
  const [loc] = useLocation();
  const { user, logout } = useAuth();
  // Live pending counts for sidebar badges (deposits / withdrawals).
  const { data: overview } = useQuery({
    queryKey: ["overview"],
    queryFn: api.overview,
    refetchInterval: 20000,
  });
  let lastSection = "";

  return (
    <div className="sidebar-bg flex flex-col h-full w-64 flex-shrink-0">
      {/* Logo */}
      <div className="p-5 border-b border-white/5">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl gradient-purple flex items-center justify-center shadow-lg">
            <span className="text-white font-bold text-base">T</span>
          </div>
          <div>
            <p className="font-bold text-white text-sm tracking-tight">TopHunt</p>
            <p className="text-xs text-white/40 font-medium">Admin Console</p>
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="ml-auto text-white/40 hover:text-white lg:hidden"
            >
              <X size={18} />
            </button>
          )}
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 p-3 overflow-y-auto space-y-0.5">
        {nav.map((item) => {
          const showLabel = item.section !== lastSection;
          lastSection = item.section;
          const active = loc.startsWith(item.href);
          return (
            <div key={item.href}>
              {showLabel && (
                <p className="text-white/25 text-[10px] font-bold tracking-widest px-3 py-2 mt-3 first:mt-0">
                  {sections[item.section]}
                </p>
              )}
              <NavItem {...item} active={active} onClick={onClose} badge={(item as any).badgeKey ? (overview as any)?.[(item as any).badgeKey] : undefined} />
            </div>
          );
        })}
      </nav>

      {/* User */}
      <div className="p-4 border-t border-white/5">
        <div className="flex items-center gap-3 p-2 rounded-xl hover:bg-white/5 transition-colors mb-1">
          <div className="w-8 h-8 rounded-lg gradient-purple flex items-center justify-center text-white font-bold text-sm flex-shrink-0">
            {user?.name?.[0]?.toUpperCase() || "A"}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-white text-sm font-semibold truncate">{user?.name}</p>
            <p className="text-white/40 text-xs truncate">{user?.email}</p>
          </div>
        </div>
        <button
          onClick={logout}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm text-red-400 hover:bg-red-500/10 rounded-xl transition-colors font-medium"
        >
          <LogOut size={15} />
          <span>Sign Out</span>
        </button>
      </div>
    </div>
  );
}

function NotificationBell() {
  const [, setLoc] = useLocation();
  const qc = useQueryClient();
  const prevUnread = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const { data = [] } = useQuery({
    queryKey: ["notifications"],
    queryFn: api.notifications,
    refetchInterval: 15000,
  });
  const items = data as any[];
  const unread = items.filter((n) => !n.isRead).length;

  // Play a ping when unread count rises (new admin alert arrived).
  useEffect(() => {
    if (prevUnread.current !== null && unread > prevUnread.current) {
      playPing();
    }
    prevUnread.current = unread;
  }, [unread]);

  const markAllRead = async () => {
    try {
      await api.markNotificationsRead();
      qc.invalidateQueries({ queryKey: ["notifications"] });
    } catch {
      /* ignore */
    }
  };

  const openItem = (n: any) => {
    setOpen(false);
    if (n?.link) setLoc(n.link);
  };

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative p-2 rounded-lg hover:bg-secondary transition-colors"
        title="Admin alerts"
      >
        <Bell size={18} />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <>
          {/* click-away backdrop */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-2 w-80 max-w-[90vw] bg-card border border-border rounded-2xl shadow-xl z-50 overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <p className="font-bold text-sm text-foreground">Notifications</p>
              {unread > 0 && (
                <button onClick={markAllRead} className="text-xs text-violet-600 font-medium hover:underline">
                  Mark all read
                </button>
              )}
            </div>
            <div className="max-h-[360px] overflow-y-auto">
              {items.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">No notifications</p>
              ) : (
                items.map((n) => (
                  <button
                    key={n.id}
                    onClick={() => openItem(n)}
                    className={`w-full text-left px-4 py-3 border-b border-border last:border-0 hover:bg-secondary/40 transition-colors ${n.isRead ? "" : "bg-violet-50/60"}`}
                  >
                    <div className="flex items-start gap-2">
                      {!n.isRead && <span className="mt-1.5 w-2 h-2 rounded-full bg-violet-500 flex-shrink-0" />}
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-foreground truncate">{n.title}</p>
                        {n.message && <p className="text-xs text-muted-foreground line-clamp-2">{n.message}</p>}
                        <p className="text-[11px] text-muted-foreground mt-0.5">{fmtDateTime(n.createdAt)}</p>
                      </div>
                    </div>
                  </button>
                ))
              )}
            </div>
            <button
              onClick={() => { setOpen(false); setLoc("/notifications"); }}
              className="w-full text-center py-2.5 text-xs font-medium text-violet-600 hover:bg-secondary/40 border-t border-border"
            >
              Open notifications page
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const [loc] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const currentPage = nav.find((n) => loc.startsWith(n.href));

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-30 lg:hidden backdrop-blur-sm"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <div
        className={`fixed inset-y-0 left-0 z-40 transform transition-transform duration-300 lg:hidden ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <Sidebar onClose={() => setMobileOpen(false)} />
      </div>

      <div className="hidden lg:flex">
        <Sidebar />
      </div>

      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <header className="h-16 bg-card border-b border-border flex items-center px-5 gap-4 flex-shrink-0">
          <button
            onClick={() => setMobileOpen(true)}
            className="lg:hidden relative p-2 rounded-lg hover:bg-secondary transition-colors"
          >
            <Menu size={18} />
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="font-bold text-base text-foreground">
              {currentPage?.label || "Dashboard"}
            </h1>
            <p className="text-xs text-muted-foreground hidden sm:block">
              TopHunt Admin Console
            </p>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            <div className="hidden sm:flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              <span className="text-xs text-muted-foreground">System Operational</span>
            </div>
            <NotificationBell />
          </div>
        </header>

        <main className="flex-1 overflow-auto p-5 lg:p-6">{children}</main>
      </div>
    </div>
  );
}
