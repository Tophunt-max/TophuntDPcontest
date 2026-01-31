import React, { useEffect, useState } from "react";
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
import { auth, firestore as db } from "@/src/services/firebase/initFirebase";
import { callApi } from "@/src/services/api"; 
import { signInWithEmailAndPassword } from "firebase/auth";
import { uploadAvatar } from "@/src/services/r2/uploadAvatar";
import { doc, getDoc } from "firebase/firestore";

const { width } = Dimensions.get('window');

export default function CongratulationsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { data: signupData, reset: resetStore } = useSignupStore();
  const [isLoading, setIsLoading] = useState(true);
  const [isFinishing, setIsFinishing] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Finalizing your account...");

  useEffect(() => {
    let isMounted = true;

    const finalizeSignup = async () => {
      try {
        console.log("Finalizing signup for provider:", signupData.authProvider);
        let finalUid = signupData.uid || auth.currentUser?.uid;

        // 1. CREATE USER ACCOUNT / SAVE PROFILE
        if (signupData.authProvider === 'email' && !auth.currentUser) {
            if (!signupData.email || !signupData.password || !signupData.username) {
                throw new Error("Missing user data. Please restart the signup process.");
            }
            
            setStatusMessage("Creating your account securely...");
            const result: any = await callApi('create', { 
                ...signupData,
                avatarUrl: null,
                platform: Platform.OS,
            });

            if (result.status !== 'success') {
                throw new Error(result.message || "An unknown error occurred on the server.");
            }
            finalUid = result.uid;

            setStatusMessage("Signing you in...");
            await signInWithEmailAndPassword(auth, signupData.email, signupData.password);
        } else {
            setStatusMessage("Saving your profile details...");
            
            if (!finalUid) throw new Error("Authentication failed. Please login again.");

            // Backend mark as signupCompleted: true during this call
            const result: any = await callApi('createProfile', { 
                ...signupData,
                avatarUrl: signupData.avatarUrl?.startsWith('http') ? signupData.avatarUrl : null,
                platform: Platform.OS,
                uid: finalUid
            });

            if (result.status !== 'success') {
                throw new Error(result.message || "Failed to save profile.");
            }
        }

        // 2. UPLOAD AVATAR
        if (signupData.avatarUrl && signupData.avatarUrl.startsWith('file://')) {
            try {
                setStatusMessage("Optimizing and uploading profile picture...");
                const derivatives = await uploadAvatar(signupData.avatarUrl);
                
                setStatusMessage("Finalizing profile...");
                await callApi('createProfile', {
                    uid: finalUid,
                    avatarUrl: derivatives.medium,
                    photoDerivatives: derivatives
                });
            } catch (uploadError) {
                console.warn("Avatar upload failed:", uploadError);
            }
        }

        setStatusMessage("Completing setup...");
        await AsyncStorage.setItem('hasSeenOnboarding', 'true');
        
        console.log("Signup finalized successfully.");
        
        // GIVE FIRESTORE TIME TO SYNC ACROSS ALL NODES
        if (isMounted) {
            setTimeout(() => {
                setIsLoading(false);
            }, 2500); 
        }

      } catch (error: any) {
        console.error("Failed to finalize signup", error);
        if (isMounted) {
            Alert.alert(
                "Signup Failed", 
                error.message || "Could not complete the process.",
                [
                    { text: "Go to Login", onPress: () => router.replace("/auth/login") },
                    { text: "Retry", onPress: () => finalizeSignup() }
                ]
            );
            setIsLoading(false);
        }
      }
    };

    finalizeSignup();
    return () => { isMounted = false; };
  }, []);

  const handleGoHome = async () => {
    setIsFinishing(true);
    try {
      // PRE-EMPTIVE STORE RESET
      resetStore();
      
      // CRITICAL FIX: Force a small wait so the local cache of auth state is solid
      setTimeout(() => {
          router.replace("/home");
      }, 500);
    } catch (e) {
      setIsFinishing(false);
    }
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
              <TouchableOpacity 
                style={[styles.button, isFinishing && { opacity: 0.7 }]} 
                onPress={handleGoHome}
                disabled={isFinishing}
              >
                  {isFinishing ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Go to Homepage</Text>}
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
