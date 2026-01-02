import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from "react-native";
import { useRouter, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { signInWithEmailAndPassword } from "firebase/auth";
import { auth } from "../../../../src/services/firebase/initFirebase";
import {
  Email_Icon,
  Facebook_Icon,
  Google_Icon,
  Apple_Light,
  Apple_Dark,
  Left_Arrow,
  New_Email_Icon,
  Lock_Icon,
  Eye_Open,
  Eye_Close,
  Checkmark_Icon,
} from "../../../../assets/svgs";
import { Ionicons } from "@expo/vector-icons";
import { useThemeColor } from "../../../../hooks/use-theme-color";
import { useColorScheme } from "../../../../hooks/use-color-scheme";
import { FormInput } from "@/src/components/inputs/FormInput";
import { PrimaryButton } from "@/src/components/buttons/PrimaryButton";
import { useToast } from "@/src/components/toast/ToastProvider";

// Validation Schema
const loginSchema = z.object({
  email: z.string().email({ message: "Invalid email address" }),
  password: z.string().min(6, { message: "Password must be at least 6 characters" }),
});

type LoginFormData = z.infer<typeof loginSchema>;

export default function PasswordLoginScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const redirect = params.redirect as string | undefined;

  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const backgroundColor = useThemeColor({}, "background");
  const textColor = useThemeColor({}, "text");
  const iconColor = useThemeColor({}, "icon");
  const { addToast } = useToast();

  const [isLoading, setIsLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);

  const {
    control,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
    defaultValues: {
      email: "",
      password: "",
    },
  });

  useEffect(() => {
    // Load saved email if "Remember Me" was checked previously
    const loadRememberedUser = async () => {
      try {
        const savedEmail = await AsyncStorage.getItem("remembered_email");
        if (savedEmail) {
          setValue("email", savedEmail);
          setRememberMe(true);
        }
      } catch (error) {
        console.log("Error loading remembered user:", error);
      }
    };
    loadRememberedUser();
  }, [setValue]);

  const onSignIn = async (data: LoginFormData) => {
    setIsLoading(true);
    try {
      // Firebase Sign In
      await signInWithEmailAndPassword(auth, data.email, data.password);

      // Handle "Remember Me"
      if (rememberMe) {
        await AsyncStorage.setItem("remembered_email", data.email);
      } else {
        await AsyncStorage.removeItem("remembered_email");
      }
      
      addToast("Login successful!", "success");
      
      // Handle Redirect
      if (redirect) {
        router.replace(decodeURIComponent(redirect) as any);
      } else {
        router.replace("/home");
      }
    } catch (error: any) {
      console.error("Login error:", error);
      let errorMessage = "Something went wrong. Please try again.";
      if (error.code === 'auth/invalid-credential') {
        errorMessage = "Invalid email or password.";
      } else if (error.code === 'auth/user-not-found') {
        errorMessage = "No account found with this email.";
      } else if (error.code === 'auth/wrong-password') {
        errorMessage = "Incorrect password.";
      }
      
      // Show both Alert and Toast
      Alert.alert("Login Failed", errorMessage);
      addToast(errorMessage, "error");
    } finally {
      setIsLoading(false);
    }
  };

  const handleSocialLogin = (provider: string) => {
    // In a real app, integrate with Firebase Social Auth here
    console.log(`Continue with ${provider}`);
    addToast(`Logged in with ${provider}`, "success");
    // Handle Redirect
    if (redirect) {
      router.replace(decodeURIComponent(redirect) as any);
    } else {
      router.replace("/home");
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <ScrollView
        contentContainerStyle={{ flexGrow: 1 }}
        keyboardShouldPersistTaps="handled"
      >
        <View
          style={[
            styles.container,
            { backgroundColor, paddingTop: insets.top, paddingBottom: insets.bottom },
          ]}
        >
          {/* Header */}
          <View style={styles.header}>
            <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
              <Left_Arrow width={24} height={24} color={textColor} />
            </TouchableOpacity>
          </View>

          <View style={styles.contentContainer}>
            <Text style={[styles.title, { color: textColor }]}>
              Login to Your Account
            </Text>

            {/* Email Input */}
            <FormInput
              control={control}
              name="email"
              placeholder="Email"
              icon={<New_Email_Icon width={20} height={20} />}
              autoCapitalize="none"
              keyboardType="email-address"
              errorMessage={errors.email?.message}
            />

            {/* Password Input */}
            <FormInput
              control={control}
              name="password"
              placeholder="Password"
              secureTextEntry={!showPassword}
              icon={<Lock_Icon width={20} height={20} />}
              rightIcon={
                <TouchableOpacity onPress={() => setShowPassword(!showPassword)}>
                  {showPassword ? <Eye_Open width={20} height={20} /> : <Eye_Close width={20} height={20} />}
                </TouchableOpacity>
              }
              errorMessage={errors.password?.message}
            />

            {/* Remember Me */}
            <View style={styles.rememberMeContainer}>
              <TouchableOpacity
                style={styles.checkboxContainer}
                onPress={() => setRememberMe(!rememberMe)}
              >
                <View style={[styles.checkbox, rememberMe && styles.checkboxChecked]}>
                  {rememberMe && (
                    <Checkmark_Icon width={14} height={14} color="#fff" />
                  )}
                </View>
                <Text style={[styles.rememberMeText, { color: textColor }]}>
                  Remember Me
                </Text>
              </TouchableOpacity>
            </View>

            {/* Sign In Button */}
            <PrimaryButton
              title="Sign in"
              onPress={handleSubmit(onSignIn)}
              isLoading={isLoading}
            />

            {/* Forgot Password */}
            <TouchableOpacity
              onPress={() => router.push("/auth/forgot-password")}
              style={styles.forgotPasswordButton}
            >
              <Text style={styles.forgotPasswordText}>Forgot the password?</Text>
            </TouchableOpacity>

            {/* Divider */}
            <View style={styles.dividerContainer}>
              <View style={styles.dividerLine} />
              <Text style={[styles.dividerText, { color: textColor }]}>
                or continue with
              </Text>
              <View style={styles.dividerLine} />
            </View>

            {/* Social Buttons */}
            <View style={styles.socialButtonsContainer}>
              <TouchableOpacity
                style={styles.socialIcon}
                onPress={() => handleSocialLogin("Facebook")}
              >
                <Facebook_Icon width={24} height={24} />
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.socialIcon}
                onPress={() => handleSocialLogin("Google")}
              >
                <Google_Icon width={24} height={24} />
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.socialIcon}
                onPress={() => handleSocialLogin("Apple")}
              >
                {colorScheme === "dark" ? (
                  <Apple_Light width={24} height={24} />
                ) : (
                  <Apple_Dark width={24} height={24} />
                )}
              </TouchableOpacity>
            </View>

            {/* Footer */}
            <View style={styles.footerContainer}>
              <Text style={[styles.footerText, { color: 'gray' }]}>
                Don't have an account?{" "}
              </Text>
              <TouchableOpacity onPress={() => router.push("/auth/signup")}>
                <Text style={styles.signupText}>Sign up</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 24,
    paddingVertical: 10,
  },
  backButton: {
    width: 40,
    height: 40,
    justifyContent: "center",
    alignItems: "flex-start",
  },
  contentContainer: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 20,
  },
  title: {
    fontSize: 32,
    fontWeight: "bold",
    marginBottom: 40,
  },
  rememberMeContainer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center", 
    marginBottom: 24,
    marginTop: 8
  },
  checkboxContainer: {
    flexDirection: "row",
    alignItems: "center",
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 8,
    borderWidth: 2,
    borderColor: "#FF4D67",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 12,
    backgroundColor: 'transparent',
  },
  checkboxChecked: {
    backgroundColor: "#FF4D67",
  },
  rememberMeText: {
    fontSize: 16,
    fontWeight: "600",
  },
  forgotPasswordButton: {
    alignItems: "center",
    marginBottom: 40,
    marginTop: 20
  },
  forgotPasswordText: {
    color: "#FF4D67",
    fontSize: 16,
    fontWeight: "600",
  },
  dividerContainer: {
    flexDirection: "row",
    alignItems: "center",
    width: "100%",
    marginBottom: 30,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: "#eee",
  },
  dividerText: {
    marginHorizontal: 16,
    fontSize: 16,
    fontWeight: "500",
  },
  socialButtonsContainer: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 20,
    marginBottom: 30,
  },
  socialIcon: {
    width: 60,
    height: 60,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#eee",
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: "#fff",
  },
  footerContainer: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    marginBottom: 20,
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
