import React, { useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Platform,
  KeyboardAvoidingView,
  Image
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "@/hooks/use-theme-color";
import { Left_Arrow, Lock_Icon, Eye_Open, Eye_Close, Checkmark_Icon, CreateNewPwdDark, CreateNewPwdLight } from "@/assets/svgs";
import { PrimaryButton } from "@/src/components/buttons/PrimaryButton";
import { FormInput } from "@/src/components/inputs/FormInput";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useToast } from "@/src/components/toast/ToastProvider";
import { SuccessModal } from "@/src/components/forms/SuccessModal";

const newPasswordSchema = z.object({
  password: z.string().min(6, "Password must be at least 6 characters"),
  passwordConfirmation: z.string().min(6, "Password must be at least 6 characters"),
}).refine((data) => data.password === data.passwordConfirmation, {
    message: "Passwords don't match",
    path: ["passwordConfirmation"],
});

type NewPasswordFormData = z.infer<typeof newPasswordSchema>;

export default function CreateNewPasswordScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const backgroundColor = useThemeColor({}, "background");
  const textColor = useThemeColor({}, "text");
  const { addToast } = useToast();
  const colorScheme = useColorScheme();

  const [isLoading, setIsLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showPasswordConfirmation, setShowPasswordConfirmation] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [showSuccessModal, setShowSuccessModal] = useState(false);

  const {
    control,
    handleSubmit,
    formState: { errors },
  } = useForm<NewPasswordFormData>({
    resolver: zodResolver(newPasswordSchema),
    defaultValues: {
      password: "",
      passwordConfirmation: "",
    },
  });

  const onSubmit = async (data: NewPasswordFormData) => {
    setIsLoading(true);
    // Simulate API call
    setTimeout(() => {
        setIsLoading(false);
        setShowSuccessModal(true);
    }, 1500);
  };

  const handleSuccess = () => {
      setShowSuccessModal(false);
      router.dismissAll(); // Go back to root or login
      router.push("/auth/login");
  };

  const useColorScheme = () => {
      return React.useContext(React.createContext('light')); // simplified for this file, ideally import from hooks
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View
        style={[
          styles.container,
          { backgroundColor, paddingTop: insets.top, paddingBottom: insets.bottom },
        ]}
      >
        <View style={styles.header}>
            <View style={styles.headerTitleContainer}>
                <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
                <Left_Arrow width={24} height={24} color={textColor} />
                </TouchableOpacity>
                <Text style={[styles.headerTitle, { color: textColor }]}>Create New Password</Text>
            </View>
        </View>

        <ScrollView contentContainerStyle={styles.contentContainer}>
          <View style={styles.imageContainer}>
             {/* Replace with actual image asset if available, using SVG for now */}
             {colorScheme === 'dark' ? 
                <CreateNewPwdDark width={300} height={250} /> : 
                <CreateNewPwdLight width={300} height={250} />
             }
          </View>

          <Text style={[styles.sectionTitle, { color: textColor }]}>Create Your New Password</Text>

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

            <View style={styles.rememberMeContainer}>
              <TouchableOpacity
                style={styles.checkboxContainer}
                onPress={() => setRememberMe(!rememberMe)}
              >
                <View style={[styles.checkbox, rememberMe && styles.checkboxChecked]}>
                  {rememberMe && <Checkmark_Icon width={12} height={12} color="#fff" />}
                </View>
                <Text style={[styles.rememberMeText, { color: textColor }]}>Remember me</Text>
              </TouchableOpacity>
            </View>

        </ScrollView>

        <View style={styles.footer}>
          <PrimaryButton 
            title="Continue" 
            onPress={handleSubmit(onSubmit)} 
            isLoading={isLoading}
          />
        </View>

        <SuccessModal 
            visible={showSuccessModal}
            onClose={handleSuccess}
            title="Congratulations!"
            message="Your account is ready to use. You will be redirected to the Home page in a few seconds."
            buttonText="Go to Homepage" // Technically Login page based on flow
            onButtonPress={handleSuccess}
        />
      </View>
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
  headerTitleContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  backButton: {
    padding: 8,
    marginLeft: -8,
  },
  headerTitle: {
    fontSize: 20,
    fontFamily: 'Urbanist-Bold',
  },
  contentContainer: {
    paddingHorizontal: 24,
    paddingBottom: 100,
  },
  imageContainer: {
    alignItems: 'center',
    marginBottom: 40,
    marginTop: 20,
  },
  sectionTitle: {
      fontSize: 18,
      fontFamily: 'Urbanist-Medium',
      marginBottom: 24,
  },
  rememberMeContainer: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 20,
    marginTop: 8,
  },
  checkboxContainer: {
    flexDirection: "row",
    alignItems: "center",
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: "#FF4D67",
    justifyContent: "center",
    alignItems: "center",
    marginRight: 10,
  },
  checkboxChecked: {
    backgroundColor: "#FF4D67",
  },
  rememberMeText: {
    fontSize: 14,
    fontFamily: 'Urbanist-SemiBold',
  },
  footer: {
    padding: 24,
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
  },
});
