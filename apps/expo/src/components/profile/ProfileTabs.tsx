import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Colors } from '@/constants/theme';
import { Grid_Icon, Play_Circle, Bookmark_Outline } from '@/assets/svgs';

export type ProfileTab = 'photo' | 'video' | 'tags';

type ProfileTabsProps = {
  activeTab: ProfileTab;
  onChangeTab: (tab: ProfileTab) => void;
  isPrivate: boolean;
  /**
   * Show the "Saved" tab. Bookmarks are private to their owner, so this must
   * only be true on your own profile — the server now rejects
   * `/read/users/:id/bookmarks` for anyone else, and rendering the tab on other
   * people's profiles would just show a permanently empty list.
   */
  showSaved: boolean;
};

const ProfileTabs: React.FC<ProfileTabsProps> = ({
  activeTab,
  onChangeTab,
  isPrivate,
  showSaved,
}) => {
  const tabs: { key: ProfileTab; icon: any; label: string }[] = [
    { key: 'photo', icon: Grid_Icon, label: 'Photo' },
    { key: 'video', icon: Play_Circle, label: 'Video' },
    ...(showSaved
      ? [{ key: 'tags' as ProfileTab, icon: Bookmark_Outline, label: 'Saved' }]
      : []),
  ];

  return (
    <View style={styles.container}>
      {tabs.map(tab => {
        const Icon = tab.icon;
        const isActive = activeTab === tab.key;
        const color = isActive ? Colors.light.primary : 'gray';

        return (
          <TouchableOpacity
            key={tab.key}
            style={[styles.tab, isActive && styles.activeTab]}
            onPress={() => onChangeTab(tab.key)}
            disabled={isPrivate && tab.key !== 'photo'}
          >
            <Icon 
              width={24} 
              height={24} 
              fill={color}
            />
            <Text style={[styles.tabLabel, { color }]}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: '#eee',
    backgroundColor: '#fff',
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 12,
  },
  activeTab: {
    borderBottomWidth: 2,
    borderBottomColor: Colors.light.primary,
  },
  tabLabel: {
    marginTop: 4,
    fontSize: 12,
  },
});

export default ProfileTabs;
