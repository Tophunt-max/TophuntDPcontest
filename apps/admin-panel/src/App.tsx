import { Suspense, lazy } from "react";
import { Switch, Route, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider, useAuth } from "@/lib/auth";
import { Layout } from "@/components/Layout";
import { PopupToaster } from "@/lib/toast";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import Login from "@/pages/Login";

const Dashboard = lazy(() => import("@/pages/Dashboard"));
const Analytics = lazy(() => import("@/pages/Analytics"));
const UsersPage = lazy(() => import("@/pages/Users"));
const Admins = lazy(() => import("@/pages/Admins"));
const Contests = lazy(() => import("@/pages/Contests"));
const Matches = lazy(() => import("@/pages/Matches"));
const Leaderboard = lazy(() => import("@/pages/Leaderboard"));
const Transactions = lazy(() => import("@/pages/Transactions"));
const Withdrawals = lazy(() => import("@/pages/Withdrawals"));
const Deposits = lazy(() => import("@/pages/Deposits"));
const CoinPackages = lazy(() => import("@/pages/CoinPackages"));
const Posts = lazy(() => import("@/pages/Posts"));
const Stories = lazy(() => import("@/pages/Stories"));
const Comments = lazy(() => import("@/pages/Comments"));
const Blog = lazy(() => import("@/pages/Blog"));
const Reports = lazy(() => import("@/pages/Reports"));
const Support = lazy(() => import("@/pages/Support"));
const Moderation = lazy(() => import("@/pages/Moderation"));
const AuditLog = lazy(() => import("@/pages/AuditLog"));
const Notifications = lazy(() => import("@/pages/Notifications"));
const Rewards = lazy(() => import("@/pages/Rewards"));
const AppControl = lazy(() => import("@/pages/AppControl"));
const AppSettings = lazy(() => import("@/pages/AppSettings"));
const Logs = lazy(() => import("@/pages/Logs"));

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
          <Route path="/leaderboard" component={Leaderboard} />
          <Route path="/transactions" component={Transactions} />
          <Route path="/withdrawals" component={Withdrawals} />
          <Route path="/deposits" component={Deposits} />
          <Route path="/coin-packages" component={CoinPackages} />
          <Route path="/posts" component={Posts} />
          <Route path="/stories" component={Stories} />
          <Route path="/comments" component={Comments} />
          <Route path="/blog" component={Blog} />
          <Route path="/reports" component={Reports} />
          <Route path="/support" component={Support} />
          <Route path="/moderation" component={Moderation} />
          <Route path="/audit-log" component={AuditLog} />
          <Route path="/logs" component={Logs} />
          <Route path="/notifications" component={Notifications} />
          <Route path="/rewards" component={Rewards} />
          <Route path="/app-control" component={AppControl} />
          <Route path="/app-settings" component={AppSettings} />
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
