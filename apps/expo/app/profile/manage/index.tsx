import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  TouchableOpacity,
  Image,
  ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '@/src/services/auth';
import { useProfile } from '@/src/hooks/useProfileData';
import {
  Left_Arrow,
  Pencil_Icon,
  Facebook_Social_Icon,
  Instagram_Social_Icon,
  Twitter_Icon,
  About_Name,
  About_Username,
  About_Bio,
} from "@/assets/svgs";

export default function ManageAccountScreen() {
  const router = useRouter();
  const { user: authUser } = useAuth();
  const { data: profile } = useProfile(authUser?.uid || '');

  const avatarUri = profile?.profileImageUrl;
  const defaultImage = require('@/assets/images/userLight.png');

  const renderSectionHeader = (title: string) => (
    <Text style={styles.sectionHeader}>{title}</Text>
  );

  const renderItem = ({ 
    icon, 
    label, 
    value, 
    onPress, 
    isLast = false 
  }: { 
    icon: React.ReactNode, 
    label: string, 
    value?: string, 
    onPress: () => void,
    isLast?: boolean
  }) => (
    <TouchableOpacity 
        style={[styles.itemContainer, isLast && { borderBottomWidth: 0 }]} 
        onPress={onPress}
    >
      <View style={styles.itemLeft}>
        <View style={styles.iconWrapper}>
            {icon}
        </View>
        <Text style={styles.itemLabel}>{label}</Text>
      </View>
      <View style={styles.itemRight}>
        <Text style={styles.itemValue} numberOfLines={1}>{value || 'Not set'}</Text>
        <Ionicons name="chevron-forward" size={20} color="#212121" />
      </View>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Left_Arrow width={24} height={24} color="#000" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Manage Account</Text>
      </View>

      <ScrollView showsVerticalScrollIndicator={false}>
        {/* Profile Picture Section */}
        <View style={styles.profilePicSection}>
          <View style={styles.avatarWrapper}>
            <Image 
              source={avatarUri ? { uri: avatarUri } : defaultImage} 
              style={styles.avatar} 
            />
            <TouchableOpacity 
                style={styles.editBadge} 
                onPress={() => router.push('/profile/manage/edit')}
            >
              <Pencil_Icon width={12} height={12} fill="white" />
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.content}>
          {renderSectionHeader('About You')}
          
          {renderItem({
            icon: <About_Name width={22} height={22} />,
            label: 'Name',
            value: profile?.fullName || '',
            onPress: () => router.push('/profile/manage/edit'),
          })}

          {renderItem({
            icon: <About_Username width={22} height={22} />,
            label: 'Username',
            value: profile?.username || '',
            onPress: () => router.push('/profile/manage/edit'),
          })}

          {renderItem({
            icon: <About_Bio width={22} height={22} />,
            label: 'Bio',
            value: profile?.bio || '',
            onPress: () => router.push('/profile/manage/edit'),
          })}

          <View style={styles.divider} />

          {renderSectionHeader('Social')}

          {renderItem({
            icon: <Facebook_Social_Icon width={22} height={22} />,
            label: 'Facebook',
            value: (profile as any)?.facebook,
            onPress: () => router.push('/profile/manage/edit'),
          })}

          {renderItem({
            icon: <Twitter_Icon width={22} height={22} />,
            label: 'Twitter',
            value: (profile as any)?.twitter,
            onPress: () => router.push('/profile/manage/edit'),
          })}

          {renderItem({
            icon: <Instagram_Social_Icon width={22} height={22} />,
            label: 'Instagram',
            value: (profile as any)?.instagram,
            onPress: () => router.push('/profile/manage/edit'),
            isLast: true
          })}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 15,
  },
  backButton: {
    marginRight: 15,
  },
  headerTitle: {
    fontSize: 22,
    fontFamily: 'Urbanist-Bold',
    color: '#000',
  },
  profilePicSection: {
    alignItems: 'center',
    marginVertical: 30,
  },
  avatarWrapper: {
    position: 'relative',
  },
  avatar: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: '#F5F5F5',
  },
  editBadge: {
    position: 'absolute',
    bottom: 5,
    right: 5,
    backgroundColor: '#ff4466',
    width: 28,
    height: 28,
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#fff',
  },
  content: {
    paddingHorizontal: 20,
  },
  sectionHeader: {
    fontSize: 20,
    fontFamily: 'Urbanist-Bold',
    color: '#212121',
    marginBottom: 15,
    marginTop: 10,
  },
  itemContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 16,
  },
  itemLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 0.4,
  },
  iconWrapper: {
    width: 30,
    alignItems: 'center',
    marginRight: 12,
  },
  itemLabel: {
    fontSize: 18,
    fontFamily: 'Urbanist-SemiBold',
    color: '#212121',
  },
  itemRight: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 0.6,
    justifyContent: 'flex-end',
  },
  itemValue: {
    fontSize: 18,
    fontFamily: 'Urbanist-SemiBold',
    color: '#212121',
    marginRight: 10,
    textAlign: 'right',
    flex: 1,
  },
  divider: {
    height: 1,
    backgroundColor: '#EEEEEE',
    marginVertical: 15,
  },
});
