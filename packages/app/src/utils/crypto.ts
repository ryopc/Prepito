/**
 * ed25519 Cryptography Utilities
 * Uses @noble/ed25519 for key generation and signing
 * Uses expo-crypto for CSPRNG
 */

import * as ed25519 from '@noble/ed25519';
import { getRandomBytes } from 'expo-crypto';

/** 鍵ペア生成 */
export async function generateKeypair(): Promise<{
  publicKey: string;   // base64 encoded 32-byte public key
  secretKey: string;   // base64 encoded 32-byte secret key (seed)
}> {
  // シード生成 (32 bytes)
  const seed = getRandomBytes(32);
  
  // 公開鍵導出
  const publicKey = await ed25519.getPublicKeyAsync(seed);
  
  return {
    publicKey: bytesToBase64(publicKey),
    secretKey: bytesToBase64(seed), // シードを秘密鍵として保存
  };
}

/** メッセージ署名 */
export async function signMessage(message: string, secretKeyBase64: string): Promise<string> {
  const secretKey = base64ToBytes(secretKeyBase64);
  const messageBytes = stringToBytes(message);
  
  // @noble/ed25519 の非同期署名
  const signature = await ed25519.signAsync(messageBytes, secretKey);
  
  return bytesToBase64(signature);
}

/** 署名検証 */
export async function verifySignature(
  message: string,
  signatureBase64: string,
  publicKeyBase64: string
): Promise<boolean> {
  try {
    const signature = base64ToBytes(signatureBase64);
    const publicKey = base64ToBytes(publicKeyBase64);
    const messageBytes = stringToBytes(message);
    
    return await ed25519.verifyAsync(signature, messageBytes, publicKey);
  } catch {
    return false;
  }
}

/** 公開鍵から秘密鍵を導出 (シードから再生成) */
export async function getPublicKeyFromSecret(secretKeyBase64: string): Promise<string> {
  const secretKey = base64ToBytes(secretKeyBase64);
  const publicKey = await ed25519.getPublicKeyAsync(secretKey);
  return bytesToBase64(publicKey);
}

/** キーペアの整合性チェック */
export async function validateKeypair(secretKeyBase64: string, expectedPublicKeyBase64: string): Promise<boolean> {
  const derivedPublicKey = await getPublicKeyFromSecret(secretKeyBase64);
  return derivedPublicKey === expectedPublicKeyBase64;
}

/** バッチ署名 (複数メッセージを一度に署名) */
export async function signMessages(messages: string[], secretKeyBase64: string): Promise<string[]> {
  const secretKey = base64ToBytes(secretKeyBase64);
  const results: string[] = [];
  
  for (const message of messages) {
    const signature = await ed25519.signAsync(stringToBytes(message), secretKey);
    results.push(bytesToBase64(signature));
  }
  
  return results;
}

// ==================== ヘルパー関数 ====================

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function stringToBytes(str: string): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(str);
}