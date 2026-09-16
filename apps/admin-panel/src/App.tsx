import { Suspense, lazy, type ComponentType } from "react";
import { Switch, Route, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider, useAuth } from "@/lib/auth";
import { Layout } from "@/components/Layout";
import { PopupToaster } from "@/lib/toast";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import Login from "@/pages/Login";

/**
 * A code-split route whose chunk fails to load must NOT blank the screen.
 *
 * On mobile especially, opening the OS file picker can get the tab discarded by
 * the browser under memory pressure; when the user returns the tab is reloaded,
 * and the very next lazy route import can hit a transient network failure (or,
 * after a fresh deploy, a chunk hash that no longer exists). A raw `lazy()` then
 * rejects, React unwinds to the top, and the admin is left staring at a white
 * page.
 *
 * `lazyWithReload` retries that import exactly once by doing a hard reload — the
 * cleanest way to pull a fresh `index.html` and its current chunk hashes. A
 * `sessionStorage` guard keyed to the module makes it a ONE-TIME move, so a
 * genuinely broken build cannot become an endless reload loop: the second
 * failure rethrows and falls through to the global ErrorBoundary instead.
 */
function lazyWithReload<T extends ComponentType<unknown>>(factory: () => Promise<{ default: T }>) {
  return lazy(async () => {
    const guardKey = `chunk-reload:${factory.toString()}`;
    try {
      const mod = await factory();
      sessionStorage.removeItem(guardKey);
      return mod;
    } catch (error) {
      if (!sessionStorage.getItem(guardKey)) {
        sessionStorage.setItem(guardKey, "1");
        window.location.reload();
        // Resolve to nothing meaningful; the reload takes over before React
        // renders this, and Suspense keeps the fallback up in the meantime.
        return await new Promise<{ default: T }>(() => {});
      }
      // Already tried a reload and it still failed — let the ErrorBoundary show
      // its recoverable fallback rather than reloading forever.
      throw error;
    }
  });
}

const Dashboard = lazyWithReload(() => import("@/pages/Dashboard"));
const Analytics = lazyWithReload(() => import("@/pages/Analytics"));
const UsersPage = lazyWithReload(() => import("@/pages/Users"));
const Admins = lazyWithReload(() => import("@/pages/Admins"));
const Contests = lazyWithReload(() => import("@/pages/Contests"));
const Matches = lazyWithReload(() => import("@/pages/Matches"));
const PrizeClaims = lazyWithReload(() => import("@/pages/PrizeClaims"));
const Leaderboard = lazyWithReload(() => import("@/pages/Leaderboard"));
const Transactions = lazyWithReload(() => import("@/pages/Transactions"));
const Withdrawals = lazyWithReload(() => import("@/pages/Withdrawals"));
const Deposits = lazyWithReload(() => import("@/pages/Deposits"));
const CoinPackages = lazyWithReload(() => import("@/pages/CoinPackages"));
const Posts = lazyWithReload(() => import("@/pages/Posts"));
const Stories = lazyWithReload(() => import("@/pages/Stories"));
const Comments = lazyWithReload(() => import("@/pages/Comments"));
const Blog = lazyWithReload(() => import("@/pages/Blog"));
const Seo = lazyWithReload(() => import("@/pages/Seo"));
const Reports = lazyWithReload(() => import("@/pages/Reports"));
const Support = lazyWithReload(() => import("@/pages/Support"));
const Moderation = lazyWithReload(() => import("@/pages/Moderation"));
const AuditLog = lazyWithReload(() => import("@/pages/AuditLog"));
const AccountDeletions = lazyWithReload(() => import("@/pages/AccountDeletions"));
const Notifications = lazyWithReload(() => import("@/pages/Notifications"));
const Rewards = lazyWithReload(() => import("@/pages/Rewards"));
const AppControl = lazyWithReload(() => import("@/pages/AppControl"));
const AppSettings = lazyWithReload(() => import("@/pages/AppSettings"));
const Legal = lazyWithReload(() => import("@/pages/Legal"));
const Integrations = lazyWithReload(() => import("@/pages/Integrations"));
const Logs = lazyWithReload(() => import("@/pages/Logs"));
const SystemHealth = lazyWithReload(() => import("@/pages/SystemHealth"));

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false } },
});

function PageLoader() {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" />
    </div>
  );
}

function ProtectedApp() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!user) return <Login />;

  return (
    <Layout>
      <Suspense fallback={<PageLoader />}>
        <Switch>
          <Route path="/" component={() => <Redirect to="/dashboard" />} />
          <Route path="/dashboard" component={Dashboard} />
          <Route path="/analytics" component={Analytics} />
          <Route path="/users" component={UsersPage} />
          <Route path="/admins" component={Admins} />
          <Route path="/contests" component={Contests} />
          <Route path="/matches" component={Matches} />
          <Route path="/prize-claims" component={PrizeClaims} />
          <Route path="/leaderboard" component={Leaderboard} />
          <Route path="/transactions" component={Transactions} />
          <Route path="/withdrawals" component={Withdrawals} />
          <Route path="/deposits" component={Deposits} />
          <Route path="/coin-packages" component={CoinPackages} />
          <Route path="/posts" component={Posts} />
          <Route path="/stories" component={Stories} />
          <Route path="/comments" component={Comments} />
          <Route path="/blog" component={Blog} />
          <Route path="/seo" component={Seo} />
          <Route path="/reports" component={Reports} />
          <Route path="/support" component={Support} />
          <Route path="/moderation" component={Moderation} />
          <Route path="/audit-log" component={AuditLog} />
          <Route path="/account-deletions" component={AccountDeletions} />
          <Route path="/logs" component={Logs} />
          <Route path="/notifications" component={Notifications} />
          <Route path="/rewards" component={Rewards} />
          <Route path="/app-control" component={AppControl} />
          <Route path="/app-settings" component={AppSettings} />
          <Route path="/legal" component={Legal} />
          <Route path="/integrations" component={Integrations} />
          <Route path="/system-health" component={SystemHealth} />
          <Route component={() => <Redirect to="/dashboard" />} />
        </Switch>
      </Suspense>
    </Layout>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ConfirmProvider>
          <ProtectedApp />
        </ConfirmProvider>
      </AuthProvider>
      <PopupToaster />
    </QueryClientProvider>
  );
}
