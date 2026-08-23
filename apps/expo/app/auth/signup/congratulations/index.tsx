import React, { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  ActivityIndicator,
  Alert,
  Platform,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Success } from "@/assets/svgs";
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSignupStore } from "@/src/store/signup";
import { auth } from "@/src/services/firebase/initFirebase";
import { callApi } from "@/src/services/api"; // Consolidated API used
import { uploadToR2 } from "@/src/lib/uploadToR2";
import { optimizeImageForUpload } from '@/src/lib/imageOptimize';
import { signInWithEmailAndPassword, sendEmailVerification } from "firebase/auth";

const { width } = Dimensions.get('window');

export default function CongratulationsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { data: signupData, reset: resetStore } = useSignupStore();
  const [isLoading, setIsLoading] = useState(true);
  const [statusMessage, setStatusMessage] = useState("Finalizing your account...");
  // Guard against double execution (React StrictMode remount / effect re-run):
  // creating the account twice would fail the 2nd time with EMAIL_EXISTS.
  const hasFinalized = useRef(false);

  // Upload the profile picture if it's still a local URI (avatars are uploaded
  // here, not on the fill-profile step, because the auth token doesn't exist
  // yet for email signups). Returns a remote URL or null. Best-effort.
  const resolveAvatarUrl = async (): Promise<string | null> => {
    const a = signupData.avatarUrl;
    if (!a) return null;
    if (/^https?:\/\//.test(a)) return a; // already a remote URL
    try {
      // Downscale before upload — a raw camera photo is several MB.
      const optimized = await optimizeImageForUpload(a, "avatar");
      return (await uploadToR2(optimized, "image/jpeg", "avatars")) as string;
    } catch (e) {
      console.warn("avatar upload failed", e);
      return null;
    }
  };

  useEffect(() => {
    const finalizeSignup = async () => {
      if (hasFinalized.current) return;
      hasFinalized.current = true;
      try {
        console.log("Finalizing signup for provider:", signupData.authProvider);

        if (signupData.authProvider === 'email') {
            if (!signupData.email || !signupData.password || !signupData.username) {
                throw new Error("Missing user data. Please restart the signup process.");
            }
            
            setStatusMessage("Creating your account securely...");
            // Create the account WITHOUT the avatar first — it's still a local
            // URI and can only be uploaded once we're authenticated (below).
            const result: any = await callApi('create', { 
                ...signupData,
                avatarUrl: null,
                platform: Platform.OS,
            });

            if (result.status !== 'success') {
                throw new Error(result.message || "An unknown error occurred on the server.");
            }

            setStatusMessage("Signing you in...");
            const cred = await signInWithEmailAndPassword(auth, signupData.email, signupData.password);

            // Now authenticated → upload the avatar and attach it to the profile.
            setStatusMessage("Uploading your photo...");
            const avatarUrl = await resolveAvatarUrl();
            if (avatarUrl) {
              try {
                await callApi('updateProfile', { avatarUrl });
              } catch (e) {
                console.warn('avatar profile update failed', e);
              }
            }
            // Send a verification email so the user can confirm ownership of the
            // address. Best-effort — never block signup if the email send fails.
            try {
              if (cred.user && !cred.user.emailVerified) {
                await sendEmailVerification(cred.user);
              }
            } catch (verifyErr) {
              console.warn("sendEmailVerification failed", verifyErr);
            }

            // Apply the follow selections made on the "Follow Someone" step. For
            // email signups the account only exists now, so these couldn't be
            // persisted live (unlike social/phone signups, which are already
            // authenticated by then). Best-effort — never block signup.
            const toFollow = signupData.following || [];
            for (const targetUserId of toFollow) {
              try {
                await callApi("toggleFollow", { targetUserId });
              } catch (followErr) {
                console.warn("follow apply failed for", targetUserId, followErr);
              }
            }
        } else {
            if (!signupData.username) {
                throw new Error("Username is required to complete your profile.");
            }

            // Social/phone signups are already authenticated here, so the avatar
            // can be uploaded now and included in the profile.
            setStatusMessage("Uploading your photo...");
            const avatarUrl = await resolveAvatarUrl();

            setStatusMessage("Saving your profile details...");
            // Using Consolidated API for Profile Creation
            const result: any = await callApi('createProfile', { 
                ...signupData,
                avatarUrl: avatarUrl ?? null,
                platform: Platform.OS,
                uid: auth.currentUser?.uid
            });

            if (result.status !== 'success') {
                throw new Error(result.message || "Failed to save profile.");
            }
        }

        // Generate the user's referral code + apply an inbound referral bonus
        // (if a code was entered during signup). Best-effort — never block signup.
        try {
          await callApi('completeSignup', { referralCode: signupData.referralCode || undefined });
        } catch (e) {
          console.warn('completeSignup/referral step failed', e);
        }

        console.log("Signup finalized successfully.");
        await AsyncStorage.setItem('hasSeenOnboarding', 'true');
        resetStore();

      } catch (error: any) {
        console.error("Failed to finalize signup", error);
        // Allow the "Retry" action below to re-run the finalize flow.
        hasFinalized.current = false;
        Alert.alert(
            "Signup Failed", 
            error.message || "Could not complete the process. Please try again.",
            [
                { text: "Go to Login", onPress: () => router.replace("/auth/login") },
                { text: "Retry", onPress: () => finalizeSignup() }
            ]
        );
      } finally {
        setIsLoading(false);
      }
    };

    finalizeSignup();
  }, []);

  const handleGoHome = () => {
    router.replace("/home");
  };

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#FF4D67" />
        <Text style={styles.loadingText}>{statusMessage}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={[styles.modalContainer, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
          <View style={styles.card}>
              <View style={styles.iconContainer}>
                 <Success width={180} height={180} />
              </View>
              <Text style={styles.title}>Congratulations!</Text>
              <Text style={styles.subtitle}>Your account is ready to use</Text>
              <TouchableOpacity style={styles.button} onPress={handleGoHome}>
                  <Text style={styles.buttonText}>Go to Homepage</Text>
              </TouchableOpacity>
          </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' },
  loadingText: { marginTop: 10, color: '#fff', fontSize: 16 },
  modalContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', width: '100%' },
  card: { width: width * 0.85, backgroundColor: '#fff', borderRadius: 40, padding: 40, alignItems: 'center' },
  iconContainer: { marginBottom: 30 },
  title: { fontSize: 24, fontWeight: 'bold', color: '#FF4D67', marginBottom: 16, textAlign: 'center' },
  subtitle: { fontSize: 16, color: '#212121', marginBottom: 30, textAlign: 'center' },
  button: { width: '100%', backgroundColor: '#FF4D67', paddingVertical: 18, borderRadius: 30, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: 'bold' },
});
