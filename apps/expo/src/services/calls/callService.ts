import { ref, set, onValue, push, onDisconnect, remove, update, off, get } from 'firebase/database';
import { database, auth } from '@/src/services/firebase/initFirebase';
import { sendMessage } from '../messages/messageService';
import { MessageType } from '@/src/types/schema';

/**
 * PRODUCTION CALL SIGNALING SERVICE
 * Uses Firebase RTDB for ultra-low latency signaling.
 */

export interface CallSession {
  chatId: string;
  callerId: string;
  receiverId: string;
  type: 'audio' | 'video';
  status: 'initiating' | 'ringing' | 'connected' | 'ended' | 'declined';
  offer?: any;
  answer?: any;
  createdAt: number;
}

export const initiateCall = async (chatId: string, receiverId: string, type: 'audio' | 'video') => {
  const user = auth.currentUser;
  if (!user) return;

  const callRef = ref(database, `calls/${chatId}`);
  
  const session: CallSession = {
    chatId,
    callerId: user.uid,
    receiverId,
    type,
    status: 'initiating',
    createdAt: Date.now(),
  };

  // 1. Record in RTDB for real-time signaling
  await set(callRef, session);
  
  // 2. Clear old candidates
  await remove(ref(database, `calls/${chatId}/candidates`));

  // 3. Record in Firestore
  try {
      const msgType = (type === 'video' ? 'video_call' : 'voice_call') as MessageType;
      await sendMessage(chatId, `Call started`, msgType, { 
          callStatus: 'started',
          callType: type
      });
  } catch (e) {
      console.error("Failed to log call message:", e);
  }
  
  onDisconnect(callRef).remove();
};

export const updateCallOffer = async (chatId: string, offer: any) => {
    const callRef = ref(database, `calls/${chatId}`);
    await update(callRef, { offer });
};

export const respondToCall = async (chatId: string, answer: any) => {
  const callRef = ref(database, `calls/${chatId}`);
  await update(callRef, {
    answer,
    status: 'connected'
  });
};

export const endCall = async (chatId: string) => {
  const callRef = ref(database, `calls/${chatId}`);
  const snapshot = await get(callRef);
  if (snapshot.exists()) {
      await update(callRef, { status: 'ended' });
      // Clean up candidates
      await remove(ref(database, `calls/${chatId}/candidates`));
      setTimeout(() => remove(callRef), 2000);
  }
};

export const declineCall = async (chatId: string) => {
    const callRef = ref(database, `calls/${chatId}`);
    await update(callRef, { status: 'declined' });
    
    try {
        await sendMessage(chatId, `Missed call`, 'text', { isMissedCall: true });
    } catch (e) {}

    setTimeout(() => remove(callRef), 2000);
};

export const sendIceCandidate = (chatId: string, candidate: any) => {
  const user = auth.currentUser;
  if (!user) return;
  // Store candidates under the sender's UID
  const candidatesRef = ref(database, `calls/${chatId}/candidates/${user.uid}`);
  push(candidatesRef, candidate);
};

export const listenForIceCandidates = (chatId: string, otherUserId: string, callback: (candidate: any) => void) => {
  const candidatesRef = ref(database, `calls/${chatId}/candidates/${otherUserId}`);
  const listener = onValue(candidatesRef, (snapshot) => {
    snapshot.forEach((child) => {
      callback(child.val());
    });
  });
  return () => off(candidatesRef, 'value', listener);
};
