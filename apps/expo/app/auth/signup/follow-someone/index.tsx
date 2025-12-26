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
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { fetchSuggestedUsers, toggleFollowService } from "@/src/services/users";
import { useSignupStore } from "@/src/store/signup";
import { Ionicons } from "@expo/vector-icons";

export default function FollowSomeone() {
  const [allUsers, setAllUsers] = useState([]);
  const [filteredUsers, setFilteredUsers] = useState([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const { data: signup, setMultiple } = useSignupStore();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  useEffect(() => {
    const loadUsers = async () => {
      try {
        setIsLoading(true);
        const usersData = await fetchSuggestedUsers();
        setAllUsers(usersData);
        setFilteredUsers(usersData);
      } catch (error) {
        console.error("Failed to fetch users", error);
        // Optionally show an error message to the user
      } finally {
        setIsLoading(false);
      }
    };
    loadUsers();
  }, []);

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
    
    // Optimistic UI update
    setMultiple({ following: newFollowList });

    try {
      // Call the backend service
      await toggleFollowService(id);
    } catch (error) {
      console.error("Failed to update follow status:", error);
      // Revert the UI if the backend call fails
      setMultiple({ following: originalFollowList });
      // Optionally, show a toast or alert to the user
    }
  };

  const handleContinue = () => {
    router.push("/auth/signup/congratulations");
  };

  const handleSkip = () => {
    setMultiple({ following: [] });
    router.push("/auth/signup/congratulations");
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.header}>
        <Text style={styles.title}>Follow Someone</Text>
        <TouchableOpacity onPress={handleSkip} style={styles.skipButton}>
          <Text style={styles.skipButtonText}>Skip</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.searchContainer}>
        <Ionicons name="search" size={20} color="#9E9E9E" style={styles.searchIcon} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search users"
          value={searchQuery}
          onChangeText={setSearchQuery}
          placeholderTextColor="#9E9E9E"
        />
      </View>

      {isLoading ? (
        <ActivityIndicator size="large" color="#ff4466" style={styles.loadingIndicator} />
      ) : (
        <FlatList
          data={filteredUsers}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => {
            const followed = (signup.following || []).includes(item.id);
            return (
              <View style={styles.userCard}>
                <Image source={{ uri: item.avatar }} style={styles.avatar} />
                <Text style={styles.userName}>{item.name}</Text>
                <TouchableOpacity
                  onPress={() => toggleFollow(item.id)}
                  style={[
                    styles.followButton,
                    followed ? styles.followedButton : styles.unfollowedButton,
                  ]}
                >
                  <Text
                    style={followed ? styles.followedButtonText : styles.unfollowedButtonText}
                  >
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
  container: {
    flex: 1,
    backgroundColor: "#fff",
    paddingHorizontal: 20,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 20,
    marginTop: 20,
  },
  title: {
    fontSize: 24,
    fontFamily: "Urbanist-Bold",
    color: "#000",
  },
  skipButton: {
    paddingHorizontal: 15,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: "#E0E0E0",
  },
  skipButtonText: {
    color: "#616161",
    fontFamily: "Urbanist-SemiBold",
    fontSize: 14,
  },
  searchContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#FAFAFA",
    borderRadius: 12,
    paddingHorizontal: 15,
    marginBottom: 20,
    height: 50,
  },
  searchIcon: {
    marginRight: 10,
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
    fontFamily: "Urbanist-Medium",
    color: "#000",
  },
  loadingIndicator: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  flatListContent: {
    paddingBottom: 20, // Add some padding at the bottom of the list
  },
  userCard: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#F0F0F0",
  },
  avatar: {
    width: 50,
    height: 50,
    borderRadius: 25,
    marginRight: 15,
  },
  userName: {
    flex: 1,
    fontSize: 16,
    fontFamily: "Urbanist-SemiBold",
    color: "#000",
  },
  followButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    minWidth: 90,
    alignItems: "center",
  },
  followedButton: {
    backgroundColor: "#E0E0E0",
  },
  unfollowedButton: {
    backgroundColor: "#ff4466",
  },
  followedButtonText: {
    color: "#616161",
    fontFamily: "Urbanist-SemiBold",
    fontSize: 14,
  },
  unfollowedButtonText: {
    color: "#fff",
    fontFamily: "Urbanist-SemiBold",
    fontSize: 14,
  },
  bottomButtonsContainer: {
    marginTop: "auto", // Pushes the container to the bottom
    paddingVertical: 10,
  },
  continueButton: {
    backgroundColor: "#ff4466",
    paddingVertical: 15,
    borderRadius: 30,
    shadowColor: "#ff4466",
    shadowOffset: {
      width: 0,
      height: 4,
    },
    shadowOpacity: 0.3,
    shadowRadius: 4.65,
    elevation: 8,
  },
  continueButtonText: {
    color: "#fff",
    textAlign: "center",
    fontSize: 16,
    fontFamily: "Urbanist-SemiBold",
  },
});