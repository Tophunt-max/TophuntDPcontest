import { auth } from '@/src/services/firebase/initFirebase';

const WORKER_WS_URL = 'wss://chat.tophunt.in'; 

export type RealtimeMessage = {
  type: 'text' | 'image' | 'voice_note' | 'typing' | 'presence' | 'offer' | 'answer' | 'ice-candidate' | 'call-request' | 'hangup';
  chatId?: string;
  text?: string;
  isTyping?: boolean;
  status?: 'online' | 'offline';
  userId?: string;
  from?: string;
  timestamp?: number;
  id?: string;
  offer?: any;
  answer?: any;
  candidate?: any;
};

class RealtimeService {
  private ws: WebSocket | null = null;
  private listeners: Set<(data: RealtimeMessage) => void> = new Set();
  private chatId: string | null = null;
  private reconnectTimer: any = null;

  connect(chatId: string) {
    const user = auth.currentUser;
    if (!user) return;
    
    if (this.chatId === chatId && this.ws?.readyState === WebSocket.OPEN) return;

    this.disconnect();
    this.chatId = chatId;

    const url = `${WORKER_WS_URL}?chatId=${chatId}&userId=${user.uid}`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      console.log("[RealtimeService] Connected to room:", chatId);
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    };

    this.ws.onmessage = (e) => {
      try {
        const data: RealtimeMessage = JSON.parse(e.data);
        this.listeners.forEach(listener => listener(data));
      } catch (err) {
        console.error("[RealtimeService] Parse error:", err);
      }
    };

    this.ws.onclose = () => {
      console.log("[RealtimeService] Disconnected. Reconnecting in 3s...");
      this.ws = null;
      this.reconnectTimer = setTimeout(() => this.connect(chatId), 3000);
    };

    this.ws.onerror = (e) => {
      console.error("[RealtimeService] WebSocket Error:", e);
    };
  }

  disconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.chatId = null;
  }

  send(payload: Partial<RealtimeMessage>) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ ...payload, chatId: this.chatId }));
    } else {
      console.warn("[RealtimeService] Cannot send: WebSocket not open");
    }
  }

  subscribe(listener: (data: RealtimeMessage) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const realtimeService = new RealtimeService();
