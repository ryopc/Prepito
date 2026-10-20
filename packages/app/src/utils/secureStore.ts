/**
 * SecureStore Utilities
 * Wrapper for expo-secure-store with fallback and type safety
 */

import * as SecureStore from 'expo-secure-store';

/** 利用可能かチェック */
export async function isSecureStoreAvailable(): Promise<boolean> {
  try {
    return await SecureStore.isAvailableAsync();
  } catch {
    return false;
  }
}

/** 汎用 get/set/delete */
export async function getSecureItem(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch (err) {
    console.warn(`[SecureStore] Failed to get ${key}:`, err);
    return null;
  }
}

export async function setSecureItem(key: string, value: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(key, value);
  } catch (err) {
    console.error(`[SecureStore] Failed to set ${key}:`, err);
    throw err;
  }
}

export async function deleteSecureItem(key: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(key);
  } catch (err) {
    console.warn(`[SecureStore] Failed to delete ${key}:`, err);
  }
}

/** JSON 値の保存/取得 */
export async function getSecureJson<T>(key: string): Promise<T | null> {
  const value = await getSecureItem(key);
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export async function setSecureJson<T>(key: string, value: T): Promise<void> {
  await setSecureItem(key, JSON.stringify(value));
}

/** キープレフィックス (アプリ固有) */
const PREFIX = 'prepito.';

export const SecureKeys = {
  // Auth
  ACCESS_TOKEN: `${PREFIX}access_token`,
  REFRESH_TOKEN: `${PREFIX}refresh_token`,
  USER_ID: `${PREFIX}user_id`,
  USERNAME: `${PREFIX}username`,

  // Device Keys (E2E)
  IDENTITY_KEY_PRIVATE: `${PREFIX}identity_key_private`,
  IDENTITY_KEY_PUBLIC: `${PREFIX}identity_key_public`,
  SIGNED_PRE_KEY_PRIVATE: `${PREFIX}signed_pre_key_private`,
  SIGNED_PRE_KEY_PUBLIC: `${PREFIX}signed_pre_key_public`,
  PRE_KEY_SIGNATURE: `${PREFIX}pre_key_signature`,
  ONE_TIME_PRE_KEYS: `${PREFIX}one_time_pre_keys`, // JSON array of { private, public, used }

  // Session State (Signal Protocol)
  SESSION_STATE: `${PREFIX}session_state_`, // + conversationId
  SENDER_KEY_STATE: `${PREFIX}sender_key_state_`, // + groupId

  /** サーバが発行したデバイス ID（/api/devices の id） */
  SERVER_DEVICE_ID: `${PREFIX}server_device_id`,

  // Settings
  APP_LOCK_ENABLED: `${PREFIX}app_lock_enabled`,
  BIOMETRIC_ENABLED: `${PREFIX}biometric_enabled`,
  PUSH_ENABLED: `${PREFIX}push_enabled`,
  PUSH_SERVER: `${PREFIX}push_server`,
  QUIET_HOURS_START: `${PREFIX}quiet_hours_start`,
  QUIET_HOURS_END: `${PREFIX}quiet_hours_end`,
} as const;

/** デバイスキー一括保存 */
export interface DeviceKeyBundle {
  identityKeyPrivate: string; // base64
  identityKeyPublic: string; // base64
  signedPreKeyPrivate: string; // base64
  signedPreKeyPublic: string; // base64
  preKeySignature: string; // base64
  oneTimePreKeys: { privateKey: string; publicKey: string; used: boolean }[];
}

export async function saveDeviceKeys(bundle: DeviceKeyBundle): Promise<void> {
  await Promise.all([
    setSecureItem(SecureKeys.IDENTITY_KEY_PRIVATE, bundle.identityKeyPrivate),
    setSecureItem(SecureKeys.IDENTITY_KEY_PUBLIC, bundle.identityKeyPublic),
    setSecureItem(SecureKeys.SIGNED_PRE_KEY_PRIVATE, bundle.signedPreKeyPrivate),
    setSecureItem(SecureKeys.SIGNED_PRE_KEY_PUBLIC, bundle.signedPreKeyPublic),
    setSecureItem(SecureKeys.PRE_KEY_SIGNATURE, bundle.preKeySignature),
    setSecureItem(SecureKeys.ONE_TIME_PRE_KEYS, JSON.stringify(bundle.oneTimePreKeys)),
  ]);
}

export async function loadDeviceKeys(): Promise<DeviceKeyBundle | null> {
  try {
    const [
      identityKeyPrivate,
      identityKeyPublic,
      signedPreKeyPrivate,
      signedPreKeyPublic,
      preKeySignature,
      oneTimePreKeysJson,
    ] = await Promise.all([
      getSecureItem(SecureKeys.IDENTITY_KEY_PRIVATE),
      getSecureItem(SecureKeys.IDENTITY_KEY_PUBLIC),
      getSecureItem(SecureKeys.SIGNED_PRE_KEY_PRIVATE),
      getSecureItem(SecureKeys.SIGNED_PRE_KEY_PUBLIC),
      getSecureItem(SecureKeys.PRE_KEY_SIGNATURE),
      getSecureItem(SecureKeys.ONE_TIME_PRE_KEYS),
    ]);

    if (
      !identityKeyPrivate ||
      !identityKeyPublic ||
      !signedPreKeyPrivate ||
      !signedPreKeyPublic ||
      !preKeySignature
    ) {
      return null;
    }

    return {
      identityKeyPrivate,
      identityKeyPublic,
      signedPreKeyPrivate,
      signedPreKeyPublic,
      preKeySignature,
      oneTimePreKeys: oneTimePreKeysJson ? JSON.parse(oneTimePreKeysJson) : [],
    };
  } catch {
    return null;
  }
}

export async function clearDeviceKeys(): Promise<void> {
  await Promise.all([
    deleteSecureItem(SecureKeys.IDENTITY_KEY_PRIVATE),
    deleteSecureItem(SecureKeys.IDENTITY_KEY_PUBLIC),
    deleteSecureItem(SecureKeys.SIGNED_PRE_KEY_PRIVATE),
    deleteSecureItem(SecureKeys.SIGNED_PRE_KEY_PUBLIC),
    deleteSecureItem(SecureKeys.PRE_KEY_SIGNATURE),
    deleteSecureItem(SecureKeys.ONE_TIME_PRE_KEYS),
  ]);
}

/** 未使用 One-Time PreKey 取得・消費 */
export async function consumeOneTimePreKey(): Promise<{
  privateKey: string;
  publicKey: string;
} | null> {
  const bundle = await loadDeviceKeys();
  if (!bundle) return null;

  const unusedIndex = bundle.oneTimePreKeys.findIndex((k) => !k.used);
  if (unusedIndex === -1) return null;

  const key = bundle.oneTimePreKeys[unusedIndex];
  bundle.oneTimePreKeys[unusedIndex] = { ...key, used: true };

  await setSecureItem(SecureKeys.ONE_TIME_PRE_KEYS, JSON.stringify(bundle.oneTimePreKeys));
  return { privateKey: key.privateKey, publicKey: key.publicKey };
}

/** One-Time PreKey 残数確認 */
export async function getRemainingPreKeys(): Promise<number> {
  const bundle = await loadDeviceKeys();
  if (!bundle) return 0;
  return bundle.oneTimePreKeys.filter((k) => !k.used).length;
}

/** One-Time PreKey 補充 (閾値下回った時に呼ぶ) */
export async function replenishPreKeys(
  newKeys: { privateKey: string; publicKey: string }[]
): Promise<void> {
  const bundle = await loadDeviceKeys();
  if (!bundle) return;

  bundle.oneTimePreKeys.push(...newKeys.map((k) => ({ ...k, used: false })));
  await setSecureItem(SecureKeys.ONE_TIME_PRE_KEYS, JSON.stringify(bundle.oneTimePreKeys));
}

/* =====================================================================
   サーバ発行デバイス ID
   ===================================================================== */

/**
 * サーバが発行したデバイス ID（`POST /api/devices` の `id`）を取得する
 *
 * - プッシュトークンの紐付け（`POST /api/users/me/push-token` の deviceId）
 * - 鍵バンドル取得（`GET /api/keys/bundle/:userId?deviceId=`）に必須
 */
export async function getServerDeviceId(): Promise<string | null> {
  try {
    return await getSecureItem(SecureKeys.SERVER_DEVICE_ID);
  } catch {
    return null;
  }
}

/** サーバが発行したデバイス ID を保存する */
export async function setServerDeviceId(deviceId: string): Promise<void> {
  await setSecureItem(SecureKeys.SERVER_DEVICE_ID, deviceId);
}

/** サーバが発行したデバイス ID を削除する（ログアウト時） */
export async function clearServerDeviceId(): Promise<void> {
  await deleteSecureItem(SecureKeys.SERVER_DEVICE_ID);
}
