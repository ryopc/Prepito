/**
 * ed25519 Cryptography Utilities
 * Uses @noble/ed25519 for key generation and signing
 * Uses expo-crypto for CSPRNG
 *
 * ## エンコーディングは hex で統一する
 *
 * koshi サーバは公開鍵を **64 文字の hex** として検証し
 * (`/^[0-9a-f]{64}$/i`)、署名も `hexToBytes()` でデコードする
 * （`@ryopc/koshi/src/auth/ed25519.js`）ため、base64 で送信すると
 * 登録が 400（"Invalid public key format"）、ログインが 401 になる。
 * サーバ側と同じ hex に統一する。
 */

import * as ed25519 from '@noble/ed25519';
import { getRandomBytes } from 'expo-crypto';
import { base64ToBytes, bytesToHex, hexToBytes, utf8Encode } from '../services/crypto/bytes';

/** 鍵ペア生成 */
export async function generateKeypair(): Promise<{
  publicKey: string; // hex encoded 32-byte public key (64 chars)
  secretKey: string; // hex encoded 32-byte secret key (seed) (64 chars)
}> {
  // シード生成 (32 bytes)
  const seed = getRandomBytes(32);

  // 公開鍵導出
  const publicKey = await ed25519.getPublicKeyAsync(seed);

  return {
    publicKey: bytesToHex(publicKey),
    secretKey: bytesToHex(seed), // シードを秘密鍵として保存
  };
}

/** メッセージ署名 (hex) */
export async function signMessage(message: string, secretKeyHex: string): Promise<string> {
  const secretKey = decodeSecretKey(secretKeyHex);
  const messageBytes = stringToBytes(message);

  // @noble/ed25519 の非同期署名
  const signature = await ed25519.signAsync(messageBytes, secretKey);

  return bytesToHex(signature);
}

/** 署名検証 (hex) */
export async function verifySignature(
  message: string,
  signatureHex: string,
  publicKeyHex: string
): Promise<boolean> {
  try {
    const signature = hexToBytes(signatureHex);
    const publicKey = hexToBytes(publicKeyHex);
    const messageBytes = stringToBytes(message);

    return await ed25519.verifyAsync(signature, messageBytes, publicKey);
  } catch {
    return false;
  }
}

/** 公開鍵から秘密鍵を導出 (シードから再生成) */
export async function getPublicKeyFromSecret(secretKeyHex: string): Promise<string> {
  const secretKey = decodeSecretKey(secretKeyHex);
  const publicKey = await ed25519.getPublicKeyAsync(secretKey);
  return bytesToHex(publicKey);
}

/** キーペアの整合性チェック */
export async function validateKeypair(
  secretKeyHex: string,
  expectedPublicKeyHex: string
): Promise<boolean> {
  const derivedPublicKey = await getPublicKeyFromSecret(secretKeyHex);
  return derivedPublicKey === expectedPublicKeyHex;
}

/** バッチ署名 (複数メッセージを一度に署名) */
export async function signMessages(messages: string[], secretKeyHex: string): Promise<string[]> {
  const secretKey = decodeSecretKey(secretKeyHex);
  const results: string[] = [];

  for (const message of messages) {
    const messageBytes = stringToBytes(message);
    const signature = await ed25519.signAsync(messageBytes, secretKey);
    results.push(bytesToHex(signature));
  }
  return results;
}

// ==================== ヘルパー関数 ====================

/**
 * 秘密鍵のデコード
 *
 * 新形式は hex。以前のバージョンで base64 として SecureStore に
 * 保存された秘密鍵が残っている可能性があるため、hex でない場合は
 * base64 として読み替える（移行用のフォールバック）。
 */
function decodeSecretKey(value: string): Uint8Array {
  if (value.length === 64 && isHex(value)) {
    return hexToBytes(value);
  }
  return base64ToBytes(value);
}

/** 16進文字列か判定 */
function isHex(value: string): boolean {
  return /^[0-9a-fA-F]+$/.test(value);
}

// NOTE: Hermes (React Native 0.74) には TextEncoder / atob が
// グローバルとして存在しないため、エンコーディングはすべて
// services/crypto/bytes.ts の自前実装を使用する。
function stringToBytes(str: string): Uint8Array {
  return utf8Encode(str);
}
