import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal, Dimensions } from 'react-native';
import { useAuth } from '@/src/hooks/useAuth';
import { database } from '@/src/services/firebase/initFirebase';
import { ref, onValue } from 'firebase/database';
import { 
  endCall, 
  declineCall, 
  respondToCall, 
  sendIceCandidate, 
  listenForIceCandidates,
  updateCallOffer 
} from '@/src/services/calls/callService';

// Import Custom SVGs from the message directory
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

const configuration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
};

export default function CallOverlay({ chatId }: { chatId: string }) {
  const { user } = useAuth();
  const [activeCall, setActiveCall] = useState<any>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [timer, setTimer] = useState(0);
  
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  
  const pc = useRef<RTCPeerConnection | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const isHandlingCall = useRef(false);
  const iceCandidatesQueue = useRef<any[]>([]);

  // Web Video Elements
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);

  const formatTime = (secs: number) => {
    const mins = Math.floor(secs / 60);
    const s = secs % 60;
    return `${mins < 10 ? '0' : ''}${mins}:${s < 10 ? '0' : ''}${s}`;
  };

  const playSound = (type: 'ring' | 'dial') => {
    if (audioRef.current) {
        audioRef.current.pause();
    }
    const audio = new Audio(type === 'ring' ? RINGTONE_URL : DIAL_TONE_URL);
    audio.loop = true;
    audio.play().catch(e => console.warn("Autoplay prevented:", e));
    audioRef.current = audio;
  };

  const stopSound = () => {
    if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
    }
  };

  const cleanupWebRTC = () => {
    console.log("[WebRTC Web] Cleaning up...");
    if (pc.current) {
        pc.current.close();
        pc.current = null;
    }
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        setLocalStream(null);
    }
    setRemoteStream(null);
    isHandlingCall.current = false;
    iceCandidatesQueue.current = [];
  };

  const setupMedia = async (isVideo: boolean) => {
    try {
        console.log("[WebRTC Web] Setting up media. Video:", isVideo);
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: isVideo
        });
        setLocalStream(stream);
        if (localVideoRef.current) {
            localVideoRef.current.srcObject = stream;
        }
        return stream;
    } catch (e) {
        console.error("[WebRTC Web] Failed to get user media:", e);
        return null;
    }
  };

  const createPeerConnection = (chatId: string) => {
    console.log("[WebRTC Web] Creating RTCPeerConnection");
    const peerConnection = new RTCPeerConnection(configuration);

    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            sendIceCandidate(chatId, event.candidate.toJSON());
        }
    };

    peerConnection.ontrack = (event) => {
        console.log("[WebRTC Web] Received remote track");
        if (event.streams && event.streams[0]) {
            setRemoteStream(event.streams[0]);
            if (remoteVideoRef.current) {
                remoteVideoRef.current.srcObject = event.streams[0];
            }
        }
    };

    pc.current = peerConnection;
    return peerConnection;
  };

  const startCallHandling = async (callData: any) => {
      if (isHandlingCall.current) return;
      isHandlingCall.current = true;

      const isCaller = callData.callerId === user?.uid;
      const peerConnection = createPeerConnection(chatId);
      const stream = await setupMedia(callData.type === 'video');

      if (stream) {
          stream.getTracks().forEach(track => {
              peerConnection.addTrack(track, stream);
          });
      }

      if (isCaller) {
          const offer = await peerConnection.createOffer();
          await peerConnection.setLocalDescription(offer);
          await updateCallOffer(chatId, offer);
      }

      const otherUserId = isCaller ? callData.receiverId : callData.callerId;
      const unsubIce = listenForIceCandidates(chatId, otherUserId, (candidate) => {
          if (candidate) {
              if (peerConnection.remoteDescription) {
                peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
                    .catch(e => console.error("[WebRTC Web] Error adding ICE candidate", e));
              } else {
                iceCandidatesQueue.current.push(candidate);
              }
          }
      });

      return unsubIce;
  };

  const processQueuedCandidates = () => {
      if (pc.current && pc.current.remoteDescription) {
          while (iceCandidatesQueue.current.length > 0) {
              const candidate = iceCandidatesQueue.current.shift();
              pc.current.addIceCandidate(new RTCIceCandidate(candidate))
                .catch(e => console.error("[WebRTC Web] Error adding queued ICE candidate", e));
          }
      }
  };

  const handleAnswer = async (callData: any) => {
      if (!pc.current || !callData.answer || pc.current.remoteDescription) return;
      try {
          await pc.current.setRemoteDescription(new RTCSessionDescription(callData.answer));
          processQueuedCandidates();
      } catch (e) {
          console.error("[WebRTC Web] Error setting remote description:", e);
      }
  };

  const acceptCall = async () => {
      if (!activeCall || !pc.current) return;
      try {
          await pc.current.setRemoteDescription(new RTCSessionDescription(activeCall.offer));
          processQueuedCandidates();
          const answer = await pc.current.createAnswer();
          await pc.current.setLocalDescription(answer);
          await respondToCall(chatId, answer);
      } catch (e) {
          console.error("[WebRTC Web] Error accepting call:", e);
      }
  };

  useEffect(() => {
    if (!chatId || !user) return;
    
    let iceUnsubscribe: (() => void) | undefined;
    const callRef = ref(database, `calls/${chatId}`);
    
    const unsubscribe = onValue(callRef, async (snapshot) => {
      const data = snapshot.val();
      
      if (data && data.status !== 'ended' && data.status !== 'declined') {
        setActiveCall(data);
        setIsVisible(true);
        
        if (!isHandlingCall.current) {
            iceUnsubscribe = await startCallHandling(data);
        }

        if (data.status === 'initiating') {
            const isIncoming = data.receiverId === user.uid;
            playSound(isIncoming ? 'ring' : 'dial');
        } else if (data.status === 'connected') {
            stopSound();
            if (data.answer && data.callerId === user.uid) {
                handleAnswer(data);
            }
            
            if (!timerRef.current) {
                timerRef.current = setInterval(() => {
                    setTimer(prev => prev + 1);
                }, 1000);
            }
        }
      } else {
        if (isVisible) {
            setIsVisible(false);
            stopSound();
            if (timerRef.current) {
                clearInterval(timerRef.current);
                timerRef.current = null;
            }
            setTimer(0);
            setIsMuted(false);
            cleanupWebRTC();
            if (iceUnsubscribe) iceUnsubscribe();
        }
      }
    });

    return () => { 
        unsubscribe(); 
        stopSound();
        cleanupWebRTC();
        if (timerRef.current) clearInterval(timerRef.current);
        if (iceUnsubscribe) iceUnsubscribe();
    };
  }, [chatId, user]);

  useEffect(() => {
      if (localStream) {
          localStream.getAudioTracks().forEach(track => {
              track.enabled = !isMuted;
          });
      }
  }, [isMuted, localStream]);

  if (!isVisible || !activeCall) return null;

  const isIncoming = activeCall.receiverId === user?.uid && activeCall.status === 'initiating';
  const isVideo = activeCall.type === 'video';
  const isConnected = activeCall.status === 'connected';

  return (
    <Modal visible={isVisible} transparent animationType="fade">
      <View style={[styles.container, isVideo && styles.videoBg]}>
        
        {isVideo && (
            <View style={StyleSheet.absoluteFill}>
                <video 
                    ref={remoteVideoRef}
                    autoPlay 
                    playsInline 
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
                <video 
                    ref={localVideoRef}
                    autoPlay 
                    playsInline 
                    muted
                    style={{ 
                        width: 150, 
                        height: 200, 
                        position: 'absolute', 
                        top: 20, 
                        right: 20, 
                        borderRadius: 10,
                        border: '2px solid white'
                    }}
                />
            </View>
        )}

        <View style={[StyleSheet.absoluteFill, isVideo && { backgroundColor: 'rgba(0,0,0,0.2)' }]}>
            <View style={styles.header}>
               <Text style={styles.callType}>{isVideo ? 'VIDEO' : 'AUDIO'} CALL</Text>
               <Text style={styles.status}>
                    {isConnected ? formatTime(timer) : (isIncoming ? 'Incoming...' : 'Ringing...')}
               </Text>
            </View>

            {!isConnected && (
                <View style={styles.userContainer}>
                    <View style={styles.avatarPlaceholder}>
                        <User_Placeholder width={100} height={100} />
                    </View>
                    <Text style={styles.username}>
                        {isIncoming ? (activeCall.callerName || 'Friend') : 'Calling...'}
                    </Text>
                </View>
            )}

            <View style={styles.controls}>
              {isConnected && (
                  <View style={styles.extraControls}>
                      <TouchableOpacity style={[styles.roundBtn, isMuted && styles.activeBtn]} onPress={() => setIsMuted(!isMuted)}>
                          <Mute_Icon width={32} height={32} />
                          <Text style={styles.btnLabel}>{isMuted ? "Unmute" : "Mute"}</Text>
                      </TouchableOpacity>
                  </View>
              )}

              {isIncoming ? (
                <View style={styles.actionRow}>
                  <TouchableOpacity style={styles.btnAction} onPress={() => declineCall(chatId)}>
                    <Decline_Call width={64} height={64} />
                  </TouchableOpacity>
                  
                  <TouchableOpacity style={styles.btnAction} onPress={acceptCall}>
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
  header: { alignItems: 'center', marginTop: 20, zIndex: 10 },
  callType: { color: '#FF4D67', fontSize: 13, fontWeight: '800', letterSpacing: 2 },
  status: { color: 'white', fontSize: 20, marginTop: 8 },
  userContainer: { alignItems: 'center', flex: 1, justifyContent: 'center' },
  avatarPlaceholder: { width: 140, height: 140, borderRadius: 70, backgroundColor: '#35383F', justifyContent: 'center', alignItems: 'center', marginBottom: 20 },
  username: { color: 'white', fontSize: 28, fontWeight: '700' },
  controls: { width: '100%', paddingHorizontal: 40, paddingBottom: 40, alignItems: 'center', zIndex: 10 },
  actionRow: { flexDirection: 'row', justifyContent: 'space-between', width: '100%' },
  btnAction: { width: 64, height: 64, borderRadius: 32, justifyContent: 'center', alignItems: 'center' },
  extraControls: { flexDirection: 'row', justifyContent: 'space-around', width: '100%', marginBottom: 40 },
  roundBtn: { width: 60, height: 60, borderRadius: 30, backgroundColor: 'rgba(255,255,255,0.15)', justifyContent: 'center', alignItems: 'center' },
  activeBtn: { backgroundColor: '#FF4D67' },
  btnLabel: { color: 'white', fontSize: 11, marginTop: 4 },
});
