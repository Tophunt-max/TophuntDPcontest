import React, { useState, memo, useCallback } from 'react';
import { View, StyleSheet, TouchableOpacity, TextInput, Platform, useColorScheme } from 'react-native';
import { InputToolbar, InputToolbarProps, IMessage, Composer, Send, ComposerProps } from 'react-native-gifted-chat';
import { Emoji_Icon, Gallery_Icon, Microphone_Icon, Send_Icon } from '@/assets/svgs/message';
import RecordingWaveform from '@/src/components/messages/RecordingWaveform';
import { Colors } from '@/constants/theme';

interface ChatInputProps extends InputToolbarProps<IMessage> {
  isRecording: boolean;
  meteringData: number[];
  onEmojiPress: () => void;
  onGalleryPress: () => void;
  onMicPressIn: () => void;
  onMicPressOut: () => void;
  chatId: string;
  setTypingStatus: (chatId: string, isTyping: boolean) => void;
}

const ChatInputComponent: React.FC<ChatInputProps> = (props) => {
  const { 
    isRecording, 
    meteringData, 
    onEmojiPress, 
    onGalleryPress, 
    onMicPressIn, 
    onMicPressOut,
    chatId,
    setTypingStatus,
    text = '',
    onTextChanged,
    onSend
  } = props;

  const [isFocused, setIsFocused] = useState(false);
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  
  const themeBackgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const textColor = isDark ? Colors.dark.text : Colors.light.text;
  
  const focusedBorderColor = '#FF4D67';
  const defaultBorderColor = isDark ? '#35383F' : '#eee';
  const focusedBackgroundColor = isDark ? '#2D1F22' : '#FFEBEE';
  const backgroundColor = isFocused ? focusedBackgroundColor : themeBackgroundColor;
  const borderColor = isFocused ? focusedBorderColor : defaultBorderColor;

  // STABLE RENDER FUNCTIONS
  const renderComposer = useCallback(() => {
    return (
      <View style={[styles.composerWrapper, { backgroundColor, borderColor, borderWidth: 1 }]}>
        <TouchableOpacity style={styles.actionButton} onPress={onEmojiPress}>
          <Emoji_Icon width={24} height={24} color={isFocused ? '#FF4D67' : textColor} />
        </TouchableOpacity>
        
        <View style={styles.inputContainer}>
          {isRecording ? (
            <RecordingWaveform meteringData={meteringData} />
          ) : (
            <TextInput 
              style={[
                styles.textInput, 
                { color: textColor },
                Platform.OS === 'web' && ({ outlineStyle: 'none' } as any)
              ]} 
              placeholder="Message..." 
              placeholderTextColor="#9E9E9E" 
              value={text} 
              onChangeText={(t) => {
                onTextChanged?.(t);
                setTypingStatus(chatId, t.length > 0);
              }} 
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              multiline 
              blurOnSubmit={false}
            />
          )}
        </View>

        {!isRecording && (
          <TouchableOpacity style={styles.actionButton} onPress={onGalleryPress}>
            <Gallery_Icon width={24} height={24} color={isFocused ? '#FF4D67' : textColor} />
          </TouchableOpacity>
        )}
      </View>
    );
  }, [backgroundColor, borderColor, isFocused, isRecording, meteringData, onEmojiPress, onGalleryPress, onTextChanged, text, textColor, chatId, setTypingStatus]);

  const renderSend = useCallback(() => {
    const hasText = text.trim().length > 0;
    return (
      <TouchableOpacity 
        onPressIn={hasText ? undefined : onMicPressIn} 
        onPressOut={hasText ? undefined : onMicPressOut} 
        onPress={() => {
          if (hasText && onSend) {
            onSend({ text: text.trim() } as any, true);
          }
        }} 
        style={[styles.micButton, isRecording && styles.micActive]}
      >
          {hasText ? (
            <Send_Icon width={24} height={24} />
          ) : (
            isRecording ? <View style={styles.stopIcon} /> : <Microphone_Icon width={24} height={24} />
          )}
      </TouchableOpacity>
    );
  }, [text, onMicPressIn, onMicPressOut, onSend, isRecording]);

  return (
    <InputToolbar 
      {...props} 
      containerStyle={[
        styles.inputToolbar, 
        { backgroundColor: isDark ? Colors.dark.background : '#fff' }
      ]} 
      renderComposer={renderComposer}
      renderSend={renderSend}
    />
  );
};

export const ChatInput = memo(ChatInputComponent);

const styles = StyleSheet.create({
  inputToolbar: { 
    borderTopWidth: 1, 
    borderTopColor: '#f0f0f0', 
    paddingHorizontal: 10, 
    paddingVertical: 5, 
    height: 75, 
    justifyContent: 'center',
    ...Platform.select({
        web: {
            position: 'relative',
        }
    })
  },
  composerWrapper: { 
    flex: 1, 
    flexDirection: 'row', 
    borderRadius: 12, 
    paddingHorizontal: 10, 
    alignItems: 'center', 
    marginRight: 10, 
    height: 56,
  },
  inputContainer: { flex: 1, height: '100%', justifyContent: 'center' },
  textInput: { 
    fontFamily: 'Urbanist-Medium', 
    fontSize: 16, 
    paddingHorizontal: 5,
    height: '100%',
    ...Platform.select({
        web: {
            outlineStyle: 'none',
        }
    })
  },
  actionButton: { padding: 5 },
  micButton: { 
    backgroundColor: '#FF4D67', 
    width: 52, 
    height: 52, 
    borderRadius: 26, 
    justifyContent: 'center', 
    alignItems: 'center', 
    elevation: 3 
  },
  micActive: { backgroundColor: '#F75555' },
  stopIcon: { width: 14, height: 14, backgroundColor: 'white', borderRadius: 2 },
});
