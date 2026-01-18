import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Platform, useColorScheme } from 'react-native';
import { useRouter } from 'expo-router';
import { Colors } from '@/constants/theme';
import { 
  Left_Arrow, 
  Add_Icon, 
  Menu_Light, 
  Menu_Dark 
} from '@/assets/svgs';

interface MessagesHeaderProps {
  title: string;
  onAddPress?: () => void;
  onMenuPress?: () => void;
}

export const MessagesHeader: React.FC<MessagesHeaderProps> = ({ title, onAddPress, onMenuPress }) => {
  const router = useRouter();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const textColor = isDark ? Colors.dark.text : Colors.light.text;

  return (
    <View style={styles.topNav}>
      <View style={styles.leftHeader}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
          <Left_Arrow width={28} height={28} color={textColor} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: textColor }]}>{title}</Text>
      </View>
      <View style={styles.rightIcons}>
        <TouchableOpacity style={styles.navButton} onPress={onAddPress}>
          <Add_Icon width={24} height={24} color={textColor} />
        </TouchableOpacity>
        <TouchableOpacity style={styles.navButton} onPress={onMenuPress}>
          {isDark ? <Menu_Dark width={24} height={24} /> : <Menu_Light width={24} height={24} />}
        </TouchableOpacity>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  topNav: { 
    flexDirection: 'row', 
    alignItems: 'center', 
    paddingHorizontal: 20, 
    paddingTop: Platform.OS === 'ios' ? 60 : 45, 
    paddingBottom: 15, 
    justifyContent: 'space-between' 
  },
  leftHeader: { flexDirection: 'row', alignItems: 'center' },
  backButton: { marginRight: 12 },
  headerTitle: { fontSize: 26, fontWeight: '700' },
  rightIcons: { flexDirection: 'row', alignItems: 'center' },
  navButton: { marginLeft: 22 },
});
