/**
 * Authentication Store (Zustand)
 * Manages auth state, tokens, user profile
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import * as SecureStore from 'expo-secure-store';
import {
  getAccessToken,
  setAccessToken,
  getRefreshToken,
  setRefreshToken,
  authApi,
  usersApi,
  devicesApi,
} from '../services/api';

/** ユーザープロフィール型 */
export interface UserProfile {
  id: string;
  username: string;
  displayName?: string;
  bio?: string;
  avatarUrl?: string;
  isAdmin: boolean;
  createdAt: string;
  followersCount: number;
  followingCount: number;
}

/** 認証状態 */
interface AuthState {
  // State
  user: UserProfile | null;
  accessToken: string | null;
  refreshToken: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;

  // Device registration state
  isDeviceRegistered: boolean;
  deviceSetupComplete: boolean;

  // Actions
  setAuth: (tokens: {
    accessToken: string;
    /** koshi v5 以降は常に返る。旧サーバ（v4）との互換のため任意のままにする */
    refreshToken?: string;
    userId: string;
    username: string;
  }) => Promise<void>;
  clearAuth: () => Promise<void>;
  loadUserProfile: () => Promise<void>;
  updateProfile: (data: Partial<UserProfile>) => Promise<void>;
  setDeviceRegistered: (registered: boolean) => void;
  setDeviceSetupComplete: (complete: boolean) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;

  // Token management
  refreshAccessToken: () => Promise<boolean>;
  initializeAuth: () => Promise<void>;
}

/** SecureStore アダプター (Zustand persist 用) */
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
      // Fallback to memory handled by api.ts
    }
  },
  removeItem: async (name: string): Promise<void> => {
    try {
      await SecureStore.deleteItemAsync(name);
    } catch {
      // Ignore
    }
  },
};

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      // Initial state
      user: null,
      accessToken: null,
      refreshToken: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,
      isDeviceRegistered: false,
      deviceSetupComplete: false,

      // Actions
      setAuth: async ({ accessToken, refreshToken, userId: _userId, username: _username }) => {
        set({ isLoading: true, error: null });
        try {
          // トークン保存
          await setAccessToken(accessToken);
          await setRefreshToken(refreshToken);

          // ストア更新
          set({
            accessToken,
            refreshToken,
            isAuthenticated: true,
            isLoading: false,
          });

          // プロフィール取得
          await get().loadUserProfile();
        } catch (err) {
          set({
            error: err instanceof Error ? err.message : 'Authentication failed',
            isLoading: false,
          });
          throw err;
        }
      },

      clearAuth: async () => {
        set({ isLoading: true });
        try {
          // サーバー側ログアウト (best effort)
          await authApi.logout().catch(() => {});

          // サーバ発行デバイス ID を破棄する（次ログイン時に再登録される）
          const { clearServerDeviceId } = await import('@/utils/secureStore');
          await clearServerDeviceId().catch(() => {});
        } finally {
          // ローカルクリア
          await setAccessToken(null);
          await setRefreshToken(null);
          set({
            user: null,
            accessToken: null,
            refreshToken: null,
            isAuthenticated: false,
            isLoading: false,
            isDeviceRegistered: false,
            deviceSetupComplete: false,
          });
        }
      },

      loadUserProfile: async () => {
        const { accessToken } = get();
        if (!accessToken) return;

        try {
          // api.ts は内部で getAccessToken を呼ぶため、ここでのトークン設定は不要
          const profile = await usersApi.getMe();
          set({ user: profile });

          // プッシュ通知が有効なら、ログイン後にトークンを登録する。
          // 動的 import で notifications <-> auth の循環 import を避ける。
          const { registerPushTokenIfAuthenticated } = await import('@/services/notifications');
          await registerPushTokenIfAuthenticated();

          // デバイス登録状態確認
          try {
            const devices = await devicesApi.list();
            set({ isDeviceRegistered: devices.length > 0 });
          } catch {
            set({ isDeviceRegistered: false });
          }
        } catch (err) {
          // トークン期限切れ等の場合
          if (err instanceof Error && err.message.includes('401')) {
            const refreshed = await get().refreshAccessToken();
            if (refreshed) {
              await get().loadUserProfile();
            } else {
              await get().clearAuth();
            }
          }
          console.warn('[AuthStore] Failed to load profile:', err);
        }
      },

      updateProfile: async (data) => {
        const { user } = get();
        if (!user) return;

        try {
          const updated = await usersApi.updateMe(data);
          set({ user: { ...user, ...updated } });
        } catch (err) {
          set({ error: err instanceof Error ? err.message : 'Profile update failed' });
          throw err;
        }
      },

      setDeviceRegistered: (registered) => set({ isDeviceRegistered: registered }),
      setDeviceSetupComplete: (complete) => set({ deviceSetupComplete: complete }),
      setLoading: (loading) => set({ isLoading: loading }),
      setError: (error) => set({ error }),

      refreshAccessToken: async () => {
        const { refreshToken } = get();
        if (!refreshToken) return false;

        try {
          const { token, refreshToken: newRefreshToken } = await authApi.refresh(refreshToken);
          await setAccessToken(token);
          await setRefreshToken(newRefreshToken);
          set({ accessToken: token, refreshToken: newRefreshToken });
          return true;
        } catch {
          await get().clearAuth();
          return false;
        }
      },

      initializeAuth: async () => {
        set({ isLoading: true });
        try {
          const token = await getAccessToken();
          const refresh = await getRefreshToken();

          if (token && refresh) {
            set({ accessToken: token, refreshToken: refresh, isAuthenticated: true });
            await get().loadUserProfile();
          } else {
            set({ isAuthenticated: false });
          }
        } catch (err) {
          console.error('[AuthStore] Initialize failed:', err);
          await get().clearAuth();
        } finally {
          set({ isLoading: false });
        }
      },
    }),
    {
      name: 'prepito-auth',
      storage: createJSONStorage(() => secureStoreAdapter),
      partialize: (state) => ({
        // 永続化する項目 (SecureStore にはトークンのみ保存、ユーザー情報は再取得)
        isDeviceRegistered: state.isDeviceRegistered,
        deviceSetupComplete: state.deviceSetupComplete,
      }),
    }
  )
);

/** 便利フック */
export function useAuth() {
  const { user, isAuthenticated, isLoading, isDeviceRegistered, deviceSetupComplete } =
    useAuthStore();
  return { user, isAuthenticated, isLoading, isDeviceRegistered, deviceSetupComplete };
}

export function useAuthActions() {
  const {
    setAuth,
    clearAuth,
    loadUserProfile,
    updateProfile,
    setDeviceRegistered,
    setDeviceSetupComplete,
    refreshAccessToken,
    initializeAuth,
  } = useAuthStore();
  return {
    setAuth,
    clearAuth,
    loadUserProfile,
    updateProfile,
    setDeviceRegistered,
    setDeviceSetupComplete,
    refreshAccessToken,
    initializeAuth,
  };
}
