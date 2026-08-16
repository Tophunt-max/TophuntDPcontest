import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  FlatList,
  Image,
  TouchableOpacity,
  StyleSheet,
  TextInput,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { fetchSuggestedUsers, toggleFollowService } from "@/src/services/users";
import { useSignupStore } from "@/src/store/signup";
import { Ionicons } from "@/src/lib/icons";
import { auth } from "@/src/services/firebase/initFirebase";

export default function FollowSomeone() {
  const [allUsers, setAllUsers] = useState<any[]>([]);
  const [filteredUsers, setFilteredUsers] = useState<any[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  const { data: signup, setMultiple } = useSignupStore();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const loadUsers = async () => {
    try {
      setIsLoading(true);
      setError(null);
      console.log("Loading users with coordinates:", signup.coordinates);
      
      const usersData = await fetchSuggestedUsers(signup.coordinates as any);
      
      // Exclude current user if they are already in the list
      const otherUsers = usersData.filter(u => u.id !== auth.currentUser?.uid);
      
      console.log("Users fetched count:", otherUsers.length);
      setAllUsers(otherUsers);
      setFilteredUsers(otherUsers);
    } catch (err: any) {
      console.error("Failed to fetch users:", err);
      setError("Unable to load users. Please check your internet.");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadUsers();
  }, [signup.coordinates]);

  useEffect(() => {
    if (searchQuery) {
      const lowercasedQuery = searchQuery.toLowerCase();
      const filtered = allUsers.filter(
        (user) =>
          user.name.toLowerCase().includes(lowercasedQuery) ||
          user.username.toLowerCase().includes(lowercasedQuery)
      );
      setFilteredUsers(filtered);
    } else {
      setFilteredUsers(allUsers);
    }
  }, [searchQuery, allUsers]);

  const toggleFollow = async (id: string) => {
    const originalFollowList = [...(signup.following || [])];
    let newFollowList = [...originalFollowList];

    if (newFollowList.includes(id)) {
      newFollowList = newFollowList.filter((x) => x !== id);
    } else {
      newFollowList.push(id);
    }

    setMultiple({ following: newFollowList });

    // For email signups the Firebase account does NOT exist yet (it's created on
    // the final "congratulations" step), so we are unauthenticated here and the
    // toggleFollow API would 401. In that case we only record the selection
    // locally and apply it after sign-in (see congratulations). Social/phone
    // signups authenticate before this step, so we persist immediately.
    if (!auth.currentUser) return;

    try {
      await toggleFollowService(id);
    } catch (error) {
      setMultiple({ following: originalFollowList });
    }
  };

  const handleContinue = () => {
    router.push("/auth/signup/congratulations");
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Follow Someone</Text>
        <TouchableOpacity onPress={() => router.push("/auth/signup/congratulations")} style={styles.skipButton}>
          <Text style={styles.skipButtonText}>Skip</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.searchContainer}>
        <Ionicons name="search" size={20} color="#9E9E9E" style={styles.searchIcon} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search near you"
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholderTextColor="#9E9E9E"
        />
      </View>

      {isLoading ? (
        <View style={styles.center}>
            <ActivityIndicator size="large" color="#ff4466" />
            <Text style={styles.infoText}>Finding people near you...</Text>
        </View>
      ) : error ? (
        <View style={styles.center}>
            <Ionicons name="cloud-offline-outline" size={48} color="#ccc" />
            <Text style={styles.errorText}>{error}</Text>
            <TouchableOpacity onPress={loadUsers} style={styles.retryButton}>
                <Text style={styles.retryText}>Retry</Text>
            </TouchableOpacity>
        </View>
      ) : filteredUsers.length === 0 ? (
        <View style={styles.center}>
            <Ionicons name="people-outline" size={48} color="#ccc" />
            <Text style={styles.infoText}>No users found nearby yet.</Text>
            <TouchableOpacity onPress={loadUsers} style={styles.retryButton}>
                <Text style={styles.retryText}>Refresh</Text>
            </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={filteredUsers}
          keyExtractor={(item) => item.id}
          refreshControl={<RefreshControl refreshing={isLoading} onRefresh={loadUsers} />}
          renderItem={({ item }) => {
            const followed = (signup.following || []).includes(item.id);
            return (
              <View style={styles.userCard}>
                <Image source={{ uri: item.avatar }} style={styles.avatar} />
                <View style={{ flex: 1 }}>
                    <Text style={styles.userName}>{item.name}</Text>
                    <Text style={styles.userHandle}>@{item.username}</Text>
                </View>
                <TouchableOpacity
                  onPress={() => toggleFollow(item.id)}
                  style={[
                    styles.followButton,
                    followed ? styles.followedButton : styles.unfollowedButton,
                  ]}
                >
                  <Text style={followed ? styles.followedButtonText : styles.unfollowedButtonText}>
                    {followed ? "Following" : "Follow"}
                  </Text>
                </TouchableOpacity>
              </View>
            );
          }}
          contentContainerStyle={styles.flatListContent}
        />
      )}

      <View style={styles.bottomButtonsContainer}>
        <TouchableOpacity onPress={handleContinue} style={styles.continueButton}>
          <Text style={styles.continueButtonText}>Continue</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff", paddingHorizontal: 20 },
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 20, marginTop: 20 },
  title: { fontSize: 24, fontFamily: "Urbanist-Bold", color: "#000" },
  skipButton: { paddingHorizontal: 15, paddingVertical: 8, borderRadius: 20, backgroundColor: "#E0E0E0" },
  skipButtonText: { color: "#616161", fontFamily: "Urbanist-SemiBold", fontSize: 14 },
  searchContainer: { flexDirection: "row", alignItems: "center", backgroundColor: "#FAFAFA", borderRadius: 12, paddingHorizontal: 15, marginBottom: 20, height: 50 },
  searchIcon: { marginRight: 10 },
  searchInput: { flex: 1, fontSize: 16, fontFamily: "Urbanist-Medium", color: "#000" },
  center: { flex: 1, justifyContent: "center", alignItems: "center", paddingBottom: 100 },
  infoText: { marginTop: 15, color: "#9E9E9E", fontFamily: "Urbanist-Medium", textAlign: "center" },
  errorText: { marginTop: 15, color: "#ff4466", fontFamily: "Urbanist-Medium", textAlign: "center" },
  retryButton: { marginTop: 20, paddingHorizontal: 25, paddingVertical: 10, borderRadius: 20, borderWidth: 1, borderColor: "#ff4466" },
  retryText: { color: "#ff4466", fontFamily: "Urbanist-Bold" },
  flatListContent: { paddingBottom: 20 },
  userCard: { flexDirection: "row", alignItems: "center", paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: "#F0F0F0" },
  avatar: { width: 50, height: 50, borderRadius: 25, marginRight: 15, backgroundColor: '#f0f0f0' },
  userName: { fontSize: 16, fontFamily: "Urbanist-SemiBold", color: "#000" },
  userHandle: { fontSize: 12, fontFamily: "Urbanist-Regular", color: "#9E9E9E" },
  followButton: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20, minWidth: 90, alignItems: "center" },
  followedButton: { backgroundColor: "#E0E0E0" },
  unfollowedButton: { backgroundColor: "#ff4466" },
  followedButtonText: { color: "#616161", fontFamily: "Urbanist-SemiBold", fontSize: 14 },
  unfollowedButtonText: { color: "#fff", fontFamily: "Urbanist-SemiBold", fontSize: 14 },
  bottomButtonsContainer: { marginTop: "auto", paddingVertical: 15 },
  continueButton: { backgroundColor: "#ff4466", paddingVertical: 18, borderRadius: 30 },
  continueButtonText: { color: "#fff", textAlign: "center", fontSize: 16, fontFamily: "Urbanist-SemiBold" },
});
