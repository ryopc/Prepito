/**
 * DM Service - E2E暗号化ダイレクトメッセージ
 * Signal Protocol (X3DH + Double Ratchet) + ed25519 署名
 *
 * 送信フロー:
 *   1. Signal セッション確立 (X3DH)
 *   2. Double Ratchet で平文を暗号化
 *   3. ed25519 で ciphertext に署名
 *   4. srv
er API 経由で送信
 *
 * 受信フロー:
 *   1. ed25519 署名検証 (相手公開鍵)
 *   2. Double Ratchet で復号
 */

import { encryptForDM, decryptFromDM } from './crypto';
import { ApiError, dmsApi } from './api';
import { generateKeypair, signMessage, verifySignature } from '../utils/crypto';
import { getSecureItem, setSecureItem } from '../utils/secureStore';

const SIGNING_SECRET_KEY = 'prepito.dm_signing_secret_key';

/** 送信用DMペイロード */
export interface SendDMPayload {
  recipientId: string;
  plaintext: string;
}

/** サーバーから受け取る生DM */
export interface RawDMMessage {
  id: string;
  from: { id: string; username: string; displayName?: string };
  to: { id: string; username: string; displayName?: string };
  content: string;
  signature: string;
  isRead: boolean;
  createdAt: string;
}

/** 復号済みDM */
export interface DecryptedDM {
  id: string;
  conversationId: string;
  fromUserId: string;
  fromUsername: string;
  fromDisplayName?: string;
  plaintext: string;
  isRead: boolean;
  isOutgoing: boolean;
  createdAt: string;
}

/** 送信済みDM (ローカル用) */
export interface OutgoingDMPayload {
  ciphertext: string;
  type: number;
  signature: string;
  registrationId?: number;
}

/* =====================================================================
   署名鍵ペア (ed25519)
   ===================================================================== */

/** ed25519 署名秘密鍵を取得（未生成なら生成して保存） */
async function getSigningSecretKey(): Promise<string> {
  const secretKey = await getSecureItem(SIGNING_SECRET_KEY);
  if (secretKey) return secretKey;

  const { secretKey: newSecretKey } = await generateKeypair();
  await setSecureItem(SIGNING_SECRET_KEY, newSecretKey);
  return newSecretKey;
}

/* =====================================================================
   送信
   ===================================================================== */

/**
 * 暗号化失敗をユーザー向けメッセージに変換する
 *
 * 相手ユーザーの PreKey Bundle は `GET /api/keys/bundle/:userId` から取得する。
 * このエンドポイントを持たない koshi サーバ（4.0.0 など）では 404 になり、
 * 原因が了然されないまま送信が失敗する。どの能力が不足しているかを
 * 具体的に示すことで、導入時の混乱を防ぐ。
 */
function toFriendlyEncryptionError(err: unknown): Error {
  if (err instanceof ApiError && err.status === 404) {
    return new Error(
      'このサーバは E2E 暗号化（Signal Protocol）に対応していません。' +
        'E2E 暗号化には /api/keys/bundle エンドポイントを持つ koshi サーバが必要です。'
    );
  }
  if (err instanceof ApiError && err.status === 401) {
    return new Error('認証に失敗しました。もう一度ログインしてください。');
  }
  return err instanceof Error ? err : new Error('メッセージの暗号化に失敗しました');
}

/** DM 送信 (E2E暗号化 + 署名) */
export async function sendDM(payload: SendDMPayload): Promise<{ id: string }> {
  const { recipientId, plaintext } = payload;

  // 1. Signal で暗号化 (X3DHセッション確立 + Double Ratchet)
  let encrypted;
  try {
    encrypted = await encryptForDM(recipientId, plaintext);
  } catch (err) {
    throw toFriendlyEncryptionError(err);
  }

  // 2. ed25519 で ciphertext に署名
  const secretKey = await getSigningSecretKey();
  const signature = await signMessage(encrypted.ciphertext, secretKey);

  // 3. サーバーに送信
  const result = await dmsApi.send(recipientId, encrypted.ciphertext, signature);

  return { id: result.id };
}

/** 送信用ペイロードを構築 (ローカル保存用) */
export async function buildOutgoingPayload(
  recipientId: string,
  plaintext: string
): Promise<OutgoingDMPayload> {
  let encrypted;
  try {
    encrypted = await encryptForDM(recipientId, plaintext);
  } catch (err) {
    throw toFriendlyEncryptionError(err);
  }
  const secretKey = await getSigningSecretKey();
  const signature = await signMessage(encrypted.ciphertext, secretKey);

  return {
    ciphertext: encrypted.ciphertext,
    type: encrypted.type,
    signature,
    registrationId: encrypted.registrationId,
  };
}

/* =====================================================================
   受信・復号
   ===================================================================== */

/** DM 受信・復号 (署名検証付き) */
export async function receiveDM(
  raw: RawDMMessage,
  senderPublicKeyHex: string | null,
  _myUserId: string
): Promise<DecryptedDM | null> {
  // 1. ed25519 署名検証
  // 公開鍵・署名は koshi サーバと同じ hex 形式で受け取る
  //
  // 送信者の公開鍵が取得できない場合（サーバが user.public_key を
  // 公開していない状態）は検証をスキップする。暗号文の真正性は
  // Double Ratchet の MAC で担保されるため、受信処理 자체は成立する。
  if (senderPublicKeyHex) {
    const isValid = await verifySignature(raw.content, raw.signature, senderPublicKeyHex);
    if (!isValid) {
      console.warn('[DMService] 署名検証に失敗しました:', raw.id);
      return null;
    }
  } else {
    console.warn('[DMService] 送信者の公開鍵が取得できないため署名検証をスキップします:', raw.id);
  }

  // 2. Double Ratchet で復号
  let plaintext: string;
  try {
    plaintext = await decryptFromDM(raw.from.id, raw.content, 2); // type=2 (SignalMessage)
  } catch (err) {
    // PreKeySignalMessage (type=3) の場合
    try {
      plaintext = await decryptFromDM(raw.from.id, raw.content, 3);
    } catch (err2) {
      console.error('[DMService] 復号に失敗しました:', err2);
      return null;
    }
  }

  return {
    id: raw.id,
    conversationId: raw.from.id,
    fromUserId: raw.from.id,
    fromUsername: raw.from.username,
    fromDisplayName: raw.from.displayName,
    plaintext,
    isRead: raw.isRead,
    isOutgoing: false,
    createdAt: raw.createdAt,
  };
}

/** 自分のユーザーIDから相手のuserIdを抽出 (DMは1対1) */
export function getConversationId(myUserId: string, otherUserId: string): string {
  return otherUserId;
}
