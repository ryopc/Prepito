/**
 * XEdDSA (Schnorr over Curve25519)
 *
 * libsignal-client v0.40 は Ed25519 ではなく XEdDSA で署名する。
 * (rust/protocol/src/curve/curve25519.rs の calculate_signature / verify_signature)
 *
 * 仕様: https://signal.org/docs/specifications/xeddsa/
 *
 * - 秘密鍵 a は clamp 済みの 32 バイト
 * - 公開鍵 A は Montgomery 形式 (u 座標) で受け渡し、
 *    Edwards 形式への変換に必要な x 座標の符号ビットは署名に同梱される
 * - 署名 = R (32 バイト) || s (32 バイト)、s の最上位ビットには符号ビットが入る
 */

import { sha512 } from '@noble/hashes/sha2.js';
import { concatBytes, numberToBytesLE } from './bytes';
import { randomBytes } from './random';
import {
  ED25519_L,
  clampPrivateKey,
  compressEdwardsPoint,
  edwardsAdd,
  edwardsBase,
  edwardsMultiply,
  edwardsNegate,
  montgomeryToEdwards,
  scalarFromBytes,
  scalarFromBytesWide,
} from './curve';

/** XEdDSA 用のハッシュプレフィックス (libsignal: 0xFE + 0xFF * 31) */
const HASH_PREFIX = new Uint8Array(32);
HASH_PREFIX[0] = 0xfe;
HASH_PREFIX.fill(0xff, 1, 32);

/** 署名長 (64 バイト) */
export const XEDDSA_SIGNATURE_LENGTH = 64;

/**
 * XEdDSA 署名
 *
 * @param privateKey clamp 前の秘密鍵でも可 (内部で clamp する)
 * @param message 署名対象
 * @param randomness 乱数 64 バイト (テスト用に注入可能)
 */
export function xeddsaSign(
  privateKey: Uint8Array,
  message: Uint8Array,
  randomness?: Uint8Array
): Uint8Array {
  const keyData = clampPrivateKey(privateKey);
  const random = randomness ?? randomBytes(64);
  if (random.length !== 64) {
    throw new Error(`Invalid randomness length: ${random.length}`);
  }

  // A = a * B (Edwards 形式)
  const a = scalarFromBytes(keyData);
  const edPublicKey = compressEdwardsPoint(edwardsMultiply(edwardsBase(), a));
  const signBit = edPublicKey[31] & 0x80;

  // r = SHA512(prefix || key_data || message || random) mod l
  const hash1 = sha512(concatBytes(HASH_PREFIX, keyData, message, random));
  const r = scalarFromBytesWide(hash1);
  const capR = compressEdwardsPoint(edwardsMultiply(edwardsBase(), r));

  // h = SHA512(R || A || message) mod l
  const hash2 = sha512(concatBytes(capR, edPublicKey, message));
  const h = scalarFromBytesWide(hash2);

  // s = h * a + r (mod l)
  const s = (h * a + r) % ED25519_L;

  const signature = concatBytes(capR, numberToBytesLE(s, 32));
  // s の最上位 7 ビットをマスクし、符号ビットを格納する
  signature[63] &= 0x7f;
  signature[63] |= signBit;
  return signature;
}

/**
 * XEdDSA 署名検証
 *
 * @param publicKey Montgomery 形式 (u 座標) の公開鍵 32 バイト
 * @param message 署名対象
 * @param signature 64 バイトの署名
 */
export function xeddsaVerify(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array
): boolean {
  if (signature.length !== XEDDSA_SIGNATURE_LENGTH) return false;

  const signBit = (signature[63] & 0x80) >> 7;
  const edPublicKeyPoint = montgomeryToEdwards(publicKey, signBit);
  if (!edPublicKeyPoint) return false;

  const capA = compressEdwardsPoint(edPublicKeyPoint);
  const capR = signature.slice(0, 32);

  // s の下位 31 ビットのみ有効 (最上位ビットは符号ビットとして使われる)
  const sBytes = signature.slice(32, 64);
  sBytes[31] &= 0x7f;
  if ((sBytes[31] & 0xe0) !== 0) return false;
  const s = scalarFromBytes(sBytes);

  // h = SHA512(R || A || message) mod l
  const h = scalarFromBytesWide(sha512(concatBytes(capR, capA, message)));

  // R' = s * B - h * A  が R と一致するか
  const check = edwardsAdd(
    edwardsMultiply(edwardsBase(), s),
    edwardsMultiply(edwardsNegate(edPublicKeyPoint), h)
  );
  return constantTimeEqual(compressEdwardsPoint(check), capR);
}

/** 定数時間比較 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
