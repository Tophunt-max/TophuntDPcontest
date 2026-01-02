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
import { httpsCallable } from "firebase/functions";
import { functions, auth } from "../../../src/services/firebase/initFirebase";
import { useToast } from "@/src/components/toast/ToastProvider";
import PasswordStrength from "@/src/components/inputs/PasswordStrength";
import { FacebookAuthProvider, signInWithCredential } from 'firebase/auth';
import * as Facebook from 'expo-facebook';

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
  const backgroundColor = useThemeColor({}, "background");
  const textColor = useThemeColor({}, "text");
  const { addToast } = useToast();
  
  const setMultiple = useSignupStore((state) => state.setMultiple);

  const [isLoading, setIsLoading] = useState(false);
  const [emailChecking, setEmailChecking] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showPasswordConfirmation, setShowPasswordConfirmation] = useState(false);

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
                // CHANGED: Call 'authHandler' with action 'check' and type 'email'
                const authHandler = httpsCallable(functions, 'authHandler');
                const result = await authHandler({ action: 'check', type: 'email', value: email });
                if ((result.data as any).exists) {
                    setError("email", { type: "manual", message: "This email is already registered" });
                } else {
                    clearErrors("email");
                }
            } catch (error) {
                console.error("Email check failed", error);
            } finally {
                setEmailChecking(false);
            }
        }
    };

    const timer = setTimeout(checkEmail, 500);
    return () => clearTimeout(timer);
  }, [email]);

  const onSignUp = async (data: SignupFormData) => {
    if (emailChecking) return;

    setIsLoading(true);
    try {
      setMultiple({ email: data.email, password: data.password });
      addToast("Email verified!", "success");
      router.push("/auth/signup/fill-profile");
    } catch (error) {
      console.error("Signup error", error);
      addToast("An error occurred during signup.", "error");
    } finally {
      setIsLoading(false);
    }
  };
  
  const handleSocialLogin = async (providerName: string) => {
    setIsLoading(true);
    addToast(`${providerName} login is not implemented yet.`, "info");
    setIsLoading(false);
  };

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
            <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
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
              <TouchableOpacity
                style={styles.checkboxContainer}
                onPress={() => setValue('termsAccepted', !termsAccepted, { shouldValidate: true })}
              >
                <View style={[styles.checkbox, termsAccepted && styles.checkboxChecked]}>
                  {termsAccepted && <Checkmark_Icon width={12} height={12} color="#fff" />}
                </View>
                <Text style={[styles.termsText, { color: textColor }]}>
                  I agree to the{" "}
                  <Text style={styles.linkText} onPress={() => Linking.openURL('https://example.com/terms')}>
                    Terms of Service
                  </Text>{" "}
                  and{" "}
                  <Text style={styles.linkText} onPress={() => Linking.openURL('https://example.com/privacy')}>
                    Privacy Policy
                  </Text>.
                </Text>
              </TouchableOpacity>
              {errors.termsAccepted && (
                <Text style={styles.errorText}>{errors.termsAccepted.message}</Text>
              )}
            </View>

            <PrimaryButton
              title="Sign up"
              onPress={handleSubmit(onSignUp)}
              isLoading={isLoading || emailChecking}
              disabled={!termsAccepted}
              style={{ marginBottom: 20 }}
            />

            <View style={styles.dividerContainer}>
              <View style={styles.dividerLine} />
              <Text style={[styles.dividerText, { color: textColor }]}>or continue with</Text>
              <View style={styles.dividerLine} />
            </View>

            <View style={styles.socialButtonsContainer}>
              <TouchableOpacity style={styles.socialIcon} onPress={() => handleSocialLogin("Facebook")}>
                <Facebook_Icon width={24} height={24} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.socialIcon} onPress={() => handleSocialLogin("Google")}>
                <Google_Icon width={24} height={24} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.socialIcon} onPress={() => handleSocialLogin("Apple")}>
                {colorScheme === "dark" ? <Apple_Light width={24} height={24} /> : <Apple_Dark width={24} height={24} />}
              </TouchableOpacity>
            </View>

            <View style={styles.footerContainer}>
              <Text style={[styles.footerText, { color: 'gray' }]}>
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
  checkboxContainer: { flexDirection: 'row', alignItems: 'flex-start', maxWidth: '90%' },
  checkbox: { width: 20, height: 20, borderRadius: 6, borderWidth: 2, borderColor: '#FF4D67', justifyContent: 'center', alignItems: 'center', marginRight: 10, marginTop: 2 },
  checkboxChecked: { backgroundColor: '#FF4D67' },
  termsText: { flexShrink: 1, fontSize: 14, fontFamily: 'Urbanist-Regular', lineHeight: 20 },
  linkText: { color: '#FF4D67', fontFamily: 'Urbanist-Bold', textDecorationLine: 'underline' },
  errorText: { color: 'red', marginTop: 5, fontSize: 12, fontFamily: 'Urbanist-Regular' },
  dividerContainer: { flexDirection: "row", alignItems: "center", width: "100%", marginBottom: 20 },
  dividerLine: { flex: 1, height: 1, backgroundColor: "#eee" },
  dividerText: { marginHorizontal: 12, fontSize: 14, fontFamily: 'Urbanist-SemiBold', color: "#616161" },
  socialButtonsContainer: { flexDirection: "row", justifyContent: "center", gap: 16, marginBottom: 20 },
  socialIcon: { width: 50, height: 50, borderRadius: 12, borderWidth: 1, borderColor: "#eee", justifyContent: "center", alignItems: "center", backgroundColor: "#fff" },
  footerContainer: { flexDirection: "row", justifyContent: "center", alignItems: "center", marginBottom: 10, paddingBottom: 20 },
  footerText: { fontSize: 14, fontFamily: 'Urbanist-Regular' },
  loginText: { fontSize: 14, fontFamily: 'Urbanist-Bold', color: "#FF4D67" },
});