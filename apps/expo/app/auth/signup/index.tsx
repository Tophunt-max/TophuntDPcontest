import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Dimensions,
  Alert,
  ActivityIndicator,
  Linking,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
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
} from "@/assets/svgs";
import { useThemeColor } from "@/hooks/use-theme-color";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { FormInput } from "@/src/components/inputs/FormInput";
import { PrimaryButton } from "@/src/components/buttons/PrimaryButton";
import { useSignupStore } from "@/src/store/signup";
import { auth, firestore as db } from "../../../src/services/firebase/initFirebase";
import { callApi } from "@/src/services/api"; 
import { useToast } from "@/src/components/toast/ToastProvider";
import PasswordStrength from "@/src/components/inputs/PasswordStrength";
import { Colors } from '@/constants/theme';
import { doc, onSnapshot } from "firebase/firestore";

const signupSchema = z.object({
  email: z.string().min(1, "Please fill in your email").email("Invalid email"),
  password: z.string().min(8, "Password must be at least 8 characters")
  .regex(/[a-z]/, "Password must contain at least one lowercase letter")
  .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
  .regex(/\d/, "Password must contain at least one number")
  .regex(/[^a-zA-Z0-9]/, "Password must contain at least one special character"),
  passwordConfirmation: z.string().min(6, "Password must be at least 6 characters"),
  termsAccepted: z.boolean().refine(val => val === true, {
    message: "You must accept the Terms of Service and Privacy Policy.",
  }),
}).refine((data) => data.password === data.passwordConfirmation, {
    message: "Passwords don't match",
    path: ["passwordConfirmation"],
});

type SignupFormData = z.infer<typeof signupSchema>;

export default function SignupEntryScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const textColor = isDark ? Colors.dark.text : Colors.light.text;
  const { addToast } = useToast();
  
  const setMultiple = useSignupStore((state) => state.setMultiple);

  const [isLoading, setIsLoading] = useState(false);
  const [emailChecking, setEmailChecking] = useState(false);
  const [isEmailAlreadyExists, setIsEmailAlreadyExists] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showPasswordConfirmation, setShowPasswordConfirmation] = useState(false);
  const [isConfigLoading, setIsConfigLoading] = useState(true);
  const [config, setConfig] = useState({
    googleLogin: true,
    facebookLogin: true,
    appleLogin: true,
    emailSignup: true,
    legalSettings: {
        termsOfService: "/legal/terms",
        privacyPolicy: "/legal/privacy"
    }
  });

  useEffect(() => {
    const docRef = doc(db, "settings", "appConfig");
    const unsubscribe = onSnapshot(docRef, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();
        if (data.authSettings) {
          setConfig(prev => ({
            ...prev,
            googleLogin: data.authSettings.googleLogin ?? true,
            facebookLogin: data.authSettings.facebookLogin ?? true,
            appleLogin: data.authSettings.appleLogin ?? true,
            emailSignup: data.authSettings.emailSignup ?? true,
          }));
          
          if (data.authSettings.emailSignup === false) {
              addToast("Email signup is currently disabled.", "info");
              router.replace("/auth/login");
          }
        }
      }
      setIsConfigLoading(false);
    }, (error) => {
      console.error("Firestore Listen Error:", error);
      setIsConfigLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const {
    control,
    handleSubmit,
    watch,
    setError,
    setValue,
    clearErrors,
    formState: { errors },
  } = useForm<SignupFormData>({
    resolver: zodResolver(signupSchema),
    defaultValues: {
      email: "",
      password: "",
      passwordConfirmation: "",
      termsAccepted: false,
    },
  });

  const email = watch("email");
  const password = watch("password");
  const termsAccepted = watch("termsAccepted");

  // Real-time Email Uniqueness Check
  useEffect(() => {
    const checkEmail = async () => {
        if (email.length > 5 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            setEmailChecking(true);
            try {
                const result: any = await callApi('check', { type: 'email', value: email });
                if (result.exists) {
                    setError("email", { type: "manual", message: "This email is already registered" });
                    setIsEmailAlreadyExists(true);
                } else {
                    clearErrors("email");
                    setIsEmailAlreadyExists(false);
                }
            } catch (error) {
                console.error("Email check failed", error);
                setIsEmailAlreadyExists(false);
            } finally {
                setEmailChecking(false);
            }
        } else {
            setIsEmailAlreadyExists(false);
            clearErrors("email");
        }
    };

    const timer = setTimeout(checkEmail, 800);
    return () => clearTimeout(timer);
  }, [email]);

  const onSignUp = async (data: SignupFormData) => {
    if (emailChecking) return;
    
    if (isEmailAlreadyExists) {
        addToast("This email is already in use.", "error");
        setError("email", { type: "manual", message: "Email already registered" });
        return;
    }

    if (!data.termsAccepted) {
      addToast("You must accept the Terms and Privacy Policy", "info");
      return;
    }

    setIsLoading(true);
    try {
      setMultiple({ 
          email: data.email, 
          password: data.password,
          authProvider: 'email'
      });
      addToast("Email verified!", "success");
      router.push("/auth/signup/fill-profile");
    } catch (error) {
      console.error("Signup error", error);
      addToast("An error occurred. Please try again.", "error");
    } finally {
      setIsLoading(false);
    }
  };
  
  const handleOpenLegal = (route: string) => {
    if (route.startsWith('http')) {
        Linking.openURL(route).catch(err => {
            console.error("Failed to open URL:", err);
            addToast("Could not open the link.", "error");
        });
    } else {
        router.push(route as any);
    }
  };

  const handleBack = () => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace("/auth/login");
    }
  };

  if (isConfigLoading) {
    return (
      <View style={[styles.container, { backgroundColor, justifyContent: 'center' }]}>
        <ActivityIndicator size="large" color="#FF4D67" />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView 
        contentContainerStyle={{ flexGrow: 1 }} 
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View
          style={[
            styles.container,
            { backgroundColor, paddingTop: insets.top, paddingBottom: insets.bottom },
          ]}
        >
          <View style={styles.header}>
            <TouchableOpacity onPress={handleBack} style={styles.backButton}>
              <Left_Arrow width={24} height={24} color={textColor} />
            </TouchableOpacity>
          </View>

          <View style={styles.contentContainer}>
            <Text style={[styles.title, { color: textColor }]}>
              Create your Account
            </Text>

            <FormInput
              control={control}
              name="email"
              placeholder="Email"
              icon={<New_Email_Icon width={20} height={20} />}
              autoCapitalize="none"
              keyboardType="email-address"
              errorMessage={errors.email?.message}
              rightIcon={emailChecking ? <ActivityIndicator size="small" color="#FF4D67" /> : null}
            />

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
             <PasswordStrength password={password} />
            
            <FormInput
              control={control}
              name="passwordConfirmation"
              placeholder="Confirm Password"
              secureTextEntry={!showPasswordConfirmation}
              icon={<Lock_Icon width={20} height={20} />}
              rightIcon={
                <TouchableOpacity onPress={() => setShowPasswordConfirmation(!showPasswordConfirmation)}>
                  {showPasswordConfirmation ? <Eye_Open width={20} height={20} /> : <Eye_Close width={20} height={20} />}
                </TouchableOpacity>
              }
              errorMessage={errors.passwordConfirmation?.message}
            />

            <View style={styles.termsContainer}>
              <View style={styles.checkboxWrapper}>
                <TouchableOpacity
                  style={styles.checkboxContainer}
                  onPress={() => {
                    const newValue = !termsAccepted;
                    setValue('termsAccepted', newValue, { shouldValidate: true });
                  }}
                >
                  <View style={[styles.checkbox, termsAccepted && styles.checkboxChecked]}>
                    {termsAccepted && <Checkmark_Icon width={12} height={12} color="#fff" />}
                  </View>
                </TouchableOpacity>
                
                <Text style={[styles.termsText, { color: textColor }]}>
                  I agree to the{" "}
                  <Text style={styles.linkText} onPress={() => handleOpenLegal('/legal/terms')}>
                    Terms of Service
                  </Text>{" "}
                  and{" "}
                  <Text style={styles.linkText} onPress={() => handleOpenLegal('/legal/privacy')}>
                    Privacy Policy
                  </Text>.
                </Text>
              </View>
              {errors.termsAccepted && (
                <Text style={styles.errorText}>{errors.termsAccepted.message}</Text>
              )}
            </View>

            <PrimaryButton
              title="Sign up"
              onPress={handleSubmit(onSignUp)}
              isLoading={isLoading || emailChecking}
              disabled={!termsAccepted || isEmailAlreadyExists}
              style={{ marginBottom: 20 }}
            />

            <View style={styles.dividerContainer}>
              <View style={[styles.dividerLine, { backgroundColor: isDark ? '#35383F' : '#eee' }]} />
              <Text style={[styles.dividerText, { color: isDark ? '#BDBDBD' : "#616161" }]}>or continue with</Text>
              <View style={[styles.dividerLine, { backgroundColor: isDark ? '#35383F' : '#eee' }]} />
            </View>

            <View style={styles.socialButtonsContainer}>
              {config.facebookLogin && (
                <TouchableOpacity style={[styles.socialIcon, { backgroundColor: isDark ? '#1F222A' : '#fff', borderColor: isDark ? '#35383F' : '#eee' }]} onPress={() => addToast("Facebook login coming soon!", "info")}>
                    <Facebook_Icon width={24} height={24} />
                </TouchableOpacity>
              )}
              {config.googleLogin && (
                <TouchableOpacity style={[styles.socialIcon, { backgroundColor: isDark ? '#1F222A' : '#fff', borderColor: isDark ? '#35383F' : '#eee' }]} onPress={() => addToast("Google login coming soon!", "info")}>
                    <Google_Icon width={24} height={24} />
                </TouchableOpacity>
              )}
              {config.appleLogin && (
                <TouchableOpacity style={[styles.socialIcon, { backgroundColor: isDark ? '#1F222A' : '#fff', borderColor: isDark ? '#35383F' : '#eee' }]} onPress={() => addToast("Apple login coming soon!", "info")}>
                    {isDark ? <Apple_Light width={24} height={24} /> : <Apple_Dark width={24} height={24} />}
                </TouchableOpacity>
              )}
            </View>

            <View style={styles.footerContainer}>
              <Text style={[styles.footerText, { color: isDark ? '#E0E0E0' : 'gray' }]}>
                Already have an account?{" "}
              </Text>
              <TouchableOpacity onPress={() => router.push("/auth/login")}>
                <Text style={styles.loginText}>Sign in</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { paddingHorizontal: 24, paddingVertical: 10, alignItems: 'flex-start' },
  backButton: { padding: 8, marginLeft: -8 },
  contentContainer: { flex: 1, paddingHorizontal: 24, paddingTop: 0, justifyContent: 'center' },
  title: { fontSize: 40, fontFamily: 'Urbanist-Bold', marginBottom: 30, lineHeight: 48, textAlign: 'center' },
  termsContainer: { alignItems: 'center', marginBottom: 20, marginTop: 8 },
  checkboxWrapper: { flexDirection: 'row', alignItems: 'flex-start', maxWidth: '90%' },
  checkboxContainer: { paddingRight: 10, paddingTop: 2 },
  checkbox: { width: 20, height: 20, borderRadius: 6, borderWidth: 2, borderColor: '#FF4D67', justifyContent: 'center', alignItems: 'center' },
  checkboxChecked: { backgroundColor: '#FF4D67' },
  termsText: { flexShrink: 1, fontSize: 14, fontFamily: 'Urbanist-Regular', lineHeight: 20 },
  linkText: { color: '#FF4D67', fontFamily: 'Urbanist-Bold', textDecorationLine: 'underline' },
  errorText: { color: 'red', marginTop: 5, fontSize: 12, fontFamily: 'Urbanist-Regular' },
  dividerContainer: { flexDirection: "row", alignItems: "center", width: "100%", marginBottom: 20 },
  dividerLine: { flex: 1, height: 1 },
  dividerText: { marginHorizontal: 12, fontSize: 14, fontFamily: 'Urbanist-SemiBold' },
  socialButtonsContainer: { flexDirection: "row", justifyContent: "center", gap: 16, marginBottom: 20 },
  socialIcon: { width: 50, height: 50, borderRadius: 12, borderWidth: 1, justifyContent: "center", alignItems: "center" },
  footerContainer: { flexDirection: "row", justifyContent: "center", alignItems: "center", marginBottom: 10, paddingBottom: 20 },
  footerText: { fontSize: 14, fontFamily: 'Urbanist-Regular' },
  loginText: { fontSize: 14, fontFamily: 'Urbanist-Bold', color: "#FF4D67" },
});
