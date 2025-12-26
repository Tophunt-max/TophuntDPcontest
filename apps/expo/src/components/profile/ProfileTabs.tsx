import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Colors } from '@/constants/theme';
import { Grid_Icon, Play_Circle, Bookmark_Outline } from '@/assets/svgs';

type ProfileTabsProps = {
  activeTab: 'posts' | 'reels' | 'tags';
  onChangeTab: (tab: 'posts' | 'reels' | 'tags') => void;
  isPrivate: boolean;
};

const ProfileTabs: React.FC<ProfileTabsProps> = ({ activeTab, onChangeTab, isPrivate }) => {
  const tabs = [
    { key: 'posts', icon: Grid_Icon, label: 'Feeds' },
    { key: 'reels', icon: Play_Circle, label: 'Shorts' },
    { key: 'tags', icon: Bookmark_Outline, label: 'Tags' },
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
            onPress={() => onChangeTab(tab.key as 'posts' | 'reels' | 'tags')}
            disabled={isPrivate && tab.key !== 'posts'}
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
