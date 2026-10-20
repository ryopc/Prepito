/**
 * Signal Protocol のセッション実装 (X3DH + Double Ratchet)
 *
 * libsignal-client v0.40 の Rust 実装 (rust/protocol/src/ratchet.rs,
 * ratchet/keys.rs, session.rs, session_cipher.rs) と同じアルゴリズム・同じ鍵導出を
 * 純 TypeScript で実装したもの。
 *
 * Kyber (PQC) には対応しておらず、メッセージバージョンは 3 (pre-Kyber) 固定。
 */

import { cbc } from '@noble/ciphers/aes.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToBase64, base64ToBytes, concatBytes, utf8Encode } from './bytes';
import { PreKeySignalMessage, SignalMessage } from './signal-message';
import type { PreKeyBundle } from './signal-keys';
import { PrivateKey, PublicKey } from './signal-keys';

/** 前方ジャンプの最大数 */
export const MAX_FORWARD_JUMPS = 25000;
/** 保持する message key の最大数 */
export const MAX_MESSAGE_KEYS = 2000;
/** 保持する receiver chain の最大数 */
export const MAX_RECEIVER_CHAINS = 5;

/** Kyber 無しのセッションが使うメッセージバージョン */
export const SESSION_VERSION_PRE_KYBER = 3;

/** HKDF の info ラベル */
const LABEL_WHISPER_TEXT = 'WhisperText';
const LABEL_WHISPER_RATCHET = 'WhisperRatchet';
const LABEL_WHISPER_MESSAGE_KEYS = 'WhisperMessageKeys';

/** メッセージ鍵 */
export interface MessageKeys {
  cipherKey: Uint8Array;
  macKey: Uint8Array;
  iv: Uint8Array;
  counter: number;
}

/** ChainKey (送信/受信チェーンの鍵) */
export class ChainKey {
  readonly key: Uint8Array;
  readonly index: number;

  constructor(key: Uint8Array, index: number) {
    this.key = key;
    this.index = index;
  }

  /** 次のチェーン鍵 */
  nextChainKey(): ChainKey {
    return new ChainKey(hmac(sha256, this.key, new Uint8Array([0x02])), this.index + 1);
  }

  /** このチェーン鍵からメッセージ鍵を導出 */
  messageKeys(): MessageKeys {
    const base = hmac(sha256, this.key, new Uint8Array([0x01]));
    const okm = hkdf(sha256, base, undefined, utf8Encode(LABEL_WHISPER_MESSAGE_KEYS), 80);
    return {
      cipherKey: okm.slice(0, 32),
      macKey: okm.slice(32, 64),
      iv: okm.slice(64, 80),
      counter: this.index,
    };
  }
}

/** RootKey (チェーンの派生元) */
export class RootKey {
  readonly key: Uint8Array;

  constructor(key: Uint8Array) {
    this.key = key;
  }

  /** DH を使って新しいチェーンを派生 */
  createChain(
    theirRatchetKey: PublicKey,
    ourRatchetKey: PrivateKey
  ): { rootKey: RootKey; chainKey: ChainKey } {
    const sharedSecret = ourRatchetKey.calculateAgreement(theirRatchetKey);
    const derived = hkdf(sha256, sharedSecret, this.key, utf8Encode(LABEL_WHISPER_RATCHET), 64);
    return {
      rootKey: new RootKey(derived.slice(0, 32)),
      chainKey: new ChainKey(derived.slice(32, 64), 0),
    };
  }
}

/** X3DH の root key / chain key を導出 */
export function deriveX3DHKeys(secrets: Uint8Array): {
  rootKey: RootKey;
  chainKey: ChainKey;
} {
  const derived = hkdf(sha256, secrets, undefined, utf8Encode(LABEL_WHISPER_TEXT), 64);
  return {
    rootKey: new RootKey(derived.slice(0, 32)),
    chainKey: new ChainKey(derived.slice(32, 64), 0),
  };
}

/** チェーンの状態 */
export interface ChainState {
  /** serialized 公開鍵 (33 バイト) */
  senderRatchetKey: Uint8Array;
  /** 秘密鍵 (32 バイト) または空 */
  senderRatchetKeyPrivate: Uint8Array;
  chainKey: { index: number; key: Uint8Array } | null;
  messageKeys: {
    index: number;
    cipherKey: Uint8Array;
    macKey: Uint8Array;
    iv: Uint8Array;
  }[];
}

/** 未応答の PreKey メッセージ */
export interface PendingPreKeyState {
  preKeyId: number | null;
  signedPreKeyId: number;
  /** serialized 公開鍵 (33 バイト) */
  baseKey: Uint8Array;
  /** Unix 時間 (秒) */
  timestamp: number;
}

/** セッション状態 */
export class SessionState {
  sessionVersion: number;
  /** serialized 公開鍵 (33 バイト) */
  localIdentityPublic: Uint8Array;
  /** serialized 公開鍵 (33 バイト) */
  remoteIdentityPublic: Uint8Array;
  rootKeyBytes: Uint8Array;
  previousCounter: number;
  senderChain: ChainState | null;
  receiverChains: ChainState[];
  pendingPreKey: PendingPreKeyState | null;
  remoteRegistrationId: number;
  localRegistrationId: number;
  /** serialized 公開鍵 (33 バイト) */
  aliceBaseKey: Uint8Array;

  constructor(
    sessionVersion: number,
    localIdentityPublic: Uint8Array,
    remoteIdentityPublic: Uint8Array,
    rootKey: RootKey,
    aliceBaseKey: Uint8Array
  ) {
    this.sessionVersion = sessionVersion;
    this.localIdentityPublic = localIdentityPublic;
    this.remoteIdentityPublic = remoteIdentityPublic;
    this.rootKeyBytes = rootKey.key;
    this.previousCounter = 0;
    this.senderChain = null;
    this.receiverChains = [];
    this.pendingPreKey = null;
    this.remoteRegistrationId = 0;
    this.localRegistrationId = 0;
    this.aliceBaseKey = aliceBaseKey;
  }

  /** root key */
  rootKey(): RootKey {
    return new RootKey(this.rootKeyBytes);
  }

  setRootKey(rootKey: RootKey): void {
    this.rootKeyBytes = rootKey.key;
  }

  /** ローカル識別鍵 */
  localIdentityKey(): PublicKey {
    return PublicKey.deserialize(this.localIdentityPublic);
  }

  /** リモート識別鍵 (未設定なら null) */
  remoteIdentityKey(): PublicKey | null {
    if (this.remoteIdentityPublic.length === 0) return null;
    return PublicKey.deserialize(this.remoteIdentityPublic);
  }

  /** 自分自身とのセッションか */
  sessionWithSelf(): boolean {
    const remote = this.remoteIdentityKey();
    if (!remote) return false;
    return remote.serialize().every((b, i) => b === this.localIdentityPublic[i]);
  }

  /** 送信チェーン鍵 */
  senderChainKey(): ChainKey {
    if (!this.senderChain || !this.senderChain.chainKey) {
      throw new Error('Missing sender chain');
    }
    return new ChainKey(this.senderChain.chainKey.key, this.senderChain.chainKey.index);
  }

  setSenderChainKey(chainKey: ChainKey): void {
    if (!this.senderChain) {
      this.senderChain = {
        senderRatchetKey: new Uint8Array(0),
        senderRatchetKeyPrivate: new Uint8Array(0),
        chainKey: { index: chainKey.index, key: chainKey.key },
        messageKeys: [],
      };
      return;
    }
    this.senderChain.chainKey = { index: chainKey.index, key: chainKey.key };
  }

  /** 送信 ratchet 鍵 (公開) */
  senderRatchetKey(): PublicKey {
    if (!this.senderChain) {
      throw new Error('Missing sender chain');
    }
    return PublicKey.deserialize(this.senderChain.senderRatchetKey);
  }

  /** 送信 ratchet 鍵 (秘密) */
  senderRatchetPrivateKey(): PrivateKey {
    if (!this.senderChain || this.senderChain.senderRatchetKeyPrivate.length !== 32) {
      throw new Error('Missing sender chain');
    }
    return PrivateKey.deserialize(this.senderChain.senderRatchetKeyPrivate);
  }

  /** 送信チェーンを設定 */
  setSenderChain(
    sender: { publicKey: PublicKey; privateKey: PrivateKey },
    chainKey: ChainKey
  ): void {
    this.senderChain = {
      senderRatchetKey: sender.publicKey.serialize(),
      senderRatchetKeyPrivate: sender.privateKey.serialize(),
      chainKey: { index: chainKey.index, key: chainKey.key },
      messageKeys: [],
    };
  }

  /** receiver chain を検索 */
  private findReceiverChain(sender: PublicKey): number {
    const serialized = sender.serialize();
    for (let i = 0; i < this.receiverChains.length; i++) {
      const chain = this.receiverChains[i];
      if (chain.senderRatchetKey.length !== serialized.length) continue;
      let same = true;
      for (let j = 0; j < serialized.length; j++) {
        if (chain.senderRatchetKey[j] !== serialized[j]) {
          same = false;
          break;
        }
      }
      if (same) return i;
    }
    return -1;
  }

  /** receiver chain の chain key */
  receiverChainKey(sender: PublicKey): ChainKey | null {
    const index = this.findReceiverChain(sender);
    if (index < 0) return null;
    const chain = this.receiverChains[index];
    if (!chain.chainKey) throw new Error('Missing receiver chain key');
    return new ChainKey(chain.chainKey.key, chain.chainKey.index);
  }

  /** receiver chain を追加 */
  addReceiverChain(sender: PublicKey, chainKey: ChainKey): void {
    this.receiverChains.push({
      senderRatchetKey: sender.serialize(),
      senderRatchetKeyPrivate: new Uint8Array(0),
      chainKey: { index: chainKey.index, key: chainKey.key },
      messageKeys: [],
    });
    if (this.receiverChains.length > MAX_RECEIVER_CHAINS) {
      this.receiverChains.shift();
    }
  }

  /** receiver chain の chain key を更新 */
  setReceiverChainKey(sender: PublicKey, chainKey: ChainKey): void {
    const index = this.findReceiverChain(sender);
    if (index < 0) throw new Error('Receiver chain not found');
    this.receiverChains[index].chainKey = { index: chainKey.index, key: chainKey.key };
  }

  /** 消費済み message key を取得 (取得したら削除) */
  messageKeys(sender: PublicKey, counter: number): MessageKeys | null {
    const index = this.findReceiverChain(sender);
    if (index < 0) return null;
    const chain = this.receiverChains[index];
    const position = chain.messageKeys.findIndex((m) => m.index === counter);
    if (position < 0) return null;
    const [keys] = chain.messageKeys.splice(position, 1);
    return {
      cipherKey: keys.cipherKey,
      macKey: keys.macKey,
      iv: keys.iv,
      counter: keys.index,
    };
  }

  /** message key を保存 */
  setMessageKeys(sender: PublicKey, keys: MessageKeys): void {
    const index = this.findReceiverChain(sender);
    if (index < 0) throw new Error('Receiver chain not found');
    const chain = this.receiverChains[index];
    chain.messageKeys.unshift({
      index: keys.counter,
      cipherKey: keys.cipherKey,
      macKey: keys.macKey,
      iv: keys.iv,
    });
    if (chain.messageKeys.length > MAX_MESSAGE_KEYS) {
      chain.messageKeys.pop();
    }
  }

  /** 未応答の PreKey メッセージを設定 */
  setPendingPreKey(
    preKeyId: number | null,
    signedPreKeyId: number,
    baseKey: PublicKey,
    timestamp: number
  ): void {
    this.pendingPreKey = {
      preKeyId,
      signedPreKeyId,
      baseKey: baseKey.serialize(),
      timestamp,
    };
  }

  /** 未応答の PreKey メッセージを破棄 */
  clearPendingPreKey(): void {
    this.pendingPreKey = null;
  }

  /* -------------------------------------------------------------------
     JSON シリアライズ (DB 保存用)
     ------------------------------------------------------------------- */

  toJSON(): Record<string, unknown> {
    return {
      sessionVersion: this.sessionVersion,
      localIdentityPublic: bytesToBase64(this.localIdentityPublic),
      remoteIdentityPublic: bytesToBase64(this.remoteIdentityPublic),
      rootKey: bytesToBase64(this.rootKeyBytes),
      previousCounter: this.previousCounter,
      senderChain: this.senderChain ? serializeChain(this.senderChain) : null,
      receiverChains: this.receiverChains.map(serializeChain),
      pendingPreKey: this.pendingPreKey
        ? {
            preKeyId: this.pendingPreKey.preKeyId,
            signedPreKeyId: this.pendingPreKey.signedPreKeyId,
            baseKey: bytesToBase64(this.pendingPreKey.baseKey),
            timestamp: this.pendingPreKey.timestamp,
          }
        : null,
      remoteRegistrationId: this.remoteRegistrationId,
      localRegistrationId: this.localRegistrationId,
      aliceBaseKey: bytesToBase64(this.aliceBaseKey),
    };
  }

  static fromJSON(data: Record<string, unknown>): SessionState {
    const state = Object.create(SessionState.prototype) as SessionState;
    state.sessionVersion = Number(data.sessionVersion ?? SESSION_VERSION_PRE_KYBER);
    state.localIdentityPublic = base64ToBytes(String(data.localIdentityPublic ?? ''));
    state.remoteIdentityPublic = base64ToBytes(String(data.remoteIdentityPublic ?? ''));
    state.rootKeyBytes = base64ToBytes(String(data.rootKey ?? ''));
    state.previousCounter = Number(data.previousCounter ?? 0);
    const senderChain = data.senderChain as Record<string, unknown> | null;
    state.senderChain = senderChain ? deserializeChain(senderChain) : null;
    const receiverChains = (data.receiverChains as Record<string, unknown>[]) ?? [];
    state.receiverChains = receiverChains.map(deserializeChain);
    const pending = data.pendingPreKey as Record<string, unknown> | null;
    state.pendingPreKey = pending
      ? {
          preKeyId: pending.preKeyId === null ? null : Number(pending.preKeyId),
          signedPreKeyId: Number(pending.signedPreKeyId ?? 0),
          baseKey: base64ToBytes(String(pending.baseKey ?? '')),
          timestamp: Number(pending.timestamp ?? 0),
        }
      : null;
    state.remoteRegistrationId = Number(data.remoteRegistrationId ?? 0);
    state.localRegistrationId = Number(data.localRegistrationId ?? 0);
    state.aliceBaseKey = base64ToBytes(String(data.aliceBaseKey ?? ''));
    return state;
  }
}

function serializeChain(chain: ChainState): Record<string, unknown> {
  return {
    senderRatchetKey: bytesToBase64(chain.senderRatchetKey),
    senderRatchetKeyPrivate: bytesToBase64(chain.senderRatchetKeyPrivate),
    chainKey: chain.chainKey
      ? { index: chain.chainKey.index, key: bytesToBase64(chain.chainKey.key) }
      : null,
    messageKeys: chain.messageKeys.map((m) => ({
      index: m.index,
      cipherKey: bytesToBase64(m.cipherKey),
      macKey: bytesToBase64(m.macKey),
      iv: bytesToBase64(m.iv),
    })),
  };
}

function deserializeChain(data: Record<string, unknown>): ChainState {
  const chainKey = data.chainKey as Record<string, unknown> | null;
  const messageKeys = (data.messageKeys as Record<string, unknown>[]) ?? [];
  return {
    senderRatchetKey: base64ToBytes(String(data.senderRatchetKey ?? '')),
    senderRatchetKeyPrivate: base64ToBytes(String(data.senderRatchetKeyPrivate ?? '')),
    chainKey: chainKey
      ? { index: Number(chainKey.index ?? 0), key: base64ToBytes(String(chainKey.key ?? '')) }
      : null,
    messageKeys: messageKeys.map((m) => ({
      index: Number(m.index ?? 0),
      cipherKey: base64ToBytes(String(m.cipherKey ?? '')),
      macKey: base64ToBytes(String(m.macKey ?? '')),
      iv: base64ToBytes(String(m.iv ?? '')),
    })),
  };
}

/* =====================================================================
   X3DH セッション初期化
   ===================================================================== */

/** Alice 側 (送信側) の初期化パラメータ */
export interface AliceSessionParameters {
  ourIdentityPrivateKey: PrivateKey;
  ourIdentityPublicKey: PublicKey;
  ourBasePrivateKey: PrivateKey;
  ourBasePublicKey: PublicKey;
  theirIdentityKey: PublicKey;
  theirSignedPreKey: PublicKey;
  theirOneTimePreKey: PublicKey | null;
  /** libsignal では their signed prekey が ratchet key として使われる */
  theirRatchetKey: PublicKey;
}

/** Bob 側 (受信側) の初期化パラメータ */
export interface BobSessionParameters {
  ourIdentityPrivateKey: PrivateKey;
  ourIdentityPublicKey: PublicKey;
  ourSignedPreKeyPrivateKey: PrivateKey;
  ourSignedPreKeyPublicKey: PublicKey;
  ourOneTimePreKeyPrivateKey: PrivateKey | null;
  theirIdentityKey: PublicKey;
  theirBaseKey: PublicKey;
}

/** Alice セッションを初期化する (X3DH) */
export function initializeAliceSession(parameters: AliceSessionParameters): SessionState {
  const sendingRatchetKey = PrivateKey.generate();

  const secrets: Uint8Array[] = [new Uint8Array(32).fill(0xff)];
  secrets.push(parameters.ourIdentityPrivateKey.calculateAgreement(parameters.theirSignedPreKey));
  secrets.push(parameters.ourBasePrivateKey.calculateAgreement(parameters.theirIdentityKey));
  secrets.push(parameters.ourBasePrivateKey.calculateAgreement(parameters.theirSignedPreKey));
  if (parameters.theirOneTimePreKey) {
    secrets.push(parameters.ourBasePrivateKey.calculateAgreement(parameters.theirOneTimePreKey));
  }

  const { rootKey, chainKey } = deriveX3DHKeys(concatBytes(...secrets));
  const sendingChain = rootKey.createChain(parameters.theirRatchetKey, sendingRatchetKey);

  const session = new SessionState(
    SESSION_VERSION_PRE_KYBER,
    parameters.ourIdentityPublicKey.serialize(),
    parameters.theirIdentityKey.serialize(),
    sendingChain.rootKey,
    parameters.ourBasePublicKey.serialize()
  );
  session.addReceiverChain(parameters.theirRatchetKey, chainKey);
  session.setSenderChain(
    { publicKey: sendingRatchetKey.getPublicKey(), privateKey: sendingRatchetKey },
    sendingChain.chainKey
  );
  return session;
}

/** Bob セッションを初期化する (X3DH) */
export function initializeBobSession(parameters: BobSessionParameters): SessionState {
  const secrets: Uint8Array[] = [new Uint8Array(32).fill(0xff)];
  secrets.push(
    parameters.ourSignedPreKeyPrivateKey.calculateAgreement(parameters.theirIdentityKey)
  );
  secrets.push(parameters.ourIdentityPrivateKey.calculateAgreement(parameters.theirBaseKey));
  secrets.push(parameters.ourSignedPreKeyPrivateKey.calculateAgreement(parameters.theirBaseKey));
  if (parameters.ourOneTimePreKeyPrivateKey) {
    secrets.push(parameters.ourOneTimePreKeyPrivateKey.calculateAgreement(parameters.theirBaseKey));
  }

  const { rootKey, chainKey } = deriveX3DHKeys(concatBytes(...secrets));

  const session = new SessionState(
    SESSION_VERSION_PRE_KYBER,
    parameters.ourIdentityPublicKey.serialize(),
    parameters.theirIdentityKey.serialize(),
    rootKey,
    parameters.theirBaseKey.serialize()
  );
  session.setSenderChain(
    {
      publicKey: parameters.ourSignedPreKeyPublicKey,
      privateKey: parameters.ourSignedPreKeyPrivateKey,
    },
    chainKey
  );
  return session;
}

/* =====================================================================
   PreKeyBundle / PreKeySignalMessage の処理 (DB 非依存)
   ===================================================================== */

/**
 * PreKeyBundle から Alice セッションを生成する
 *
 * libsignal の `process_prekey_bundle` 相当。
 * 署名検証 (XEdDSA) に失敗した場合は例外を投げる。
 */
export function processPreKeyBundle(
  bundle: PreKeyBundle,
  ourIdentityPrivateKey: PrivateKey,
  ourIdentityPublicKey: PublicKey,
  localRegistrationId: number,
  nowSeconds: number
): SessionState {
  // 相手の identity key で signed pre key の署名を検証する
  const signatureValid = bundle.identityKey.verifySignature(
    bundle.signedPreKeyPublic.serialize(),
    bundle.signedPreKeySignature
  );
  if (!signatureValid) {
    throw new Error('Signature validation failed');
  }

  const ourBasePrivateKey = PrivateKey.generate();
  const ourBasePublicKey = ourBasePrivateKey.getPublicKey();

  const session = initializeAliceSession({
    ourIdentityPrivateKey,
    ourIdentityPublicKey,
    ourBasePrivateKey,
    ourBasePublicKey,
    theirIdentityKey: bundle.identityKey,
    theirSignedPreKey: bundle.signedPreKeyPublic,
    theirOneTimePreKey: bundle.preKeyPublic,
    theirRatchetKey: bundle.signedPreKeyPublic,
  });

  session.setPendingPreKey(bundle.preKeyId, bundle.signedPreKeyId, ourBasePublicKey, nowSeconds);
  session.localRegistrationId = localRegistrationId;
  session.remoteRegistrationId = bundle.registrationId;
  return session;
}

/**
 * PreKeySignalMessage から Bob セッションを生成する
 *
 * libsignal の `process_prekey` 相当。
 */
export function processPreKeyMessage(
  message: PreKeySignalMessage,
  ourIdentityPrivateKey: PrivateKey,
  ourIdentityPublicKey: PublicKey,
  ourSignedPreKeyPrivateKey: PrivateKey,
  ourSignedPreKeyPublicKey: PublicKey,
  ourOneTimePreKeyPrivateKey: PrivateKey | null,
  localRegistrationId: number
): SessionState {
  const session = initializeBobSession({
    ourIdentityPrivateKey,
    ourIdentityPublicKey,
    ourSignedPreKeyPrivateKey,
    ourSignedPreKeyPublicKey,
    ourOneTimePreKeyPrivateKey,
    theirIdentityKey: message.identityKey,
    theirBaseKey: message.baseKey,
  });

  session.localRegistrationId = localRegistrationId;
  session.remoteRegistrationId = message.registrationId;
  return session;
}

/* =====================================================================
   Double Ratchet (暗号化 / 復号)
   ===================================================================== */

/** AES-256-CBC (PKCS#7) 暗号化 */
export function aes256CbcEncrypt(
  plaintext: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array
): Uint8Array {
  return cbc(key, iv).encrypt(plaintext);
}

/** AES-256-CBC (PKCS#7) 復号 */
export function aes256CbcDecrypt(
  ciphertext: Uint8Array,
  key: Uint8Array,
  iv: Uint8Array
): Uint8Array {
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    throw new Error('Ciphertext length must be a non-zero multiple of 16');
  }
  try {
    return cbc(key, iv).decrypt(ciphertext);
  } catch {
    throw new Error('Failed to decrypt');
  }
}

/**
 * メッセージ暗号化
 *
 * 未応答の PreKey メッセージがある場合は PreKeySignalMessage を、
 * ない場合は SignalMessage を返す。
 */
export function encryptMessage(
  state: SessionState,
  plaintext: Uint8Array
): SignalMessage | PreKeySignalMessage {
  const chainKey = state.senderChainKey();
  const messageKeys = chainKey.messageKeys();

  const senderEphemeral = state.senderRatchetKey();
  const previousCounter = state.previousCounter;
  const sessionVersion = state.sessionVersion;

  const localIdentityKey = state.localIdentityKey();
  const theirIdentityKey = state.remoteIdentityKey();
  if (!theirIdentityKey) {
    throw new Error('No remote identity key');
  }

  const ciphertext = aes256CbcEncrypt(plaintext, messageKeys.cipherKey, messageKeys.iv);

  const signalMessage = SignalMessage.new(
    sessionVersion,
    messageKeys.macKey,
    senderEphemeral,
    chainKey.index,
    previousCounter,
    ciphertext,
    localIdentityKey,
    theirIdentityKey
  );

  let result: SignalMessage | PreKeySignalMessage;
  if (state.pendingPreKey) {
    result = PreKeySignalMessage.new(
      sessionVersion,
      state.localRegistrationId,
      state.pendingPreKey.preKeyId,
      state.pendingPreKey.signedPreKeyId,
      PublicKey.deserialize(state.pendingPreKey.baseKey),
      localIdentityKey,
      signalMessage
    );
  } else {
    result = signalMessage;
  }

  state.setSenderChainKey(chainKey.nextChainKey());
  return result;
}

/**
 * メッセージ復号
 *
 * 受信 ratchet の更新を含むため state は破壊的に更新される。
 */
export function decryptMessage(state: SessionState, message: SignalMessage): Uint8Array {
  if (message.messageVersion !== state.sessionVersion) {
    throw new Error(`Unrecognized message version: ${message.messageVersion}`);
  }

  const theirEphemeral = message.senderRatchetKey;
  const counter = message.counter;

  const chainKey = getOrCreateChainKey(state, theirEphemeral);
  const messageKeys = getOrCreateMessageKey(state, theirEphemeral, chainKey, counter);

  const theirIdentityKey = state.remoteIdentityKey();
  if (!theirIdentityKey) {
    throw new Error('Cannot decrypt without remote identity key');
  }

  const macValid = message.verifyMac(
    theirIdentityKey,
    state.localIdentityKey(),
    messageKeys.macKey
  );
  if (!macValid) {
    throw new Error('MAC verification failed');
  }

  const plaintext = aes256CbcDecrypt(message.ciphertext, messageKeys.cipherKey, messageKeys.iv);

  state.clearPendingPreKey();
  return plaintext;
}

/** 受信チェーンの準備 (必要なら ratchet を進める) */
function getOrCreateChainKey(state: SessionState, theirEphemeral: PublicKey): ChainKey {
  const existing = state.receiverChainKey(theirEphemeral);
  if (existing) return existing;

  const rootKey = state.rootKey();
  const ourEphemeral = state.senderRatchetPrivateKey();
  const receiverChain = rootKey.createChain(theirEphemeral, ourEphemeral);

  const ourNewEphemeral = PrivateKey.generate();
  const senderChain = receiverChain.rootKey.createChain(theirEphemeral, ourNewEphemeral);

  state.setRootKey(senderChain.rootKey);
  state.addReceiverChain(theirEphemeral, receiverChain.chainKey);

  const currentIndex = state.senderChainKey().index;
  state.previousCounter = currentIndex > 0 ? currentIndex - 1 : 0;
  state.setSenderChain(
    { publicKey: ourNewEphemeral.getPublicKey(), privateKey: ourNewEphemeral },
    senderChain.chainKey
  );

  return receiverChain.chainKey;
}

/** メッセージ鍵の取得 (必要なら chain を進める) */
function getOrCreateMessageKey(
  state: SessionState,
  theirEphemeral: PublicKey,
  chainKey: ChainKey,
  counter: number
): MessageKeys {
  const chainIndex = chainKey.index;

  if (chainIndex > counter) {
    const keys = state.messageKeys(theirEphemeral, counter);
    if (keys) return keys;
    throw new Error(`Duplicate message for counter: ${counter}`);
  }

  const jump = counter - chainIndex;
  if (jump > MAX_FORWARD_JUMPS && !state.sessionWithSelf()) {
    throw new Error('Message from too far into the future');
  }

  let current = chainKey;
  while (current.index < counter) {
    state.setMessageKeys(theirEphemeral, current.messageKeys());
    current = current.nextChainKey();
  }

  state.setReceiverChainKey(theirEphemeral, current.nextChainKey());
  return current.messageKeys();
}
