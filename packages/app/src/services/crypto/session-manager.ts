/**
 * Session Manager
 * High-level API for E2E encryption operations:
 * - X3DH Key Agreement (session establishment via processPreKeyBundle)
 * - Double Ratchet encryption/decryption (signalEncrypt/signalDecrypt)
 * - Group Sender Key management (groupEncrypt/groupDecrypt)
 * - Session state management
 *
 * libsignal-client v0.40 API:
 *   ProtocolAddress, signalEncrypt, signalDecrypt, signalDecryptPreKey,
 *   processPreKeyBundle, groupEncrypt, groupDecrypt, CiphertextMessageType
 */

import {
  ProtocolAddress,
  PreKeyBundle,
  SessionRecord,
  SenderKeyRecord,
  SenderKeyDistributionMessage,
  CiphertextMessage,
  CiphertextMessageType,
  SignalMessage,
  PreKeySignalMessage,
  KyberPreKeyStore,
  KyberPreKeyRecord,
  PrivateKey,
  PublicKey,
  signalEncrypt,
  signalDecrypt,
  signalDecryptPreKey,
  processPreKeyBundle,
  groupEncrypt,
  groupDecrypt,
} from '@signalapp/libsignal-client';
import {
  SignalSessionStore,
  SignalIdentityStore,
  SignalPreKeyStore,
  SignalSignedPreKeyStore,
  SignalSenderKeyStore,
  loadPreKey,
  storePreKey,
  getUnusedPreKeys,
  markPreKeyUsed,
  getPreKeyCount,
  loadSignedPreKey,
  storeSignedPreKey,
  getIdentityKey,
  getLocalRegistrationId,
  getDeviceKeyBundle,
} from './signal-store';
import {
  generateDeviceKeys,
  runInitialDeviceSetup,
  checkDeviceRegistration,
} from './device-keys';
import { devicesApi, keysApi } from '../../services/api';

/* =====================================================================
   Store instances (singletons)
   ===================================================================== */

const sessionStore = new SignalSessionStore();
const identityStore = new SignalIdentityStore();
const preKeyStore = new SignalPreKeyStore();
const signedPreKeyStore = new SignalSignedPreKeyStore();
const senderKeyStore = new SignalSenderKeyStore();

/** Kyber PreKey スタブ (libsignal-client v0.40 は signalDecryptPreKey に必須) */
class SignalKyberPreKeyStore extends KyberPreKeyStore {
  async saveKyberPreKey(_kyberPreKeyId: number, _record: KyberPreKeyRecord): Promise<void> {
    // Kyber prekeys 未使用
  }
  async getKyberPreKey(_kyberPreKeyId: number): Promise<KyberPreKeyRecord> {
    throw new Error('Kyber prekeys are not supported');
  }
  async markKyberPreKeyUsed(_kyberPreKeyId: number): Promise<void> {
    // no-op
  }
}
const kyberPreKeyStore = new SignalKyberPreKeyStore();

/* =====================================================================
   Types
   ===================================================================== */

export type ConversationType = 'dm' | 'group';

export interface EncryptionResult {
  ciphertext: string;
  messageType: number;
}

export interface DecryptionResult {
  plaintext: string;
  senderKeyDistribution?: SenderKeyRecord;
}

export interface SessionInfo {
  conversationId: string;
  conversationType: ConversationType;
  isEstablished: boolean;
  lastUsedAt: number;
}

export interface OutgoingMessagePayload {
  ciphertext: string;
  type: number;
  registrationId?: number;
}

export interface IncomingMessagePayload {
  ciphertext: string;
  type: number;
  senderKeyDistribution?: SenderKeyRecord;
}

/* =====================================================================
   Helpers
   ===================================================================== */

function toBase64(bytes: Uint8Array | Buffer): string {
  return Buffer.from(bytes).toString('base64');
}

function fromBase64(base64: string): Buffer {
  return Buffer.from(base64, 'base64');
}

function addressFor(conversationId: string, deviceId: number): ProtocolAddress {
  return ProtocolAddress.new(conversationId, deviceId);
}

const DEFAULT_DEVICE_ID = 1;

/* =====================================================================
   Session Manager Class
   ===================================================================== */

export class SessionManager {
  private static instance: SessionManager;

  static getInstance(): SessionManager {
    if (!SessionManager.instance) {
      SessionManager.instance = new SessionManager();
    }
    return SessionManager.instance;
  }

  private constructor() {}

  /* -----------------------------------------------------------------
     Initialization
     ----------------------------------------------------------------- */

  async isDeviceReady(): Promise<boolean> {
    return checkDeviceRegistration();
  }

  async ensureDeviceSetup(deviceName?: string): Promise<boolean> {
    const ready = await this.isDeviceReady();
    if (ready) return true;
    return runInitialDeviceSetup(deviceName);
  }

  /* -----------------------------------------------------------------
     X3DH Key Agreement (Session Establishment)
     ----------------------------------------------------------------- */

  /** 1:1 セッション確立 (X3DH) */
  async establishSession(
    recipientUserId: string,
    recipientDeviceId: number = DEFAULT_DEVICE_ID
  ): Promise<SessionRecord> {
    console.log('[SessionManager] Establishing session with', recipientUserId);

    const registrationId = await getLocalRegistrationId();

    // 相手の KeyBundle 取得 (サーバー)
    const bundleResponse = await keysApi.getBundle(recipientUserId, String(recipientDeviceId));
    const preKeyBundle = this.convertToPreKeyBundle(bundleResponse.bundle, recipientDeviceId, registrationId);

    const address = addressFor(recipientUserId, recipientDeviceId);

    // X3DH: プロセスPreKeyバンドル → セッション生成・保存
    await processPreKeyBundle(preKeyBundle, address, sessionStore, identityStore);

    const session = await sessionStore.getSession(address);
    if (!session) throw new Error('Session creation failed');

    console.log('[SessionManager] Session established with', recipientUserId);
    return session;
  }

  /** 相手からの PreKeySignalMessage を処理してセッション確立 */
  async processPreKeyMessage(
    senderUserId: string,
    preKeyMessage: Uint8Array,
    senderDeviceId: number
  ): Promise<SessionRecord> {
    console.log('[SessionManager] Processing PreKey message from', senderUserId);

    const address = addressFor(senderUserId, senderDeviceId);

    const message = PreKeySignalMessage.deserialize(Buffer.from(preKeyMessage));

    await signalDecryptPreKey(
      message,
      address,
      sessionStore,
      identityStore,
      preKeyStore,
      signedPreKeyStore,
      kyberPreKeyStore
    );

    const session = await sessionStore.getSession(address);
    if (!session) throw new Error('Session creation from PreKey message failed');

    console.log('[SessionManager] Session established from PreKey message with', senderUserId);
    return session;
  }

  /** PreKeyBundle を libsignal 形式に変換 (サーバー応答 → PreKeyBundle) */
  private convertToPreKeyBundle(bundle: any, deviceId: number, registrationId: number): PreKeyBundle {
    const oneTimePreKeys: string[] = bundle.oneTimePreKeys || [];
    const preKeyPublic = oneTimePreKeys.length > 0 ? base64ToPublicKey(oneTimePreKeys[0]) : null;

    return PreKeyBundle.new(
      registrationId,
      deviceId,
      null, // prekey_id (サーバー応答に含まれない)
      preKeyPublic,
      1, // signed_prekey_id
      base64ToPublicKey(bundle.signedPreKey),
      fromBase64(bundle.preKeySignature),
      base64ToPublicKey(bundle.identityKey)
    );
  }

  /* -----------------------------------------------------------------
     Message Encryption/Decryption (Double Ratchet)
     ----------------------------------------------------------------- */

  /** メッセージ暗号化 (送信) */
  async encryptMessage(
    conversationId: string,
    conversationType: ConversationType,
    plaintext: string
  ): Promise<OutgoingMessagePayload> {
    const address = addressFor(conversationId, DEFAULT_DEVICE_ID);

    let session = await sessionStore.getSession(address);
    if (!session) {
      if (conversationType === 'dm') {
        await this.establishSession(conversationId, DEFAULT_DEVICE_ID);
        session = await sessionStore.getSession(address);
      }
      if (!session) throw new Error('No session established');
    }

    const plaintextBytes = new TextEncoder().encode(plaintext);
    const ciphertext: CiphertextMessage = await signalEncrypt(
      Buffer.from(plaintextBytes),
      address,
      sessionStore,
      identityStore
    );

    return {
      ciphertext: toBase64(ciphertext.serialize()),
      type: ciphertext.type(),
      registrationId: await getLocalRegistrationId(),
    };
  }

  /** メッセージ復号化 (受信) */
  async decryptMessage(
    conversationId: string,
    conversationType: ConversationType,
    payload: IncomingMessagePayload
  ): Promise<DecryptionResult> {
    const address = addressFor(conversationId, DEFAULT_DEVICE_ID);

    const ciphertext = fromBase64(payload.ciphertext);

    let session = await sessionStore.getSession(address);
    if (!session) {
      if (payload.type === CiphertextMessageType.PreKey) {
        throw new Error('Session not established and cannot build from incoming message automatically');
      }
      throw new Error('No session established for decryption');
    }

    if (payload.type === CiphertextMessageType.PreKey) {
      const preKeyMessage = PreKeySignalMessage.deserialize(ciphertext);
      const plaintext = await signalDecryptPreKey(
        preKeyMessage,
        address,
        sessionStore,
        identityStore,
        preKeyStore,
        signedPreKeyStore,
        kyberPreKeyStore
      );
      return { plaintext: new TextDecoder().decode(plaintext) };
    }

    const signalMessage = SignalMessage.deserialize(ciphertext);
    const plaintext = await signalDecrypt(signalMessage, address, sessionStore, identityStore);
    return { plaintext: new TextDecoder().decode(plaintext) };
  }

  /* -----------------------------------------------------------------
     Group Encryption (Sender Keys)
     ----------------------------------------------------------------- */

  /** グループ Sender Key 初期化 */
  async createGroupSenderKey(groupId: string): Promise<void> {
    const sender = addressFor(groupId, DEFAULT_DEVICE_ID);
    const distributionId = String(await getLocalRegistrationId());
    await SenderKeyDistributionMessage.create(sender, distributionId, senderKeyStore);
  }

  /** グループメッセージ暗号化 */
  async encryptGroupMessage(
    groupId: string,
    plaintext: string
  ): Promise<OutgoingMessagePayload> {
    const registrationId = await getLocalRegistrationId();
    const distributionId = String(registrationId);
    const sender = addressFor(groupId, DEFAULT_DEVICE_ID);

    const existing = await senderKeyStore.getSenderKey(sender, distributionId);
    if (!existing) {
      await this.createGroupSenderKey(groupId);
    }

    const plaintextBytes = new TextEncoder().encode(plaintext);
    const ciphertext: CiphertextMessage = await groupEncrypt(
      sender,
      distributionId,
      senderKeyStore,
      Buffer.from(plaintextBytes)
    );

    return {
      ciphertext: toBase64(ciphertext.serialize()),
      type: CiphertextMessageType.SenderKey,
      registrationId,
    };
  }

  /** グループメッセージ復号化 */
  async decryptGroupMessage(
    groupId: string,
    senderUserId: string,
    payload: IncomingMessagePayload
  ): Promise<DecryptionResult> {
    const sender = addressFor(senderUserId, DEFAULT_DEVICE_ID);
    const ciphertext = fromBase64(payload.ciphertext);

    const plaintext = await groupDecrypt(sender, senderKeyStore, ciphertext);
    return { plaintext: new TextDecoder().decode(plaintext) };
  }

  /** メンバー追加時の Sender Key 再配布 */
  async rotateGroupSenderKeys(groupId: string, newMembers: string[]): Promise<void> {
    await this.createGroupSenderKey(groupId);
    console.log('[SessionManager] Rotated sender keys for group', groupId);
  }

  /* -----------------------------------------------------------------
     Session State Management
     ----------------------------------------------------------------- */

  async getActiveSessions(): Promise<SessionInfo[]> {
    return [{
      conversationId: '',
      conversationType: 'dm',
      isEstablished: true,
      lastUsedAt: Date.now(),
    }];
  }

  async deleteSession(conversationId: string, conversationType: ConversationType): Promise<void> {
    const address = addressFor(conversationId, DEFAULT_DEVICE_ID);
    await sessionStore.deleteSession(address);
  }

  async clearAllSessions(): Promise<void> {
    await sessionStore.deleteAllSessions();
  }

  /* -----------------------------------------------------------------
     PreKey Management
     ----------------------------------------------------------------- */

  async consumePreKey(keyId: number) {
    const records = await getUnusedPreKeys();
    const target = records.find(r => r.keyId === keyId);
    return target ?? null;
  }

  async replenishPreKeysIfNeeded(): Promise<void> {
    const { unused } = await getPreKeyCount();
    if (unused <= 20) {
      for (let i = 0; i < 50; i++) {
        const preKey = PrivateKey.generate();
        await storePreKey(i, preKey);
      }
    }
  }

  async rotateSignedPreKey(): Promise<void> {
    const privateKey = await getIdentityKey();
    const signedPreKeyPair = PrivateKey.generate();
    const signedPreKeyId = Math.floor(Math.random() * 16380) + 1;
    const signature = privateKey.sign(signedPreKeyPair.getPublicKey().serialize());
    await storeSignedPreKey(signedPreKeyId, {
      privateKey: signedPreKeyPair,
      publicKey: signedPreKeyPair.getPublicKey(),
      signature,
    });
    console.log('[SessionManager] Rotated signed prekey');
  }

  /* -----------------------------------------------------------------
     Utility: Key Bundle 取得 (自分用)
     ----------------------------------------------------------------- */

  async getMyKeyBundle(deviceId: number = DEFAULT_DEVICE_ID): Promise<any> {
    const bundle = await getDeviceKeyBundle();
    if (!bundle) throw new Error('Device keys not initialized');

    const unusedPreKeys = await getUnusedPreKeys();
    const preKey = unusedPreKeys[0];
    if (!preKey) throw new Error('No unused prekeys available');

    await markPreKeyUsed(preKey.keyId);

    return {
      userId: bundle.public_key,
      deviceId,
      bundle: {
        identityKey: bundle.public_key,
        signedPreKey: '',
        preKeySignature: '',
        oneTimePreKeys: [preKey.privateKey],
      },
    };
  }
}

/* =====================================================================
   High-level API Functions
   ===================================================================== */

export function getSessionManager(): SessionManager {
  return SessionManager.getInstance();
}

export async function encryptForDM(recipientUserId: string, plaintext: string): Promise<OutgoingMessagePayload> {
  const manager = getSessionManager();
  await manager.ensureDeviceSetup();

  const address = addressFor(recipientUserId, DEFAULT_DEVICE_ID);
  let session = await sessionStore.getSession(address);
  if (!session) {
    await manager.establishSession(recipientUserId);
    session = await sessionStore.getSession(address);
  }

  return manager.encryptMessage(recipientUserId, 'dm', plaintext);
}

export async function decryptFromDM(senderUserId: string, ciphertext: string, type: number): Promise<string> {
  const manager = getSessionManager();
  const result = await manager.decryptMessage(senderUserId, 'dm', { ciphertext, type });
  return result.plaintext;
}

export async function encryptForGroup(groupId: string, plaintext: string): Promise<OutgoingMessagePayload> {
  const manager = getSessionManager();
  await manager.ensureDeviceSetup();
  return manager.encryptGroupMessage(groupId, plaintext);
}

export async function decryptFromGroup(groupId: string, senderUserId: string, ciphertext: string, type: number): Promise<string> {
  const manager = getSessionManager();
  const result = await manager.decryptGroupMessage(groupId, senderUserId, { ciphertext, type });
  return result.plaintext;
}

/* =====================================================================
   Base64 helpers for PreKeyBundle conversion
   ===================================================================== */

function base64ToPublicKey(base64: string): PublicKey {
  return PublicKey.deserialize(fromBase64(base64));
}
