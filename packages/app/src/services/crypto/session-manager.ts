/**
 * Session Manager
 * High-level API for E2E encryption operations:
 * - X3DH Key Agreement (session establishment)
 * - Double Ratchet encryption/decryption
 * - Session state management
 *
 * libsignal-client v0.40 の API シグネチャを維持しつつ、
 * 内部実装は純 TypeScript (X3DH + Double Ratchet) に置き換えたもの。
 *
 * グループ (Sender Key)  messaging は未実装のため unsupported を投げる。
 */

import { PreKeyBundle, PrivateKey, ProtocolAddress, PublicKey } from './signal-keys';
import { CiphertextMessageType, PreKeySignalMessage, SignalMessage } from './signal-message';
import type { SessionState } from './signal-session';
import {
  decryptMessage,
  encryptMessage,
  processPreKeyBundle,
  processPreKeyMessage,
} from './signal-session';
import {
  SignalIdentityStore,
  SignalPreKeyStore,
  SignalSenderKeyStore,
  SignalSessionStore,
  SignalSignedPreKeyStore,
  getDeviceKeyBundle,
  getLocalRegistrationId,
  getPreKeyCount,
  getUnusedPreKeys,
  loadSignedPreKey,
  markPreKeyUsed,
  storePreKey,
  storeSignedPreKey,
} from './signal-store';
import { base64ToBytes, bytesToBase64, utf8Decode, utf8Encode } from './bytes';
import { runInitialDeviceSetup, checkDeviceRegistration } from './device-keys';
import { keysApi } from '../../services/api';

/* =====================================================================
   Store instances (singletons)
   ===================================================================== */

const sessionStore = new SignalSessionStore();
const identityStore = new SignalIdentityStore();
const preKeyStore = new SignalPreKeyStore();
const signedPreKeyStore = new SignalSignedPreKeyStore();
const senderKeyStore = new SignalSenderKeyStore();

/**
 * Kyber PreKey スタブ
 *
 * libsignal-client v0.40 は Kyber (PQC) 前提の wire format を持つが、
 * 本実装は Kyber 非対応 (message_version = 3) のため未サポートとする。
 */
class SignalKyberPreKeyStore {
  async saveKyberPreKey(): Promise<void> {
    // Kyber prekeys 未使用
  }
  async getKyberPreKey(): Promise<never> {
    throw new Error('Kyber prekeys are not supported');
  }
  async markKyberPreKeyUsed(): Promise<void> {
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
  senderKeyDistribution?: unknown;
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
  senderKeyDistribution?: unknown;
}

/** 自分用の PreKeyBundle (サーバー登録用) */
export interface MyKeyBundle {
  userId: string;
  deviceId: number;
  bundle: {
    identityKey: string;
    signedPreKey: string;
    preKeySignature: string;
    oneTimePreKeys: string[];
  };
}

/* =====================================================================
   Helpers
   ===================================================================== */

function addressFor(conversationId: string, deviceId: number): ProtocolAddress {
  return ProtocolAddress.new(conversationId, deviceId);
}

const DEFAULT_DEVICE_ID = 1;

/** グループ messaging は未実装 */
function unsupportedGroup(): never {
  throw new Error('group messaging is not supported');
}

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
  ): Promise<SessionState> {
    console.log('[SessionManager] Establishing session with', recipientUserId);

    const registrationId = await getLocalRegistrationId();

    // 相手の KeyBundle 取得 (サーバー)
    const bundleResponse = await keysApi.getBundle(recipientUserId, String(recipientDeviceId));
    const preKeyBundle = this.convertToPreKeyBundle(
      bundleResponse.bundle,
      recipientDeviceId,
      registrationId
    );

    const address = addressFor(recipientUserId, recipientDeviceId);

    // X3DH: PreKeyBundle を処理してセッションを生成・保存
    const identityKey = await identityStore.getIdentityKey();
    const session = processPreKeyBundle(
      preKeyBundle,
      identityKey,
      identityKey.getPublicKey(),
      registrationId,
      Math.floor(Date.now() / 1000)
    );

    await identityStore.saveIdentity(address, preKeyBundle.identityKey);
    await sessionStore.saveSession(address, session);

    console.log('[SessionManager] Session established with', recipientUserId);
    return session;
  }

  /** 相手からの PreKeySignalMessage を処理してセッション確立 */
  async processPreKeyMessage(
    senderUserId: string,
    preKeyMessage: Uint8Array,
    senderDeviceId: number
  ): Promise<SessionState> {
    console.log('[SessionManager] Processing PreKey message from', senderUserId);

    const address = addressFor(senderUserId, senderDeviceId);
    const message = PreKeySignalMessage.deserialize(preKeyMessage);

    const built = await this.buildSessionFromPreKeyMessage(message, address);
    if (!built) throw new Error('Session creation from PreKey message failed');

    console.log('[SessionManager] Session established from PreKey message with', senderUserId);
    return built.session;
  }

  /**
   * PreKeySignalMessage からセッションを組み立てる
   *
   * サーバーの KeyBundle API は one-time prekey の ID を返さないため、
   * メッセージの preKeyId が wrong の場合はローカルの未使用 prekey を
   * 順に試す (MAC 検証で正解を判定する)。
   */
  private async buildSessionFromPreKeyMessage(
    message: PreKeySignalMessage,
    address: ProtocolAddress
  ): Promise<{ session: SessionState; plaintext: Uint8Array } | null> {
    const identityKey = await identityStore.getIdentityKey();
    const signedPreKey = await this.loadOurSignedPreKey(message.signedPreKeyId);
    if (!signedPreKey) {
      throw new Error(`Signed prekey ${message.signedPreKeyId} not found`);
    }

    const candidates = await this.collectPreKeyCandidates(message.preKeyId);

    for (const candidate of candidates) {
      const session = processPreKeyMessage(
        message,
        identityKey,
        identityKey.getPublicKey(),
        signedPreKey.privateKey,
        signedPreKey.publicKey,
        candidate?.privateKey ?? null,
        await getLocalRegistrationId()
      );

      let plaintext: Uint8Array;
      try {
        plaintext = decryptMessage(session, message.message);
      } catch {
        continue;
      }

      if (candidate) {
        await markPreKeyUsed(candidate.keyId);
      }
      await identityStore.saveIdentity(address, message.identityKey);
      await sessionStore.saveSession(address, session);
      return { session, plaintext };
    }

    return null;
  }

  /** ローカルの signed prekey を読み込む */
  private async loadOurSignedPreKey(
    signedPreKeyId: number
  ): Promise<{ privateKey: PrivateKey; publicKey: PublicKey } | null> {
    const row = await loadSignedPreKey(signedPreKeyId);
    if (!row) return null;
    return {
      privateKey: PrivateKey.deserialize(base64ToBytes(row.privateKey)),
      publicKey: PublicKey.deserialize(base64ToBytes(row.publicKey)),
    };
  }

  /** 試す one-time prekey の候補を gathered する */
  private async collectPreKeyCandidates(
    preKeyId: number | null
  ): Promise<{ keyId: number; privateKey: PrivateKey }[]> {
    const candidates: { keyId: number; privateKey: PrivateKey }[] = [];

    if (preKeyId !== null) {
      const row = await this.loadPreKeyById(preKeyId);
      if (row) candidates.push(row);
    }

    for (const unused of await getUnusedPreKeys()) {
      if (candidates.some((c) => c.keyId === unused.keyId)) continue;
      candidates.push({
        keyId: unused.keyId,
        privateKey: PrivateKey.deserialize(base64ToBytes(unused.privateKey)),
      });
    }

    return candidates;
  }

  /** prekey を id 指定で読み込む (使用済みでも許可) */
  private async loadPreKeyById(
    keyId: number
  ): Promise<{ keyId: number; privateKey: PrivateKey } | null> {
    const rows = await getUnusedPreKeys();
    const found = rows.find((r) => r.keyId === keyId);
    if (found) {
      return { keyId, privateKey: PrivateKey.deserialize(base64ToBytes(found.privateKey)) };
    }
    return null;
  }

  /** PreKeyBundle を libsignal 形式に変換 (サーバー応答 → PreKeyBundle) */
  private convertToPreKeyBundle(
    bundle: {
      identityKey: string;
      signedPreKey: string;
      preKeySignature: string;
      oneTimePreKeys: string[];
    },
    deviceId: number,
    registrationId: number
  ): PreKeyBundle {
    const oneTimePreKeys: string[] = bundle.oneTimePreKeys || [];
    const preKeyPublic =
      oneTimePreKeys.length > 0 ? PublicKey.deserialize(base64ToBytes(oneTimePreKeys[0])) : null;

    return PreKeyBundle.new(
      registrationId,
      deviceId,
      // サーバーの bundle API は prekey id を返さないため、
      // 0 番の prekey を使う前提で id を通知する
      preKeyPublic ? 0 : null,
      preKeyPublic,
      1, // signed_prekey_id
      PublicKey.deserialize(base64ToBytes(bundle.signedPreKey)),
      base64ToBytes(bundle.preKeySignature),
      PublicKey.deserialize(base64ToBytes(bundle.identityKey))
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
    if (conversationType !== 'dm') unsupportedGroup();

    const address = addressFor(conversationId, DEFAULT_DEVICE_ID);

    let session = await sessionStore.getSession(address);
    if (!session) {
      await this.establishSession(conversationId, DEFAULT_DEVICE_ID);
      session = await sessionStore.getSession(address);
    }
    if (!session) throw new Error('No session established');

    const plaintextBytes = utf8Encode(plaintext);
    const message = encryptMessage(session, plaintextBytes);

    await sessionStore.saveSession(address, session);

    return {
      ciphertext: bytesToBase64(message.serialize()),
      type:
        message instanceof PreKeySignalMessage
          ? CiphertextMessageType.PreKey
          : CiphertextMessageType.Whisper,
      registrationId: await getLocalRegistrationId(),
    };
  }

  /** メッセージ復号化 (受信) */
  async decryptMessage(
    conversationId: string,
    conversationType: ConversationType,
    payload: IncomingMessagePayload
  ): Promise<DecryptionResult> {
    if (conversationType !== 'dm') unsupportedGroup();

    const address = addressFor(conversationId, DEFAULT_DEVICE_ID);
    const ciphertext = base64ToBytes(payload.ciphertext);

    if (payload.type === CiphertextMessageType.PreKey) {
      const preKeyMessage = PreKeySignalMessage.deserialize(ciphertext);
      const session = await sessionStore.getSession(address);

      if (session) {
        try {
          const plaintext = decryptMessage(session, preKeyMessage.message);
          await sessionStore.saveSession(address, session);
          return { plaintext: utf8Decode(plaintext) };
        } catch {
          // 既存セッションでは復号できない場合があるため、
          // PreKey メッセージからセッションを作り直す
        }
      }

      const built = await this.buildSessionFromPreKeyMessage(preKeyMessage, address);
      if (!built) throw new Error('Failed to build session from PreKey message');
      return { plaintext: utf8Decode(built.plaintext) };
    }

    const session = await sessionStore.getSession(address);
    if (!session) throw new Error('No session established for decryption');

    const signalMessage = SignalMessage.deserialize(ciphertext);
    const plaintext = decryptMessage(session, signalMessage);
    await sessionStore.saveSession(address, session);
    return { plaintext: utf8Decode(plaintext) };
  }

  /* -----------------------------------------------------------------
     Group Encryption (Sender Keys) - 未実装
     ----------------------------------------------------------------- */

  /** グループ Sender Key 初期化 */
  async createGroupSenderKey(_groupId: string): Promise<void> {
    unsupportedGroup();
  }

  /** グループメッセージ暗号化 */
  async encryptGroupMessage(_groupId: string, _plaintext: string): Promise<OutgoingMessagePayload> {
    unsupportedGroup();
  }

  /** グループメッセージ復号化 */
  async decryptGroupMessage(
    _groupId: string,
    _senderUserId: string,
    _payload: IncomingMessagePayload
  ): Promise<DecryptionResult> {
    unsupportedGroup();
  }

  /** メンバー追加時の Sender Key 再配布 */
  async rotateGroupSenderKeys(_groupId: string, _newMembers: string[]): Promise<void> {
    unsupportedGroup();
  }

  /* -----------------------------------------------------------------
     Session State Management
     ----------------------------------------------------------------- */

  async getActiveSessions(): Promise<SessionInfo[]> {
    return [
      {
        conversationId: '',
        conversationType: 'dm',
        isEstablished: true,
        lastUsedAt: Date.now(),
      },
    ];
  }

  async deleteSession(conversationId: string, _conversationType: ConversationType): Promise<void> {
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
    const target = records.find((r) => r.keyId === keyId);
    return target ?? null;
  }

  async replenishPreKeysIfNeeded(): Promise<void> {
    const { unused } = await getPreKeyCount();
    if (unused <= 20) {
      for (let i = 0; i < 50; i++) {
        // 既存 key_id (0-99) と衝突しない id を使う
        const keyId = 1000 + i;
        const preKey = PrivateKey.generate();
        await storePreKey(keyId, preKey);
      }
    }
  }

  async rotateSignedPreKey(): Promise<void> {
    const identityKey = await identityStore.getIdentityKey();
    const signedPreKeyPair = PrivateKey.generate();
    const signedPreKeyId = Math.floor(Math.random() * 16380) + 1;
    const signature = identityKey.sign(signedPreKeyPair.getPublicKey().serialize());
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

  async getMyKeyBundle(deviceId: number = DEFAULT_DEVICE_ID): Promise<MyKeyBundle> {
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

export async function encryptForDM(
  recipientUserId: string,
  plaintext: string
): Promise<OutgoingMessagePayload> {
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

export async function decryptFromDM(
  senderUserId: string,
  ciphertext: string,
  type: number
): Promise<string> {
  const manager = getSessionManager();
  const result = await manager.decryptMessage(senderUserId, 'dm', { ciphertext, type });
  return result.plaintext;
}

export async function encryptForGroup(
  _groupId: string,
  _plaintext: string
): Promise<OutgoingMessagePayload> {
  const manager = getSessionManager();
  await manager.ensureDeviceSetup();
  return manager.encryptGroupMessage(_groupId, _plaintext);
}

export async function decryptFromGroup(
  _groupId: string,
  _senderUserId: string,
  _ciphertext: string,
  _type: number
): Promise<string> {
  const manager = getSessionManager();
  const result = await manager.decryptGroupMessage(_groupId, _senderUserId, {
    ciphertext: _ciphertext,
    type: _type,
  });
  return result.plaintext;
}

/* =====================================================================
   参照用のエクスポート (呼び出し側の互換性維持)
   ===================================================================== */

export {
  senderKeyStore,
  sessionStore,
  identityStore,
  preKeyStore,
  signedPreKeyStore,
  kyberPreKeyStore,
};
