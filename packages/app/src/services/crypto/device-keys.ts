/**
 * X3DH Device Key Generation & Management
 * Uses @signalapp/libsignal-client for Signal Protocol key operations
 * 
 * Key types:
 * - IdentityKeyPair: Long-term identity key (X25519)
 * - PrivateKey/PublicKey: PreKeys (X25519)
 * - RegistrationId: Unique device identifier (1-16380)
 * 
 * Note: libsignal-client requires React Native JSI / Hermes
 * Must use Expo Development Build (EAS Build) - not Expo Go
 */

import { 
  IdentityKeyPair, 
  PrivateKey, 
  PublicKey,
  PreKeyBundle,
} from '@signalapp/libsignal-client';
import { 
  saveDeviceKeys, 
  loadDeviceKeys, 
  clearDeviceKeys,
  type DeviceKeyBundle,
  getRemainingPreKeys,
  replenishPreKeys,
} from '@/utils/secureStore';
import { devicesApi } from '@/services/api';

/** 定数 */
const ONETIME_PREKEY_COUNT = 100;
const PREKEY_REPLENISH_THRESHOLD = 20;
const PREKEY_REPLENISH_COUNT = 50;

/** 公開鍵を base64 文字列に変換 */
function publicKeyToBase64(publicKey: PublicKey): string {
  return bytesToBase64(publicKey.serialize());
}

/** 秘密鍵を base64 文字列に変換 */
function privateKeyToBase64(privateKey: PrivateKey): string {
  return bytesToBase64(privateKey.serialize());
}

/** base64 を PrivateKey に変換 */
function base64ToPrivateKey(base64: string): PrivateKey {
  return PrivateKey.deserialize(fromBase64(base64));
}

/** base64 を PublicKey に変換 */
function base64ToPublicKey(base64: string): PublicKey {
  return PublicKey.deserialize(fromBase64(base64));
}

/** バイト配列を base64 文字列に変換 */
function bytesToBase64(bytes: Buffer): string {
  return bytes.toString('base64');
}

/** base64 を Uint8Array に変換 */
function fromBase64(base64: string): Buffer {
  return Buffer.from(base64, 'base64');
}

/** 署名用ヘルパー: IdentityKey で SignedPreKey に署名 */
async function signWithIdentityKey(
  identityKeyPrivate: PrivateKey,
  data: Buffer
): Promise<Buffer> {
  const signature = identityKeyPrivate.sign(data);
  return signature;
}

/** デバイス鍵バンドル生成 (初回セットアップ時) */
export async function generateDeviceKeys(deviceName?: string): Promise<DeviceKeyBundle> {
  console.log('[DeviceKeys] Generating new device key bundle...');
  
  const identityKeyPair = IdentityKeyPair.generate();
  const identityKeyPrivate = privateKeyToBase64(identityKeyPair.privateKey);
  const identityKeyPublic = publicKeyToBase64(identityKeyPair.publicKey);
  
  const signedPreKeyPair = PrivateKey.generate();
  const signedPreKeyPrivate = privateKeyToBase64(signedPreKeyPair);
  const signedPreKeyPublic = publicKeyToBase64(signedPreKeyPair.getPublicKey());
  
  const preKeySignatureBytes = await signWithIdentityKey(
    identityKeyPair.privateKey,
    signedPreKeyPair.getPublicKey().serialize()
  );
  const preKeySignature = bytesToBase64(preKeySignatureBytes);
  
  const oneTimePreKeys: Array<{ privateKey: string; publicKey: string; used: boolean }> = [];
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
  
  const registrationId = Math.floor(Math.random() * 16380) + 1;
  
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
    const bundle = await generateDeviceKeys(deviceName);
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
    
    const newKeys: Array<{ privateKey: string; publicKey: string }> = [];
    for (let i = 0; i < PREKEY_REPLENISH_COUNT; i++) {
      const preKey = PrivateKey.generate();
      newKeys.push({
        privateKey: privateKeyToBase64(preKey),
        publicKey: publicKeyToBase64(preKey.getPublicKey()),
      });
    }
    
    await replenishPreKeys(newKeys);
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

/** Registration ID 生成・取得 */
const REGISTRATION_ID_KEY = 'prepito.registration_id';

export async function getOrCreateRegistrationId(): Promise<number> {
  return Math.floor(Math.random() * 16380) + 1;
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
  console.log('  One-Time PreKeys:', bundle.oneTimePreKeys.length, 'total,', 
    bundle.oneTimePreKeys.filter((k: { used: boolean }) => !k.used).length, 'unused');
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
    null,
    base64ToPublicKey(preKey.publicKey),
    1,
    base64ToPublicKey(bundle.signedPreKeyPublic),
    fromBase64(bundle.preKeySignature),
    base64ToPublicKey(bundle.identityKeyPublic)
  );
}
