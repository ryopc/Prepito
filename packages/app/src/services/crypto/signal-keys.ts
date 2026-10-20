/**
 * Signal Protocol の鍵・アドレス型
 *
 * libsignal-client v0.40 の Rust 実装 (rust/protocol/src/curve.rs, identity_key.rs)
 * と同じ wire 表現を持つ純 TypeScript 再実装。
 *
 * 重要な点:
 * - 公開鍵の serialize() は先頭に鍵種別バイト 0x05 (Djb) が付く 33 バイト
 * - 秘密鍵の serialize() は clamp 済みの 32 バイト
 * - 署名は Ed25519 ではなく XEdDSA (Schnorr over Curve25519)
 */

import { bytesEqual, concatBytes } from './bytes';
import {
  clampPrivateKey,
  generateX25519PrivateKey,
  x25519PublicKey,
  x25519SharedSecret,
} from './curve';
import { xeddsaSign, xeddsaVerify } from './xeddsa';
import { decodeFields, encodeBytesField, getBytesField } from './protobuf';

/** 鍵種別バイト (Djb) */
export const DJB_KEY_TYPE = 0x05;

/** 公開鍵 (Montgomery u 座標) */
export class PublicKey {
  private readonly key: Uint8Array;

  private constructor(key: Uint8Array) {
    this.key = key;
  }

  /** 生の 32 バイト (Montgomery u 座標) から生成 */
  static fromBytes(bytes: Uint8Array): PublicKey {
    if (bytes.length !== 32) {
      throw new Error(`Invalid public key length: ${bytes.length}`);
    }
    return new PublicKey(new Uint8Array(bytes));
  }

  /** serialized 形式 (0x05 + 32 バイト) から復元 */
  static deserialize(bytes: Uint8Array): PublicKey {
    if (bytes.length === 0) {
      throw new Error('No key type identifier');
    }
    if (bytes[0] !== DJB_KEY_TYPE) {
      throw new Error(`Bad key type: ${bytes[0]}`);
    }
    if (bytes.length < 33) {
      throw new Error(`Bad key length: ${bytes.length}`);
    }
    return new PublicKey(bytes.slice(1, 33));
  }

  /** serialized 形式 (33 バイト) */
  serialize(): Uint8Array {
    return concatBytes(new Uint8Array([DJB_KEY_TYPE]), this.key);
  }

  /** 生の 32 バイト */
  publicKeyBytes(): Uint8Array {
    return new Uint8Array(this.key);
  }

  /** XEdDSA 署名検証 */
  verifySignature(message: Uint8Array, signature: Uint8Array): boolean {
    return xeddsaVerify(this.key, message, signature);
  }

  /** 等値比較 (定数時間) */
  equals(other: PublicKey): boolean {
    return bytesEqual(this.key, other.key);
  }
}

/** 秘密鍵 (clamp 済み 32 バイト) */
export class PrivateKey {
  private readonly key: Uint8Array;

  private constructor(key: Uint8Array) {
    this.key = key;
  }

  /** 新規生成 */
  static generate(): PrivateKey {
    return new PrivateKey(generateX25519PrivateKey());
  }

  /** 32 バイトから復元 (内部で clamp する) */
  static deserialize(bytes: Uint8Array): PrivateKey {
    if (bytes.length !== 32) {
      throw new Error(`Invalid private key length: ${bytes.length}`);
    }
    return new PrivateKey(clampPrivateKey(bytes));
  }

  /** serialized 形式 (32 バイト) */
  serialize(): Uint8Array {
    return new Uint8Array(this.key);
  }

  /** 対応する公開鍵 */
  getPublicKey(): PublicKey {
    return PublicKey.fromBytes(x25519PublicKey(this.key));
  }

  /** XEdDSA 署名 */
  sign(message: Uint8Array): Uint8Array {
    return xeddsaSign(this.key, message);
  }

  /** DH 共有秘密 */
  calculateAgreement(other: PublicKey): Uint8Array {
    return x25519SharedSecret(this.key, other.publicKeyBytes());
  }
}

/**
 * アイデンティティ鍵ペア
 *
 * serialized 形式は libsignal と同じ
 * `storage.proto` の IdentityKeyPairStructure { public_key = 1, private_key = 2 }
 */
export class IdentityKeyPair {
  readonly publicKey: PublicKey;
  readonly privateKey: PrivateKey;

  constructor(publicKey: PublicKey, privateKey: PrivateKey) {
    this.publicKey = publicKey;
    this.privateKey = privateKey;
  }

  /** 新規生成 */
  static generate(): IdentityKeyPair {
    const privateKey = PrivateKey.generate();
    return new IdentityKeyPair(privateKey.getPublicKey(), privateKey);
  }

  /** serialized 形式からの復元 */
  static deserialize(bytes: Uint8Array): IdentityKeyPair {
    const fields = decodeFields(bytes);
    const publicKeyBytes = getBytesField(fields, 1);
    const privateKeyBytes = getBytesField(fields, 2);
    if (!publicKeyBytes || !privateKeyBytes) {
      throw new Error('Invalid identity key pair');
    }
    return new IdentityKeyPair(
      PublicKey.deserialize(publicKeyBytes),
      PrivateKey.deserialize(privateKeyBytes)
    );
  }

  /** serialized 形式 (protobuf) */
  serialize(): Uint8Array {
    return concatBytes(
      encodeBytesField(1, this.publicKey.serialize()),
      encodeBytesField(2, this.privateKey.serialize())
    );
  }
}

/** アドレス (ユーザー ID + デバイス ID) */
export class ProtocolAddress {
  private readonly addressName: string;
  private readonly deviceIdentifier: number;

  private constructor(name: string, deviceId: number) {
    this.addressName = name;
    this.deviceIdentifier = deviceId;
  }

  static new(name: string, deviceId: number): ProtocolAddress {
    return new ProtocolAddress(name, deviceId);
  }

  name(): string {
    return this.addressName;
  }

  deviceId(): number {
    return this.deviceIdentifier;
  }
}

/** 信頼判定の方向 */
export enum Direction {
  Sending = 0,
  Receiving = 1,
}

/**
 * PreKeyBundle
 *
 * server 側の KeyBundle (identityKey / signedPreKey / preKeySignature /
 * oneTimePreKeys) から libsignal 互換の構造に変換する。
 */
export class PreKeyBundle {
  readonly registrationId: number;
  readonly deviceId: number;
  readonly preKeyId: number | null;
  readonly preKeyPublic: PublicKey | null;
  readonly signedPreKeyId: number;
  readonly signedPreKeyPublic: PublicKey;
  readonly signedPreKeySignature: Uint8Array;
  readonly identityKey: PublicKey;

  constructor(
    registrationId: number,
    deviceId: number,
    preKeyId: number | null,
    preKeyPublic: PublicKey | null,
    signedPreKeyId: number,
    signedPreKeyPublic: PublicKey,
    signedPreKeySignature: Uint8Array,
    identityKey: PublicKey
  ) {
    this.registrationId = registrationId;
    this.deviceId = deviceId;
    this.preKeyId = preKeyId;
    this.preKeyPublic = preKeyPublic;
    this.signedPreKeyId = signedPreKeyId;
    this.signedPreKeyPublic = signedPreKeyPublic;
    this.signedPreKeySignature = signedPreKeySignature;
    this.identityKey = identityKey;
  }

  static new(
    registrationId: number,
    deviceId: number,
    preKeyId: number | null,
    preKeyPublic: PublicKey | null,
    signedPreKeyId: number,
    signedPreKeyPublic: PublicKey,
    signedPreKeySignature: Uint8Array,
    identityKey: PublicKey
  ): PreKeyBundle {
    return new PreKeyBundle(
      registrationId,
      deviceId,
      preKeyId,
      preKeyPublic,
      signedPreKeyId,
      signedPreKeyPublic,
      signedPreKeySignature,
      identityKey
    );
  }
}
