/**
 * @prepito/shared
 *
 * koshiプラットフォームの型定義を再エクスポート。
 * クライアント開発者はここから型をインポートする。
 *
 * @example
 * import { DM, Group, GroupMessage, WSEventMap, KeyBundle } from '@prepito/shared';
 */

// koshiプラットフォームの公開型をすべて再エクスポート
export type {
  // Common
  User,
  ApiError,

  // DM
  DM,
  SendDMRequest,
  DMListParams,

  // Groups
  Group,
  GroupRole,
  GroupMember,
  CreateGroupRequest,
  UpdateGroupRequest,
  GroupMessage,
  SendGroupMessageRequest,
  GroupMessagesParams,

  // E2E / Devices / Keys
  Device,
  RegisterDeviceRequest,
  KeyBundle,

  // WebSocket
  WSMessageType,
  WSMessage,
  WSEventMap,
  PostEvent,
  DMEvent,
} from '@ryopc/koshi/types';

// Prepito固有のユーティリティ型（必要に応じて追加）

/** コンバーション統一型（DM / グループ共通で扱う時用） */
export type ConversationType = 'dm' | 'group';

/** コンバーション識別子 */
export interface ConversationId {
  type: ConversationType;
  id: string; // DM: 相手のuserId, Group: groupId
}

/** メッセージ統一型（UI表示用） */
export interface UnifiedMessage {
  id: string;
  conversationId: ConversationId;
  senderId: string;
  senderUsername: string;
  senderDisplayName?: string;
  content: string; // 復号済み平文 (E2E後)
  isOutgoing: boolean; // 自分が送信したか
  status: 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
  messageType: 'text' | 'image' | 'file' | 'system';
  replyTo?: string;
  createdAt: string;
  readAt?: string;
}

/** 未読カウント */
export interface UnreadCount {
  dm: number;
  group: number;
  total: number;
}

/** タイピング状態 */
export interface TypingState {
  conversationId: ConversationId;
  userId: string;
  username: string;
  startedAt: number; // Date.now()
}
