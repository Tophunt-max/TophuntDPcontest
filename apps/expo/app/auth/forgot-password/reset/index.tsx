import React, { useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Platform,
  KeyboardAvoidingView,
  TextInput,
  Switch
} from "react-native";
import { z } from 'zod';
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "@/hooks/use-theme-color";
import { useColorScheme } from '@/hooks/use-color-scheme';
import { NewPassWordDark, NewPassWordLight, Eye_Open, Eye_Close } from "@/assets/svgs";
import { BackButton } from "@/src/components/ui/BackButton";
import { PrimaryButton } from "@/src/components/buttons/PrimaryButton";
import { useToast } from "@/src/components/toast/ToastProvider";
import { callApi } from '@/src/services/api'; // Consolidated API used

// Mirror the server-side policy (worker lib/password.ts) so the user gets
// inline feedback instead of a round-trip rejection.
const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters long')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/\d/, 'Password must contain at least one number')
  .regex(/[^a-zA-Z0-9]/, 'Password must contain at least one special character');

export default function ResetPasswordScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { phoneNumber } = useLocalSearchParams<{ phoneNumber: string }>();
  const colorScheme = useColorScheme();
  const backgroundColor = useThemeColor({}, "background");
  const textColor = useThemeColor({}, "text");
  const { addToast } = useToast();
  
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isPasswordVisible, setIsPasswordVisible] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleResetPassword = async () => {
    try {
      passwordSchema.parse(newPassword);
      if (newPassword !== confirmPassword) {
        addToast({ type: 'error', text: 'Passwords do not match.' });
        return;
      }

      setLoading(true);
      // Using callApi with 'updatePasswordWithPhone' action
      await callApi('updatePasswordWithPhone', { phone: phoneNumber, newPassword });
      
      router.push("/auth/forgot-password/success");

    } catch (error: any) {
      if (error instanceof z.ZodError) {
        addToast({ type: 'error', text: error.errors[0].message });
      } else {
        addToast({ type: 'error', text: error.message || "An error occurred" });
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={{ flex: 1, backgroundColor }}
    >
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
        }}
      >
        <View style={styles.container}>
          <BackButton size={24} color={textColor} style={styles.backButton} />
          <View style={styles.header}>
            <Text style={[styles.title, { color: textColor }]}>Create New Password</Text>
            {colorScheme === 'light' ? <NewPassWordLight/> : <NewPassWordDark/>}
          </View>

          <View style={styles.inputContainer}>
            <TextInput
              style={[styles.input, { color: textColor, backgroundColor: useThemeColor({}, 'input') }]}
              placeholder="New Password"
              placeholderTextColor={useThemeColor({}, "textSecondary")}
              secureTextEntry={!isPasswordVisible}
              value={newPassword}
              onChangeText={setNewPassword}
            />
            <TouchableOpacity style={styles.eyeIcon} onPress={() => setIsPasswordVisible(!isPasswordVisible)}>
              {isPasswordVisible ? <Eye_Open /> : <Eye_Close />}
            </TouchableOpacity>
          </View>
          <View style={styles.inputContainer}>
            <TextInput
              style={[styles.input, { color: textColor, backgroundColor: useThemeColor({}, 'input') }]}
              placeholder="Confirm Password"
              placeholderTextColor={useThemeColor({}, "textSecondary")}
              secureTextEntry={!isPasswordVisible}
              value={confirmPassword}
              onChangeText={setConfirmPassword}
            />
             <TouchableOpacity style={styles.eyeIcon} onPress={() => setIsPasswordVisible(!isPasswordVisible)}>
              {isPasswordVisible ? <Eye_Open /> : <Eye_Close />}
            </TouchableOpacity>
          </View>

          <View style={styles.rememberMeContainer}>
            <Switch
              trackColor={{ false: "#767577", true: "#FF6347" }}
              thumbColor={rememberMe ? "#f4f3f4" : "#f4f3f4"}
              ios_backgroundColor="#3e3e3e"
              onValueChange={setRememberMe}
              value={rememberMe}
            />
            <Text style={{ color: textColor, marginLeft: 10 }}>Remember me</Text>
          </View>

          <PrimaryButton
            title="Continue"
            onPress={handleResetPassword}
            isLoading={loading}
            disabled={loading || !newPassword || !confirmPassword}
          />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 20,
    alignItems: 'center'
  },
  backButton: {
    alignSelf: "flex-start",
    padding: 10,
  },
  header: {
    alignItems: "center",
    marginBottom: 30,
  },
  title: {
    fontSize: 24,
    fontWeight: "bold",
    marginBottom: 20,
  },
  inputContainer: {
    width: '100%',
    marginBottom: 20,
    position: 'relative',
    justifyContent: 'center'
  },
  input: {
    width: '100%',
    height: 50,
    paddingHorizontal: 15,
    borderRadius: 10,
    fontSize: 16,
  },
  eyeIcon: {
    position: 'absolute',
    right: 15,
  },
  rememberMeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    marginBottom: 30,
  }
});