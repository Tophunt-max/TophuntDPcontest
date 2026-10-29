// FIRST import, on purpose: it records how this session started (the launch
// URL) before the router can rewrite the address bar. See src/lib/onboarding.ts.
import '@/src/lib/onboarding';
import { ThemeProvider } from '@react-navigation/native';
import { Stack, useGlobalSearchParams, usePathname, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as NativeSplash from 'expo-splash-screen';
import { useFonts } from 'expo-font';
import React, { useEffect } from 'react';
import 'react-native-reanimated';
import { QueryClient, QueryClientProvider, QueryCache, MutationCache, onlineManager, focusManager, useQuery } from '@tanstack/react-query';
import { Provider as PaperProvider } from 'react-native-paper';
import { startUsageStats } from '@/src/services/usageStats';
import { registerServiceWorker } from '@/src/lib/serviceWorker';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as Notifications from 'expo-notifications';
import NetInfo from '@react-native-community/netinfo';

import dayjs from 'dayjs';
import localeData from 'dayjs/plugin/localeData';
import weekday from 'dayjs/plugin/weekday';
import localizedFormat from 'dayjs/plugin/localizedFormat';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import calendar from 'dayjs/plugin/calendar';
import utc from 'dayjs/plugin/utc';
import { createRootGuard } from '@/src/lib/rootGuard';
import {
  onboardingSnapshot,
  onboardingStatusFor,
  refreshOnboarding,
  resetOnboarding,
  subscribeOnboarding,
} from '@/src/lib/profileCompletion';
import { useAppControl, useViewer } from '@/src/hooks/useAppControl';
import { allowedDuringMaintenance, featureForRoute, featureOn } from '@/src/lib/appControl';
import { LiveAppConfig } from '@/src/components/system/LiveAppConfig';
import { AppControlBars } from '@/src/components/system/AppControlBars';

// Initialize all dayjs plugins globally at the root
dayjs.extend(localeData);
dayjs.extend(weekday);
dayjs.extend(localizedFormat);
dayjs.extend(customParseFormat);
dayjs.extend(calendar);
dayjs.extend(utc);

import { useColorScheme } from '@/hooks/use-color-scheme';
import { ToastProvider } from '@/src/components/toast/ToastProvider';
import { ConfirmHost } from '@/src/components/modals/ConfirmHost';
import { useFirebaseActionLink } from '@/src/hooks/useFirebaseActionLink';
import { lightTheme, darkTheme } from '@/constants/theme';
import '@/src/services/firebase/initFirebase'; // Import to initialize Firebase
import '@/src/database'; // Initialize WatermelonDB
import { startOfflineSync, onAccountChangedForSync } from '@/src/sync';
import { shouldReportQueryError, shouldRetryQuery } from '@/src/sync/queryPolicy';
import { getNotificationDestination } from '@/src/services/notifications/notificationMeta';
import { AppState, Platform } from 'react-native';
// Icons are now SVG-based (src/lib/icons.tsx via lucide-react-native), so there
// are NO icon fonts to preload — icons render identically on web/Android/iOS.

// Apply our video cache budget. This runs at module scope on purpose: expo-video
// refuses to change the cache size once any VideoPlayer exists, and module
// evaluation of the root layout happens before any screen can mount one.
// Pause react-query background refetches (refetchInterval) whenever the app is
// not in the foreground. On mobile the "window" is never focused the way a
// browser is, so without this react-query keeps polling even when the app is
// backgrounded — burning Worker requests + D1 reads for idle users. Wiring
// focusManager to AppState makes every useQuery poll ONLY while the app is open.
focusManager.setEventListener((handleFocus) => {
  const sub = AppState.addEventListener('change', (state) => handleFocus(state === 'active'));
  return () => sub.remove();
});

import { useAuth } from '@/src/hooks/useAuth'; // Shared app-wide auth session
import { shouldWipeDeviceCaches } from '@/src/lib/authState';
import { clearOffline, offlineOwner } from '@/src/lib/offlineStore';
import { restoreQueries } from '@/src/lib/queryPersistence';
import { reportConnectivity } from '@/src/lib/networkRecovery';
import { useQueryPersistence } from '@/src/hooks/useQueryPersistence';
import { useProfile } from '@/src/hooks/useProfileData';
import { useCachedIdentity } from '@/src/hooks/useCachedIdentity';
import { savePendingInvite } from '@/src/services/referrals';
import { notificationService } from '@/src/services/notifications/notificationService';
import { AnnouncementBanner } from '@/src/components/ui/AnnouncementBanner';
import { VerificationRewardPopup } from '@/src/components/verification/VerificationRewardPopup';
import { AnnouncementPopup } from '@/src/components/ui/AnnouncementPopup';
import { ErrorBoundary } from '@/src/components/ErrorBoundary';
import { OfflineBanner } from '@/src/components/ui/OfflineBanner';
import { AuthStartupGate } from '@/src/components/system/AuthStartupGate';
import { PhoneFrame } from '@/src/components/layout/PhoneFrame';
import { emitToast } from '@/src/lib/toastBridge';
import { reportError } from '@/src/lib/reportError';
import { readApi, readApiLive } from '@/src/services/api';
import { configureVideoCache } from '@/src/lib/videoCache';
import { hydrateThemePreference } from '@/src/lib/themePreference';

// Hold the native launch screen until fonts AND Firebase's first persisted-session
// decision are ready. Direct links bypass app/splash.tsx, so this belongs here.
if (Platform.OS !== 'web') void NativeSplash.preventAutoHideAsync().catch(() => {});

// Apply our video cache budget. Deliberately at module scope: expo-video refuses
// to change the cache size once any VideoPlayer exists, and module evaluation of
// the root layout happens before any screen can mount one.
configureVideoCache();

// Load the saved Dark Mode preference before the first paint where possible, so
// an overridden theme doesn't flash the system theme on launch.
void hydrateThemePreference();

// Anonymous usage counters: read the opt-out and send on background.
startUsageStats();

// Web: offline start and cached build files (public/sw.js). No-op on native.
registerServiceWorker();

// Drive React Query's online state from the device's real connectivity so
// queries pause offline and auto-refetch when the network returns.
//
// Web: where `navigator.connection` exists (Chrome, Android browsers) NetInfo
// listens ONLY to its 'change' event, which does not fire on every offline /
// online flip. Coming back online then went unnoticed: paused queries never
// resumed and Home kept its "saved battles" until a manual retry. The
// browser's own online/offline events make NetInfo re-read the state.
// The same state drives src/lib/networkRecovery.ts (sockets + live lists).
onlineManager.setEventListener((setOnline) => {
  const unsubscribe = NetInfo.addEventListener((state) => {
    const online = !!state.isConnected;
    setOnline(online);
    reportConnectivity(online);
  });
  const reRead = () => void NetInfo.refresh();
  const web = Platform.OS === 'web' && typeof window !== 'undefined';
  if (web) {
    window.addEventListener('online', reRead);
    window.addEventListener('offline', reRead);
  }
  return () => {
    unsubscribe();
    if (web) {
      window.removeEventListener('online', reRead);
      window.removeEventListener('offline', reRead);
    }
  };
});

// Resilient defaults: retry transient failures, keep data briefly fresh, and
// refetch when connectivity returns — important on flaky mobile networks.
const queryClient = new QueryClient({
  // Report every query error; toast only on user-triggered mutation failures to
  // avoid spamming toasts for background refetches.
  queryCache: new QueryCache({
    onError: (error) => {
      if (shouldReportQueryError(error)) reportError(error);
    },
  }),
  mutationCache: new MutationCache({
    onError: (error: any) => {
      reportError(error);
      emitToast(error?.message || 'Something went wrong. Please try again.', 'error');
    },
  }),
  defaultOptions: {
    queries: {
      // The request core already retries transient read failures; see
      // src/sync/queryPolicy.ts for why this no longer stacks on top of it.
      retry: shouldRetryQuery,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
      staleTime: 30_000,
      // Unused data stays in memory for 30 min (react-query's default is 5), so
      // data restored from disk at launch (src/lib/queryPersistence.ts) is still
      // there when an offline user opens that screen a few minutes later.
      gcTime: 30 * 60_000,
      refetchOnReconnect: true,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 0,
    },
  },
});

/**
 * App Control gate (admin panel → App Control), for every route.
 *
 *  1. Maintenance (manual or scheduled; staff may enter anyway) → /maintenance.
 *     Sign-in and legal pages stay reachable, so staff can log in.
 *  2. A required update (native only; "soft" can be snoozed) → /force-update.
 *  3. A route whose feature is switched off → /feature-off.
 * Everything is live: LiveAppConfig pushes admin changes in seconds, and a
 * scheduled window switches at its minute without a fetch.
 */
function MaintenanceGuard({ children }: { children: React.ReactNode }) {
  const { control, config, loading } = useAppControl();
  const viewer = useViewer();
  const segments = useSegments() as string[];
  const router = useRouter();
  const top = segments[0];
  const blocked = control.maintenance.active && !control.maintenance.bypassed;
  const routeFeature = featureForRoute(segments);
  // Signed-in only: every feature route is private, so a guest is sent to sign
  // in by the root guard — two guards redirecting at once would race.
  const featureBlocked = viewer.signedIn && !!routeFeature && !featureOn(config, routeFeature, viewer.uid);

  useEffect(() => {
    if (loading) return;
    if (blocked) {
      if (!allowedDuringMaintenance(segments)) router.replace('/maintenance');
      return;
    }
    if (control.update.required) {
      if (top !== 'force-update') router.replace('/force-update');
      return;
    }
    if (top === 'maintenance' || top === 'force-update') {
      router.replace('/');
      return;
    }
    if (featureBlocked && routeFeature) router.replace(`/feature-off?f=${routeFeature}` as any);
  }, [loading, blocked, control.update.required, featureBlocked, routeFeature, top, segments, router]);

  return <>{children}</>;
}

/**
 * Redirect a signed-in user whose account is scheduled for deletion to the
 * reactivation gate — from ANY route, and back to the app once they cancel.
 *
 * This is the always-on safety net behind app/splash.tsx's cold-start check: it
 * also catches a deletion requested on another device mid-session, and a direct
 * deep-link into the app. `/read/users/:id` hides pending accounts, so without a
 * dedicated status read the app has no other way to know.
 *
 * Cheap: one cached `/read/me/status` read per session (staleTime), and the query
 * only runs while logged in. Maintenance / force-update take priority — those gates
 * are about the whole app, this one is about a single account.
 */
function DeletionGuard({ children }: { children: React.ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  const { data } = useQuery({
    queryKey: ['me-status', user?.uid],
    queryFn: () => readApi('/read/me/status'),
    enabled: !!user && !authLoading,
    staleTime: 120_000,
  });

  const pending =
    !!user && (data as any)?.status === 'pending_deletion' && !!(data as any)?.deletion;

  useEffect(() => {
    if (!user || !data) return; // not logged in, or status not known yet
    const top = segments[0];
    // Let the app-wide gates win — never fight maintenance / force-update.
    if (top === 'maintenance' || top === 'force-update') return;
    const onGate = top === 'account-scheduled-deletion';
    if (pending && !onGate) {
      router.replace('/account-scheduled-deletion');
    } else if (!pending && onGate) {
      // Deletion was cancelled (here or elsewhere) — hand the user back to the app.
      router.replace('/home');
    }
  }, [pending, segments, user, data, router]);

  return <>{children}</>;
}

// Main Root Layout Component
function RootLayoutNav() {
  const { user, loading } = useAuth(); // One shared, already-resolved session snapshot
  // Warm and persist public identity once per authenticated launch. Screens share
  // this react-query row; Explore can paint the cached avatar/name while a fresh
  // profile is still loading, without ever caching wallet/private fields.
  const { data: shellProfile } = useProfile(user?.uid || '');
  useCachedIdentity(user?.uid, shellProfile);

  // Drop every cached query when the signed-in account changes (sign-out, or a
  // different account signing in). The client is module-scoped and lives for the
  // whole JS session, and several keys are not uid-scoped (e.g. ['stories'],
  // ['match', id]) — so the next account on the device was served the previous
  // account's viewer-specific data until each query happened to refetch.
  const lastUidRef = React.useRef<string | null | undefined>(undefined);
  React.useEffect(() => {
    if (loading) return;
    const uid = user?.uid ?? null;
    const prev = lastUidRef.current;
    if (prev !== undefined && prev !== uid) {
      queryClient.clear();
      if (shouldWipeDeviceCaches(prev, uid)) {
        // The on-device Story cache is not keyed by account either: wipe it so a
        // guest (or the next account) never sees the previous viewer's
        // followers-only Stories or replays their queued reactions.
        void import('@/src/services/stories/offlineStoryService')
          .then(({ clearLocalStories }) => clearLocalStories())
          .catch((e) => console.error('Story cache clear failed', e));
        // Same for the Home feed snapshot: it carries the previous viewer's
        // vote/like/bookmark flags and their personalised ordering. Home also keys
        // its reads by uid, so this is defence in depth plus the storage bound.
        void import('@/src/lib/feedSnapshot')
          .then(({ clearFeedSnapshots }) => clearFeedSnapshots())
          .catch((e) => console.error('Feed snapshot clear failed', e));
        void clearOffline();
      } else {
        // Guest -> account. The guest shell can come FIRST for an account that
        // was already signed in (Continue as guest while a slow network delayed
        // the restore). Wiping here deleted that account's own offline feed,
        // Stories and saved screens. Every cache is owner-checked on read, so
        // nothing of another account can surface; restore this account's.
        void restoreQueries(queryClient, offlineOwner(uid));
      }
    }
    // Resolved identity (launch or a change): load this account's pending
    // offline intents for the UI, then send them.
    if (lastUidRef.current !== uid) onAccountChangedForSync();
    lastUidRef.current = uid;
  }, [user?.uid, loading]);

  // Local-database housekeeping, once per launch and off the critical path:
  // expired Story rows and week-old queued actions. Both helpers existed but had
  // no caller, so the tables were bounded only by the next account switch.
  React.useEffect(() => {
    const t = setTimeout(() => {
      void import('@/src/services/stories/offlineStoryService')
        .then(({ clearExpiredStories, clearOldPendingActions }) =>
          Promise.all([clearExpiredStories(), clearOldPendingActions()]),
        )
        .catch((e) => console.error('Local cache housekeeping failed', e));
    }, 5000);
    return () => clearTimeout(t);
  }, []);
  const segments = useSegments();
  const router = useRouter();

  // A Firebase email action link (?mode=…&oobCode=…) can land on ANY route,
  // because the console's action URL is free-form. Claim it for the handler
  // before anything else renders, or a password reset ends up on the login
  // screen with no way to set a password. Declared first so it wins the race
  // against the auth gate below.
  useFirebaseActionLink();
  
  // Hook to handle notification listeners
  useEffect(() => {
    const open = (response: Notifications.NotificationResponse) => {
      // The launch tap can arrive both from getLastNotificationResponse and the
      // listener; route it once.
      const key = response.notification.request.identifier;
      if (key && handledNotificationTaps.has(key)) return;
      if (key) handledNotificationTaps.add(key);
      const data = response.notification.request.content.data;

      // Resolve the destination with the SAME shared helper the in-app list
      // uses, so a tap behaves identically from the OS tray or inside the app.
      // `data.url` (admin deep-link) wins; otherwise the real backend `type`
      // string (follow, match_like, contest-win, purchase, ...) maps to a route.
      try {
          const dest = getNotificationDestination(
              data?.type as string | undefined,
              data?.targetId as string | undefined,
              data?.url as string | undefined,
          );
          router.push((dest || '/notifications') as any);
      } catch (e) {
          console.error('Notification navigation failed', e);
          router.push('/notifications');
      }
    };
    const subscription = Notifications.addNotificationResponseReceivedListener(open);
    // A tap that LAUNCHED the app (from killed) can happen before this listener
    // exists, so it never routed and the user landed on Home.
    if (Platform.OS !== 'web') {
      try {
        const last = Notifications.getLastNotificationResponse();
        if (last) {
          open(last);
          Notifications.clearLastNotificationResponse();
        }
      } catch (e) {
        console.warn('[notifications] launch response unavailable', e);
      }
    }

    // Also handle foreground notifications if needed
    const foregroundSubscription = Notifications.addNotificationReceivedListener(() => {
        // You can show a toast here if you want custom UI instead of system alert
    });

    // Replay queued story actions whenever connectivity returns.
    //
    // This registration belongs in the effect body. It previously sat *inside*
    // the notification-response callback above, which meant offline sync only
    // armed once the user tapped a notification, leaked an extra NetInfo
    // listener on every tap, and the cleanup referenced an undefined `sub`.
    // Queued offline work (social outbox + Story views/reactions) is sent on
    // reconnect, foreground and launch, debounced (src/sync/index.ts). This
    // replaces a listener that re-ran the Story sync on every NetInfo event.
    const unsubscribeNetInfo = startOfflineSync();

    return () => {
        subscription.remove();
        foregroundSubscription.remove();
        unsubscribeNetInfo();
    };
  }, []);

  /**
   * The route guard — guest-first. The policy itself lives in
   * src/lib/routeAccess.ts (exact segment matching, fail-closed for unlisted
   * routes); this only applies it:
   *  - guests browse public content freely and are sent to sign in only for a
   *    private screen, with a sanitised return path;
   *  - a signed-in user who lands on a sign-in/sign-up screen goes on to their
   *    destination, except right after signing in there (that screen routes
   *    itself — e.g. a brand-new account to profile setup);
   *  - splash and the maintenance/update/deletion gates own their own navigation,
   *    so there is exactly one authority per route.
   */
  const pathname = usePathname();
  const globalParams = useGlobalSearchParams();
  // `?ref=CODE` on any link (e.g. tophunt.in/?ref=THX1Y2Z3): remember the code
  // for signup, like an /invite/CODE link (src/services/referrals.ts).
  const refParam = typeof globalParams.ref === 'string' ? globalParams.ref : null;
  useEffect(() => {
    if (refParam) void savePendingInvite(refParam);
  }, [refParam]);
  // One guard per mount; it remembers the previous signed-in state (see
  // src/lib/rootGuard.ts, which is where this behaviour is tested).
  const guardRef = React.useRef(createRootGuard());
  // Onboarding status of the signed-in user (src/lib/profileCompletion.ts): resolved
  // from the server whenever the account changes, and flipped back to
  // "incomplete" by any PROFILE_INCOMPLETE answer (services/api.ts).
  const onboardingState = React.useSyncExternalStore(subscribeOnboarding, onboardingSnapshot, onboardingSnapshot);
  const onboarding = onboardingStatusFor(user?.uid);
  useEffect(() => {
    if (loading) return;
    if (!user) {
      resetOnboarding();
      return;
    }
    void refreshOnboarding(user.uid, (uid) => readApiLive(`/read/users/${encodeURIComponent(uid)}`));
  }, [user?.uid, loading]);
  useEffect(() => {
    guardRef.current.run(
      {
        signedIn: !!user,
        loading,
        onboarding,
        segments: segments as string[],
        params: globalParams as Record<string, unknown>,
        pathname,
      },
      {
        replace: (to) => router.replace(to as any),
        back: () => router.back(),
        canGoBack: () => router.canGoBack(),
      },
    );
  }, [user, loading, segments, pathname, globalParams, onboarding, onboardingState]);

  useEffect(() => {
    // Register for push notifications only when user is logged in
    if (user && !loading) {
      notificationService.registerForPushNotificationsAsync(user.uid);
    }
  }, [user, loading]);

  return (
    <MaintenanceGuard>
      <DeletionGuard>
        {/*
          Desktop browsers get a centred phone-width column, because every
          screen is a phone layout. Blog posts opt out (/blog/[slug] and the
          root /[slug] permalink): BlogDetailScreen has its own 800px reading
          column. The blog LIST is a phone layout, so it stays framed.
        */}
        <PhoneFrame
          disabled={
            segments[0] === '[slug]' ||
            (segments[0] === 'blog' && (segments as string[])[1] === '[slug]')
          }
        >
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="index" />
            <Stack.Screen name="splash" />
            <Stack.Screen name="home" />
            <Stack.Screen name="maintenance" options={{ gestureEnabled: false }} />
            <Stack.Screen name="force-update" options={{ gestureEnabled: false }} />
            <Stack.Screen name="feature-off" options={{ gestureEnabled: false }} />
            <Stack.Screen name="account-scheduled-deletion" options={{ gestureEnabled: false }} />
            <Stack.Screen name="notifications/index" options={{ presentation: 'modal', title: 'Notifications' }} />
            <Stack.Screen name="notifications/requests" options={{ presentation: 'modal', title: 'Follow requests' }} />
          </Stack>
          {/* Keeps App Control (maintenance, update, flags, banner) live on this device. */}
          <LiveAppConfig />
          {/* Upcoming-maintenance notice, and the staff "maintenance is ON" bar. */}
          <AppControlBars />
          {/* Admin-controlled announcement banner (main screens; dismissal persists per announcement). */}
          <AnnouncementBanner />
          {/* Admin-controlled announcement popup (targeted, 24h-snooze modal). */}
          <AnnouncementPopup />
          <VerificationRewardPopup />
          {/* Connectivity banner shown whenever the device goes offline. */}
          <OfflineBanner />
        </PhoneFrame>
      </DeletionGuard>
    </MaintenanceGuard>
  );
}


/** Notification taps already routed (by request identifier), across remounts. */
const handledNotificationTaps = new Set<string>();

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const authSession = useAuth();
  // Saved screens (profile, explore, rewards…) for this viewer: restored once on
  // launch, saved after fetches. src/lib/queryPersistence.ts.
  const persistOwner =
    authSession.status === 'authenticated' && authSession.user
      ? offlineOwner(authSession.user.uid)
      : authSession.status === 'guest'
        ? offlineOwner(null)
        : null;
  const queriesRestored = useQueryPersistence(queryClient, persistOwner);

  /**
   * Text fonts.
   *
   * These load HERE because the root layout is the only component that mounts on
   * every route. They used to load inside `app/splash.tsx`, which works from a
   * cold start (index -> splash always runs first) but silently fails the moment
   * a route is opened directly — a refresh, a bookmark, a shared link or a search
   * result all mount the target screen WITHOUT ever mounting the splash route, so
   * `Font.loadAsync` never ran.
   *
   * The failure was invisible in code review and obvious on screen: the ~400
   * `fontFamily: 'Urbanist-*'` styles across the app fell back to the browser's
   * default face, so every text-bearing screen rendered in the wrong typeface for
   * anyone who did not enter through the splash.
   */
  const [fontsLoaded, fontError] = useFonts({
    'Urbanist-Regular': require('../assets/fonts/Urbanist-Regular.ttf'),
    'Urbanist-Medium': require('../assets/fonts/Urbanist-Medium.ttf'),
    'Urbanist-SemiBold': require('../assets/fonts/Urbanist-SemiBold.ttf'),
    'Urbanist-Bold': require('../assets/fonts/Urbanist-Bold.ttf'),
  });

  // A font that fails to load must be reported, not absorbed. The bug above was
  // only ever visible to someone looking at the screen; the fallback itself never
  // said anything, which is why it survived.
  useEffect(() => {
    if (fontError) reportError(fontError, { scope: 'root-layout', asset: 'urbanist-fonts' });
  }, [fontError]);

  const fontsReady = fontsLoaded || !!fontError;
  useEffect(() => {
    if (!fontsReady || authSession.loading) return;
    if (Platform.OS !== 'web') void NativeSplash.hideAsync().catch(() => {});
  }, [fontsReady, authSession.loading]);

  /*
   * Hold the first paint until the fonts resolve, so text never renders in the
   * fallback face and then reflows once the real one arrives.
   *
   * `fontError` counts as resolved on purpose: a missing font must degrade to the
   * system face, never leave a blank app. Blocking is safe here because the web
   * build is a SPA (`web.output: "single"`) whose crawlable meta is injected by
   * the edge worker in `public/_worker.js` — no indexed content depends on this
   * render. On native the OS splash is still up, so there is nothing to flash.
   */
  if (!fontsReady) return null;

  // The crucial visual gate: the route tree does not mount while persisted auth
  // is unknown, so no child can paint Login / Signup, a `?` avatar, guest feed,
  // or guest-shaped viewer queries for an account Firebase is about to restore.
  if (authSession.status === 'restoring') return <AuthStartupGate />;
  // At most RESTORE_WAIT_MS more on the splash, so the first screen paints saved
  // data instead of skeletons when offline.
  if (persistOwner && !queriesRestored) return <AuthStartupGate />;
  if (authSession.status === 'error') {
    return <AuthStartupGate failed onRetry={authSession.retry} onContinue={authSession.continueAsGuest} />;
  }

  return (
    <ErrorBoundary>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
          <QueryClientProvider client={queryClient}>
            <PaperProvider>
              <ToastProvider>
                <ThemeProvider value={colorScheme === 'dark' ? darkTheme : lightTheme}>
                  <RootLayoutNav />
                  {/*
                    Hosts the confirmation dialog for `src/lib/appAlert.ts`. Must
                    live inside ThemeProvider (it is themed) and be mounted for
                    the whole session, since any screen can raise a confirmation.
                  */}
                  <ConfirmHost />
                  <StatusBar style="auto" />
                </ThemeProvider>
              </ToastProvider>
            </PaperProvider>
          </QueryClientProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </ErrorBoundary>
  );
}
