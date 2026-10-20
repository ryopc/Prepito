/**
 * Notification Service
 *
 * 責務を 2 つに分離する。
 *
 * ## 1. ローカル通知（端末内で発火する通知）
 *
 * 常に有効。F-Droid ビルド（プッシュ無効）でも動作する。
 * 受信 DM の復号 → ストア反映 → 平文での通知表示を担う。
 *
 * ## 2. リモートプッシュ（Expo Push）
 *
 * `app.config.ts` の `extra.enablePushNotifications` で制御する。
 * 既定は true だが、F-Droid ビルドでは `.build-flags.json` に
 * `{"enablePushNotifications": false}` を指定して無効化する。理由:
 *
 * - F-Droid は Google Play Services / Firebase を含むビルドを認めない
 * - Expo Push トークン取得は `exp.host` への常時通信を伴うため、
 *   既定オフ + 明示同意の状態でなければ Anti-Feature「Tracking」に該当しうる
 *
 * なお、この値は APK に埋め込まれる `assets/app.config` 経由で参照される。
 * `assets/app.config` は Gradle ビルド中の `createExpoConfig` タスクが生成する
 * ため、prebuild プロセスへの環境変数指定だけでは反映されない。
 * 詳細は `app.config.ts` のコメントを参照。
 *
 * ## セキュリティ上の制約
 *
 * **通知本文に暗号文（ciphertext）を表示しない。**
 * 表示できない場合は送信者名と定型文のみを表示する。
 * ロック画面にも通知がpreview されるため、平文が露出する可能性がある。
 */

import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { router } from 'expo-router';
import { usersApi } from './api';
import { useAuthStore } from '@/store/auth';
import { useDMStore } from '@/store/dm';
import { getServerDeviceId } from '@/utils/secureStore';
import type { RawDMMessage } from './dm';

/** 通知設定完了フラグ */
let _isConfigured = false;

/** Android の通知チャンネル ID */
const CHANNEL_ID = 'messages';

/**
 * 送信者公開鍵の短期キャッシュ
 *
 * 受信 DM ごとに `GET /api/users/:username` を発行すると通信量が増えるため、
 * セッション内で結果を保持する。TTL 経過後は再取得する。
 */
const PUBLIC_KEY_CACHE_TTL_MS = 5 * 60 * 1000;
const publicKeyCache = new Map<string, { value: string | null; expiresAt: number }>();

/**
 * プッシュ通知の有効判定
 *
 * `app.config.ts` の `extra.enablePushNotifications` で制御する。
 * ローカル通知はこの判定と独立して常に動作する。
 */
export function isPushEnabled(): boolean {
  return Constants.expoConfig?.extra?.enablePushNotifications !== false;
}

/* =====================================================================
   初期化
   ===================================================================== */

/**
 * 通知の初期化
 *
 * - ローカル通知（ハンドラ・チャンネル・リスナー）は常に設定する
 * - リモートプッシュ（権限要求・トークン取得・登録）は有効時のみ行う
 *
 * @returns プッシュ通知が初期化できたか
 */
export async function initializeNotifications(): Promise<boolean> {
  // ローカル通知は常に有効にする（重複初期化は避ける）
  if (!_isConfigured) {
    await setupLocalNotifications();
    _isConfigured = true;
  }

  if (!isPushEnabled()) {
    return false;
  }

  // 実機でない場合はプッシュをスキップ (シミュレータでは FCM/APNs が動作しない)
  if (!Device.isDevice) {
    console.warn('[Notifications] 実機ではないため、プッシュ通知をスキップします');
    return false;
  }

  try {
    // 通知権限の要求
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (finalStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== 'granted') {
      console.warn('[Notifications] 通知権限が拒否されました');
      return false;
    }

    // Expo プッシュトークン取得 → サーバ登録
    await registerPushTokenIfAuthenticated();

    return true;
  } catch (err) {
    console.error('[Notifications] プッシュ通知の初期化に失敗:', err);
    return false;
  }
}

/**
 * ローカル通知のセットアップ
 *
 * フォアグラウンド表示のハンドラ・Android チャンネル・
 * 受信 / タップのリスナーを設定する。
 */
async function setupLocalNotifications(): Promise<void> {
  // フォアグラウンドでも通知を表示する
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    }),
  });

  // Android 用: 通知チャンネル設定
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: 'メッセージ',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#0EA5E9',
    });
  }

  // 通知受信時の処理 (フォアグラウンド / バックグラウンド)
  Notifications.addNotificationReceivedListener((notification) => {
    void handleReceivedNotification(notification);
  });

  // 通知タップ時の処理
  Notifications.addNotificationResponseReceivedListener((response) => {
    void handleNotificationResponse(response);
  });
}

/* =====================================================================
   DM 通知
   ===================================================================== */

/**
 * 受信 DM を処理する
 *
 * WebSocket とプッシュ通知の双方から呼ばれる唯一の入口。
 * 以下の順で処理する。
 *
 * 1. Signal Protocol で復号し、DM ストアへ反映する
 * 2. 復号できた場合は平文を、できなかった場合は定型文を通知表示する
 *
 * @param raw サーバから受信した DM
 */
export async function handleIncomingDM(raw: RawDMMessage): Promise<void> {
  const senderPublicKey = await getSenderPublicKey(raw.from.username);

  // 1. 復号 + ストア反映（ストア側で重複排除される）
  await useDMStore.getState().receiveMessage(raw, senderPublicKey);

  // 2. 復号結果を取り出す
  const decrypted = useDMStore.getState().messages.find((m) => m.id === raw.id);

  const senderName = raw.from.displayName || raw.from.username;

  // 復号できなかった場合、暗号文をそのまま表示しない
  let body: string;
  if (decrypted?.decryptionFailed) {
    body = '復号できないメッセージがあります';
  } else if (decrypted?.plaintext?.trim()) {
    body = decrypted.plaintext.trim();
  } else {
    body = '新しいメッセージがあります';
  }

  await presentLocalNotification({
    title: senderName,
    body,
    data: { type: 'dm', conversationId: raw.from.id, username: raw.from.username },
  });
}

/**
 * 送信者の ed25519 公開鍵を取得する
 *
 * サーバの `GET /api/users/:username` が `publicKey`（hex）を返す場合に取得できる。
 * 返さない場合（未実装のサーバ）は null を返し、署名検証をスキップする
 * （暗号文の真正性は Double Ratchet の MAC で担保される）。
 *
 * 受信ごとに HTTP を発行しないよう、メモリ上に短期キャッシュする。
 */
async function getSenderPublicKey(username: string): Promise<string | null> {
  const cached = publicKeyCache.get(username);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  let publicKey: string | null = null;
  try {
    const profile = await usersApi.getByUsername(username);
    publicKey = profile.publicKey && profile.publicKey.length > 0 ? profile.publicKey : null;
  } catch {
    publicKey = null;
  }

  publicKeyCache.set(username, {
    value: publicKey,
    expiresAt: Date.now() + PUBLIC_KEY_CACHE_TTL_MS,
  });
  return publicKey;
}

/* =====================================================================
   プッシュ通知
   ===================================================================== */

/**
 * プッシュトークンをサーバへ登録する
 *
 * サーバ側の `/api/users/me/push-token` は `deviceId` を受け取れる。
 * これを指定することで、サーバが
 * - 正しいデバイスへ通知を配信できる
 * - 通知に送信者のデバイス ID を含められる（複数端末での E2E 配送に必要）
 */
export async function registerPushTokenIfAuthenticated(): Promise<void> {
  if (!isPushEnabled()) return;
  if (!Device.isDevice) return;

  // サーバは JWT からユーザーを特定するため、プロフィール取得の完了に
  // 依存させない（`GET /api/users/me` が未実装のサーバでも登録できる）。
  const { isAuthenticated } = useAuthStore.getState();
  if (!isAuthenticated) return;

  try {
    const tokenData = await Notifications.getExpoPushTokenAsync();
    const deviceId = await getServerDeviceId();
    await usersApi.registerPushToken({
      expoPushToken: tokenData.data,
      ...(deviceId ? { deviceId } : {}),
    });
  } catch (err) {
    console.error('[Notifications] トークン登録に失敗:', err);
  }
}

/** プッシュトークン登録解除 (ログアウト時) */
export async function unregisterPushTokenIfAuthenticated(): Promise<void> {
  if (!isPushEnabled()) return;

  try {
    await usersApi.unregisterPushToken();
  } catch (err) {
    console.error('[Notifications] トークン登録解除に失敗:', err);
  }
}

/* =====================================================================
   ローカル通知
   ===================================================================== */

/**
 * ローカル通知を表示する
 *
 * プッシュ通知の有効・無効に依存しない。
 */
export async function presentLocalNotification(options: {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}): Promise<void> {
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: options.title,
        body: options.body,
        data: options.data ?? {},
      },
      trigger: null, // 即時通知
    });
  } catch (err) {
    console.error('[Notifications] ローカル通知の表示に失敗:', err);
  }
}

/** ローカル通知を送信 (テスト・デバッグ用) */
export async function sendLocalNotification(title: string, body: string): Promise<void> {
  await presentLocalNotification({ title, body, data: { type: 'test' } });
}

/* =====================================================================
   通知の受信 / タップ
   ===================================================================== */

/**
 * 通知を受信したときの処理
 *
 * プッシュ通知の data に DM が含まれていれば、復号して通知内容を更新する。
 * サーバーからは次の形式を想定する。
 *
 * ```json
 * { "type": "dm_received", "dm": { "id": "...", "from": {...}, "content": "..." } }
 * ```
 */
async function handleReceivedNotification(notification: Notifications.Notification): Promise<void> {
  const data = notification.request.content.data as Record<string, unknown> | undefined;
  if (!data) return;

  const raw = parseRawDM(data);
  if (!raw) return;

  // すでにストアへ反映済み（WebSocket 経由で受信済み）なら通知のみ更新する
  const existing = useDMStore.getState().messages.find((m) => m.id === raw.id);
  if (existing) {
    await presentLocalNotification({
      title: raw.from.displayName || raw.from.username,
      body: existing.plaintext?.trim() || '新しいメッセージがあります',
      data: { type: 'dm', conversationId: raw.from.id, username: raw.from.username },
    });
    return;
  }

  await handleIncomingDM(raw);
}

/**
 * 通知がタップされたときの処理
 *
 * 該当する会話画面へ遷移する。
 */
async function handleNotificationResponse(
  response: Notifications.NotificationResponse
): Promise<void> {
  const data = response.notification.request.content.data as Record<string, unknown> | undefined;
  if (!data) return;

  if (data.type === 'dm' && typeof data.conversationId === 'string') {
    router.push(`/chats/${data.conversationId}`);
  }
}

/**
 * 通知 payload から RawDMMessage を抽出する
 *
 * `dm` オブジェクト形式とフラット形式の両方を受け付ける。
 */
function parseRawDM(data: Record<string, unknown>): RawDMMessage | null {
  const source = (data.dm ?? data) as Record<string, unknown>;
  const from = source.from as RawDMMessage['from'] | undefined;

  if (!from?.id || !from?.username || typeof source.content !== 'string') {
    return null;
  }

  return {
    id: String(source.id ?? ''),
    from: {
      id: from.id,
      username: from.username,
      displayName: from.displayName,
    },
    to: (source.to as RawDMMessage['to']) ?? { id: '', username: '' },
    content: source.content,
    signature: typeof source.signature === 'string' ? source.signature : '',
    isRead: source.isRead === true,
    createdAt:
      typeof source.createdAt === 'string'
        ? source.createdAt
        : typeof source.timestamp === 'string'
          ? source.timestamp
          : new Date().toISOString(),
  };
}

/* =====================================================================
   デバイス ID
   ===================================================================== */

export { getServerDeviceId, setServerDeviceId, clearServerDeviceId } from '@/utils/secureStore';

/* =====================================================================
   権限状態
   ===================================================================== */

/** 通知権限状態 */
export interface NotificationStatus {
  /** ビルドフラグでプッシュ通知が有効化されているか */
  enabled: boolean;
  /** expo-notifications の権限状態 ('granted' | 'denied' | 'undetermined') */
  status: string;
  granted: boolean;
  canAskAgain: boolean;
}

/** 通知権限状態取得 */
export async function getNotificationStatus(): Promise<NotificationStatus> {
  if (!isPushEnabled()) {
    return {
      enabled: false,
      status: 'denied',
      granted: false,
      canAskAgain: false,
    };
  }

  const { status, granted, canAskAgain } = await Notifications.getPermissionsAsync();
  return { enabled: true, status: String(status), granted, canAskAgain };
}
