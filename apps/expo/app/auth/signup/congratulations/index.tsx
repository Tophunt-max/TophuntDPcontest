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
import { httpsCallable } from "firebase/functions";
import { functions, auth } from "@/src/services/firebase/initFirebase";
import { signInWithEmailAndPassword } from "firebase/auth";

const { width } = Dimensions.get('window');

export default function CongratulationsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { data: signupData, reset: resetStore } = useSignupStore();
  const [isLoading, setIsLoading] = useState(true);
  const [statusMessage, setStatusMessage] = useState("Finalizing your account...");

  useEffect(() => {
    const finalizeSignup = async () => {
      try {
        console.log("Finalizing signup for provider:", signupData.authProvider);

        if (signupData.authProvider === 'email') {
            if (!signupData.email || !signupData.password || !signupData.username) {
                throw new Error("Missing user data. Please restart the signup process.");
            }
            
            setStatusMessage("Creating your account securely...");
            const authHandler = httpsCallable(functions, 'authHandler');
            const result = await authHandler({ 
                action: 'create',
                ...signupData,
                platform: Platform.OS,
            });

            const data = result.data as any;
            if (data.status !== 'success') {
                throw new Error(data.message || "An unknown error occurred on the server.");
            }

            // Automatically sign the user in
            setStatusMessage("Signing you in...");
            await signInWithEmailAndPassword(auth, signupData.email, signupData.password);
        } else {
            // For Phone, Google, Facebook - User is already authenticated in Auth
            // We only need to create the Firestore profile
            if (!signupData.username) {
                throw new Error("Username is required to complete your profile.");
            }

            setStatusMessage("Saving your profile details...");
            const authHandler = httpsCallable(functions, 'authHandler');
            
            // For phone login, the user is already signed in at the start of the flow
            const result = await authHandler({ 
                action: 'createProfile',
                ...signupData,
                platform: Platform.OS,
                uid: auth.currentUser?.uid // Ensure we have the UID
            });

            const data = result.data as any;
            if (data.status !== 'success') {
                throw new Error(data.message || "Failed to save profile.");
            }
        }

        console.log("Signup finalized successfully.");
        await AsyncStorage.setItem('hasSeenOnboarding', 'true');
        resetStore();

      } catch (error: any) {
        console.error("Failed to finalize signup", error);
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
