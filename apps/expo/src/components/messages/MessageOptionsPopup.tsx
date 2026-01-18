import React from 'react';
import { View, Text, StyleSheet, Modal, TouchableOpacity, Pressable, Platform, useWindowDimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

interface MessageOptionsPopupProps {
  isVisible: boolean;
  onClose: () => void;
  onDelete: () => void;
  onCopy: () => void;
  onReply?: () => void;
  isMyMessage: boolean;
}

export const MessageOptionsPopup: React.FC<MessageOptionsPopupProps> = ({ 
  isVisible, 
  onClose, 
  onDelete, 
  onCopy, 
  onReply,
  isMyMessage 
}) => {
  const { width: screenWidth } = useWindowDimensions();
  
  const isLargeScreen = Platform.OS === 'web' && screenWidth > 600;
  const popupWidth = isLargeScreen ? 400 : '100%';

  return (
    <Modal
      visible={isVisible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable 
          style={[
            styles.popupContainer, 
            { width: popupWidth }
          ]} 
          onPress={(e) => e.stopPropagation()}
        >
          <View style={styles.dragHandle} />
          <Text style={styles.title}>Message Options</Text>
          
          <TouchableOpacity style={styles.option} onPress={() => { onCopy(); onClose(); }}>
            <View style={[styles.iconContainer, { backgroundColor: '#F0F0F0' }]}>
              <Ionicons name="copy-outline" size={22} color="#333" />
            </View>
            <Text style={styles.optionText}>Copy Text</Text>
          </TouchableOpacity>

          {onReply && (
            <TouchableOpacity style={styles.option} onPress={() => { onReply(); onClose(); }}>
              <View style={[styles.iconContainer, { backgroundColor: '#F0F0F0' }]}>
                <Ionicons name="arrow-undo-outline" size={22} color="#333" />
              </View>
              <Text style={styles.optionText}>Reply</Text>
            </TouchableOpacity>
          )}
          
          {isMyMessage && (
            <TouchableOpacity style={[styles.option, { borderBottomWidth: 0 }]} onPress={() => { onDelete(); onClose(); }}>
              <View style={[styles.iconContainer, { backgroundColor: '#FFEBEE' }]}>
                <Ionicons name="trash-outline" size={22} color="#FF4D67" />
              </View>
              <Text style={[styles.optionText, { color: "#FF4D67" }]}>Unsend Message</Text>
            </TouchableOpacity>
          )}
          
          <TouchableOpacity style={styles.cancelButton} onPress={onClose}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  );
};

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
    ...Platform.select({
      web: {
        cursor: 'default',
      }
    })
  },
  popupContainer: {
    backgroundColor: 'white',
    borderTopLeftRadius: 25,
    borderTopRightRadius: 25,
    paddingBottom: Platform.OS === 'ios' ? 40 : 20,
    paddingHorizontal: 20,
    alignSelf: 'center',
  },
  dragHandle: {
    width: 40,
    height: 5,
    backgroundColor: '#E0E0E0',
    borderRadius: 2.5,
    alignSelf: 'center',
    marginTop: 10,
    marginBottom: 15,
  },
  title: {
    fontSize: 18,
    fontFamily: 'Urbanist-Bold',
    color: '#333',
    textAlign: 'center',
    marginBottom: 20,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F5F5F5',
  },
  iconContainer: {
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
  },
  optionText: {
    fontSize: 16,
    fontFamily: 'Urbanist-SemiBold',
    marginLeft: 15,
    color: '#333',
  },
  cancelButton: {
    marginTop: 15,
    backgroundColor: '#F5F5F5',
    paddingVertical: 15,
    borderRadius: 15,
    alignItems: 'center',
    marginBottom: 10,
  },
  cancelText: {
    fontSize: 16,
    fontFamily: 'Urbanist-Bold',
    color: '#333',
  },
});
