/**
 * Signal メッセージの wire format
 *
 * libsignal-client v0.40 は Protobuf ベースの wire format を使う。
 * (rust/protocol/src/protocol.rs, rust/protocol/src/proto/wire.proto)
 *
 * SignalMessage      = version(1) || protobuf || mac(8)
 * PreKeySignalMessage = version(1) || protobuf
 *
 * version バイト = ((message_version & 0xF) << 4) | 4
 * (Kyber 無しのセッションでは message_version = 3 なので 0x34)
 */

import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesEqual, concatBytes } from './bytes';
import {
  decodeFields,
  encodeBytesField,
  encodeUint32Field,
  getBytesField,
  getUint32Field,
} from './protobuf';
import { PublicKey } from './signal-keys';

/** MAC 長 (8 バイト) */
export const SIGNAL_MESSAGE_MAC_LENGTH = 8;

/**
 * 暗号文メッセージの種類
 *
 * libsignal-client の `CiphertextMessageType` と同じ値を使う。
 */
export enum CiphertextMessageType {
  Unknown = 0,
  PreKey = 3,
  Whisper = 4,
  SenderKey = 5,
  DecryptionError = 6,
}

/** wire format の現行バージョン (Kyber 対応) */
export const CIPHERTEXT_MESSAGE_CURRENT_VERSION = 4;

/** Kyber を含まないセッションのバージョン */
export const CIPHERTEXT_MESSAGE_PRE_KYBER_VERSION = 3;

/** バージョンバイトを生成する */
export function messageVersionByte(messageVersion: number): number {
  return ((messageVersion & 0x0f) << 4) | CIPHERTEXT_MESSAGE_CURRENT_VERSION;
}

/**
 * MAC を計算する
 *
 * HMAC-SHA256(macKey, senderIdentity || receiverIdentity || message)[0..8]
 */
export function computeSignalMac(
  macKey: Uint8Array,
  senderIdentityKey: PublicKey,
  receiverIdentityKey: PublicKey,
  message: Uint8Array
): Uint8Array {
  if (macKey.length !== 32) {
    throw new Error(`Invalid MAC key length: ${macKey.length}`);
  }
  return hmac(
    sha256,
    macKey,
    concatBytes(senderIdentityKey.serialize(), receiverIdentityKey.serialize(), message)
  ).slice(0, SIGNAL_MESSAGE_MAC_LENGTH);
}

/** SignalMessage (通常の Double Ratchet メッセージ) */
export class SignalMessage {
  readonly messageVersion: number;
  readonly senderRatchetKey: PublicKey;
  readonly counter: number;
  readonly previousCounter: number;
  readonly ciphertext: Uint8Array;
  readonly serialized: Uint8Array;

  constructor(
    messageVersion: number,
    senderRatchetKey: PublicKey,
    counter: number,
    previousCounter: number,
    ciphertext: Uint8Array,
    serialized: Uint8Array
  ) {
    this.messageVersion = messageVersion;
    this.senderRatchetKey = senderRatchetKey;
    this.counter = counter;
    this.previousCounter = previousCounter;
    this.ciphertext = ciphertext;
    this.serialized = serialized;
  }

  /** 新規作成 (MAC まで計算して serialized に含める) */
  static new(
    messageVersion: number,
    macKey: Uint8Array,
    senderRatchetKey: PublicKey,
    counter: number,
    previousCounter: number,
    ciphertext: Uint8Array,
    senderIdentityKey: PublicKey,
    receiverIdentityKey: PublicKey
  ): SignalMessage {
    const body = concatBytes(
      new Uint8Array([messageVersionByte(messageVersion)]),
      encodeBytesField(1, senderRatchetKey.serialize()),
      encodeUint32Field(2, counter),
      encodeUint32Field(3, previousCounter),
      encodeBytesField(4, ciphertext)
    );

    const mac = computeSignalMac(macKey, senderIdentityKey, receiverIdentityKey, body);

    return new SignalMessage(
      messageVersion,
      senderRatchetKey,
      counter,
      previousCounter,
      ciphertext,
      concatBytes(body, mac)
    );
  }

  /** serialized 形式からの復元 */
  static deserialize(bytes: Uint8Array): SignalMessage {
    if (bytes.length < SIGNAL_MESSAGE_MAC_LENGTH + 1) {
      throw new Error(`Ciphertext message too short: ${bytes.length}`);
    }

    const messageVersion = bytes[0] >> 4;
    if (messageVersion < CIPHERTEXT_MESSAGE_PRE_KYBER_VERSION) {
      throw new Error(`Legacy ciphertext version: ${messageVersion}`);
    }
    if (messageVersion > CIPHERTEXT_MESSAGE_CURRENT_VERSION) {
      throw new Error(`Unrecognized ciphertext version: ${messageVersion}`);
    }

    const body = bytes.slice(1, bytes.length - SIGNAL_MESSAGE_MAC_LENGTH);
    const fields = decodeFields(body);

    const ratchetKey = getBytesField(fields, 1);
    const counter = getUint32Field(fields, 2);
    const previousCounter = getUint32Field(fields, 3) ?? 0;
    const ciphertext = getBytesField(fields, 4);

    if (!ratchetKey || counter === null || !ciphertext) {
      throw new Error('Invalid protobuf encoding');
    }

    return new SignalMessage(
      messageVersion,
      PublicKey.deserialize(ratchetKey),
      counter,
      previousCounter,
      ciphertext,
      new Uint8Array(bytes)
    );
  }

  /** serialized 形式 */
  serialize(): Uint8Array {
    return this.serialized;
  }

  /** MAC 検証 */
  verifyMac(
    senderIdentityKey: PublicKey,
    receiverIdentityKey: PublicKey,
    macKey: Uint8Array
  ): boolean {
    const body = this.serialized.slice(0, this.serialized.length - SIGNAL_MESSAGE_MAC_LENGTH);
    const expected = computeSignalMac(macKey, senderIdentityKey, receiverIdentityKey, body);
    const actual = this.serialized.slice(this.serialized.length - SIGNAL_MESSAGE_MAC_LENGTH);
    return bytesEqual(expected, actual);
  }
}

/** PreKeySignalMessage (X3DH セッション確立時のメッセージ) */
export class PreKeySignalMessage {
  readonly messageVersion: number;
  readonly registrationId: number;
  readonly preKeyId: number | null;
  readonly signedPreKeyId: number;
  readonly baseKey: PublicKey;
  readonly identityKey: PublicKey;
  readonly message: SignalMessage;
  readonly serialized: Uint8Array;

  constructor(
    messageVersion: number,
    registrationId: number,
    preKeyId: number | null,
    signedPreKeyId: number,
    baseKey: PublicKey,
    identityKey: PublicKey,
    message: SignalMessage,
    serialized: Uint8Array
  ) {
    this.messageVersion = messageVersion;
    this.registrationId = registrationId;
    this.preKeyId = preKeyId;
    this.signedPreKeyId = signedPreKeyId;
    this.baseKey = baseKey;
    this.identityKey = identityKey;
    this.message = message;
    this.serialized = serialized;
  }

  /** 新規作成 */
  static new(
    messageVersion: number,
    registrationId: number,
    preKeyId: number | null,
    signedPreKeyId: number,
    baseKey: PublicKey,
    identityKey: PublicKey,
    message: SignalMessage
  ): PreKeySignalMessage {
    const parts: Uint8Array[] = [new Uint8Array([messageVersionByte(messageVersion)])];

    if (preKeyId !== null) {
      parts.push(encodeUint32Field(1, preKeyId));
    }
    parts.push(encodeBytesField(2, baseKey.serialize()));
    parts.push(encodeBytesField(3, identityKey.serialize()));
    parts.push(encodeBytesField(4, message.serialize()));
    parts.push(encodeUint32Field(5, registrationId));
    parts.push(encodeUint32Field(6, signedPreKeyId));

    return new PreKeySignalMessage(
      messageVersion,
      registrationId,
      preKeyId,
      signedPreKeyId,
      baseKey,
      identityKey,
      message,
      concatBytes(...parts)
    );
  }

  /** serialized 形式からの復元 */
  static deserialize(bytes: Uint8Array): PreKeySignalMessage {
    if (bytes.length === 0) {
      throw new Error('Ciphertext message too short: 0');
    }

    const messageVersion = bytes[0] >> 4;
    if (messageVersion < CIPHERTEXT_MESSAGE_PRE_KYBER_VERSION) {
      throw new Error(`Legacy ciphertext version: ${messageVersion}`);
    }
    if (messageVersion > CIPHERTEXT_MESSAGE_CURRENT_VERSION) {
      throw new Error(`Unrecognized ciphertext version: ${messageVersion}`);
    }

    const fields = decodeFields(bytes.slice(1));

    const preKeyId = getUint32Field(fields, 1);
    const baseKey = getBytesField(fields, 2);
    const identityKey = getBytesField(fields, 3);
    const message = getBytesField(fields, 4);
    const registrationId = getUint32Field(fields, 5) ?? 0;
    const signedPreKeyId = getUint32Field(fields, 6);

    if (!baseKey || !identityKey || !message || signedPreKeyId === null) {
      throw new Error('Invalid protobuf encoding');
    }

    const kyberPreKeyId = getUint32Field(fields, 7);
    const kyberCiphertext = getBytesField(fields, 8);
    if ((kyberPreKeyId === null) !== (kyberCiphertext === null)) {
      throw new Error('Both or neither kyber pre_key_id and kyber_ciphertext can be present');
    }
    if (kyberPreKeyId !== null && messageVersion > CIPHERTEXT_MESSAGE_PRE_KYBER_VERSION) {
      throw new Error('Kyber pre keys are not supported');
    }

    return new PreKeySignalMessage(
      messageVersion,
      registrationId,
      preKeyId,
      signedPreKeyId,
      PublicKey.deserialize(baseKey),
      PublicKey.deserialize(identityKey),
      SignalMessage.deserialize(message),
      new Uint8Array(bytes)
    );
  }

  /** serialized 形式 */
  serialize(): Uint8Array {
    return this.serialized;
  }
}
