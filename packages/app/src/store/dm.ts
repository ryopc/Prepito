/**
 * DM Store (Zustand)
 * E2E暗号化DMの状態管理
 * - DM一覧・未読数
 * - 現在の会話のメッセージリスト
 * - 送信・受信フロー
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import * as SecureStore from 'expo-secure-store';
import { sendDM, receiveDM, type RawDMMessage } from '@/services/dm';
import { dmsApi } from '@/services/api';
import { useAuthStore } from './auth';
import {
  saveMessage,
  loadMessages,
  loadUnreadCount,
  markMessagesRead,
  updateMessageStatus,
} from '@/services/db/encrypted-db';

/** SecureStore アダプター */
const secureStoreAdapter = {
  getItem: async (name: string): Promise<string | null> => {
    try {
      return await SecureStore.getItemAsync(name);
    } catch {
      return null;
    }
  },
  setItem: async (name: string, value: string): Promise<void> => {
    try {
      await SecureStore.setItemAsync(name, value);
    } catch {
      // 保存失敗は無視 (メモリ上の状態のみを保つ)
    }
  },
  removeItem: async (name: string): Promise<void> => {
    try {
      await SecureStore.deleteItemAsync(name);
    } catch {
      // 削除失敗は無視
    }
  },
};

/** DMスレッド */
export interface DMThread {
  conversationId: string;
  otherUserId: string;
  otherUsername: string;
  otherDisplayName?: string;
  otherAvatarUrl?: string;
  lastMessage?: string;
  lastMessageAt: string;
  unreadCount: number;
}

/** DMメッセージ (ローカル表示用) */
export interface DMMessage {
  id: string;
  conversationId: string;
  fromUserId: string;
  fromUsername: string;
  fromDisplayName?: string;
  plaintext: string;
  isRead: boolean;
  isOutgoing: boolean;
  status: 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
  createdAt: string;
  localId: string; // 楽観的UI用
  /**
   * 復号に失敗したメッセージか
   *
   * Signal Protocol のセッション再確立前のメッセージなど、
   * 復号できない場合にも「届いたことは分かる」ようプレースホルダを保持する。
   */
  decryptionFailed?: boolean;
}

/** 状態 */
interface DMState {
  // スレッド一覧
  threads: DMThread[];
  threadsLoading: boolean;
  // 現在の会話
  activeConversationId: string | null;
  messages: DMMessage[];
  messagesLoading: boolean;
  // 未読数
  unreadCount: number;
  // エラー
  error: string | null;

  // アクション
  fetchThreads: () => Promise<void>;
  fetchMessages: (conversationId: string, otherUserId: string) => Promise<void>;
  sendMessage: (conversationId: string, recipientId: string, plaintext: string) => Promise<void>;
  receiveMessage: (raw: RawDMMessage, senderPublicKeyHex: string | null) => Promise<void>;
  setActiveConversation: (conversationId: string | null) => void;
  markAsRead: (conversationId: string) => Promise<void>;
  setError: (error: string | null) => void;
  clearError: () => void;
}

export const useDMStore = create<DMState>()(
  persist(
    (set, get) => ({
      // 初期状態
      threads: [],
      threadsLoading: false,
      activeConversationId: null,
      messages: [],
      messagesLoading: false,
      unreadCount: 0,
      error: null,

      // スレッド一覧取得
      fetchThreads: async () => {
        set({ threadsLoading: true, error: null });
        try {
          const { user } = useAuthStore.getState();
          if (!user) return;

          const rawThreads = await dmsApi.list({ limit: 50 });
          // TODO: 生APIレスポンスをスレッド形式に変換 (サーバー側スレッド集約エンドポイント未実装のためプレースホルダー)
          const threads: DMThread[] = rawThreads.map((dm: any) => {
            const other = dm.from.id === user.id ? dm.to : dm.from;
            return {
              conversationId: other.id,
              otherUserId: other.id,
              otherUsername: other.username,
              otherDisplayName: other.displayName,
              otherAvatarUrl: other.avatarUrl,
              lastMessage: dm.content, // 暗号文 (UIでは表示しない、またはプレビュー)
              lastMessageAt: dm.createdAt,
              unreadCount: dm.isRead ? 0 : 1,
            };
          });

          set({ threads, threadsLoading: false });
        } catch (err) {
          set({
            error: err instanceof Error ? err.message : 'スレッド一覧の取得に失敗しました',
            threadsLoading: false,
          });
        }
      },

      // メッセージ履歴取得 (DB優先、サーバーAPIとの併用)
      fetchMessages: async (conversationId: string, _otherUserId: string) => {
        set({ messagesLoading: true, error: null, activeConversationId: conversationId });
        try {
          const { user } = useAuthStore.getState();
          if (!user) return;

          // 1. ローカルDBからメッセージを復元
          const dbMessages = await loadMessages(conversationId, 'dm', 100);
          const fromDb: DMMessage[] = dbMessages.map((row) => ({
            id: row.message_id,
            conversationId: row.conversation_id,
            fromUserId: row.sender_id,
            fromUsername: '', // DBにはユーザー名を保存しないため空
            fromDisplayName: undefined,
            plaintext: '', // 暗号文はDBに保存しない (SQLCipher暗号化済みだが平文は保存しない)
            isRead: row.status === 'read',
            isOutgoing: row.is_outgoing === 1,
            status: row.status as DMMessage['status'],
            createdAt: new Date(row.timestamp).toISOString(),
            localId: row.local_id,
          }));

          // 2. サーバーから最新メッセージを取得 (実際には /api/dms/:conversationId/messages エンドポイント)
          // プレースホルダー: dmsApi.list は全スレッドなのでここでは未実装
          set({ messages: fromDb, messagesLoading: false });
        } catch (err) {
          set({
            error: err instanceof Error ? err.message : 'メッセージ取得に失敗しました',
            messagesLoading: false,
          });
        }
      },

      // メッセージ送信
      sendMessage: async (conversationId: string, recipientId: string, plaintext: string) => {
        const { user } = useAuthStore.getState();
        if (!user) return;

        // 楽観的UI: 即座にローカルメッセージを追加
        const localId = `local-${Date.now()}`;
        const optimisticMessage: DMMessage = {
          id: localId,
          conversationId,
          fromUserId: user.id,
          fromUsername: user.username,
          fromDisplayName: user.displayName,
          plaintext,
          isRead: true,
          isOutgoing: true,
          status: 'sending',
          createdAt: new Date().toISOString(),
          localId,
        };

        set((state) => ({
          messages: [...state.messages, optimisticMessage],
          error: null,
        }));

        try {
          const result = await sendDM({ recipientId, plaintext });

          // DBに保存 (messageId はサーバーから返ってくる)
          await saveMessage({
            conversationId,
            conversationType: 'dm',
            messageId: result.id,
            localId,
            senderId: user.id,
            messageType: 'text',
            timestamp: Date.now(),
            isOutgoing: true,
            status: 'sent',
          });

          // 送信成功: ステータス更新
          set((state) => ({
            messages: state.messages.map((m) =>
              m.localId === localId ? { ...m, id: result.id, status: 'sent' } : m
            ),
          }));
        } catch (err) {
          // 送信失敗: ステータスを failed に
          await updateMessageStatus(localId, 'failed');
          set((state) => ({
            messages: state.messages.map((m) =>
              m.localId === localId ? { ...m, status: 'failed' } : m
            ),
            error: err instanceof Error ? err.message : 'メッセージ送信に失敗しました',
          }));
        }
      },

      // メッセージ受信 (プッシュ/WebSocket 経由)
      receiveMessage: async (raw: RawDMMessage, senderPublicKeyHex: string | null) => {
        const { user } = useAuthStore.getState();

        // 重複排除 (WebSocket とプッシュ通知の双重経路で到達しうる)
        if (get().messages.some((m) => m.id === raw.id)) return;

        // NOTE: プロフィール取得（GET /api/users/me）が未実装のサーバでも
        // メッセージを受信できるよう、user は任意とする。
        const decrypted = await receiveDM(raw, senderPublicKeyHex, user?.id ?? '');

        // 復号に失敗した場合でも「届いた」ことは伝える。
        // Signal Protocol のセッション再確立前のメッセージは復号できないが、
        // サイレントに消すとユーザに伝わらないためプレースホルダを保持する。
        if (!decrypted) {
          const failedMessage: DMMessage = {
            id: raw.id,
            conversationId: raw.from.id,
            fromUserId: raw.from.id,
            fromUsername: raw.from.username,
            fromDisplayName: raw.from.displayName,
            plaintext: '',
            isRead: raw.isRead,
            isOutgoing: false,
            status: 'read',
            createdAt: raw.createdAt,
            localId: `local-${raw.id}`,
            decryptionFailed: true,
          };

          set((state) => ({
            messages: [...state.messages, failedMessage],
            unreadCount: state.unreadCount + 1,
          }));
          return;
        }

        const localId = `local-${decrypted.id}`;
        const message: DMMessage = {
          id: decrypted.id,
          conversationId: decrypted.conversationId,
          fromUserId: decrypted.fromUserId,
          fromUsername: decrypted.fromUsername,
          fromDisplayName: decrypted.fromDisplayName,
          plaintext: decrypted.plaintext,
          isRead: decrypted.isRead,
          isOutgoing: false,
          status: 'read',
          createdAt: decrypted.createdAt,
          localId,
        };

        // DBに保存
        await saveMessage({
          conversationId: decrypted.conversationId,
          conversationType: 'dm',
          messageId: decrypted.id,
          localId,
          senderId: decrypted.fromUserId,
          messageType: 'text',
          timestamp: new Date(decrypted.createdAt).getTime(),
          isOutgoing: false,
          status: 'read',
        });

        set((state) => ({
          messages: [...state.messages, message],
          unreadCount: state.unreadCount + 1,
          // スレッドの未読数更新
          threads: state.threads.map((t) =>
            t.conversationId === decrypted.conversationId
              ? {
                  ...t,
                  unreadCount: t.unreadCount + 1,
                  lastMessage: decrypted.plaintext,
                  lastMessageAt: decrypted.createdAt,
                }
              : t
          ),
        }));
      },

      // アクティブ会話設定
      setActiveConversation: (conversationId: string | null) =>
        set({ activeConversationId: conversationId, error: null }),

      // 既読マーク
      markAsRead: async (conversationId: string) => {
        // サーバの既読エンドポイントは **DM（メッセージ）ID** を要求する
        // (PUT /api/dms/:dmId/read)。会話 ID を渡すと 400 になるため、
        // 会話内の未読メッセージごとに呼び出す。
        const { messages } = get();
        const unreadIncoming = messages.filter(
          (m) => m.conversationId === conversationId && !m.isOutgoing && !m.isRead
        );
        await Promise.all(unreadIncoming.map((m) => dmsApi.markRead(m.id).catch(() => {})));

        await markMessagesRead(conversationId, 'dm');
        set((state) => ({
          messages: state.messages.map((m) =>
            m.conversationId === conversationId && !m.isOutgoing ? { ...m, isRead: true } : m
          ),
          threads: state.threads.map((t) =>
            t.conversationId === conversationId ? { ...t, unreadCount: 0 } : t
          ),
          unreadCount: 0,
        }));
      },

      // DBからメッセージを復元 (アプリ起動時など)
      loadMessagesFromDB: async (conversationId: string) => {
        const dbMessages = await loadMessages(conversationId, 'dm', 100);
        const unread = await loadUnreadCount(conversationId, 'dm');
        const messages: DMMessage[] = dbMessages.map((row) => ({
          id: row.message_id,
          conversationId: row.conversation_id,
          fromUserId: row.sender_id,
          fromUsername: '',
          fromDisplayName: undefined,
          plaintext: '',
          isRead: row.status === 'read',
          isOutgoing: row.is_outgoing === 1,
          status: row.status as DMMessage['status'],
          createdAt: new Date(row.timestamp).toISOString(),
          localId: row.local_id,
        }));

        set({ messages, unreadCount: unread, messagesLoading: false });
      },

      setError: (error) => set({ error }),
      clearError: () => set({ error: null }),
    }),
    {
      name: 'prepito-dm',
      storage: createJSONStorage(() => secureStoreAdapter),
      partialize: () => ({
        // 永続化しない (メッセージは機密のためメモリのみ、またはDBに保存)
      }),
    }
  )
);

/** 便利フック */
export function useDM() {
  const {
    threads,
    threadsLoading,
    activeConversationId,
    messages,
    messagesLoading,
    unreadCount,
    error,
    fetchThreads,
    fetchMessages,
    sendMessage,
    receiveMessage,
    setActiveConversation,
    markAsRead,
    setError,
    clearError,
  } = useDMStore();
  return {
    threads,
    threadsLoading,
    activeConversationId,
    messages,
    messagesLoading,
    unreadCount,
    error,
    fetchThreads,
    fetchMessages,
    sendMessage,
    receiveMessage,
    setActiveConversation,
    markAsRead,
    setError,
    clearError,
  };
}

export function useDMActions() {
  const {
    fetchThreads,
    fetchMessages,
    sendMessage,
    receiveMessage,
    setActiveConversation,
    markAsRead,
    setError,
    clearError,
  } = useDMStore();
  return {
    fetchThreads,
    fetchMessages,
    sendMessage,
    receiveMessage,
    setActiveConversation,
    markAsRead,
    setError,
    clearError,
  };
}
