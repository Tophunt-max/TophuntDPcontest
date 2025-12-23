import {
  View,
  Text,
  TouchableOpacity,
  Image,
  ScrollView,
  StyleSheet,
  Platform,
  ActivityIndicator,
  Modal,
  Alert,
} from "react-native";
import React, { useState, useEffect } from "react";
import { router } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import { useSignupStore } from "../../../../src/store/signup";
import { uploadToS3 } from "../../../../src/lib/uploadToS3";
import { FormInput } from "@/src/components/inputs/FormInput";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { SafeAreaView } from "react-native-safe-area-context";
import { Left_Arrow, Email_Icon } from "@/assets/svgs";
import { Ionicons } from "@expo/vector-icons";
import { DatePickerField } from "@/src/components/inputs/DatePickerField";
import { CountryPicker } from "react-native-country-codes-picker";
import { httpsCallable } from "firebase/functions";
import { functions } from "../../../../src/services/firebase/initFirebase";
import Images from "@/assets/images";
import Svg, { Circle } from 'react-native-svg';
// Removed import for saveUserProfile

const fillProfileSchema = z.object({
  avatarUrl: z.string().min(1, "Please upload a profile picture"),
  fullName: z.string().min(1, "Please fill in your full name"),
  username: z.string()
    .min(1, "Please fill in a username")
    .min(3, "Username must be at least 3 characters")
    .regex(/^[a-zA-Z0-9_.]+$/, "Only letters, numbers, dots and underscores allowed"),
  email: z.string().min(1, "Email is required").email("Invalid email address"),
  phone: z.string().min(1, "Please fill in your phone number").min(10, "Phone number must be at least 10 digits"),
  occupation: z.string().min(1, "Please select your occupation"),
  gender: z.string().min(1, "Please select your gender"),
  dateOfBirth: z.date({
    required_error: "Please select your date of birth",
    invalid_type_error: "Please select your date of birth",
  }).refine((date) => {
    const today = new Date();
    let age = today.getFullYear() - date.getFullYear();
    const m = today.getMonth() - date.getMonth();
    if (m < 0 || (m === 0 && today.getDate() < date.getDate())) {
        age--;
    }
    return age >= 15;
  }, "You must be at least 15 years old"),
});

type FillProfileFormValues = z.infer<typeof fillProfileSchema>;

const occupations = [
    "Student",
    "Engineer",
    "Doctor",
    "Artist",
    "Teacher",
    "Developer",
    "Designer",
    "Manager",
    "Other"
];

const CircularProgress = ({ progress, size = 60 }: { progress: number, size?: number }) => {
    const strokeWidth = 4;
    const radius = (size - strokeWidth) / 2;
    const circumference = radius * 2 * Math.PI;
    const offset = circumference - progress * circumference;
  
    return (
      <View style={{ justifyContent: 'center', alignItems: 'center' }}>
        <Svg width={size} height={size}>
          <Circle
            stroke="rgba(255, 255, 255, 0.3)"
            fill="none"
            cx={size / 2}
            cy={size / 2}
            r={radius}
            strokeWidth={strokeWidth}
          />
          <Circle
            stroke="#ff4466"
            fill="none"
            cx={size / 2}
            cy={size / 2}
            r={radius}
            strokeWidth={strokeWidth}
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        </Svg>
        <View style={{ position: 'absolute' }}>
          <Text style={{ color: '#ff4466', fontSize: size * 0.2, fontWeight: 'bold' }}>{Math.round(progress * 100)}%</Text>
        </View>
      </View>
    );
  };

const FillProfile: React.FC = () => {
  const { data: signupData, setMultiple, setField } = useSignupStore();
  const [isGenderPickerVisible, setGenderPickerVisibility] = useState(false);
  const [isOccupationPickerVisible, setOccupationPickerVisibility] = useState(false);
  const [showCountryPicker, setShowCountryPicker] = useState(false);
  const [countryCode, setCountryCode] = useState("+91");
  const [isLoading, setIsLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(0);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [localAvatarUri, setLocalAvatarUri] = useState<string | null>(signupData.avatarUrl || null);
  
  const [usernameChecking, setUsernameChecking] = useState(false);
  const [phoneChecking, setPhoneChecking] = useState(false);
  const [apiErrors, setApiErrors] = useState<{username?: string, phone?: string}>({});

  const {
    control,
    handleSubmit,
    setValue,
    watch,
    trigger,
    setError,
    clearErrors,
    formState: { errors },
  } = useForm<FillProfileFormValues>({
    resolver: zodResolver(fillProfileSchema),
    defaultValues: {
      avatarUrl: signupData.avatarUrl || "",
      fullName: signupData.fullName || "",
      username: signupData.username || "",
      email: signupData.email || "",
      phone: signupData.phone || "",
      occupation: signupData.occupation || "",
      gender: signupData.gender || "",
      dateOfBirth: signupData.dob ? new Date(signupData.dob) : undefined,
    },
  });

  const selectedOccupation = watch("occupation");
  const selectedGender = watch("gender");
  const username = watch("username");
  const phone = watch("phone");

  // Effect to check unique username
  useEffect(() => {
    const checkUsername = async () => {
        if (username.length >= 3) {
            setUsernameChecking(true);
            try {
                const checkUniqueUsername = httpsCallable(functions, 'checkUniqueUsername');
                const result = await checkUniqueUsername({ username });
                if ((result.data as any).exists) {
                    setError("username", { type: "manual", message: "This username is already taken" });
                } else {
                    clearErrors("username");
                }
            } catch (error) {
                console.error("Username check failed", error);
            } finally {
                setUsernameChecking(false);
            }
        }
    };

    const timer = setTimeout(checkUsername, 500); // Debounce
    return () => clearTimeout(timer);
  }, [username]);

  // Effect to check unique phone
  useEffect(() => {
    const checkPhone = async () => {
        if (phone.length >= 10) {
            setPhoneChecking(true);
            try {
                const checkPhoneExists = httpsCallable(functions, 'checkPhoneExists');
                const result = await checkPhoneExists({ phone: countryCode + phone });
                if ((result.data as any).exists) {
                    setError("phone", { type: "manual", message: "This phone number is already registered" });
                } else {
                    clearErrors("phone");
                }
            } catch (error) {
                console.error("Phone check failed", error);
            } finally {
                setPhoneChecking(false);
            }
        }
    };

    const timer = setTimeout(checkPhone, 500); // Debounce
    return () => clearTimeout(timer);
  }, [phone, countryCode]);

  const pickAvatar = async () => {
    const img = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.5,
    });
    
    if (!img.canceled && img.assets) {
      const selectedImage = img.assets[0];
      setLocalAvatarUri(selectedImage.uri);
      setValue("avatarUrl", selectedImage.uri);
      setIsUploading(1);
      setUploadProgress(0);
      
      try {
         const s3Url = await uploadToS3(selectedImage.uri, "image/jpeg", "avatars", (progress) => {
             setUploadProgress(progress);
         });
         setValue("avatarUrl", s3Url as string);
         setField("avatarUrl", s3Url as string);
         trigger("avatarUrl");
      } catch (e) {
        console.error("Upload failed", e);
        setLocalAvatarUri(null);
        setValue("avatarUrl", "");
        Alert.alert("Upload Failed", "Could not upload profile picture.");
      } finally {
        setIsUploading(0);
      }
    }
  };

  const onSubmit = async (data: FillProfileFormValues) => {
    if (usernameChecking || phoneChecking) return; // Wait for async checks

    setIsLoading(true);
    try {
      const userData = {
        ...signupData, // Include email and password from previous step
        avatarUrl: data.avatarUrl,
        fullName: data.fullName,
        username: data.username,
        email: data.email,
        phone: countryCode + data.phone,
        occupation: data.occupation,
        gender: data.gender,
        dob: data.dateOfBirth?.toISOString(),
      };
      
      // saveUserProfile(userData); // Removed saveUserProfile call
      setMultiple(userData); // Update the store with all collected data
      router.push("/auth/signup/follow-someone");
    } catch (error) {
      console.error("Submission error", error);
      Alert.alert("Error", "Something went wrong. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const onInvalid = () => {
    Alert.alert("Incomplete Profile", "Please fill in all the required fields correctly.");
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Left_Arrow width={24} height={24} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Fill Your Profile</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.avatarContainer}>
          <TouchableOpacity onPress={pickAvatar} style={styles.avatarWrapper} disabled={!!isUploading}>
             <Image 
                source={localAvatarUri ? { uri: localAvatarUri } : Images.userLight} 
                style={[styles.avatar, errors.avatarUrl ? { borderColor: 'red', borderWidth: 2 } : null]} 
             />
             {!!isUploading && (
                 <View style={styles.uploadOverlay}>
                     <CircularProgress progress={uploadProgress} size={80} />
                 </View>
             )}
            {!isUploading && (
                <View style={styles.editIconContainer}>
                    <Ionicons name="pencil" size={18} color="white" />
                </View>
            )}
          </TouchableOpacity>
          {errors.avatarUrl && <Text style={[styles.errorText, { textAlign: 'center' }]}>{errors.avatarUrl.message}</Text>}
        </View>

        <FormInput
          control={control}
          name="fullName"
          placeholder="Full Name"
          errorMessage={errors.fullName?.message}
        />

        <View>
            <FormInput
                control={control}
                name="username"
                placeholder="Username"
                errorMessage={errors.username?.message}
                rightIcon={usernameChecking ? <ActivityIndicator size="small" color="#ff4466" /> : null}
            />
        </View>

        <FormInput
          control={control}
          name="email"
          placeholder="Email"
          rightIcon={<Email_Icon width={20} height={20} color="#9E9E9E" />}
          keyboardType="email-address"
          editable={false}
          errorMessage={errors.email?.message}
        />

        <View style={styles.phoneInputRow}>
             <TouchableOpacity
               style={styles.flagButton}
               onPress={() => setShowCountryPicker(true)}
             >
                <Text style={styles.flagText}>{countryCode}</Text>
                <Ionicons name="chevron-down" size={12} color="#9E9E9E" style={{ marginLeft: 4 }} />
             </TouchableOpacity>

             <View style={styles.phoneNumberInputWrapper}>
                 <FormInput
                    control={control}
                    name="phone"
                    placeholder="Phone Number"
                    containerStyle={{ flex: 1, marginBottom: 0 }}
                    keyboardType="phone-pad"
                    errorMessage={errors.phone?.message}
                    rightIcon={phoneChecking ? <ActivityIndicator size="small" color="#ff4466" /> : null}
                 />
             </View>
        </View>

        <CountryPicker
          show={showCountryPicker}
          pickerButtonOnPress={(item) => {
            setCountryCode(item.dial_code);
            setShowCountryPicker(false);
          }}
          onBackdropPress={() => setShowCountryPicker(false)}
          style={{ modal: { height: 500 }, countryButtonStyles: { height: 50 } }}
        />

        <View style={{ marginBottom: 20 }}>
          <TouchableOpacity
            style={[styles.dropdownContainer, errors.gender && styles.inputError]}
            onPress={() => setGenderPickerVisibility(true)}
          >
              <Text style={[styles.dropdownText, !selectedGender && { color: '#9E9E9E' }]}>
                  {selectedGender || "Gender"}
              </Text>
              <Ionicons name="chevron-down" size={20} color="#9E9E9E" />
          </TouchableOpacity>
          {errors.gender && <Text style={styles.errorText}>{errors.gender.message}</Text>}
        </View>

        <View style={{ marginBottom: 20 }}>
          <TouchableOpacity
            style={[styles.dropdownContainer, errors.occupation && styles.inputError]}
            onPress={() => setOccupationPickerVisibility(true)}
          >
              <Text style={[styles.dropdownText, !selectedOccupation && { color: '#9E9E9E' }]}>
                  {selectedOccupation || "Occupation"}
              </Text>
              <Ionicons name="chevron-down" size={20} color="#9E9E9E" />
          </TouchableOpacity>
          {errors.occupation && <Text style={styles.errorText}>{errors.occupation.message}</Text>}
        </View>

        <DatePickerField
          control={control}
          name="dateOfBirth"
          placeholder="Date of Birth"
          errorMessage={errors.dateOfBirth?.message}
        />

        <TouchableOpacity
          onPress={handleSubmit(onSubmit, onInvalid)}
          style={styles.continueButton}
          disabled={isLoading || !!isUploading || usernameChecking || phoneChecking}
        >
          {isLoading ? (
            <ActivityIndicator color="white" />
          ) : (
            <Text style={styles.continueButtonText}>Continue</Text>
          )}
        </TouchableOpacity>

      </ScrollView>

      {/* Gender Modal */}
      <Modal transparent visible={isGenderPickerVisible} animationType="fade">
        <TouchableOpacity style={styles.modalOverlay} onPress={() => setGenderPickerVisibility(false)}>
            <View style={styles.modalContent}>
                <Text style={styles.modalTitle}>Select Gender</Text>
                <View style={styles.separator} />
                {['Male', 'Female', 'Other'].map((g) => (
                    <TouchableOpacity key={g} style={styles.modalOption} onPress={() => { setValue('gender', g); trigger('gender'); setGenderPickerVisibility(false); }}>
                        <Text style={[styles.modalOptionText, selectedGender === g && styles.selectedOptionText]}>{g}</Text>
                        {selectedGender === g && <Ionicons name="checkmark" size={24} color="#ff4466" />}
                    </TouchableOpacity>
                ))}
            </View>
        </TouchableOpacity>
      </Modal>

      {/* Occupation Modal */}
      <Modal transparent visible={isOccupationPickerVisible} animationType="fade">
        <TouchableOpacity style={styles.modalOverlay} onPress={() => setOccupationPickerVisibility(false)}>
            <View style={[styles.modalContent, { maxHeight: '60%' }]}>
                <Text style={styles.modalTitle}>Select Occupation</Text>
                <View style={styles.separator} />
                <ScrollView>
                    {occupations.map((occ) => (
                        <TouchableOpacity key={occ} style={styles.modalOption} onPress={() => { setValue('occupation', occ); trigger('occupation'); setOccupationPickerVisibility(false); }}>
                            <Text style={[styles.modalOptionText, selectedOccupation === occ && styles.selectedOptionText]}>{occ}</Text>
                            {selectedOccupation === occ && <Ionicons name="checkmark" size={24} color="#ff4466" />}
                        </TouchableOpacity>
                    ))}
                </ScrollView>
            </View>
        </TouchableOpacity>
      </Modal>

    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingVertical: 10 },
  headerTitle: { fontSize: 20, fontFamily: "Urbanist-SemiBold", color: "#000" },
  scrollContent: { paddingHorizontal: 24, paddingBottom: 40 },
  avatarContainer: { alignItems: "center", marginVertical: 30 },
  avatarWrapper: { position: "relative" },
  avatar: { width: 140, height: 140, borderRadius: 70, backgroundColor: '#F5F5F5' },
  uploadOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)', borderRadius: 70, justifyContent: 'center', alignItems: 'center' },
  editIconContainer: { position: 'absolute', bottom: 5, right: 5, backgroundColor: '#ff4466', borderRadius: 12, padding: 6, borderWidth: 3, borderColor: '#fff', width: 32, height: 32, justifyContent: 'center', alignItems: 'center' },
  errorText: { color: 'red', fontSize: 12, marginTop: 4, fontFamily: 'Urbanist-Medium' },
  phoneInputRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 20, gap: 12 },
  flagButton: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FAFAFA', borderRadius: 12, paddingHorizontal: 12, height: 56, justifyContent: 'center' },
  flagText: { fontSize: 16, fontFamily: "Urbanist-Medium", color: "#000" },
  phoneNumberInputWrapper: { flex: 1 },
  dropdownContainer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#FAFAFA', borderRadius: 12, paddingHorizontal: 16, height: 56 },
  inputError: { borderColor: 'red', borderWidth: 1, backgroundColor: '#FFF5F5' },
  dropdownText: { fontSize: 16, color: '#000', fontFamily: "Urbanist-Medium" },
  continueButton: { backgroundColor: "#ff4466", paddingVertical: 18, borderRadius: 30, marginTop: 20 },
  continueButtonText: { color: "white", textAlign: "center", fontSize: 16, fontWeight: "bold", fontFamily: "Urbanist-SemiBold" },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: '#fff', borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingBottom: 40, paddingHorizontal: 24, paddingTop: 24 },
  modalTitle: { fontSize: 20, fontFamily: 'Urbanist-Bold', color: '#000', textAlign: 'center', marginBottom: 16 },
  separator: { height: 1, backgroundColor: '#EEEEEE', marginBottom: 8 },
  modalOption: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#F5F5F5' },
  modalOptionText: { fontSize: 18, fontFamily: 'Urbanist-SemiBold', color: '#424242' },
  selectedOptionText: { color: '#ff4466', fontFamily: 'Urbanist-Bold' },
});

export default FillProfile;