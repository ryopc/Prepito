/**
 * X3DH Device Key Generation & Management
 *
 * 純 TypeScript 実装 (X25519 + XEdDSA) を使う。
 * libsignal-client の Node 専用ネイティブ依存を排除するため、
 * Expo Development Build (Hermes) でもそのまま動作する。
 *
 * Key types:
 * - IdentityKeyPair: 長期識別鍵 (X25519)
 * - PrivateKey/PublicKey: PreKey (X25519)
 * - RegistrationId: 端末ごとの識別子 (1-16380)
 */

import {
  saveDeviceKeys,
  loadDeviceKeys,
  clearDeviceKeys,
  type DeviceKeyBundle,
  getRemainingPreKeys,
  replenishPreKeys,
} from '@/utils/secureStore';
import { getLocalRegistrationId, storePreKey, storeSignedPreKey } from './signal-store';
import { PreKeyBundle, PrivateKey, PublicKey } from './signal-keys';
import { base64ToBytes, bytesToBase64 } from './bytes';
import { devicesApi } from '@/services/api';
import { setServerDeviceId } from '@/utils/secureStore';

/** 定数 */
const ONETIME_PREKEY_COUNT = 100;
const PREKEY_REPLENISH_THRESHOLD = 20;
const PREKEY_REPLENISH_COUNT = 50;

/**
 * アップロードする one-time prekey の key_id 開始位置
 *
 * 0-99 は初回生成時の prekey (アップロード順と一致させる)、
 * 1000 以降は補充した prekey 用的。
 */
const REPLENISHED_PREKEY_ID_BASE = 1000;

/** signed prekey の ID (PreKeyBundle の signed_pre_key_id と一致させる) */
const SIGNED_PREKEY_ID = 1;

/** 公開鍵を base64 文字列に変換 */
function publicKeyToBase64(publicKey: PublicKey): string {
  return bytesToBase64(publicKey.serialize());
}

/** 秘密鍵を base64 文字列に変換 */
function privateKeyToBase64(privateKey: PrivateKey): string {
  return bytesToBase64(privateKey.serialize());
}

/** base64 を PublicKey に変換 */
function base64ToPublicKey(base64: string): PublicKey {
  return PublicKey.deserialize(base64ToBytes(base64));
}

/** base64 を PrivateKey に変換 */
function base64ToPrivateKey(base64: string): PrivateKey {
  return PrivateKey.deserialize(base64ToBytes(base64));
}

/** デバイス鍵バンドル生成 (初回セットアップ時) */
export async function generateDeviceKeys(): Promise<DeviceKeyBundle> {
  console.log('[DeviceKeys] Generating new device key bundle...');

  const identityKeyPair = PrivateKey.generate();
  const identityKeyPrivate = privateKeyToBase64(identityKeyPair);
  const identityKeyPublic = publicKeyToBase64(identityKeyPair.getPublicKey());

  const signedPreKeyPair = PrivateKey.generate();
  const signedPreKeyPrivate = privateKeyToBase64(signedPreKeyPair);
  const signedPreKeyPublic = publicKeyToBase64(signedPreKeyPair.getPublicKey());

  // signed prekey は identity key で XEdDSA 署名する
  const preKeySignatureBytes = identityKeyPair.sign(signedPreKeyPair.getPublicKey().serialize());
  const preKeySignature = bytesToBase64(preKeySignatureBytes);

  const oneTimePreKeys: { privateKey: string; publicKey: string; used: boolean }[] = [];
  for (let i = 0; i < ONETIME_PREKEY_COUNT; i++) {
    const preKeyPair = PrivateKey.generate();
    oneTimePreKeys.push({
      privateKey: privateKeyToBase64(preKeyPair),
      publicKey: publicKeyToBase64(preKeyPair.getPublicKey()),
      used: false,
    });
  }

  const bundle: DeviceKeyBundle = {
    identityKeyPrivate,
    identityKeyPublic,
    signedPreKeyPrivate,
    signedPreKeyPublic,
    preKeySignature,
    oneTimePreKeys,
  };

  await saveDeviceKeys(bundle);

  // ローカル DB にミラーする (受信側で prekey / signed prekey を解決するため)
  await storeSignedPreKey(SIGNED_PREKEY_ID, {
    privateKey: signedPreKeyPair,
    publicKey: signedPreKeyPair.getPublicKey(),
    signature: preKeySignatureBytes,
  });
  for (let i = 0; i < oneTimePreKeys.length; i++) {
    await storePreKey(i, base64ToPrivateKey(oneTimePreKeys[i].privateKey));
  }

  console.log('[DeviceKeys] Device keys generated and saved locally');
  return bundle;
}

/** 既存鍵読み込み (アプリ起動時) */
export async function loadExistingKeys(): Promise<DeviceKeyBundle | null> {
  return loadDeviceKeys();
}

/** サーバーにデバイス登録 */
export async function registerDeviceWithServer(
  bundle: DeviceKeyBundle,
  deviceName?: string
): Promise<{ id: string } | null> {
  try {
    const result = await devicesApi.register({
      deviceName,
      identityKey: bundle.identityKeyPublic,
      signedPreKey: bundle.signedPreKeyPublic,
      preKeySignature: bundle.preKeySignature,
      oneTimePreKeys: bundle.oneTimePreKeys.map((k: { publicKey: string }) => k.publicKey),
    });
    // サーバが発行したデバイス ID を保存する。
    // プッシュトークンの紐付けと、鍵バンドル取得時の deviceId 指定に必須。
    await setServerDeviceId(String(result.id));
    console.log('[DeviceKeys] Device registered with server:', result.id);
    return result;
  } catch (err) {
    console.error('[DeviceKeys] Failed to register device with server:', err);
    return null;
  }
}

/** 初回セットアップ完全フロー */
export async function runInitialDeviceSetup(deviceName?: string): Promise<boolean> {
  console.log('[DeviceKeys] Starting initial device setup...');

  try {
    const bundle = await generateDeviceKeys();
    const registered = await registerDeviceWithServer(bundle, deviceName);
    if (!registered) {
      throw new Error('Server registration failed');
    }
    console.log('[DeviceKeys] Initial device setup complete');
    return true;
  } catch (err) {
    console.error('[DeviceKeys] Initial setup failed:', err);
    await clearDeviceKeys();
    return false;
  }
}

/** デバイス登録状態確認 */
export async function checkDeviceRegistration(): Promise<boolean> {
  const bundle = await loadExistingKeys();
  if (!bundle) return false;

  try {
    const devices = await devicesApi.list();
    return devices.length > 0;
  } catch {
    return false;
  }
}

/** One-Time PreKey 残数チェック・自動補充 */
export async function checkAndReplenishPreKeys(): Promise<void> {
  const remaining = await getRemainingPreKeys();
  if (remaining <= PREKEY_REPLENISH_THRESHOLD) {
    console.log('[DeviceKeys] PreKeys low (' + remaining + '), replenishing...');

    const newKeys: { privateKey: string; publicKey: string }[] = [];
    for (let i = 0; i < PREKEY_REPLENISH_COUNT; i++) {
      const preKey = PrivateKey.generate();
      newKeys.push({
        privateKey: privateKeyToBase64(preKey),
        publicKey: publicKeyToBase64(preKey.getPublicKey()),
      });
    }

    await replenishPreKeys(newKeys);

    // ローカル DB にもミラーする (key_id は初回分とかぶらない範囲を使う)
    for (let i = 0; i < newKeys.length; i++) {
      await storePreKey(REPLENISHED_PREKEY_ID_BASE + i, base64ToPrivateKey(newKeys[i].privateKey));
    }

    console.log('[DeviceKeys] Replenished ' + newKeys.length + ' prekeys');
  }
}

/** デバイス削除 (ローカル + サーバー) */
export async function removeDevice(deviceId: string): Promise<boolean> {
  try {
    await devicesApi.remove(deviceId);
    await clearDeviceKeys();
    return true;
  } catch (err) {
    console.error('[DeviceKeys] Failed to remove device:', err);
    return false;
  }
}

/**
 * Registration ID を取得 (端末ごとに固定)
 *
 * Signal Protocol の Registration ID はセッションの identity として使われるため、
 * 呼び出しごとに値が変わるとセッションが継続できなくなる。
 * 値は SecureStore に永続化される。
 */
export async function getOrCreateRegistrationId(): Promise<number> {
  return getLocalRegistrationId();
}

/** デバッグ: 鍵情報表示 */
export async function debugPrintKeys(): Promise<void> {
  const bundle = await loadExistingKeys();
  if (!bundle) {
    console.log('[DeviceKeys] No keys found');
    return;
  }

  console.log('[DeviceKeys] Current key bundle:');
  console.log('  Identity Key (pub):', bundle.identityKeyPublic.slice(0, 20) + '...');
  console.log('  Signed PreKey (pub):', bundle.signedPreKeyPublic.slice(0, 20) + '...');
  console.log('  PreKey Signature:', bundle.preKeySignature.slice(0, 20) + '...');
  console.log(
    '  One-Time PreKeys:',
    bundle.oneTimePreKeys.length,
    'total,',
    bundle.oneTimePreKeys.filter((k: { used: boolean }) => !k.used).length,
    'unused'
  );
}

/** PreKeyBundle 作成 (サーバー配布用 / X3DH) */
export async function createPreKeyBundle(
  deviceId: number,
  registrationId: number
): Promise<PreKeyBundle> {
  const bundle = await loadExistingKeys();
  if (!bundle) throw new Error('No device keys loaded');

  const unusedPreKeys = bundle.oneTimePreKeys.filter((k: { used: boolean }) => !k.used);
  const preKey = unusedPreKeys[0];
  if (!preKey) throw new Error('No unused prekeys available');

  preKey.used = true;

  return PreKeyBundle.new(
    registrationId,
    deviceId,
    0,
    base64ToPublicKey(preKey.publicKey),
    SIGNED_PREKEY_ID,
    base64ToPublicKey(bundle.signedPreKeyPublic),
    base64ToBytes(bundle.preKeySignature),
    base64ToPublicKey(bundle.identityKeyPublic)
  );
}
