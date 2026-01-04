import React from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Image,
  Dimensions,
  Platform,
} from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Facebook_Icon,
  Google_Icon,
  Apple_Light,
  Apple_Dark,
} from "../../../assets/svgs";
import Images from "../../../assets/images";
import { useThemeColor } from "../../../hooks/use-theme-color";
import { useColorScheme } from "../../../hooks/use-color-scheme";
import { useToast } from "../../../src/components/toast/ToastProvider";
import { Colors } from "@/constants/theme";

const { width } = Dimensions.get("window");

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

  const handleSocialLogin = (provider: string) => {
    // In a real app, integrate with Firebase Social Auth here
    console.log(`Continue with ${provider}`);
    addToast(`Logged in with ${provider}`, "success");
    // Handle redirect for social login too if implemented
    if (redirect) {
        router.replace(decodeURIComponent(redirect) as any);
    } else {
        router.replace("/home");
    }
  };

  const handlePasswordLogin = () => {
    // Pass the redirect param to the password screen
    if (redirect) {
        router.push(`/auth/login/password?redirect=${encodeURIComponent(redirect)}`);
    } else {
        router.push("/auth/login/password");
    }
  };

  const handleSignUp = () => {
    router.push("/auth/signup");
  };

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
           <Image 
             source={Images.onBoardingLight1} 
             style={styles.illustration}
             resizeMode="contain"
           />
        </View>

        <Text style={[styles.title, { color: textColor }]}>Let's you in</Text>

        <View style={styles.socialButtonsContainer}>
          <TouchableOpacity
            style={[styles.socialButton, { backgroundColor: isDark ? '#1F222A' : '#fff', borderColor: isDark ? '#35383F' : '#eee' }]}
            onPress={() => handleSocialLogin("Facebook")}
          >
            <Facebook_Icon width={24} height={24} />
            <Text style={[styles.socialButtonText, { color: textColor }]}>Continue with Facebook</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.socialButton, { backgroundColor: isDark ? '#1F222A' : '#fff', borderColor: isDark ? '#35383F' : '#eee' }]}
            onPress={() => handleSocialLogin("Google")}
          >
            <Google_Icon width={24} height={24} />
            <Text style={[styles.socialButtonText, { color: textColor }]}>Continue with Google</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.socialButton, { backgroundColor: isDark ? '#1F222A' : '#fff', borderColor: isDark ? '#35383F' : '#eee' }]}
            onPress={() => handleSocialLogin("Apple")}
          >
            {isDark ? (
              <Apple_Light width={24} height={24} />
            ) : (
              <Apple_Dark width={24} height={24} />
            )}
            <Text style={[styles.socialButtonText, { color: textColor }]}>Continue with Apple</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.dividerContainer}>
          <View style={[styles.dividerLine, { backgroundColor: isDark ? '#35383F' : '#eee' }]} />
          <Text style={[styles.dividerText, { color: textColor }]}>or</Text>
          <View style={[styles.dividerLine, { backgroundColor: isDark ? '#35383F' : '#eee' }]} />
        </View>

        <TouchableOpacity
          style={styles.passwordButton}
          onPress={handlePasswordLogin}
        >
          <Text style={styles.passwordButtonText}>Sign in with password</Text>
        </TouchableOpacity>

        <View style={styles.footerContainer}>
          <Text style={[styles.footerText, { color: isDark ? '#E0E0E0' : 'gray' }]}>
            Don't have an account?{" "}
          </Text>
          <TouchableOpacity onPress={handleSignUp}>
            <Text style={styles.signupText}>Sign up</Text>
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
  illustration: {
    width: width * 0.6,
    height: width * 0.4,
  },
  title: {
    fontSize: 32,
    fontWeight: "bold",
    marginBottom: 30,
    textAlign: "center",
  },
  socialButtonsContainer: {
    width: "100%",
    gap: 16,
  },
  socialButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderRadius: 16,
    paddingVertical: 16,
    paddingHorizontal: 20,
    elevation: 1,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
  },
  socialButtonText: {
    marginLeft: 12,
    fontSize: 16,
    fontWeight: "600",
  },
  dividerContainer: {
    flexDirection: "row",
    alignItems: "center",
    width: "100%",
    marginVertical: 24,
  },
  dividerLine: {
    flex: 1,
    height: 1,
  },
  dividerText: {
    marginHorizontal: 16,
    fontSize: 16,
    fontWeight: "500",
  },
  passwordButton: {
    width: "100%",
    backgroundColor: "#FF4D67", // Pink color from screenshot
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
    fontWeight: "bold",
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
    fontWeight: "bold",
    color: "#FF4D67",
  },
});
