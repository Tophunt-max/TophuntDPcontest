import React, { memo, useState, useEffect } from "react";
import {
  View,
  StyleSheet,
  Pressable,
  useColorScheme,
} from "react-native";
import { Image } from "expo-image";
import { 
    ChatIcon_Light, ChatIcon_Dark 
} from '@/assets/svgs';
import { useRouter } from 'expo-router';
import { Colors } from '@/constants/theme';
import { useAppConfig } from "@/src/services/appSettings";
import images from "@/assets/images";
import { HeartNotificationIcon } from "../notifications/HeartNotificationIcon";
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { firestore, auth } from '@/src/services/firebase/initFirebase';

const HeaderComponent = () => {
  const router = useRouter();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const { config } = useAppConfig();
  const [hasUnreadMessages, setHasUnreadMessages] = useState(false);

  const currentUser = auth.currentUser;
  const ChatIcon = isDark ? ChatIcon_Dark : ChatIcon_Light;

  // Real-time listener for Unread Messages
  useEffect(() => {
    if (!currentUser) return;

    const chatsRef = collection(firestore, 'chats');
    const q = query(
        chatsRef, 
        where('participants', 'array-contains', currentUser.uid)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
        let unread = false;
        snapshot.docs.forEach(doc => {
            const data = doc.data();
            const count = data.unreadCount?.[currentUser.uid] || 0;
            if (count > 0) unread = true;
        });
        setHasUnreadMessages(unread);
    }, (error) => {
        console.error("Unread Badge Error:", error);
    });

    return () => unsubscribe();
  }, [currentUser]);

  return (
    <View
      style={[
        styles.container,
        { 
            backgroundColor: isDark ? Colors.dark.background : Colors.light.background,
            borderBottomColor: isDark ? '#35383F' : '#eaeaea',
            borderBottomWidth: StyleSheet.hairlineWidth,
        },
      ]}
    >
      {/* LEFT */}
      <View style={styles.left}>
        <Image 
          source={config?.headerLogoUrl ? { uri: config.headerLogoUrl } : images.tophuntLogo} 
          style={{ width: 115, height: 32 }} 
          contentFit="contain"
          cachePolicy="disk"
        />
      </View>

      {/* RIGHT */}
      <View style={styles.right}>
        <View style={styles.iconBtn}>
           <HeartNotificationIcon />
        </View>

        <Pressable 
            hitSlop={10} 
            style={styles.iconBtn}
            onPress={() => router.push('/messages')}
        >
          <View>
            <ChatIcon width={24} height={24} />
            {hasUnreadMessages && (
                <View style={styles.redDot} />
            )}
          </View>
        </Pressable>
      </View>
    </View>
  );
};

export const Header = memo(HeaderComponent);

const styles = StyleSheet.create({
  container: {
    width: "100%",
    paddingLeft: 10,
    paddingRight: 16,
    height: 54,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  left: { 
      flexDirection: "row", 
      alignItems: "center",
      justifyContent: 'flex-start',
      flex: 1, 
  },
  right: { 
      flexDirection: "row",
      alignItems: 'center' 
  },
  iconBtn: { 
      marginLeft: 20 
  },
  redDot: {
      position: 'absolute',
      right: -2,
      top: -2,
      width: 10,
      height: 10,
      borderRadius: 5,
      backgroundColor: '#FF4D67',
      borderWidth: 1.5,
      borderColor: 'white'
  }
});
