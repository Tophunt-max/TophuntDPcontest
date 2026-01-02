import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, ScrollView } from 'react-native';
import { useThemeColor } from '@/hooks/use-theme-color';
import CloseCircleIcon from '@/assets/svgs/close_circle.svg'; // Import the SVG icon

const BRAND_PRIMARY = '#FF4D67'; 

interface RulesModalProps {
  isVisible: boolean;
  onClose: () => void;
  rules: string;
  title?: string;
}

export const RulesModal = ({ isVisible, onClose, rules, title = "Contest Rules" }: RulesModalProps) => {
  const cardBg = useThemeColor({ light: '#FFFFFF', dark: '#1F222A' }, 'background');
  const textColor = useThemeColor({}, 'text');

  return (
    <Modal
      animationType="slide"
      transparent={true}
      visible={isVisible}
      onRequestClose={onClose}
    >
      <View style={styles.centeredView}>
        <View style={[styles.modalView, { backgroundColor: cardBg }]}>
          <View style={styles.modalHeader}>
            <Text style={[styles.modalTitle, { color: textColor }]}>{title}</Text>
            <TouchableOpacity onPress={onClose} style={styles.closeButton}>
              <CloseCircleIcon width={24} height={24} fill={BRAND_PRIMARY} /> 
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.rulesContainer}>
            <Text style={[styles.rulesText, { color: textColor }]}>{rules}</Text>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  centeredView: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  modalView: {
    margin: 20,
    borderRadius: 20,
    padding: 25, // Increased padding to give more space
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.25,
    shadowRadius: 4,
    elevation: 5,
    width: '90%',
    maxHeight: '70%',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%',
    marginBottom: 15,
    position: 'relative', // Needed for absolute positioning of children
    paddingRight: 30, // Add padding to prevent title overlap with icon
  },
  modalTitle: {
    fontSize: 20,
    fontFamily: 'Urbanist-Bold',
    flexShrink: 1, // Allow title to shrink if too long
  },
  closeButton: {
    position: 'absolute',
    right: 0,
    top: -5, // Adjust as needed for vertical alignment
    padding: 5, // Keep padding for touchable area
  },
  rulesContainer: {
    width: '100%',
  },
  rulesText: {
    fontSize: 14,
    fontFamily: 'Urbanist-Regular',
    lineHeight: 20,
  },
});
