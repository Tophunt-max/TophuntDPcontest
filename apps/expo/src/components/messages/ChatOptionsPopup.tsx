import React from 'react';
import { View, Text, StyleSheet, Modal, TouchableOpacity, Pressable, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

interface ChatOptionsPopupProps {
  isVisible: boolean;
  onClose: () => void;
  onBlock: () => void;
  onReport: () => void;
  onViewProfile: () => void;
  isBlocked?: boolean;
}

export const ChatOptionsPopup: React.FC<ChatOptionsPopupProps> = ({ 
  isVisible, 
  onClose, 
  onBlock, 
  onReport, 
  onViewProfile,
  isBlocked 
}) => {
  return (
    <Modal
      visible={isVisible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.popupContainer} onPress={(e) => e.stopPropagation()}>
          <TouchableOpacity style={styles.option} onPress={() => { onViewProfile(); onClose(); }}>
            <Ionicons name="person-outline" size={24} color="#333" />
            <Text style={styles.optionText}>View Profile</Text>
          </TouchableOpacity>
          
          <TouchableOpacity style={styles.option} onPress={() => { onBlock(); onClose(); }}>
            <Ionicons 
                name={isBlocked ? "lock-open-outline" : "ban-outline"} 
                size={24} 
                color={isBlocked ? "#4CAF50" : "#FF4D67"} 
            />
            <Text style={[styles.optionText, { color: isBlocked ? "#4CAF50" : "#FF4D67" }]}>
                {isBlocked ? "Unblock User" : "Block User"}
            </Text>
          </TouchableOpacity>
          
          <TouchableOpacity style={[styles.option, { borderBottomWidth: 0 }]} onPress={() => { onReport(); onClose(); }}>
            <Ionicons name="flag-outline" size={24} color="#FF4D67" />
            <Text style={[styles.optionText, { color: "#FF4D67" }]}>Report User</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.3)',
    justifyContent: 'flex-start',
    alignItems: 'flex-end',
    ...Platform.select({
      web: {
        cursor: 'default',
      }
    })
  },
  popupContainer: {
    backgroundColor: 'white',
    width: 200,
    borderRadius: 15,
    marginTop: Platform.OS === 'ios' ? 100 : 70,
    marginRight: 15,
    padding: 5,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
    elevation: 10,
    zIndex: 999,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 15,
    borderBottomWidth: 1,
    borderBottomColor: '#F5F5F5',
  },
  optionText: {
    fontSize: 16,
    fontFamily: 'Urbanist-Medium',
    marginLeft: 15,
    color: '#333',
  },
});
