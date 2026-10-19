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
import {
  sendDM,
  receiveDM,
  buildOutgoingPayload,
  getConversationId,
  type DecryptedDM,
  type RawDMMessage,
  type SendDMPayload,
} from '@/services/dm';
import { usersApi, dmsApi } from '@/services/api';
import { useAuthStore } from './auth';

/** SecureStore アダプター */
const secureStoreAdapter = {
  getItem: async (name: string): Promise<string | null> => {
    try { return await SecureStore.getItemAsync(name); } catch { return null; }
  },
  setItem: async (name: string, value: string): Promise<void> => {
    try { await SecureStore.setItemAsync(name, value); } catch {}
  },
  removeItem: async (name: string): Promise<void> => {
    try { await SecureStore.deleteItemAsync(name); } catch {}
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
  receiveMessage: (raw: RawDMMessage, senderPublicKeyBase64: string) => Promise<void>;
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

      // メッセージ履歴取得
      fetchMessages: async (conversationId: string, otherUserId: string) => {
        set({ messagesLoading: true, error: null, activeConversationId: conversationId });
        try {
          const { user } = useAuthStore.getState();
          if (!user) return;

          // サーバーからDM履歴取得 (dmsApi.list は全スレッドなので、ここではプレースホルダー)
          // 実際には /api/dms/:conversationId/messages エンドポイントが必要
          const rawMessages = await dmsApi.list({ limit: 100 });
          const myId = user.id;

          const messages: DMMessage[] = await Promise.all(
            rawMessages
              .filter((dm: any) => {
                const isWithOther =
                  (dm.from.id === otherUserId && dm.to.id === myId) ||
                  (dm.from.id === myId && dm.to.id === otherUserId);
                return isWithOther;
              })
              .map(async (dm: any) => {
                // 復号 (署名鍵は相手から取得・キャッシュ)
                // プレースホルダー: 復号ロジックは receiveMessage 側で実行
                const decrypted = await receiveDM(dm, '', myId);
                return {
                  id: dm.id,
                  conversationId,
                  fromUserId: dm.from.id,
                  fromUsername: dm.from.username,
                  fromDisplayName: dm.from.displayName,
                  plaintext: decrypted?.plaintext ?? '[復号に失敗]',
                  isRead: dm.isRead,
                  isOutgoing: dm.from.id === myId,
                  status: 'read',
                  createdAt: dm.createdAt,
                  localId: `local-${dm.id}`,
                };
              })
          );

          set({ messages, messagesLoading: false });
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
          await sendDM({ recipientId, plaintext });

          // 送信成功: ステータス更新
          set((state) => ({
            messages: state.messages.map((m) =>
              m.localId === localId ? { ...m, status: 'sent' } : m
            ),
          }));
        } catch (err) {
          // 送信失敗: ステータスを failed に
          set((state) => ({
            messages: state.messages.map((m) =>
              m.localId === localId ? { ...m, status: 'failed' } : m
            ),
            error: err instanceof Error ? err.message : 'メッセージ送信に失敗しました',
          }));
        }
      },

      // メッセージ受信 (プッシュ/WebSocket 経由)
      receiveMessage: async (raw: RawDMMessage, senderPublicKeyBase64: string) => {
        const { user } = useAuthStore.getState();
        if (!user) return;

        const decrypted = await receiveDM(raw, senderPublicKeyBase64, user.id);
        if (!decrypted) return;

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
          localId: `local-${decrypted.id}`,
        };

        set((state) => ({
          messages: [...state.messages, message],
          unreadCount: state.unreadCount + 1,
          // スレッドの未読数更新
          threads: state.threads.map((t) =>
            t.conversationId === decrypted.conversationId
              ? { ...t, unreadCount: t.unreadCount + 1, lastMessage: decrypted.plaintext, lastMessageAt: decrypted.createdAt }
              : t
          ),
        }));
      },

      // アクティブ会話設定
      setActiveConversation: (conversationId: string | null) =>
        set({ activeConversationId: conversationId, error: null }),

      // 既読マーク
      markAsRead: async (conversationId: string) => {
        // TODO: API 呼び出し (markRead)
        set((state) => ({
          threads: state.threads.map((t) =>
            t.conversationId === conversationId ? { ...t, unreadCount: 0 } : t
          ),
          unreadCount: 0,
        }));
      },

      setError: (error) => set({ error }),
      clearError: () => set({ error: null }),
    }),
    {
      name: 'prepito-dm',
      storage: createJSONStorage(() => secureStoreAdapter),
      partialize: (state) => ({
        // 永続化しない (メッセージは機密のためメモリのみ、またはDBに保存)
      }),
    }
  )
);

/** 便利フック */
export function useDM() {
  const {
    threads, threadsLoading, activeConversationId, messages,
    messagesLoading, unreadCount, error,
    fetchThreads, fetchMessages, sendMessage, receiveMessage,
    setActiveConversation, markAsRead, setError, clearError,
  } = useDMStore();
  return {
    threads, threadsLoading, activeConversationId, messages,
    messagesLoading, unreadCount, error,
    fetchThreads, fetchMessages, sendMessage, receiveMessage,
    setActiveConversation, markAsRead, setError, clearError,
  };
}

export function useDMActions() {
  const {
    fetchThreads, fetchMessages, sendMessage, receiveMessage,
    setActiveConversation, markAsRead, setError, clearError,
  } = useDMStore();
  return { fetchThreads, fetchMessages, sendMessage, receiveMessage,
    setActiveConversation, markAsRead, setError, clearError };
}
