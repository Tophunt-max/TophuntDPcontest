import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  useWindowDimensions,
  ActivityIndicator,
} from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Facebook_Icon,
  Google_Icon,
  Apple_Light,
  Apple_Dark,
  Connect_Light,
  Connect_Dark,
  Phone_Color,
} from "../../../assets/svgs";
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useToast } from "../../../src/components/toast/ToastProvider";
import { Colors } from "@/constants/theme";
import { SocialAuthService, socialProviderAvailability, completeWebRedirectSignIn } from "../../../src/services/auth/socialAuth";
import { designWidth, PHONE_MAX_WIDTH } from "@/src/lib/layout";
import { useAuthMethods } from "@/src/hooks/useAuthMethods";
import { lastAuthMethod, type LastAuthMethod } from "@/src/lib/lastAuthMethod";
import { InAppBrowserNotice } from "@/src/components/auth/InAppBrowserNotice";

export default function LoginWelcomeScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const redirect = params.redirect as string | undefined;

  const insets = useSafeAreaInsets();
  // `useWindowDimensions` rather than a module-scope `Dimensions.get('window')`:
  // the latter is captured once when the bundle loads, so resizing a desktop
  // browser left the illustration sized for whatever window the user arrived with.
  const { width: windowWidth } = useWindowDimensions();
  // Clamped, or a wide window makes the art tall enough to push the content past
  // the viewport — which is what made this screen unreadable on desktop.
  const artWidth = designWidth(windowWidth);
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const textColor = isDark ? Colors.dark.text : Colors.light.text;
  const { addToast } = useToast();
  
  // A provider with no client id for this platform cannot complete a sign-in, so
  // the button is hidden rather than shown and then failing.
  const socialAvailable = socialProviderAvailability();
  const [loading, setLoading] = useState<string | null>(null);
  // Admin-managed switches (App Control -> Login & Signup), for this platform.
  const { methods, ready } = useAuthMethods();
  const show = {
    facebook: methods.facebook && socialAvailable.facebook,
    google: methods.google && socialAvailable.google,
    apple: methods.apple && socialAvailable.apple,
    phone: methods.phone,
    password: methods.password,
  };
  const anySocial = show.facebook || show.google || show.apple || show.phone;
  const [lastUsed, setLastUsed] = useState<LastAuthMethod | null>(null);
  useEffect(() => {
    void lastAuthMethod().then(setLastUsed);
  }, []);

  // Web: finish a sign-in that fell back from a blocked popup to a redirect.
  const redirectChecked = React.useRef(false);
  useEffect(() => {
    if (!ready || redirectChecked.current) return;
    redirectChecked.current = true;
    void completeWebRedirectSignIn(router, addToast, methods);
  }, [ready, router, addToast, methods]);

  const handleSocialLogin = async (provider: string) => {
    // `redirect` is forwarded to EVERY branch, not just the password one. A shared
    // `/@handle` link sends anonymous visitors here, so a branch that drops it lands
    // them on the home feed instead of the profile they followed a link to.
    if (provider === "Phone") {
      router.push(
        redirect ? `/auth/login/phone?redirect=${encodeURIComponent(redirect)}` : "/auth/login/phone",
      );
      return;
    }

    setLoading(provider);
    try {
      if (provider === "Google") {
        await SocialAuthService.googleLogin(router, addToast, redirect, { methods });
      } else if (provider === "Facebook") {
        await SocialAuthService.facebookLogin(router, addToast, redirect, { methods });
      } else if (provider === "Apple") {
        await SocialAuthService.appleLogin(router, addToast, redirect, { methods });
      }
    } catch (error: any) {
      // Error handled in service
    } finally {
      setLoading(null);
    }
  };

  const handlePasswordLogin = () => {
    if (redirect) {
        router.push(`/auth/login/password?redirect=${encodeURIComponent(redirect)}`);
    } else {
        router.push("/auth/login/password");
    }
  };

  if (!ready) {
    return (
      <View style={[styles.container, { backgroundColor, justifyContent: 'center' }]}>
        <ActivityIndicator size="large" color="#FF4D67" />
        <Text style={{ marginTop: 10, color: textColor, textAlign: 'center' }}>Connecting...</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor }]}>
      {/*
        The content has to be able to SCROLL, not just be centred.
        `contentContainerStyle` (not `style`) is what carries the centring, and it
        uses `flexGrow: 1` rather than `flex: 1` — `flex: 1` sets `flex-basis: 0`,
        which collapses the container and reintroduces the very bug this fixes.
        With `flexGrow`, the content box is max(content, viewport): still centred
        when it fits, scrollable when it does not.

        Before this, the screen was a fixed-height centred View. When the content
        grew taller than the window — routine in a desktop browser — it overflowed
        symmetrically and the web build's `body { overflow: hidden }` clipped
        219px off the TOP and the BOTTOM, unreachable, with no scrollbar.
      */}
      <ScrollView
        contentContainerStyle={[
          styles.contentContainer,
          // Insets move onto the scrolling content so the safe area is respected
          // without shrinking the scroll viewport itself.
          { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 },
        ]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/*
          A phone-width column, centred. Without the cap, every full-width child
          here — the four social buttons and the password button — stretched the
          entire 1280px of a desktop window, which reads as a broken page rather
          than a deliberate one. Below 420px (every phone) this changes nothing.
        */}
        <View style={styles.column}>
        {/* Welcome Illustration */}
        <View style={styles.illustrationContainer}>
           {isDark ? (
             <Connect_Dark width={artWidth * 0.6} height={artWidth * 0.4} />
           ) : (
             <Connect_Light width={artWidth * 0.6} height={artWidth * 0.4} />
           )}
        </View>

        <Text style={[styles.title, { color: textColor, fontFamily: 'Urbanist-Bold' }]}>Let&apos;s you in</Text>

        <InAppBrowserNotice isDark={isDark} />

        {!anySocial && !show.password && (
          <Text style={[styles.noMethods, { color: textColor }]}>
            Login abhi thodi der ke liye band hai. Kuch der baad try karo.
          </Text>
        )}

        <View style={styles.socialButtonsContainer}>
          {show.facebook && (
            <TouchableOpacity
              style={[styles.socialButton, { backgroundColor: isDark ? '#1F222A' : '#fff', borderColor: isDark ? '#35383F' : '#eee' }]}
              onPress={() => handleSocialLogin("Facebook")}
              disabled={loading !== null}
            >
              {loading === "Facebook" ? <ActivityIndicator color={textColor} /> : (
                <>
                  <Facebook_Icon width={24} height={24} />
                  <Text style={[styles.socialButtonText, { color: textColor, fontFamily: 'Urbanist-Medium' }]}>Continue with Facebook</Text>
                  {lastUsed === 'facebook' && <LastUsedPill />}
                </>
              )}
            </TouchableOpacity>
          )}

          {show.google && (
            <TouchableOpacity
              style={[styles.socialButton, { backgroundColor: isDark ? '#1F222A' : '#fff', borderColor: isDark ? '#35383F' : '#eee' }]}
              onPress={() => handleSocialLogin("Google")}
              disabled={loading !== null}
            >
              {loading === "Google" ? <ActivityIndicator color={textColor} /> : (
                <>
                  <Google_Icon width={24} height={24} />
                  <Text style={[styles.socialButtonText, { color: textColor, fontFamily: 'Urbanist-Medium' }]}>Continue with Google</Text>
                  {lastUsed === 'google' && <LastUsedPill />}
                </>
              )}
            </TouchableOpacity>
          )}

          {show.apple && (
            <TouchableOpacity
              style={[styles.socialButton, { backgroundColor: isDark ? '#1F222A' : '#fff', borderColor: isDark ? '#35383F' : '#eee' }]}
              onPress={() => handleSocialLogin("Apple")}
              disabled={loading !== null}
            >
              {loading === "Apple" ? <ActivityIndicator color={textColor} /> : (
                <>
                  {isDark ? <Apple_Light width={24} height={24} /> : <Apple_Dark width={24} height={24} />}
                  <Text style={[styles.socialButtonText, { color: textColor, fontFamily: 'Urbanist-Medium' }]}>Continue with Apple</Text>
                  {lastUsed === 'apple' && <LastUsedPill />}
                </>
              )}
            </TouchableOpacity>
          )}

          {show.phone && (
            <TouchableOpacity
              style={[styles.socialButton, { backgroundColor: isDark ? '#1F222A' : '#fff', borderColor: isDark ? '#35383F' : '#eee' }]}
              onPress={() => handleSocialLogin("Phone")}
              disabled={loading !== null}
            >
              <Phone_Color width={24} height={24} />
              <Text style={[styles.socialButtonText, { color: textColor, fontFamily: 'Urbanist-Medium' }]}>Continue with Phone</Text>
              {lastUsed === 'phone' && <LastUsedPill />}
            </TouchableOpacity>
          )}
        </View>

        {anySocial && show.password && (
          <View style={styles.dividerContainer}>
            <View style={[styles.dividerLine, { backgroundColor: isDark ? '#35383F' : '#eee' }]} />
            <Text style={[styles.dividerText, { color: textColor, fontFamily: 'Urbanist-Medium' }]}>or</Text>
            <View style={[styles.dividerLine, { backgroundColor: isDark ? '#35383F' : '#eee' }]} />
          </View>
        )}

        {show.password && (
          <TouchableOpacity
            style={styles.passwordButton}
            onPress={handlePasswordLogin}
            disabled={loading !== null}
          >
            <Text style={[styles.passwordButtonText, { fontFamily: 'Urbanist-Bold' }]}>
              Sign in with password{lastUsed === 'password' ? '  · Last used' : ''}
            </Text>
          </TouchableOpacity>
        )}

        {methods.signupsOpen ? (
          <View style={styles.footerContainer}>
            <Text style={[styles.footerText, { color: isDark ? '#E0E0E0' : 'gray', fontFamily: 'Urbanist-Regular' }]}>
              Don&apos;t have an account?{" "}
            </Text>
            <TouchableOpacity onPress={() => router.push("/auth/signup")}>
              <Text style={[styles.signupText, { fontFamily: 'Urbanist-Bold' }]}>Sign up</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <Text style={[styles.footerText, { color: isDark ? '#E0E0E0' : 'gray', fontFamily: 'Urbanist-Regular', textAlign: 'center' }]}>
            {methods.signupsClosedMessage}
          </Text>
        )}
        </View>
      </ScrollView>
    </View>
  );
}

/** "Last used" marker on the method this device signed in with last time. */
function LastUsedPill() {
  return (
    <View style={styles.lastUsedPill}>
      <Text style={styles.lastUsedText}>Last used</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  lastUsedPill: {
    marginLeft: 10,
    backgroundColor: "#FFE8EC",
    borderRadius: 10,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  lastUsedText: {
    color: "#FF4D67",
    fontSize: 11,
    fontFamily: "Urbanist-Bold",
  },
  noMethods: {
    fontSize: 15,
    textAlign: "center",
    marginBottom: 20,
    fontFamily: "Urbanist-Medium",
  },
  contentContainer: {
    // flexGrow, NOT flex. See the ScrollView above: `flex: 1` implies
    // `flex-basis: 0`, which collapses a scroll container's content box back to
    // the viewport height and restores the clipping this screen was fixed for.
    flexGrow: 1,
    paddingHorizontal: 24,
    justifyContent: "center",
    alignItems: "center",
  },
  // Caps the layout at phone width on a desktop window; a no-op on phones.
  column: {
    width: "100%",
    maxWidth: PHONE_MAX_WIDTH,
    alignItems: "center",
  },
  illustrationContainer: {
    marginBottom: 20,
    alignItems: "center",
  },
  title: {
    fontSize: 32,
    marginBottom: 30,
    textAlign: "center",
  },
  socialButtonsContainer: {
    width: "100%",
    gap: 12,
  },
  socialButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderRadius: 16,
    paddingVertical: 14,
    paddingHorizontal: 20,
    minHeight: 56,
  },
  socialButtonText: {
    marginLeft: 12,
    fontSize: 16,
  },
  dividerContainer: {
    flexDirection: "row",
    alignItems: "center",
    width: "100%",
    marginVertical: 20,
  },
  dividerLine: {
    flex: 1,
    height: 1,
  },
  dividerText: {
    marginHorizontal: 16,
    fontSize: 16,
  },
  passwordButton: {
    width: "100%",
    backgroundColor: "#FF4D67",
    borderRadius: 30,
    paddingVertical: 18,
    alignItems: "center",
    marginBottom: 24,
    shadowColor: "#FF4D67",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  passwordButtonText: {
    color: "#fff",
    fontSize: 16,
  },
  footerContainer: {
    flexDirection: "row",
    alignItems: "center",
  },
  footerText: {
    fontSize: 14,
  },
  signupText: {
    fontSize: 14,
    color: "#FF4D67",
  },
});
