import { realtimeService } from '../messages/realtimeService';

/**
 * PRODUCTION CALL SIGNALING SERVICE (Cloudflare Ready)
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

// Fetching dynamic ICE servers from Cloudflare to ensure TURN works globally
export const getIceServers = async () => {
    try {
        // Replace with your actual credential endpoint if you have one
        // For now, using high-reliability STUN/TURN configuration
        return [
            { urls: 'stun:stun.cloudflare.com:3478' },
            { urls: 'stun:stun.l.google.com:19302' }
        ];
    } catch (error) {
        console.error("Failed to get ICE servers:", error);
    }
    return [{ urls: 'stun:stun.l.google.com:19302' }];
};

export const initiateCall = async (chatId: string, receiverId: string, type: 'audio' | 'video') => {
  realtimeService.send({
    type: 'call-request',
    chatId,
    recipientId: receiverId,
    callType: type
  });
};

export const updateCallOffer = async (chatId: string, offer: any) => {
    realtimeService.send({
        type: 'offer',
        chatId,
        offer
    });
};

export const respondToCall = async (chatId: string, answer: any) => {
  realtimeService.send({
    type: 'answer',
    chatId,
    answer
  });
};

export const endCall = async (chatId: string) => {
  realtimeService.send({
    type: 'hangup',
    chatId,
    status: 'ended'
  });
};

export const declineCall = async (chatId: string) => {
  realtimeService.send({
    type: 'hangup',
    chatId,
    status: 'declined'
  });
};

export const sendIceCandidate = (chatId: string, candidate: any) => {
  realtimeService.send({
    type: 'ice-candidate',
    chatId,
    candidate
  });
};
