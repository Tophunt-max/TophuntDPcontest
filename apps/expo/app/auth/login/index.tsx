import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
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
  Sms_Icon,
} from "../../../assets/svgs";
import { useColorScheme } from "../../../hooks/use-color-scheme";
import { useToast } from "../../../src/components/toast/ToastProvider";
import { Colors } from "@/constants/theme";
import { SocialAuthService } from "../../../src/services/auth/socialAuth";
import { doc, onSnapshot } from "firebase/firestore";
import { firestore as db } from "../../../src/services/firebase/initFirebase";

const { width } = Dimensions.get("window");

interface AuthConfig {
  googleLogin: boolean;
  facebookLogin: boolean;
  appleLogin: boolean;
  phoneLogin: boolean;
  passwordLogin: boolean;
}

export default function LoginWelcomeScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const redirect = params.redirect as string | undefined;

  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const textColor = isDark ? Colors.dark.text : Colors.light.text;
  const { addToast } = useToast();
  
  const [loading, setLoading] = useState<string | null>(null);
  const [isConfigLoading, setIsConfigLoading] = useState(true);
  const [config, setConfig] = useState<AuthConfig>({
    googleLogin: true,
    facebookLogin: true,
    appleLogin: true,
    phoneLogin: true,
    passwordLogin: true
  });

  // REAL-TIME Sync with Admin Settings
  useEffect(() => {
    console.log("Listening for Auth Settings changes...");
    const docRef = doc(db, "settings", "appConfig");
    
    const unsubscribe = onSnapshot(docRef, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        console.log("New Auth Settings received:", data.authSettings);
        if (data.authSettings) {
          setConfig({
            googleLogin: data.authSettings.googleLogin ?? true,
            facebookLogin: data.authSettings.facebookLogin ?? true,
            appleLogin: data.authSettings.appleLogin ?? true,
            phoneLogin: data.authSettings.phoneLogin ?? true,
            passwordLogin: data.authSettings.passwordLogin ?? true,
          });
        }
      }
      setIsConfigLoading(false);
    }, (error) => {
      console.error("Firestore Listen Error:", error);
      setIsConfigLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const handleSocialLogin = async (provider: string) => {
    if (provider === "Phone") {
      router.push("/auth/login/phone");
      return;
    }

    setLoading(provider);
    try {
      if (provider === "Google") {
        await SocialAuthService.googleLogin(router, addToast);
      } else if (provider === "Facebook") {
        await SocialAuthService.facebookLogin(router, addToast);
      } else if (provider === "Apple") {
        await SocialAuthService.appleLogin(router, addToast);
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

  if (isConfigLoading) {
    return (
      <View style={[styles.container, { backgroundColor, justifyContent: 'center' }]}>
        <ActivityIndicator size="large" color="#FF4D67" />
        <Text style={{ marginTop: 10, color: textColor, textAlign: 'center' }}>Connecting...</Text>
      </View>
    );
  }

  return (
    <View
      style={[
        styles.container,
        { backgroundColor, paddingTop: insets.top, paddingBottom: insets.bottom },
      ]}
    >
      <View style={styles.contentContainer}>
        {/* Welcome Illustration */}
        <View style={styles.illustrationContainer}>
           {isDark ? (
             <Connect_Dark width={width * 0.6} height={width * 0.4} />
           ) : (
             <Connect_Light width={width * 0.6} height={width * 0.4} />
           )}
        </View>

        <Text style={[styles.title, { color: textColor, fontFamily: 'Urbanist-Bold' }]}>Let's you in</Text>

        <View style={styles.socialButtonsContainer}>
          {config.facebookLogin && (
            <TouchableOpacity
              style={[styles.socialButton, { backgroundColor: isDark ? '#1F222A' : '#fff', borderColor: isDark ? '#35383F' : '#eee' }]}
              onPress={() => handleSocialLogin("Facebook")}
              disabled={loading !== null}
            >
              {loading === "Facebook" ? <ActivityIndicator color={textColor} /> : (
                <>
                  <Facebook_Icon width={24} height={24} />
                  <Text style={[styles.socialButtonText, { color: textColor, fontFamily: 'Urbanist-Medium' }]}>Continue with Facebook</Text>
                </>
              )}
            </TouchableOpacity>
          )}

          {config.googleLogin && (
            <TouchableOpacity
              style={[styles.socialButton, { backgroundColor: isDark ? '#1F222A' : '#fff', borderColor: isDark ? '#35383F' : '#eee' }]}
              onPress={() => handleSocialLogin("Google")}
              disabled={loading !== null}
            >
              {loading === "Google" ? <ActivityIndicator color={textColor} /> : (
                <>
                  <Google_Icon width={24} height={24} />
                  <Text style={[styles.socialButtonText, { color: textColor, fontFamily: 'Urbanist-Medium' }]}>Continue with Google</Text>
                </>
              )}
            </TouchableOpacity>
          )}

          {config.appleLogin && (
            <TouchableOpacity
              style={[styles.socialButton, { backgroundColor: isDark ? '#1F222A' : '#fff', borderColor: isDark ? '#35383F' : '#eee' }]}
              onPress={() => handleSocialLogin("Apple")}
              disabled={loading !== null}
            >
              {loading === "Apple" ? <ActivityIndicator color={textColor} /> : (
                <>
                  {isDark ? <Apple_Light width={24} height={24} /> : <Apple_Dark width={24} height={24} />}
                  <Text style={[styles.socialButtonText, { color: textColor, fontFamily: 'Urbanist-Medium' }]}>Continue with Apple</Text>
                </>
              )}
            </TouchableOpacity>
          )}

          {config.phoneLogin && (
            <TouchableOpacity
              style={[styles.socialButton, { backgroundColor: isDark ? '#1F222A' : '#fff', borderColor: isDark ? '#35383F' : '#eee' }]}
              onPress={() => handleSocialLogin("Phone")}
              disabled={loading !== null}
            >
              <Sms_Icon width={24} height={24} fill={textColor} />
              <Text style={[styles.socialButtonText, { color: textColor, fontFamily: 'Urbanist-Medium' }]}>Continue with Phone</Text>
            </TouchableOpacity>
          )}
        </View>

        {(config.facebookLogin || config.googleLogin || config.appleLogin || config.phoneLogin) && config.passwordLogin && (
          <View style={styles.dividerContainer}>
            <View style={[styles.dividerLine, { backgroundColor: isDark ? '#35383F' : '#eee' }]} />
            <Text style={[styles.dividerText, { color: textColor, fontFamily: 'Urbanist-Medium' }]}>or</Text>
            <View style={[styles.dividerLine, { backgroundColor: isDark ? '#35383F' : '#eee' }]} />
          </View>
        )}

        {config.passwordLogin && (
          <TouchableOpacity
            style={styles.passwordButton}
            onPress={handlePasswordLogin}
            disabled={loading !== null}
          >
            <Text style={[styles.passwordButtonText, { fontFamily: 'Urbanist-Bold' }]}>Sign in with password</Text>
          </TouchableOpacity>
        )}

        <View style={styles.footerContainer}>
          <Text style={[styles.footerText, { color: isDark ? '#E0E0E0' : 'gray', fontFamily: 'Urbanist-Regular' }]}>
            Don't have an account?{" "}
          </Text>
          <TouchableOpacity onPress={() => router.push("/auth/signup")}>
            <Text style={[styles.signupText, { fontFamily: 'Urbanist-Bold' }]}>Sign up</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  contentContainer: {
    flex: 1,
    paddingHorizontal: 24,
    justifyContent: "center",
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
