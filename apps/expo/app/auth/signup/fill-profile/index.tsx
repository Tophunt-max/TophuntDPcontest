import {
  View,
  Text,
  TouchableOpacity,
  Image,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Platform,
} from "react-native";
import React, { useState, useEffect } from "react";
import { router } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import * as Location from 'expo-location';
import * as Device from 'expo-device';
import { useSignupStore } from "../../../../src/store/signup";
import { FormInput } from "@/src/components/inputs/FormInput";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { SafeAreaView } from "react-native-safe-area-context";
import { Left_Arrow, Email_Icon, Pencil_Icon } from "@/assets/svgs";
import { Ionicons } from "@expo/vector-icons";
import { DatePickerField } from "@/src/components/inputs/DatePickerField";
import { CountryPicker } from "react-native-country-codes-picker";
import { useToast } from "@/src/components/toast/ToastProvider";
import Images from "@/assets/images";
import { ReanimatedBottomSheet } from "@/src/components/modals/ReanimatedBottomSheet";
import { useAuth } from "@/src/hooks/useAuth";
import { doc, getDoc } from "firebase/firestore";
import { firestore as db } from "@/src/services/firebase/initFirebase";

const fillProfileSchema = z.object({
  avatarUrl: z.string().optional().nullable(),
  fullName: z.string().min(1, "Full name is required"),
  username: z.string()
    .min(1, "Username is required")
    .min(3, "Must be at least 3 characters")
    .regex(/^[a-zA-Z0-9_.]+$/, "Invalid format"),
  email: z.string().min(1, "Email is required").email("Invalid email"),
  phone: z.string().optional(),
  occupation: z.string().min(1, "Required"),
  gender: z.string().min(1, "Required"),
  dateOfBirth: z.any().refine((val) => !!val, "Required"),
});

type FillProfileFormValues = z.infer<typeof fillProfileSchema>;

const occupations = ["Student", "Engineer", "Doctor", "Artist", "Teacher", "Developer", "Designer", "Manager", "Other"];

const FillProfile: React.FC = () => {
  const { data: signupData, setMultiple, setField } = useSignupStore();
  const { user } = useAuth();
  const { addToast } = useToast();
  
  const [isGenderPickerVisible, setGenderPickerVisibility] = useState(false);
  const [isOccupationPickerVisible, setOccupationPickerVisibility] = useState(false);
  const [showCountryPicker, setShowCountryPicker] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isDataFetching, setIsDataFetching] = useState(false);

  const [countryCode, setCountryCode] = useState('+91');
  const [localAvatarUri, setLocalAvatarUri] = useState<string | null>(signupData.avatarUrl || null);

  const { control, handleSubmit, setValue, watch, trigger, formState: { errors } } = useForm<FillProfileFormValues>({
    resolver: zodResolver(fillProfileSchema),
    defaultValues: {
      avatarUrl: signupData.avatarUrl || "",
      fullName: signupData.fullName || "",
      username: signupData.username || "",
      email: signupData.email || "",
      phone: signupData.phone?.replace(/^\+\d{2,3}/, '') || "",
      occupation: signupData.occupation || "",
      gender: signupData.gender || "",
      dateOfBirth: signupData.dob ? new Date(signupData.dob) : undefined,
    },
  });

  const selectedOccupation = watch("occupation");
  const selectedGender = watch("gender");
  
  const isEmailLocked = (signupData.authProvider === 'google' || signupData.authProvider === 'facebook' || signupData.authProvider === 'apple') && !!signupData.email;
  const isPhoneLocked = signupData.authProvider === 'phone' && !!signupData.phone;

  // Recovery: If store is empty, try fetching from Firestore
  useEffect(() => {
    const recoverData = async () => {
        if (user?.uid && !signupData.email && !signupData.fullName) {
            setIsDataFetching(true);
            try {
                const docSnap = await getDoc(doc(db, "users", user.uid));
                if (docSnap.exists()) {
                    const data = docSnap.data();
                    const recovered = {
                        fullName: data.fullName || "",
                        username: data.username || "",
                        email: data.email || user.email || "",
                        phone: data.phoneNumber || user.phoneNumber || "",
                        avatarUrl: data.avatarUrl || user.photoURL || "",
                        gender: data.gender || "",
                        occupation: data.occupation || "",
                        dob: data.dob || ""
                    };
                    setMultiple(recovered);
                    
                    // Update form values
                    setValue("fullName", recovered.fullName);
                    setValue("username", recovered.username);
                    setValue("email", recovered.email);
                    setValue("phone", recovered.phone.replace(/^\+\d{2,3}/, ''));
                    setValue("gender", recovered.gender);
                    setValue("occupation", recovered.occupation);
                    if (recovered.dob) setValue("dateOfBirth", new Date(recovered.dob));
                    if (recovered.avatarUrl) {
                        setValue("avatarUrl", recovered.avatarUrl);
                        setLocalAvatarUri(recovered.avatarUrl);
                    }
                }
            } catch (e) {
                console.error("Data recovery failed:", e);
            } finally {
                setIsDataFetching(false);
            }
        }
    };
    recoverData();
  }, [user]);

  useEffect(() => {
    (async () => {
        try {
            const { status } = await Location.requestForegroundPermissionsAsync();
            if (status === 'granted') {
                const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
                setMultiple({ coordinates: { lat: location.coords.latitude, lng: location.coords.longitude } });
            }
            
            const deviceInfo = {
              brand: Device.brand,
              model: Device.modelName,
              osName: Device.osName,
              osVersion: Device.osVersion,
              platform: Platform.OS,
              deviceId: Device.osInternalBuildId || Device.modelId,
            };
            setField("deviceInfo", deviceInfo);
        } catch (e) {}
    })();
  }, []);

  const pickAvatar = async () => {
    const img = await ImagePicker.launchImageLibraryAsync({ 
        mediaTypes: ['images'], 
        allowsEditing: true, 
        aspect: [1, 1], 
        quality: 0.8 
    });
    
    if (!img.canceled && img.assets) {
      setLocalAvatarUri(img.assets[0].uri);
      setValue("avatarUrl", img.assets[0].uri);
      setField("avatarUrl", img.assets[0].uri);
      trigger("avatarUrl");
    }
  };

  const onSubmit = async (data: FillProfileFormValues) => {
    setIsLoading(true);
    try {
      const finalPhone = data.phone ? (countryCode + data.phone) : (signupData.phone || "");
      setMultiple({ 
          ...signupData, 
          avatarUrl: data.avatarUrl || signupData.avatarUrl,
          fullName: data.fullName, 
          username: data.username, 
          email: data.email, 
          phone: finalPhone, 
          occupation: data.occupation, 
          gender: data.gender, 
          dob: data.dateOfBirth instanceof Date ? data.dateOfBirth.toISOString() : data.dateOfBirth 
      });
      router.push("/auth/signup/follow-someone");
    } catch (e) { 
        addToast("Error saving profile details", "error"); 
    } finally { 
        setIsLoading(false); 
    }
  };

  if (isDataFetching) {
    return (
        <View style={[styles.container, { justifyContent: 'center', alignItems: 'center' }]}>
            <ActivityIndicator size="large" color="#ff4466" />
            <Text style={{ marginTop: 10, fontFamily: 'Urbanist-Medium' }}>Loading your profile...</Text>
        </View>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Left_Arrow width={24} height={24} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Fill Your Profile</Text>
        <View style={{ width: 24 }} />
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        <View style={styles.avatarContainer}>
          <TouchableOpacity onPress={pickAvatar} style={styles.avatarWrapper}>
             <Image source={localAvatarUri ? { uri: localAvatarUri } : Images.userLight} style={[styles.avatar, errors.avatarUrl && { borderColor: 'red', borderWidth: 2 }]} />
             <View style={styles.editIconContainer}>
                <Pencil_Icon width={16} height={16} fill="white" />
             </View>
          </TouchableOpacity>
        </View>

        <FormInput control={control} name="fullName" placeholder="Full Name" errorMessage={errors.fullName?.message} />
        <FormInput control={control} name="username" placeholder="Username" errorMessage={errors.username?.message} />
        <FormInput control={control} name="email" placeholder="Email" rightIcon={<Email_Icon width={20} height={20} color="#9E9E9E" />} editable={!isEmailLocked} style={isEmailLocked ? styles.readOnlyInput : null} errorMessage={errors.email?.message} />

        <View style={styles.phoneInputRow}>
             <TouchableOpacity style={[styles.flagButton, isPhoneLocked && styles.readOnlyInput]} onPress={() => !isPhoneLocked && setShowCountryPicker(true)} disabled={isPhoneLocked}>
                <Text style={styles.flagText}>{countryCode}</Text>
                {!isPhoneLocked && <Ionicons name="chevron-down" size={14} color="#9E9E9E" style={{ marginLeft: 4 }} />}
             </TouchableOpacity>
             <View style={styles.phoneField}>
                 <FormInput control={control} name="phone" placeholder="Phone Number" containerStyle={{ marginBottom: 0 }} keyboardType="phone-pad" editable={!isPhoneLocked} style={isPhoneLocked ? styles.readOnlyInput : null} errorMessage={errors.phone?.message} />
             </View>
        </View>

        <CountryPicker 
            show={showCountryPicker} 
            pickerButtonOnPress={(item) => { setCountryCode(item.dial_code); setShowCountryPicker(false); }} 
            onBackdropPress={() => setShowCountryPicker(false)} 
            style={{ modal: { height: 500 } }} 
        />

        <TouchableOpacity style={[styles.dropdown, errors.gender && { borderColor: 'red' }]} onPress={() => setGenderPickerVisibility(true)}>
            <Text style={{ color: selectedGender ? '#000' : '#9E9E9E', fontFamily: 'Urbanist-Medium' }}>{selectedGender || "Gender"}</Text>
            <Ionicons name="chevron-down" size={20} color="#9E9E9E" />
        </TouchableOpacity>

        <TouchableOpacity style={[styles.dropdown, errors.occupation && { borderColor: 'red' }]} onPress={() => setOccupationPickerVisibility(true)}>
            <Text style={{ color: selectedOccupation ? '#000' : '#9E9E9E', fontFamily: 'Urbanist-Medium' }}>{selectedOccupation || "Occupation"}</Text>
            <Ionicons name="chevron-down" size={20} color="#9E9E9E" />
        </TouchableOpacity>

        <DatePickerField control={control} name="dateOfBirth" placeholder="Date of Birth" errorMessage={errors.dateOfBirth?.message} />

        <TouchableOpacity onPress={handleSubmit(onSubmit)} style={styles.continueButton} disabled={isLoading}>
          {isLoading ? <ActivityIndicator color="white" /> : <Text style={styles.continueButtonText}>Continue</Text>}
        </TouchableOpacity>
      </ScrollView>

      <ReanimatedBottomSheet visible={isGenderPickerVisible} onClose={() => setGenderPickerVisibility(false)} title="Select Gender" maxHeight={300}>
        <View style={{ paddingBottom: 20 }}>
            {['Male', 'Female', 'Other'].map((g) => (
                <TouchableOpacity key={g} style={styles.modalOption} onPress={() => { setValue('gender', g); trigger('gender'); setGenderPickerVisibility(false); }}>
                    <Text style={[styles.modalOptionText, selectedGender === g && { color: '#ff4466', fontWeight: 'bold' }]}>{g}</Text>
                    {selectedGender === g && <Ionicons name="checkmark" size={24} color="#ff4466" />}
                </TouchableOpacity>
            ))}
        </View>
      </ReanimatedBottomSheet>

      <ReanimatedBottomSheet visible={isOccupationPickerVisible} onClose={() => setOccupationPickerVisibility(false)} title="Select Occupation" maxHeight={500}>
        <ScrollView style={{ maxHeight: 400 }} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
            {occupations.map((occ) => (
                <TouchableOpacity key={occ} style={styles.modalOption} onPress={() => { setValue('occupation', occ); trigger('occupation'); setOccupationPickerVisibility(false); }}>
                    <Text style={[styles.modalOptionText, selectedOccupation === occ && { color: '#ff4466', fontWeight: 'bold' }]}>{occ}</Text>
                    {selectedOccupation === occ && <Ionicons name="checkmark" size={24} color="#ff4466" />}
                </TouchableOpacity>
            ))}
        </ScrollView>
      </ReanimatedBottomSheet>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, paddingVertical: 10 },
  headerTitle: { fontSize: 20, fontFamily: "Urbanist-Bold" },
  backButton: { padding: 5 },
  scrollContent: { paddingHorizontal: 24, paddingBottom: 40 },
  avatarContainer: { alignItems: "center", marginVertical: 30 },
  avatarWrapper: { position: "relative" },
  avatar: { width: 140, height: 140, borderRadius: 70, backgroundColor: '#F5F5F5' },
  editIconContainer: { position: 'absolute', bottom: 5, right: 5, backgroundColor: '#ff4466', borderRadius: 12, padding: 8, borderWidth: 3, borderColor: '#fff', width: 36, height: 36, justifyContent: 'center', alignItems: 'center', zIndex: 10 },
  phoneInputRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 20, gap: 12 },
  flagButton: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FAFAFA', borderRadius: 12, paddingHorizontal: 12, height: 56, justifyContent: 'center', borderWidth: 1, borderColor: '#f0f0f0' },
  flagText: { fontSize: 16, fontFamily: "Urbanist-Medium" },
  phoneField: { flex: 1 },
  dropdown: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#FAFAFA', borderRadius: 12, paddingHorizontal: 16, height: 56, marginBottom: 20, borderWidth: 1, borderColor: '#f0f0f0' },
  continueButton: { backgroundColor: "#ff4466", paddingVertical: 18, borderRadius: 30, marginTop: 10 },
  continueButtonText: { color: "white", textAlign: "center", fontSize: 16, fontFamily: "Urbanist-Bold" },
  modalOption: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: '#F5F5F5', paddingHorizontal: 20 },
  modalOptionText: { fontSize: 18, fontFamily: 'Urbanist-SemiBold', color: '#424242' },
  readOnlyInput: { opacity: 0.6, backgroundColor: '#f0f0f0' },
});

export default FillProfile;
