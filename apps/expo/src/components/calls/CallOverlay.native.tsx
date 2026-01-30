import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, Dimensions } from 'react-native';
import { useAuth } from '@/src/hooks/useAuth';
import { 
  endCall, 
  declineCall, 
  respondToCall, 
  sendIceCandidate, 
  updateCallOffer,
  getIceServers
} from '@/src/services/calls/callService';
import { realtimeService, RealtimeMessage } from '@/src/services/messages/realtimeService';
import { Audio } from 'expo-av';

// Native-only WebRTC Imports
import {
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
  RTCView,
  mediaDevices,
  MediaStream,
} from 'react-native-webrtc';

// SVGs
import { 
  Accept_Call, 
  Decline_Call, 
  End_Call,
  Mute_Icon,
  Speaker_Icon,
  User_Placeholder 
} from '@/assets/svgs/message';

const RINGTONE_URL = 'https://assets.mixkit.co/active_storage/sfx/1359/1359-preview.mp3'; 
const DIAL_TONE_URL = 'https://www.soundjay.com/phone/phone-calling-1.mp3';

export default function CallOverlay({ chatId }: { chatId: string }) {
  const { user } = useAuth();
  const [activeCall, setActiveCall] = useState<any>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isSpeakerOn, setIsSpeakerOn] = useState(false);
  const [timer, setTimer] = useState(0);
  
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  
  const pc = useRef<RTCPeerConnection | null>(null);
  const soundRef = useRef<Audio.Sound | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const isHandlingCall = useRef(false);

  const cleanupWebRTC = async () => {
    if (pc.current) { pc.current.close(); pc.current = null; }
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); setLocalStream(null); }
    setRemoteStream(null);
    isHandlingCall.current = false;
    setActiveCall(null);
    setIsVisible(false);
  };

  const playSound = async (type: 'ring' | 'dial') => {
    try {
      if (soundRef.current) await soundRef.current.unloadAsync();
      const { sound } = await Audio.Sound.createAsync(
        { uri: type === 'ring' ? RINGTONE_URL : DIAL_TONE_URL },
        { shouldPlay: true, isLooping: true }
      );
      soundRef.current = sound;
    } catch (e) {}
  };

  const stopSound = async () => {
    if (soundRef.current) { await soundRef.current.stopAsync(); await soundRef.current.unloadAsync(); soundRef.current = null; }
  };

  const setupWebRTC = async (isVideo: boolean, isCaller: boolean) => {
    const iceServers = await getIceServers();
    const peerConnection = new RTCPeerConnection({ iceServers });

    const stream = await mediaDevices.getUserMedia({
        audio: true,
        video: isVideo ? { facingMode: 'user' } : false
    }) as MediaStream;
    
    setLocalStream(stream);
    stream.getTracks().forEach(track => peerConnection.addTrack(track, stream));

    peerConnection.onicecandidate = (e) => {
        if (e.candidate) sendIceCandidate(chatId, e.candidate.toJSON());
    };

    peerConnection.ontrack = (e) => {
        if (e.streams && e.streams[0]) setRemoteStream(e.streams[0]);
    };

    pc.current = peerConnection;

    if (isCaller) {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        updateCallOffer(chatId, offer);
    }
  };

  useEffect(() => {
    if (!chatId || !user) return;

    const unsubscribe = realtimeService.subscribe(async (data: RealtimeMessage) => {
      switch (data.type) {
        case 'call-request':
          if (data.from !== user.uid) {
              setActiveCall({ ...data, status: 'initiating' });
              setIsVisible(true);
              playSound('ring');
          } else {
              // I am the caller
              setActiveCall({ ...data, status: 'initiating' });
              setIsVisible(true);
              playSound('dial');
              setupWebRTC(data.callType === 'video', true);
          }
          break;

        case 'offer':
          if (data.from !== user.uid && pc.current) {
              await pc.current.setRemoteDescription(new RTCSessionDescription(data.offer));
          }
          break;

        case 'answer':
          if (data.from !== user.uid && pc.current) {
              await pc.current.setRemoteDescription(new RTCSessionDescription(data.answer));
              setActiveCall(prev => ({ ...prev, status: 'connected' }));
              stopSound();
          }
          break;

        case 'ice-candidate':
          if (data.from !== user.uid && pc.current) {
              await pc.current.addIceCandidate(new RTCIceCandidate(data.candidate));
          }
          break;

        case 'hangup':
          stopSound();
          cleanupWebRTC();
          break;
      }
    });

    return () => { unsubscribe(); cleanupWebRTC(); stopSound(); };
  }, [chatId, user]);

  const handleAccept = async () => {
      if (!activeCall || !pc.current) {
          // If we haven't setup media yet (receiver side)
          await setupWebRTC(activeCall?.callType === 'video', false);
      }
      
      await pc.current?.setRemoteDescription(new RTCSessionDescription(activeCall.offer));
      const answer = await pc.current?.createAnswer();
      await pc.current?.setLocalDescription(answer);
      
      respondToCall(chatId, answer);
      setActiveCall(prev => ({ ...prev, status: 'connected' }));
      stopSound();
  };

  if (!isVisible) return null;

  const isIncoming = activeCall?.status === 'initiating' && activeCall?.from !== user?.uid;

  return (
    <Modal visible={isVisible} transparent animationType="slide">
      <View style={styles.container}>
        <Text style={styles.status}>{activeCall?.status === 'connected' ? 'Connected' : 'Calling...'}</Text>
        
        {activeCall?.callType === 'video' && remoteStream && (
            <RTCView streamURL={remoteStream.toURL()} style={styles.remoteVideo} objectFit="cover" />
        )}

        <View style={styles.controls}>
          {isIncoming ? (
              <View style={styles.actionRow}>
                  <TouchableOpacity onPress={() => declineCall(chatId)}><Decline_Call width={64} height={64} /></TouchableOpacity>
                  <TouchableOpacity onPress={handleAccept}><Accept_Call width={64} height={64} /></TouchableOpacity>
              </View>
          ) : (
              <TouchableOpacity onPress={() => endCall(chatId)}><End_Call width={64} height={64} /></TouchableOpacity>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#1F222A', alignItems: 'center', justifyContent: 'center' },
  status: { color: 'white', fontSize: 24, marginBottom: 20 },
  controls: { position: 'absolute', bottom: 50, width: '100%', alignItems: 'center' },
  actionRow: { flexDirection: 'row', justifyContent: 'space-around', width: '80%' },
  remoteVideo: { width: '100%', height: '100%', position: 'absolute' }
});
