/**
 * API Client for koshi platform
 * Base configuration and common utilities
 */

import * as SecureStore from 'expo-secure-store';
import Constants from 'expo-constants';

/**
 * API基底URL / WebSocket URL の解決
 *
 * 優先順位:
 *   1. ビルド時環境変数 (EXPO_PUBLIC_*) — Metro がバンドルへインライン化する
 *   2. app.config.ts の `extra.apiBaseUrl` / `extra.wsBaseUrl` — 単一情報源
 *   3. 公開サーバ（app.config.ts と同じ値）
 *
 * Previously ここだけ環境変数を直接参照しており、app.config.ts の `extra` と
 * 二重定義になっていた（F-Droid ビルドなど環境変数を設定できない経路で
 * 不整合が発生する）。app.config.ts と同じ解決順序に揃える。
 *
 * フォールバックも `localhost` ではなく公開サーバにしている。
 * release ビルドの AndroidManifest は cleartext を無効化しているため
 * HTTP のままでは接続できず、気づかないまま「接続できない」状態になるため。
 */
const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_BASE_URL ||
  (Constants.expoConfig?.extra?.apiBaseUrl as string | undefined) ||
  'https://koshi.ryopc.org';
const WS_BASE_URL =
  process.env.EXPO_PUBLIC_WS_BASE_URL ||
  (Constants.expoConfig?.extra?.wsBaseUrl as string | undefined) ||
  'wss://koshi.ryopc.org';

/** セキュアストレージキー */
const STORAGE_KEYS = {
  ACCESS_TOKEN: 'prepito.access_token',
  REFRESH_TOKEN: 'prepito.refresh_token',
  USER_ID: 'prepito.user_id',
  USERNAME: 'prepito.username',
} as const;

/** 汎用APIエラークラス */
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
    public details?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** トークン取得 (SecureStore優先、フォールバックでメモリ) */
let _memoryToken: string | null = null;
let _memoryRefreshToken: string | null | undefined = null;

export async function getAccessToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(STORAGE_KEYS.ACCESS_TOKEN);
  } catch {
    return _memoryToken;
  }
}

export async function setAccessToken(token: string | null): Promise<void> {
  try {
    if (token) {
      await SecureStore.setItemAsync(STORAGE_KEYS.ACCESS_TOKEN, token);
    } else {
      await SecureStore.deleteItemAsync(STORAGE_KEYS.ACCESS_TOKEN);
    }
  } catch {
    _memoryToken = token;
  }
}

export async function getRefreshToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(STORAGE_KEYS.REFRESH_TOKEN);
  } catch {
    return _memoryRefreshToken ?? null;
  }
}

export async function setRefreshToken(token: string | null | undefined): Promise<void> {
  try {
    if (token) {
      await SecureStore.setItemAsync(STORAGE_KEYS.REFRESH_TOKEN, token);
    } else {
      await SecureStore.deleteItemAsync(STORAGE_KEYS.REFRESH_TOKEN);
    }
  } catch {
    _memoryRefreshToken = token;
  }
}

/** 共通ヘッダー生成 */
async function getAuthHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/** レスポンス処理 */
async function handleResponse<T>(response: Response): Promise<T> {
  const contentType = response.headers.get('content-type');
  const isJson = contentType?.includes('application/json');
  const data = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    const message = isJson
      ? (data as any)?.message || (data as any)?.error || `HTTP ${response.status}`
      : (data as string);
    throw new ApiError(message, response.status, (data as any)?.code, data);
  }

  return data as T;
}

/** 汎用リクエスト関数 */
async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers = await getAuthHeaders();

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  return handleResponse<T>(response);
}

/** HTTPメソッド別ショートカット */
export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};

/** 認証関連API */
export const authApi = {
  /**
   * 新規登録
   *
   * 公開鍵は **hex** で送信する（koshi は `/^[0-9a-f]{64}$/i` で検証する）。
   * base64 で送信すると 400 "Invalid public key format" になる。
   *
   * NOTE: koshi 4.0.0 は refreshToken を返さない（`{ token, userId }` のみ）。
   * トークン更新は `POST /api/auth/refresh` が未実装のため利用できない。
   */
  register: (username: string, publicKey: string) =>
    api.post<{ userId: string; token: string; refreshToken?: string }>('/api/auth/register', {
      username,
      publicKey,
    }),

  /**
   * ログイン
   *
   * 署名は **hex** で送信する（サーバは `hexToBytes()` でデコードする）。
   * チャレンジ文字列はサーバと同一の正規化（trim + 小文字化）を使う。
   */
  login: (username: string, signature: string) =>
    api.post<{ userId: string; token: string; refreshToken?: string }>('/api/auth/login', {
      username,
      signature,
    }),

  /** トークンリフレッシュ */
  refresh: (refreshToken: string) =>
    api.post<{ token: string; refreshToken: string }>('/api/auth/refresh', {
      refreshToken,
    }),

  /** ログアウト (サーバーサイドでトークン無効化) */
  logout: () => api.post('/api/auth/logout', {}),
};

/** ユーザー関連API */
export const usersApi = {
  /** 自分 own profile 取得 */
  getMe: () =>
    api.get<{
      id: string;
      username: string;
      displayName?: string;
      bio?: string;
      avatarUrl?: string;
      isAdmin: boolean;
      createdAt: string;
      followersCount: number;
      followingCount: number;
    }>('/api/users/me'),

  /** プロフィール更新 */
  updateMe: (data: { displayName?: string; bio?: string; avatarUrl?: string }) =>
    api.put<{
      id: string;
      username: string;
      displayName?: string;
      bio?: string;
      avatarUrl?: string;
    }>('/api/users/me', data),

  /** ユーザー検索 */
  search: (query: string) =>
    api.get<
      {
        id: string;
        username: string;
        displayName?: string;
        avatarUrl?: string;
      }[]
    >(`/api/users/search/${encodeURIComponent(query)}`),

  /** 特定ユーザー取得 */
  getByUsername: (username: string) =>
    api.get<{
      id: string;
      username: string;
      displayName?: string;
      bio?: string;
      avatarUrl?: string;
      isAdmin: boolean;
      createdAt: string;
      followersCount: number;
      followingCount: number;
      /**
       * ed25519 公開鍵（hex 64 文字）。
       * koshi v5 では `GET /api/users/:username` に含まれる想定。
       * 未実装のサーバでは undefined（署名検証をスキップする）。
       */
      publicKey?: string;
    }>(`/api/users/${username}`),

  /** プッシュ通知トークン登録 */
  registerPushToken: (data: { expoPushToken: string; deviceId?: string }) =>
    api.post('/api/users/me/push-token', data),

  /** プッシュ通知トークン削除 */
  unregisterPushToken: () => api.delete('/api/users/me/push-token'),
};

/** デバイス関連API */
export const devicesApi = {
  /** 自分のデバイス一覧 */
  list: () =>
    api.get<
      {
        id: string;
        userId: string;
        deviceName?: string;
        identityKey: string;
        signedPreKey: string;
        preKeySignature: string;
        oneTimePreKeys: string[];
        createdAt: string;
        lastSeenAt?: string;
      }[]
    >('/api/devices'),

  /** デバイス登録 */
  register: (data: {
    deviceName?: string;
    identityKey: string;
    signedPreKey: string;
    preKeySignature: string;
    oneTimePreKeys: string[];
  }) =>
    api.post<{
      id: string;
      userId: string;
      deviceName?: string;
      identityKey: string;
      signedPreKey: string;
      preKeySignature: string;
      oneTimePreKeys: string[];
      createdAt: string;
      lastSeenAt?: string;
    }>('/api/devices', data),

  /** デバイス削除 */
  remove: (deviceId: string) => api.delete(`/api/devices/${deviceId}`),

  /** 他ユーザーのデバイス取得 (公開鍵のみ) */
  getUserDevices: (userId: string) =>
    api.get<
      {
        id: string;
        userId: string;
        deviceName?: string;
        identityKey: string;
        signedPreKey: string;
        preKeySignature: string;
        oneTimePreKeys: string[];
        createdAt: string;
        lastSeenAt?: string;
      }[]
    >(`/api/devices/user/${userId}`),
};

/** 鍵配布API (X3DH) */
export const keysApi = {
  /** Key Bundle 取得 */
  getBundle: (userId: string, deviceId?: string) =>
    api.get<{
      userId: string;
      deviceId: string;
      bundle: {
        identityKey: string;
        signedPreKey: string;
        preKeySignature: string;
        oneTimePreKeys: string[];
      };
    }>(`/api/keys/bundle/${userId}${deviceId ? `?deviceId=${deviceId}` : ''}`),
};

/** DM API */
export const dmsApi = {
  /** DM一覧取得 */
  list: (params?: { limit?: number; offset?: number; unread?: boolean }) => {
    const searchParams = new URLSearchParams();
    if (params?.limit) searchParams.set('limit', String(params.limit));
    if (params?.offset) searchParams.set('offset', String(params.offset));
    if (params?.unread) searchParams.set('unread', 'true');
    const query = searchParams.toString();
    return api.get<
      {
        id: string;
        from: { id: string; username: string; displayName?: string };
        to: { id: string; username: string; displayName?: string };
        content: string;
        signature: string;
        isRead: boolean;
        createdAt: string;
      }[]
    >(`/api/dms${query ? `?${query}` : ''}`);
  },

  /** DM送信 */
  send: (recipientId: string, content: string, signature: string) =>
    api.post<{
      id: string;
      from: { id: string; username: string; displayName?: string };
      to: { id: string; username: string; displayName?: string };
      content: string;
      signature: string;
      isRead: boolean;
      createdAt: string;
    }>(`/api/dms/${recipientId}`, { content, signature }),

  /** 既読マーク */
  markRead: (dmId: string) => api.put(`/api/dms/${dmId}/read`, {}),

  /** 未読数取得 */
  getUnreadCount: () => api.get<{ count: number }>('/api/dms/unread/count'),
};

/** グループ API */
export const groupsApi = {
  /** 参加グループ一覧 */
  list: (params?: { limit?: number; offset?: number }) => {
    const searchParams = new URLSearchParams();
    if (params?.limit) searchParams.set('limit', String(params.limit));
    if (params?.offset) searchParams.set('offset', String(params.offset));
    const query = searchParams.toString();
    return api.get<
      {
        id: string;
        name: string;
        description?: string;
        avatarUrl?: string;
        createdBy: string;
        isE2EE: boolean;
        createdAt: string;
        updatedAt: string;
        memberCount: number;
        myRole: 'admin' | 'member';
      }[]
    >(`/api/groups${query ? `?${query}` : ''}`);
  },

  /** グループ作成 */
  create: (data: {
    name: string;
    description?: string;
    memberUserIds: string[];
    avatarUrl?: string;
  }) =>
    api.post<{
      group: {
        id: string;
        name: string;
        description?: string;
        avatarUrl?: string;
        createdBy: string;
        isE2EE: boolean;
        createdAt: string;
        updatedAt: string;
        memberCount: number;
        myRole: 'admin' | 'member';
      };
      members: {
        id: string;
        groupId: string;
        role: 'admin' | 'member';
        joinedAt: string;
        user: {
          id: string;
          username: string;
          displayName?: string;
          bio?: string;
          avatarUrl?: string;
          isAdmin: boolean;
          createdAt: string;
        };
      }[];
    }>('/api/groups', data),

  /** グループ詳細取得 */
  get: (groupId: string) =>
    api.get<{
      group: {
        id: string;
        name: string;
        description?: string;
        avatarUrl?: string;
        createdBy: string;
        isE2EE: boolean;
        createdAt: string;
        updatedAt: string;
        memberCount: number;
        myRole: 'admin' | 'member';
      };
      members: {
        id: string;
        groupId: string;
        role: 'admin' | 'member';
        joinedAt: string;
        user: {
          id: string;
          username: string;
          displayName?: string;
          bio?: string;
          avatarUrl?: string;
          isAdmin: boolean;
          createdAt: string;
        };
      }[];
      latestMessage?: {
        id: string;
        groupId: string;
        sender: { id: string; username: string; displayName?: string };
        content: string;
        signature: string;
        messageType: 'text' | 'image' | 'file' | 'system';
        replyTo?: string;
        createdAt: string;
      };
    }>(`/api/groups/${groupId}`),

  /** グループ更新 */
  update: (groupId: string, data: { name?: string; description?: string; avatarUrl?: string }) =>
    api.patch<{
      id: string;
      name: string;
      description?: string;
      avatarUrl?: string;
      createdBy: string;
      isE2EE: boolean;
      createdAt: string;
      updatedAt: string;
    }>(`/api/groups/${groupId}`, data),

  /** グループ削除 */
  delete: (groupId: string) => api.delete(`/api/groups/${groupId}`),

  /** メンバー招待 */
  invite: (groupId: string, userIds: string[]) =>
    api.post<{
      members: {
        id: string;
        groupId: string;
        role: 'admin' | 'member';
        joinedAt: string;
        user: {
          id: string;
          username: string;
          displayName?: string;
          bio?: string;
          avatarUrl?: string;
          isAdmin: boolean;
          createdAt: string;
        };
      }[];
    }>(`/api/groups/${groupId}/members`, { userIds }),

  /** メンバー削除/退出 */
  removeMember: (groupId: string, userId: string) =>
    api.delete(`/api/groups/${groupId}/members/${userId}`),

  /** メッセージ履歴 */
  getMessages: (groupId: string, params?: { limit?: number; offset?: number; before?: string }) => {
    const searchParams = new URLSearchParams();
    if (params?.limit) searchParams.set('limit', String(params.limit));
    if (params?.offset) searchParams.set('offset', String(params.offset));
    if (params?.before) searchParams.set('before', params.before);
    const query = searchParams.toString();
    return api.get<
      {
        id: string;
        groupId: string;
        sender: { id: string; username: string; displayName?: string };
        content: string;
        signature: string;
        messageType: 'text' | 'image' | 'file' | 'system';
        replyTo?: string;
        createdAt: string;
      }[]
    >(`/api/groups/${groupId}/messages${query ? `?${query}` : ''}`);
  },

  /** メッセージ送信 */
  sendMessage: (
    groupId: string,
    data: {
      content: string;
      signature: string;
      messageType?: 'text' | 'image' | 'file';
      replyTo?: string;
    }
  ) =>
    api.post<{
      id: string;
      groupId: string;
      sender: { id: string; username: string; displayName?: string };
      content: string;
      signature: string;
      messageType: 'text' | 'image' | 'file' | 'system';
      replyTo?: string;
      createdAt: string;
    }>(`/api/groups/${groupId}/messages`, data),

  /** 既読マーク */
  markRead: (groupId: string, messageId: string) =>
    api.put(`/api/groups/${groupId}/messages/${messageId}/read`, {}),
};

/** WebSocket ベースURL取得 */
export function getWsUrl(token: string): string {
  return `${WS_BASE_URL}/ws?token=${encodeURIComponent(token)}`;
}

/** 定数エクスポート */
export { API_BASE_URL, WS_BASE_URL, STORAGE_KEYS };
