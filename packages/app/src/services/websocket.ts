/**
 * WebSocket Service - リアルタイムメッセージ受信
 * DM のプッシュ通知を WebSocket で受信し、DM Store に反映する
 */

import { getAccessToken, getWsUrl } from './api';
import { useAuthStore } from '@/store/auth';
import { handleIncomingDM as handleIncomingDMNotification } from './notifications';

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
  // サーバは { type, payload } のエンベロープで送信する
  // （koshi: wsSend -> JSON.stringify({ type, payload })）
  const type = data?.type;
  const payload = data?.payload ?? {};

  switch (type) {
    case 'dm_received':
      handleIncomingDM(payload);
      break;
    case 'dm_sent':
      // 送信確認（TODO: ローカルストアの status を 'sent' へ更新）
      break;
    case 'dm_read':
      // TODO: 既読レシート
      break;
    case 'typing_start':
    case 'typing_stop':
      // TODO: タイピングインジケータ
      break;
    default:
      console.log('[WebSocket] Unknown message type:', type);
  }
}

/** 受信DMを DM Store に反映 */
async function handleIncomingDM(payload: any): Promise<void> {
  // サーバの DMEvent 形状: { id, from: { id, username }, content, signature, timestamp }
  const { id, from, content, signature, timestamp } = payload;

  const { user: authUser } = useAuthStore.getState();
  if (!authUser) return;

  // 自分宛てのメッセージのみ処理
  if (!from || from.id === authUser.id) return;

  const rawMessage = {
    id,
    from,
    to: { id: authUser.id, username: authUser.username },
    content,
    signature,
    isRead: false,
    createdAt: timestamp,
  };

  // 復号 → ストア反映 → ローカル通知表示 の唯一 entry point。
  // 送信者の ed25519 公開鍵の取得もここで行う
  // （サーバが user.public_key を公開していない場合は検証をスキップする）。
  await handleIncomingDMNotification(rawMessage);
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
