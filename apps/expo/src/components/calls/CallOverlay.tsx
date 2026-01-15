import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, Dimensions, Platform } from 'react-native';
import { useAuth } from '@/src/hooks/useAuth';
import { database } from '@/src/services/firebase/initFirebase';
import { ref, onValue } from 'firebase/database';
import { endCall, declineCall, respondToCall } from '@/src/services/calls/callService';
import { Audio } from 'expo-av';
import { CameraView, useCameraPermissions } from 'expo-camera';

// Import Custom SVGs from the message directory
import { 
  Accept_Call, 
  Decline_Call, 
  End_Call,
  Mute_Icon,
  Speaker_Icon,
  User_Placeholder 
} from '@/assets/svgs/message';

const { width, height } = Dimensions.get('window');

const RINGTONE_URL = 'https://assets.mixkit.co/active_storage/sfx/1359/1359-preview.mp3'; 
const DIAL_TONE_URL = 'https://www.soundjay.com/phone/phone-calling-1.mp3';

export default function CallOverlay({ chatId }: { chatId: string }) {
  const { user } = useAuth();
  const [activeCall, setActiveCall] = useState<any>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [isMuted, setIsMuted] = useState(false);
  const [isSpeakerOn, setIsSpeakerOn] = useState(false);
  const [timer, setTimer] = useState(0);
  const soundRef = useRef<Audio.Sound | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const formatTime = (secs: number) => {
    const mins = Math.floor(secs / 60);
    const s = secs % 60;
    return `${mins < 10 ? '0' : ''}${mins}:${s < 10 ? '0' : ''}${s}`;
  };

  const setupAudioMode = async (speaker: boolean) => {
      try {
          await Audio.setAudioModeAsync({
              allowsRecordingIOS: true,
              playsInSilentModeIOS: true,
              staysActiveInBackground: true,
              playThroughEarpieceAndroid: !speaker,
          });
      } catch (e) {}
  };

  const playSound = async (type: 'ring' | 'dial') => {
    try {
      await setupAudioMode(false);
      if (soundRef.current) await soundRef.current.unloadAsync();
      const { sound } = await Audio.Sound.createAsync(
        { uri: type === 'ring' ? RINGTONE_URL : DIAL_TONE_URL },
        { shouldPlay: true, isLooping: true, volume: 1.0 }
      );
      soundRef.current = sound;
      await sound.playAsync();
    } catch (error) {}
  };

  const stopSound = async () => {
    try {
      if (soundRef.current) {
        await soundRef.current.stopAsync();
        await soundRef.current.unloadAsync();
        soundRef.current = null;
      }
    } catch (error) {}
  };

  const toggleSpeaker = async () => {
      const newState = !isSpeakerOn;
      setIsSpeakerOn(newState);
      await setupAudioMode(newState);
  };

  useEffect(() => {
    if (!chatId || !user) return;
    
    const callRef = ref(database, `calls/${chatId}`);
    const unsubscribe = onValue(callRef, (snapshot) => {
      const data = snapshot.val();
      
      if (data && data.status !== 'ended' && data.status !== 'declined') {
        setActiveCall(data);
        setIsVisible(true);
        
        if (data.type === 'video' && !permission?.granted) {
            requestPermission();
        }

        if (data.status === 'initiating') {
            const isIncoming = data.receiverId === user.uid;
            playSound(isIncoming ? 'ring' : 'dial');
        } else if (data.status === 'connected') {
            stopSound();
            if (data.type === 'video' && !isSpeakerOn) toggleSpeaker();
            
            // Start Timer if not already started
            if (!timerRef.current) {
                timerRef.current = setInterval(() => {
                    setTimer(prev => prev + 1);
                }, 1000);
            }
        }
      } else {
        setIsVisible(false);
        stopSound();
        if (timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
        }
        setTimer(0);
        setIsMuted(false);
        setIsSpeakerOn(false);
      }
    });

    return () => { 
        unsubscribe(); 
        stopSound();
        if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [chatId, user, permission]);

  if (!isVisible || !activeCall) return null;

  const isIncoming = activeCall.receiverId === user?.uid && activeCall.status === 'initiating';
  const isVideo = activeCall.type === 'video';
  const isConnected = activeCall.status === 'connected';

  return (
    <Modal visible={isVisible} transparent animationType="fade">
      <View style={[styles.container, isVideo && styles.videoBg]}>
        
        {/* VIDEO CALL UI */}
        {isVideo && permission?.granted && (
            <CameraView style={StyleSheet.absoluteFill} facing="front" />
        )}

        <View style={[StyleSheet.absoluteFill, isVideo && { backgroundColor: 'rgba(0,0,0,0.4)' }]}>
            <View style={styles.header}>
               <Text style={styles.callType}>{isVideo ? 'VIDEO' : 'AUDIO'} CALL</Text>
               <Text style={styles.status}>
                    {isConnected ? formatTime(timer) : (isIncoming ? 'Incoming...' : 'Ringing...')}
               </Text>
            </View>

            <View style={styles.userContainer}>
                {!isVideo && (
                    <View style={styles.avatarPlaceholder}>
                        <User_Placeholder width={100} height={100} />
                    </View>
                )}
                <Text style={styles.username}>
                    {isIncoming ? (activeCall.callerName || 'Friend') : 'Calling...'}
                </Text>
            </View>

            <View style={styles.controls}>
              {/* Extra Controls */}
              {isConnected && (
                  <View style={styles.extraControls}>
                      <TouchableOpacity style={[styles.roundBtn, isMuted && styles.activeBtn]} onPress={() => setIsMuted(!isMuted)}>
                          <Mute_Icon width={32} height={32} />
                          <Text style={styles.btnLabel}>{isMuted ? "Unmute" : "Mute"}</Text>
                      </TouchableOpacity>

                      <TouchableOpacity style={[styles.roundBtn, isSpeakerOn && styles.activeBtn]} onPress={toggleSpeaker}>
                          <Speaker_Icon width={32} height={32} />
                          <Text style={styles.btnLabel}>Speaker</Text>
                      </TouchableOpacity>
                  </View>
              )}

              {isIncoming ? (
                <View style={styles.actionRow}>
                  <TouchableOpacity style={styles.btnAction} onPress={() => declineCall(chatId)}>
                    <Decline_Call width={64} height={64} />
                  </TouchableOpacity>
                  
                  <TouchableOpacity style={styles.btnAction} onPress={() => respondToCall(chatId, { sdp: 'fake' })}>
                    <Accept_Call width={64} height={64} />
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity style={styles.btnAction} onPress={() => endCall(chatId)}>
                    <End_Call width={64} height={64} />
                </TouchableOpacity>
              )}
            </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1F222A', paddingVertical: 80, justifyContent: 'space-between' },
  videoBg: { backgroundColor: 'black' },
  header: { alignItems: 'center', marginTop: 20 },
  callType: { color: '#FF4D67', fontSize: 13, fontWeight: '800', letterSpacing: 2, fontFamily: 'Urbanist-Bold' },
  status: { color: 'white', fontSize: 20, marginTop: 8, fontFamily: 'Urbanist-Bold' }, // Made timer bold
  userContainer: { alignItems: 'center', flex: 1, justifyContent: 'center' },
  avatarPlaceholder: { width: 140, height: 140, borderRadius: 70, backgroundColor: '#35383F', justifyContent: 'center', alignItems: 'center', marginBottom: 20 },
  username: { color: 'white', fontSize: 28, fontWeight: '700', fontFamily: 'Urbanist-Bold', textShadowColor: 'rgba(0,0,0,0.5)', textShadowOffset: {width: 0, height: 2}, textShadowRadius: 4 },
  controls: { width: '100%', paddingHorizontal: 40, paddingBottom: 40, alignItems: 'center' },
  actionRow: { flexDirection: 'row', justifyContent: 'space-between', width: '100%' },
  btnAction: { width: 64, height: 64, borderRadius: 32, justifyContent: 'center', alignItems: 'center' },
  extraControls: { flexDirection: 'row', justifyContent: 'space-around', width: '100%', marginBottom: 40 },
  roundBtn: { width: 60, height: 60, borderRadius: 30, backgroundColor: 'rgba(255,255,255,0.15)', justifyContent: 'center', alignItems: 'center' },
  activeBtn: { backgroundColor: '#FF4D67' },
  btnLabel: { color: 'white', fontSize: 11, marginTop: 4, fontFamily: 'Urbanist-Medium' }
});
