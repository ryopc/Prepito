/**
 * 乱数生成
 *
 * expo-crypto の getRandomBytes を第一候補とし、
 * 実行環境 (Node / Jest) では globalThis.crypto.getRandomValues にフォールバックする。
 */

import { getRandomBytes } from 'expo-crypto';

type CryptoLike = {
  getRandomValues?: <T extends Uint8Array>(array: T) => T;
};

/** 暗号学的乱数を指定バイト数生成する */
export function randomBytes(length: number): Uint8Array {
  if (length <= 0) return new Uint8Array(0);

  try {
    const bytes = getRandomBytes(length);
    if (bytes && bytes.length === length) return bytes;
  } catch {
    // expo-crypto が利用できない環境 (Node / Jest) では下の WebCrypto へフォールバック
  }

  const webCrypto = (globalThis as unknown as { crypto?: CryptoLike }).crypto;
  if (webCrypto && typeof webCrypto.getRandomValues === 'function') {
    const out = new Uint8Array(length);
    webCrypto.getRandomValues(out);
    return out;
  }

  throw new Error('Secure random source is not available');
}
