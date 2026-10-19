/**
 * WebSocket Service - リアルタイムメッセージ受信
 * DM のプッシュ通知を WebSocket で受信し、DM Store に反映する
 */

import { getAccessToken, getWsUrl } from './api';
import { useAuthStore } from '@/store/auth';
import { useDMStore } from '@/store/dm';
import { receiveDM } from '@/services/dm';

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let isConnecting = false;
let shouldReconnect = true;

/** WebSocket 接続開始 */
export async function connectWebSocket(): Promise<void> {
  if (ws?.readyState === WebSocket.OPEN || isConnecting) return;
  isConnecting = true;

  const token = await getAccessToken();
  if (!token) {
    isConnecting = false;
    return;
  }

  const url = getWsUrl(token);
  ws = new WebSocket(url);

  ws.onopen = () => {
    console.log('[WebSocket] Connected');
    isConnecting = false;
    shouldReconnect = true;
  };

  ws.onmessage = (event: any) => {
    try {
      const data = JSON.parse(event.data);
      handleWebSocketMessage(data);
    } catch (err) {
      console.warn('[WebSocket] Failed to parse message:', err);
    }
  };

  ws.onclose = () => {
    console.log('[WebSocket] Disconnected');
    ws = null;
    isConnecting = false;
    if (shouldReconnect) {
      scheduleReconnect();
    }
  };

  ws.onerror = (err) => {
    console.error('[WebSocket] Error:', err);
    ws?.close();
  };
}

/** 再接続スケジュール */
function scheduleReconnect(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    console.log('[WebSocket] Reconnecting...');
    connectWebSocket();
  }, 3000);
}

/** WebSocket メッセージ処理 */
function handleWebSocketMessage(data: any): void {
  switch (data.type) {
    case 'dm':
      handleIncomingDM(data);
      break;
    case 'typing':
      // TODO: タイピングインジケータ
      break;
    case 'read_receipt':
      // TODO: 既読レシート
      break;
    default:
      console.log('[WebSocket] Unknown message type:', data.type);
  }
}

/** 受信DMを DM Store に反映 */
async function handleIncomingDM(data: any): Promise<void> {
  const { conversation_id, from, content, signature, created_at, message_id } = data;

  const { user: authUser } = useAuthStore.getState();
  if (!authUser) return;

  // 自分宛てのメッセージのみ処理
  if (from.id === authUser.id) return;

  const rawMessage = {
    id: message_id,
    from,
    to: { id: authUser.id, username: authUser.username },
    content,
    signature,
    isRead: false,
    createdAt: created_at,
  };

  // 相手の公開鍵を取得して復号 (プレースホルダー: 実際には API から取得)
  const senderPublicKeyBase64 = ''; // TODO: usersApi.getByUsername(from.username) から取得

  const dmStore = useDMStore.getState();
  await dmStore.receiveMessage(rawMessage, senderPublicKeyBase64);
}

/** WebSocket 切断 */
export function disconnectWebSocket(): void {
  shouldReconnect = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
  isConnecting = false;
}

/** 接続状態取得 */
export function isWebSocketConnected(): boolean {
  return ws?.readyState === WebSocket.OPEN;
}
