import React, { memo } from "react";
import {
  View,
  StyleSheet,
  Pressable,
  useColorScheme
} from "react-native";
import { 
    App_Logo, 
    HeartIcon_Light, HeartIcon_Dark,
    ChatIcon_Light, ChatIcon_Dark 
} from '@/assets/svgs';
import { useRouter } from 'expo-router';

const HeaderComponent = () => {
  const router = useRouter();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';

  const HeartIcon = isDark ? HeartIcon_Dark : HeartIcon_Light;
  const ChatIcon = isDark ? ChatIcon_Dark : ChatIcon_Light;

  return (
    <View
      style={[
        styles.container,
        { 
            backgroundColor: isDark ? '#181A20' : '#fff',
            borderBottomColor: isDark ? '#35383F' : '#eaeaea',
            borderBottomWidth: StyleSheet.hairlineWidth,
        },
      ]}
    >
      {/* LEFT */}
      <View style={styles.left}>
        <App_Logo width={115} height={32} />
      </View>

      {/* RIGHT */}
      <View style={styles.right}>
        <Pressable 
            hitSlop={10} 
            style={styles.iconBtn}
            onPress={() => router.push('/notifications')}
        >
          <HeartIcon width={24} height={24} />
        </Pressable>

        <Pressable 
            hitSlop={10} 
            style={styles.iconBtn}
            onPress={() => router.push('/messages')}
        >
          <ChatIcon width={24} height={24} />
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
});
